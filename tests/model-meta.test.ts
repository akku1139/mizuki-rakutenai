// SPDX-License-Identifier: AGPL-3.0-or-later

// モデルカタログ (models.dev + プロバイダの /models) からコンテキストウィンドウを引く。
// teapot の model-meta.ts の移植なので、判定の順序 (ホスト → パス) もそのまま。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextLengthFor, fetchModelList, providerFor, resetModelMetaCache } from '../src/ai/model-meta.ts';

const DB = {
  openrouter: {
    id: 'openrouter',
    api: 'https://openrouter.ai/api/v1',
    models: { 'acme/long': { id: 'acme/long', name: 'Acme Long', limit: { context: 1_000_000 } } },
  },
  commandcode: {
    id: 'commandcode',
    api: 'https://api.commandcode.ai/provider/v1',
    models: { 'plain/model': { id: 'plain/model', limit: { context: 200_000 } } },
  },
  // 同じホストを 2 つのカタログに分けている例 (opencode / opencode-go)
  opencode: { id: 'opencode', api: 'https://opencode.ai/inference/openai/v1', models: { many: { id: 'many', limit: { context: 300_000 } } } },
  'opencode-go': { id: 'opencode-go', api: 'https://opencode.ai/inference/go/openai/v1', models: { few: { id: 'few', limit: { context: 100_000 } } } },
};

/** models.dev と、プロバイダの /models を返すモック */
const mockCatalog = (
  t: { mock: { method: Function } },
  upstream: (url: string) => Response | undefined,
) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    urls.push(String(url));
    const res = upstream(String(url));
    if (res !== undefined) return res;
    if (String(url) === 'https://models.dev/api.json') {
      return new Response(JSON.stringify(DB), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('nope', { status: 404 });
  });
  return urls;
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('ホストが同じカタログを選び、パスの食い違いはモデル数で決める', () => {
  const providers = new Map(Object.entries(DB));
  assert.equal(providerFor(providers, 'https://openrouter.ai/api/v1')?.id, 'openrouter');
  // パスが全く違う (zen/v1 はどちらとも一致しない) → モデル数が多い一般のカタログ
  assert.equal(providerFor(providers, 'https://opencode.ai/zen/v1')?.id, 'opencode');
  // パスが一致するならそちら
  assert.equal(providerFor(providers, 'https://opencode.ai/inference/go/openai/v1')?.id, 'opencode-go');
  assert.equal(providerFor(providers, 'https://unknown.invalid/v1'), undefined);
  assert.equal(providerFor(providers, 'not a url'), undefined);
});

test('一覧はプロバイダが勝ち、無い項目だけ models.dev で埋める', async t => {
  resetModelMetaCache();
  mockCatalog(t, url => url.endsWith('/models')
    // プロバイダは context_length を返す。models.dev に無いモデルも配信している
    ? json({ data: [
        { id: 'acme/long', context_length: 1_050_000 },
        { id: 'reflection/beam:free', context_length: 1_000_000 },
      ] })
    : undefined);

  const list = await fetchModelList('https://openrouter.ai/api/v1', 'secret');
  assert.deepEqual(list.map(m => m.id), ['acme/long', 'reflection/beam:free']);
  assert.equal(contextLengthFor(list, 'acme/long'), 1_050_000, 'プロバイダの値が勝つ');
  assert.equal(contextLengthFor(list, 'reflection/beam:free'), 1_000_000, 'models.dev に無くてもプロバイダから引ける');
  assert.equal(contextLengthFor(list, 'unknown/model'), undefined);
});

test('プロバイダが /models を返さなくても models.dev で引ける', async t => {
  resetModelMetaCache();
  mockCatalog(t, () => undefined);
  const list = await fetchModelList('https://openrouter.ai/api/v1', 'secret');
  assert.deepEqual(list.map(m => m.id), ['acme/long']);
  assert.equal(contextLengthFor(list, 'acme/long'), 1_000_000);
});

test('models.dev もプロバイダも駄目なら空 (推測しない)', async t => {
  resetModelMetaCache();
  t.mock.method(globalThis, 'fetch', async () => new Response('down', { status: 503 }));
  const list = await fetchModelList('https://openrouter.ai/api/v1', 'secret');
  assert.deepEqual(list, []);
});

test('カタログの問い合わせ失敗は短く記憶され、毎回は投げない', async t => {
  resetModelMetaCache();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls++;
    if (String(url) === 'https://models.dev/api.json') return new Response('down', { status: 503 });
    return new Response('nope', { status: 404 });
  });
  await fetchModelList('https://openrouter.ai/api/v1', 'secret');
  const first = calls;
  await fetchModelList('https://openrouter.ai/api/v1', 'secret');
  assert.equal(calls - first, 1, 'プロバイダの /models だけを引き直す (DB の失敗は記憶している)');
});
