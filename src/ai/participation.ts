// SPDX-License-Identifier: AGPL-3.0-or-later

/// ローカルの Kev 互換判定器を呼び、会話に入るかと返信先を決める。

import type { Message } from 'discord.js';
import { config } from '../config.ts';
import { describeMessage } from './embeds.ts';
import { error } from '../log.ts';

const busy = new Set<string>();
const lastReply = new Map<string, number>();

export const finishParticipation = (channelId: string, replied = false): void => {
  if (replied) lastReply.set(channelId, Date.now());
  busy.delete(channelId);
};

export const participationTarget = async (m: Message): Promise<string | undefined> => {
  const settings = config.ai?.participation;
  if (!settings?.channels.includes(m.channelId) || !m.guild || !m.channel.isTextBased() || m.author.bot) return;
  const parentId = 'parentId' in m.channel ? m.channel.parentId : undefined;
  if ((config.blacklistedChannels ?? []).some(id => id === m.channelId || id === parentId)) return;
  if (busy.has(m.channelId) || Date.now() - (lastReply.get(m.channelId) ?? 0) < (settings.cooldownMs ?? 60_000)) return;
  busy.add(m.channelId);
  let selected = false;
  try {
    const recent = await m.channel.messages.fetch({ limit: 12, before: m.id });
    const messages = [...recent.values(), m].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const response = await fetch(settings.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({
        model: settings.model ?? 'kev-latest',
        state: messages.map(msg => `[${msg.id}] ${msg.author.displayName}: ${describeMessage(msg)}`).join('\n').slice(-6000),
        questions: {
          participate: { type: 'noul', instructions: 'Should 瑞稀 (mizuki), a helpful Discord bot, join this conversation now? Reply only if asked, if it can add useful information, or if a reply to it needs an answer. Avoid interrupting casual chat.' },
          reply: { type: 'choice', instructions: 'Which message should mizuki reply to?', criteria: Object.fromEntries(messages.filter(msg => !msg.author.bot).map(msg => [msg.id, describeMessage(msg).slice(0, 300)])) },
        },
      }),
    });
    if (!response.ok) throw new Error(`判定API: HTTP ${response.status}`);
    const data = await response.json() as { answers?: { participate?: { noul?: unknown }, reply?: { choice?: unknown } } };
    const probability = data.answers?.participate?.noul;
    const target = data.answers?.reply?.choice;
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < (settings.threshold ?? 0.85) || probability > 1) return;
    if (typeof target !== 'string' || !messages.some(msg => msg.id === target && !msg.author.bot)) return;
    selected = true;
    return target;
  } catch (e) {
    error('participation failed:', e);
    return;
  } finally {
    if (!selected) busy.delete(m.channelId);
  }
};
