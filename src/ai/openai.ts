// SPDX-License-Identifier: AGPL-3.0-or-later

/// OpenAI互換 (/v1/chat/completions) API を ChatSession インターフェースに適合させるアダプタ。
/// ツール (function calling) 対応。モデルがツール呼び出しを返した場合は実行して
/// 結果を送り返すエージェントループを内部で回す。

import type { AIEvent, ChatContents, ChatFile, ChatSession, ToolSpec } from './types.ts';

export interface OpenAICompatConfig {
  /** 例: https://api.openai.com/v1 (末尾に / を付けない) */
  baseUrl: string,
  apiKey: string,
  /** 例: gpt-4o-mini */
  model: string,
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool',
  content: string | null,
  tool_calls?: Array<{
    id: string,
    type: 'function',
    function: { name: string, arguments: string },
  }>,
  tool_call_id?: string,
}

const MAX_HISTORY = 40; // 保持するやり取りの上限 (system除く)
const MAX_TOOL_ROUNDS = 10; // 1回の発言でツールを実行して再生成する上限

export class OpenAICompatChat implements ChatSession {
  readonly label: string;
  readonly id: string;

  readonly #config: OpenAICompatConfig;
  #systemPrompt: string = '';
  #history: ChatMessage[] = [];
  readonly #tools?: ToolSpec;

  constructor(config: OpenAICompatConfig, tools?: ToolSpec) {
    this.#config = config;
    this.#tools = tools;
    // チャンネルごとにインスタンスが作られるので、IDはランダムで一意にする
    this.id = crypto.randomUUID();
    this.label = config.model;
  }

  setSystemPrompt(text: string): void {
    this.#systemPrompt = text;
  }

  /** サーバー/チャンネルの文脈をシステムプロンプトに追記する */
  setServerContext(guildName: string, channelName: string): void {
    this.#systemPrompt += `\nあなたが参加してるサーバーは "${guildName}"、チャンネルは "${channelName}" です。`;
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

    yield* this.#agentLoop(userText, message.meta);
  }

  /** ツール実行 → 再生成のループ */
  async *#agentLoop(userText: string, meta: unknown): AsyncGenerator<AIEvent> {
    this.#history.push({ role: 'user', content: userText });
    if (this.#history.length > MAX_HISTORY * 2) {
      this.#history = this.#history.slice(-MAX_HISTORY * 2);
    }

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      let sawToolCall = false;

      for await (const ev of this.#complete(meta)) {
        if (ev.type === 'tool-call-detail') sawToolCall = true;
        yield ev;
      }

      // ツール呼び出しがなければ完了
      if (!sawToolCall) return;
      if (round === MAX_TOOL_ROUNDS) {
        yield { type: 'error', code: 'loop', message: 'ツールの実行回数上限を超えました', trace: { id: '-', url: '-' }, threadId: this.id };
        return;
      }
    }
  }

  /** 1回分の chat/completions をストリーミング実行し、必要ならツールを実行する */
  async *#complete(meta: unknown): AsyncGenerator<AIEvent> {
    const messages: ChatMessage[] = [
      ...(this.#systemPrompt ? [{ role: 'system' as const, content: this.#systemPrompt }] : []),
      ...this.#history,
    ];

    const body: Record<string, unknown> = {
      model: this.#config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (this.#tools !== undefined && this.#tools.definitions.length > 0) {
      body.tools = this.#tools.definitions;
    }

    const res = await fetch(`${this.#config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.#config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => '');
      // 失敗時は履歴を汚さない
      this.#history.pop();
      yield {
        type: 'error',
        code: String(res.status),
        message: `OpenAI-compat API error: ${res.status} ${errBody.slice(0, 500)}`,
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

    for await (const chunk of sseLines(res.body)) {
      for (const choice of (chunk as any).choices ?? []) {
        const delta = choice.delta ?? {};

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

        if (delta.reasoning_content != null || delta.reasoning != null) {
          continue; // reasoningは表示のみで履歴には入れない (ここでは無視)
        }
        const piece = typeof choice.text === 'string' && delta.content == null ? choice.text : delta.content;
        if (typeof piece === 'string' && piece.length > 0) {
          text += piece;
          yield { type: 'text-delta', text: piece };
        }
        if (choice.finish_reason != null) finishReason = choice.finish_reason;
      }

      const usage = (chunk as any).usage;
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

    const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);

    if (calls.length > 0) {
      // アシスタントのツール呼び出しを履歴に積む
      this.#history.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map(c => ({
          id: c.id || `call_${crypto.randomUUID()}`,
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
          content: JSON.stringify(result[0] ? result[1] : result[1]),
          tool_call_id: c.id || `call_${crypto.randomUUID()}`,
        });
      }
      return; // ツール実行後は agentLoop が再生成する
    }

    // 通常のテキスト応答: 履歴に追加
    if (finishReason === 'tool_calls') {
      // finish_reasonだけtool_callsで中身が空のケースは、次ラウンドへそのまま渡す
      this.#history.push({ role: 'assistant', content: null });
    } else if (text.trim() !== '') {
      this.#history.push({ role: 'assistant', content: text });
    } else {
      // 空応答: 履歴を汚さないようuserメッセージを戻す
      this.#history.pop();
    }

    if (usageEvent !== undefined) yield usageEvent;
    yield { type: 'done', messageIds: [this.id] };
  }
}

/** SSE (data: ...) をパースしてJSONチャンクごとに返す */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        yield JSON.parse(payload);
      } catch {
        // keep-alive コメント等は無視
      }
    }
  }
}
