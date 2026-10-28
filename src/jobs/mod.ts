// SPDX-License-Identifier: AGPL-3.0-or-later

/// 管理パネルから発行するバックグラウンドジョブ。

import { log, error } from '../log.ts';
import { discord, fluxer } from '../clients.ts';
import { config, get } from '../config.ts';
import { createChatSession } from '../ai/mod.ts';
import { getAitoolsSpec } from '../ai/tools.ts';

export interface Job {
  id: string,
  type: string,
  channelId: string,
  status: 'queued' | 'running' | 'done' | 'error',
  startedAt?: number,
  finishedAt?: number,
  result?: string,
  error?: string,
}

const jobs: Job[] = [];
let counter = 0;

const clientForChannel = async (channelId: string) => {
  for (const c of [discord, fluxer]) {
    try {
      const ch = await c.channels.fetch(channelId);
      if (ch) return { client: c, channel: ch };
    } catch {}
  }
  return null;
};

const runIndexJob = async (job: Job): Promise<void> => {
  job.status = 'running';
  job.startedAt = Date.now();
  log(`job ${job.id}: indexing channel ${job.channelId}`);
  try {
    const found = await clientForChannel(job.channelId);
    if (!found || !found.channel.isTextBased()) throw new Error('channel not found or not text-based');
    const msgs = await (found.channel as any).messages.fetch({ limit: 100 });
    job.result = `fetched ${msgs.size} messages`;
    job.status = 'done';
  } catch (e: any) {
    job.status = 'error';
    job.error = e?.message ?? String(e);
    error(`job ${job.id} failed:`, e);
  } finally {
    job.finishedAt = Date.now();
    log(`job ${job.id}: ${job.status} (${job.result ?? job.error ?? ''})`);
  }
};

export interface JobOptions {
  prompt?: string,
}

export const enqueueJob = (type: string, channelId: string, options?: JobOptions): Job => {
  const job: Job = { id: `job-${++counter}`, type, channelId, status: 'queued', result: options?.prompt ? `prompt: ${options.prompt}` : undefined };
  jobs.push(job);
  void (async () => {
    if (type === 'agent') await runAgentJob(job, options?.prompt ?? '');
    else await runIndexJob(job);
  })();
  return job;
};

const runAgentJob = async (job: Job, prompt: string): Promise<void> => {
  job.status = 'running';
  job.startedAt = Date.now();
  log(`job ${job.id}: agent start`);
  try {
    const chat = await createChatSession('openai');
    let text = '';
    for await (const ev of chat.sendMessage({ contents: [{ type: 'text', text: prompt }] })) {
      if (ev.type === 'text-delta') text += ev.text;
      if (ev.type === 'error') throw new Error(ev.message);
    }
    job.result = text.slice(0, 4000);
    job.status = 'done';
  } catch (e: any) {
    job.status = 'error';
    job.error = e?.message ?? String(e);
    error(`job ${job.id} failed:`, e);
  } finally {
    job.finishedAt = Date.now();
    log(`job ${job.id}: ${job.status}`);
  }
};

export const listJobs = (): Job[] => [...jobs].reverse();
