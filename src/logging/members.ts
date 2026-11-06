// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GuildMember, PartialGuildMember } from 'discord.js';
import { discord } from '../clients.ts';
import { config } from '../config.ts';

/** 参加から5分以内の退出を即抜けとして記録する。 */
export const quickLeaveNote = (joinedAt: number | null, now = Date.now()): string => {
  if (joinedAt === null || now < joinedAt || now - joinedAt > 5 * 60_000) return '';
  return ` (即抜け: 参加から${Math.floor((now - joinedAt) / 1000)}秒)`;
};

export const sendQuickLeaveNotice = async (member: GuildMember | PartialGuildMember, note: string): Promise<void> => {
  const channelId = (member.client === discord ? config.discord : config.fluxer)?.quickLeaveChannelId;
  if (!channelId || !note) return;
  const channel = await member.client.channels.fetch(channelId);
  if (!channel?.isSendable() || !('guildId' in channel) || channel.guildId !== member.guild.id) throw new Error('即抜け通知先は同じサーバーの送信可能なチャンネルを指定してください');
  await channel.send({ content: `<@${member.id}> が即抜けしました${note}`, allowedMentions: { parse: [], repliedUser: false } });
};
