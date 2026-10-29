// SPDX-License-Identifier: AGPL-3.0-or-later

// ChatGPT 方式の記憶 (保存した事実) の保存・想起・ツール。

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { recall, termsOf } from '../src/memory/recall.ts';
import {
  forgetFact, loadMemory, MAX_FACTS_PER_GUILD, mergeFacts, newFactId, rememberFact, resetMemoryCache,
  saveMemory, trimFacts, type GuildMemory, type MemoryFact,
} from '../src/memory/store.ts';
import { memoryTool } from '../src/memory/tools.ts';
import type { AIToolMeta } from '../src/ai/tools.ts';

const GUILD = 'test-memory-guild';
const OTHER_GUILD = 'test-memory-guild-2';
const pathOf = (guildId: string) => `./data/memory/${guildId}.json`;

const cleanup = async () => {
  await fs.rm(pathOf(GUILD), { force: true });
  await fs.rm(pathOf(OTHER_GUILD), { force: true });
  await fs.rm(`${pathOf(GUILD)}.tmp`, { force: true });
  await fs.rm(`${pathOf(OTHER_GUILD)}.tmp`, { force: true });
  resetMemoryCache();
};

const fact = (over: Partial<MemoryFact> = {}): MemoryFact => ({
  id: newFactId(),
  scope: 'guild',
  text: 'テストの事実',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const meta = (authorId: string, guildId = GUILD): AIToolMeta => ({
  msg: {
    guild: { id: guildId },
    author: { id: authorId },
    url: 'https://discord.com/channels/1/2/3',
  },
} as unknown as AIToolMeta);

test('同じ事実は増やさず、内容と時刻を更新する', async () => {
  await cleanup();
  const memory = await loadMemory(GUILD);
  const first = rememberFact(memory, { scope: 'user', subject: 'u1', text: 'たこは Rust 派。', tags: ['たこ'] }, 100);
  const again = rememberFact(memory, { scope: 'user', subject: 'u1', text: 'たこは Rust 派', tags: ['Rust'] }, 200);
  assert.equal(again.created, false);
  assert.equal(again.fact.id, first.fact.id);
  assert.equal(memory.facts.length, 1);
  assert.equal(again.fact.updatedAt, 200);
  assert.deepEqual([...again.fact.tags].sort(), ['Rust', 'たこ']);
  // 相手が違えば別の事実
  rememberFact(memory, { scope: 'user', subject: 'u2', text: 'たこは Rust 派' }, 300);
  assert.equal(memory.facts.length, 2);
  // 保存先が違えば別
  rememberFact(memory, { scope: 'guild', text: 'たこは Rust 派' }, 400);
  assert.equal(memory.facts.length, 3);
});

test('id でも本文でも消せる', async () => {
  await cleanup();
  const memory = await loadMemory(GUILD);
  const { fact: a } = rememberFact(memory, { scope: 'guild', text: 'CI は GitHub Actions' }, 1);
  rememberFact(memory, { scope: 'guild', text: 'サーバーは Evex' }, 2);
  assert.equal(forgetFact(memory, a.id)?.id, a.id);
  assert.equal(forgetFact(memory, 'Evex')?.text, 'サーバーは Evex');
  assert.equal(forgetFact(memory, 'Evex'), undefined);
  assert.equal(memory.facts.length, 0);
});

test('上限を超えたらピン留め以外の古いものから捨てる', () => {
  const facts = Array.from({ length: MAX_FACTS_PER_GUILD + 10 }, (_, i) => fact({ text: `f${i}`, updatedAt: i }));
  facts[0]!.pinned = true;
  const trimmed = trimFacts(facts);
  assert.equal(trimmed.length, MAX_FACTS_PER_GUILD);
  assert.equal(trimmed[0]!.text, 'f0', 'ピン留めは残る');
  assert.ok(!trimmed.some(f => f.text === 'f1'), '古いものから消える');
});

test('保存したものが読み戻せて、サーバーをまたいで混ざらない', async () => {
  await cleanup();
  const memory = await loadMemory(GUILD);
  rememberFact(memory, { scope: 'guild', text: 'サーバーは Evex', pinned: true }, 10);
  await saveMemory(memory);
  resetMemoryCache();

  const reloaded = await loadMemory(GUILD);
  assert.equal(reloaded.facts.length, 1);
  assert.equal(reloaded.facts[0]!.text, 'サーバーは Evex');
  assert.equal(reloaded.facts[0]!.pinned, true);
  assert.equal((await loadMemory(OTHER_GUILD)).facts.length, 0);
  await cleanup();
});

test('想起は ピン留め > 本人 > 語の一致 > サーバー の順で、文字数で切る', () => {
  const memory: GuildMemory = {
    guildId: GUILD,
    facts: [
      fact({ scope: 'guild', text: 'サーバーは Evex', pinned: true, updatedAt: 1 }),
      fact({ scope: 'user', subject: 'u1', text: 'たこは Rust 派', updatedAt: 2 }),
      fact({ scope: 'guild', text: 'Notion に記憶を置く', tags: ['notion'], updatedAt: 3 }),
      fact({ scope: 'guild', text: '関係ない話', updatedAt: 4 }),
    ],
  };
  const result = recall({ memory, userId: 'u1', text: 'notion の話して' });
  const lines = result.text.split('\n');
  assert.match(lines[0]!, /覚えていること/);
  assert.match(lines[1]!, /サーバーは Evex/, 'ピン留めが先頭');
  assert.match(lines[2]!, /たこは Rust 派/, '本人の事実が次');
  assert.match(lines[3]!, /Notion に記憶を置く/, '語が当たったもの');
  // 当たらなくてもサーバーの事実は後ろに出す (ChatGPT が保存済みの記憶を全部載せるのと同じ)。
  // 予算が厳しければ落ちる
  assert.match(lines[4]!, /関係ない話/);

  const tiny = recall({ memory, userId: 'u1', text: 'notion', maxChars: 60 });
  assert.ok(tiny.text.length <= 60);
  assert.ok(!tiny.text.includes('関係ない話'), '予算が無ければ落とす');
  assert.equal(recall({ memory: { guildId: GUILD, facts: [] }, userId: 'u1', text: 'x' }).text, '');
});

test('依頼文から想起の手がかりを取る', () => {
  assert.deepEqual(termsOf('<@123> Rust の話').filter(t => t === 'rust'), ['rust']);
  assert.ok(termsOf('さかなのメモリシステム').includes('さかな'));
  assert.ok(termsOf('https://example.com/x').length === 0);
});

test('memory ツールで保存・検索・削除でき、根拠の URL が残る', async () => {
  await cleanup();
  const remembered = await memoryTool.execute(
    { action: 'remember', text: 'たこは Rust 派', tags: 'たこ,Rust' },
    meta('u1'),
  );
  assert.equal(remembered[0], true);
  const id = (remembered[1] as { saved: Array<{ id: string }> }).saved[0]!.id;

  const memory = await loadMemory(GUILD);
  assert.equal(memory.facts.length, 1);
  assert.equal(memory.facts[0]!.scope, 'user');
  assert.equal(memory.facts[0]!.subject, 'u1');
  assert.equal(memory.facts[0]!.source, 'https://discord.com/channels/1/2/3');
  assert.deepEqual(memory.facts[0]!.tags, ['たこ', 'Rust']);

  // 同じことをもう一度言っても増えない
  await memoryTool.execute({ action: 'remember', text: 'たこは Rust 派' }, meta('u1'));
  assert.equal((await loadMemory(GUILD)).facts.length, 1);

  const found = await memoryTool.execute({ action: 'search', query: 'Rust' }, meta('u1'));
  assert.equal(found[0], true);
  assert.match(String((found[1] as { facts: string }).facts), /たこは Rust 派/);

  const forgotten = await memoryTool.execute({ action: 'forget', text: id }, meta('u1'));
  assert.equal(forgotten[0], true);
  assert.equal((await loadMemory(GUILD)).facts.length, 0);
  await cleanup();
});

test('memory ツールはサーバー外では断る', async () => {
  const result = await memoryTool.execute({ action: 'remember', text: 'x' }, {
    msg: { guild: null, author: { id: 'u1' } },
  } as unknown as AIToolMeta);
  assert.equal(result[0], false);
});

test('Notion から取り込んだ事実は、新しいときだけ上書きする', () => {
  const memory: GuildMemory = { guildId: GUILD, facts: [fact({ id: 'local', text: '古い説明', updatedAt: 100, notionPageId: 'p1' })] };
  const { updated } = mergeFacts(memory, [fact({ text: '新しい説明', updatedAt: 200, notionPageId: 'p1' })]);
  assert.equal(updated, 1);
  assert.equal(memory.facts[0]!.id, 'local', 'ローカルの id は保つ');
  assert.equal(memory.facts[0]!.text, '新しい説明');

  const older = mergeFacts(memory, [fact({ text: 'もっと古い説明', updatedAt: 50, notionPageId: 'p1' })]);
  assert.equal(older.updated, 0);
  assert.equal(memory.facts[0]!.text, '新しい説明', '古い方では上書きしない');
});
