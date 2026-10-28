// SPDX-License-Identifier: AGPL-3.0-or-later
import { log, info, warn, error } from '../log.ts';

/// OpenAI互換API向けのAIツール群。
/// akku1139/evex-quotes の src/aitools を移植し、OpenAIのfunction calling形式で使えるようにしたもの。
/// RakutenAIはサーバー側ツールのみ使えるため、このツール群は渡さない。

import { SnowflakeUtil } from 'discord.js';
import {
  type Client,
  type MessageManager,
  type Message,
  type OmitPartialGroupDMChannel,
} from 'discord.js';
import process from 'node:process';
import { discord, fluxer } from '../clients.ts';
import { callMcpTool, getMcpTools } from './mcp-registry.ts';
import { flattenToolName } from './mcp.ts';
import { describeQuery, matchesQuery, parseSearchQuery, type SearchQuery } from './search-query.ts';
import { memoryTool } from '../memory/tools.ts';
import { config, get } from '../config.ts';
import { describeEmbed, describeMessage } from './embeds.ts';
import type { ToolSpec } from './types.ts';

/** ツールの実行結果。成功値はそのままモデルへJSONとして渡される */
export type AIToolResult = [true, unknown] | [false, { error: string }];

export interface AIToolMeta {
  /** 呼び出し元のメッセージ (チャンネルやクライアントの解決に使用) */
  msg: OmitPartialGroupDMChannel<Message<boolean>>,
}

export interface AITool {
  description: string,
  parametersJsonSchema: Record<string, unknown>,
  execute(args: Record<string, unknown>, meta: AIToolMeta): Promise<AIToolResult>,
}

export const DEFAULT_UA = 'MizukiBot (https://github.com/akku1139/mizuki-rakutenai)';

const getEnv = (key: string): string => {
  const map: Record<string, string> = {
    READABILITY_ENDPOINT: get(config, 'ai.readabilityEndpoint', process.env['READABILITY_ENDPOINT'] ?? ''),
    SEARCH_ENDPOINT: get(config, 'ai.searchEndpoint', process.env['SEARCH_ENDPOINT'] ?? ''),
  };
  const v = map[key] ?? process.env[key];
  if (!v) throw new Error(`${key} environment variable is missing.`);
  return v;
};

/** URLのホストからどちらのクライアントで取得するか決める */
const clientForUrl = (url: string, fallback: Client<boolean>): Client<boolean> => {
  if (url.includes('fluxer.app')) return fluxer as unknown as Client<boolean>;
  if (url.includes('discord.com')) return discord as unknown as Client<boolean>;
  return fallback;
};

/** discord.com/fluxer.app のメッセージURL (またはチャンネルURL) をパースする */
const parseMessageUrl = (url: string): { guildId?: string, channelId: string, messageId?: string } | undefined => {
  const split = /https:\/\/(?:canary\.|ptb\.)?(?:discord\.com|fluxer\.app)\/channels\/(\d+)\/(\d+)(?:\/(\d+))?/.exec(url);
  if (!split) return undefined;
  return {
    guildId: split[1],
    channelId: split[2],
    messageId: split[3],
  };
};

/** メッセージをAIに渡す形へ整形 */
const messageToAISchema = async (m: Message<boolean>): Promise<Record<string, unknown>> => ({
  content: m.content,
  embeds: m.embeds.length > 0 ? m.embeds.map(e => describeEmbed(e.data)).filter(e => e !== undefined) : undefined,
  attachments: m.attachments.size > 0
    ? [...m.attachments.values()].map(a => ({ name: a.name, url: a.url, contentType: a.contentType ?? undefined }))
    : undefined,
  forwarded: m.messageSnapshots.size > 0 ? [...m.messageSnapshots.values()].map(s => describeMessage(s)) : undefined,
  url: m.url,
  timestamp: m.createdAt.toISOString(),
  author: {
    displayName: m.member?.displayName ?? m.author.displayName,
    id: m.author.id,
    globalName: m.author.globalName ?? m.author.displayName,
    username: m.author.username,
    bot: m.author.bot,
  },
  replies: m.reference ? {
    guildId: m.reference.guildId,
    channelId: m.reference.channelId,
    messageId: m.reference.messageId,
    type: m.reference.type,
  } : undefined,
});

