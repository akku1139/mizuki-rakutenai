// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quickLeaveNote, sendQuickLeaveNotice } from '../src/logging/members.ts';
import { discord } from '../src/clients.ts';
import { config } from '../src/config.ts';
import type { GuildMember } from 'discord.js';

test('5分以内の退出だけに即抜けの経過秒数を付ける', () => {
  assert.equal(quickLeaveNote(1000, 31000), ' (即抜け: 参加から30秒)');
  assert.equal(quickLeaveNote(1000, 301000), ' (即抜け: 参加から300秒)');
  assert.equal(quickLeaveNote(1000, 301001), '');
  assert.equal(quickLeaveNote(null), '');
  assert.equal(quickLeaveNote(2000, 1000), '');
});

test('即抜けだけを指定チャンネルに通知し、別サーバーの指定を拒否する', async t => {
  const old = config.discord;
  const sent: unknown[] = [];
  let guildId = '1';
  const fetch = t.mock.method(discord.channels, 'fetch', async () => ({ guildId, isSendable: () => true, send: async (value: unknown) => { sent.push(value); } }));
  const member = { id: '2', client: discord, guild: { id: '1' } } as GuildMember;
  config.discord = { quickLeaveChannelId: '3' };
  try {
    await sendQuickLeaveNotice(member, '');
    assert.equal(fetch.mock.callCount(), 0);
    await sendQuickLeaveNotice(member, quickLeaveNote(1000, 31000));
    assert.deepEqual((sent[0] as { allowedMentions: unknown }).allowedMentions, { parse: [], repliedUser: false });
    guildId = '999';
    await assert.rejects(sendQuickLeaveNotice(member, '即抜け'), /同じサーバー/);
    assert.equal(sent.length, 1);
  } finally { config.discord = old; }
});
