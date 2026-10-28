// SPDX-License-Identifier: AGPL-3.0-or-later
import { log, info, warn, error } from '../log.ts';

/// OpenAI互換 (/v1/chat/completions) API を ChatSession インターフェースに適合させるアダプタ。
/// ツール (function calling) 対応。モデルがツール呼び出しを返した場合は実行して
/// 結果を送り返すエージェントループを内部で回す。

import type { AIEvent, ChatContents, ChatFile, ChatSession, ToolSpec } from './types.ts';
import OpenAI, { APIError } from 'openai';
import { fetchWithRateLimitRetry } from './ratelimit.ts';

export interface OpenAICompatConfig {
  /** 例: https://api.openai.com/v1 (末尾に / を付けない) */
  baseUrl: string,
  apiKey: string,
  /** 例: gpt-4o-mini */
  model: string,
}

const MAX_HISTORY = 40; // 保持するやり取りの上限 (system除く)
// ツール実行の再生成上限は撤廃 (モデルが tool_calls を返し続ける限りループする)
const MAX_TEXT_ATTACHMENT_CHARS = 20_000;

const OPENCODE_SESSION_SUFFIX_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const createOpenCodeSessionId = (): string => {
  const timestamp = Date.now().toString(16).padStart(12, '0').slice(-12);
  let suffix = '';
  while (suffix.length < 14) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const byte of bytes) {
      // 248 is divisible by 62, so this avoids modulo bias.
      if (byte >= 248) continue;
      suffix += OPENCODE_SESSION_SUFFIX_ALPHABET[byte % OPENCODE_SESSION_SUFFIX_ALPHABET.length]!;
      if (suffix.length === 14) break;
    }
  }
  return `ses_${timestamp}${suffix}`;
};

/**
 * 思考過程 (reasoning) のフィールド。
 * OpenAI 公式のスキーマには無いが、互換サーバーは次のどちらかで返す。
 * - reasoning_content: DeepSeek、vLLM、SGLang、GLM など
 * - reasoning: OpenRouter など
 */
interface ReasoningDelta {
  reasoning_content?: string | null,
  reasoning?: string | null,
}

const reasoningText = (delta: ReasoningDelta): string => {
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content;
  if (typeof delta.reasoning === 'string') return delta.reasoning;
  return '';
};

const textFromFile = (file: ChatFile): string | undefined => {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(file.fileUrl);
  if (!dataUrl || !/^text\/|^application\/(?:json|xml|x-yaml|yaml|csv)$/i.test(
    dataUrl[1]!,
  )) return undefined;
  const text = Buffer.from(dataUrl[2]!, 'base64').toString('utf8');
  return text.length > MAX_TEXT_ATTACHMENT_CHARS
    ? `${text.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n[添付ファイルの残りは省略されました]`
    : text;
};

export class OpenAICompatChat implements ChatSession {
  readonly label: string;
  readonly id: string;

  readonly #config: OpenAICompatConfig;
  readonly #client: OpenAI;
  #systemPrompt: string = '';
  #history: Array<OpenAI.Chat.ChatCompletionMessageParam & { reasoning?: string }> = [];
  /** 今回の発言を始める前の履歴。失敗や空応答のときはここまで戻す */
  #historyBeforeTurn: Array<OpenAI.Chat.ChatCompletionMessageParam & { reasoning?: string }> = [];
  readonly #tools?: ToolSpec;
  /** 思考過程を再送するときのフィールド名 (OpenRouter は reasoning、それ以外は reasoning_content) */
  readonly #reasoningKey: 'reasoning' | 'reasoning_content';

