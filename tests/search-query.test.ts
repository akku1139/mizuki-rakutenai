// SPDX-License-Identifier: AGPL-3.0-or-later

// メッセージ検索: クエリの解釈と、公式検索 API / 自前の遡りの両方。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeQuery, parseSearchQuery, parseWhen } from '../src/ai/search-query.ts';

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
  const value = result[1] as { count: number, messages: Array<{ id: string, at?: string }>, query: string };
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

test('公式検索が使えないときはエラーを返す (自前で遡るフォールバックは持たない)', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const { client } = fakeClient(() => { throw new Error('403 Missing Access'); });
  const result = await executeAITool('search_messages', { query: 'デプロイ' }, meta(client, channel));

  assert.equal(result[0], false);
  const error = result[1] as { error: string, hint: string };
  assert.match(error.error, /403 Missing Access/);
  assert.match(error.hint, /READ_MESSAGE_HISTORY/);
});

test('has: はそのまま検索 API に渡す', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const { calls, client } = fakeClient(() => ({
    messages: [[apiMessage('20', 'デプロイ', { attachments: [{ id: 'a', filename: 'a.png', content_type: 'image/png' }] })]],
  }));
  const result = await executeAITool('search_messages', { query: 'has:image' }, meta(client, channel));
  assert.equal(result[0], true);
  assert.equal(calls[0]!.query.get('has'), 'image');
  assert.equal((result[1] as { count: number }).count, 1);
});

test('日本語の長い文は語に割ってから検索する', () => {
  assert.deepEqual(parseSearchQuery('techfishの不祥事について教えて').terms, ['techfish', '不祥事']);
  assert.deepEqual(parseSearchQuery('メンション攻撃の記録を探して').terms, ['メンション攻撃', '記録']);
  // フレーズは割らない
  assert.deepEqual(parseSearchQuery('"PRをマージしろ"').phrases, ['prをマージしろ']);
});

test('OR は API が解釈しないので、1 つずつ検索してまとめる', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const contents: string[] = [];
  const { client } = fakeClient((_path, options) => {
    const query = (options as { query: URLSearchParams }).query;
    contents.push(String(query.get('content')));
    const term = query.get('content') ?? '';
    return {
      total_results: 1,
      messages: [[apiMessage(term.includes('techfish') ? '20' : '21', term)]],
    };
  });
  const result = await executeAITool('search_messages', { query: 'techfish OR 不祥事' }, meta(client, channel));
  assert.equal(result[0], true);
  assert.deepEqual(contents, ['techfish', '不祥事'], '語ごとに 1 回ずつ検索する');
  assert.equal((result[1] as { count: number }).count, 2, '結果はまとめる');
});

test('API が解釈しない条件だけのクエリは、黙って全件を返さずエラーにする', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const { client } = fakeClient(() => ({ total_results: 0, messages: [] }));
  for (const query of ['regex:/techfish/i', 'len:>50']) {
    const result = await executeAITool('search_messages', { query }, meta(client, channel));
    assert.equal(result[0], false, query);
    assert.match(String((result[1] as { error: string }).error), /使えません/);
  }
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

test('検索結果はチャンネルの ID と名前を返し、次に使える形にする', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const { client } = fakeClient(() => ({ total_results: 1, messages: [[apiMessage('20', 'デプロイ 失敗')]] }));
  const result = await executeAITool('search_messages', { query: 'デプロイ' }, meta(client, channel));
  assert.equal(result[0], true);
  const value = result[1] as {
    channels: Array<{ id: string, name: string }>,
    messages: Array<{ channelId: string, url: string }>,
    next?: string,
  };
  // 名前だけだと次のツール呼び出しで困るので、ID を必ず返す
  assert.deepEqual(value.channels, [{ id: '2', name: '#general' }]);
  assert.equal(value.messages[0]!.channelId, '2');
  assert.match(String(value.next), /fetch_messages_history/);
});

