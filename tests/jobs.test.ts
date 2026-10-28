// SPDX-License-Identifier: AGPL-3.0-or-later

// バックグラウンドジョブ: Discord に何も送らずにエージェントループを回す。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancelJob, clearFinishedJobs, enqueueJob, getJob, jobSummary, listJobs, whenIdle } from '../src/jobs/mod.ts';

// OpenAI SDK は鍵が空だとクライアントを作る時点で落ちるので、テスト用の鍵を置く
process.env['OPENAI_API_KEY'] = 'test-key';

const sse = (...deltas: object[]) => new Response(
  deltas.map(d => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`).join('') + 'data: [DONE]\n\n',
);

/** ジョブの実行 (OpenAI 互換 API だけをモックする) */
const mockAgent = (t: { mock: { method: Function } }, respond: () => Response) => {
  const bodies: Array<{ messages: Array<{ role: string, content: unknown }> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (!target.endsWith('/chat/completions')) return new Response('{}', { headers: { 'content-type': 'application/json' } });
    bodies.push(JSON.parse(String(init!.body)));
    return respond();
  });
  return bodies;
};

test('agent ジョブは Discord に送らずに回り、結果と使用量が残る', async t => {
  const bodies = mockAgent(t, () => sse(
    { content: '調べた結果' },
    { content: 'です' },
  ));
  const job = enqueueJob({ type: 'agent', prompt: 'これを調べて', provider: 'openai' });
  assert.equal(job.status === 'queued' || job.status === 'running', true);
  await whenIdle();

  const done = getJob(job.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.result, '調べた結果です');
  assert.ok(done.startedAt !== undefined && done.finishedAt !== undefined);
  assert.ok(done.events.some(e => e.kind === 'log'));
  // 送ったのは指示文 (+ システムプロンプト) だけ
  const sent = bodies.at(-1)!.messages.map(m => String(m.content)).join('\n');
  assert.match(sent, /これを調べて/);
});

test('ツール呼び出しはイベントとして残る', async t => {
  let round = 0;
  mockAgent(t, () => {
    round++;
    return round === 1
      ? sse({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'wikipedia_search', arguments: JSON.stringify({ query: 'x', $explain: '調べる' }) } }] })
      : sse({ content: 'ok' });
  });
  const job = enqueueJob({ type: 'agent', prompt: 'q', provider: 'openai' });
  await whenIdle();
  const done = getJob(job.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.tools?.['wikipedia_search'], 1);
  assert.ok(done.events.some(e => e.kind === 'tool' && e.text.includes('wikipedia_search')));
});

test('API エラーは status=error とメッセージになる', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (String(url).endsWith('/chat/completions')) return new Response('boom', { status: 500 });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  const job = enqueueJob({ type: 'agent', prompt: 'q', provider: 'openai' });
  await whenIdle();
  const failed = getJob(job.id)!;
  assert.equal(failed.status, 'error');
  assert.match(String(failed.error), /500/);
});

test('指示もチャンネルも無いジョブはエラーになる', async () => {
  const job = enqueueJob({ type: 'agent', provider: 'openai' });
  await whenIdle();
  const failed = getJob(job.id)!;
  assert.equal(failed.status, 'error');
  assert.match(String(failed.error), /prompt/);
});

test('実行中・待機中のジョブは取り消せる', async t => {
  mockAgent(t, () => sse({ content: 'ok' }));
  const first = enqueueJob({ type: 'agent', prompt: 'q1', provider: 'openai' });
  const second = enqueueJob({ type: 'agent', prompt: 'q2', provider: 'openai' });
  // 2 本目は待ち行列にある (同時実行は 1)
  assert.equal(cancelJob(first.id) || cancelJob(second.id), true);
  await whenIdle();
  assert.ok(listJobs().some(j => j.status === 'cancelled'));
});

test('終わったジョブは一覧から消せる', async t => {
  mockAgent(t, () => sse({ content: 'ok' }));
  enqueueJob({ type: 'agent', prompt: 'q', provider: 'openai' });
  await whenIdle();
  const before = listJobs().length;
  assert.ok(before > 0);
  const removed = clearFinishedJobs();
  assert.ok(removed > 0);
  assert.equal(listJobs().length, before - removed);
});

test('要約は実行中・待ち・同時数を返す', async t => {
  mockAgent(t, () => sse({ content: 'ok' }));
  const job = enqueueJob({ type: 'agent', prompt: 'q', provider: 'openai' });
  const summary = jobSummary();
  assert.equal(summary.concurrency >= 1, true);
  assert.equal(summary.queued + summary.running >= 0, true);
  await whenIdle();
  assert.equal(getJob(job.id)!.status, 'done');
  assert.equal(jobSummary().queued, 0);
  assert.equal(jobSummary().running, 0);
});