const errText = (err: unknown): { error: string } => ({
  error: 'エラーが発生しました\n' + (err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
});

/** メッセージ履歴を取得できるチャンネルの最小インターフェース */
interface HistoryChannel {
  id: string,
  name?: string,
  messages: MessageManager,
}

/// fetch_message: メッセージURLから1件取得

const fetchMessage: AITool = {
  description: 'DiscordのメッセージURLからメッセージ内容を取得します',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'メッセージのURL' },
    },
    required: ['url'],
  },
  async execute({ url }, { msg }) {
    try {
      const parsed = parseMessageUrl(String(url));
      if (!parsed?.messageId || !parsed.guildId) return [false, { error: 'URLのパース中にエラーが発生しました' }];
      const client = clientForUrl(String(url), msg.client as Client<boolean>);
      const channel = await client.channels.fetch(parsed.channelId);
      if (!channel?.isTextBased()) return [false, { error: 'チャンネルを取得できませんでした' }];
      if ((config.blacklistedChannels ?? []).includes(parsed.channelId)) return [false, { error: 'このチャンネルはブラックリストです' }];
      const channelParentId = (channel as { parentId?: string | null }).parentId;
      if (channelParentId && (config.blacklistedChannels ?? []).includes(channelParentId)) return [false, { error: 'このチャンネルはブラックリストです' }];
      const channelGuildId = (channel as { guildId?: string; guild?: { id?: string } }).guildId ?? (channel as { guild?: { id?: string } }).guild?.id;
      if (msg.guild && channelGuildId && channelGuildId !== msg.guild.id) return [false, { error: '別サーバーのチャンネルにはアクセスできません' }];
      const message = await channel.messages.fetch(parsed.messageId) as Message<boolean>;
      return [true, await messageToAISchema(message)];
    } catch (err) {
      return [false, errText(err)];
    }
  },
};

/// search_messages: サーバー内のメッセージを検索する。
/// Discord の検索 API は bot に開放されていないので、対象チャンネルを遡って取得し、
/// `search-query.ts` が解釈した条件で自前で絞る。

/** 1 回の検索で見るメッセージ数の既定と上限 */
const SEARCH_SCAN_DEFAULT = 1_000;
const SEARCH_SCAN_MAX = 5_000;
/** 1 リクエストで取る件数 (Discord の上限) */
const SEARCH_PAGE = 100;
/** 一度に遡るチャンネルの上限 (`all` のとき) */
const SEARCH_MAX_CHANNELS = 12;

interface SearchTarget {
  id: string;
  name: string;
  messages: { fetch(options: Record<string, unknown>): Promise<Map<string, any>> };
}

const textChannelsOf = (guild: any, blacklist: readonly string[]): SearchTarget[] => {
  const blocked = (id: string, parentId?: string | null): boolean =>
    blacklist.includes(id) || (parentId !== undefined && parentId !== null && blacklist.includes(parentId));
  const out: SearchTarget[] = [];
  for (const ch of guild.channels?.cache?.values?.() ?? []) {
    if (typeof ch?.isTextBased === 'function' && !ch.isTextBased()) continue;
    if (blocked(ch.id, ch.parentId)) continue;
    out.push({ id: ch.id, name: ch.name ?? ch.id, messages: ch.messages });
  }
  for (const t of guild.threads?.cache?.values?.() ?? []) {
    if (blocked(t.id, t.parentId)) continue;
    out.push({ id: t.id, name: `#${t.parent?.name ?? '?'} / ${t.name}`, messages: t.messages });
  }
  return out;
};

