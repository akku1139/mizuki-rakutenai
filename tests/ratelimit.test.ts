import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchWithRateLimitRetry, retryAfterMs } from '../src/ai/ratelimit.ts';
import { OpenAICompatChat } from '../src/ai/openai.ts';

test('Retry-After: seconds, dates and invalid values', () => {
  assert.equal(retryAfterMs('1.5', 0), 1500);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:03 GMT', 1000), 2000);
  assert.equal(retryAfterMs(null, 0), undefined);
  assert.equal(retryAfterMs('invalid', 0), undefined);
  assert.equal(retryAfterMs('-1', 0), undefined);
});

test('429 backs off with jitter, then returns success', async () => {
  const waits: number[] = [];
  let calls = 0;
  const response = await fetchWithRateLimitRetry(async () => {
    return ++calls < 4 ? new Response('busy', { status: 429 }) : new Response('ok');
  }, { sleep: async ms => { waits.push(ms); }, random: () => 0.5 });
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(waits, [1500, 2500, 4500]);
});

test('retry count is bounded and final response remains readable', async () => {
  let calls = 0;
  const response = await fetchWithRateLimitRetry(async () => {
    calls++;
    return new Response('busy', { status: 429, headers: { 'Retry-After': '0' } });
  }, { sleep: async () => {} });
  assert.equal(calls, 4);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), 'busy');
});

test('server cooldown takes priority; long delays and quota errors are not retried', async () => {
  const waits: number[] = [];
  let calls = 0;
  await fetchWithRateLimitRetry(async () => ++calls === 1
    ? new Response('busy', { status: 429, headers: { 'Retry-After': '2' } })
    : new Response('ok'), { sleep: async ms => { waits.push(ms); } });
  assert.deepEqual(waits, [2000]);
  for (const response of [
    new Response('busy', { status: 429, headers: { 'Retry-After': '61' } }),
    Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }),
    Response.json({ error: { type: 'billing_hard_limit_reached' } }, { status: 429 }),
    new Response('unauthorized', { status: 401 }),
    new Response('unavailable', { status: 503 }),
  ]) {
    let requests = 0;
    const result = await fetchWithRateLimitRetry(async () => { requests++; return response; });
    assert.equal(requests, 1);
    assert.equal(result, response);
    assert.ok(await result.text());
  }
});

test('network failures are not retried', async () => {
  let calls = 0;
  await assert.rejects(fetchWithRateLimitRetry(async () => {
    calls++;
    throw new Error('network');
  }), /network/);
  assert.equal(calls, 1);
});

test('a successful response with a broken stream is not replayed', async () => {
  let calls = 0;
  const response = await fetchWithRateLimitRetry(async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) { controller.error(new Error('stream disconnected')); },
    }));
  });
  await assert.rejects(response.text(), /stream disconnected/);
  assert.equal(calls, 1);
});

test('429 during tool follow-up retries the same request without executing the tool twice', async t => {
  const bodies: string[] = [];
  let executions = 0;
  const sse = (delta: object) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    if (bodies.length === 1) return sse({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '{}' } }] });
    if (bodies.length === 2) return new Response('busy', { status: 429, headers: { 'Retry-After': '0' } });
    return sse({ content: 'finished' });
  });
  const chat = new OpenAICompatChat({ baseUrl: 'https://unused.invalid/v1', apiKey: 'test', model: 'test' }, {
    definitions: [{ type: 'function', function: { name: 'lookup' } }],
    execute: async () => { executions++; return [true, { result: 'found' }]; },
  });
  const events = [];
  for await (const event of chat.sendMessage({ contents: [{ type: 'text', text: 'hello' }] })) events.push(event);
  assert.equal(executions, 1);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[1], bodies[2]);
  assert.equal(events.filter(e => e.type === 'tool-call-detail').length, 1);
  assert.ok(events.some(e => e.type === 'text-delta' && e.text === 'finished'));
});
