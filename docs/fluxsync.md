# Discord ⇔ Fluxer チャンネル同期 (fluxsync)

コードは `src/fluxsync/` にあります。

| ファイル | 役割 |
|---|---|
| `mod.ts` | メッセージとリアクションの転送、`=syncsetup` コマンド |
| `state.ts` | 同期設定 (`data/fluxersync_*.json`) の読み書き |

## 仕組み

同期する2つのチャンネルそれぞれに「Fluxer Sync」という webhook を作り、
相手側のメッセージをその webhook で投稿し直します。
投稿者名は `<ニックネームか表示名>#Discord` / `<ニックネームか表示名>#Fluxer`、アイコンは元の投稿者のサーバーアバターを優先し、無ければ既定の表示アバターを1024pxで使います。

同期設定は次の2つのファイルに保存されます。キーは送信元チャンネルの ID です。

- `data/fluxersync_fluxer.json`: Fluxer チャンネル → `{ whID, whToken, targetChannelID }`
- `data/fluxersync_discord.json`: Discord チャンネル → `{ whID, whToken, targetChannelID }`

`whID` と `whToken` はそのチャンネル自身に作った webhook、`targetChannelID` は相手側のチャンネルです。

## 設定方法

Fluxer 側のチャンネルで、次のコマンドを実行します。

```
=syncsetup <Discord チャンネル ID>
```

- 実行できるのは、コードに書かれた特定のユーザー (`1493964990916384451`) だけです
- 両方のチャンネルに webhook を作り、設定を保存して、2つのチャンネルへのリンクを返信します
- チャンネル ID が無いか、Discord のテキストチャンネルとして取得できない場合は、使い方を返信して何もしません
- 返信のリンクは Evex のサーバー ID を前提に組み立てています
- 同期の解除コマンドはありません。解除するには `data/fluxersync_*.json` から該当の項目を消して再起動します

## 同期されるもの

| 内容 | Discord → Fluxer | Fluxer → Discord |
|---|---|---|
| 本文 | ○ | ○ (2000文字で切り詰め) |
| 添付ファイル | ○ (ダウンロードして再アップロード。スポイラーも維持) | ○ |
| embed | ○ | ○ |
| スタンプ | 画像 URL を本文に追記 | 画像 URL を本文に追記 |
| カスタム絵文字 | 同名の絵文字に置き換え。無ければ `:name:` | 同名の絵文字に置き換え。無ければ `:name:` |
| 返信 | 返信として投稿 | Discord の webhook は返信できないので、`-# ↩ <元メッセージの URL>` を先頭に付ける |
| リアクション | ○ (追加と削除) | ○ (追加と削除) |
| メッセージの編集 | ○ | ○ (2000文字で切り詰め) |
| メッセージの削除 | ○ | ○ |
| メンション | 通知はしない | 通知はしない |

## 制限

- 返信とリアクションの同期には、メモリ上のメッセージ ID 対応表 (各方向最大5000件) を使います。
  再起動前のメッセージや古いメッセージへの返信・リアクションは同期されません。
- リアクションは、discord.js がメッセージをキャッシュしている間しかイベントが届きません。
- カスタム絵文字のリアクションは、相手側のサーバーに同名の絵文字がある場合だけ同期されます。
- リアクションを外す同期は、ボット自身のリアクション以外がすべて外れたときに行います。
- ユーザーの参加などのシステムメッセージは同期しません (TODO として残っています)。

## AI との関係

同期している Fluxer チャンネルで瑞稀に話しかけた場合、会話は Discord 側のチャンネル ID で管理されます。
詳しくは [ai.md](ai.md#会話の単位と順番) を参照してください。

## Fluxer互換性の確認

Fluxer本体のcommit `4d2df4f250d15fb04cf04f902678b03d392c0c46` の以下を確認しています。

- [WebhookRequestSchemas.ts](https://github.com/fluxerapp/fluxer/blob/4d2df4f250d15fb04cf04f902678b03d392c0c46/packages/schema/src/domains/webhook/WebhookRequestSchemas.ts): `avatar_url`、`message_reference`を受け付ける
- [WebhookService.ts](https://github.com/fluxerapp/fluxer/blob/4d2df4f250d15fb04cf04f902678b03d392c0c46/fluxer_api/src/api/webhook/WebhookService.ts): 外部アバターURLを取得し、メッセージの返信参照へ引き継ぐ
- [AvatarUtils.ts](https://github.com/fluxerapp/fluxer/blob/4d2df4f250d15fb04cf04f902678b03d392c0c46/fluxer_app/src/features/user/utils/AvatarUtils.ts) と [asset_path.rs](https://github.com/fluxerapp/fluxer/blob/4d2df4f250d15fb04cf04f902678b03d392c0c46/fluxer_media_proxy/src/server/asset_path.rs): `/avatars/<user>/<hash>.webp` と `/guilds/<guild>/users/<user>/avatars/<hash>.webp` のパス
- [MediaProxyImageSizes.ts](https://github.com/fluxerapp/fluxer/blob/4d2df4f250d15fb04cf04f902678b03d392c0c46/packages/constants/src/MediaProxyImageSizes.ts): `size=1024` を受け付ける

Fluxerの既定画像はフロントエンドの静的アセットで、`fluxerusercontent.com/embed/avatars/0.png` は
確認時に404でした。その互換外URLは生成せず、カスタムアバターがない場合はDiscord CDNの既定画像へ
フォールバックします。Fluxerの独自ブランド画像と完全には一致しない場合があります。
`tests/fluxsync-message.test.ts` ではmultipartのsnake_case・アバターURL・返信ID・メンション抑止を検査します。
本番のDiscord/Fluxer間での送信確認は別途必要です。