  constructor(config: OpenAICompatConfig, tools?: ToolSpec) {
    this.#config = config;
    // OpenCode Go uses this ID to route requests belonging to the same chat session.
    this.id = createOpenCodeSessionId();
    this.#client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
      // 429 の再試行は ratelimit.ts の設定 (待ち時間・回数・諦める条件) に一本化する。
      // SDK 側にも再試行があるので、二重に再送しないよう向こうは止める。
      maxRetries: 0,
      fetch: (url, init) => fetchWithRateLimitRetry(() => fetch(url, init)),
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/akku1139/mizuki-rakutenai',
        'X-OpenRouter-Title': 'mizuki-rakutenai',
        'X-OpenRouter-Categories': 'general-chat',
        'x-opencode-session': this.id,
      },
    });
    this.#tools = tools;
    // OpenRouter は supported_parameters に reasoning を持つ。それ以外 (Command Code / DeepSeek 等) は
    // reasoning_content を要求するので、ホスト名で切り替える (teapot と同じ方針)。
    let host = '';
    try { host = new URL(config.baseUrl).hostname; } catch { host = ''; }
    this.#reasoningKey = /(^|\.)openrouter\.ai$/i.test(host) ? 'reasoning' : 'reasoning_content';
    this.label = config.model;
  }

  setSystemPrompt(text: string): void {
    this.#systemPrompt = text;
  }

  /** サーバー/チャンネルの文脈をシステムプロンプトに追記する */
  setServerContext(guildName: string, channelName: string): void {
    this.#systemPrompt += `\nあなたが参加してるサーバーは "${guildName}"、チャンネルは "${channelName}" です。`;
  }

  /** assistant メッセージの思考過程を、プロバイダが要求するフィールド名で再送する */
  #withReasoning(m: OpenAI.Chat.ChatCompletionMessageParam): OpenAI.Chat.ChatCompletionMessageParam {
    if (m.role !== 'assistant') return m;
    const r = (m as { reasoning?: unknown }).reasoning;
    const { reasoning: _r, ...rest } = m as unknown as Record<string, unknown>;
    return { ...rest, [this.#reasoningKey]: typeof r === 'string' ? r : '' } as unknown as OpenAI.Chat.ChatCompletionMessageParam;
  }

  async uploadFile(opts: { file: File, isImage?: boolean }): Promise<ChatFile> {
    const buf = Buffer.from(await opts.file.arrayBuffer());
    const mime = opts.file.type || 'application/octet-stream';
    return {
      fileId: crypto.randomUUID(),
      // ファイルは base64 data URL として送る (Files API 未対応の互換サーバーでも動くように)
      fileUrl: `data:${mime};base64,${buf.toString('base64')}`,
      fileName: opts.file.name,
      isImage: opts.isImage ?? false,
    };
  }

  async *sendMessage(message: {
    mode?: 'USER_INPUT' | 'DEEP_THINK' | 'AI_READ',
    contents: ChatContents,
    meta?: unknown,
  }): AsyncGenerator<AIEvent> {
    const userText = message.contents
      .filter((c): c is { type: 'text', text: string } => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    const files = message.contents
      .filter((c): c is { type: 'file', file: ChatFile } => c.type === 'file')
      .map(c => c.file);
    const userContent: string | Array<OpenAI.Chat.ChatCompletionContentPart> = files.length === 0
      ? userText
      : [
          ...(userText ? [{ type: 'text' as const, text: userText }] : []),
          ...files.map((file): OpenAI.Chat.ChatCompletionContentPart => {
            if (file.isImage) {
              return { type: 'image_url', image_url: { url: file.fileUrl } };
            }
            const text = textFromFile(file);
            return {
              type: 'text',
              text: text === undefined
                ? `[添付ファイル「${file.fileName}」は、このAPI経路では読み取れない形式です]`
                : `[添付ファイル: ${file.fileName}]\n${text}`,
            };
          }),
        ];

    yield* this.#agentLoop(userContent, message.meta);
  }

  /** ツール実行 → 再生成のループ */
  async *#agentLoop(userContent: string | Array<OpenAI.Chat.ChatCompletionContentPart>, meta: unknown): AsyncGenerator<AIEvent> {
    this.#historyBeforeTurn = [...this.#history];
    this.#history.push({ role: 'user', content: userContent });
    if (this.#history.length > MAX_HISTORY * 2) {
      // ツール呼び出しとその結果の間で切らないよう、先頭をuserメッセージに揃える
      const trimmed = this.#history.slice(-MAX_HISTORY * 2);
      this.#history = trimmed.slice(trimmed.findIndex(m => m.role === 'user'));
    }

    while (true) {
      let sawToolCall = false;

      for await (const ev of this.#complete(meta)) {
        if (ev.type === 'tool-call-detail') sawToolCall = true;
        yield ev;
      }

      // ツール呼び出しがなければ完了
      if (!sawToolCall) return;
    }
  }

  /** 1回分の chat/completions をストリーミング実行し、必要ならツールを実行する */
  async *#complete(meta: unknown): AsyncGenerator<AIEvent> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      ...(this.#systemPrompt ? [{ role: 'system' as const, content: this.#systemPrompt }] : []),
      ...this.#history.map(m => this.#withReasoning(m)),
    ];

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk> | undefined;
    try {
      stream = await this.#client.chat.completions.create({
        model: this.#config.model,
        messages: messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(this.#tools !== undefined && this.#tools.definitions.length > 0 ? { tools: this.#tools.definitions as unknown as OpenAI.Chat.ChatCompletionTool[] } : {}),
      }, { timeout: 120_000 }) as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    } catch (err) {
      // 失敗時は履歴を汚さない
      this.#history = this.#historyBeforeTurn;
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as APIError)?.status ?? '-';
      yield {
        type: 'error',
        code: String(status),
        message: `OpenAI-compat API error: ${message.slice(0, 500)}`,
        trace: { id: '-', url: `${this.#config.baseUrl}/chat/completions` },
        threadId: this.id,
      };
      return;
    }

    // ストリームを解析してアシスタントメッセージを組み立てる
    let text = '';
    const toolCalls = new Map<number, { id: string, name: string, arguments: string }>();
    let finishReason: string | undefined;
    let usageEvent: AIEvent | undefined;
    /** reasoning は表示用。履歴には入れない (入れ直すとモデル次第でループする) */
    let sawReasoning = false;
    let reasoning = '';

    try {
      for await (const chunk of stream) {
        for (const choice of chunk.choices ?? []) {
          const delta = (choice.delta ?? {}) as OpenAI.Chat.ChatCompletionChunk.Choice.Delta;

          // reasoning は SDK の型に無いので、互換サーバーの独自フィールドから拾う。
          // ツール呼び出しと同じチャンクに載ることもあるため、先に処理する
          const r = reasoningText(delta as ReasoningDelta);
          if (r.length > 0) {
            if (!sawReasoning) {
              sawReasoning = true;
              yield { type: 'reasoning-start' };
            }
            reasoning += r;
            yield { type: 'reasoning-delta', text: r };
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const slot = toolCalls.get(tc.index ?? 0) ?? { id: tc.id ?? '', name: '', arguments: '' };
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.name += tc.function.name;
              if (typeof tc.function?.arguments === 'string') slot.arguments += tc.function.arguments;
              toolCalls.set(tc.index ?? 0, slot);
            }
            continue;
          }

          if (choice.finish_reason != null) finishReason = choice.finish_reason;

          // 古いスタイル (completions系) は delta.content ではなく choices[].text に本文が載る
          const legacyText = (choice as { text?: unknown }).text;
          const piece = typeof legacyText === 'string' && delta.content == null
            ? legacyText
            : delta.content;
          if (typeof piece === 'string' && piece.length > 0) {
            text += piece;
            yield { type: 'text-delta', text: piece };
          }
        }

        const usage = chunk.usage;
        if (usage != null) {
          usageEvent = {
            type: 'usage',
            usage: {
              inputTokens: usage.prompt_tokens ?? 0,
              outputTokens: usage.completion_tokens ?? 0,
              cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
            },
          };
        }
      }
    } catch (err) {
      // ストリーム中断時も履歴を汚さない
      this.#history = this.#historyBeforeTurn;
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as APIError)?.status ?? (err as APIError)?.code ?? '-';
      yield {
        type: 'error',
        code: String(status),
        message: `OpenAI-compat API error (stream): ${message.slice(0, 500)}`,
        trace: { id: '-', url: `${this.#config.baseUrl}/chat/completions` },
        threadId: this.id,
      };
      return;
    }

    // IDが無いツール呼び出しには、assistant側とtool側で同じIDを振る
    const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ ...v, id: v.id || `call_${crypto.randomUUID()}` }));

    if (calls.length > 0) {
      // アシスタントのツール呼び出しを履歴に積む
      this.#history.push({
        role: 'assistant',
        content: text || null,
        reasoning: reasoning || undefined,
        tool_calls: calls.map(c => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments || '{}' },
        })),
      });

      for (const c of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.arguments || '{}');
        } catch {
          // 引数が壊れている場合は空で実行
        }
        const explain = typeof args['$explain'] === 'string' ? args['$explain'] : undefined;
        delete args['$explain'];

        yield {
          type: 'tool-call-detail',
          data: { name: c.name, description: explain ?? '', groupId: this.id },
        };

        const result = this.#tools !== undefined && this.#tools.execute !== undefined
          ? await this.#tools.execute(c.name, args, meta)
          : [false, { error: 'ツールが利用できません' }] as const;

        yield {
          type: 'tool-result',
          data: { name: c.name, ok: result[0], value: result[0] ? undefined : result[1] },
        };

        this.#history.push({
          role: 'tool',
          content: JSON.stringify(result[1]),
          tool_call_id: c.id,
        });
      }
      return; // ツール実行後は agentLoop が再生成する
    }

    // 通常のテキスト応答: 履歴に追加
    if (finishReason === 'tool_calls') {
      // finish_reasonだけtool_callsで中身が空のケースは、次ラウンドへそのまま渡す
      this.#history.push({ role: 'assistant', content: null, reasoning: reasoning || undefined });
    } else if (text.trim() !== '') {
      this.#history.push({ role: 'assistant', content: text, reasoning: reasoning || undefined });
    } else {
      // 空応答: 履歴を汚さないよう、今回の発言 (ツールの実行結果を含む) ごと戻す
      this.#history = this.#historyBeforeTurn;
    }

    if (usageEvent !== undefined) yield usageEvent;
    yield { type: 'done', messageIds: [this.id] };
  }
}
