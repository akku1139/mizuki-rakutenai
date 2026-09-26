import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIEmbed, Message, OmitPartialGroupDMChannel } from 'discord.js';
import { buildContextBlock } from '../src/ai/context.ts';
import { describeEmbed, describeMessage, embedImageUrls } from '../src/ai/embeds.ts';

const msg = (content: string, embeds: object[] = [], names: string[] = []) => ({
  content,
  embeds: embeds.map(data => ({ data: data as APIEmbed })),
  attachments: new Map(names.map(name => [name, { name }])),
});

test('a link preview is described by its visible text, without repeating the URL', () => {
  const preview = {
    type: 'article',
    url: 'https://example.com/post',
    provider: { name: 'Example' },
    title: 'Post',
    description: 'First line\nsecond line',
    image: { url: 'https://example.com/og.png' },
  } as APIEmbed;
  assert.equal(describeEmbed(preview), '[embed: Example / Post / First line second line / (画像)]');
});

test('a bot embed keeps its fields, footer and URL, and long text is cut', () => {
  const rich = {
    type: 'rich',
    url: 'https://example.com/r',
    title: 'Result',
    description: 'x'.repeat(500),
    fields: [{ name: 'Price', value: '100' }],
    footer: { text: 'footer' },
  } as APIEmbed;
  assert.equal(describeEmbed(rich), `[embed: Result / ${'x'.repeat(300)}… / Price: 100 / footer <https://example.com/r>]`);
});

test('an embed with nothing to read is left out', () => {
  assert.equal(describeEmbed({ type: 'link', url: 'https://example.com' } as APIEmbed), undefined);
});

test('a message includes its embeds, attachments and forwarded messages', () => {
  const m = {
    ...msg('look', [{ type: 'rich', title: 'T' }], ['a.png']),
    messageSnapshots: new Map([['1', msg('', [{ type: 'rich', description: 'inner' }], ['b.txt'])]]),
  };
  assert.equal(describeMessage(m), 'look [embed: T] [添付: a.png] (forwarded) [embed: inner] [添付: b.txt]');
  assert.equal(describeMessage(msg('', [{ type: 'rich', title: 'only embed' }])), '[embed: only embed]');
});

test('embed images use the proxy URL, take media thumbnails, skip article thumbnails, and are capped', () => {
  const embeds = [
    { type: 'image', url: 'u', thumbnail: { url: 'https://a/1.png', proxy_url: 'https://proxy/1.png' } },
    { type: 'article', thumbnail: { url: 'https://a/small.png' } },
    { type: 'rich', image: { url: 'https://a/2.png' } },
    { type: 'rich', image: { url: 'https://a/2.png' } },
    ...[3, 4, 5].map(i => ({ type: 'rich', image: { url: `https://a/${i}.png` } })),
  ] as APIEmbed[];
  assert.deepEqual(embedImageUrls(embeds.map(data => ({ data }))), [
    'https://proxy/1.png', 'https://a/2.png', 'https://a/3.png', 'https://a/4.png',
  ]);
});

const fakeMessage = (id: string, authorId: string, content: string, embeds: object[] = []) => ({
  id,
  content,
  createdAt: new Date(0),
  reference: null,
  messageSnapshots: new Map(),
  embeds: embeds.map(data => ({ data })),
  attachments: new Map(),
  member: null,
  author: { id: authorId, bot: false, displayName: authorId, username: authorId },
}) as unknown as Message;

test('replied-to messages come first with their embeds, even when older than the recent history', () => {
  const replied = fakeMessage('1', 'alice', 'see this', [{ type: 'article', title: 'News', image: { url: 'https://a/og.png' } }]);
  const recent = fakeMessage('5', 'bob', 'hi');
  const trigger = fakeMessage('9', 'carol', 'what is it?') as OmitPartialGroupDMChannel<Message>;
  const lines = buildContextBlock(trigger, [recent], [], 0, [replied, recent]).trimEnd().split('\n');
  assert.deepEqual(lines.map(l => l.replace(/\d\d:\d\d:\d\d/, 'T')), [
    '[System] 返信先のメッセージ:',
    '[1] T | alice (alice, alice): see this [embed: News / (画像)]',
    '[System] ここから直近のメッセージ:',
    '[5] T | bob (bob, bob): hi',
    '[9] T | carol (carol, carol): what is it?',
  ]);
});