test('fetch_messages_history はチャンネル名でも引ける (曖昧一致・候補つき)', async () => {
  // fetch_messages_history は createdAt / messageSnapshots / author.bot も読む
  const fullMessage = {
    ...fakeMessage('5', 'ok'),
    createdAt: new Date('2026-10-20T00:00:00Z'),
    messageSnapshots: new Map(),
    author: { id: 'u1', username: 'tako', globalName: null, displayName: 'たこ', bot: false },
  };
  const takenGeneral = { id: '9', name: 'taken-general', isTextBased: () => true, messages: { fetch: async () => new Map([['5', fullMessage]]) } };
  const guild = {
    id: '1',
    channels: { cache: new Map([['9', takenGeneral]]) },
    threads: { cache: new Map() },
  };
  const fetched: unknown[] = [];
  const client = { channels: { fetch: async (id: string) => (id === '9' ? takenGeneral : null) } };
  const m = {
    msg: {
      id: '100',
      channelId: '2',
      guild,
      channel: { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } },
      client,
    },
  } as unknown as Parameters<typeof executeAITool>[2];

  // 名前 (曖昧一致) で引ける
  const ok = await executeAITool('fetch_messages_history', { channel: 'taken', limit: 5 }, m);
  assert.equal(ok[0], true, JSON.stringify(ok));
  // #付き・ID・URL でも同じ
  for (const value of ['#taken-general', '9', '<#9>', 'https://discord.com/channels/1/9/5']) {
    const result = await executeAITool('fetch_messages_history', { channel: value, limit: 5 }, m);
    assert.equal(result[0], true, `${value}: ${JSON.stringify(result)}`);
  }

  // 曖昧一致 (taken-gen → taken-general) も通る
  const fuzzy = await executeAITool('fetch_messages_history', { channel: 'taken-gen', limit: 5 }, m);
  assert.equal(fuzzy[0], true, JSON.stringify(fuzzy));

  // 打ち間違いは、候補つきのエラーで返す (次の呼び出しを直せるように)
  const missing = await executeAITool('fetch_messages_history', { channel: 'taken-generl', limit: 5 }, m);
  assert.equal(missing[0], false);
  const error = missing[1] as { error: string, candidates?: string[] };
  assert.match(error.error, /#taken-general/);
  assert.deepEqual(error.candidates, ['#taken-general']);
});

test('読めないチャンネルは権限のエラーで返す (50001 をそのまま出さない)', async () => {
  const denied = {
    id: '7', name: 'taken-gen', isTextBased: () => true,
    permissionsFor: () => ({ has: () => false }),
    messages: { fetch: async () => { throw Object.assign(new Error('Missing Access'), { code: 50001 }); } },
  };
  const metaWith = (channel: object) => ({
    msg: {
      id: '1', channelId: '2', guild: { id: '1', channels: { cache: new Map([['7', channel]]) }, threads: { cache: new Map() } },
      channel: { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } },
      client: { channels: { fetch: async () => channel } },
    },
  }) as unknown as Parameters<typeof executeAITool>[2];

  const result = await executeAITool('fetch_messages_history', { channel: 'taken-gen', limit: 3 }, metaWith(denied));
  assert.equal(result[0], false);
  assert.match(String((result[1] as { error: string }).error), /権限がありません/);

  // 権限判定が無い実装でも、取得時の 50001 を分かりやすい文にする
  const readableButBroken = { ...denied, permissionsFor: () => ({ has: () => true }) };
  const second = await executeAITool('fetch_messages_history', { channel: 'taken-gen', limit: 3 }, metaWith(readableButBroken));
  assert.equal(second[0], false);
  const error = second[1] as { error: string, hint: string };
  assert.match(error.error, /権限がありません/);
  assert.match(error.hint, /URL/);
});

