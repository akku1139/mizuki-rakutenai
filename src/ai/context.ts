// SPDX-License-Identifier: AGPL-3.0-or-later

/// Formats recent channel messages into the text context given to the model.

import type { Message, OmitPartialGroupDMChannel, Snowflake } from 'discord.js';
import { describeMessage } from './embeds.ts';

/** Upper bound of the context block, excluding the system prompt prefix. */
const MAX_CONTEXT_LEN = 7000;

const formatTime = (m: Message): string =>
  m.createdAt.toLocaleTimeString('ja-JP', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

/** One history line; author info is omitted for consecutive posts by the same user. */
const formatLine = (m: Message, lastAuthorId: string | null): string => {
  const replyNote = m.reference ? `(reply to ${m.reference.messageId}) ` : '';
  const body = describeMessage(m);
  const botPrefix = m.author.bot ? '[BOT] ' : '';

  if (m.author.id === lastAuthorId) {
    // 連続投稿: ユーザー情報を省略し、ID・返信マーク・時刻・本文のみ
    return `[${m.id}] ${replyNote}${formatTime(m)} ${body}`;
  }
  // 通常表示
  return `[${m.id}] ${replyNote}${formatTime(m)} | ${botPrefix}${m.member?.displayName ?? m.author.displayName} (${m.author.username}, ${m.author.id}): ${body}`;
};

/**
 * Builds the context block: the replied-to messages, recent messages and the triggering message.
 *
 * `repliedMessages` come first so they survive when the recent history does not fit.
 * `prefixLength` counts toward the budget because the result is concatenated
 * right after the system prompt.
 */
export const buildContextBlock = (
  m: OmitPartialGroupDMChannel<Message<boolean>>,
  recentMessages: Array<Message<boolean>>,
  lastIds: Snowflake[],
  prefixLength: number,
  repliedMessages: Array<Message<boolean>> = [],
): string => {
  const contextLines: string[] = [];
  let contextLength = prefixLength;

  // システム行: 前回の自分のメッセージID（常に表示）
  if (lastIds.length > 0) {
    const sysLine = `[System] あなたの前回のメッセージID: ${lastIds.join(', ')}`;
    contextLines.push(sysLine);
    contextLength += sysLine.length + 1;
  }

  // 返信先 (直近の履歴に無いものだけ)。前回の自分の発言より古くても載せる
  const recentIds = new Set(recentMessages.map(msg => msg.id));
  const replied = repliedMessages.filter(msg => msg.id !== m.id && !recentIds.has(msg.id));
  if (replied.length > 0) {
    const header = '[System] 返信先のメッセージ:';
    contextLines.push(header);
    contextLength += header.length + 1;
    let repliedAuthorId: string | null = null;
    for (const msg of replied) {
      const line = formatLine(msg, repliedAuthorId);
      if (contextLength + line.length + 1 > MAX_CONTEXT_LEN) break;
      contextLines.push(line);
      contextLength += line.length + 1;
      repliedAuthorId = msg.author.id;
    }
    const footer = '[System] ここから直近のメッセージ:';
    contextLines.push(footer);
    contextLength += footer.length + 1;
  }

  let lastAuthorId: string | null = null;

  // 過去メッセージの整形
  for (const msg of recentMessages) {
    if (msg.id === m.id) continue;

    const line = formatLine(msg, lastAuthorId);

    if (contextLength + line.length + 1 > MAX_CONTEXT_LEN) break;
    contextLines.push(line);
    contextLength += line.length + 1;
    lastAuthorId = msg.author.id;
  }

  contextLines.push(formatLine(m, lastAuthorId));

  return contextLines.join('\n') + '\n';
};
