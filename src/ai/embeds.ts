// SPDX-License-Identifier: AGPL-3.0-or-later

/// Turns what a message carries outside its content (embeds, attachments, forwarded messages)
/// into text and image URLs the model can use.

import type { APIEmbed } from 'discord.js';

const MAX_EMBED_DESCRIPTION = 300;
const MAX_FIELD_VALUE = 100;
const MAX_EMBED_TEXT = 600;
/** Images taken from embeds per message, on top of the attachments. */
const MAX_EMBED_IMAGES = 4;

/** The parts of a message or forwarded message snapshot read here. */
export interface MessageParts {
  content: string | null,
  embeds: readonly { data: Readonly<APIEmbed> }[],
  attachments: { values(): Iterable<{ name: string }> },
}

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Image, GIF and video previews only have a thumbnail, which is the media itself. */
const isMedia = (e: Readonly<APIEmbed>): boolean => e.type === 'image' || e.type === 'gifv' || e.type === 'video';

/** One embed as a single line, or undefined when it has no text to show. */
export const describeEmbed = (e: Readonly<APIEmbed>): string | undefined => {
  const parts: string[] = [];
  if (e.provider?.name) parts.push(oneLine(e.provider.name, 50));
  if (e.author?.name) parts.push(oneLine(e.author.name, 100));
  if (e.title) parts.push(oneLine(e.title, 200));
  if (e.description) parts.push(oneLine(e.description, MAX_EMBED_DESCRIPTION));
  for (const f of e.fields ?? []) parts.push(`${oneLine(f.name, 50)}: ${oneLine(f.value, MAX_FIELD_VALUE)}`);
  if (e.footer?.text) parts.push(oneLine(e.footer.text, 100));
  if (e.image?.url || isMedia(e)) parts.push(e.type === 'video' || e.type === 'gifv' ? '(動画)' : '(画像)');
  if (parts.length === 0) return undefined;
  // A link preview's URL is already in the content; only a bot's embed brings a new one.
  const url = e.url && (e.type === undefined || e.type === 'rich') ? ` <${e.url}>` : '';
  return `[embed: ${oneLine(parts.join(' / '), MAX_EMBED_TEXT)}${url}]`;
};

/** Content, embeds and attachments of one message (or forwarded snapshot) as one line. */
const describeParts = (m: MessageParts): string =>
  [
    m.content ?? '',
    ...m.embeds.map(e => describeEmbed(e.data)),
    ...[...m.attachments.values()].map(a => `[添付: ${a.name}]`),
  ].filter(s => s).join(' ');

/** The text of a message as the model sees it, including forwarded messages. */
export const describeMessage = (m: MessageParts & { messageSnapshots?: { values(): Iterable<MessageParts> } | null }): string =>
  [
    describeParts(m),
    ...[...m.messageSnapshots?.values() ?? []].map(s => `(forwarded) ${describeParts(s)}`),
  ].filter(s => s).join(' ');

/** URLs of the images shown in embeds, preferring Discord's proxy, which serves them reliably. */
export const embedImageUrls = (embeds: readonly { data: Readonly<APIEmbed> }[]): string[] => {
  const urls = embeds.flatMap(({ data: e }) => {
    const image = e.image ?? (isMedia(e) ? e.thumbnail : undefined);
    const url = image?.proxy_url ?? image?.url;
    return url ? [url] : [];
  });
  return [...new Set(urls)].slice(0, MAX_EMBED_IMAGES);
};
