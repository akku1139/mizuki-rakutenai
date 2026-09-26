# セットアップと起動

## 必要なもの

- Node.js (TypeScript を直接実行できるバージョン。v22.18 以降を想定)
  - ビルド工程はなく、`index.ts` を `node` でそのまま実行します
- pnpm (`package.json` の `packageManager` は `pnpm@10.25.0`)
- Discord のボットトークン
  - Gateway Intents: Guilds, Guild Messages, Message Content, Guild Members,
    Guild Expressions, Guild Message Reactions
  - Message Content と Server Members は Developer Portal で Privileged Intent の有効化が必要です
- Fluxer のボットトークン

## インストール

```sh
pnpm install
cp .env.example .env
```

`@evex/rakutenai` は JSR から取得します (`jsr:^0.1.19`)。

## 環境変数

`.env` に記入します。`.env` は `.gitignore` 済みです。

### 必須

| 変数 | 用途 |
|---|---|
| `DISCORD_TOKEN` | Discord ボットのトークン |
| `FLUXER_TOKEN` | Fluxer ボットのトークン |
| `DISCORD_LOG_WEBHOOK` | Discord 側のサーバーログを送る webhook の URL |
| `FLUXER_LOG_WEBHOOK_ID` | Fluxer 側のサーバーログを送る webhook の ID |
| `FLUXER_LOG_WEBHOOK_TOKEN` | 同じ webhook のトークン |

`DISCORD_LOG_WEBHOOK` が未設定だと起動時に例外で落ちます。
`FLUXER_LOG_WEBHOOK_ID` / `FLUXER_LOG_WEBHOOK_TOKEN` が未設定だと、Fluxer 側のログ送信が失敗します。

### 任意

| 変数 | 既定値 | 用途 |
|---|---|---|
| `AI_PROVIDER` | `rakutenai` | ユーザーが `aimodel` で選んでいない場合に使う AI プロバイダ (`rakutenai` / `openai`) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 互換 API のベース URL (末尾の `/` は付けない) |
| `OPENAI_API_KEY` | (空) | OpenAI 互換 API のキー |
| `OPENAI_MODEL` | `gpt-4o-mini` | 使用するモデル名。返信の末尾にもこの名前が表示されます |
| `READABILITY_ENDPOINT` | なし | 設定すると AI ツール `read_web` が有効になります |
| `SEARCH_ENDPOINT` | なし | 設定すると AI ツール `search_web` が有効になります |
| `OPENMIQ_TOKEN` | なし | MiQ 機能で使う API キー。未設定のまま `make` を使うと失敗します |

OpenRouter など OpenAI 互換のサービスは `OPENAI_BASE_URL` を差し替えて使えます。
リクエストには OpenRouter 向けのヘッダー (`HTTP-Referer`、`X-OpenRouter-Title` など) が付きます。

`READABILITY_ENDPOINT` と `SEARCH_ENDPOINT` のリクエスト形式は [ai.md](ai.md#ツール-openai-のみ) を参照してください。

## 起動

```sh
pnpm start   # node --env-file=.env index.ts
```

本番運用では `start.sh` を使います。

```sh
./start.sh
```

`start.sh` は次の処理を無限に繰り返します。

1. `git pull` で最新のコードを取得する
2. `node --env-file=.env index.ts` で起動する
3. 終了したら10秒待つ

そのため、デフォルトブランチに push した変更は、次にボットが再起動したときに反映されます。
依存パッケージは自動では更新されないので、`package.json` を変えたときは手動で `pnpm install` が必要です。

## `data/` に保存されるもの

実行時に `./data/` が使われます (`.gitignore` 済み)。ファイルが無くても起動できます。

| ファイル | 内容 |
|---|---|
| `data/ai_prefs.json` | ユーザー ID ごとの AI プロバイダ設定 (`aimodel` コマンドで保存) |
| `data/fluxersync_fluxer.json` | Fluxer チャンネル → Discord チャンネルの同期設定と webhook |
| `data/fluxersync_discord.json` | Discord チャンネル → Fluxer チャンネルの同期設定と webhook |

`fluxersync_*.json` には webhook のトークンが含まれるので、取り扱いに注意してください。

## 再起動で消えるもの

次の状態はメモリ上にしか持っていないため、再起動するとリセットされます。

- AI の会話履歴 (チャンネル × ユーザーごと)
- 進行中の安価
- チャンネル同期で使うメッセージ ID の対応表 (再起動前のメッセージへの返信とリアクションは同期されません)
- コイン監視で集計中の出来高
