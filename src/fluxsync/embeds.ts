// SPDX-License-Identifier: AGPL-3.0-or-later

/// Turns received embeds into ones a webhook can send.

import type { APIEmbed } from 'discord.js';

/** Webhooks accept at most 10 embeds per message. */
const MAX_EMBEDS = 10;

const isRich = (e: APIEmbed): boolean => e.type === undefined || e.type === 'rich';

/**
 * Link previews (article, image, video, ...) carry fields a webhook cannot send,
 * such as type, video, provider and proxy_url, so only the rich embed fields are kept.
 * Returns undefined when nothing would be left to show.
 */
export const toSendableEmbed = (e: APIEmbed): APIEmbed | undefined => {
  // Image, GIF and video previews only have a thumbnail, which a rich embed shows small.
  const media = e.type === 'image' || e.type === 'gifv' || e.type === 'video';
  const image = e.image?.url ?? (media ? e.thumbnail?.url : undefined);
  const thumbnail = media ? undefined : e.thumbnail?.url;
  const out: APIEmbed = {};
  if (e.title) out.title = e.title;
  if (e.description) out.description = e.description;
  if (e.url) out.url = e.url;
  if (e.timestamp) out.timestamp = e.timestamp;
  if (e.color !== undefined) out.color = e.color;
  if (e.author?.name) out.author = { name: e.author.name, url: e.author.url, icon_url: e.author.icon_url };
  if (e.footer?.text) out.footer = { text: e.footer.text, icon_url: e.footer.icon_url };
  if (image) out.image = { url: image };
  if (thumbnail) out.thumbnail = { url: thumbnail };
  if (e.fields?.length) out.fields = e.fields.map(f => ({ name: f.name, value: f.value, inline: f.inline }));
  // A URL or color alone renders nothing.
  const { url: _url, color: _color, ...visible } = out;
  return Object.keys(visible).length === 0 ? undefined : out;
};

/**
 * `dropPreviews` is for sending to Discord, which unfurls the links in the content by itself.
 */
export const toSendableEmbeds = (embeds: readonly { data: APIEmbed }[], { dropPreviews = false } = {}): APIEmbed[] =>
  embeds
    .filter(e => !dropPreviews || isRich(e.data))
    .map(e => toSendableEmbed(e.data))
    .filter(e => e !== undefined)
    .slice(0, MAX_EMBEDS);
