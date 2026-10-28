// SPDX-License-Identifier: AGPL-3.0-or-later

// ツール呼び出しを含む会話履歴が、次のリクエストで通用する形のまま残るかを見る。
//
// 壊れた履歴は OpenAI 互換 API では 400 になり、`src/ai/mod.ts` はエラーイベントで
// セッションを捨てる (`chatStore.delete`)。つまり「ツール呼び出しが次から消える」と
// 「会話がリセットされる」は同じ現象の裏表になりうる。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatChat } from '../src/ai/openai.ts';
import type { ToolSpec } from '../src/ai/types.ts';

type Message = { role: string, content?: unknown, tool_calls?: Array<{ id: string }>, tool_call_id?: string, [k: string]: unknown };
type Body = { messages: Message[] };

const config = { baseUrl: 'https://llm.invalid/v1', apiKey: 'secret', model: 'test-model' };

const stream = (...pieces: string[]) => new Response(new ReadableStream({
  start(controller) {
    for (const p of pieces) controller.enqueue(new TextEncoder().encode(p));
    controller.close();
  },
}));
const data = (chunk: object) => `data: ${JSON.stringify(chunk)}\n\n`;
const delta = (d: object) => data({ choices: [{ delta: d }] });
const done = 'data: [DONE]\n\n';
const toolCall = (id: string, name = 'lookup') =>
  delta({ tool_calls: [{ index: 0, id, function: { name, arguments: '{}' } }] });

/** リクエストを記録し、n 回目の呼び出しに responses[n-1] を返す (足りなければ最後を使い回す)。 */
const mockFetch = (t: { mock: { method: Function } }, ...responses: Array<() => Response>) => {
  const bodies: Body[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Body);
    return responses[Math.min(bodies.length, responses.length) - 1]!();
  });
  return bodies;
};

const tools = (execute: ToolSpec['execute']): ToolSpec => ({
  definitions: [{ type: 'function', function: { name: 'lookup' } }],
  execute,
});

const say = async (chat: OpenAICompatChat, text: string, onError?: (error: unknown) => void) => {
  try {
    for await (const _event of chat.sendMessage({ contents: [{ type: 'text', text }] })) { /* drain */ }
  } catch (error) {
    onError?.(error);
  }
};

/** 引用の対応が取れている (= プロバイダに 400 を食らわない) 履歴か。 */
const assertToolExchangesAreComplete = (messages: Message[]) => {
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      const answer = messages.slice(index + 1).find(m => m.role === 'tool' && m.tool_call_id === call.id);
      assert.ok(answer, `assistant のツール呼び出し ${call.id} に対する tool メッセージが無い`);
      assert.equal(typeof answer.content, 'string', `tool メッセージ ${call.id} の content が文字列でない`);
    }
  }
};

