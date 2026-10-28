// SPDX-License-Identifier: AGPL-3.0-or-later

// コンテキストの auto-compact。コンテキストウィンドウの 75% を使ったら、
// 古い方を要約 1 通に置き換え、直近は生のまま残す。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatChat } from '../src/ai/openai.ts';
import { resetModelMetaCache } from '../src/ai/model-meta.ts';
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

test('要約が続けて失敗しても、捨ててでも予算に収める', async t => {
  resetModelMetaCache();
  const bodies: Body[] = [];
  let rounds = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === 'https://models.dev/api.json') return new Response('{}', { headers: { 'content-type': 'application/json' } });
    if (target.endsWith('/models')) return new Response('nope', { status: 404 });
    const body = JSON.parse(String(init!.body)) as Body;
    bodies.push(body);
    if (body.stream === false) return new Response('boom', { status: 500 }); // 要約は常に失敗
    if (body.messages.at(-1)!.role === 'tool') rounds++;
    if (rounds >= 12) return stream('done');
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${rounds}`, function: { name: 'custom_tool', arguments: '{}' } }] } }] })}\n\ndata: [DONE]\n\n`);
  });
  // 削れないツール (PRUNABLE_TOOLS でも mcp__ でもない) なので、捨てるしかない
  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', contextWindowTokens: 1_000 }, {
    definitions: [{ type: 'function', function: { name: 'custom_tool' } }],
    execute: async () => [true, { rows: 'あ'.repeat(1_000) }],   // 1 往復 ≒ 1,200 トークン
  });
  for await (const _event of chat.sendMessage({ contents: [{ type: 'text', text: 'q' }] })) { /* drain */ }

  const summarizeCalls = bodies.filter(b => b.stream === false).length;
  // 要約の試行は 3 回まで (1 回につき縮めて 1 回やり直すので最大 6 回) で止める
  assert.ok(summarizeCalls <= 6, `要約を試しすぎている: ${summarizeCalls}`);
  // それでも捨てて縮め続ける (諦めると 1 ターンで窓を超えて 400 になる)
  assert.ok(bodies.some(b => JSON.stringify(b.messages).includes('破棄されました')), '破棄して縮めていない');
  const largest = Math.max(...bodies.filter(b => b.stream !== false).map(b => JSON.stringify(b.messages).length));
  assert.ok(largest < 20_000, `履歴が伸び続けている: ${largest} 文字`);
});

