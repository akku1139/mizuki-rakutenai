// SPDX-License-Identifier: AGPL-3.0-or-later

import { fluxer } from './clients.ts';
import process from 'node:process';
import { OpenMiQ } from '@makeitaquote/openmiq';

fluxer.on('messageCreate', async m => {
  if (m.author.bot) return;
  if (!(m.content === 'めいく' || m.content === 'make')) return;
  if (!m.reference?.messageId) return;
  try {
    m.channel.sendTyping().catch(() => {});
    const replied = await m.channel.messages.fetch(m.reference.messageId);
    const miq = new OpenMiQ({
      apiKey: process.env['OPENMIQ_TOKEN']!,
      baseUrl: 'https://miq.otnc.dev',
    }).setFromMessage(replied).setColor(true);
    const response = await miq.toURL();
    await m.reply(response);
  } catch (e) {
    console.error(m.id, ': miq failed\n', e);
    await m.reply(`ERROR:\n\`\`\`\n${e}\n\`\`\``).catch(() => {});
  }
});