/** `in:` の値 (チャンネル ID / #名前 / メッセージやチャンネルの URL) を対象に解決する */
const resolveTargets = (values: readonly string[], guild: any, fallback: SearchTarget): { targets: SearchTarget[], missing: string[] } => {
  if (values.length === 0) return { targets: [fallback], missing: [] };
  const known = textChannelsOf(guild, []);
  const byId = new Map(known.map(t => [t.id, t]));
  const byName = new Map<string, SearchTarget[]>();
  for (const t of known) {
    const name = t.name.replace(/^#/, '').toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), t]);
  }
  const targets: SearchTarget[] = [];
  const missing: string[] = [];
  for (const raw of values) {
    const value = raw.replace(/[<>]/g, '').trim();
    if (value === '' ) continue;
    const url = /channels\/\d+\/(\d+)/.exec(value);
    const id = url?.[1] ?? (/^\d{5,}$/.test(value) ? value : undefined);
    if (id !== undefined) {
      const hit = byId.get(id);
      if (hit !== undefined) { if (!targets.includes(hit)) targets.push(hit); }
      else missing.push(raw);
      continue;
    }
    const name = value.replace(/^#/, '').toLowerCase();
    const hits = byName.get(name) ?? [];
    for (const hit of hits) if (!targets.includes(hit)) targets.push(hit);
    if (hits.length === 0) missing.push(raw);
  }
  return { targets, missing };
};

/** 1 チャンネルを遡り、条件に合うものを集める */
const searchChannel = async (
  target: SearchTarget,
  query: SearchQuery,
  need: number,
  budget: number,
): Promise<{ hits: any[], scanned: number }> => {
  const hits: any[] = [];
  let scanned = 0;
  let before: string | undefined;
  // after があれば、そこより古くなったら止める (取得自体も after で絞る)
  const afterId = query.after !== undefined ? SnowflakeUtil.generate({ timestamp: query.after }).toString() : undefined;

  while (scanned < budget && hits.length < need) {
    const limit = Math.min(SEARCH_PAGE, budget - scanned);
    let batch: Map<string, any>;
    try {
      batch = await target.messages.fetch({
        limit,
        ...(before !== undefined ? { before } : {}),
        ...(afterId !== undefined ? { after: afterId } : {}),
      });
    } catch {
      break; // 読めないチャンネルは飛ばす
    }
    if (batch.size === 0) break;
    let oldest = Number.MAX_SAFE_INTEGER;
    for (const m of batch.values()) {
      scanned++;
      if (typeof m?.createdTimestamp === 'number' && m.createdTimestamp < oldest) oldest = m.createdTimestamp;
      if (matchesQuery(m, query)) hits.push(m);
      if (hits.length >= need) break;
    }
    if (batch.size < limit) break; // これ以上古いものが無い
    if (query.after !== undefined && oldest < query.after) break;
    const oldestId = [...batch.keys()].reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
    if (oldestId === before) break;
    before = oldestId;
  }
  return { hits, scanned };
};

/** 検索で使える has: の値 (公式検索の has に対応) */
const SEARCH_HAS_TYPES = new Set(['image', 'sound', 'video', 'file', 'sticker', 'embed', 'link', 'poll', 'snapshot']);

interface OfficialSearchResult {
  messages: any[];
  total: number;
}

/**
 * 公式の検索 (GET /guilds/{id}/messages/search)。
 * bot からも使える (要 READ_MESSAGE_HISTORY、MESSAGE_CONTENT intent の制限は受ける)。
 * 索引がまだ無いときは 202 と `retry_after` が返るので、指定された分だけ待って 1 回だけやり直す。
 */
const searchViaApi = async (
  msg: OmitPartialGroupDMChannel<Message<boolean>>,
  query: SearchQuery,
  channelIds: string[],
  limit: number,
): Promise<OfficialSearchResult> => {
  const client = msg.client;
  const guild = msg.guild!;
  const members = guild.members;

  // from: はユーザー ID でも名前でも書ける。名前はメンバーから引く
  const authorIds: string[] = [];
  const unresolvedFrom: string[] = [];
  for (const from of query.from) {
    if (/^\d{5,}$/.test(from) || /^\d+$/.test(from)) { authorIds.push(from); continue; }
    const nameMatches = (m: { user: { username: string, globalName: string | null }, displayName: string }) =>
      m.user.username.toLowerCase().includes(from)
      || (m.user.globalName ?? '').toLowerCase().includes(from)
      || m.displayName.toLowerCase().includes(from);
    const cached = [...members.cache.values()].find(nameMatches);
    if (cached !== undefined) { authorIds.push(cached.id); continue; }
      // キャッシュに無い名前はサーバーに問い合わせる
    try {
      const found = await members.fetch({ query: from, limit: 5 });
      const hit = [...found.values()].find(nameMatches);
      if (hit !== undefined) authorIds.push(hit.id);
      else unresolvedFrom.push(from);
    } catch {
      unresolvedFrom.push(from);
    }
  }

  const base: Record<string, unknown> = {
    content: [...query.terms, ...query.phrases.map(p => `"${p}"`), ...query.anyOf].join(' ').trim() || undefined,
    channel_id: channelIds.length > 0 ? channelIds : [msg.channelId],
    ...(authorIds.length > 0 ? { author_id: authorIds } : {}),
    ...(query.mentions.length > 0 ? { mentions: query.mentions } : {}),
    ...(query.pinned === true ? { pinned: true } : {}),
    ...(query.has.length > 0 ? { has: query.has.filter(h => SEARCH_HAS_TYPES.has(h)) } : {}),
    ...(query.after !== undefined ? { min_id: SnowflakeUtil.generate({ timestamp: query.after }).toString() } : {}),
    ...(query.before !== undefined ? { max_id: SnowflakeUtil.generate({ timestamp: query.before }).toString() } : {}),
    sort_by: 'timestamp',
    sort_order: query.sort === 'old' ? 'asc' : 'desc',
    include_nsfw: ('nsfw' in msg.channel ? Boolean((msg.channel as { nsfw?: boolean }).nsfw) : false),
  };

  const collected: any[] = [];
  let total = 0;
  let offset = 0;
  let retried = false;
  while (collected.length < limit && offset <= 9_975) {
    const page = await client.rest.get(`/guilds/${guild.id}/messages/search`, {
      query: new URLSearchParams(
        Object.entries({ ...base, limit: Math.min(25, limit - collected.length), offset })
          .filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))
          .flatMap(([k, v]) => (Array.isArray(v) ? v.map(item => [k, String(item)]) : [[k, String(v)]])) as Array<[string, string]>,
      ),
    }) as { messages?: any[][], total_results?: number, code?: number, retry_after?: number };

    // 索引がまだ無い (202)
    if (page?.code === 11_0000 || (page?.retry_after !== undefined && page?.messages === undefined)) {
      if (retried) throw new Error('検索の索引がまだ準備できていません。少し待ってからもう一度試してください');
      retried = true;
      const wait = Math.min(Math.max(Number(page.retry_after ?? 1), 0), 5) * 1000;
      await new Promise(resolve => setTimeout(resolve, wait));
      continue;
    }
    const rows = (page?.messages ?? []).flat();
    total = Number(page?.total_results ?? rows.length);
    if (rows.length === 0) break;
    for (const m of rows) if (!collected.some(c => c.id === m.id)) collected.push(m);
    if (rows.length < 25) break;
    offset += rows.length;
  }
  if (unresolvedFrom.length > 0) {
    log(`search: from:${unresolvedFrom.join(',')} に当たるメンバーが見つからないので条件から外しました`);
  }
  return { messages: collected, total };
};

