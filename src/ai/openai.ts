// SPDX-License-Identifier: AGPL-3.0-or-later

/// OpenAI互換 (/v1/chat/completions) API を ChatThread インターフェースに適合させるアダプタ。

import type { AIEvent, ChatContents, ChatFile, ChatSession } from './types.ts';

export interface OpenAICompatConfig {
  /** 例: https://api.openai.com/v1 (末尾に / を付けない) */
  baseUrl: string,
  apiKey: string,
  /** 例: gpt-4o-mini */
  model: string,
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant',
  content: string,
}

const MAX_HISTORY = 40; // 保持するやり取りの上限 (system除く)

export class OpenAICompatChat implements ChatSession {
  readonly label: string;
  readonly id: string;

  readonly #config: OpenAICompatConfig;
  #systemPrompt: string = '';
  #history: ChatMessage[] = [];

  constructor(config: OpenAICompatConfig, id?: string) {
    this.#config = config;
    // チャンネルごとにインスタンスが作られるので、IDはランダムで一意にする
    this.id = id ?? crypto.randomUUID();
    this.label = config.model;
  }

  setSystemPrompt(text: string): void {
    this.#systemPrompt = text;
  }

  async uploadFile(opts: { file: File, isImage?: boolean }): Promise<ChatFile> {
    const uploaded = await this.#upload(opts.file);
    return {
      fileId: uploaded.id,
      fileUrl: uploaded.url ?? opts.file.name,
      fileName: opts.file.name,
      isImage: opts.isImage ?? false,
    };
  }

  /**
   * ファイルを base64 data URL として送る。
   * Files API 未対応の互換サーバーでも動くようにこちらを既定にする。
   */
  async #upload(file: File): Promise<{ id: string, url?: string }> {
    const buf = Buffer.from(await file.arrayBuffer());
    const mime = file.type || 'application/octet-stream';
    const url = `data:${mime};base64,${buf.toString('base64')}`;
    return { id: crypto.randomUUID(), url };
  }

  async *sendMessage(message: {
    mode?: 'USER_INPUT' | 'DEEP_THINK' | 'AI_READ',
    contents: ChatContents,
  }): AsyncGenerator<AIEvent> {
    const userText = message.contents
      .filter((c): c is { type: 'text', text: string } => c.type === 'text')
      .map(c => c.text)
      .join('\n');

    const imageParts = message.contents.flatMap(c => c.type === 'file' && c.file.isImage && c.file.fileUrl.startsWith('data:')
      ? [c.file.fileUrl]
      : []);

    yield* this.#complete(userText, imageParts);
  }

  async *#complete(userText: string, imageDataUrls: string[]): AsyncGenerator<AIEvent> {
    this.#history.push({ role: 'user', content: userText });
    if (this.#history.length > MAX_HISTORY * 2) {
      this.#history = this.#history.slice(-MAX_HISTORY * 2);
    }

    const messages: ChatMessage[] = [
      ...(this.#systemPrompt ? [{ role: 'system' as const, content: this.#systemPrompt }] : []),
      ...this.#history,
    ];

    const res = await fetch(`${this.#config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.#config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.#config.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      yield {
        type: 'error',
        code: String(res.status),
        message: `OpenAI-compat API error: ${res.status} ${body.slice(0, 500)}`,
        trace: { id: '-', url: `${this.#config.baseUrl}/chat/completions` },
        threadId: this.id,
      };
      return;
    }

    let text = '';
    let reasoning = false;
    const emittedTools = new Set<string>();

    for await (const raw of lines(res.body)) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') break;

      let chunk: unknown;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // keep-alive コメント等は無視
      }

      for (const choice of (chunk as any).choices ?? []) {
        const delta = choice.delta ?? {};
        // ツール呼び出し (function calling)。フッター表示はRakutenAIと同様に tool-call-detail で流す
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const name = tc?.function?.name;
            if (typeof name === 'string' && name !== '' && !emittedTools.has(name)) {
              emittedTools.add(name);
              yield {
                type: 'tool-call-detail',
                data: { name, description: tc.function.description ?? '', groupId: this.id },
              };
            }
          }
        }
        if (delta.reasoning_content != null || delta.reasoning != null) {
          const t = delta.reasoning_content ?? delta.reasoning;
          if (!reasoning) {
            reasoning = true;
            yield { type: 'reasoning-start' };
          }
          if (typeof t === 'string' && t.length > 0) {
            yield { type: 'reasoning-delta', text: t };
          }
          continue;
        }
        const piece = typeof choice.text === 'string' && choice.delta?.content == null
          ? choice.text // 古いスタイル (completions系)
          : delta.content;
        if (typeof piece === 'string' && piece.length > 0) {
          if (reasoning) reasoning = false;
          text += piece;
          yield { type: 'text-delta', text: piece };
        }
      }

      const usage = (chunk as any).usage;
      if (usage != null) {
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.prompt_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
            cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
          },
        };
      }
    }

    // 履歴に追加。画像はURLが長大なので履歴にはテキストのみ入れる
    if (text.trim() !== '') {
      this.#history.push({ role: 'assistant', content: text });
    } else {
      // 失敗時は履歴を汚さない
      this.#history.pop();
    }

    yield { type: 'done', messageIds: [this.id] };
  }
}

/** SSE/NDJSONどちらでも扱えるよう、改行区切りで読む */
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf !== '') yield buf;
}
