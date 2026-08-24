// SPDX-License-Identifier: AGPL-3.0-or-later

/// Persisted webhook pairs for the Discord <-> Fluxer bridge.

import fs from 'node:fs/promises';

export interface WebhookLink {
  whID: string,
  whToken: string,
  targetClannelID: string, // relation ※歴史的経緯によりタイポのまま。保存JSONのキーなので変更しない
}

export const whMapFluxer = JSON.parse((await fs.readFile('./data/fluxersync_fluxer.json')).toString()) as Record<string, WebhookLink>;
export const whMapDiscord = JSON.parse((await fs.readFile('./data/fluxersync_discord.json')).toString()) as Record<string, WebhookLink>;

export const saveWhMap = async (): Promise<void> => {
  await fs.writeFile('./data/fluxersync_fluxer.json', JSON.stringify(whMapFluxer));
  await fs.writeFile('./data/fluxersync_discord.json', JSON.stringify(whMapDiscord));
};
