// SPDX-License-Identifier: AGPL-3.0-or-later

/// AIバックエンド (RakutenAI / OpenAI互換API) の共通インターフェース。
/// イベント型は @evex/rakutenai の Thread.sendMessage の戻り値と構造的に一致する。

export type AIEvent =
  | { type: 'ack', messageId: string }
  | { type: 'text-delta', text: string }
  | { type: 'reasoning-start' }
  | { type: 'reasoning-delta', text: string }
  | { type: 'done', messageIds: string[] }
  | { type: 'usage', usage: {
      inputTokens: number,
      outputTokens: number,
      cachedInputTokens?: number,
    } }
  | { type: 'notification', data: any }
  | { type: 'disconnected' }
  | { type: 'tool-call', data: Array<{
      contentType: 'TEXT' | 'SUMMARY_TEXT',
      textData: { text: string },
    }> }
  | { type: 'tool-call-detail', data: {
      name: string,
      description: string,
      groupId: string,
    } }
  | { type: 'tool-result', data: {
      name: string,
      ok: boolean,
      /** ok=falseの場合のエラー情報 */
      value?: unknown,
    } }
  | { type: 'image-thumbnail', url: string }
  | { type: 'image', url: string }
  | { type: 'error', code: string, message: string, trace: {
      id: string,
      url: string,
    }, threadId: string };

export interface ChatFile {
  fileId: string,
  fileUrl: string,
  fileName: string,
  isImage: boolean,
}

export type ChatContents = Array<
  | { type: 'text', text: string }
  | { type: 'file', file: ChatFile }
>;

/** プロバイダ非依存のツール群。definitionsはOpenAI function calling形式 */
export interface ToolSpec {
  definitions: Array<Record<string, unknown>>,
  execute(
    name: string,
    args: Record<string, unknown>,
    meta: unknown,
  ): Promise<[true, unknown] | [false, { error: string }]>,
}

/** 1チャンネルごとの会話セッション。RakutenAIのスレッド or クライアント側履歴。 */
export interface ChatSession {
  /** ログ表示用のラベル (例: "rakutenai", "openai/gpt-4o-mini") */
  readonly label: string,
  readonly id: string,
  uploadFile(opts: { file: File, isImage?: boolean }): Promise<ChatFile>,
  sendMessage(message: {
    mode?: 'USER_INPUT' | 'DEEP_THINK' | 'AI_READ',
    contents: ChatContents,
    /** ツール実行時に渡されるコンテキスト (呼び出し元メッセージなど) */
    meta?: unknown,
  }): AsyncGenerator<AIEvent>,
  /** 履歴をクライアント側で持つバックエンド (OpenAI互換) のみ実装 */
  setSystemPrompt?(text: string): void,
}

export const PROVIDERS = ['rakutenai', 'openai'] as const;

export type ProviderName = typeof PROVIDERS[number];

export const isProviderName = (v: string): v is ProviderName =>
  (PROVIDERS as ReadonlyArray<string>).includes(v);
