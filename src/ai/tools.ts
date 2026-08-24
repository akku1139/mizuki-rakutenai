// SPDX-License-Identifier: AGPL-3.0-or-later

/// OpenAI互換API向けのAIツール群。
/// akku1139/evex-quotes の src/aitools を移植し、OpenAIのfunction calling形式で使えるようにしたもの。
/// RakutenAIはサーバー側ツールのみ使えるため、このツール群は渡さない。

import {
  type Client,
  type MessageManager,
  type Message,
  type OmitPartialGroupDMChannel,
} from 'discord.js';
import process from 'node:process';
import { discord, fluxer } from '../clients.ts';
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
  const v = process.env[key];
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
      const message = await channel.messages.fetch(parsed.messageId) as Message<boolean>;
      return [true, await messageToAISchema(message)];
    } catch (err) {
      return [false, errText(err)];
    }
  },
};

/// fetch_messages_history: 特定メッセージ周辺の履歴を取得

const fetchMessagesHistory: AITool = {
  description: 'Discordの特定メッセージ周辺のメッセージ履歴を取得します',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '起点のメッセージまたはチャンネルのURL、またはチャンネルメンション (デフォルトでは現在のチャンネルの最後のメッセージ)' },
      limit: { type: 'number', description: '取得するメッセージの個数', default: 30 },
      mode: {
        type: 'string',
        enum: ['after', 'before', 'around'],
        description: 'メッセージ取得モード。指定したメッセージから (after: 新しい, before: 古い, around: 周辺) を取得します。',
        default: 'around',
      },
    },
  },
  async execute({ url, limit, mode }, { msg }) {
    try {
      let channel = msg.channel as unknown as HistoryChannel;
      let targetMessageID: string | undefined = msg.id;
      if (url !== undefined && url !== '') {
        const mention = /<#(\d+)>/.exec(String(url));
        const parsed = parseMessageUrl(String(url));
        if (mention?.[1]) {
          targetMessageID = undefined;
          const fetched = await msg.client.channels.fetch(mention[1]);
          if (!fetched?.isTextBased()) return [false, { error: 'チャンネルを取得できませんでした' }];
          channel = fetched as unknown as HistoryChannel;
        } else if (parsed) {
          const client = clientForUrl(String(url), msg.client as Client<boolean>);
          targetMessageID = parsed.messageId;
          const fetched = await client.channels.fetch(parsed.channelId);
          if (!fetched?.isTextBased()) return [false, { error: 'チャンネルを取得できませんでした' }];
          channel = fetched as unknown as HistoryChannel;
        } else {
          return [false, { error: 'URL/チャンネルメンションのパース中にエラーが発生しました' }];
        }
      }
      const messages = await channel.messages.fetch({
        ...{ [mode === 'after' || mode === 'before' ? mode : 'around']: targetMessageID },
        cache: false,
        limit: typeof limit === 'number' ? Math.min(Math.max(limit, 1), 100) : 30,
      } as Parameters<typeof channel.messages.fetch>[0]);
      return [true, {
        ...(await Promise.all([...messages.values()].map(async m => [m.id, await messageToAISchema(m)]))
          .then(entries => Object.fromEntries(entries))),
        channel: {
          id: channel.id,
          name: (channel as unknown as { name?: string }).name,
        },
      }];
    } catch (err) {
      return [false, errText(err)];
    }
  },
};

/// wikipedia_search: Wikipedia記事を検索

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

const readabilityEndpoint = process.env['READABILITY_ENDPOINT'];

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

/// search_web: 検索エンドポイント経由でWeb検索 (SEARCH_ENDPOINT が無い場合は無効)

const searchWeb: AITool = {
  description: 'Webを検索します。',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '検索クエリ (スペース区切り、Google検索と同じ構文が使用可能)' },
    },
    required: ['query'],
  },
  async execute({ query }) {
    try {
      const res = await fetch(`${new URL(getEnv('SEARCH_ENDPOINT'))}?q=${encodeURIComponent(String(query))}`, {
        headers: { 'User-Agent': DEFAULT_UA },
      });
      if (!res.ok) return [false, { error: `HTTPステータスコード: ${res.status} (${res.statusText})` }];
      return [true, await res.json()];
    } catch (err) {
      return [false, errText(err)];
    }
  },
};

/** 利用可能なツール一覧。エンドポイント系は環境変数が設定されている場合のみ含める */
export const aitools: Record<string, AITool> = {
  fetch_message: fetchMessage,
  fetch_messages_history: fetchMessagesHistory,
  wikipedia_search: wikipediaSearch,
  wikipedia_read: wikipediaRead,
  ...(readabilityEndpoint ? { read_web: readWeb } : {}),
  ...(process.env['SEARCH_ENDPOINT'] ? { search_web: searchWeb } : {}),
};

/** OpenAI function calling 形式のツール定義に変換する ($explain を自動追加) */
export const toOpenAITools = (): Array<Record<string, unknown>> =>
  Object.entries(aitools).map(([name, t]) => {
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
  const tool = aitools[name];
  if (!tool) return [false, { error: `function: ${name} は存在しません` }];
  return tool.execute(args, meta);
};

/** ChatSessionへ渡すToolSpec */
export const aitoolsSpec: ToolSpec = {
  definitions: toOpenAITools(),
  execute: executeAITool,
};