/** 公式検索の生メッセージを、自前の判定 (`matchesQuery`) が読める形に均す */
const normalizeApiMessage = (m: any): any => {
  const at = Date.parse(String(m?.timestamp ?? ''));
  return {
    id: m?.id,
    url: typeof m?.id === 'string' && typeof m?.channel_id === 'string'
      ? `https://discord.com/channels/${m.guild_id ?? '@me'}/${m.channel_id}/${m.id}`
      : undefined,
    channel_id: m?.channel_id,
    content: typeof m?.content === 'string' ? m.content : '',
    createdTimestamp: Number.isNaN(at) ? 0 : at,
    pinned: m?.pinned === true,
    author: {
      id: m?.author?.id,
      username: m?.author?.username,
      globalName: m?.author?.global_name ?? null,
      displayName: m?.member?.nick ?? m?.author?.global_name ?? null,
    },
    mentions: { users: { has: (id: string) => Array.isArray(m?.mentions) && m.mentions.some((u: { id?: string }) => u?.id === id) } },
    embeds: Array.isArray(m?.embeds) ? m.embeds : [],
    attachments: {
      size: Array.isArray(m?.attachments) ? m.attachments.length : 0,
      values: () => (Array.isArray(m?.attachments) ? m.attachments : []).map((a: any) => ({
        contentType: a?.content_type ?? null,
        name: a?.filename,
        url: a?.url,
      }))[Symbol.iterator](),
    },
    stickers: { size: Array.isArray(m?.sticker_items) ? m.sticker_items.length : 0 },
    poll: m?.poll,
    reactions: { cache: { size: Array.isArray(m?.reactions) ? m.reactions.length : 0 } },
  };
};

