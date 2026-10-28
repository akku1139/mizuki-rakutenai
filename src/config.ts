// SPDX-License-Identifier: AGPL-3.0-or-later

/// 固定パスの data/config.json を読み込む。無ければ空オブジェクト (env にフォールバック)。

import fs from 'node:fs';

export interface OpenAIProfile {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
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
  discord?: {
    token?: string;
    logWebhookUrl?: string;
    botUserId?: string;
    guildId?: string;
  };
  fluxer?: {
    token?: string;
    logWebhookId?: string;
    logWebhookToken?: string;
    botUserId?: string;
    guildId?: string;
    apiBase?: string;
    cdnBase?: string;
  };
  ai?: {
    defaultProvider?: string;
    openaiProfiles?: Record<string, OpenAIProfile>;
    activeOpenaiProfile?: string | null;
    readabilityEndpoint?: string | null;
    searchEndpoint?: string | null;
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
  };
}

const CONFIG_PATH = './data/config.json';

const readConfig = (): Config => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
  } catch {
    return {};
  }
};

export const config: Config = readConfig();

export const saveConfig = (): void => {
  fs.writeFileSync('./data/config.json', JSON.stringify(config, null, 2));
};

/** ネストしたキーを安全に取り出す。無ければ fallback */
export const get = (obj: Config, path: string, fallback?: any): any => {
  const parts = path.split('.');
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
};