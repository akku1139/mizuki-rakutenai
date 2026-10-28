// SPDX-License-Identifier: AGPL-3.0-or-later

/// 管理パネルから発行するバックグラウンドジョブ。
///
/// Discord にメッセージを送らずにエージェントループを回す (`src/ai/agent.ts` の共通実装)。
/// 出力は捨てずにジョブへ記録し、管理パネルから状態・ログ・結果を読めるようにする。
///
/// ジョブは 1 本ずつ順番に走らせる (同時に走るとモデルの枠と記憶の書き込みがぶつかる)。
/// 実行中のジョブは中断でき、`AbortSignal` でループを抜けてストリームを閉じる。

import { config, get } from '../config.ts';
import { error, log, warn } from '../log.ts';
import { discord, fluxer } from '../clients.ts';
import { runAgent } from '../ai/agent.ts';
import { createChatSession } from '../ai/mod.ts';
import { buildSystemPrompt } from '../ai/prompt.ts';
import { isProviderName, type ProviderName } from '../ai/types.ts';
import { describeMessage } from '../ai/embeds.ts';

export type JobType = 'agent' | 'index';
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobEvent {
  at: number;
  kind: 'log' | 'tool' | 'error' | 'text';
  text: string;
}

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  /** 実行する内容 (agent: 指示文、index: 対象チャンネルの直近 N 件を読む) */
  prompt?: string;
  channelId?: string;
  guildId?: string;
  provider?: ProviderName;
  /** index で読む件数 */
  limit?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  usage?: { inputTokens: number, outputTokens: number, cachedInputTokens?: number };
  tools?: Record<string, number>;
  events: JobEvent[];
}

export interface JobRequest {
  type?: string;
  prompt?: string;
  channelId?: string;
  guildId?: string;
  provider?: string;
  limit?: number;
}

/** 保持するジョブの数 (古いものから消える) */
const MAX_JOBS = 100;
/** 1 ジョブが持つイベントの数 (これ以上は捨てる) */
const MAX_EVENTS = 300;
/** 結果として残す本文の長さ */
const MAX_RESULT_CHARS = 20_000;
/** 既定で読む件数 (index) */
const DEFAULT_INDEX_LIMIT = 100;

const jobs: Job[] = [];
let counter = 0;
let running: { job: Job, controller: AbortController } | undefined;
const queue: Job[] = [];
/** 実行中・待機中が無くなったら解決する待ち行列 (終了処理とテスト用) */
const idleWaiters: Array<() => void> = [];

const notifyIdle = (): void => {
  if (runningCount() > 0 || queue.length > 0) return;
  for (const resolve of idleWaiters.splice(0)) resolve();
};

/** 実行中と待機中のジョブが無くなるまで待つ */
export const whenIdle = (): Promise<void> =>
  (runningCount() === 0 && queue.length === 0 ? Promise.resolve() : new Promise<void>(resolve => { idleWaiters.push(resolve); }));

const concurrency = (): number => {
  const n = Number(get(config, 'admin.jobConcurrency', 1));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
};

const runningCount = (): number => jobs.filter(j => j.status === 'running').length;

const event = (job: Job, kind: JobEvent['kind'], text: string): void => {
  if (job.events.length >= MAX_EVENTS) return;
  job.events.push({ at: Date.now(), kind, text: text.slice(0, 1_000) });
};

const asType = (value: unknown): JobType => (value === 'index' ? 'index' : 'agent');

const asProvider = (value: unknown): ProviderName | undefined =>
  typeof value === 'string' && isProviderName(value) ? value : undefined;

const defaultProvider = (): ProviderName => {
  const v = get(config, 'ai.defaultProvider', process.env['AI_PROVIDER'] ?? 'rakutenai');
  return isProviderName(String(v)) ? v : 'rakutenai';
};

/** チャンネルを Discord / Fluxer のどちらから引くか */
const findChannel = async (channelId: string) => {
  for (const client of [discord, fluxer]) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel !== null) return channel;
    } catch { /* 見つからないのは想定内 */ }
  }
  return undefined;
};

