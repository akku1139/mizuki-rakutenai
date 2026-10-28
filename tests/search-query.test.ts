// SPDX-License-Identifier: AGPL-3.0-or-later

// メッセージ検索: クエリの解釈と、公式検索 API / 自前の遡りの両方。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeQuery, matchesQuery, parseSearchQuery, parseWhen } from '../src/ai/search-query.ts';

process.env['READABILITY_ENDPOINT'] = 'https://readability.invalid/read';
process.env['SEARCH_ENDPOINT'] = 'https://search.invalid/search';
const { executeAITool } = await import('../src/ai/tools.ts');

const NOW = Date.parse('2026-10-28T00:00:00Z');

test('クエリを Discord 流の条件に解釈する', () => {
  const q = parseSearchQuery('レビュー from:たこ in:#dev has:image after:2026-10-01 -warn "デプロイ 失敗" is:pinned sort:old', NOW);
  assert.deepEqual(q.terms, ['レビュー']);
  assert.deepEqual(q.phrases, ['デプロイ 失敗']);
  assert.deepEqual(q.from, ['たこ']);
  assert.deepEqual(q.channels, ['#dev']);
  assert.deepEqual(q.has, ['image']);
  assert.deepEqual(q.notTerms, ['warn']);
  assert.equal(q.pinned, true);
  assert.equal(q.sort, 'old');
  assert.equal(q.after, Date.UTC(2026, 9, 1) - 9 * 3_600_000);
  assert.match(describeQuery(q), /from:たこ/);
});

test('OR と正規表現と長さ', () => {
  const q = parseSearchQuery('Rust OR Go regex:/v?\\d+\\.\\d+/i len:>50', NOW);
  assert.deepEqual(q.anyOf, ['rust', 'go']);
  assert.ok(q.regex instanceof RegExp);
  assert.equal(q.regex!.test('v1.2'), true);
  assert.equal(q.minLength, 50);
});

test('期間の書き方 (相対と絶対)', () => {
  assert.equal(parseWhen('7d', NOW), NOW - 7 * 86_400_000);
  assert.equal(parseWhen('24h', NOW), NOW - 24 * 3_600_000);
  assert.equal(parseWhen('2026-10-01', NOW), Date.UTC(2026, 9, 1) - 9 * 3_600_000);
  assert.equal(parseWhen('2026-10', NOW), Date.UTC(2026, 9, 1) - 9 * 3_600_000);
  assert.equal(parseWhen('nonsense', NOW), undefined);
  const during = parseSearchQuery('during:week', NOW);
  assert.equal(during.after, NOW - 7 * 86_400_000);
});

test('知らない演算子は捨てて、結果に添える', () => {
  const q = parseSearchQuery('foo unknownbar:1', NOW);
  assert.deepEqual(q.ignored, ['unknownbar:1']);
  assert.deepEqual(q.terms, ['foo']);
});

const message = (over: Partial<Parameters<typeof matchesQuery>[0]> = {}) => ({
  content: 'デプロイ 失敗した',
  createdTimestamp: Date.parse('2026-10-20T00:00:00Z'),
  author: { id: 'u1', username: 'tako', globalName: 'Tako', displayName: 'たこ' },
  embeds: [],
  attachments: { size: 0 },
  stickers: { size: 0 },
  reactions: { cache: { size: 0 } },
  ...over,
});

test('条件は取得したメッセージに対して評価する', () => {
  const m = message();
  assert.equal(matchesQuery(m, parseSearchQuery('デプロイ', NOW)), true);
  assert.equal(matchesQuery(m, parseSearchQuery('デプロイ -失敗', NOW)), false);
  assert.equal(matchesQuery(m, parseSearchQuery('from:たこ', NOW)), true);
  assert.equal(matchesQuery(m, parseSearchQuery('from:u1', NOW)), true);
  assert.equal(matchesQuery(m, parseSearchQuery('from:さば', NOW)), false);
  assert.equal(matchesQuery(m, parseSearchQuery('after:2026-10-01', NOW)), true);
  assert.equal(matchesQuery(m, parseSearchQuery('after:2026-10-25', NOW)), false);
  assert.equal(matchesQuery(m, parseSearchQuery('before:2026-10-25', NOW)), true);
  assert.equal(matchesQuery(m, parseSearchQuery('has:embed', NOW)), false);
  assert.equal(matchesQuery(m, parseSearchQuery('has:embed', NOW)), false);
  assert.equal(matchesQuery(message({ embeds: [{}] }), parseSearchQuery('has:embed', NOW)), true);
  assert.equal(matchesQuery(m, parseSearchQuery('len:<5', NOW)), false);
  assert.equal(matchesQuery(m, parseSearchQuery('is:pinned', NOW)), false);
  assert.equal(matchesQuery(message({ pinned: true }), parseSearchQuery('is:pinned', NOW)), true);
  assert.equal(matchesQuery(m, parseSearchQuery('Go OR Rust', NOW)), false);
  assert.equal(matchesQuery(message({ content: 'Rust の話' }), parseSearchQuery('Go OR Rust', NOW)), true);
});

