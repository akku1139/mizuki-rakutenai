// SPDX-License-Identifier: AGPL-3.0-or-later

/// サーバーごとの記憶 (事実) の保存。
///
/// ChatGPT の memory と同じく「明示的に保存した事実」を単位にする。会話ログそのものではなく、
/// 「誰が・何を・どういう人か」を 1 行 1 事実で持つ。想起は埋め込みではなく名前・語の照合で行い、
/// 毎ターン上限つきでプロンプトに注入する (検索で引くのではなく常駐させる)。
///
/// 保存先は `data/memory/<guildId>.json`。正本はローカルで、Notion は後から合流させる
/// (Notion が落ちていても会話が止まらないように)。

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

export type MemoryScope = 'guild' | 'user';

export interface MemoryFact {
  id: string;
  scope: MemoryScope;
  /** scope が user のときの対象ユーザー ID */
  subject?: string;
  /** 1 行の事実 (現在形) */
  text: string;
  /** 想起に使う名前・別名・話題 */
  tags: string[];
  /** 根拠 (メッセージ URL など) */
  source?: string;
  createdAt: number;
  updatedAt: number;
  /** 想起のたびに必ず出す */
  pinned?: boolean;
  /** Notion 上のページ ID (同期している場合) */
  notionPageId?: string;
}

export interface GuildMemory {
  guildId: string;
  facts: MemoryFact[];
  /** Notion から最後に取り込んだ時刻 */
  syncedAt?: number;
}

/** サーバーごとに持つ事実の上限 (超えたら古いものから捨てる。pinned は残す) */
export const MAX_FACTS_PER_GUILD = 500;
/** 1 つの事実の長さの上限 */
export const MAX_FACT_CHARS = 300;
const MEMORY_DIR = './data/memory';

const cache = new Map<string, GuildMemory>();

const pathOf = (guildId: string): string => `${MEMORY_DIR}/${guildId}.json`;

/** 想起用の id。短くて衝突しない程度 */
export const newFactId = (): string => `m_${createHash('sha1').update(crypto.randomUUID()).digest('hex').slice(0, 8)}`;

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** 同じ事実かどうか (空白・句読点の揺れを吸収) */
const sameText = (a: string, b: string): boolean =>
  normalize(a).replace(/[。、．，!！?？]/g, '') === normalize(b).replace(/[。、．!！?？]/g, '') ||
  normalize(a).toLowerCase() === normalize(b).toLowerCase();

export const loadMemory = async (guildId: string): Promise<GuildMemory> => {
  const hit = cache.get(guildId);
  if (hit !== undefined) return hit;
  let memory: GuildMemory = { guildId, facts: [] };
  try {
    const raw = JSON.parse(await fs.readFile(pathOf(guildId), 'utf8')) as Partial<GuildMemory>;
    memory = {
      guildId,
      facts: Array.isArray(raw.facts) ? raw.facts.filter(isFact) : [],
      ...(typeof raw.syncedAt === 'number' ? { syncedAt: raw.syncedAt } : {}),
    };
  } catch {
    // ファイルが無い / 壊れている → 空から始める
  }
  cache.set(guildId, memory);
  return memory;
};

const isFact = (value: unknown): value is MemoryFact => {
  if (value === null || typeof value !== 'object') return false;
  const f = value as Partial<MemoryFact>;
  return typeof f.id === 'string' && typeof f.text === 'string' && (f.scope === 'guild' || f.scope === 'user');
};

/** テスト用: 読み込み済みのキャッシュを捨てる */
export const resetMemoryCache = (): void => cache.clear();

export const saveMemory = async (memory: GuildMemory): Promise<void> => {
  const trimmed = trimFacts(memory.facts);
  memory.facts = trimmed;
  cache.set(memory.guildId, memory);
  await fs.mkdir(MEMORY_DIR, { recursive: true });
  const body = JSON.stringify(memory, null, 2);
  // 途中で落ちても壊れないよう、書いてから置き換える
  await fs.writeFile(`${pathOf(memory.guildId)}.tmp`, body);
  await fs.rename(`${pathOf(memory.guildId)}.tmp`, pathOf(memory.guildId));
};

/** 上限を超えたら、pinned 以外の古いものから捨てる */
export const trimFacts = (facts: MemoryFact[]): MemoryFact[] => {
  if (facts.length <= MAX_FACTS_PER_GUILD) return facts;
  const sorted = [...facts].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt);
  return sorted.slice(0, MAX_FACTS_PER_GUILD);
};

export interface RememberInput {
  scope: MemoryScope;
  subject?: string;
  text: string;
  tags?: string[];
  source?: string;
  pinned?: boolean;
}

/**
 * 事実を足す。同じ事実が既にあれば、内容と時刻を更新して同じ id を返す
 * (同じことを何度も記憶しない)。
 */
export const rememberFact = (memory: GuildMemory, input: RememberInput, now = Date.now()): { fact: MemoryFact, created: boolean } => {
  const text = normalize(input.text).slice(0, MAX_FACT_CHARS);
  const existing = memory.facts.find(f => f.scope === input.scope
    && (f.subject ?? '') === (input.subject ?? '')
    && sameText(f.text, text));
  const tags = [...new Set([...(input.tags ?? []), ...(existing?.tags ?? [])].map(t => normalize(t)).filter(Boolean))].slice(0, 20);
  if (existing !== undefined) {
    existing.text = text;
    existing.tags = tags;
    existing.updatedAt = now;
    if (input.source !== undefined) existing.source = input.source;
    if (input.pinned !== undefined) existing.pinned = input.pinned;
    return { fact: existing, created: false };
  }
  const fact: MemoryFact = {
    id: newFactId(),
    scope: input.scope,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    text,
    tags,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.pinned === true ? { pinned: true } : {}),
    createdAt: now,
    updatedAt: now,
  };
  memory.facts.push(fact);
  return { fact, created: true };
};

/** id か本文の一致で消す */
export const forgetFact = (memory: GuildMemory, key: string): MemoryFact | undefined => {
  const needle = normalize(key).toLowerCase();
  const index = memory.facts.findIndex(f => f.id === key || f.text.toLowerCase().includes(needle));
  if (index < 0) return undefined;
  const [removed] = memory.facts.splice(index, 1);
  return removed;
};

/** Notion から取り込んだ事実を合流させる (同じ notionPageId / 同じ本文は置き換える) */
export const mergeFacts = (memory: GuildMemory, incoming: MemoryFact[]): { added: number, updated: number } => {
  let added = 0;
  let updated = 0;
  for (const fact of incoming) {
    const byPage = fact.notionPageId !== undefined
      ? memory.facts.find(f => f.notionPageId === fact.notionPageId)
      : undefined;
    const byText = memory.facts.find(f => f.scope === fact.scope && (f.subject ?? '') === (fact.subject ?? '') && sameText(f.text, fact.text));
    const target = byPage ?? byText;
    if (target === undefined) {
      memory.facts.push(fact);
      added++;
      continue;
    }
    // Notion 側が新しいときだけ上書きする (ローカルの編集を消さない)
    if (fact.updatedAt > target.updatedAt) {
      Object.assign(target, { ...fact, id: target.id });
      updated++;
    }
  }
  return { added, updated };
};
