// SPDX-License-Identifier: AGPL-3.0-or-later

/// Formats recent channel messages into the text context given to the model.

import type { Message, OmitPartialGroupDMChannel, Snowflake } from 'discord.js';

/** Upper bound of the context block, excluding the system prompt prefix. */
const MAX_CONTEXT_LEN = 7000;

const formatTime = (m: Message): string =>
  m.createdAt.toLocaleTimeString('ja-JP', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

/** One history line; author info is omitted for consecutive posts by the same user. */
const formatLine = (m: Message, lastAuthorId: string | null): string => {
  const replyNote = m.reference ? `(reply to ${m.reference.messageId}) ` : '';
  const forwardNote = m.messageSnapshots && m.messageSnapshots.size > 0 ? ' (forwarded)' : '';
  const botPrefix = m.author.bot ? '[BOT] ' : '';

  if (m.author.id === lastAuthorId) {
    // 連続投稿: ユーザー情報を省略し、ID・返信マーク・時刻・本文のみ
    return `[${m.id}] ${replyNote}${formatTime(m)} ${m.content}${forwardNote}`;
  }
  // 通常表示
  return `[${m.id}] ${replyNote}${formatTime(m)} | ${botPrefix}${m.member?.displayName ?? m.author.displayName} (${m.author.username}, ${m.author.id}): ${m.content}${forwardNote}`;
};

/**
 * Builds the context block: recent messages plus the triggering message.
 *
 * `prefixLength` counts toward the budget because the result is concatenated
 * right after the system prompt.
 */
export const buildContextBlock = (
  m: OmitPartialGroupDMChannel<Message<boolean>>,
  recentMessages: Array<Message<boolean>>,
  lastIds: Snowflake[],
  prefixLength: number,
): string => {
  const contextLines: string[] = [];
  let contextLength = prefixLength;

  // システム行: 前回の自分のメッセージID（常に表示）
  if (lastIds.length > 0) {
    const sysLine = `[System] あなたの前回のメッセージID: ${lastIds.join(', ')}`;
    contextLines.push(sysLine);
    contextLength += sysLine.length + 1;
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