test('検索語が無いときは API を叩かずエラーにする (最新の羅列を返さない)', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  let calls = 0;
  const { client } = fakeClient(() => { calls++; return { total_results: 0, messages: [] }; });
  for (const args of [{}, { query: '' }, { query: '   ' }] as Array<Record<string, unknown>>) {
    const result = await executeAITool('search_messages', args, meta(client, channel));
    assert.equal(result[0], false, JSON.stringify(args));
    assert.match(String((result[1] as { error: string }).error), /検索条件がありません|検索語がありません/);
  }
  assert.equal(calls, 0, '条件が無いのに API を叩いている');
});

test('条件だけのクエリは API に渡す (has: だけでも検索できる)', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const { calls, client } = fakeClient(() => ({ total_results: 1, messages: [[apiMessage('20', '')]] }));
  const result = await executeAITool('search_messages', { query: 'has:image' }, meta(client, channel));
  assert.equal(result[0], true);
  assert.equal(calls[0]!.query.get('content'), null, '語は送らない');
  assert.equal(calls[0]!.query.get('has'), 'image');
});

test('チャンネルを指定しないときは、そのことを結果に書く', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const { client } = fakeClient(() => ({ total_results: 1, messages: [[apiMessage('20', 'techfish')]], }));
  const result = await executeAITool('search_messages', { query: 'techfish' }, meta(client, channel));
  assert.match(String((result[1] as { scope?: string }).scope), /現在のチャンネルだけ/);
});

test('実際に検索した条件を結果に含める (モデルが確認できる)', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const { client } = fakeClient(() => ({ total_results: 1, messages: [[apiMessage('20', 'GMO の話')]] }));
  const result = await executeAITool('search_messages', { query: 'GMO' }, meta(client, channel));
  const value = result[1] as { request: { content: string | null, channels: string[] } };
  assert.equal(value.request.content, 'gmo');
  assert.deepEqual(value.request.channels, ['#general(2)']);
});

test('query が文字列でなければ断る (空扱いにしない)', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  let calls = 0;
  const { client } = fakeClient(() => { calls++; return { total_results: 0, messages: [] }; });
  const result = await executeAITool('search_messages', { query: { q: 'GMO' } }, meta(client, channel));
  assert.equal(result[0], false);
  assert.match(String((result[1] as { error: string }).error), /文字列で指定/);
  assert.equal(calls, 0);
});

test('offset で 2 ページ目以降を読める (total と nextOffset を返す)', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const offsets: string[] = [];
  const { client } = fakeClient((_path, options) => {
    const query = (options as { query: URLSearchParams }).query;
    offsets.push(String(query.get('offset')));
    return { total_results: 141, messages: [[apiMessage('20', 'techfish')]] };
  });
  const result = await executeAITool('search_messages', { query: 'techfish', offset: 50 }, meta(client, channel));
  const value = result[1] as { total: number, offset: number, nextOffset?: number };
  assert.deepEqual(offsets, ['50']);
  assert.equal(value.total, 141);
  assert.equal(value.offset, 50);
  assert.equal(value.nextOffset, 51);
});

test('limit が 25 を超えたら 25 件ずつページングする', async () => {
  const channel = { id: '2', name: 'general', isTextBased: () => true, messages: { fetch: async () => new Map() } };
  const calls: Array<{ limit: string | null, offset: string | null }> = [];
  let id = 100;
  const { client } = fakeClient((_path, options) => {
    const query = (options as { query: URLSearchParams }).query;
    calls.push({ limit: query.get('limit'), offset: query.get('offset') });
    // 25 件ずつ返す (最後は 10 件)
    const remaining = 60 - Number(query.get('offset'));
    const size = Math.min(25, remaining);
    const rows = Array.from({ length: size }, () => apiMessage(String(id++), 'techfish'));
    return { total_results: 60, messages: [rows] };
  });
  const result = await executeAITool('search_messages', { query: 'techfish', limit: 60 }, meta(client, channel));
  assert.equal(result[0], true);
  assert.deepEqual(calls.map(c => c.limit), ['25', '25', '10']);
  assert.deepEqual(calls.map(c => c.offset), ['0', '25', '50']);
  assert.equal((result[1] as { count: number }).count, 60);
});