/** チャンネルの直近のログを、aiHandler と同じ形の 1 行テキストにする */
const channelLog = async (channelId: string, limit: number): Promise<{ text: string, name: string, guildName?: string } | undefined> => {
  const channel = await findChannel(channelId);
  if (channel === undefined || !channel.isTextBased() || !('messages' in channel)) return undefined;
  const fetched = await channel.messages.fetch({ limit: Math.max(1, Math.min(limit, 200)) });
  const lines = [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(m => `[${m.id}] ${new Date(m.createdTimestamp).toLocaleString('ja-JP')} | ${m.author.bot ? '[BOT] ' : ''}${m.author.username} (${m.author.id}): ${describeMessage(m)}`);
  const guild = 'guild' in channel ? channel.guild : undefined;
  return {
    text: lines.join('\n'),
    name: 'name' in channel ? String(channel.name) : channelId,
    ...(guild !== undefined ? { guildName: guild.name } : {}),
  };
};

const indexPrompt = (channelName: string, text: string): string =>
  `チャンネル #${channelName} の直近のログを読み、記憶に残すべき事実を memory ツールで保存してください。\n\n`
  + `- 人物の性格・立場・好み・関係、決まったこと、用語や由来を、1 件 1 事実で保存する\n`
  + `- 保存したら、何を保存したかを短く箇条書きで返す (保存しなかったものは書かない)\n`
  + `- 挨拶・相槌・その場限りの雑談・推測・機微情報は保存しない\n\n`
  + `## ログ (#${channelName})\n${text}`;

interface JobOutcome {
  text: string;
  usage?: { inputTokens: number, outputTokens: number, cachedInputTokens?: number };
  tools?: Record<string, number>;
  aborted?: boolean;
  error?: string;
}

/** 1 ジョブを実行する。Discord には何も送らない */
const execute = async (job: Job, signal: AbortSignal): Promise<JobOutcome> => {
  const provider = job.provider ?? defaultProvider();

  // index は対象チャンネルのログを読んでから回す。agent は指示文だけでもよい
  let channel: { text: string, name: string, guildName?: string } | undefined;
  if (job.channelId !== undefined && job.channelId !== '') {
    channel = await channelLog(job.channelId, job.limit ?? DEFAULT_INDEX_LIMIT);
    if (channel === undefined && job.type === 'index') throw new Error(`チャンネル ${job.channelId} を読めません`);
  }

  const input = job.type === 'index'
    ? indexPrompt(channel?.name ?? job.channelId ?? '', channel?.text ?? '')
    : [job.prompt ?? '', channel !== undefined ? `\n\n## チャンネル #${channel.name} の直近のログ\n${channel.text}` : ''].join('');

  if (input.trim() === '') throw new Error('prompt か channelId を指定してください');

  const chat = await createChatSession(provider, {
    ...(channel?.guildName !== undefined ? { guildName: channel.guildName } : {}),
    ...(channel !== undefined ? { channelName: channel.name } : {}),
  });
  const systemPrompt = await buildSystemPrompt(undefined, provider);
  chat.setSystemPrompt?.(systemPrompt);
  // RakutenAI はシステムプロンプトを入力の先頭に連結する
  const prefix = chat.setSystemPrompt == null ? systemPrompt : '';

  event(job, 'log', `${provider} / ${chat.label} で開始`);
  const result = await runAgent(chat, [{ type: 'text', text: prefix + input }], undefined, {
    signal,
    onEvent: (e) => {
      if (e.type === 'tool-call-detail') event(job, 'tool', `${e.data.name}${e.data.description !== '' ? ` (${e.data.description})` : ''}`);
      else if (e.type === 'error') event(job, 'error', `${e.code}: ${e.message}`);
    },
  });

  return {
    text: result.text.slice(0, MAX_RESULT_CHARS),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...(result.tools.size > 0 ? { tools: Object.fromEntries(result.tools) } : {}),
    ...(result.aborted ? { aborted: true } : {}),
    ...(result.error !== undefined ? { error: result.error.message } : {}),
  };
};

const finish = (job: Job, outcome: JobOutcome): void => {
  job.finishedAt = Date.now();
  if (outcome.aborted === true || job.status === 'cancelled') {
    job.status = 'cancelled';
    return;
  }
  if (outcome.error !== undefined) {
    job.status = 'error';
    job.error = outcome.error;
    return;
  }
  job.status = 'done';
  job.result = outcome.text;
  if (outcome.usage !== undefined) job.usage = outcome.usage;
  if (outcome.tools !== undefined) job.tools = outcome.tools;
};

const pump = (): void => {
  while (runningCount() < concurrency() && queue.length > 0) {
    const job = queue.shift()!;
    job.status = 'running';
    job.startedAt = Date.now();
    const controller = new AbortController();
    running = { job, controller };
    log(`job ${job.id}: start (${job.type}${job.channelId !== undefined ? `, channel ${job.channelId}` : ''})`);

    void (async () => {
      let outcome: JobOutcome;
      try {
        outcome = await execute(job, controller.signal);
      } catch (e) {
        outcome = { text: '', error: e instanceof Error ? e.message : String(e) };
      }
      finish(job, outcome);
      if (running?.job === job) running = undefined;
      if (job.status === 'error') error(`job ${job.id}: ${job.error}`);
      else log(`job ${job.id}: ${job.status}${job.usage !== undefined ? ` (${job.usage.inputTokens} in / ${job.usage.outputTokens} out)` : ''}`);
      pump();
      notifyIdle();
    })();
  }
};

export const enqueueJob = (request: JobRequest): Job => {
  const job: Job = {
    id: `job-${++counter}`,
    type: asType(request.type),
    status: 'queued',
    createdAt: Date.now(),
    events: [],
    ...(request.prompt !== undefined && request.prompt !== '' ? { prompt: request.prompt.slice(0, 8_000) } : {}),
    ...(request.channelId !== undefined && request.channelId !== '' ? { channelId: request.channelId } : {}),
    ...(request.guildId !== undefined && request.guildId !== '' ? { guildId: request.guildId } : {}),
    ...(asProvider(request.provider) !== undefined ? { provider: asProvider(request.provider)! } : {}),
    ...(typeof request.limit === 'number' && Number.isFinite(request.limit) ? { limit: Math.max(1, Math.min(Math.floor(request.limit), 200)) } : {}),
  };
  jobs.push(job);
  while (jobs.length > MAX_JOBS) {
    const removable = jobs.findIndex(j => j.status === 'done' || j.status === 'error' || j.status === 'cancelled');
    if (removable < 0) break;
    jobs.splice(removable, 1);
  }
  queue.push(job);
  pump();
  return job;
};

/** 実行中 / 待機中のジョブを止める */
export const cancelJob = (id: string): boolean => {
  const job = jobs.find(j => j.id === id);
  if (job === undefined) return false;
  const queuedAt = queue.findIndex(j => j.id === id);
  if (queuedAt >= 0) {
    queue.splice(queuedAt, 1);
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    event(job, 'log', '実行前に取り消しました');
    return true;
  }
  if (job.status === 'running' && running?.job === job) {
    event(job, 'log', '中断しました');
    running.controller.abort();
    return true;
  }
  return false;
};

/** 終わったジョブを一覧から消す */
export const clearFinishedJobs = (): number => {
  const before = jobs.length;
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (jobs[i]!.status !== 'running' && jobs[i]!.status !== 'queued') jobs.splice(i, 1);
  }
  return before - jobs.length;
};

export const listJobs = (): Job[] => [...jobs].reverse();

export const getJob = (id: string): Job | undefined => jobs.find(j => j.id === id);

/** 管理パネル向けの要約 */
export const jobSummary = () => ({
  running: runningCount(),
  queued: queue.length,
  concurrency: concurrency(),
});

if (concurrency() > 1) warn('admin.jobConcurrency > 1: ジョブが並行します (記憶の書き込みが競合しえます)');
