import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, OmitPartialGroupDMChannel } from 'discord.js';
import { buildContextBlock } from '../src/ai/context.ts';

interface FakeOptions {
  bot?: boolean,
  nickname?: string,
  replyTo?: string,
}

const fake = (id: string, authorId: string, content: string, { bot = false, nickname, replyTo }: FakeOptions = {}) => ({
  id,
  content,
  createdAt: new Date(0),
  reference: replyTo ? { messageId: replyTo } : null,
  messageSnapshots: new Map(),
  embeds: [],
  attachments: new Map(),
  member: nickname ? { displayName: nickname } : null,
  author: { id: authorId, bot, displayName: `${authorId}-display`, username: authorId },
}) as unknown as OmitPartialGroupDMChannel<Message>;

/** The block as lines, with the local time replaced so the test does not depend on the time zone. */
const lines = (block: string) => block.trimEnd().split('\n').map(l => l.replace(/\d\d:\d\d:\d\d/, 'T'));

test('the block ends with a newline and the triggering message is the last line', () => {
  const block = buildContextBlock(fake('9', 'carol', 'hello'), [], [], 0);
  assert.ok(block.endsWith('\n'));
  assert.deepEqual(lines(block), ['[9] T | carol-display (carol, carol): hello']);
});

test('the previous reply IDs come first as a system line', () => {
  const block = buildContextBlock(fake('9', 'carol', 'again'), [], ['3', '4'], 0);
  assert.equal(lines(block)[0], '[System] あなたの前回のメッセージID: 3, 4');
});

test('history lines show nicknames, bots and replies, and drop the author for consecutive posts', () => {
  const history = [
    fake('1', 'alice', 'one', { nickname: 'Alice' }),
    fake('2', 'alice', 'two', { replyTo: '1' }),
    fake('3', 'bot', 'beep', { bot: true }),
  ];
  const block = buildContextBlock(fake('9', 'bot', 'hey @bot'), history, [], 0);
  assert.deepEqual(lines(block), [
    '[1] T | Alice (alice, alice): one',
    '[2] (reply to 1) T two',
    '[3] T | [BOT] bot-display (bot, bot): beep',
    '[9] T hey @bot',
  ]);
});

test('the triggering message is not repeated when it is also in the history', () => {
  const trigger = fake('9', 'carol', 'hi');
  const block = buildContextBlock(trigger, [fake('1', 'alice', 'before'), trigger], [], 0);
  assert.deepEqual(lines(block), [
    '[1] T | alice-display (alice, alice): before',
    '[9] T | carol-display (carol, carol): hi',
  ]);
});

test('history stops at the length budget, which includes the prefix, but the trigger is always kept', () => {
  const history = Array.from({ length: 20 }, (_, i) => fake(String(i + 1), `u${i % 2}`, 'x'.repeat(500)));
  const trigger = fake('99', 'carol', 'question');

  const full = buildContextBlock(trigger, history, [], 0);
  const withPrefix = buildContextBlock(trigger, history, [], 3000);
  for (const block of [full, withPrefix]) {
    assert.ok(block.trimEnd().endsWith('question'));
  }
  // Everything but the trigger fits in 7000 characters, less the prefix
  const historyLength = (block: string) => block.slice(0, block.lastIndexOf('[99]')).length;
  assert.ok(historyLength(full) <= 7000);
  assert.ok(historyLength(withPrefix) <= 7000 - 3000);
  assert.ok(lines(withPrefix).length < lines(full).length);
  assert.ok(lines(full).length < history.length + 1);
});

test('replied-to messages already in the history are listed only once', () => {
  const replied = fake('1', 'alice', 'look');
  const block = buildContextBlock(fake('9', 'carol', 'what?', { replyTo: '1' }), [replied], [], 0, [replied]);
  assert.deepEqual(lines(block), [
    '[1] T | alice-display (alice, alice): look',
    '[9] (reply to 1) T | carol-display (carol, carol): what?',
  ]);
});
