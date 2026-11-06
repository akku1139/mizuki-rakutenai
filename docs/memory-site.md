# 記憶Wiki

`src/memory/wiki.ts` は、既存の `data/memory/<guildId>.json` を読む小さなWikiです。
Sakana の「サーバー別公開範囲・出典・年表・検索」を取り入れます。
ローカルDB、Cloudflare D1、差分同期は増やさず、保存した事実を記事単位として使います。
長い記録の正本は引き続き Notion です。Notion のページ全文やSakanaの記憶木は複製しません。

## 設定

`data/config.json` に次を追加して再起動します。未設定なら起動しません。

```json
{
  "memorySite": {
    "port": 8081,
    "origin": "https://mizuki-wiki.example.com",
    "guilds": { "1255359848644608035": "members" },
    "clientId": "DiscordアプリのID",
    "clientSecret": "Discordアプリのシークレット",
    "sessionSecret": "32文字以上のランダムな秘密文字列"
  }
}
```

`127.0.0.1:8081` にだけ待ち受けます。HTTPS のリバースプロキシを設定し、
Discord Developer Portal の OAuth2 Redirects に `<origin>/auth/callback` を登録してください。
本番のDNS・プロキシ・OAuth設定はPRからは変更しません。

`guilds` の値はサーバーごとに `off` / `members` / `public` を選べます。

- `off` / 未登録のサーバー: 404
- `members`: Discord OAuth (`identify guilds`) でサーバー加入を確認
- `public`: ログイン無し。運営者が明示的に設定したときだけ公開

メンバー限定公開には全ての認証設定が必須です。不足していると起動を拒否します。
OAuth の state は署名して検証します。アクセストークンは加入確認後に失効させ、保存しません。
セッションはサーバー別の署名付き HttpOnly / Secure / SameSite=Lax Cookie で、有効期限は15分です。
退出はセッションの期限まで反映されない場合があります。

## 読めるもの

- `/<guildId>/wiki`: 記憶一覧
- `/<guildId>/wiki/<factId>`: 個別の事実と出典
- `?q=語`: 本文・タグのAND検索
- `?month=YYYY-MM`: 月ごとの年表 (事実を保存した日付)
- タグを押すと同じ話題を検索

表示時にDiscordで出典を確認し、全員とbotの両方が読めるチャンネルの、存在する発言に
出典を持つ記憶だけを表示します。非公開・NSFW・ブラックリスト・スレッド・削除済み・
別サーバー・出典無しの記憶は表示しません。元の発言が削除されても記憶そのものは消しません。
出典の確認ができなければ表示しないため、API障害中は記事が減ったり503になる場合があります。

本文・タグはHTMLエスケープし、出典URLは同じサーバーのDiscordメッセージURLだけを許可します。
CSP、`noindex,nofollow`、`Cache-Control: no-store` を付けます。
公開前に保存済みの記憶の内容を確認してください。公開の判断は設定を行う運営者が行います。

## 検証

`tests/wiki.test.ts` で検索・年表・エスケープ、出典の公開範囲、Cookieの改ざん、OAuthのstate、
メンバー確認、別サーバーのセッションを使えないことを検査します。外部APIはモックします。
実際のDiscord OAuthログインと本番のHTTPS配信は、運用設定後に確認してください。

参考: [Sakanaの記憶](https://github.com/tako0614/sakana/blob/main/docs/memory-tree.md)、
[Worker](https://github.com/tako0614/sakana/blob/main/worker/README.md)。
