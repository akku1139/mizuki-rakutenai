// SPDX-License-Identifier: AGPL-3.0-or-later

/// Bridges channels between Discord and Fluxer via webhooks.

import {
  WebhookClient,
  type Client,
  type Guild,
  type Message,
  type MessageReaction,
  type OmitPartialGroupDMChannel,
  type PartialMessageReaction,
  type PartialUser,
  type Snowflake,
  type TextChannel,
  type User as DiscordUser,
} from 'discord.js';
import { discord, fluxer } from '../clients.ts';
import { saveWhMap, whMapDiscord, whMapFluxer, type WebhookLink } from './state.ts';

// TODO:
// m.type === MessageType.UserJoin

/** Lost on restart, and reactions only fire while discord.js still caches the message. */
const dToF = new Map<Snowflake, Snowflake>();
const fToD = new Map<Snowflake, Snowflake>();

const linkMessages = (discordId: Snowflake, fluxerId: Snowflake) => {
  dToF.set(discordId, fluxerId);
  fToD.set(fluxerId, discordId);
  for (const m of [dToF, fToD]) {
    if (m.size <= 5000) continue;
    const oldest = m.keys().next();
    if (!oldest.done) m.delete(oldest.value);
  }
};

/** Each WebhookClient owns its own REST rate limit buckets. */
const discordWHs = new Map<Snowflake, WebhookClient>();

const getDiscordWH = (info: WebhookLink): WebhookClient => {
  let wh = discordWHs.get(info.whID);
  if (wh === undefined) {
    wh = new WebhookClient({ id: info.whID, token: info.whToken });
    discordWHs.set(info.whID, wh);
  }
  return wh;
};

const guildOfChannel = (c: Client, channelId: Snowflake): Guild | undefined => {
  const ch = c.channels.cache.get(channelId);
  return ch !== undefined && 'guild' in ch ? ch.guild : undefined;
};

const convertEmojis = (content: string, target: Guild | undefined): string =>
  target === undefined ? content : content.replace(/<a?:([^:\s]+):\d+>/g, (_full, name: string) =>
    target.emojis.cache.find(e => e.name === name)?.toString() ?? `:${name}:`);

/** Sticker IDs are server local, and Discord webhooks cannot send stickers at all. */
const stickerLinks = (stickers: Message['stickers']): string =>
  [...stickers.values()].map(s => `\n${s.url}`).join('');

const onDiscordMessage = async (m: OmitPartialGroupDMChannel<Message>): Promise<void> => {
  const whInfo = whMapDiscord[m.channelId];
  if (!whInfo || m.author.id === whInfo.whID) return;
  console.log('sending a message to fluxer:', m.id);
  const targetInfo = whMapFluxer[whInfo.targetChannelID];
  const repliedId = dToF.get(m.reference?.messageId ?? '');

  const formData = new FormData();
  formData.append('payload_json', JSON.stringify({
    allowed_mentions: {
      parse: [], // とりあえずメンション無し
    },
    message_reference: repliedId === undefined ? undefined : { message_id: repliedId },
    username: `${m.member?.nickname ?? m.author.displayName}#Discord`,
    avatar_url: m.member?.avatarURL() ?? m.author.avatarURL() ?? void 0,
    content: convertEmojis(m.content, guildOfChannel(fluxer, whInfo.targetChannelID)) + stickerLinks(m.stickers),
    embeds: m.embeds,
    attachments: Array.from(m.attachments.values()).map((a, i) => ({
      id: i,
      filename: a.name,
      content_type: a.contentType,
      description: a.description ?? undefined,
      /** MessageAttachmentFlags: IS_SPOILER (8), CONTAINS_EXPLICIT_MEDIA (16), IS_ANIMATED (32) */
      flags: 8 * Number(a.spoiler),
      // duration:
      // waveform:
    })),
    // https://github.com/fluxerjs/core/blob/cca2f8ff28f82e8a4d43c834ed38f08d484a8bd6/packages/fluxer-core/src/structures/Webhook.ts#L28-L35
    // https://github.com/KartoffelChipss/bifrost/blob/923a2161ffe0795f90e78e66e6daedc8c6992046/src/services/WebhookService.ts#L240-L246
    // https://github.com/fluxerapp/fluxer/blob/29f0f34c76414adb40fcd8dfd040f6b7f4da2b41/fluxer_api/src/api/webhook/tests/WebhookMultipartAttachmentUploads.test.ts
    // https://deepwiki.com/search/webhook_0ce957d0-db57-4f93-8e53-4b8471941adf?mode=deep
    tts: m.tts,
    withComponents: false,
  }));

  (await Promise.all(m.attachments.map<Promise<[string, Blob]>>(async a => [a.name, await (await fetch(a.proxyURL)).blob()])))
    .forEach((f, i) => formData.append(`files[${i}]`, f[1], f[0]));

  const res = await fetch(`https://api.fluxer.app/webhooks/${targetInfo.whID}/${targetInfo.whToken}?wait=true`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    // Error bodies are not always JSON, e.g. a proxy 502.
    console.error('fluxer webhook error:', res.status, await res.text());
    return;
  }
  linkMessages(m.id, (await res.json() as { id: Snowflake }).id);
};

