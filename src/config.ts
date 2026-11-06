// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseJson, ensureDataDirectory } from './utils.ts';

/// 固定パスの data/config.json を読み込む。無ければ空オブジェクト (env にフォールバック)。

import fs from 'node:fs';

export interface OpenAIProfile {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** ユーザーがaimodelで選べるモデル。未設定ならモデルIDの変更は不可 */
  allowedModels?: string[];
  /** コンテキストウィンドウ (トークン)。auto-compact の予算はこの 75% */
  contextWindowTokens?: number;
}

export interface McpServerConfig {
  name: string;
  description?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  transport?: 'http' | 'sse' | 'stdio';
  enabled?: boolean;
  timeoutMs?: number;
}

export interface Config {
  mcpServers?: McpServerConfig[];
  blacklistedChannels?: string[];
  discord?: {
    token?: string;
    logWebhookUrl?: string;
    botUserId?: string;
    guildId?: string;
    quickLeaveChannelId?: string;
  };
  fluxer?: {
    token?: string;
    logWebhookId?: string;
    logWebhookToken?: string;
    botUserId?: string;
    guildId?: string;
    quickLeaveChannelId?: string;
    apiBase?: string;
    cdnBase?: string;
  };
  ai?: {
    defaultProvider?: string;
    openaiProfiles?: Record<string, OpenAIProfile>;
    activeOpenaiProfile?: string | null;
    /** コンテキストウィンドウ (トークン)。auto-compact の予算はこの 75%。未設定なら 128k */
    contextWindowTokens?: number;
    readabilityEndpoint?: string | null;
    searchEndpoint?: string | null;
    /** llama.cppのchat completions。未設定ならメンション時だけ応答する */
    participation?: { endpoint: string, channels: string[], model?: string, threshold?: number, cooldownMs?: number };
    /** 本人とbotが読める同一サーバーのチャンネルで履歴を共有する (既定 false) */
    shareChannelContext?: boolean;
  };
  miq?: {
    token?: string | null;
    baseUrl?: string;
  };
  fluxsync?: {
    setupAllowedUserId?: string;
  };
  coinwatch?: {
    channelId?: string;
    symbol?: string;
  };
  purge?: {
    allowedRoleId?: string;
  };
  admin?: {
    port?: number;
    token?: string;
    /** バックグラウンドジョブを同時に走らせる本数 (既定 1。増やすと記憶の書き込みが競合しうる) */
    jobConcurrency?: number;
  };
}

const CONFIG_PATH = './data/config.json';

const readConfig = (): Config => {
  try {
    return parseJson(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
  } catch {
    return {};
  }
};

export const config: Config = readConfig();

let writes = Promise.resolve();
export const saveConfig = (): Promise<void> => {
  const body = JSON.stringify(config, null, 2);
  const write = writes.catch(() => {}).then(async () => {
    await ensureDataDirectory();
    await fs.promises.writeFile('./data/config.json.tmp', body);
    await fs.promises.rename('./data/config.json.tmp', './data/config.json');
  });
  writes = write;
  return write;
};

/** ネストしたキーを安全に取り出す。無ければ fallback */
export const get = <T = unknown>(obj: unknown, path: string, fallback?: T): T => {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return fallback as T;
    cur = (cur as Record<string, unknown>)[p];
  }
  return (cur === undefined ? fallback : cur) as T;
};
