// SPDX-License-Identifier: AGPL-3.0-or-later

/// 再起動後も呼び出し元の削除を返信に反映するための小さな対応表。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { discord, fluxer } from '../clients.ts';
import type { Message } from 'discord.js';

interface ReplyLink { platform: 'discord' | 'fluxer', channelId: string, ids: string[] }
const file = './data/ai_replies.json';
const links = new Map<string, ReplyLink>();
try {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw && typeof raw === 'object') for (const [id, value] of Object.entries(raw)) {
    const v = value as Partial<ReplyLink> | null;
    if (/^\d+$/.test(id) && v && (v.platform === 'discord' || v.platform === 'fluxer') && /^\d+$/.test(v.channelId ?? '') && Array.isArray(v.ids) && v.ids.every(x => typeof x === 'string' && /^\d+$/.test(x))) links.set(id, v as ReplyLink);
  }
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
let writes = Promise.resolve();
const save = (): Promise<void> => {
  const body = JSON.stringify(Object.fromEntries(links));
  const write = writes.catch(() => {}).then(async () => {
    await fsp.mkdir('./data', { recursive: true });
    await fsp.writeFile(`${file}.tmp`, body);
    await fsp.rename(`${file}.tmp`, file);
  });
  writes = write;
  return write;
};

export const rememberReply = async (source: Message, replyId: string): Promise<void> => {
  const link = links.get(source.id) ?? { platform: source.client === discord ? 'discord' : 'fluxer', channelId: source.channelId, ids: [] };
  if (!link.ids.includes(replyId)) link.ids.push(replyId);
  links.set(source.id, link);
  await save();
};

export const removeSavedReplies = async (sourceId: string): Promise<void> => {
  const link = links.get(sourceId);
  if (!link) return;
  const client = link.platform === 'discord' ? discord : fluxer;
  const channel = await client.channels.fetch(link.channelId);
  if (!channel?.isTextBased()) throw new Error('返信先のチャンネルが取得できません');
  for (const id of [...link.ids]) {
    try { await channel.messages.delete(id); }
    catch (e) { if ((e as { code?: number }).code !== 10008) throw e; }
    link.ids = link.ids.filter(value => value !== id);
  }
  if (link.ids.length === 0) links.delete(sourceId);
  await save();
};
