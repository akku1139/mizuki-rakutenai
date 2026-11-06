# llama.cppによる自動参加

`src/ai/participation.ts` が、許可したチャンネルだけでローカルの `llama-server` の
`POST /v1/chat/completions` を呼びます。判定はJSON制約付きで、返事の本文は普段のAIプロバイダが作ります。
直接のメンションは判定器を通りません。Python・PyTorchのサイドカーは使いません。

## サーバーの起動

[llama.cpp公式配布](https://github.com/ggml-org/llama.cpp/releases) の `llama-server` と、
チャットテンプレートを持つGGUFモデルを用意してください。
例えば [ggml-org/Qwen3-0.6B-GGUF](https://huggingface.co/ggml-org/Qwen3-0.6B-GGUF) には
`Qwen3-0.6B-Q4_0.gguf` があります。既存のKev専用headをGGUFとして流用する実装ではありません。

```sh
llama-server -m /path/to/model.gguf --alias mizuki-participation --host 127.0.0.1 --port 8010 -c 4096
```

`response_format: { type: "json_object", schema: ... }` の制約付きJSONを扱える版を使います。
[公式サーバー仕様](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1chatcompletions-openai-compatible-chat-completions-endpoint) に対応したリクエストです。
Qwen3向けには `chat_template_kwargs.enable_thinking: false` を付け、判定の出力だけを最大128トークン生成します。
これは判定器の出力上限であり、本体のツール往復回数を制限するものではありません。

## botの設定

`data/config.json` の例です。未設定なら自動参加はしません。

```json
{
  "ai": {
    "participation": {
      "endpoint": "http://127.0.0.1:8010/v1/chat/completions",
      "channels": ["1437420093259907175"],
      "model": "mizuki-participation",
      "threshold": 0.85,
      "cooldownMs": 60000
    }
  }
}
```

最大13発言・末尾6000文字を渡し、`participate`・`confidence`・`replyTo` を受け取ります。
返信先は渡した人間のメッセージIDに限定します。返されたJSONも型・範囲・IDを検証します。
`confidence` はモデルの自己評価で、校正済みの確率ではありません。

bot発言・ブラックリスト・許可外のチャンネルは判定しません。チャンネルごとの同時判定・自動生成は1つです。
実際の返信成功後に既定で60秒待ち、取得・生成失敗ではクールダウンを消費しません。
APIエラー・15秒のタイムアウト・不正な応答・低い自己評価・参加不要の判定なら返答しません。
返信先が過去の発言でも、最新のトリガーと返信先の両方を生成へ渡します。

運営者が許可したチャンネルのログを扱うため、外部送信を避ける場合はループバックURLを指定してください。

## 検証範囲

`tests/participation.test.ts` でJSONスキーマ・許可範囲・型と値・返信先・クールダウンをAPIモックで検査します。
llama.cppの実バイナリによる推論と、日本語会話での判定精度・閾値は未検証です。
旧Kevの実行結果は、このllama.cpp経路の動作確認には数えません。
