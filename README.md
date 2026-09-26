# mizuki-rakutenai

Evex の Discord サーバーと Fluxer サーバーで動いているボット「瑞稀 (mizuki)」です。
メンションで応答する AI アシスタントを中心に、Discord と Fluxer のチャンネル同期や
サーバーログなどの機能を1つのプロセスで提供します。

## 機能

| 機能 | 動作するサービス | 概要 | 詳細 |
|---|---|---|---|
| AI アシスタント | Discord / Fluxer | メンションすると瑞稀が返信します。RakutenAI と OpenAI 互換 API をユーザーごとに切り替えられます | [docs/ai.md](docs/ai.md) |
| チャンネル同期 (fluxsync) | Discord ⇔ Fluxer | webhook でメッセージとリアクションを双方向に同期します | [docs/fluxsync.md](docs/fluxsync.md) |
| サーバーログ | Discord / Fluxer | メッセージの削除・編集、メンバーの参加・退出を webhook に記録します | [docs/features.md](docs/features.md#サーバーログ) |
| 安価 | Discord | `>>n` と書くと、n 件後の投稿者を通知します | [docs/features.md](docs/features.md#安価) |
| コイン監視 | Discord | MEXC の 114514USDT の約定を30秒ごとに報告します | [docs/features.md](docs/features.md#コイン監視) |
| MiQ | Fluxer | 返信先のメッセージから引用画像を作ります | [docs/features.md](docs/features.md#miq) |

コマンドの一覧は [docs/commands.md](docs/commands.md) にまとめています。

## クイックスタート

```sh
pnpm install
cp .env.example .env   # トークンなどを記入する
pnpm start   # node --env-file=.env index.ts
```

本番では `start.sh` を使います。`git pull` してから起動し、プロセスが終了したら10秒後に
再起動する、を繰り返します。

詳しい手順と環境変数は [docs/setup.md](docs/setup.md) を参照してください。

## ドキュメント

- [docs/setup.md](docs/setup.md): 必要なもの、環境変数、起動、`data/` に保存されるもの
- [docs/commands.md](docs/commands.md): コマンド一覧
- [docs/ai.md](docs/ai.md): AI アシスタントの仕組み (プロバイダ、文脈、ツール、429 対策)
- [docs/fluxsync.md](docs/fluxsync.md): Discord ⇔ Fluxer チャンネル同期
- [docs/features.md](docs/features.md): サーバーログ、安価、コイン監視、MiQ
- [docs/scripts.md](docs/scripts.md): 単発実行のスクリプト (`emojisync.ts`、`purge.js`)
- [docs/development.md](docs/development.md): ディレクトリ構成、ハードコードされた ID、テスト

## ライセンス

- プロジェクト全体: AGPL-3.0-or-later
- `mexc-proto/` 以下: Apache-2.0
