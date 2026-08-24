// SPDX-License-Identifier: AGPL-3.0-or-later

/// The two bot clients (Discord / Fluxer) shared by every feature.

import { Client, GatewayIntentBits } from 'discord.js';

/** Bot user IDs, used for mention detection and the AI system prompt. */
export const DISCORD_USER_ID = '1379433738143924284';
export const FLUXER_USER_ID = '1493977173863738082';

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildExpressions,
  GatewayIntentBits.GuildMessageReactions,
];

/** Main bot on Discord. */
export const discord = new Client({ intents });

/** Bot on Fluxer (Discord-compatible API). */
export const fluxer = new Client({
  intents,
  rest: {
    // do not add / at the last
    api: 'https://api.fluxer.app',
    version: '1',
    cdn: 'https://fluxerusercontent.com',
  },
  ws: {
    version: 1,
  },
});
