# 開発

## ディレクトリ構成

```
index.ts            エントリーポイント。各機能を登録して Discord と Fluxer にログインする
mexc.ts             MEXC の WebSocket クライアント
mexc-proto/         MEXC の protobuf 生成コード (Apache-2.0)
src/
  clients.ts        Discord と Fluxer のクライアント、ボットのユーザー ID
  utils.ts          文字列の分割などの共通処理
  ai/               AI アシスタント (docs/ai.md)
  fluxsync/         チャンネル同期 (docs/fluxsync.md)
  logging/          サーバーログ (docs/features.md)
  anka.ts           安価 (docs/features.md)
  coinwatch.ts      コイン監視 (docs/features.md)
  miq.ts            MiQ (docs/features.md)
tests/              テスト
emojisync.ts        絵文字移行スクリプト (docs/scripts.md)
purge.js            一括削除ボット (docs/scripts.md)
start.sh            本番用の起動ループ
```

## 設計

- Discord と Fluxer は、どちらも discord.js の `Client` で扱います。
  Fluxer は Discord 互換の API を持つので、REST と WebSocket の接続先を差し替えるだけで動きます (`src/clients.ts`)。
- 各機能は `setupXxx()` で自分のイベントハンドラを登録します。`index.ts` はそれを呼んでログインするだけです。
  `src/miq.ts` だけは import した時点でハンドラを登録します。
- AI のプロバイダを追加するには、`ChatSession` (`src/ai/types.ts`) を実装し、
  `PROVIDERS` と `createChatSession` (`src/ai/mod.ts`) に追加します。
  イベントの型は `@evex/rakutenai` の `Thread.sendMessage` の戻り値と同じ形にしています。
- AI ツールを追加するには、`src/ai/tools.ts` に `AITool` を定義して `aitools` に登録します。

## ハードコードされた値

次の ID や URL はコードに直接書かれています。別のサーバーで動かすときは書き換えが必要です。

| 値 | 場所 | 用途 |
|---|---|---|
| `1379433738143924284` | `src/clients.ts` | Discord の瑞稀のユーザー ID (コマンド判定、システムプロンプト) |
| `1493977173863738082` | `src/clients.ts` | Fluxer の瑞稀のユーザー ID |
| `1255359848644608035` | `src/logging/mod.ts`、`src/fluxsync/mod.ts`、`emojisync.ts` | Evex の Discord サーバー ID |
| `1493971310876907609` | `src/logging/mod.ts`、`src/fluxsync/mod.ts`、`emojisync.ts` | Evex の Fluxer サーバー ID |
| `1493964990916384451` | `src/fluxsync/mod.ts` | `=syncsetup` を実行できる Fluxer ユーザー |
| `1468910632119308289` | `src/coinwatch.ts` | コイン監視の投稿先チャンネル |
| `114514USDT` | `src/coinwatch.ts` | コイン監視の銘柄 |
| `1255803402898898964` | `purge.js` | `!purge` を実行できるロール |
| `https://api.fluxer.app` など | `src/clients.ts`、`src/logging/mod.ts`、`src/fluxsync/mod.ts` | Fluxer の API と CDN |
| `https://miq.otnc.dev` | `src/miq.ts` | MiQ の API |

## テストと型チェック

```sh
node --test tests/ratelimit.test.ts
pnpm exec tsc --noEmit
```

現在のテストは `tests/ratelimit.test.ts` だけで、429 の再試行と OpenAI 互換 API の添付ファイル処理を確認しています。

## コーディング規約

- ファイルの先頭に `// SPDX-License-Identifier: AGPL-3.0-or-later` を書きます
- `.editorconfig` に従います (スペース2つ、LF、UTF-8、末尾の改行あり)
- `tsconfig.json` は `erasableSyntaxOnly` を有効にしています。
  Node.js で直接実行するため、`enum` や `namespace` など、型を消すだけでは実行できない構文は使えません
- import には拡張子 `.ts` を付けます
