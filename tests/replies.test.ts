// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Message } from 'discord.js';
import { discord } from '../src/clients.ts';

const cwd = process.cwd();
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mizuki-replies-'));
process.chdir(dir);
const { rememberReply, removeSavedReplies } = await import('../src/ai/replies.ts');
test.after(async () => { process.chdir(cwd); await fs.rm(dir, { recursive: true, force: true }); });
const source = { id: '123', channelId: '456', client: discord } as Message;

test('分割した返信を永続化し、再読み込み後も全て削除する', async t => {
  await Promise.all([rememberReply(source, '789'), rememberReply(source, '790')]);
  const deleted: string[] = [];
  t.mock.method(discord.channels, 'fetch', async () => ({ isTextBased: () => true, messages: { delete: async (id: string) => { deleted.push(id); } } }));
  const reloaded = await import(new URL('../src/ai/replies.ts?reload', import.meta.url).href);
  await reloaded.removeSavedReplies(source.id);
  assert.deepEqual(deleted, ['789', '790']);
  assert.deepEqual(JSON.parse(await fs.readFile('./data/ai_replies.json', 'utf8')), {});
});

test('削除失敗時は対応を残し、再試行できる', async t => {
  await rememberReply(source, '791');
  t.mock.method(discord.channels, 'fetch', async () => ({ isTextBased: () => true, messages: { delete: async () => { throw new Error('Missing Access'); } } }));
  await assert.rejects(removeSavedReplies(source.id), /Missing Access/);
  assert.ok((await fs.readFile('./data/ai_replies.json', 'utf8')).includes('791'));
});
