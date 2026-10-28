// SPDX-License-Identifier: AGPL-3.0-or-later
import { log, info, warn, error } from '../log.ts';

/// OpenAI互換 (/v1/chat/completions) API を ChatSession インターフェースに適合させるアダプタ。
/// ツール (function calling) 対応。モデルがツール呼び出しを返した場合は実行して
/// 結果を送り返すエージェントループを内部で回す。

import type { AIEvent, ChatContents, ChatFile, ChatSession, ToolSpec } from './types.ts';
import OpenAI, { APIError } from 'openai';
import {
  COMPACT_INSTRUCTION, COMPACT_UPDATE_INSTRUCTION, contextTokens, droppedMessage, estimateTokens,
  safeCutPoint, stripAnalysis, summaryMessage, type History,
} from './compact.ts';
import { contextLengthFor, fetchModelListCached } from './model-meta.ts';
import { fetchWithRateLimitRetry } from './ratelimit.ts';

export interface OpenAICompatConfig {
  /** 例: https://api.openai.com/v1 (末尾に / を付けない) */
  baseUrl: string,
  apiKey: string,
  /** 例: gpt-4o-mini */
  model: string,
  /**
   * コンテキストウィンドウ (トークン)。auto-compact の予算はこの 75%。
   * 未指定ならモデルカタログ (`model-meta.ts`) から引き、それも無ければ 128k を仮定する
   */
  contextWindowTokens?: number,
}

/** コンテキストウィンドウが分からないときの想定値 */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
/** この割合まで使ったら auto-compact する */
const COMPACT_AT_SHARE = 0.75;
/** compact のあと、生のまま残す直近のトークン数 */
const KEEP_RECENT_TOKENS = 15_000;
/** 要約に連続で失敗したら、要約は諦めて捨てるだけにする (毎ターン無駄な呼び出しをしない) */
const MAX_COMPACT_FAILURES = 3;
/** 予算のこの割合を使ったら、要約の前に古いツール出力を削る (teapot の `PRUNE_AT_SHARE`) */
const PRUNE_AT_SHARE = 0.95;
/** これより短いツール出力は削らない */
const PRUNE_MIN_CHARS = 3_000;
/** 削るときに残す先頭の文字数 */
const PRUNE_KEEP_CHARS = 400;
/** 出力が長いだけで、消しても会話が続くツール (teapot の `PRUNABLE_TOOLS` の mizuki 版) */
const PRUNABLE_TOOLS = new Set([
  'fetch_message', 'fetch_messages_history', 'search_messages',
  'wikipedia_search', 'wikipedia_read', 'read_web', 'search_web', 'run_tool',
]);
/**
 * 1 つのツール出力を履歴に積む上限 (文字)。compact はリクエストの前にしか走らないので、
 * 1 ラウンドで積む量を抑えないと、窓を超えて 400 になる (実測: 1M のモデルに 1,885,392 トークン)。
 */
