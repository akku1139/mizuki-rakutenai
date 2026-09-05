// SPDX-License-Identifier: AGPL-3.0-or-later

/// めいくざquote ("めいく"/"make" reply) feature.

import { fluxer } from './clients.ts';
import { MiQ } from '../miq.ts';

fluxer.on('messageCreate', async m => {
  if (!m.author.bot) return;
  if (!(m.content === 'めいく' || m.content === 'make')) return;
  if (!m.reference?.messageId) return;
  m.channel.sendTyping();
  const replied = await m.channel.messages.fetch(m.reference.messageId);
  const miq = (await new MiQ().setFromMessage(replied)).setColor(true);
  const response = await miq.generate();
  await m.reply(response);
});