test('対照: 普通のツール呼び出しは次のターンにも残る', async t => {
  const bodies = mockFetch(t,
    () => stream(toolCall('call_1'), done),
    () => stream(delta({ content: 'answer' }), done),
    () => stream(delta({ content: 'next' }), done),
  );
  const chat = new OpenAICompatChat(config, tools(async () => [true, { found: 42 }]));

  await say(chat, 'turn1');
  assertToolExchangesAreComplete(bodies[1]!.messages); // 同じターンの再生成
  await say(chat, 'turn2');
  assertToolExchangesAreComplete(bodies[2]!.messages);
  assert.ok(bodies[2]!.messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_1'));
});

test('ツールが例外を投げても、履歴には対応の取れた tool メッセージが残る', async t => {
  const bodies = mockFetch(t,
    () => stream(toolCall('call_1'), done),
    () => stream(delta({ content: 'recovered' }), done),
    () => stream(delta({ content: 'next' }), done),
  );
  const chat = new OpenAICompatChat(config, tools(async () => { throw new Error('tool exploded'); }));

  let thrown: unknown;
  await say(chat, 'turn1', error => { thrown = error; });
  await say(chat, 'turn2');

  assertToolExchangesAreComplete(bodies.at(-1)!.messages);
  assert.ok(thrown || bodies.at(-1)!.messages.some(m => m.role === 'tool'), '例外が外に漏れ、tool メッセージも無い');
});

test('ツールが undefined を返しても、tool メッセージには content が入る', async t => {
  const bodies = mockFetch(t,
    () => stream(toolCall('call_1', 'noop'), done),
    () => stream(delta({ content: 'ok' }), done),
  );
  const chat = new OpenAICompatChat(config, tools(async () => [true, undefined]));

  await say(chat, 'turn1');
  assertToolExchangesAreComplete(bodies[1]!.messages);
});

test('ツールを呼んだターンが空の返答で終わっても、ツール呼び出しは次のターンに残る', async t => {
  const bodies = mockFetch(t,
    () => stream(toolCall('call_1'), done),
    () => stream(done),                        // 最終応答が空 (本文もツール呼び出しも無い)
    () => stream(delta({ content: 'next' }), done),
  );
  const chat = new OpenAICompatChat(config, tools(async () => [true, { found: 42 }]));

  await say(chat, 'turn1');
  await say(chat, 'turn2');
  const messages = bodies.at(-1)!.messages;
  assert.ok(messages.some(m => m.role === 'tool' && m.tool_call_id === 'call_1'), 'ツール呼び出しが履歴ごと消えている');
  assertToolExchangesAreComplete(messages);
});

test('思考過程を返さないモデルには reasoning 系フィールドを送らない', async t => {
  const bodies = mockFetch(t,
    () => stream(delta({ content: 'plain answer' }), done),
    () => stream(delta({ content: 'next' }), done),
  );
  // 既定の OPENAI_BASE_URL 相当。reasoning を解釈しないプロバイダでは未知のフィールドになる
  const chat = new OpenAICompatChat({ ...config, baseUrl: 'https://api.openai.com/v1' });
  await say(chat, 'a');
  await say(chat, 'b');

  const assistant = bodies[1]!.messages.find(m => m.role === 'assistant')!;
  assert.equal(assistant.reasoning_content, undefined, 'reasoning_content が空文字で送られている');
  assert.equal(assistant.reasoning, undefined, 'reasoning が空文字で送られている');
});

test('思考過程を返すモデルでは、そのターンの思考過程だけを再送する', async t => {
  const bodies = mockFetch(t,
    () => stream(delta({ reasoning_content: '考えた' }), delta({ content: 'a1' }), done),
    () => stream(delta({ content: 'a2' }), done),
    () => stream(delta({ content: 'a3' }), done),
  );
  const chat = new OpenAICompatChat(config);
  await say(chat, 'q1');
  await say(chat, 'q2');
  await say(chat, 'q3');

  const assistants = bodies[2]!.messages.filter(m => m.role === 'assistant');
  assert.equal(assistants[0]!.reasoning_content, '考えた');
  assert.equal(assistants[1]!.reasoning_content, undefined, '思考過程の無かったターンはフィールドごと省く');
});

/** 1ターンで rounds 回ツールを呼んでから答えるモデルを模す。 */
const heavyTurn = (
  t: { mock: { method: Function } },
  rounds: number,
  record: (body: Body) => void,
) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    record(body);
    calls = body.messages.at(-1)!.role === 'user' ? 1 : calls + 1;
    return calls <= rounds
      ? stream(toolCall(`call_${calls}`, 'search_messages'), done)
      : stream(delta({ content: `answer ${calls}` }), done);
  });
};

test('ツールを大量に呼んだターンでも、前のターンは履歴に残る', async t => {
  const bodies: Body[] = [];
  // 2026-10-28 の本番ログと同じ 40 回 (search_messages 27 + Notion 12 + fetch_messages_history 1)
  heavyTurn(t, 40, body => bodies.push(body));
  const chat = new OpenAICompatChat(config, {
    definitions: [{ type: 'function', function: { name: 'search_messages' } }],
    execute: async () => [true, { rows: 'x'.repeat(2000) }],
  });

  await say(chat, 'turn1');
  await say(chat, 'turn2');

  const messages = bodies.at(-1)!.messages;
  assert.ok(messages.length > 1, `2ターン目の履歴が ${messages.length} 件しかない`);
  assert.ok(messages.some(m => m.role === 'user' && m.content === 'turn1'), '前のターンの発言が消えている');
  assertToolExchangesAreComplete(messages);
});
