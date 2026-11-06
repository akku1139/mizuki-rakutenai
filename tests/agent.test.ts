// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAgent } from '../src/ai/agent.ts';
import { OpenAICompatChat } from '../src/ai/openai.ts';
import type { ChatSession, AIEvent } from '../src/ai/types.ts';

const cfg = { baseUrl: 'https://llm.invalid/v1', apiKey: 'test', model: 'test', contextWindowTokens: 128000 };
const sse = (chunks: object[]) => new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
const text = (content: string, finish_reason = 'stop') => ({ choices: [{ delta: { content }, finish_reason }] });

test('ツール往復の全使用量を合計し、次の生成前に新着を注入する', async t => {
  const requests: Array<{ messages: Array<{ role: string, content: unknown }> }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return sse(requests.length === 1 ? [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call1', function: { name: 'test', arguments: '{}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } },
    ] : [text('done'), { choices: [], usage: { prompt_tokens: 15, completion_tokens: 5 } }]);
  });
  const chat = new OpenAICompatChat(cfg, { definitions: [], execute: async () => [true, 'ok'] });
  const result = await runAgent(chat, [{ type: 'text', text: 'hello' }], undefined, {
    beforeRequest: async () => [{ type: 'text', text: '新しい依頼' }],
  });
  assert.deepEqual(result.usage, { inputTokens: 25, outputTokens: 8, cachedInputTokens: 4 });
  assert.equal(requests[1].messages.at(-2)?.role, 'tool');
  assert.deepEqual(requests[1].messages.at(-1), { role: 'user', content: [{ type: 'text', text: '新しい依頼' }] });
});

test('length終了だけを自動継続し、通常終了で止める', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => sse([text(++requests === 1 ? '前半' : '後半', requests === 1 ? 'length' : 'stop')]));
  const result = await runAgent(new OpenAICompatChat(cfg), [{ type: 'text', text: 'q' }], undefined);
  assert.equal(result.text, '前半後半');
  assert.equal(requests, 2);
});

test('自動継続は3回で止まり、無限に生成しない', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return sse([text('x', 'length')]); });
  const result = await runAgent(new OpenAICompatChat(cfg), [{ type: 'text', text: 'q' }], undefined);
  assert.equal(result.text, 'xxxx');
  assert.equal(requests, 4);
});

test('本文の自動継続上限と関係なくツールは12ラウンド以上往復できる', async t => {
  let requests = 0, executed = 0;
  t.mock.method(globalThis, 'fetch', async () => sse(++requests <= 12
    ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${requests}`, function: { name: 'test', arguments: requests === 1 ? 'null' : '{}' } }] } }] }]
    : [text('finished')]));
  const chat = new OpenAICompatChat(cfg, { definitions: [], execute: async (_name, args) => { assert.deepEqual(args, {}); executed++; return [true, 'ok']; } });
  const result = await runAgent(chat, [{ type: 'text', text: 'q' }], undefined);
  assert.equal(executed, 12);
  assert.equal(result.text, 'finished');
});

const stalled = (): ChatSession => ({
  label: 'stalled', id: 'stalled', uploadFile: async () => { throw new Error('unused'); },
  async *sendMessage(): AsyncGenerator<AIEvent> { await new Promise(() => {}); },
});

test('停止したストリームを待たずにキャンセルできる', async () => {
  const controller = new AbortController();
  const pending = runAgent(stalled(), [], undefined, { signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
});

test('無進捗のタイムアウトはエラーとして返る', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await runAgent(stalled(), [], undefined, { idleTimeoutMs: 10 });
    assert.equal(result.aborted, true);
    assert.equal(result.error?.code, 'timeout');
  } finally { clearTimeout(keepAlive); }
});
