// SPDX-License-Identifier: AGPL-3.0-or-later

/// 記憶の想起と、プロンプトに差し込む文面の組み立て (ChatGPT の memory と同じ方式)。
///
/// 保存された事実を「検索して引く」のではなく、毎ターン上限つきで常駐させる。
/// 優先順は ピン留め > 話している本人の事実 > 依頼文に出てくる語に当たった事実 > サーバーの最近の事実。

import type { GuildMemory, MemoryFact } from './store.ts';

/** プロンプトに差し込む記憶の上限 (文字)。ChatGPT の user memory と同じく常駐させるので小さく保つ */
export const MEMORY_BLOCK_CHARS = 1_200;
/** 本人の事実として必ず出す件数の上限 */
export const MAX_SUBJECT_FACTS = 12;
/** 語が当たった事実の上限 */
export const MAX_MATCHED_FACTS = 8;

/** 依頼文から想起の手がかりになる語を取り出す。日本語は単語境界が無いので 2 文字以上の連なりを使う */
export const termsOf = (text: string): string[] => {
  const cleaned = text
    .replace(/<[@#!&:]+\d+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\s　、。！？!?「」『』()（）:：,，.・~〜\-—…\[\]{}"'`|/\\]+/g, ' ')
    .toLowerCase();
  const terms = new Set<string>();
  for (const chunk of cleaned.split(' ')) {
    if (chunk.length < 2) continue;
    terms.add(chunk);
    // 長い塊は 3 文字ずつの断片でも引く (「さかなのメモリ」→「さかな」「かなの」…)
    if (chunk.length >= 6) {
      for (let i = 0; i + 3 <= chunk.length && terms.size < 40; i++) terms.add(chunk.slice(i, i + 3));
    }
  }
  return [...terms].slice(0, 30);
};

const haystack = (fact: MemoryFact): string => `${fact.text}\n${fact.tags.join('\n')}`.toLowerCase();

/** 依頼文の語が、事実の本文かタグに当たるか */
export const matches = (fact: MemoryFact, terms: readonly string[]): boolean => {
  const hay = haystack(fact);
  return terms.some(term => hay.includes(term));
};

export interface RecallInput {
  memory: GuildMemory;
  /** 話している相手 (Discord のユーザー ID) */
  userId: string;
  /** 今の依頼文 (名前や話題の手がかり) */
  text: string;
  maxChars?: number;
}

export interface Recalled {
  /** プロンプトに差し込む文面 (何も無ければ空文字) */
  text: string;
  /** 出した事実 (ツールの案内や、デバッグ用) */
  facts: MemoryFact[];
  /** 保存されている事実の総数 */
  total: number;
}

/**
 * 事実を選ぶ。件数ではなく文字数で切る (ChatGPT が user memory を常駐させるときと同じ考え方)。
 * 新しいものほど前に出す。
 */
export const recall = ({ memory, userId, text, maxChars = MEMORY_BLOCK_CHARS }: RecallInput): Recalled => {
  const terms = termsOf(text);
  const byRecent = (a: MemoryFact, b: MemoryFact): number => b.updatedAt - a.updatedAt;

  const pinned = memory.facts.filter(f => f.pinned === true).sort(byRecent);
  const about = memory.facts
    .filter(f => f.scope === 'user' && f.subject === userId && f.pinned !== true)
    .sort(byRecent)
    .slice(0, MAX_SUBJECT_FACTS);
  const matched = memory.facts
    .filter(f => f.pinned !== true && !(f.scope === 'user' && f.subject === userId) && matches(f, terms))
    .sort(byRecent)
    .slice(0, MAX_MATCHED_FACTS);
  const guild = memory.facts
    .filter(f => f.scope === 'guild' && f.pinned !== true && !matched.includes(f))
    .sort(byRecent);

  const lines: string[] = [];
  const facts: MemoryFact[] = [];
  let used = 0;
  const head = `覚えていること (全 ${memory.facts.length} 件の抜粋。足りなければ memory ツールの search、`
    + '詳しい記録は Notion を見る。古い・食い違うときは本人に確認する):';
  used += head.length + 1;

  const push = (fact: MemoryFact, label?: string): void => {
    if (facts.includes(fact)) return;
    const line = `- ${label !== undefined ? `[${label}] ` : ''}${fact.text} (${fact.id})`;
    if (used + line.length + 1 > maxChars) return;
    lines.push(line);
    facts.push(fact);
    used += line.length + 1;
  };

  for (const fact of pinned) push(fact, '重要');
  for (const fact of about) push(fact, '本人');
  for (const fact of matched) push(fact);
  for (const fact of guild) push(fact);

  if (lines.length === 0) return { text: '', facts: [], total: memory.facts.length };
  return { text: [head, ...lines].join('\n'), facts, total: memory.facts.length };
};

/** ツールが返す一覧の文面 */
export const formatFacts = (facts: readonly MemoryFact[]): string => {
  if (facts.length === 0) return '記憶に該当する事実はありません。';
  return facts
    .map(f => `${f.id} [${f.scope === 'guild' ? 'サーバー' : `ユーザー ${f.subject ?? '?'}`}] ${f.text}`
      + `${f.tags.length > 0 ? ` (タグ: ${f.tags.join(', ')})` : ''}`
      + `${f.source !== undefined ? ` ${f.source}` : ''}`)
    .join('\n');
};

/** 新しい事実を書くときにモデルへ渡す指示 (プロンプト側と揃える) */
export const MEMORY_TOOL_GUIDE = [
  'このサーバーには 2 段の記憶がある。使い分けること。',
  '',
  '1. memory ツール — 短い事実の索引。毎ターン自動でプロンプトに載る (抜粋)。',
  '   知ったらすぐ `memory` の remember で 1 行ずつ保存する。',
  '   例: { "action": "remember", "facts": [{ "text": "たこは Rust 派 (2026-10 時点)", "tags": "たこ,Rust" }] }',
  '   例: { "action": "remember", "text": "サーバーの本番は Evex", "scope": "guild" }',
  '2. Notion (MCP ツール) — 長い記録の置き場。人物ページ、経緯、一覧、引用。',
  '   プロンプトに載っているのは memory の抜粋だけなので、**詳しい話は Notion を検索して読む**。',
  '   覚えておきたいことを詳しく書くときも Notion に書く (memory には 1 行の索引だけ置く)。',
  '',
  '記録のしかた:',
  '- 対象: 人物の性格・立場・好み・関係、決まったこと、用語や由来、プロジェクト。',
  '- 保存しない: 挨拶・相槌・その場限りの雑談・推測・機微情報 (連絡先、本名、住所など)。',
  '- 1 事実 1 行・現在形で短く (「〜は〜派」「〜を作っている」)。「〜と言った」の形にしない。',
  '- 話し相手についてなら scope: "user" (既定)、サーバー全体なら "guild"。',
  '- 同じことを何度も保存しない (同じ文は 1 件にまとまる)。',
  '- 自分が保存した事実は次の会話から自動で載る。読み直さなくてよい。',
  '- 記録の置き場 (Notion) や記憶の仕組みの話は会話に出さない。使うのは積極的に。',
  '- 過去の話題を出すときは、根拠のメッセージ URL を添える。',
].join('\n');
