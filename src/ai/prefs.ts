// SPDX-License-Identifier: AGPL-3.0-or-later

/// ユーザーごとのAIプロバイダ設定の永続化 (data/ai_prefs.json)。

import fs from 'node:fs/promises';
import { isProviderName, type ProviderName } from './types.ts';

const PREFS_FILE = './data/ai_prefs.json';

const prefs = new Map<string, ProviderName>();

export const loadPrefs = async (): Promise<void> => {
  try {
    const raw = JSON.parse((await fs.readFile(PREFS_FILE)).toString()) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && isProviderName(v)) prefs.set(k, v);
    }
  } catch {
    // ファイルが無い/壊れていても既定値で開始する
  }
};

export const getUserProvider = (userId: string): ProviderName | undefined => prefs.get(userId);

export const setUserProvider = async (userId: string, provider: ProviderName): Promise<void> => {
  prefs.set(userId, provider);
  await fs.mkdir('./data', { recursive: true });
  await fs.writeFile(PREFS_FILE, JSON.stringify(Object.fromEntries(prefs)));
};
