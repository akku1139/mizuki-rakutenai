// SPDX-License-Identifier: AGPL-3.0-or-later

/// エージェントループの共通部分。Discord のメンション応答も、管理パネルの
/// バックグラウンドジョブも、ここを通してモデルを回す。
///
/// ここは「送る・見せる」を持たない。イベントをそのまま流し、本文・使用量・ツール回数・
/// エラーを集めるだけにする (Discord への投稿は呼び出し側、ジョブは捨てるか記録する)。

import type { AIEvent, ChatContents, ChatSession } from './types.ts';

export type TokenUsage = Extract<AIEvent, { type: 'usage' }>['usage'];

export interface AgentHooks {
  /** すべてのイベント (進捗の表示や記録に使う)。await されるので、重い処理は中で待たせない */
  onEvent?(event: AIEvent): void | Promise<void>;
  /** 中断。ループを抜けてストリームを閉じる */
  signal?: AbortSignal;
  /** 何イベントごとに onTick を呼ぶか (Discord の typing 用)。0 で無効 */
  tickEvery?: number;
  onTick?(): void;
}

export interface AgentResult {
  /** 生成された本文 (エラーやツールの進捗は含まない) */
  text: string;
  usage?: TokenUsage;
  /** ツール名 → 呼ばれた回数 */
  tools: Map<string, number>;
  /** error イベントの内容 (本文には混ぜない) */
  error?: { code: string; message: string };
  /** signal で止めたか */
  aborted: boolean;
  /** 流れたイベント数 */
  events: number;
}

/**
 * 1 ターン分のエージェントループを回す。
 * モデルがツールを呼ぶ限り ChatSession 側が内部で往復するので、ここは 1 回呼ぶだけ。
 */
export const runAgent = async (
  chat: ChatSession,
  contents: ChatContents,
  meta: unknown,
  hooks: AgentHooks = {},
): Promise<AgentResult> => {
  let text = '';
  let usage: TokenUsage | undefined;
  const tools = new Map<string, number>();
  let error: AgentResult['error'];
  let aborted = false;
  let events = 0;

  const stream = chat.sendMessage({ contents, meta });
  try {
    for await (const event of stream) {
      events++;
      if (hooks.tickEvery !== undefined && hooks.tickEvery > 0 && hooks.onTick !== undefined && events % hooks.tickEvery === 0) {
        hooks.onTick();
      }
      switch (event.type) {
        case 'text-delta':
          text += event.text;
          break;
        case 'tool-call-detail':
          tools.set(event.data.name, (tools.get(event.data.name) ?? 0) + 1);
          break;
        case 'usage':
          usage = event.usage;
          break;
        case 'error':
          error = { code: event.code, message: event.message };
          break;
        default:
          break;
      }
      if (hooks.onEvent !== undefined) await hooks.onEvent(event);
      if (hooks.signal?.aborted === true) {
        aborted = true;
        break;
      }
    }
  } finally {
    // 途中で抜けたらストリームを閉じる (接続を残さない)
    await stream.return(undefined).catch(() => {});
  }

  return { text, ...(usage !== undefined ? { usage } : {}), tools, ...(error !== undefined ? { error } : {}), aborted, events };
};

/** 使用量を 1 行にする (Discord のフッターとジョブの記録で共用) */
export const formatUsage = (usage: TokenUsage): string => {
  const input = usage.inputTokens.toLocaleString();
  const output = usage.outputTokens.toLocaleString();
  if (usage.cachedInputTokens === undefined) return `${input} in / ${output} out`;
  const cached = usage.cachedInputTokens;
  const uncached = Math.max(usage.inputTokens - cached, 0);
  const percent = usage.inputTokens > 0 ? (cached / usage.inputTokens * 100).toFixed(1) : '0.0';
  return `${uncached.toLocaleString()} + ${cached.toLocaleString()} [${percent}% cached] in / ${output} out`;
};