const searchMessages: AITool = {
  description: 'サーバー内のメッセージを、Discord の検索と同じ書き方で探す (Discord の検索 API を使う)。'
    + 'query に語と条件をまとめて書ける (例: `from:たこ has:image after:2026-10-01 "デプロイ 失敗" -warn`)。'
    + '使える条件: from: (ユーザー名/ID) in: (#チャンネル名/ID/URL) mentions: (ユーザーID) has: (link/embed/image/file/sticker/poll/reaction) '
    + 'before: after: during: (2026-10-01 / 2026-10 / 7d / 24h) is:pinned len:>100 len:<50 regex:/…/i sort:old。'
    + '`OR` でどちらか、先頭に - で除外、"" でフレーズ。既定は現在のチャンネルだけを新しい順に見る。'
    + 'サーバー全体を見るときは channels: "all"。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '検索語と条件 (上記の書き方)' },
      channels: { type: 'string', description: '対象チャンネル (#名前 / ID / URL をカンマ区切り)。"all" でサーバー全体。省略時は現在のチャンネル' },
      limit: { type: 'number', description: '返す最大件数 (既定 20, 最大 50)' },
      scan: { type: 'number', description: '何件まで遡って調べるか (既定 1000, 最大 5000)。結果が少ないときは増やす' },
    },
  },
  async execute({ query: rawQuery, channels, limit, scan }, { msg }) {
    try {
      if (!msg.guild) return [false, { error: 'サーバー内でのみ使用できます' }];
      const query = parseSearchQuery(typeof rawQuery === 'string' ? rawQuery : '');
      const blacklist = config.blacklistedChannels ?? [];
      const limits = typeof limit === 'number' ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 20;
      const budgetTotal = typeof scan === 'number'
        ? Math.min(Math.max(Math.trunc(scan), 50), SEARCH_SCAN_MAX)
        : SEARCH_SCAN_DEFAULT;

      const current: SearchTarget = {
        id: msg.channel.id,
        name: 'name' in msg.channel ? `#${(msg.channel as { name: string }).name}` : msg.channel.id,
        messages: (msg.channel as unknown as SearchTarget).messages,
      };

      // 対象チャンネル: channels 引数 > in: > 現在のチャンネル
      const requested = [
        ...(typeof channels === 'string' && channels.trim() !== '' ? channels.split(/[,、\s]+/).filter(Boolean) : []),
        ...query.channels,
      ];
      let targets: SearchTarget[];
      let missing: string[] = [];
      if (requested.some(v => v.toLowerCase() === 'all')) {
        targets = textChannelsOf(msg.guild, blacklist).slice(0, SEARCH_MAX_CHANNELS);
      } else {
        const resolved = resolveTargets(requested, msg.guild, current);
        targets = resolved.targets;
        missing = resolved.missing;
      }
      targets = targets.filter(t => !blacklist.includes(t.id));
      if (targets.length === 0) return [false, { error: `対象のチャンネルが見つかりません: ${missing.join(', ') || 'なし'}` }];

      // まず公式の検索 API。使えないとき (権限不足・Fluxer・索引なし) だけ自前で遡る
      let collected: Array<{ message: any, target: SearchTarget }> = [];
      let scanned = 0;
      let via: 'api' | 'paging' = 'api';
      try {
        const result = await searchViaApi(msg, query, targets.map(t => t.id), limits);
        const byId = new Map(targets.map(t => [t.id, t]));
        for (const raw of result.messages) {
          const message = normalizeApiMessage(raw);
          if (!matchesQuery(message, query)) continue;
          const target = byId.get(String(message.channel_id)) ?? targets[0]!;
          collected.push({ message, target });
        }
      } catch (e) {
        via = 'paging';
        log('search: 公式検索が使えないので自前で遡ります:', e instanceof Error ? e.message : e);
        const perChannel = Math.max(50, Math.floor(budgetTotal / targets.length));
        for (const target of targets) {
          const result = await searchChannel(target, query, limits - collected.length, perChannel);
          scanned += result.scanned;
          for (const message of result.hits) collected.push({ message, target });
          if (collected.length >= limits) break;
        }
      }

      collected.sort((a, b) => query.sort === 'old'
        ? (a.message.createdTimestamp ?? 0) - (b.message.createdTimestamp ?? 0)
        : (b.message.createdTimestamp ?? 0) - (a.message.createdTimestamp ?? 0));

      const messages = collected.slice(0, limits).map(({ message, target }) => ({
        id: message.id,
        url: message.url ?? `https://discord.com/channels/${msg.guild!.id}/${message.channel_id ?? target.id}/${message.id}`,
        channelId: message.channel_id ?? target.id,
        channelName: target.name,
        author: message.author?.username ?? message.author?.global_name ?? '?',
        authorId: message.author?.id,
        at: (message.createdTimestamp ?? 0) > 0 ? new Date(message.createdTimestamp).toISOString() : undefined,
        content: typeof message.content === 'string' ? message.content.slice(0, 400) : '',
        ...(message.attachments !== undefined && (message.attachments.size ?? 0) > 0
          ? { attachments: [...message.attachments.values()].slice(0, 5).map((a: { name?: string, url?: string }) => a.name ?? a.url) }
          : {}),
      }));

      return [true, {
        query: describeQuery(query),
        via,
        ...(query.ignored.length > 0 ? { ignoredOperators: query.ignored } : {}),
        ...(missing.length > 0 ? { unknownChannels: missing } : {}),
        channelsSearched: targets.map(t => t.name),
        ...(via === 'paging' ? { scanned } : {}),
        count: messages.length,
        ...(messages.length === 0
          ? { hint: '条件を緩めるか、期間 (after:) を広げてください。サーバー全体を見るには channels: "all"' }
          : {}),
        messages,
      }];
    } catch (err) {
      return [false, errText(err)];
    }
  },
};

/// fetch_messages_history: 特定メッセージ周辺の履歴を取得

