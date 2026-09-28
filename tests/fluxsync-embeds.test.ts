import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIEmbed } from 'discord.js';
import { toSendableEmbed, toSendableEmbeds } from '../src/fluxsync/embeds.ts';

/** Drops undefined keys, as they are when sent as JSON. */
const sent = (e: unknown) => JSON.parse(JSON.stringify(e));

test('an article preview keeps its visible fields and drops preview-only ones', () => {
  const preview = {
    type: 'article',
    url: 'https://example.com/post',
    title: 'Post',
    description: 'Summary',
    color: 0x123456,
    provider: { name: 'Example' },
    thumbnail: { url: 'https://example.com/og.png', proxy_url: 'https://images-ext-1.discordapp.net/og.png', width: 1200, height: 630 },
  } as APIEmbed;
  assert.deepEqual(sent(toSendableEmbed(preview)), {
    url: 'https://example.com/post',
    title: 'Post',
    description: 'Summary',
    color: 0x123456,
    thumbnail: { url: 'https://example.com/og.png' },
  });
});

test('image and video previews show their thumbnail as a full image', () => {
  for (const type of ['image', 'gifv', 'video'] as const) {
    const preview = {
      type,
      url: 'https://example.com/a',
      thumbnail: { url: 'https://example.com/a.png', proxy_url: 'https://proxy.invalid/a.png' },
      video: { url: 'https://example.com/a.mp4' },
    } as APIEmbed;
    assert.deepEqual(sent(toSendableEmbed(preview)), { url: 'https://example.com/a', image: { url: 'https://example.com/a.png' } }, type);
  }
});

test('an embed with nothing to show is dropped', () => {
  assert.equal(toSendableEmbed({ type: 'link', url: 'https://example.com', color: 1 } as APIEmbed), undefined);
});

test('previews are dropped for Discord, rich embeds are kept, and at most 10 are sent', () => {
  const rich = { data: { type: 'rich', description: 'rich' } as APIEmbed };
  const preview = { data: { type: 'article', title: 'preview' } as APIEmbed };
  assert.deepEqual(sent(toSendableEmbeds([rich, preview], { dropPreviews: true })), [{ description: 'rich' }]);
  assert.equal(toSendableEmbeds([rich, preview]).length, 2);
  assert.equal(toSendableEmbeds(Array(12).fill(rich)).length, 10);
});
