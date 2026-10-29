# AGENTS.md

Discord / Fluxer で動くボット「瑞稀 (mizuki)」のリポジトリ。TypeScript をビルドせず
`node` で直接実行します。ドキュメント (`README.md`、`docs/*.md`) は日本語で書きます。

## コマンド

```sh
pnpm install
pnpm test        # node --test "tests/*.test.ts"
pnpm typecheck   # tsc --noEmit
```

`pnpm start` は `node --env-file=.env index.ts` で、Discord / Fluxer の実トークンが要ります。
**PR を出す前に `pnpm test` と `pnpm typecheck` の両方を緑にしてください**
(`.github/workflows/ci.yml` が main への push と PR で同じ2つを回します)。
テストはリポジトリのルートから実行します (`./data/` を相対パスで読むため)。

## 構成

```
index.ts          エントリーポイント。setupXxx() を呼んでログインするだけ
src/clients.ts    discord.js の Client 2つ (Discord / Fluxer) とボットのユーザー ID
src/utils.ts      splitLongString、createFileFromUrl などの共通処理
src/ai/           AI アシスタント
src/fluxsync/     Discord ⇔ Fluxer のチャンネル同期
src/logging/      サーバーログ用 webhook
src/anka.ts, src/coinwatch.ts, src/miq.ts   個別機能
tests/            node:test
emojisync.ts, purge.js, mexc.ts, mexc-proto/   単発スクリプトと MEXC クライアント
docs/             機能ごとの仕様 (ai.md が AI の一次資料)
```

- 機能は `setupXxx()` で自分のイベントハンドラを登録します。`index.ts` はそれを呼ぶだけです
  (例外: `src/miq.ts` は import された時点で登録)。
- Fluxer は Discord 互換 API なので、同じ discord.js の `Client` を接続先だけ差し替えて使います。
- AI のプロバイダは `ChatSession` (`src/ai/types.ts`) を実装し、`PROVIDERS` と
  `createChatSession` (`src/ai/mod.ts`) に足します。RakutenAI 側のイベント型に合わせてあります。
- AI ツールは `src/ai/tools.ts` の `aitools` に登録します。`$explain` 引数は `toOpenAITools` が
  自動で足し、`src/ai/openai.ts` が実行前に取り除いて進捗表示 (`tool-call-detail`) に使います。
  ツールの `execute` には渡ってこないので、スキーマにも書かないでください。

## 規約

- ファイルの先頭に `// SPDX-License-Identifier: AGPL-3.0-or-later` (`mexc-proto/` は Apache-2.0)。
- `.editorconfig`: スペース2つ、LF、UTF-8、行末の空白なし、末尾の改行あり。
- `tsconfig.json` は `erasableSyntaxOnly` + `verbatimModuleSyntax` です。
  - `enum`、`namespace`、コンストラクタのパラメータプロパティ (`constructor(private x: T)`) は使えません
    (型を消すだけでは実行できないため、Node が直接実行できない)。代替は `const` オブジェクト + union 型。
  - 型だけの import は `import type` にします。
  - import には拡張子 `.ts` を付けます。
- フォーマッタとリンタはありません。周りのコードの書き方 (2スペース、シングルクォート、
  末尾カンマあり、`export const f = (): T => {}`) に合わせてください。
- コメントと docs は日本語、識別子は英語です。新しいコメントを足すときは、そのファイルの
  既存コメントの言語に合わせます (`src/ai/embeds.ts` や `src/ai/ratelimit.ts` は英語)。
- 依存を足すのは最終手段です。CI は `pnpm install --frozen-lockfile` なので、
  追加したら `pnpm-lock.yaml` も同じコミットに入れてください。
- コミットは `<領域>: <日本語の要約>` (例: `ai: openai: reasoning を返す`)。
  変更した振る舞いが `docs/*.md` に書いてある場合は、同じコミットで docs も直します。

## テストの書き方

`tests/*.test.ts` は `node:test` + `node:assert/strict` です。
テストフレームワークを足さないでください。外部 API は叩かず、`t.mock.method(globalThis, 'fetch', ...)`
で SSE を返すのがこのリポジトリの流儀です (`tests/openai-chat.test.ts` の `mockFetch` を参照)。

注意点:

- `tests/ai-tools.test.ts` はモジュール読み込み時に環境変数を見て有効なツールを決めるため、
  `process.env` を先に設定してから動的 `import()` しています。この順序を崩すとツールが消えます。
- `src/ai/prefs.ts` と `src/fluxsync/state.ts` は import 時に `./data/` を読みます。
  ファイルが無ければ空で開始するので、CI ではそのまま動きます。
- OpenAI SDK (v7) は `fetch` に `Headers` インスタンスを渡します。素の object として読むと
  ヘッダーが `undefined` になるので、テストでは `new Headers(init.headers)` に通してください。

## 触るときに知っておくべきこと

