// SPDX-License-Identifier: AGPL-3.0-or-later

/// メッセージ検索のクエリ。
///
/// Discord の検索と同じ書き方 (`from:` `in:` `mentions:` `has:` `before:` `after:` `pinned:` `-除外`)
/// に、`OR`・フレーズ・`regex:`・`len:` を足したもの。Discord の検索 API は bot に開放されていないので、
/// ここで解釈した条件を、取得したメッセージに対して自前で評価する (`matchesQuery`)。
///
///   レビュー from:たこ has:image after:2026-10-01
///   "デプロイ 失敗" -warn in:#dev
///   OR でつなぐとどれか 1 つ、`-` を付けると除外。

export type SearchSort = 'new' | 'old';

export interface SearchQuery {
  /** すべて含む語 (小文字) */
  terms: string[];
  /** 空白込みのフレーズ (小文字) */
  phrases: string[];
  /** どれか 1 つ含めばよい語 (OR でつないだもの) */
  anyOf: string[];
  /** 含んではいけない語 */
  notTerms: string[];
  /** from: の値 (ユーザー ID / ユーザー名 / 表示名。小文字) */
  from: string[];
  /** in: の値 (チャンネル ID / #名前 / メッセージ URL) */
  channels: string[];
  /** mentions: の値 (ユーザー ID) */
  mentions: string[];
  /** has: の値 (link / embed / image / file / sticker / poll / reaction / sound) */
  has: string[];
  /** これより前 (ms) */
  before?: number;
  /** これより後 (ms) */
  after?: number;
  /** is:pinned / pinned:true */
  pinned?: boolean;
  /** len:>100 など */
  minLength?: number;
  maxLength?: number;
  /** regex:/…/i */
  regex?: RegExp;
  sort: SearchSort;
  /** 解釈できなかった演算子 (結果に添えてモデルに返す) */
  ignored: string[];
}

/**
 * 日本語の長い塊を、検索 API が扱える語に割る。
 *
 * Discord の `content` は語の一致で探すので、`techfishの不祥事について教えて` のような
 * 文をそのまま渡すと 0 件になる (実測)。助詞・依頼表現で切って `techfish 不祥事` にする。
 */
export const japaneseTerms = (text: string): string[] => {
  if (!/[\u3040-\u30ff\u4e00-\u9faf]/.test(text) || text.length < 4) return [text];
  const separators = [
    'について', 'に関して', 'という', 'って', 'を', 'が', 'は', 'に', 'で', 'と', 'の', 'や', 'も', 'へ',
    'から', 'まで', 'より', '教えて', '探して', '調べて', '見せて', 'ください', 'おしえて', 'さがして',
  ];
  let rest = text;
  for (const sep of separators) rest = rest.split(sep).join(' ');
  return rest
    .split(/[\s　、。,.!?！？「」『』()（）]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
};

export const EMPTY_QUERY = (): SearchQuery => ({
  terms: [], phrases: [], anyOf: [], notTerms: [], from: [], channels: [], mentions: [], has: [],
  sort: 'new', ignored: [],
});

/** 日本時間での日付解釈 (この bot の他の文脈と揃える) */
const TZ_MS = 9 * 3_600_000;

const FILTERS = new Set([
  'from', 'author', 'in', 'channel', 'mentions', 'mention', 'has', 'is',
  'before', 'after', 'since', 'until', 'during', 'on', 'len', 'length', 'regex', 're',
  'pinned', 'sort',
]);

interface Token {
  text: string;
  quoted: boolean;
  negated: boolean;
}

const tokenize = (raw: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
    if (i >= raw.length) break;
    let negated = false;
    while (raw[i] === '-') { negated = true; i++; }
    if (raw[i] === '"' || raw[i] === '“' || raw[i] === '「') {
      const close = raw[i] === '"' ? '"' : raw[i] === '“' ? '”' : '」';
      const end = raw.indexOf(close, i + 1);
      const text = raw.slice(i + 1, end < 0 ? raw.length : end);
      tokens.push({ text, quoted: true, negated });
      i = end < 0 ? raw.length : end + 1;
      continue;
    }
    let text = '';
    while (i < raw.length && !/\s/.test(raw[i]!)) text += raw[i++];
    // 値が空白を含む演算子 (`from:"た こ"`) を拾う
    const colon = text.indexOf(':');
    if (colon > 0 && raw[i] === '"') {
      const end = raw.indexOf('"', i + 1);
      text += `"${raw.slice(i + 1, end < 0 ? raw.length : end)}"`;
      i = end < 0 ? raw.length : end + 1;
    }
    tokens.push({ text, quoted: false, negated });
  }
  return tokens;
};