test('1 つのツール出力は履歴に積む時点で切り詰める', async t => {
  resetModelMetaCache();
  const bodies: Body[] = [];
  let rounds = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === 'https://models.dev/api.json') return new Response('{}', { headers: { 'content-type': 'application/json' } });
    if (target.endsWith('/models')) return new Response('nope', { status: 404 });
    const body = JSON.parse(String(init!.body)) as Body;
    bodies.push(body);
    if (body.stream === false) return completion('- 要約');
    if (body.messages.at(-1)!.role === 'tool') rounds++;
    if (rounds >= 1) return stream('done');
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 's', arguments: '{}' } }] } }] })}\n\ndata: [DONE]\n\n`);
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', contextWindowTokens: 10_000_000 }, {
    definitions: [{ type: 'function', function: { name: 's' } }],
    execute: async () => [true, { rows: 'あ'.repeat(200_000) }],
  });
  for await (const _event of chat.sendMessage({ contents: [{ type: 'text', text: 'q' }] })) { /* drain */ }

  const tool = bodies.at(-1)!.messages.find(m => m.role === 'tool')!;
  assert.ok(String(tool.content).length < 51_000, `切り詰めていない: ${String(tool.content).length} 文字`);
  assert.match(String(tool.content), /省略しました/);
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

test('コンテキストウィンドウはモデルカタログから引く (1M のモデルを 96k で compact しない)', async t => {
  resetModelMetaCache();
  const bodies: Body[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url) === 'https://models.dev/api.json') {
      return new Response(JSON.stringify({ openrouter: { id: 'openrouter', api: 'https://openrouter.ai/api/v1', models: {} } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/models')) {
      // プロバイダは 1M と答えている (models.dev には無いモデル)
      return new Response(JSON.stringify({ data: [{ id: 'test-model', context_length: 1_000_000 }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = JSON.parse(String(init!.body)) as Body;
    bodies.push(body);
    if (body.stream === false) return completion('- 要約');
    // 200k トークン相当 (日本語 400 文字 x 60 往復) まで積む
    return body.messages.length >= 120
      ? stream('done')
      : new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${body.messages.length}`, function: { name: 's', arguments: '{}' } }] } }] })}\n\ndata: [DONE]\n\n`);
  });

  const chat = new OpenAICompatChat({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'test-model' }, {
    definitions: [{ type: 'function', function: { name: 's' } }],
    execute: async () => [true, { rows: 'あ'.repeat(1000) }],   // 1 往復 ≒ 1,200 トークン
  });
  for await (const _event of chat.sendMessage({ contents: [{ type: 'text', text: 'q' }] })) { /* drain */ }

  const compactions = bodies.filter(b => b.stream === false);
  const largest = Math.max(...bodies.filter(b => b.stream !== false).map(b => JSON.stringify(b.messages).length));
  assert.equal(compactions.length, 0, `約 ${Math.round(largest / 2.5)} トークンで compact している (1M のモデルなので不要)`);
});

test('カタログに無ければ既定の 128k で compact する', async t => {
  resetModelMetaCache();
  const bodies: Body[] = [];
  let rounds = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url) === 'https://models.dev/api.json') return new Response('{}', { headers: { 'content-type': 'application/json' } });
    if (String(url).endsWith('/models')) return new Response('nope', { status: 404 });
    const body = JSON.parse(String(init!.body)) as Body;
    bodies.push(body);
    if (body.stream === false) return completion('- 要約');
    if (body.messages.at(-1)!.role === 'tool') rounds++;
    if (rounds >= 20) return stream('done');
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${rounds}`, function: { name: 'custom_tool', arguments: '{}' } }] } }] })}\n\ndata: [DONE]\n\n`);
  });

  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'unknown-model' }, {
    definitions: [{ type: 'function', function: { name: 's' } }],
    execute: async () => [true, { rows: 'あ'.repeat(20_000) }],   // 1 往復 ≒ 24,000 トークン
  });
  for await (const _event of chat.sendMessage({ contents: [{ type: 'text', text: 'q' }] })) { /* drain */ }

  assert.ok(bodies.some(b => b.stream === false), '既定の窓で compact していない');
});

test('古いツール出力は要約の前に削られ、直近は残る (teapot の maybePrune)', async t => {
  resetModelMetaCache();
  const bodies: Body[] = [];
  let rounds = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === 'https://models.dev/api.json') return new Response('{}', { headers: { 'content-type': 'application/json' } });
    if (target.endsWith('/models')) return new Response('nope', { status: 404 });
    const body = JSON.parse(String(init!.body)) as Body;
    bodies.push(body);
    if (body.stream === false) return completion('- 要約');
    if (body.messages.at(-1)!.role === 'tool') rounds++;
    if (rounds >= 4) return stream('done');
    // 1 ラウンドで 10 本並列に呼ぶ (本番の notion 連打と同じ形)
    const calls = Array.from({ length: 10 }, (_, i) => ({ index: i, id: `c${rounds}_${i}`, function: { name: 'fetch_messages_history', arguments: '{}' } }));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}\n\ndata: [DONE]\n\n`);
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', contextWindowTokens: 200_000 }, {
    definitions: [{ type: 'function', function: { name: 'fetch_messages_history' } }],
    execute: async () => [true, { rows: 'あ'.repeat(20_000) }],   // 1 本 ≒ 24,000 トークン
  });
  for await (const _event of chat.sendMessage({ contents: [{ type: 'text', text: 'q' }] })) { /* drain */ }

  const last = bodies.at(-1)!;
  const pruned = last.messages.filter(m => typeof m.content === 'string' && m.content.includes('pruned'));
  assert.ok(pruned.length > 0, '古いツール出力を削っていない');
  // 削ったものは頭 400 文字 + 注記だけになる
  for (const message of pruned) assert.ok(String(message.content).length < 1_000);
  // 削っても、ツール呼び出しと結果の対応は保たれている
  for (const message of last.messages) {
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      assert.ok(last.messages.some(m => m.role === 'tool' && m.tool_call_id === call.id));
    }
  }
  // 削るだけで予算に収まるなら、要約は呼ばない (余計な API 呼び出しをしない)
  assert.equal(bodies.filter(b => b.stream === false).length, 0);
  // 予算 (150,000 トークン) を超えていない
  const largest = Math.max(...bodies.filter(b => b.stream !== false).map(b => JSON.stringify(b.messages).length));
  assert.ok(largest < 150_000 * 1.2, `履歴が予算を超えている: ${largest} 文字`);
});

