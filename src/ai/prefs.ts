// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseJson, ensureDataDirectory } from '../utils.ts';
import { log, info, warn, error } from '../log.ts';

/// ユーザーごとのAIプロバイダ設定の永続化 (data/ai_prefs.json)。

import fs from 'node:fs/promises';
import { isProviderName, type ProviderName } from './types.ts';

const PREFS_FILE = './data/ai_prefs.json';

const prefs = new Map<string, ProviderName>();
const models = new Map<string, string>();
let writes = Promise.resolve();

export const loadPrefs = async (): Promise<void> => {
  try {
    const raw = parseJson((await fs.readFile(PREFS_FILE)).toString()) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && isProviderName(v)) prefs.set(k, v);
      else if (v && typeof v === 'object') {
        const p = v as { provider?: unknown, model?: unknown };
        if (typeof p.provider === 'string' && isProviderName(p.provider)) {
          prefs.set(k, p.provider);
          if (typeof p.model === 'string') models.set(k, p.model);
        }
      }
    }
  } catch {
    // ファイルが無い/壊れていても既定値で開始する
  }
};

export const getUserProvider = (userId: string): ProviderName | undefined => prefs.get(userId);
export const getUserModel = (userId: string): string | undefined => models.get(userId);
export const getAllPrefs = (): Record<string, ProviderName> => Object.fromEntries(prefs);

export const setUserProvider = (userId: string, provider: ProviderName, model?: string): Promise<void> => {
  const write = writes.catch(() => {}).then(async () => {
    await ensureDataDirectory();
    const entries = [...prefs].filter(([id]) => id !== userId);
    entries.push([userId, provider]);
    await fs.writeFile(`${PREFS_FILE}.tmp`, JSON.stringify(Object.fromEntries(entries.map(([id, p]) => {
      const selectedModel = id === userId ? model : models.get(id);
      return [id, selectedModel ? { provider: p, model: selectedModel } : p];
    }))));
    await fs.rename(`${PREFS_FILE}.tmp`, PREFS_FILE);
    prefs.set(userId, provider);
    if (model) models.set(userId, model);
    else models.delete(userId);
  });
  writes = write;
  return write;
};
