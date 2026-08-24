// SPDX-License-Identifier: AGPL-3.0-or-later

/// Posts message/member events to log webhooks (Discord and Fluxer).

import { WebhookClient, type Client } from 'discord.js';
import process from 'node:process';
import { discord, fluxer } from '../clients.ts';

interface LogConfig {
  client: Client,
  guildId: string,
  webhook: WebhookClient,
  footerText: string,
}

const logwh = new WebhookClient({ url: process.env['DISCORD_LOG_WEBHOOK']! });
const evexID = '1255359848644608035';
const evexIDFluxer = '1493971310876907609';

const logwhFluxer = new WebhookClient({ id: process.env['FLUXER_LOG_WEBHOOK_ID']!, token: process.env['FLUXER_LOG_WEBHOOK_TOKEN']! }, {
  rest: {
     api: 'https://api.fluxer.app',
     version: '1',
     cdn: 'https://fluxerusercontent.com'
   },
});

/** Discord embed color numbers are shared with Fluxer as-is. */
const COLORS = {
  delete: 0xd0021a,
  edit: 0x7dd321,
  join: 0x21d3c2,
  leave: 0xd3c821,
} as const;

export const setupLogging = ({ client, guildId, webhook, footerText }: LogConfig): void => {
  const sendLog = async (embed: Record<string, unknown>): Promise<void> => {
    await webhook.send({ embeds: [embed] });
  };

  client.on('messageDelete', async m => {
    if (m.guildId !== guildId) return;
    await sendLog({
      description: `:wastebasket: **Message sent by <@${m.author?.id}> deleted in <#${m.channelId}>.**\n${m.content}`,
      footer: {
        text: footerText,
      },
      author: {
        name: `${m.author?.username}`,
        icon_url: m.member?.avatarURL() ?? m.author?.avatarURL() ?? undefined,
      },
      timestamp: new Date().toISOString(),
      color: COLORS.delete,
    });
  });

  client.on('messageUpdate', async (o, n) => {
    if (o.guildId !== guildId || o.author?.id === webhook.id || o.content === n.content) return;
    await sendLog({
      description: `:pencil2: **Message sent by <@${o.author?.id}> edited in <#${o.channelId}>.**  [Jump to Message](${o.url})`,
      footer: {
        text: footerText,
      },
      author: {
        name: `${o.author?.username}`,
        icon_url: o.member?.avatarURL() ?? o.author?.avatarURL() ?? undefined,
      },
      timestamp: new Date().toISOString(),
      color: COLORS.edit,
      fields: [
        {
          name: "**Old**",
          value: '```md\n'+o.content+'\n```',
          inline: false,
        },
        {
          name: "**New**",
          value: '```md\n'+n.content+'\n```',
          inline: false,
        }
      ],
    });
  });

  client.on('guildMemberAdd', async m => {
    if (m.guild.id !== guildId) return;
    await sendLog({
      description: `:airplane_arriving: <@${m.user.id}> joined ${footerText}`,
      footer: {
        text: footerText,
      },
      author: {
        name: `${m.user.displayName} (${m.user.username})`,
        icon_url: m.user.avatarURL() ?? undefined,
      },
      timestamp: new Date().toISOString(),
      color: COLORS.join,
    });
  });

  client.on('guildMemberRemove', async m => {
    if (m.guild.id !== guildId) return;
    await sendLog({
      description: `:airplane_departure: <@${m.user.id}> left ${footerText}`,
      footer: {
        text: footerText,
      },
      author: {
        name: `${m.user.displayName} (${m.user.username})`,
        icon_url: m.user.avatarURL() ?? undefined,
      },
      timestamp: new Date().toISOString(),
      color: COLORS.leave,
    });
  });
};

export const setupAllLogging = (): void => {
  setupLogging({ client: discord, guildId: evexID, webhook: logwh, footerText: 'Evex Developers' });
  setupLogging({ client: fluxer, guildId: evexIDFluxer, webhook: logwhFluxer, footerText: 'Evex Developers@Fluxer.app' });
};