test('削っても収まらないときは、保護範囲も削ってから要約する', async t => {
  resetModelMetaCache();
  const bodies: Body[] = [];
  let rounds = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === 'https://models.dev/api.json') return new Response('{}', { headers: { 'content-type': 'application/json' } });
    if (target.endsWith('/models')) return new Response('nope', { status: 404 });
    const body = JSON.parse(String(init!.body)) as Body;
    bodies.push(body);
    if (body.stream === false) return completion('- 要約');
    if (body.messages.at(-1)!.role === 'tool') rounds++;
    if (rounds >= 6) return stream('done');
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${rounds}`, function: { name: 'fetch_messages_history', arguments: '{}' } }] } }] })}\n\ndata: [DONE]\n\n`);
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', contextWindowTokens: 100_000 }, {
    definitions: [{ type: 'function', function: { name: 'fetch_messages_history' } }],
    execute: async () => [true, { rows: 'あ'.repeat(20_000) }],   // 予算 75,000 に対して 1 本 24,000 トークン
  });
  for await (const _event of chat.sendMessage({ contents: [{ type: 'text', text: 'q' }] })) { /* drain */ }

  assert.ok(bodies.some(b => b.stream === false), '要約に進んでいない');
  const largest = Math.max(...bodies.filter(b => b.stream !== false).map(b => JSON.stringify(b.messages).length));
  assert.ok(largest < 100_000, `履歴が伸び続けている: ${largest} 文字`);
});

test('要約できないときは、古い方から全体の 1/3 を捨てる (全部は消さない)', async t => {
  resetModelMetaCache();
  const requests: Body[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === 'https://models.dev/api.json') return new Response('{}', { headers: { 'content-type': 'application/json' } });
    if (target.endsWith('/models')) return new Response('nope', { status: 404 });
    const body = JSON.parse(String(init!.body)) as Body;
    requests.push(body);
    if (body.stream === false) return new Response('boom', { status: 500 }); // 要約は必ず失敗
    return stream('ok');
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://llm.invalid/v1', apiKey: 'k', model: 'm', contextWindowTokens: 10_000 });

  // 1 通 ≒ 600 トークン。予算 7,500 なので 13 往復目で超える
  for (let i = 0; i < 16; i++) {
    for await (const _event of chat.sendMessage({ contents: [{ type: 'text', text: `m${i} ` + 'あ'.repeat(500) }] })) { /* drain */ }
  }

  const dropped = requests.filter(b => JSON.stringify(b.messages).includes('破棄されました'));
  assert.ok(dropped.length > 0, '破棄して縮めていない');
  const userLines = dropped[0]!.messages.filter(m => typeof m.content === 'string' && /^m\d+ /.test(m.content));
  assert.ok(userLines.length > 4, `捨てすぎている: ${userLines.length} 件しか残っていない`);
  // 捨てた直後も、直近の会話は続いている (全部消して作り直しにはしない)
  const last = requests.at(-1)!;
  assert.ok(last.messages.some(m => String(m.content).startsWith('m15 ')), '直近が消えている');
  assert.ok(!last.messages.some(m => String(m.content).startsWith('m0 ')), '最も古いものが残っている');
  const kept = last.messages.filter(m => typeof m.content === 'string' && /^m\d+ /.test(m.content));
  assert.ok(kept.length >= 4, `残りすぎ/捨てすぎ: ${kept.length} 件`);
  // tool 呼び出しの対応は割らない
  for (const message of last.messages) {
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      assert.ok(last.messages.some(m => m.role === 'tool' && m.tool_call_id === call.id));
    }
  }
});
