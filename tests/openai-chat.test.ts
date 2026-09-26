import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatChat } from '../src/ai/openai.ts';
import type { AIEvent, ChatContents, ToolSpec } from '../src/ai/types.ts';

type Body = { model: string, stream: boolean, tools?: unknown, messages: Array<{ role: string, content: unknown, tool_calls?: any[], tool_call_id?: string }> };

const config = { baseUrl: 'https://llm.invalid/v1', apiKey: 'secret', model: 'test-model' };

/** An SSE response whose bytes arrive in the given pieces. */
const stream = (...pieces: string[]) => new Response(new ReadableStream({
  start(controller) {
    for (const p of pieces) controller.enqueue(new TextEncoder().encode(p));
    controller.close();
  },
}));
const data = (chunk: object) => `data: ${JSON.stringify(chunk)}\n\n`;
const delta = (d: object) => data({ choices: [{ delta: d }] });
const done = 'data: [DONE]\n\n';

const collect = async (chat: OpenAICompatChat, contents: ChatContents) => {
  const events: AIEvent[] = [];
  for await (const e of chat.sendMessage({ contents })) events.push(e);
  return events;
};
const say = (chat: OpenAICompatChat, text: string) => collect(chat, [{ type: 'text', text }]);

/** Mocks fetch with one handler per request, and records the request bodies. */
const mockFetch = (t: { mock: { method: Function } }, ...responses: Array<() => Response>) => {
  const requests: Array<{ url: string, headers: Record<string, string>, body: Body }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const next = responses[Math.min(requests.length, responses.length) - 1]!;
    return next();
  });
  return requests;
};

test('the request carries the model, the key and the system prompt with the server context', async t => {
  const requests = mockFetch(t, () => stream(delta({ content: 'hi' }), done));
  const chat = new OpenAICompatChat(config);
  chat.setSystemPrompt('be nice');
  chat.setServerContext('Guild', 'general');
  await say(chat, 'hello');

  const [req] = requests;
  assert.equal(req!.url, 'https://llm.invalid/v1/chat/completions');
  assert.equal(req!.headers['Authorization'], 'Bearer secret');
  assert.equal(req!.body.model, 'test-model');
  assert.equal(req!.body.stream, true);
  assert.equal(req!.body.tools, undefined);
  assert.deepEqual(req!.body.messages, [
    { role: 'system', content: 'be nice\nあなたが参加してるサーバーは "Guild"、チャンネルは "general" です。' },
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(chat.label, 'test-model');
});

test('streamed text is yielded piece by piece, even when a line is split across reads', async t => {
  mockFetch(t, () => stream(
    delta({ reasoning_content: 'thinking' }),
    delta({ content: 'Hel' }).slice(0, 10), delta({ content: 'Hel' }).slice(10),
    ': keep-alive\n\n',
    data({ choices: [{ text: 'lo', delta: {} }] }),
    data({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } } }),
    done,
  ));
  const chat = new OpenAICompatChat(config);
  const events = await say(chat, 'hi');
  assert.deepEqual(events, [
    { type: 'text-delta', text: 'Hel' },
    { type: 'text-delta', text: 'lo' },
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 } },
    { type: 'done', messageIds: [chat.id] },
  ]);
});

test('the reply is kept in the history for the next turn', async t => {
  const requests = mockFetch(t, () => stream(delta({ content: 'first reply' }), done));
  const chat = new OpenAICompatChat(config);
  await say(chat, 'one');
  await say(chat, 'two');
  assert.deepEqual(requests[1]!.body.messages, [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: 'two' },
  ]);
});

test('an HTTP error yields an error event and leaves the history as it was', async t => {
  let status = 500;
  const requests = mockFetch(t, () => status === 500 ? new Response('boom', { status }) : stream(delta({ content: 'ok' }), done));
  const chat = new OpenAICompatChat(config);
  const events = await say(chat, 'fails');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'error');
  assert.match((events[0] as { message: string }).message, /500 boom/);

  status = 200;
  await say(chat, 'works');
  assert.deepEqual(requests[1]!.body.messages, [{ role: 'user', content: 'works' }]);
});

