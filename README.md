# mizuki-rakutenai

## OpenAI互換APIの429対策

追加の `.env` 設定は不要です。HTTP 429 の場合のみ最大3回再試行します。
`Retry-After`（秒数 / HTTP日時）を優先し、無い場合は1・2・4秒に
最大1秒のランダムな待機を加えて再試行します。
サーバーが60秒を超える待機を要求した場合は、早期再送せずエラーを返します。
残高・クォータ不足 (`insufficient_quota` / `billing_hard_limit_reached`) は再試行しません。

対象はOpenAI互換APIのHTTPリクエストのみです。ストリーミング開始後の切断や
実行済みツールをやり直すことはありません。RakutenAI側には影響しません。
複数ユーザー間の全体的な送信レート制御や、残高不足の解消を行う機能ではありません。

検証: `node --test tests/ratelimit.test.ts` / `pnpm exec tsc --noEmit`

## LICENSE

project: AGPL-3.0-or-later

under `mexc-proto/`: Apache-2.0
