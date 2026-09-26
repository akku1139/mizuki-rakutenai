import assert from 'node:assert/strict';
import { test } from 'node:test';

// The endpoint tools are only enabled when these are set when the module loads
process.env['READABILITY_ENDPOINT'] = 'https://readability.invalid/read';
process.env['SEARCH_ENDPOINT'] = 'https://search.invalid/search';
const { aitools, executeAITool, toOpenAITools } = await import('../src/ai/tools.ts');
const { discord, fluxer } = await import('../src/clients.ts');

type Meta = Parameters<typeof executeAITool>[2];

const fakeMessage = (id: string, content: string, extra: object = {}) => ({
  id,
  content,
  url: `https://discord.com/channels/1/2/${id}`,
  createdAt: new Date('2026-01-02T03:04:05Z'),
  member: null,
  author: { id: 'u1', displayName: 'User', globalName: null, username: 'user', bot: false },
  reference: null,
  embeds: [],
  attachments: new Map(),
  messageSnapshots: new Map(),
  ...extra,
});

/** A text channel whose history fetch records its options. */
const fakeChannel = (id: string, messages: ReturnType<typeof fakeMessage>[]) => {
  const fetches: unknown[] = [];
  return {
    fetches,
    channel: {
      id,
      name: `ch-${id}`,
      isTextBased: () => true,
      messages: {
        fetch: async (opts: unknown) => {
          fetches.push(opts);
          if (typeof opts === 'string') return messages.find(m => m.id === opts);
          return new Map(messages.map(m => [m.id, m]));
        },
      },
    },
  };
};

const meta = (channel: object, client: object = { channels: { fetch: async () => null } }) =>
  ({ msg: { id: '100', channel, client } }) as unknown as Meta;

test('every tool gets a required $explain argument in its OpenAI definition', () => {
  const defs = toOpenAITools() as Array<{ function: { name: string, parameters: { properties: object, required: string[] } } }>;
  assert.deepEqual(defs.map(d => d.function.name), [
    'fetch_message', 'fetch_messages_history', 'wikipedia_search', 'wikipedia_read', 'read_web', 'search_web',
  ]);
  for (const d of defs) {
    assert.ok('$explain' in d.function.parameters.properties, d.function.name);
    assert.ok(d.function.parameters.required.includes('$explain'), d.function.name);
  }
  const search = defs.find(d => d.function.name === 'wikipedia_search')!;
  assert.deepEqual(search.function.parameters.required, ['query', '$explain']);
  // The original schema is not modified
  assert.deepEqual((aitools['wikipedia_search']!.parametersJsonSchema as { required: string[] }).required, ['query']);
});

test('an unknown tool returns an error result', async () => {
  assert.deepEqual(await executeAITool('nope', {}, meta({})), [false, { error: 'function: nope は存在しません' }]);
});

test('fetch_message rejects URLs that are not message links', async () => {
  for (const url of ['https://example.com/x', 'https://discord.com/channels/1/2']) {
    assert.deepEqual(await executeAITool('fetch_message', { url }, meta({})), [false, { error: 'URLのパース中にエラーが発生しました' }]);
  }
});

test('fetch_message picks the client from the host and returns the message in the tool format', async t => {
  const { channel } = fakeChannel('2', [fakeMessage('3', 'hello', {
    reference: { guildId: '1', channelId: '2', messageId: '1', type: 0 },
    embeds: [{ data: { type: 'rich', title: 'Card' } }],
    attachments: new Map([['a', { name: 'a.png', url: 'https://cdn/a.png', contentType: 'image/png' }]]),
  })]);
  const discordFetch = t.mock.method(discord.channels, 'fetch', async () => channel);
  const fluxerFetch = t.mock.method(fluxer.channels, 'fetch', async () => channel);

  const [ok, value] = await executeAITool('fetch_message', { url: 'https://discord.com/channels/1/2/3' }, meta({}));
  assert.equal(ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), {
    content: 'hello',
    embeds: ['[embed: Card]'],
    attachments: [{ name: 'a.png', url: 'https://cdn/a.png', contentType: 'image/png' }],
    url: 'https://discord.com/channels/1/2/3',
    timestamp: '2026-01-02T03:04:05.000Z',
    author: { displayName: 'User', id: 'u1', globalName: 'User', username: 'user', bot: false },
    replies: { guildId: '1', channelId: '2', messageId: '1', type: 0 },
  });
  assert.deepEqual(discordFetch.mock.calls.map(c => c.arguments[0]), ['2']);

  await executeAITool('fetch_message', { url: 'https://fluxer.app/channels/1/2/3' }, meta({}));
  assert.equal(fluxerFetch.mock.callCount(), 1);
});

