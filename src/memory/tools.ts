// SPDX-License-Identifier: AGPL-3.0-or-later

/// 記憶のツール (OpenAI 互換 API の function calling 用)。
/// モデルが自分で事実を保存・削除・検索できるようにする。読み出しは毎ターンの自動注入が主で、
/// ここは「忘れて」「これ覚えて」と言われたときと、古い事実を探すとき用。

import type { AITool, AIToolMeta, AIToolResult } from '../ai/tools.ts';
import { log } from '../log.ts';
import { formatFacts, matches, termsOf } from './recall.ts';
import { forgetFact, loadMemory, rememberFact, saveMemory, type MemoryScope } from './store.ts';

const guildIdOf = (meta: AIToolMeta): string | undefined => meta.msg.guild?.id;

const asScope = (value: unknown): MemoryScope => (value === 'guild' ? 'guild' : 'user');

const tagsOf = (value: unknown): string[] => (typeof value === 'string' ? value.split(/[,、\s]+/) : Array.isArray(value) ? value.map(String) : [])
  .map(t => t.trim())
  .filter(t => t !== '');

const messageUrlOf = (meta: AIToolMeta): string | undefined => {
  try {
    return meta.msg.url;
  } catch {
    return undefined;
  }
};

export const memoryTool: AITool = {
  description: '短い事実の記憶 (毎ターン自動でプロンプトに載る索引) を読み書きする。'
    + 'action: remember (事実を保存。facts でまとめて保存できる) / forget (id か本文で削除) / '
    + 'search または recall (語で探す) / stats (件数)。'
    + '長い記録・人物ページ・経緯は Notion に書く (Notion の MCP ツール)。'
    + '保存した事実は次の会話から自動で載るので、読み直す必要はない。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['remember', 'forget', 'search', 'recall', 'stats'], description: '行う操作' },
      text: { type: 'string', description: 'remember: 保存する事実 (1行・現在形)。forget: 削除する事実の id か本文の一部' },
      facts: {
        type: 'array',
        description: 'remember: まとめて保存するときの配列 (text の代わりに使う)',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '事実 (1行・現在形)' },
            scope: { type: 'string', enum: ['guild', 'user'] },
            subject: { type: 'string', description: 'scope が user のときの対象ユーザー ID' },
            tags: { type: 'string', description: '想起に使う名前・別名 (カンマ区切り)' },
          },
          required: ['text'],
        },
      },
      scope: { type: 'string', enum: ['guild', 'user'], description: 'remember: 話し相手についてなら user、サーバー全体なら guild (既定 user)' },
      subject: { type: 'string', description: 'remember: scope が user のときの対象ユーザー ID (既定は話し相手)' },
      tags: { type: 'string', description: 'remember: 想起に使う名前・別名・話題 (カンマ区切り)' },
      query: { type: 'string', description: 'search / recall: 探す語 (複数はスペース区切り)' },
      limit: { type: 'number', description: 'search / recall: 返す最大件数 (既定 20)' },
    },
    required: ['action'],
  },
  async execute(args, meta): Promise<AIToolResult> {
    const guildId = guildIdOf(meta);
    if (guildId === undefined) return [false, { error: 'サーバー外では記憶を使えません' }];
    const memory = await loadMemory(guildId);
    const action = String(args['action'] ?? '');

    if (action === 'remember') {
      // 1 件でも配列でも受ける (モデルはまとめて保存したほうが失敗しにくい)
      const items = Array.isArray(args['facts'])
        ? args['facts'].filter((f): f is Record<string, unknown> => f !== null && typeof f === 'object')
        : [];
      const single = typeof args['text'] === 'string' && args['text'].trim() !== ''
        ? [{ text: args['text'], ...(args['scope'] !== undefined ? { scope: args['scope'] } : {}), ...(args['subject'] !== undefined ? { subject: args['subject'] } : {}), ...(args['tags'] !== undefined ? { tags: args['tags'] } : {}) }]
        : [];
      const list = [...single, ...items];
      if (list.length === 0) return [false, { error: 'text か facts (保存する事実) を指定してください' }];
      if (list.length > 20) return [false, { error: '1 回に保存できるのは 20 件までです' }];

      const saved: Array<{ id: string, created: boolean, text: string }> = [];
      for (const item of list) {
        const text = typeof item['text'] === 'string' ? item['text'] : '';
        if (text.trim() === '') continue;
        const scope = asScope(item['scope'] ?? args['scope']);
        const subject = scope === 'user'
          ? String(item['subject'] ?? args['subject'] ?? meta.msg.author.id)
          : undefined;
        const { fact, created } = rememberFact(memory, {
          scope,
          ...(subject !== undefined ? { subject } : {}),
          text,
          tags: tagsOf(item['tags'] ?? args['tags']),
          ...(messageUrlOf(meta) !== undefined ? { source: messageUrlOf(meta)! } : {}),
        });
        saved.push({ id: fact.id, created, text: fact.text });
      }
      if (saved.length === 0) return [false, { error: '保存できる事実がありませんでした (text が空)' }];
      await saveMemory(memory);
      log(`memory: remember ${saved.filter(x => x.created).length} 件 (既存の更新 ${saved.filter(x => !x.created).length} 件)`);
      return [true, {
        saved,
        created: saved.filter(x => x.created).length,
        updated: saved.filter(x => !x.created).length,
        total: memory.facts.length,
        hint: '次の会話から自動でプロンプトに載ります。詳しい経緯は Notion に書いてください。',
      }];
    }

    if (action === 'forget') {
      const key = typeof args['text'] === 'string' && args['text'] !== '' ? args['text'] : String(args['query'] ?? '');
      if (key.trim() === '') return [false, { error: 'text (id か本文の一部) を指定してください' }];
      const removed = forgetFact(memory, key);
      if (removed === undefined) return [false, { error: `「${key}」に当たる事実がありません。search で id を確かめてください` }];
      await saveMemory(memory);
      log(`memory: forget ${removed.id}`);
      return [true, { id: removed.id, text: removed.text, total: memory.facts.length }];
    }

    if (action === 'search' || action === 'recall') {
      const query = typeof args['query'] === 'string' ? args['query'] : (typeof args['text'] === 'string' ? args['text'] : '');
      const take = typeof args['limit'] === 'number' ? Math.min(Math.max(Math.trunc(args['limit']), 1), 50) : 20;
      const terms = termsOf(query);
      const hits = terms.length === 0
        ? memory.facts.slice(-take).reverse()
        : memory.facts.filter(f => matches(f, terms));
      return [true, {
        count: hits.length,
        total: memory.facts.length,
        ...(hits.length === 0
          ? { hint: '語を短くするか、別の言い方で探してください。詳しい記録は Notion を検索してください。' }
          : {}),
        facts: formatFacts(hits.slice(0, take)),
      }];
    }

    if (action === 'stats') {
      const users = new Set(memory.facts.filter(f => f.scope === 'user').map(f => f.subject ?? ''));
      return [true, {
        total: memory.facts.length,
        userFacts: memory.facts.filter(f => f.scope === 'user').length,
        guildFacts: memory.facts.filter(f => f.scope === 'guild').length,
        people: users.size,
        pinned: memory.facts.filter(f => f.pinned === true).length,
      }];
    }

    return [false, { error: `unknown action: ${action}` }];
  },
};
