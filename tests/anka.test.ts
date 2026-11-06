// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupAnka } from '../src/anka.ts';
import { discord } from '../src/clients.ts';

test('通常のメンション抑止設定でも安価の通知先だけは明示して通知する', async () => {
  setupAnka();
  const handler = discord.listeners('messageCreate').at(-1)!;
  const replies: unknown[] = [];
  const message = (id: string, user: string, content: string) => ({ id, channelId: 'test-anka', content, url: `https://discord.com/channels/1/2/${id}`, author: { id: user, bot: false }, reply: async (value: unknown) => { replies.push(value); } });
  try {
    await handler(message('1', 'alice', '>>1') as never);
    await handler(message('2', 'bob', 'reached') as never);
    assert.deepEqual((replies[0] as { allowedMentions: unknown }).allowedMentions, { parse: [], users: ['alice'], repliedUser: true });
  } finally { discord.off('messageCreate', handler); }
});