const fetchMessagesHistory: AITool = {
  description: 'Discordのチャンネル履歴を取得します。anchor 未指定ならチャンネルの最新メッセージを起点にします。channel 未指定で anchor が別チャンネルのメッセージを指す場合は、そのチャンネルを解決します。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'チャンネルURLまたは <#id>。未指定なら anchor または現在のチャンネル' },
      anchor: { type: 'string', description: '起点メッセージのURLまたはID。未指定ならチャンネルの最新メッセージ' },
      direction: {
        type: 'string',
        enum: ['before', 'after', 'around'],
        description: '取得方向。before: 古い, after: 新しい, around: 周辺。既定 before',
      },
      limit: { type: 'number', description: '取得するメッセージ数 (1-100, 既定 30)' },
    },
  },
  async execute({ channel: channelArg, anchor, direction, limit }, { msg }) {
    try {
      let ch = msg.channel as unknown as HistoryChannel;
      const channelExplicit = channelArg !== undefined && channelArg !== '';

      if (channelExplicit) {
        const mention = /<#(\d+)>/.exec(String(channelArg));
        const parsed = parseMessageUrl(String(channelArg));
        if (mention?.[1]) {
          const fetched = await msg.client.channels.fetch(mention[1]);
          if (!fetched?.isTextBased()) return [false, { error: 'チャンネルを取得できませんでした' }];
          ch = fetched as unknown as HistoryChannel;
        } else if (parsed?.channelId) {
          const client = clientForUrl(String(channelArg), msg.client as Client<boolean>);
          const fetched = await client.channels.fetch(parsed.channelId);
          if (!fetched?.isTextBased()) return [false, { error: 'チャンネルを取得できませんでした' }];
          ch = fetched as unknown as HistoryChannel;
        } else {
          return [false, { error: 'チャンネルのパースに失敗しました' }];
        }
      }

      const dir = direction === 'after' || direction === 'around' ? direction : 'before';
      const lim = typeof limit === 'number' ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 30;

      let anchorId: string | undefined;
      if (anchor !== undefined && anchor !== '') {
        const parsed = parseMessageUrl(String(anchor));
        anchorId = parsed?.messageId ?? String(anchor);
        // channel 未指定時は anchor が存在するチャンネルを解決する
        if (!channelExplicit) {
          if (parsed?.channelId) {
            const client = clientForUrl(String(anchor), msg.client as Client<boolean>);
            const fetched = await client.channels.fetch(parsed.channelId);
            if (fetched?.isTextBased()) ch = fetched as unknown as HistoryChannel;
          } else if (msg.guild) {
            for (const c of msg.guild.channels.cache.values()) {
              if (!c.isTextBased()) continue;
              try {
                const m = await (c as any).messages.fetch(anchorId);
                if (m) { ch = c as unknown as HistoryChannel; break; }
              } catch {}
            }
            // スレッドも検索
            for (const t of (msg.guild as any).threads?.cache?.values?.() ?? []) {
              try {
                const m = await t.messages.fetch(anchorId);
                if (m) { ch = t as unknown as HistoryChannel; break; }
              } catch {}
            }
          }
        }
      } else {
        const latest = await ch.messages.fetch({ limit: 1 });
        anchorId = [...latest.values()][0]?.id;
        if (!anchorId && msg.id) anchorId = msg.id;
      }

      if ((config.blacklistedChannels ?? []).includes(ch.id)) return [false, { error: 'このチャンネルはブラックリストです' }];
      const chParentId = (ch as { parentId?: string | null }).parentId;
      if (chParentId && (config.blacklistedChannels ?? []).includes(chParentId)) return [false, { error: 'このチャンネルはブラックリストです' }];
      const chGuildId = (ch as { guildId?: string; guild?: { id?: string } }).guildId ?? (ch as { guild?: { id?: string } }).guild?.id;
      if (msg.guild && chGuildId && chGuildId !== msg.guild.id) return [false, { error: '別サーバーのチャンネルにはアクセスできません' }];

      const fetchOpts: Record<string, unknown> = { cache: false, limit: lim };
      if (anchorId) fetchOpts[dir === 'after' ? 'after' : dir === 'before' ? 'before' : 'around'] = anchorId;

      const messages = await ch.messages.fetch(fetchOpts as Parameters<typeof ch.messages.fetch>[0]);
      const items = await Promise.all([...messages.values()].map(async m => ({
        id: m.id,
        ...(await messageToAISchema(m)),
      })));
      items.sort((a: any, b: any) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

      return [true, {
        channel: { id: ch.id, name: (ch as unknown as { name?: string }).name },
        anchor: anchorId,
        direction: dir,
        count: items.length,
        messages: items,
      }];
    } catch (err) {
      return [false, errText(err)];
    }
  },
};


const wikipediaSearch: AITool = {
  description: 'Wikipediaを検索します',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '検索クエリ' },
    },
    required: ['query'],
  },
  async execute({ query }) {
    try {
      const res = await fetch(
        `https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(String(query))}&format=json`,
        { headers: { 'User-Agent': DEFAULT_UA } },
      );
      if (!res.ok) return [false, { error: `HTTPステータスコード: ${res.status} (${res.statusText})` }];
      return [true, ((await res.json()) as { query?: unknown })['query']];
    } catch (err) {
      return [false, errText(err)];
    }
  },
};

/// wikipedia_read: Wikipedia記事の本文を取得

