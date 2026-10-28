import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatChat } from '../src/ai/openai.ts';

type Body = { messages: Array<{ role: string, content: unknown }> };

const sse = (delta: object) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
const toolCall = () => sse({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{}' } }] });
const tools = {
  definitions: [{ type: 'function', function: { name: 'lookup' } }],
  execute: async () => [true, { result: 'found' }] as [true, unknown],
};
const say = async (chat: OpenAICompatChat, text: string) => {
  for await (const _event of chat.sendMessage({ contents: [{ type: 'text', text }] })) { /* drain */ }
};

test('a heavy tool turn keeps the previous one in the history', async t => {
  const bodies: Body[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? toolCall() : sse({ content: 'ok' });
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://unused.invalid/v1', apiKey: 'test', model: 'test' }, tools);
  for (let i = 0; i < 45; i++) await say(chat, `turn ${i}`);
  assert.ok(bodies.at(-1)!.messages.some(m => m.content === 'turn 0'), '古いターンが消えている');
});

test('an empty reply after a tool call keeps the tool exchange', async t => {
  const bodies: Body[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length === 1) return toolCall();
    if (bodies.length === 2) return sse({}); // 空応答
    return sse({ content: 'ok' });
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://unused.invalid/v1', apiKey: 'test', model: 'test' }, tools);
  await say(chat, 'first');
  await say(chat, 'second');
  // ツールを実行したターンは残す (消すと次のリクエストで「何を調べたか」を失う)
  assert.deepEqual(bodies[2]?.messages.slice(0, 3), [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', content: '{"result":"found"}', tool_call_id: 'call_1' },
  ]);
  assert.deepEqual(bodies[2]?.messages.at(-1), { role: 'user', content: 'second' });
});

test('an empty reply with no tool call still rolls the turn back', async t => {
  const bodies: Body[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return bodies.length === 1 ? sse({}) : sse({ content: 'ok' });
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://unused.invalid/v1', apiKey: 'test', model: 'test' }, tools);
  await say(chat, 'first');
  await say(chat, 'second');
  assert.deepEqual(bodies[1]?.messages, [{ role: 'user', content: 'second' }]);
});
