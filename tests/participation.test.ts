// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from 'discord.js';
import { config } from '../src/config.ts';
import { participationTarget } from '../src/ai/participation.ts';

test('自動参加は許可チャンネルだけで判定し、確率と返信先を検証する', async t => {
  const old = config.ai;
  try {
    config.ai = { participation: { endpoint: 'http://127.0.0.1:8009/v1/systemone', channels: ['1'], cooldownMs: 0 } };
    const m = { id: '10', channelId: '1', guild: {}, author: { id: 'user', bot: false, displayName: 'user' }, createdTimestamp: 10,
      content: 'これはどうする？', embeds: [], messageSnapshots: new Map(), attachments: new Map(),
      channel: { isTextBased: () => true, parentId: null, messages: { fetch: async () => new Map() } },
    } as unknown as Message;
    let answer: unknown = { participate: { noul: 0.9 }, reply: { choice: '10' } };
    const mock = t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      assert.equal(JSON.parse(String(init.body)).questions.participate.type, 'noul');
      return Response.json({ answers: answer });
    });
    assert.equal(await participationTarget(m), '10');
    answer = { participate: { noul: 0.5 }, reply: { choice: '10' } };
    assert.equal(await participationTarget(m), undefined);
    answer = { participate: { noul: 0.9 }, reply: { choice: '999' } };
    assert.equal(await participationTarget(m), undefined);
    answer = { participate: { noul: 2 }, reply: { choice: '10' } };
    assert.equal(await participationTarget(m), undefined);
    const before = mock.mock.callCount();
    assert.equal(await participationTarget({ ...m, channelId: '2' } as Message), undefined);
    assert.equal(mock.mock.callCount(), before);
  } finally { config.ai = old; }
});