/** `7d` `24h` `2w` `30m` のような相対指定と、`2026-10-01` / `2026-10` / `2026` の絶対指定 */
export const parseWhen = (value: string, now = Date.now()): number | undefined => {
  const v = value.trim().toLowerCase().replace(/^["「]|["」]$/g, '');
  if (v === '') return undefined;
  const relative = /^(\d+)\s*(m|h|d|w|mo|y)$/.exec(v);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2]!;
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000
      : unit === 'w' ? 7 * 86_400_000 : unit === 'mo' ? 30 * 86_400_000 : 365 * 86_400_000;
    return now - n * ms;
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (day) return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) - TZ_MS;
  const month = /^(\d{4})-(\d{2})$/.exec(v);
  if (month) return Date.UTC(Number(month[1]), Number(month[2]) - 1, 1) - TZ_MS;
  const year = /^(\d{4})$/.exec(v);
  if (year) return Date.UTC(Number(year[1]), 0, 1) - TZ_MS;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/** during:day / week / month / year を、その期間の開始時刻にする */
const duringStart = (value: string, now: number): number | undefined => {
  const unit = value.toLowerCase().replace(/^["「]|["」]$/g, '');
  const ms = unit === 'day' || unit === 'today' ? 86_400_000
    : unit === 'week' ? 7 * 86_400_000
      : unit === 'month' ? 30 * 86_400_000
        : unit === 'year' ? 365 * 86_400_000
          : undefined;
  return ms === undefined ? undefined : now - ms;
};

const unquote = (value: string): string => value.replace(/^["「]|["」]$/g, '').trim();

