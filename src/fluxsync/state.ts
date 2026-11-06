// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseJson, ensureDataDirectory } from '../utils.ts';
import { log, info, warn, error } from '../log.ts';

/// Persisted webhook pairs for the Discord <-> Fluxer bridge.

import fs from 'node:fs/promises';

export interface WebhookLink {
  whID: string,
  whToken: string,
  targetChannelID: string,
}

const readWhMap = async (path: string): Promise<Record<string, WebhookLink>> => {
  try {
    return parseJson((await fs.readFile(path)).toString()) as Record<string, WebhookLink>;
  } catch {
    // 初回起動時などファイルが無い場合は空のマップから始める
    return {};
  }
};

export const whMapFluxer = await readWhMap('./data/fluxersync_fluxer.json');
export const whMapDiscord = await readWhMap('./data/fluxersync_discord.json');

export const saveWhMap = async (): Promise<void> => {
  await ensureDataDirectory();
  await fs.writeFile('./data/fluxersync_fluxer.json', JSON.stringify(whMapFluxer));
  await fs.writeFile('./data/fluxersync_discord.json', JSON.stringify(whMapDiscord));
};