test('files become image parts, expanded text, or a note for unreadable formats', async t => {
  const requests = mockFetch(t, () => stream(delta({ content: 'ok' }), done));
  const chat = new OpenAICompatChat(config);
  const image = await chat.uploadFile({ file: new File([new Uint8Array([1, 2])], 'a.png', { type: 'image/png' }), isImage: true });
  const json = await chat.uploadFile({ file: new File(['{"a":1}'], 'a.json', { type: 'application/json' }) });
  const long = await chat.uploadFile({ file: new File(['y'.repeat(20_001)], 'long.txt', { type: 'text/plain' }) });
  const zip = await chat.uploadFile({ file: new File([new Uint8Array([0])], 'a.zip', { type: 'application/zip' }) });

  assert.equal(image.fileUrl, 'data:image/png;base64,AQI=');
  assert.equal(image.isImage, true);
  assert.equal(json.isImage, false);

  await collect(chat, [
    { type: 'text', text: 'see files' },
    ...[image, json, long, zip].map(file => ({ type: 'file' as const, file })),
  ]);
  const content = requests[0]!.body.messages.at(-1)!.content as Array<{ type: string, text?: string, image_url?: { url: string } }>;
  assert.deepEqual(content[0], { type: 'text', text: 'see files' });
  assert.deepEqual(content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AQI=' } });
  assert.deepEqual(content[2], { type: 'text', text: '[添付ファイル: a.json]\n{"a":1}' });
  assert.equal(content[3]!.text, `[添付ファイル: long.txt]\n${'y'.repeat(20_000)}\n[添付ファイルの残りは省略されました]`);
  assert.deepEqual(content[4], { type: 'text', text: '[添付ファイル「a.zip」は、このAPI経路では読み取れない形式です]' });
});

test('a tool call is assembled from pieces, run without $explain, and answered before the reply', async t => {
  const calls: Array<{ name: string, args: Record<string, unknown>, meta: unknown }> = [];
  const tools: ToolSpec = {
    definitions: [{ type: 'function', function: { name: 'lookup' } }],
    execute: async (name, args, meta) => {
      calls.push({ name, args, meta });
      return [true, { found: 42 }];
    },
  };
  const requests = mockFetch(t,
    () => stream(
      delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'look', arguments: '{"q":"x",' } }] }),
      delta({ tool_calls: [{ index: 0, function: { name: 'up', arguments: '"$explain":"searching"}' } }] }),
      done,
    ),
    () => stream(delta({ content: 'answer' }), done),
  );
  const chat = new OpenAICompatChat(config, tools);
  const events: AIEvent[] = [];
  for await (const e of chat.sendMessage({ contents: [{ type: 'text', text: 'q' }], meta: 'ctx' })) events.push(e);

  assert.deepEqual(calls, [{ name: 'lookup', args: { q: 'x' }, meta: 'ctx' }]);
  assert.deepEqual(events.filter(e => e.type.startsWith('tool')), [
    { type: 'tool-call-detail', data: { name: 'lookup', description: 'searching', groupId: chat.id } },
    { type: 'tool-result', data: { name: 'lookup', ok: true, value: undefined } },
  ]);
  assert.ok(events.some(e => e.type === 'text-delta' && e.text === 'answer'));

  assert.deepEqual(requests[0]!.body.tools, tools.definitions);
  assert.deepEqual(requests[1]!.body.messages.slice(1), [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x","$explain":"searching"}' } }] },
    { role: 'tool', content: '{"found":42}', tool_call_id: 'call_1' },
  ]);
});

test('a tool call without an ID gets the same generated ID on both sides, and broken arguments run as empty', async t => {
  const seen: Array<Record<string, unknown>> = [];
  const tools: ToolSpec = { definitions: [{}], execute: async (_n, args) => { seen.push(args); return [false, { error: 'nope' }]; } };
  const requests = mockFetch(t,
    () => stream(delta({ tool_calls: [{ index: 0, function: { name: 'lookup', arguments: '{broken' } }] }), done),
    () => stream(delta({ content: 'ok' }), done),
  );
  const events = await say(new OpenAICompatChat(config, tools), 'q');

  assert.deepEqual(seen, [{}]);
  assert.ok(events.some(e => e.type === 'tool-result' && !e.data.ok && (e.data.value as { error: string }).error === 'nope'));
  const [assistant, tool] = requests[1]!.body.messages.slice(1);
  assert.match(assistant!.tool_calls![0].id, /^call_/);
  assert.equal(tool!.tool_call_id, assistant!.tool_calls![0].id);
});

test('without tools a tool call is answered with an error result', async t => {
  mockFetch(t,
    () => stream(delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'x', arguments: '{}' } }] }), done),
    () => stream(delta({ content: 'ok' }), done),
  );
  const events = await say(new OpenAICompatChat(config), 'q');
  assert.ok(events.some(e => e.type === 'tool-result' && (e.data.value as { error: string }).error === 'ツールが利用できません'));
});

test('a model that keeps calling tools is stopped after the round limit', async t => {
  const tools: ToolSpec = { definitions: [{}], execute: async () => [true, {}] };
  const requests = mockFetch(t, () => stream(delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'x', arguments: '{}' } }] }), done));
  const chat = new OpenAICompatChat(config, tools);
  const events = await say(chat, 'q');
  assert.equal(requests.length, 11);
  assert.deepEqual(events.at(-1), { type: 'error', code: 'loop', message: 'ツールの実行回数上限を超えました', trace: { id: '-', url: '-' }, threadId: chat.id });
});

test('fork copies the system prompt and history, and the two chats continue separately', async t => {
  const requests = mockFetch(t, () => stream(delta({ content: 'reply' }), done));
  const chat = new OpenAICompatChat(config);
  chat.setSystemPrompt('be nice');
  await say(chat, 'one');

  const forked = await chat.fork();
  assert.notEqual(forked.id, chat.id);
  await say(forked, 'in thread');
  await say(chat, 'in channel');

  const base = [
    { role: 'system', content: 'be nice' },
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'reply' },
  ];
  assert.deepEqual(requests[1]!.body.messages, [...base, { role: 'user', content: 'in thread' }]);
  assert.deepEqual(requests[2]!.body.messages, [...base, { role: 'user', content: 'in channel' }]);
});
