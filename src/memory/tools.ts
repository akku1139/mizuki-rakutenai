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
  description: 'サーバーの記憶 (保存した事実) を読み書きする。'
    + 'action: remember (新しい事実を保存) / forget (id か本文で削除) / search (語で探す)。'
    + '保存した事実は次の会話から自動でプロンプトに載るので、読み直す必要はない。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['remember', 'forget', 'search'], description: '行う操作' },
      text: { type: 'string', description: 'remember: 保存する事実 (1行・現在形)。forget: 削除する事実の id か本文の一部' },
      scope: { type: 'string', enum: ['guild', 'user'], description: 'remember: 話し相手についてなら user、サーバー全体なら guild (既定 user)' },
      subject: { type: 'string', description: 'remember: scope が user のときの対象ユーザー ID (既定は話し相手)' },
      tags: { type: 'string', description: 'remember: 想起に使う名前・別名・話題 (カンマ区切り)' },
      query: { type: 'string', description: 'search: 探す語' },
    },
    required: ['action'],
  },
  async execute(args, meta): Promise<AIToolResult> {
    const guildId = guildIdOf(meta);
    if (guildId === undefined) return [false, { error: 'サーバー外では記憶を使えません' }];
    const memory = await loadMemory(guildId);
    const action = String(args['action'] ?? '');

    if (action === 'remember') {
      const text = typeof args['text'] === 'string' ? args['text'] : '';
      if (text.trim() === '') return [false, { error: 'text を指定してください' }];
      const scope = asScope(args['scope']);
      const subject = scope === 'user'
        ? (typeof args['subject'] === 'string' && args['subject'] !== '' ? args['subject'] : meta.msg.author.id)
        : undefined;
      const { fact, created } = rememberFact(memory, {
        scope,
        ...(subject !== undefined ? { subject } : {}),
        text,
        tags: tagsOf(args['tags']),
        ...(messageUrlOf(meta) !== undefined ? { source: messageUrlOf(meta)! } : {}),
      });
      await saveMemory(memory);
      log(`memory: ${created ? 'remember' : 'update'} ${fact.id} (${scope}${subject !== undefined ? ` ${subject}` : ''})`);
      return [true, { id: fact.id, created, text: fact.text }];
    }

    if (action === 'forget') {
      const key = typeof args['text'] === 'string' && args['text'] !== '' ? args['text'] : String(args['query'] ?? '');
      if (key.trim() === '') return [false, { error: 'text (id か本文の一部) を指定してください' }];
      const removed = forgetFact(memory, key);
      if (removed === undefined) return [false, { error: `「${key}」に当たる事実がありません` }];
      await saveMemory(memory);
      log(`memory: forget ${removed.id}`);
      return [true, { id: removed.id, text: removed.text }];
    }

    if (action === 'search') {
      const query = typeof args['query'] === 'string' ? args['query'] : '';
      const terms = termsOf(query);
      const hits = terms.length === 0
        ? memory.facts.slice(-20).reverse()
        : memory.facts.filter(f => matches(f, terms));
      return [true, { count: hits.length, facts: formatFacts(hits.slice(0, 20)) }];
    }

    return [false, { error: `unknown action: ${action}` }];
  },
};
