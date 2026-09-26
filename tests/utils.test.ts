import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileFromUrl, getFileName, isEffectivelyEmpty, splitLongString } from '../src/utils.ts';

test('splitLongString keeps short text as one part', () => {
  assert.deepEqual(splitLongString('abc', 3), ['abc']);
  assert.deepEqual(splitLongString('', 3), ['']);
});

test('splitLongString cuts after the last newline that fits, keeping the newline', () => {
  assert.deepEqual(splitLongString('aa\nbb\ncc', 6), ['aa\nbb\n', 'cc']);
});

test('splitLongString cuts at the length when a part has no newline', () => {
  assert.deepEqual(splitLongString('abcdefg', 3), ['abc', 'def', 'g']);
});

test('splitLongString parts are within the length and join back to the original', () => {
  const text = Array.from({ length: 50 }, (_, i) => 'x'.repeat(i % 13) + '\n').join('') + 'y'.repeat(40);
  const parts = splitLongString(text, 16);
  assert.equal(parts.join(''), text);
  for (const p of parts) assert.ok(p.length <= 16 && p.length > 0, JSON.stringify(p));
});

test('isEffectivelyEmpty ignores half-width and full-width spaces and newlines', () => {
  assert.equal(isEffectivelyEmpty(''), true);
  assert.equal(isEffectivelyEmpty(' 　\n\r\n'), true);
  assert.equal(isEffectivelyEmpty(' a '), false);
});

test('getFileName takes the last path segment and drops a size suffix after a colon', () => {
  assert.equal(getFileName('https://pbs.twimg.com/media/G53TrWRbYAEXaOP.jpg:medium'), 'G53TrWRbYAEXaOP.jpg');
  assert.equal(getFileName('https://cdn.example.com/a/b/image.png?width=100'), 'image.png');
  assert.equal(getFileName('https://example.com/'), '');
});

test('getFileName returns an empty string for an invalid URL', t => {
  t.mock.method(console, 'error', () => {});
  assert.equal(getFileName('not a url'), '');
});

test('createFileFromUrl keeps the content type and falls back to text/plain', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) =>
    url.endsWith('.png')
      ? new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
      : new Response(new Blob(['hello'])));

  const png = await createFileFromUrl('https://example.com/a.png', 'a.png');
  assert.equal(png.name, 'a.png');
  assert.equal(png.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await png.arrayBuffer())], [1, 2, 3]);

  const txt = await createFileFromUrl('https://example.com/a', 'a');
  assert.equal(txt.type, 'text/plain');
  assert.equal(await txt.text(), 'hello');
});

test('createFileFromUrl throws when the response is not ok', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('gone', { status: 404, statusText: 'Not Found' }));
  await assert.rejects(createFileFromUrl('https://example.com/x', 'x.png'), /failed to fetch x\.png: 404 Not Found/);
});
