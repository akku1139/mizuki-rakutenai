// SPDX-License-Identifier: AGPL-3.0-or-later

/// 固定パスの data/config.json を読み込む。無ければ空オブジェクト (env にフォールバック)。

import fs from 'node:fs';

const CONFIG_PATH = './data/config.json';

const readConfig = (): Record<string, any> => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, any>;
  } catch {
    return {};
  }
};

export const config = readConfig();

/** ネストしたキーを安全に取り出す。無ければ fallback */
export const get = (obj: any, path: string, fallback?: any): any => {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
};
