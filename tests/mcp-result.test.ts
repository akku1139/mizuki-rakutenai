// SPDX-License-Identifier: AGPL-3.0-or-later

// MCP のツール結果をテキストにする部分。
// GitHub MCP の get_file_contents のように `resource` で返すサーバーがあり、
// text 以外を捨てるとモデルには中身が届かない (実際にこれでファイルが読めなかった)。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resultText } from '../src/ai/mcp.ts';

const noRead = async (uri: string) => `[unread ${uri}]`;

test('text はそのまま渡る', async () => {
  const r = await resultText({ content: [{ type: 'text', text: 'hello' }] }, noRead);
  assert.deepEqual(r, { text: 'hello', ok: true });
});

test('埋め込みリソース (text) の中身を渡す', async () => {
  const r = await resultText({
    content: [{ type: 'resource', resource: { uri: 'repo://a/b', mimeType: 'text/plain', text: 'export const x = 1;' } }],
  }, noRead);
  assert.deepEqual(r, { text: 'export const x = 1;', ok: true });
});

test('uri だけのリソースは取りに行く', async () => {
  const asked: string[] = [];
  const r = await resultText({
    content: [{ type: 'resource', resource: { uri: 'repo://a/b' } }],
  }, async (uri) => { asked.push(uri); return '中身'; });
  assert.deepEqual(asked, ['repo://a/b']);
  assert.equal(r.text, '中身');
});

test('リソースリンクも取りに行き、駄目ならリンクを残す', async () => {
  const body = await resultText({
    content: [{ type: 'resource_link', uri: 'repo://x', name: 'x.ts' }],
  }, async () => 'ファイルの中身');
  assert.equal(body.text, 'ファイルの中身');

  const fallback = await resultText({
    content: [{ type: 'resource_link', uri: 'repo://x', name: 'x.ts' }],
  }, async () => '');
  assert.match(fallback.text, /x\.ts/);
  assert.match(fallback.text, /repo:\/\/x/);
});

test('バイナリと画像は概要にする (base64 をそのまま流さない)', async () => {
  const r = await resultText({
    content: [
      { type: 'resource', resource: { uri: 'repo://bin', mimeType: 'image/png', blob: 'A'.repeat(400) } },
      { type: 'image', mimeType: 'image/jpeg', data: 'B'.repeat(400) },
    ],
  }, noRead);
  assert.match(r.text, /バイナリ image\/png/);
  assert.match(r.text, /画像 image\/jpeg/);
  assert.ok(!r.text.includes('A'.repeat(50)), 'base64 を流している');
});

test('テキストが無ければ structuredContent を JSON で渡す', async () => {
  const r = await resultText({ content: [], structuredContent: { count: 2, rows: [1, 2] } }, noRead);
  assert.match(r.text, /"count": 2/);
});

test('isError は ok=false、中身が無ければ (no content)', async () => {
  assert.equal((await resultText({ content: [{ type: 'text', text: 'boom' }], isError: true }, noRead)).ok, false);
  assert.equal((await resultText({ content: [] }, noRead)).text, '(no content)');
});

test('知らない種類は残す (黙って捨てない)', async () => {
  const r = await resultText({ content: [{ type: 'weird' }] }, noRead);
  assert.match(r.text, /weird/);
});