const onFluxerMessage = async (m: OmitPartialGroupDMChannel<Message>): Promise<void> => {
  const whInfo = whMapFluxer[m.channelId];
  if (!whInfo || m.author.id === whInfo.whID) {
    if (m.author.id === '1493964990916384451' && m.content.startsWith('=syncsetup ')) {
      const whSrc = await (m.channel as TextChannel).createWebhook({ name: 'Fluxer Sync' });
      const distCh = m.content.split(' ')[1];
      const whDist = await ((await discord.channels.fetch(distCh))! as TextChannel).createWebhook({ name: 'Fluxer Sync' });
      whMapFluxer[m.channelId] = { whID: whSrc.id, whToken: whSrc.token, targetChannelID: distCh };
      whMapDiscord[distCh] = { whID: whDist.id, whToken: whDist.token, targetChannelID: m.channelId };
      await saveWhMap();
      await m.reply(`link channel between https://discord.com/channels/1255359848644608035/${distCh} and https://fluxer.app/channels/1493971310876907609/${m.channelId}`);
    }
    return;
  }
  console.log('sending a message to discord:', m.id);
  const targetInfo = whMapDiscord[whInfo.targetChannelID];
  const targetGuild = guildOfChannel(discord, whInfo.targetChannelID);
  const repliedId = fToD.get(m.reference?.messageId ?? '');
  // Discord webhooks cannot reply.
  const replyLine = repliedId === undefined || targetGuild === undefined ? ''
    : `-# ↩ https://discord.com/channels/${targetGuild.id}/${whInfo.targetChannelID}/${repliedId}\n`;
  const sent = await getDiscordWH(targetInfo).send({
    allowedMentions: {
      parse: [], // とりあえずメンション無し
    },
    username: `${m.member?.nickname ?? m.author.displayName}#Fluxer`,
    avatarURL: m.member?.avatarURL() ?? m.author.avatarURL() ?? void 0,
    content: (replyLine + convertEmojis(m.content, targetGuild) + stickerLinks(m.stickers)).slice(0, 2000),
    embeds: m.embeds,
    files: [...m.attachments.values()],
    tts: m.tts,
    withComponents: false,
  });
  linkMessages(sent.id, m.id);
};

const bridgeReactions = (from: Client, to: Client, idMap: Map<Snowflake, Snowflake>, whMap: Record<string, WebhookLink>): void => {
  const handle = async (r: MessageReaction | PartialMessageReaction, u: DiscordUser | PartialUser, remove: boolean) => {
    // Our own mirrored reaction is in the count too.
    if (u.bot || (remove && (r.count ?? 0) - (r.me ? 1 : 0) > 0)) return;
    const targetId = idMap.get(r.message.id);
    const wh = whMap[r.message.channelId];
    if (targetId === undefined || !wh) return;
    const ch = await to.channels.fetch(wh.targetChannelID);
    if (!ch?.isTextBased()) return;
    const msg = await ch.messages.fetch(targetId);
    const emoji = r.emoji.id === null ? r.emoji.name : msg.guild?.emojis.cache.find(e => e.name === r.emoji.name);
    if (!emoji) return;
    if (remove) await msg.reactions.cache.get(typeof emoji === 'string' ? emoji : emoji.id)?.users.remove();
    else await msg.react(emoji);
  };
  from.on('messageReactionAdd', (r, u) => void handle(r, u, false));
  from.on('messageReactionRemove', (r, u) => void handle(r, u, true));
};

export const setupFluxSync = (): void => {
  discord.on('messageCreate', onDiscordMessage);
  fluxer.on('messageCreate', onFluxerMessage);
  bridgeReactions(discord, fluxer, dToF, whMapDiscord);
  bridgeReactions(fluxer, discord, fToD, whMapFluxer);
};
