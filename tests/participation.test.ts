// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from 'discord.js';
import { config } from '../src/config.ts';
import { finishParticipation, participationTarget } from '../src/ai/participation.ts';

test('自動参加は許可チャンネルだけで判定し、確率と返信先を検証する', async t => {
  const old = config.ai;
  try {
    config.ai = { participation: { endpoint: 'http://127.0.0.1:8010/v1/chat/completions', channels: ['1'], cooldownMs: 0 } };
    const m = { id: '10', channelId: '1', guild: {}, author: { id: 'user', bot: false, displayName: 'user' }, createdTimestamp: 10,
      content: 'これはどうする？', embeds: [], messageSnapshots: new Map<string, unknown>(), attachments: new Map<string, unknown>(),
      channel: { isTextBased: () => true, parentId: null, messages: { fetch: async () => new Map<string, unknown>() } },
    } as unknown as Message;
    let answer: unknown = { participate: true, confidence: 0.9, replyTo: '10' };
    const mock = t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { response_format: { schema: { properties: { replyTo: { enum: string[] } } } } };
      assert.deepEqual(body.response_format.schema.properties.replyTo.enum, ['', '10']);
      return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
    });
    assert.equal(await participationTarget(m), '10');
    finishParticipation(m.channelId);
    answer = { participate: true, confidence: 0.5, replyTo: '10' };
    assert.equal(await participationTarget(m), undefined);
    answer = { participate: true, confidence: 0.9, replyTo: '999' };
    assert.equal(await participationTarget(m), undefined);
    answer = { participate: true, confidence: 2, replyTo: '10' };
    assert.equal(await participationTarget(m), undefined);
    const before = mock.mock.callCount();
    assert.equal(await participationTarget({ ...m, channelId: '2' } as Message), undefined);
    assert.equal(mock.mock.callCount(), before);
  } finally { config.ai = old; }
});

test('失敗ならクールダウンを消費せず、返信成功後だけ次の参加を抑制する', async t => {
  const old = config.ai;
  config.ai = { participation: { endpoint: 'http://127.0.0.1:8010/v1/chat/completions', channels: ['cooldown'], cooldownMs: 60_000 } };
  const m = { id: '10', channelId: 'cooldown', guild: {}, author: { bot: false, displayName: 'u' }, content: 'hi', createdTimestamp: 1, embeds: [], attachments: new Map<string, unknown>(), channel: { isTextBased: () => true, messages: { fetch: async () => new Map<string, unknown>() } } } as unknown as Message;
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: JSON.stringify({ participate: true, confidence: 0.99, replyTo: '10' }) } }] }));
  try {
    assert.equal(await participationTarget(m), '10');
    assert.equal(await participationTarget(m), undefined);
    finishParticipation(m.channelId);
    assert.equal(await participationTarget(m), '10');
    finishParticipation(m.channelId, true);
    assert.equal(await participationTarget(m), undefined);
    assert.equal(mock.mock.callCount(), 2);
  } finally { finishParticipation(m.channelId); config.ai = old; }
});
