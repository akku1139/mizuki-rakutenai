// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Collection, type Guild } from 'discord.js';
import { DISCORD_USER_ID, FLUXER_USER_ID } from '../src/clients.ts';
import { buildSystemPrompt } from '../src/ai/prompt.ts';

test('the system prompt names both bot accounts and lists the server emojis', async () => {
  const guild = { emojis: { fetch: async () => new Collection([['1', { toString: () => '<:wave:1>' }], ['2', { toString: () => '<a:dance:2>' }]]) } };
  const prompt = await buildSystemPrompt(guild as unknown as Guild);
  assert.ok(prompt.includes(`<@${DISCORD_USER_ID}>, <@${FLUXER_USER_ID}>`));
  assert.ok(prompt.includes('瑞稀(mizuki)'));
  assert.ok(prompt.includes('<:wave:1>\n<a:dance:2>\n=========='));
});

test('the system prompt can be built without a server', async () => {
  const prompt = await buildSystemPrompt(null);
  assert.ok(prompt.includes('カスタム絵文字一覧'));
});

test('詳しい記録はNotionへ保存し、Wikiを増やさないことを明示する', async () => {
  const prompt = await buildSystemPrompt(null, 'openai');
  assert.match(prompt, /詳しい内容は Notion/);
  assert.match(prompt, /別のWikiや公開サイトを作らない/);
  assert.match(prompt, /Notionに記録してから最終回答/);
});
