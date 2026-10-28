// SPDX-License-Identifier: AGPL-3.0-or-later

/// 会話履歴の auto-compact。コンテキストウィンドウの一定割合を使ったら、
/// 古い方を要約 1 通に置き換え、直近はそのまま残す (teapot の compact を移植)。
///
/// 元の実装 (メッセージ数で切り詰める) は、ツールを大量に呼ぶターンが 1 回で窓を
/// 食い潰して前のターンが丸ごと消えるため廃止した。

import type OpenAI from 'openai';

/** 履歴に積む形 (reasoning は再送用の内部フィールド) */
export type History = Array<OpenAI.Chat.ChatCompletionMessageParam & { reasoning?: string }>;

/** 使ったトークンの推定。英語は 4 文字 / トークン、日本語は 1.2 トークン / 文字でざっくり数える。 */
export const estimateTokens = (messages: ReadonlyArray<History[number]>): number => {
  let ascii = 0;
  let wide = 0;
  const count = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 0x2e7f) wide++;
      else ascii++;
    }
  };
  for (const m of messages) {
    if (typeof m.content === 'string') count(m.content);
    else if (Array.isArray(m.content)) count(JSON.stringify(m.content));
    const calls = (m as { tool_calls?: ReadonlyArray<{ function: { name: string, arguments: string } }> }).tool_calls;
    for (const c of calls ?? []) {
      count(c.function.name);
      count(c.function.arguments);
    }
  }
  return Math.ceil(ascii / 4 + wide * 1.2 + messages.length * 8);
};

/**
 * 予算として使うトークン数。API が返した入力トークン数 (システムプロンプト込み) があれば
 * それを使い、無ければ推定する。推定は実際より小さく出ることがあるので下限としてのみ使う。
 */
export const contextTokens = (messages: ReadonlyArray<History[number]>, reported?: number | undefined): number => {
  const estimated = estimateTokens(messages);
  if (reported === undefined || !Number.isFinite(reported) || reported <= 0) return estimated;
  return Math.max(reported, Math.floor(estimated / 2));
};

/**
 * 履歴を切ってよい位置。先頭から `cut` 件を要約し、`cut` 以降をそのまま残す。
 *
 * - `messages[cut]` が `tool` だと、その呼び出し元の assistant が要約側に落ちて対応が切れる
 * - `messages[cut - 1]` が `tool_calls` 付きの assistant だと、要約側が未回答の呼び出しで終わる
 *
 * どちらも API が 400 を返す形なので、そうならない位置まで戻す。
 */
export const safeCutPoint = (messages: ReadonlyArray<History[number]>, maxCut: number): number => {
  let cut = Math.min(maxCut, messages.length - 1);
  while (cut >= 1) {
    const startsWithTool = messages[cut]!.role === 'tool';
    const endsWithUnansweredCall = ((messages[cut - 1] as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0;
    if (!startsWithTool && !endsWithUnansweredCall) return cut;
    cut -= 1;
  }
  return -1;
};

/** 要約の出力から、捨てる <analysis> ブロックとコードフェンスを外す。 */
export const stripAnalysis = (raw: string): string => {
  const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  const fenced = /^```(?:markdown|md)?\s*([\s\S]*?)```$/i.exec(withoutAnalysis);
  return (fenced?.[1] ?? withoutAnalysis).trim();
};

export const COMPACT_INSTRUCTION = [
  'あなたは Discord の会話を、続きを自然に話せるように圧縮する係です。',
  '上の会話を、次の見出しの箇条書きだけで出力してください (前置き・後書き・自己紹介は不要)。',
  '',
  '## 依頼と意図',
  '## 話題と経緯',
  '## 決まったこと・分かったこと',
  '## 未解決のこと',
  '## 出てきた人と関係',
  '## 守るべき指示',
  '## 次にやること',
  '',
  'ルール:',
  '- 簡潔な箇条書き。推測を足さない。会話に無いことを書かない。',
  '- 人名・数値・URL・日付・モデル名は正確に写す。',
  '- 相手の発言は意図が残るように、ほぼそのまま残す。',
  '- 守るべき指示は MUST / MUST NOT / SHOULD のいずれかで始める。既に守った指示も落とさない。',
  '- <analysis> の中は保存されないので、そこで自由に考えてよい。',
].join('\n');

export const COMPACT_UPDATE_INSTRUCTION = [
  '',
  '前回のメモが <conversation_checkpoint> として上にあります。今回は更新です。',
  'まだ正しいことは残し、新しい会話で分かったことを足し、解決したことだけを消してください。',
  '新しい会話で繰り返されていないという理由で、依頼や制約を落とさないでください。',
  '同じ見出しで、更新後のメモ全体を出力してください。',
].join('\n');

/** 要約を履歴に戻すときの文面。履歴の先頭は user メッセージに保つ。 */
export const summaryMessage = (summary: string, summarized: number): string =>
  `[harness] ここより前の会話 ${summarized} 件は、コンテキストを空けるため要約されました。`
  + '要約に無い細部は失われているので、必要なら相手に聞き直すか、ツールで調べ直してください。'
  + `\n\n## ここまでの会話の要約\n${summary}`;

/** 要約に失敗したときの文面 (古い方を捨てたことを伝える)。 */
export const droppedMessage = (dropped: number): string =>
  `[harness] ここより前の会話 ${dropped} 件は、要約できなかったため破棄されました。`
  + '失われた内容を前提にせず、必要なら相手に聞き直すか、ツールで調べ直してください。';
