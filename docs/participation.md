# ローカルモデルによる自動参加

`src/ai/participation.ts` が、許可したチャンネルだけでローカルKevの
`POST /v1/systemone` を呼びます。判定器は文章を生成せず、参加する確率と返信先を選びます。
実際の返事は普段のAIプロバイダが作ります。直接のメンションは判定器を通りません。

## INT8サーバー

Python 3.12または3.13を使い、[Kev公式リポジトリ](https://github.com/jaredpalmer/kev)を
独立した仮想環境にインストールしてください。PyPIの同名 `kev` は別物なので使いません。
Node側に依存パッケージは追加しません。

```sh
git clone https://github.com/jaredpalmer/kev.git
cd kev
git checkout 2074cc44256200bb37540103fa4572901faa10f3
python -m venv .venv
# Linux/macOS: . .venv/bin/activate
# Windows PowerShell: .venv/Scripts/Activate.ps1
python -m pip install "torch==2.8.0" --index-url https://download.pytorch.org/whl/cpu
python -m pip install ".[serve]"
cd /path/to/mizuki-rakutenai
python scripts/participation-server.py --self-check
python scripts/participation-server.py
```

`jaredpalmer/kev-0.6b` (Qwen3-0.6B、重みrevision `dece6dba8d43f0f7ded45e9f5b9df12474d90843`) を読み、backboneのLinearだけを動的INT8に変換します。
判定headと埋め込みはFP32のままです。公式サーバーを再利用し、`127.0.0.1:8009` だけに待ち受けます。
起動時に `INT8 Linear layers: N` を表示します。初回は重みのダウンロードと量子化で時間がかかります。
`/v1/models` の `dtype: float32` は残した埋め込み等の型であり、LinearのINT8を否定するものではありません。
PyTorch 2.10以降で削除予定のAPIを使うので2.8に固定しています。上げるときはtorchaoへ移行してください。
Qwen3.5等のハイブリッドモデルやGPU向けの量子化には対応しません。

## botの設定

`data/config.json` の例です。未設定なら自動参加はしません。

```json
{
  "ai": {
    "participation": {
      "endpoint": "http://127.0.0.1:8009/v1/systemone",
      "channels": ["1437420093259907175"],
      "model": "kev-latest",
      "threshold": 0.85,
      "cooldownMs": 60000
    }
  }
}
```

最大13発言・末尾6000文字を `state` に渡し、`noul` で参加確率、`choice` で返信先を選びます。
返信先は渡した人間のメッセージIDに限定します。bot発言、ブラックリスト、許可外のチャンネルは
判定しません。チャンネルごとの同時判定・自動生成は1つです。実際の返信に成功してから既定で60秒待ちます。
判定後の取得失敗・生成失敗ではクールダウンを消費しません。
生成のトリガーは最新の発言のまま保持し、Kevが選ぶ過去の返信先とは分けます。
最新の補足発言と選んだ返信先の両方を生成へ渡します。
APIエラー・5秒のタイムアウト・不正な応答・低確率なら黙って通常のメンション待ちに戻ります。
運営者が許可したチャンネルのログを扱う設計です。外部に送らないためローカルURLを使ってください。

## 検証と限界

- `tests/participation.test.ts`: 許可範囲、判定確率と返信先の検証、外部APIはモック
- `--self-check`: 小さいLinearをINT8化し、変換前後の推論値を比較
- 実際のKev-0.6BをCPUでINT8化して起動し、`/v1/systemone` の確率・返信先の応答を確認

日本語Discord会話での参加精度や閾値は未校正です。推論が動くことと、参加判定が適切なことは
別なので、既定では有効にしません。運営者が少数のチャンネルで判定を確認してから有効にしてください。