- **429 の再試行は `src/ai/ratelimit.ts` に一本化**しています。SDK 側の再試行は
  `maxRetries: 0` で止め、`fetch` に `fetchWithRateLimitRetry` を差し込んでいます。
  SDK の既定 (2回・独自バックオフ) に戻すと、docs に書いた方針 (最大3回、`Retry-After` 尊重、
  60秒超は諦める、quota は再送しない、5xx・接続断は短い待ちで再試行、描画失敗の 400 は1回だけ)
  が効かなくなります。`tests/ratelimit.test.ts` がこれを見ています。
- **reasoning** は OpenAI 公式のスキーマに無いフィールドです。`reasoning_content` (DeepSeek 系) と
  `reasoning` (OpenRouter) の両方を読み、`reasoning-start` → `reasoning-delta` として流します。
  返信本文には入れませんが、プロバイダが要求する場合は会話履歴の assistant メッセージに
  `reasoning_content` / `reasoning` として再送します。**ツール呼び出しを含むメッセージだけは、
  そのモデルが思考過程を返すなら空でも必ず付けます** (直前の思考を要求するプロバイダがある)。
  思考過程を一度も返さないモデルには付けません (空文字は未知の引数として 400 になる)。
- **会話履歴の不変条件** (`src/ai/openai.ts`): 履歴の先頭は必ず `user` メッセージ。
  ツール呼び出しとその結果の間で切らない (`assistant` の `tool_calls` には必ず対応する `tool`
  メッセージを積む。ツールが例外を投げてもエラーを `tool` 本文にして積む)。
  ツールが何もしていないターンが空応答で終わったときだけ `#historyBeforeTurn` まで巻き戻す。
  `tests/openai-history.test.ts` と `tests/openai-tool-history.test.ts` が守っています。
- **履歴はトークン数で auto-compact する** (`src/ai/compact.ts`)。コンテキストウィンドウの
  75% で古い方を要約 1 通に置き換え、直近 15,000 トークンは生で残します。件数で切る旧実装は
  廃止しました (ツールを多用する 1 ターンで 80 メッセージを超え、前のターンが丸ごと消えるため)。
  切れ目が `tool_calls` と `tool` の間にならないよう `safeCutPoint` を通すこと。
  順番は teapot と同じで、**まず古いツール出力を削り** (`#pruneOldToolResults`)、収まらなければ
  要約、要約が駄目でも破棄して必ず予算に収める (縮めないと 400 でセッションごと捨てられる)。
  保護範囲はトークンで数える (文字数で数えると日本語では全履歴が保護範囲に入って削れない)。
- **コンテキストウィンドウはモデルカタログから引く** (`src/ai/model-meta.ts`、teapot の移植)。
  設定 > プロバイダの `/models` の `context_length` > models.dev の `limit.context` > 128k の順。
  カタログはホストで引き、値はプロバイダ優先・models.dev は穴埋め (両方欠けることがある)。
- **記憶は `src/memory/`**。ChatGPT 方式 (保存した事実を毎ターン注入。検索しない) で、
  サーバーごとに `data/memory/<guildId>.json`。書き込みは `memory` ツールに一本化し、
  Notion を直接叩かせない (重複する)。**ローカルに DB は作らない**方針 (sakana 式の木を
  入れるときは Notion 側に置く)。
- **MCP の結果は text だけではない** (`src/ai/mcp.ts` の `resultText`)。`resource` /
  `resource_link` / `image` / `audio` / `structuredContent` をテキストにする。text だけを見ると
  GitHub MCP の `get_file_contents` の中身が消える (実際にこれで読めなかった)。
- **メッセージ検索は Discord の検索 API** (`search_messages`)。bot でも使える
  (`GET /guilds/{id}/messages/search`、要 `READ_MESSAGE_HISTORY`)。使えないときだけ
  チャンネルを遡る自前実装に落ちる。クエリの解釈は `src/ai/search-query.ts`。
- **返信の整形は `src/utils.ts`**: `suppressEmbeds` (URL を `<...>` で囲んで embed を止める。
  コード内は触らない) と `splitLongString` (1500 文字分割。コードブロックはフェンスを付け直して壊さない)。
- **docs が仕様書です**。`docs/ai.md` にはプロバイダの違い、文脈の組み立て、添付ファイルの扱い、
  ツール一覧、429 対策が書いてあります。コードを読む前にここを読むのが速いです。
- ハードコードされたサーバー ID・チャンネル ID・ロール ID が多数あります
  (`docs/development.md` の表)。別サーバー向けの一般化は求められていません。
- `src/ai/mod.ts` は 1 チャンネル × 1 ユーザー単位のセッションを Promise チェーンで直列化します。
  非同期の処理を足すときは、この順序保証と `finally` のジョブ数デクリメントを壊さないでください。

## ドキュメント

| ファイル | 内容 |
|---|---|
| `docs/setup.md` | 必要なもの、環境変数、起動 |
| `docs/ai.md` | AI アシスタントの仕組み (プロバイダ、文脈、添付、ツール、429) |
| `docs/commands.md` | コマンド一覧 |
| `docs/fluxsync.md` | チャンネル同期 |
| `docs/features.md` | サーバーログ、安価、コイン監視、MiQ |
| `docs/scripts.md` | 単発スクリプト |
| `docs/development.md` | ディレクトリ構成、ハードコードされた ID、テストの一覧 |
