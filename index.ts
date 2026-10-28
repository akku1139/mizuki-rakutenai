// SPDX-License-Identifier: AGPL-3.0-or-later
import { log, info, warn, error } from './src/log.ts';

/// Entry point: wires up every feature and logs in to Discord + Fluxer.

import process from 'node:process';
import { discord, fluxer } from './src/clients.ts';
import { config, get } from './src/config.ts';
import { setupAI } from './src/ai/mod.ts';
import { setupAnka } from './src/anka.ts';
import { setupCoinWatch } from './src/coinwatch.ts';
import { setupFluxSync } from './src/fluxsync/mod.ts';
import { setupAllLogging } from './src/logging/mod.ts';
import { setupAdmin } from './src/admin/mod.ts';
import './src/miq.ts';

process.on('unhandledRejection', (reason, promise) => {
  error('unhandledRejection', reason, promise);
});

discord.on('error', async err => {
  error(err.stack ?? err.name + '\n' + err.message);
});

discord.on('clientReady', readyClient => {
  info(`Logged in as ${readyClient.user.tag}!`);
});

fluxer.on('clientReady', readyClient => {
  info(`Logged in to fluxer as ${readyClient.user.tag}!`);
});

setupAI();
setupFluxSync();
setupAllLogging();
setupCoinWatch();
setupAnka();
setupAdmin();

discord.login(get(config, 'discord.token', process.env['DISCORD_TOKEN']));
fluxer.login(get(config, 'fluxer.token', process.env['FLUXER_TOKEN']));
