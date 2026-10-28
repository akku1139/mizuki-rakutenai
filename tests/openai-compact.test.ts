// SPDX-License-Identifier: AGPL-3.0-or-later

// コンテキストの auto-compact。コンテキストウィンドウの 75% を使ったら、
// 古い方を要約 1 通に置き換え、直近は生のまま残す。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatChat } from '../src/ai/openai.ts';
import type { AIEvent, ToolSpec } from '../src/ai/types.ts';

type Message = { role: string, content?: unknown, tool_calls?: Array<{ id: string }>, tool_call_id?: string };
type Body = { stream?: boolean, messages: Message[], tools?: unknown };

const stream = (text: string) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    controller.close();
  },
}));

// SDK は content-type が JSON でないと本文をパースしないので、ヘッダーまで付ける
const completion = (text: string) => new Response(JSON.stringify({
  id: 'x', object: 'chat.completion', created: 0, model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
}), { headers: { 'content-type': 'application/json' } });

/** 記録しつつ、stream:false の要約リクエストには summary を返す。 */
const mockFetch = (t: { mock: { method: Function } }, reply: string, summary?: (body: Body) => string) => {
  const bodies: Body[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push(body);
    if (body.stream === false) return completion(summary?.(body) ?? '## 依頼と意図\n- 要約された本文');
    return stream(reply);
  });
  return bodies;
};

const big = (n: number) => 'あ'.repeat(n) // 1.2 トークン/文字

test('コンテキストが予算 (75%) を超えたら要約に置き換わる', async t => {
  const bodies = mockFetch(t, 'ok');
  // 窓 1,000 トークン → 予算 750。1 メッセージ 400 文字 ≒ 480 トークン
  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', contextWindowTokens: 1_000 });
  chat.setSystemPrompt('sys');

  await chat.sendMessage({ contents: [{ type: 'text', text: big(400) }] }).next();
  const beforeCompact = bodies.length;
  await chat.sendMessage({ contents: [{ type: 'text', text: big(400) }] }).next();

  const summarize = bodies.filter(b => b.stream === false);
  assert.equal(summarize.length, 1, '要約リクエストが 1 回だけ出る');
  const sent = bodies.at(-1)!;
  assert.equal(sent.stream, true, '最後は通常のストリーミング');
  const firstHistory = sent.messages.find(m => String(m.content).includes('要約されました') || m.role !== 'system');
  assert.match(String(firstHistory!.content), /要約されました/, '要約が履歴の先頭に入る');
  assert.ok(bodies.length > beforeCompact);
  // 履歴は要約 + 直近だけに縮む
  assert.ok(sent.messages.length <= 3, `履歴が縮んでいない: ${sent.messages.length}`);
});

test('予算に届いていなければ要約しない', async t => {
  const bodies = mockFetch(t, 'ok');
  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', contextWindowTokens: 1_000_000 });
  await chat.sendMessage({ contents: [{ type: 'text', text: big(400) }] }).next();
  await chat.sendMessage({ contents: [{ type: 'text', text: big(400) }] }).next();
  assert.equal(bodies.filter(b => b.stream === false).length, 0);
});

test('要約リクエストには system プロンプトと古い履歴が渡り、ツールは渡らない', async t => {
  const bodies = mockFetch(t, 'ok');
  const tools: ToolSpec = {
    definitions: [{ type: 'function', function: { name: 'lookup' } }],
    execute: async () => [true, {}],
  };
  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', contextWindowTokens: 1_000 }, tools);
  chat.setSystemPrompt('sys');
  for (let i = 0; i < 3; i++) await chat.sendMessage({ contents: [{ type: 'text', text: big(400) }] }).next();

  const summarize = bodies.find(b => b.stream === false);
  assert.ok(summarize, '要約リクエストが無い');
  assert.equal(summarize!.tools, undefined);
  assert.deepEqual(summarize!.messages[0], { role: 'system', content: 'sys' });
  assert.match(String(summarize!.messages.at(-1)!.content), /圧縮する係/);
});

test('要約に失敗したら古い方を捨てて、リクエストは通す', async t => {
  const bodies: Body[] = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push(body);
    calls++;
    if (body.stream === false) return new Response('boom', { status: 500 });
    return stream('ok');
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', contextWindowTokens: 1_000 });
  chat.setSystemPrompt('sys');

  const events: AIEvent[] = [];
  for (let i = 0; i < 3; i++) {
    for await (const event of chat.sendMessage({ contents: [{ type: 'text', text: big(400) }] })) events.push(event);
    if (i === 2) break;
  }
  const sent = bodies.filter(b => b.stream === true).at(-1)!;
  assert.match(String(sent.messages[1]!.content), /破棄されました/);
  assert.ok(!events.some(e => e.type === 'error'), 'compact の失敗で会話を壊さない');
  assert.ok(calls >= 2);
});

test('要約が続けて失敗したら、自動 compact を諦める', async t => {
  const bodies: Body[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push(body);
    return body.stream === false ? new Response('boom', { status: 500 }) : stream('ok');
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', contextWindowTokens: 1_000 });
  for (let i = 0; i < 8; i++) await chat.sendMessage({ contents: [{ type: 'text', text: big(400) }] }).next();

  // 要約の試行は 3 回まで (MAX_COMPACT_FAILURES)、そのあとは呼ばない
  assert.equal(bodies.filter(b => b.stream === false).length, 3);
});

test('compact は tool 呼び出しとその結果の対応を割らない', async t => {
  const bodies: Body[] = [];
  let n = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push(body);
    if (body.stream === false) return completion('## 要約\n- ツールを使った');
    // ツールの結果を受け取った直後だけ本文を返す (それ以外はツールを呼ぶ)
    if (body.messages.at(-1)!.role === 'tool') return stream('ok');
    n++;
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${n}`, function: { name: 'lookup', arguments: JSON.stringify({ q: big(200) }) } }] } }] })}\n\ndata: [DONE]\n\n`);
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', contextWindowTokens: 1_000 }, {
    definitions: [{ type: 'function', function: { name: 'lookup' } }],
    execute: async () => [true, { result: big(200) }],
  });

  for (let i = 0; i < 4; i++) {
    for await (const _event of chat.sendMessage({ contents: [{ type: 'text', text: big(200) }] })) { /* drain */ }
  }

  for (const body of bodies) {
    for (const [index, message] of body.messages.entries()) {
      if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
      for (const call of message.tool_calls) {
        const answer = body.messages.slice(index + 1).find(m => m.role === 'tool' && m.tool_call_id === call.id);
        assert.ok(answer, `要約リクエストで tool ${call.id} の応答が消えている`);
      }
    }
  }
});
