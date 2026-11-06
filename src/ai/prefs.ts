// SPDX-License-Identifier: AGPL-3.0-or-later
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
    const raw = JSON.parse((await fs.readFile(PREFS_FILE)).toString()) as Record<string, unknown>;
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
    const next = new Map(prefs);
    const nextModels = new Map(models);
    next.set(userId, provider);
    if (model) nextModels.set(userId, model);
    else nextModels.delete(userId);
    await fs.mkdir('./data', { recursive: true });
    await fs.writeFile(`${PREFS_FILE}.tmp`, JSON.stringify(Object.fromEntries([...next].map(([id, p]) =>
      [id, nextModels.has(id) ? { provider: p, model: nextModels.get(id) } : p]))));
    await fs.rename(`${PREFS_FILE}.tmp`, PREFS_FILE);
    prefs.set(userId, provider);
    if (model) models.set(userId, model);
    else models.delete(userId);
  });
  writes = write;
  return write;
};