const wikipediaRead: AITool = {
  description: 'ページタイトルを指定してWikipediaの記事本文を取得します',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'ページタイトル' },
    },
    required: ['title'],
  },
  async execute({ title }) {
    try {
      const res = await fetch(
        `https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&titles=${encodeURIComponent(String(title))}&explaintext=1&format=json`,
        { headers: { 'User-Agent': DEFAULT_UA } },
      );
      if (!res.ok) return [false, { error: `HTTPステータスコード: ${res.status} (${res.statusText})` }];
      return [true, ((await res.json()) as { query?: { pages?: unknown } }).query?.pages];
    } catch (err) {
      return [false, errText(err)];
    }
  },
};

/// read_web: Readabilityエンドポイント経由でWebページを閲覧 (READABILITY_ENDPOINT が無い場合は無効)

const readabilityEndpoint = get(config, 'ai.readabilityEndpoint', process.env['READABILITY_ENDPOINT']);

const readWeb: AITool = {
  description: 'Readability.jsを使ってWebサイトを閲覧します。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'WebページのURL' },
    },
    required: ['url'],
  },
  async execute({ url }) {
    try {
      const res = await fetch(`${new URL(getEnv('READABILITY_ENDPOINT'))}?url=${encodeURIComponent(String(url))}`, {
        headers: { 'User-Agent': DEFAULT_UA },
      });
      if (!res.ok) return [false, { error: `HTTPステータスコード: ${res.status} (${res.statusText})` }];
      return [true, await res.json()];
    } catch (err) {
      return [false, errText(err)];
    }
  },
};

/// search_web: 検索エンドポイント経由で Web 検索
/// 1 回の tool call で複数クエリを並列実行する。
const searchWeb: AITool = {
  description: 'Web を検索します。複数の検索クエリを指定すると並列で検索します。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: {
          type: 'string',
          description: '検索クエリ (スペース区切り、Google 検索と同じ構文が使用可能)',
        },
        minItems: 1,
        maxItems: 6,
        description: '検索クエリの配列。複数指定すると並列で検索します。',
      },
    },
    required: ['queries'],
  },

  async execute({ queries }) {
    try {
      if (!Array.isArray(queries)) {
        return [false, {
          error: 'queries は文字列の配列で指定してください',
        }];
      }

      if (queries.length < 1 || queries.length > 6) {
        return [false, {
          error: 'queries は 1〜6 個指定してください',
        }];
      }

      const normalizedQueries: string[] = [];

      for (const query of queries) {
        if (typeof query !== 'string') {
          return [false, {
            error: 'queries の各要素は文字列で指定してください',
          }];
        }

        const normalized = query.trim();
        if (normalized === '') {
          return [false, {
            error: 'queries に空の検索クエリは指定できません',
          }];
        }

        normalizedQueries.push(normalized);
      }

      const endpoint = new URL(getEnv('SEARCH_ENDPOINT'));

      const results = await Promise.all(
        normalizedQueries.map(async query => {
          const url = `${endpoint}?q=${encodeURIComponent(query)}`;

          const res = await fetch(url, {
            headers: { 'User-Agent': DEFAULT_UA },
          });

          if (!res.ok) {
            return {
              query,
              error: `HTTPステータスコード: ${res.status} (${res.statusText})`,
            };
          }

          return {
            query,
            result: await res.json(),
          };
        }),
      );

      return [true, results];
    } catch (err) {
      return [false, errText(err)];
    }
  },
};

/** 利用可能なツール一覧。エンドポイント系は環境変数が設定されている場合のみ含める */
export let aitools: Record<string, AITool> = {
  memory: memoryTool,
  fetch_message: fetchMessage,
  fetch_messages_history: fetchMessagesHistory,
  search_messages: searchMessages,
  wikipedia_search: wikipediaSearch,
  wikipedia_read: wikipediaRead,
  ...(readabilityEndpoint ? { read_web: readWeb } : {}),
  ...(get(config, 'ai.searchEndpoint', process.env['SEARCH_ENDPOINT']) ? { search_web: searchWeb } : {}),
};