test('fetch_message reports a channel that cannot be read and errors from the API', async t => {
  t.mock.method(discord.channels, 'fetch', async () => null);
  assert.deepEqual(await executeAITool('fetch_message', { url: 'https://discord.com/channels/1/2/3' }, meta({})),
    [false, { error: 'チャンネルを取得できませんでした' }]);

  t.mock.method(discord.channels, 'fetch', async () => { throw new Error('Missing Access'); });
  const [ok, value] = await executeAITool('fetch_message', { url: 'https://discord.com/channels/1/2/3' }, meta({}));
  assert.equal(ok, false);
  assert.match((value as { error: string }).error, /Error: Missing Access/);
});

test('fetch_messages_history defaults to 30 messages around the current message', async () => {
  const { channel, fetches } = fakeChannel('2', [fakeMessage('5', 'a'), fakeMessage('6', 'b')]);
  const [ok, value] = await executeAITool('fetch_messages_history', {}, meta(channel));
  assert.equal(ok, true);
  assert.deepEqual(fetches, [{ around: '100', cache: false, limit: 30 }]);
  const result = value as Record<string, { content?: string }>;
  assert.equal(result['5']!.content, 'a');
  assert.equal(result['6']!.content, 'b');
  assert.deepEqual(result['channel'], { id: '2', name: 'ch-2' });
});

test('fetch_messages_history clamps the limit and honours the mode', async () => {
  const { channel, fetches } = fakeChannel('2', []);
  await executeAITool('fetch_messages_history', { limit: 500, mode: 'before' }, meta(channel));
  await executeAITool('fetch_messages_history', { limit: 0, mode: 'after' }, meta(channel));
  await executeAITool('fetch_messages_history', { limit: 10, mode: 'sideways' }, meta(channel));
  assert.deepEqual(fetches, [
    { before: '100', cache: false, limit: 100 },
    { after: '100', cache: false, limit: 1 },
    { around: '100', cache: false, limit: 10 },
  ]);
});

test('fetch_messages_history reads another channel from a mention or a message URL', async t => {
  const other = fakeChannel('7', []);
  const client = { channels: { fetch: async (id: string) => (id === '7' ? other.channel : null) } };

  await executeAITool('fetch_messages_history', { url: '<#7>' }, meta({}, client));
  assert.deepEqual(other.fetches.at(-1), { around: undefined, cache: false, limit: 30 });

  t.mock.method(discord.channels, 'fetch', async () => other.channel);
  await executeAITool('fetch_messages_history', { url: 'https://discord.com/channels/1/7/42' }, meta({}, client));
  assert.deepEqual(other.fetches.at(-1), { around: '42', cache: false, limit: 30 });

  assert.deepEqual(await executeAITool('fetch_messages_history', { url: 'nonsense' }, meta({}, client)),
    [false, { error: 'URL/チャンネルメンションのパース中にエラーが発生しました' }]);
  assert.deepEqual(await executeAITool('fetch_messages_history', { url: '<#8>' }, meta({}, client)),
    [false, { error: 'チャンネルを取得できませんでした' }]);
});

test('the web tools call their endpoints with the query and a User-Agent, and report HTTP errors', async t => {
  const urls: string[] = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.match((init.headers as Record<string, string>)['User-Agent']!, /^MizukiBot/);
    return new Response(JSON.stringify({ query: { search: ['hit'] }, extra: 1 }), { status, statusText: status === 200 ? 'OK' : 'Service Unavailable' });
  });

  assert.deepEqual(await executeAITool('wikipedia_search', { query: 'a b' }, meta({})), [true, { search: ['hit'] }]);
  assert.deepEqual(await executeAITool('search_web', { query: 'a&b' }, meta({})), [true, { query: { search: ['hit'] }, extra: 1 }]);
  await executeAITool('read_web', { url: 'https://example.com/?x=1' }, meta({}));
  await executeAITool('wikipedia_read', { title: '東京' }, meta({}));
  assert.deepEqual(urls, [
    'https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=a%20b&format=json',
    'https://search.invalid/search?q=a%26b',
    'https://readability.invalid/read?url=https%3A%2F%2Fexample.com%2F%3Fx%3D1',
    `https://ja.wikipedia.org/w/api.php?action=query&prop=extracts&titles=${encodeURIComponent('東京')}&explaintext=1&format=json`,
  ]);

  status = 503;
  assert.deepEqual(await executeAITool('wikipedia_read', { title: 'x' }, meta({})),
    [false, { error: 'HTTPステータスコード: 503 (Service Unavailable)' }]);
});
