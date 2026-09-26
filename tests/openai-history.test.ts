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

test('trimming the history never starts in the middle of a tool exchange', async t => {
  const bodies: Body[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    // 最初の発言だけツールを使い、履歴に assistant(tool_calls) と tool を積む
    return bodies.length === 1 ? toolCall() : sse({ content: 'ok' });
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://unused.invalid/v1', apiKey: 'test', model: 'test' }, tools);
  for (let i = 0; i < 45; i++) await say(chat, `turn ${i}`);
  for (const body of bodies) assert.equal(body.messages[0]?.role, 'user');
});

test('an empty reply after a tool call rolls back the whole turn', async t => {
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
  assert.deepEqual(bodies[2]?.messages, [{ role: 'user', content: 'second' }]);
});
