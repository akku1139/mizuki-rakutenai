// SPDX-License-Identifier: AGPL-3.0-or-later

import { fluxer } from './clients.ts';
import process from 'node:process';
import { OpenMiQ } from '@makeitaquote/openmiq';

fluxer.on('messageCreate', async m => {
  if (!m.author.bot) return;
  if (!(m.content === 'めいく' || m.content === 'make')) return;
  if (!m.reference?.messageId) return;
  m.channel.sendTyping();
  const replied = await m.channel.messages.fetch(m.reference.messageId);
  const miq = new OpenMiQ({
    apiKey: process.env['OPENMIQ_TOKEN']!,
    baseUrl: 'https://miq.otnc.dev',
  }).setFromMessage(replied).setColor(true);
  const response = await miq.toURL();
  await m.reply(response);
});