/** OpenAI function calling 形式のツール定義に変換する ($explain を自動追加) */
const searchMcpTools: AITool = {
  description: 'MCP ツールをキーワードで検索します。query が空なら一覧を返します。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '検索キーワード' },
      offset: { type: 'number', description: 'オフセット (既定 0)' },
    },
  },
  async execute({ query, offset }) {
    const q = typeof query === 'string' ? query.toLowerCase().trim() : '';
    const off = typeof offset === 'number' ? Math.max(0, Math.trunc(offset)) : 0;
    const all = getMcpTools();
    const terms = q.split(/\\s+/).filter(Boolean);
    const scored = all.map(t => {
      const hay = (t.name + ' ' + t.description + ' ' + t.server).toLowerCase();
      let score = 0;
      if (q && hay.includes(q)) score += 5;
      for (const term of terms) {
        if (hay.includes(term)) score += 2;
        if (t.name.toLowerCase().startsWith(term)) score += 3;
        if (t.name.toLowerCase() === term) score += 5;
      }
      return { t, score };
    }).filter(x => q === '' || x.score > 0)
      .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
    const filtered = scored.map(x => x.t);
    const page = filtered.slice(off, off + 20);
    return [true, {
      tools: page.map(t => ({
        tool_id: flattenToolName(t.server, t.name),
        server: t.server,
        name: t.name,
        description: t.description.slice(0, 1000),
        inputSchema: t.inputSchema,
      })),
      totalMatches: filtered.length,
      nextOffset: off + page.length < filtered.length ? off + page.length : null,
    }];
  },
};

const runMcpTool: AITool = {
  description: 'search_tools で見つけた tool_id を指定して MCP ツールを実行します。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      tool_id: { type: 'string', description: 'search_tools が返した tool_id' },
      arguments: { type: 'object', description: 'ツールに渡す引数' },
    },
    required: ['tool_id'],
  },
  async execute({ tool_id, arguments: args }) {
    if (typeof tool_id !== 'string') return [false, { error: 'tool_id は文字列で指定してください' }];
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
    const r = await callMcpTool(tool_id, a);
    if (r === null) {
      const near = getMcpTools()
        .map(t => flattenToolName(t.server, t.name))
        .filter(n => n.toLowerCase().includes(String(tool_id).toLowerCase().slice(0, 20)))
        .slice(0, 5);
      return [false, { error: `unknown tool_id. Closest: ${near.join(', ') || 'none'}` }];
    }
    return [r.ok, r.text] as AIToolResult;
  },
};

export const getAllAitools = (): Record<string, AITool> => {
  const out: Record<string, AITool> = { ...aitools };
  const mcpTools = getMcpTools();
  if (mcpTools.length === 0) return out;
  if (mcpTools.length <= 20) {
    for (const t of mcpTools) {
      const flat = flattenToolName(t.server, t.name);
      out[flat] = {
        description: t.description,
        parametersJsonSchema: t.inputSchema,
        async execute(args) {
          const r = await callMcpTool(flat, args);
          if (r === null) return [false, { error: 'mcp tool not found' }];
          return [r.ok, r.text] as AIToolResult;
        },
      };
    }
  } else {
    out['search_tools'] = searchMcpTools;
    out['run_tool'] = runMcpTool;
  }
  return out;
};

export const toOpenAITools = (): Array<Record<string, unknown>> =>
  Object.entries(getAllAitools()).map(([name, t]) => {
    const p = t.parametersJsonSchema as {
      properties?: Record<string, unknown>,
      required?: ReadonlyArray<string>,
    };
    return {
      type: 'function',
      function: {
        name,
        description: t.description,
        parameters: {
          ...p,
          properties: {
            ...p.properties,
            '$explain': { type: 'string', description: 'この関数呼び出しで何をするのかの簡単な説明' },
          },
          required: [...(p.required ?? []), '$explain'],
        },
      },
    };
  });

export interface ExecutedToolCall {
  name: string,
  args: Record<string, unknown>,
  /** モデルが$explainに書いた実行内容の説明 (進捗表示に使う) */
  explain: string | undefined,
  result: AIToolResult,
}

/** ツールを実行する。存在しないツール名の場合はエラー結果を返す */
export const executeAITool = async (
  name: string,
  args: Record<string, unknown>,
  meta: AIToolMeta,
): Promise<AIToolResult> => {
  const tool = getAllAitools()[name];
  if (!tool) return [false, { error: `function: ${name} は存在しません` }];
  log('tool call:', name, ':', args);
  return tool.execute(args, meta);
};

/** MCP ツールを aitools に反映する */
export const refreshMcpTools = (): void => {
  // 既存の MCP エントリを除去
  for (const k of Object.keys(aitools)) {
    if (k.startsWith('mcp__')) delete aitools[k];
  }
  for (const t of getMcpTools()) {
    const flat = flattenToolName(t.server, t.name);
    aitools[flat] = {
      description: t.description,
      parametersJsonSchema: t.inputSchema,
      async execute(args) {
        const r = await callMcpTool(flat, args);
        if (r === null) return [false, { error: 'mcp tool not found' }];
        return [r.ok, r.text] as AIToolResult;
      },
    };
  }
};

/** ChatSessionへ渡すToolSpec (呼び出し時に最新の aitools を使う) */
export const getAitoolsSpec = (): ToolSpec => ({
  definitions: toOpenAITools(),
  execute: executeAITool,
});