const MAX_TOOL_RESULT_CHARS = 50_000;
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
  #history: History = [];
  /** 今回の発言を始める前の履歴。失敗や空応答のときはここまで戻す */
  #historyBeforeTurn: History = [];
  readonly #tools?: ToolSpec;
  /** 思考過程を再送するときのフィールド名 (OpenRouter は reasoning、それ以外は reasoning_content) */
  readonly #reasoningKey: 'reasoning' | 'reasoning_content';
  /** API が返した直近の入力トークン数 (auto-compact の判断に使う) */
  #lastInputTokens: number | undefined;
  /** 直近の要約。次の compact はこれを更新する */
  #lastSummary: string | undefined;
  /** 要約に連続で失敗した回数 */
  #compactFailures = 0;
  /** 最後に compact したあとの履歴の長さ (無進捗での再 compact を避ける) */
  #compactedAtLen = 0;
  /** モデルカタログから引いたコンテキストウィンドウ (解決は 1 回だけ) */
  #catalogWindowTokens: Promise<number | undefined> | undefined;
  /** 直近に使ったウィンドウの出どころ (変わったときだけログに出す) */
  #windowSource: 'config' | 'catalog' | 'default' | undefined;

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
    // 最初のリクエストでカタログ待ちにならないよう、先に引き始めておく
    if (config.contextWindowTokens === undefined) void this.#contextWindow();
  }

  setSystemPrompt(text: string): void {
    this.#systemPrompt = text;
  }

  /** サーバー/チャンネルの文脈をシステムプロンプトに追記する */
  setServerContext(guildName: string, channelName: string): void {
    this.#systemPrompt += `\nあなたが参加してるサーバーは "${guildName}"、チャンネルは "${channelName}" です。`;
  }

  /**
   * assistant メッセージの思考過程を、プロバイダが要求するフィールド名で再送する。
   * 思考過程が無かったターンはフィールドごと省く (空文字を送ると、そのフィールドを
   * 知らないプロバイダ (OpenAI 公式など) では未知の引数として 400 になる)。
   */
  #withReasoning(m: OpenAI.Chat.ChatCompletionMessageParam): OpenAI.Chat.ChatCompletionMessageParam {
    if (m.role !== 'assistant') return m;
    const r = (m as { reasoning?: unknown }).reasoning;
    const { reasoning: _r, ...rest } = m as unknown as Record<string, unknown>;
    if (typeof r !== 'string' || r === '') return rest as unknown as OpenAI.Chat.ChatCompletionMessageParam;
    return { ...rest, [this.#reasoningKey]: r } as unknown as OpenAI.Chat.ChatCompletionMessageParam;
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

  /**
   * コンテキストウィンドウを決める。設定 > モデルカタログ > 既定 (128k)。
   * カタログは 1 セッションにつき 1 回だけ引く (DB 自体は model-meta 側でキャッシュされる)。
   */
  async #contextWindow(): Promise<{ tokens: number, source: 'config' | 'catalog' | 'default' }> {
    const configured = this.#config.contextWindowTokens;
    if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
      return { tokens: configured, source: 'config' };
    }
    this.#catalogWindowTokens ??= fetchModelListCached(this.#config.baseUrl, this.#config.apiKey)
      .then(list => contextLengthFor(list, this.#config.model))
      .catch(() => undefined);
    const tokens = await this.#catalogWindowTokens;
    if (tokens !== undefined && Number.isFinite(tokens) && tokens > 0) return { tokens, source: 'catalog' };
    return { tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'default' };
  }

  /** auto-compact の予算 (トークン)。コンテキストウィンドウの 75% */
  async #contextBudget(): Promise<number> {
    const { tokens, source } = await this.#contextWindow();
    if (this.#windowSource !== source) {
      this.#windowSource = source;
      log(`compact: コンテキストウィンドウ ${tokens.toLocaleString()} トークン (${source}) → 予算 ${Math.round(tokens * COMPACT_AT_SHARE).toLocaleString()}`);
    }
    if (!Number.isFinite(tokens) || tokens <= 0) return 0;
    return Math.round(tokens * COMPACT_AT_SHARE);
  }

  /**
   * コンテキストが予算を超えていたら、古い方を要約 1 通に置き換える。
   * 要約に失敗したら古い方を捨てる (リクエストは通すが、文脈は失われる)。
   * 連続で失敗したら、そのセッションでは自動 compact を諦める。
   */
  async #maybeCompact(): Promise<void> {
    const budget = await this.#contextBudget();
    if (budget <= 0) return;
    if (this.#history.length <= this.#compactedAtLen) return;
    if (contextTokens(this.#history, this.#lastInputTokens) < budget) return;

    // 1) まず古いツール出力を削る。要約よりずっと安く、原文の頭は残る (teapot の maybePrune)
    const pruned = this.#pruneOldToolResults(budget, true);
    if (pruned > 0 && contextTokens(this.#history, this.#lastInputTokens) < budget) {
      this.#compactedAtLen = this.#history.length;
      return;
    }

    // 2) それでも足りなければ、古い方を要約 1 通に置き換える。
    //    要約に失敗しても、捨ててでも必ず予算に収める (縮めないと次のリクエストが 400 で
    //    セッションごと捨てられる。実測: 1M のモデルに 1,885,392 トークンを送って 400)。
    //    回数では打ち切らない (打ち切ると、そのターンの残りが無防備になる)
    for (;;) {
      const before = contextTokens(this.#history, this.#lastInputTokens);
      if (before < budget) return;
      const lengthBefore = this.#history.length;

      const cut = this.#keepRecentCut(budget);
      if (cut <= 0) {
        // 直近の tool 交換しか残っておらず、履歴としてはもう削れない。
        // 保護範囲より前にもう無いなら、保護範囲も削る
        if (!this.#pruneOldToolResults(budget, true, 0)) return;
        continue;
      }
      // 残す側だけで予算を使い切っているなら、要約しても収まらない (要約を呼ぶと、
      // 1 件消したうえに要約の文面で逆に増える)。まず保護範囲も削り、それでも駄目なら捨てる
      const keptOverBudget = contextTokens(this.#history.slice(cut)) >= budget;
      if (keptOverBudget && this.#pruneOldToolResults(budget, true, 0) > 0) continue;

      const summarizable = !keptOverBudget && this.#compactFailures < MAX_COMPACT_FAILURES;
      const { summary, cut: appliedCut } = summarizable
        ? await this.#summarizeWithShrink(cut)
        : { summary: '', cut };

      if (summary !== '') {
        this.#lastSummary = summary;
        this.#compactFailures = 0;
        this.#history = [
          { role: 'user', content: summaryMessage(summary, appliedCut) },
          ...this.#history.slice(appliedCut),
        ];
      } else {
        // 要約できなかった (または連続失敗で諦めた)。要約の代わりに古い方を捨てる。
        // 直近 (keepRecentCut が残した分) はそのまま残る
        this.#history = [
          { role: 'user', content: droppedMessage(appliedCut) },
          ...this.#history.slice(appliedCut),
        ];
      }

      // compact は履歴の書き換えなので、失敗時の巻き戻し先も今の履歴に付け替える
      this.#historyBeforeTurn = [...this.#history];
      this.#compactedAtLen = this.#history.length;
      this.#lastInputTokens = undefined;
      log(`compact: ${appliedCut} 件を${summary === '' ? '破棄' : '要約'} (${before} → ${contextTokens(this.#history)})`);
      if (this.#history.length >= lengthBefore) return;
    }
  }

  /**
   * 古いツール出力を削る (teapot の `maybePrune` の移植)。
   * 直近 (予算と同じだけのトークン) は触らない。削った件数を返す。
   *
   * teapot は保護範囲を `budget * 2` 文字で数えるが、それは英語 (4 文字 / トークン) 前提で、
   * 日本語 (1.2 トークン / 文字) だと全履歴が保護範囲に入って 1 件も削れない。
   * ここではトークンで数える。
   */
  #pruneOldToolResults(budget: number, force: boolean, protectShare = 1): number {
    const estimate = contextTokens(this.#history, this.#lastInputTokens);
    if (!force && estimate < budget * PRUNE_AT_SHARE) return 0;

    const protectTokens = budget * protectShare;
    let seen = 0;
    let boundary = this.#history.length;
    for (let i = this.#history.length - 1; i >= 0; i--) {
      seen += estimateTokens([this.#history[i]!]);
      boundary = i;
      if (seen >= protectTokens) break;
    }

    const callerTool = new Map<string, string>();
    for (const message of this.#history) {
      const calls = (message as { tool_calls?: Array<{ id: string, function: { name: string } }> }).tool_calls;
      for (const call of calls ?? []) callerTool.set(call.id, call.function.name);
    }

    let count = 0;
    let saved = 0;
    for (let i = 0; i < boundary; i++) {
      const message = this.#history[i]!;
      if (message.role !== 'tool' || typeof message.content !== 'string') continue;
      const name = callerTool.get((message as { tool_call_id?: string }).tool_call_id ?? '') ?? '';
      if (!PRUNABLE_TOOLS.has(name) && !name.startsWith('mcp__')) continue;
      if (message.content.length <= PRUNE_MIN_CHARS) continue;
      const length = message.content.length;
      saved += length - PRUNE_KEEP_CHARS;
      message.content = `${message.content.slice(0, PRUNE_KEEP_CHARS)}\n…[pruned ${length.toLocaleString()} bytes of ${name || 'tool'} output]`;
      count++;
    }
    if (count > 0) log(`compact: 古いツール出力 ${count} 件を削った (${saved.toLocaleString()} 文字)`);
    return count;
  }

  /** 直近を生のまま残す位置。tool 呼び出しの対応は割らない */
  #keepRecentCut(budget: number): number {
    const keepTokens = Math.min(KEEP_RECENT_TOKENS, Math.max(1, Math.floor(budget / 4)));
    let cut = -1;
    let kept = 0;
    for (let i = this.#history.length - 1; i >= 1; i--) {
      kept += estimateTokens([this.#history[i]!]);
      if (kept > keepTokens) break;
      cut = i;
    }
    // 直近の 1 通だけで予算を使い切るような巨大なメッセージでも、必ず前進させる
    if (cut < 1) cut = this.#history.length - 1;
    return safeCutPoint(this.#history, cut);
  }

  /**
   * 古い方を要約する。窓に収まらず失敗したら、対象を 6 割に縮めて 1 回だけやり直す
   * (teapot の `SUMMARIZE_SHRINK`)。それでも駄目なら空文字を返し、呼び出し側が捨てる。
   */
  async #summarizeWithShrink(cut: number): Promise<{ summary: string, cut: number }> {
    let attemptCut = cut;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const summary = stripAnalysis(await this.#summarize(this.#history.slice(0, attemptCut)));
        if (summary !== '') return { summary, cut: attemptCut };
      } catch (err) {
        log('compact: summarize failed:', err instanceof Error ? err.message : err);
      }
      const smaller = safeCutPoint(this.#history, Math.max(1, Math.floor(attemptCut * 0.6)));
      if (smaller <= 0 || smaller >= attemptCut) break;
      attemptCut = smaller;
    }
    this.#compactFailures += 1;
    return { summary: '', cut: attemptCut };
  }

  /** 古い履歴を 1 通のメモに圧縮する。前回のメモがあれば更新させる */
  async #summarize(old: History): Promise<string> {
    const previous = this.#lastSummary;
    const response = await this.#client.chat.completions.create({
      model: this.#config.model,
      messages: [
        ...(this.#systemPrompt ? [{ role: 'system' as const, content: this.#systemPrompt }] : []),
        ...old.map(m => this.#withReasoning(m)),
        {
          role: 'user' as const,
          content: (previous !== undefined ? `<conversation_checkpoint>\n${previous}\n</conversation_checkpoint>\n\n` : '')
            + COMPACT_INSTRUCTION
            + (previous !== undefined ? COMPACT_UPDATE_INSTRUCTION : ''),
        },
      ],
      stream: false,
    }, { timeout: 120_000 });
    return response.choices?.[0]?.message?.content ?? '';
  }

  /** 1回分の chat/completions をストリーミング実行し、必要ならツールを実行する */
  async *#complete(meta: unknown): AsyncGenerator<AIEvent> {
    // ツールを大量に呼ぶターンは 1 回で窓を食い潰すので、毎リクエストの前に見る
    await this.#maybeCompact();

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
          this.#lastInputTokens = usage.prompt_tokens ?? undefined;
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

        let result: [true, unknown] | [false, { error: string }];
        try {
          result = this.#tools !== undefined && this.#tools.execute !== undefined
            ? await this.#tools.execute(c.name, args, meta)
            : [false, { error: 'ツールが利用できません' }] as const;
        } catch (err) {
          // 例外をここで止める。外に漏らすと assistant(tool_calls) だけが履歴に残り、
          // 以降のリクエストが「tool の応答が無い」で 400 になる
          result = [false, { error: err instanceof Error ? err.message : String(err) }];
        }

        yield {
          type: 'tool-result',
          data: { name: c.name, ok: result[0], value: result[0] ? undefined : result[1] },
        };

        // JSON.stringify(undefined) は undefined になり、content の無い tool メッセージになる
        const raw = JSON.stringify(result[1]) ?? 'null';
        this.#history.push({
          role: 'tool',
          content: raw.length > MAX_TOOL_RESULT_CHARS
            ? `${raw.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[ツール出力が長いため ${(raw.length - MAX_TOOL_RESULT_CHARS).toLocaleString()} 文字を省略しました]`
            : raw,
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
      // 空応答。ツールを実行したターンは、その呼び出しと結果を残す (次のリクエストで
      // モデルが「何を調べたか」を失う)。何も起きていないターンだけ巻き戻す
      const ranTool = this.#history.slice(this.#historyBeforeTurn.length + 1).some(m => m.role === 'tool');
      if (!ranTool) this.#history = this.#historyBeforeTurn;
    }

    if (usageEvent !== undefined) yield usageEvent;
    yield { type: 'done', messageIds: [this.id] };
  }
}
