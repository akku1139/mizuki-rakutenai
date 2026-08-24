// SPDX-License-Identifier: AGPL-3.0-or-later

/// Entry point: wires up every feature and logs in to Discord + Fluxer.

import process from 'node:process';
import { discord, fluxer } from './src/clients.ts';
import { setupAI } from './src/ai/mod.ts';
import { setupAnka } from './src/anka.ts';
import { setupCoinWatch } from './src/coinwatch.ts';
import { setupFluxSync } from './src/fluxsync/mod.ts';
import { setupAllLogging } from './src/logging/mod.ts';
import './src/miq.ts';

process.on('unhandledRejection', (reason, promise) => {
  console.error('unhandledRejection', reason, promise);
});

discord.on('error', async err => {
  console.error(err.stack ?? err.name + '\n' + err.message);
});

discord.on('clientReady', readyClient => {
  console.info(`Logged in as ${readyClient.user.tag}!`);
});

fluxer.on('clientReady', readyClient => {
  console.info(`Logged in to fluxer as ${readyClient.user.tag}!`);
});

setupAI();
setupFluxSync();
setupAllLogging();
setupCoinWatch();
setupAnka();

discord.login(process.env['DISCORD_TOKEN']);
fluxer.login(process.env['FLUXER_TOKEN']);