const fakeMessage = (id: string, content: string, extra: object = {}) => ({
  id,
  content,
  url: `https://discord.com/channels/1/2/${id}`,
  createdTimestamp: Date.parse('2026-10-20T00:00:00Z'),
  pinned: false,
  author: { id: 'u1', username: 'tako', globalName: null, displayName: 'たこ' },
  mentions: { users: new Map() },
  embeds: [],
  attachments: new Map(),
  stickers: new Map(),
  reactions: { cache: new Map() },
  ...extra,
});

/** 公式検索 API を返すクライアント (rest.get をモックする) */
const fakeClient = (respond: (path: string, options: unknown) => unknown) => {
  const calls: Array<{ path: string, query: URLSearchParams }> = [];
  return {
    calls,
    client: {
      rest: {
        get: async (path: string, options: { query: URLSearchParams }) => {
          calls.push({ path, query: options.query });
          return respond(path, options);
        },
      },
    },
  };
};

const meta = (client: object, channel: object, members: { cache: Map<string, unknown>, fetch?: Function } = { cache: new Map() }) => ({
  msg: {
    id: '100',
    channelId: '2',
    guild: {
      id: '1',
      members,
      channels: { cache: new Map([['2', channel]]) },
      threads: { cache: new Map() },
    },
    channel,
    client,
  },
}) as unknown as Parameters<typeof executeAITool>[2];

/** `after:7d` のような相対指定に引っかからないよう、1 時間前のメッセージにする */
const RECENT = new Date(Date.now() - 3_600_000).toISOString();

const apiMessage = (id: string, content: string, extra: object = {}) => ({
  id,
  channel_id: '2',
  guild_id: '1',
  content,
  timestamp: RECENT,
  pinned: false,
  author: { id: 'u1', username: 'tako', global_name: 'Tako' },
  mentions: [],
  embeds: [],
  attachments: [],
  sticker_items: [],
  ...extra,
});

test('公式の検索 API に条件を渡し、結果を整形して返す', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const { calls, client } = fakeClient(() => ({
    total_results: 2,
    messages: [[
      apiMessage('20', 'デプロイ 失敗した', { author: { id: '900', username: 'tako', global_name: null }, attachments: [{ id: 'a', filename: 'log.txt', content_type: 'text/plain' }] }),
      apiMessage('21', 'デプロイ 成功', { author: { id: '900', username: 'tako', global_name: null }, attachments: [{ id: 'b', filename: 'b.txt', content_type: 'text/plain' }] }),
    ]],
  }));
  const members = {
    cache: new Map([['900', { id: '900', user: { username: 'tako', globalName: null }, displayName: 'たこ' }]]),
  };
  const result = await executeAITool('search_messages', { query: 'デプロイ from:tako has:file after:7d' }, meta(client, channel, members));

  assert.equal(result[0], true);
  const value = result[1] as { count: number, via: string, messages: Array<{ id: string, at?: string }>, query: string };
  assert.equal(value.via, 'api');
  assert.equal(value.count, 2);
  assert.equal(value.messages[0]!.id, '20');
  assert.equal(value.messages[0]!.at, RECENT);
  // 送った条件
  const query = calls[0]!.query;
  assert.equal(calls[0]!.path, '/guilds/1/messages/search');
  assert.equal(query.get('content'), 'デプロイ');
  assert.equal(query.get('author_id'), '900');
  assert.equal(query.get('channel_id'), '2');
  assert.equal(query.get('has'), 'file');
  assert.equal(query.get('sort_order'), 'desc');
  assert.ok(query.get('min_id'));
});

test('公式検索が使えないときは自前で遡る', async () => {
  const fetched: unknown[] = [];
  const channel = {
    id: '2',
    name: 'general',
    isTextBased: () => true,
    messages: {
      fetch: async (options: unknown) => {
        fetched.push(options);
        return new Map([['20', fakeMessage('20', 'デプロイ 失敗した')]]);
      },
    },
  };
  const { client } = fakeClient(() => { throw new Error('403 Missing Access'); });
  const result = await executeAITool('search_messages', { query: 'デプロイ' }, meta(client, channel));

  assert.equal(result[0], true);
  const value = result[1] as { via: string, count: number, messages: Array<{ id: string }> };
  assert.equal(value.via, 'paging');
  assert.equal(value.count, 1);
  assert.equal(value.messages[0]!.id, '20');
  assert.ok(fetched.length > 0);
});

test('has: は公式検索が知っている種類だけを渡し、残りは自前で判定する', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const { calls, client } = fakeClient(() => ({
    messages: [[apiMessage('20', 'デプロイ', { attachments: [{ id: 'a', filename: 'a.png', content_type: 'image/png' }] })]],
  }));
  const result = await executeAITool('search_messages', { query: 'has:image' }, meta(client, channel));
  assert.equal(result[0], true);
  assert.equal(calls[0]!.query.get('has'), 'image');
  assert.equal((result[1] as { count: number }).count, 1);
});

test('索引がまだ無い (202) と言われたら 1 回だけ待ってやり直す', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  let calls = 0;
  const { client } = fakeClient(() => {
    calls++;
    return calls === 1
      ? { code: 110000, message: 'Index not yet available', retry_after: 0 }
      : { total_results: 1, messages: [[apiMessage('30', 'デプロイ 済み')]] };
  });
  const result = await executeAITool('search_messages', { query: 'デプロイ' }, meta(client, channel));
  assert.equal(result[0], true);
  assert.equal(calls, 2);
  assert.equal((result[1] as { count: number }).count, 1);
});
