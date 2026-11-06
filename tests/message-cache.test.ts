// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheMessage, MESSAGE_CACHE_LIMIT } from '../src/fluxsync/cache.ts';

test('同期と返信の共用キャッシュは5000件を超えたら古い対応から捨てる', () => {
  const cache = new Map<string, string[]>();
  for (let i = 0; i <= MESSAGE_CACHE_LIMIT; i++) cacheMessage(cache, String(i), [String(i)]);
  assert.equal(cache.size, MESSAGE_CACHE_LIMIT);
  assert.equal(cache.has('0'), false);
  assert.deepEqual(cache.get(String(MESSAGE_CACHE_LIMIT)), [String(MESSAGE_CACHE_LIMIT)]);
});
