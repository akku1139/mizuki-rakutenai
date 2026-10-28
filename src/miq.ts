// SPDX-License-Identifier: AGPL-3.0-or-later
import { log, info, warn, error } from './log.ts';

import { fluxer } from './clients.ts';
import { config, get } from './config.ts';
import { OpenMiQ } from '@makeitaquote/openmiq';

fluxer.on('messageCreate', async m => {
  if (m.author.bot) return;
  if (!(m.content === 'めいく' || m.content === 'make')) return;
  if (!m.reference?.messageId) return;
  try {
    m.channel.sendTyping().catch(() => {});
    const replied = await m.channel.messages.fetch(m.reference.messageId);
    const miq = new OpenMiQ({
      apiKey: get(config, 'miq.token', process.env['OPENMIQ_TOKEN'])!,
      baseUrl: get(config, 'miq.baseUrl', 'https://miq.otnc.dev'),
    }).setFromMessage(replied).setColor(true);
    const response = await miq.toURL();
    await m.reply(response);
  } catch (e) {
    error(m.id, ': miq failed\n', e);
    await m.reply(`ERROR:\n\`\`\`\n${e}\n\`\`\``).catch(() => {});
  }
});