export const parseSearchQuery = (raw: string, now = Date.now()): SearchQuery => {
  const query = EMPTY_QUERY();
  const tokens = tokenize(String(raw ?? ''));
  // OR でつながった語をまとめるため、いったん順番つきで溜める
  const operands: Array<{ text: string, quoted: boolean, negated: boolean, orBefore: boolean }> = [];
  let pendingOr = false;

  for (const token of tokens) {
    const colon = token.text.indexOf(':');
    const key = colon > 0 ? token.text.slice(0, colon).toLowerCase() : '';
    const value = colon > 0 ? token.text.slice(colon + 1) : '';

    if (colon > 0 && FILTERS.has(key)) {
      switch (key) {
        case 'from': case 'author':
          query.from.push(unquote(value).toLowerCase());
          break;
        case 'in': case 'channel':
          query.channels.push(unquote(value));
          break;
        case 'mentions': case 'mention':
          query.mentions.push(unquote(value).replace(/[<@!>]/g, ''));
          break;
        case 'has': {
          const has = unquote(value).toLowerCase();
          if (has !== '') query.has.push(has);
          break;
        }
        case 'is': {
          const is = unquote(value).toLowerCase();
          if (is === 'pinned') query.pinned = true;
          else if (is.startsWith('pin')) query.pinned = true;
          else query.ignored.push(token.text);
          break;
        }
        case 'pinned':
          query.pinned = !['false', 'no', '0', 'off'].includes(unquote(value).toLowerCase());
          break;
        case 'before': case 'until': {
          const at = parseWhen(value, now);
          if (at !== undefined) query.before = at;
          else query.ignored.push(token.text);
          break;
        }
        case 'after': case 'since': {
          const at = parseWhen(value, now);
          if (at !== undefined) query.after = at;
          else query.ignored.push(token.text);
          break;
        }
        case 'during': case 'on': {
          const at = key === 'on' ? parseWhen(value, now) : duringStart(value, now);
          if (at !== undefined) {
            query.after = at;
            if (key === 'on') {
              const day = parseWhen(value, now);
              if (day !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(unquote(value))) query.before = day + 86_400_000;
            }
          } else query.ignored.push(token.text);
          break;
        }
        case 'len': case 'length': {
          const m = /^([<>]?)(\d+)$/.exec(unquote(value));
          if (m === null) { query.ignored.push(token.text); break; }
          const n = Number(m[2]);
          if (m[1] === '<') query.maxLength = n;
          else if (m[1] === '>') query.minLength = n;
          else { query.minLength = n; query.maxLength = n; }
          break;
        }
        case 'regex': case 're': {
          const body = unquote(value);
          const m = /^\/(.*)\/([a-z]*)$/.exec(body);
          try {
            query.regex = m !== null ? new RegExp(m[1]!, m[2] || 'i') : new RegExp(body, 'i');
          } catch {
            query.ignored.push(token.text);
          }
          break;
        }
        case 'sort': {
          const v = unquote(value).toLowerCase();
          query.sort = (v === 'old' || v === 'oldest' || v === 'asc') ? 'old' : 'new';
          break;
        }
        default:
          query.ignored.push(token.text);
      }
      continue;
    }

    if (token.text === 'OR' && !token.negated) { pendingOr = true; continue; }
    if (token.text === 'AND' && !token.negated) continue;

    const text = token.quoted ? unquote(token.text) : token.text;
    if (text === '') continue;
    if (!token.quoted && colon > 0 && !FILTERS.has(key) && /^[a-z_]{2,12}$/.test(key) && !/[/]/.test(value)) {
      // 演算子の形をしているが知らないもの (URL は key に // が入るので除外)
      query.ignored.push(token.text);
      pendingOr = false;
      continue;
    }
    if (token.quoted) {
      operands.push({ text, quoted: true, negated: token.negated, orBefore: pendingOr });
      pendingOr = false;
      continue;
    }
    {
      // 長い日本語の塊は語に割る (API は語の一致で探すため)
      for (const term of japaneseTerms(text)) {
        operands.push({ text: term, quoted: false, negated: token.negated, orBefore: pendingOr });
        pendingOr = false;
      }
      continue;
    }
    operands.push({ text, quoted: token.quoted, negated: token.negated, orBefore: pendingOr });
    pendingOr = false;
  }

  // `a OR b OR c` は 1 つの群にする。否定されたものは群に混ぜず、個別に除外する
  for (let i = 0; i < operands.length; i++) {
    const item = operands[i]!;
    const lower = item.text.toLowerCase();
    if (item.negated) { query.notTerms.push(lower); continue; }
    const group = [lower];
    let j = i + 1;
    while (j < operands.length && operands[j]!.orBefore) {
      const next = operands[j]!;
      if (!next.negated) group.push(next.text.toLowerCase());
      j++;
    }
    if (group.length > 1) query.anyOf.push(...group);
    else if (item.quoted) query.phrases.push(lower);
    else query.terms.push(lower);
    i = j - 1;
  }
  return query;
};

/** 何を条件にしたかを 1 行にする (ツールの結果に添えてモデルに返す) */
export const describeQuery = (q: SearchQuery): string => {
  const parts: string[] = [];
  if (q.terms.length > 0) parts.push(q.terms.join(' '));
  if (q.phrases.length > 0) parts.push(...q.phrases.map(p => `"${p}"`));
  if (q.anyOf.length > 0) parts.push(q.anyOf.join(' OR '));
  if (q.notTerms.length > 0) parts.push(...q.notTerms.map(t => `-${t}`));
  if (q.from.length > 0) parts.push(...q.from.map(f => `from:${f}`));
  if (q.channels.length > 0) parts.push(...q.channels.map(c => `in:${c}`));
  if (q.mentions.length > 0) parts.push(...q.mentions.map(m => `mentions:${m}`));
  if (q.has.length > 0) parts.push(...q.has.map(h => `has:${h}`));
  if (q.pinned === true) parts.push('is:pinned');
  const when = (ms: number): string => new Date(ms + TZ_MS).toISOString().slice(0, 16).replace('T', ' ');
  if (q.after !== undefined) parts.push(`after:${when(q.after)}`);
  if (q.before !== undefined) parts.push(`before:${when(q.before)}`);
  if (q.minLength !== undefined) parts.push(`len:>${q.minLength}`);
  if (q.maxLength !== undefined) parts.push(`len:<${q.maxLength}`);
  if (q.regex !== undefined) parts.push(`regex:${q.regex.source}`);
  if (q.sort === 'old') parts.push('sort:old');
  return parts.length === 0 ? '(条件なし)' : parts.join(' ');
};
