# 未解決イシューの対応

2026-11-06時点の未解決22件を1つの変更にまとめます。

| イシュー | 対応 | 主な検証 |
|---|---|---|
| #1 生成停止で詰まる | 初期化・取得の待ち時間上限、無進捗ストリームの中断、clear、未使用セッションの破棄 | agent / ai-handler |
| #5 allowedMentions | Discord・Fluxerの通常送信とAIの分割返信でメンション通知を抑止 | ai-handler |
| #7 アバター画質 | 同期・ログでサーバーアバターか既定アバターを1024pxで取得 | 型チェック |
| #8 clearの追加指示 | clear後の依頼をそのまま新しい会話で処理 | ai-handler |
| #10 過去1万文字 | beforeで最新100件を取得し、今回の依頼・返信先を優先して最新側から1万文字に収める | ai-context / ai-embeds |
| #16 auto-continue | length終了時だけ最大3回継続 | agent |
| #23 URL変換 | URL内の括弧とMarkdownの閉じ括弧を区別 | utils |
| #24 ツール中の新着 | 全ツール結果の後、次の生成前に新着を一度ずつ注入 | agent / ai-handler |
| #27 OpenRouterモデル選択 | `=aimodel openai <モデルID>`。運営者のallowlistで検証して保存 | ai-prefs / ai-handler |
| #28 記憶 | 既存memoryを継続利用し、並列の読み込み・保存による消失を防止 | memory |
| #29 チャンネル間共有 | 設定時だけ本人とbotが読めるチャンネル間 (非公開も含む) で履歴を共有。閲覧権限喪失でリセット | ai-handler |
| #30 aimodel切替 | メンション無しのコマンドを認識し、本人の全チャンネルの既存セッションを中断 | ai-handler |
| #31 即抜け | 参加から5分以内の退出に経過秒数を付けてログへ。任意の通知チャンネルも指定可 | member-logging |
| #32 周辺ファイル | 履歴・返信先・転送・embedと、ツール取得先のファイルも次の生成に渡す | ai-handler / ai-tools / agent |
| #34 使用量 | ツールのあるラウンドもusageを流し、入力・出力・キャッシュを加算 | agent |
| #35 自動参加 | llama.cppのJSON制約付き判定、許可チャンネルと成功後クールダウン | participation (APIモック。実推論は未検証) |
| #37 typing再表示 | イベント数でtypingせず、生成中のタイマーだけにし、最終送信前に停止 | ai-handler |
| #38 並列とマージ | ユーザー別の並列を維持し、他の並列返信もツール境界で文脈へ | ai-handler |
| #41 mutex | セッション登録とキューの確保をawaitより前に行い、初期化もキュー内に | ai-handler |
| #42 Wiki調査の応用 | 独立Wikiは設けず、memoryの短い索引とNotionの詳しい記録に整理 | ai-prompt |
| #43 毎ターンの記憶 | 自分の順番が来てから記憶を読み、同じセッションでも最新の抜粋を注入 | ai-handler |
| #44 呼び出し削除 | 生成を中断し分割返信・画像・進捗を削除。ID対応は共通ユーティリティでチャンネルごと100呼び出しのメモリキャッシュ | ai-handler / message-cache |

## 運用設定が必要なもの

- 自動参加・チャンネル間共有は既定では無効。設定方法は [ai.md](ai.md)、[participation.md](participation.md) を参照
- 詳細記録はNotion MCPを使い、独立Wiki・公開用DBは追加しない
- 本番のDiscord / Fluxerでの投稿・削除とllama.cppの実推論は未検証
- FluxerのAPI・メディアURLは [fluxsync.md](fluxsync.md#fluxer互換性の確認) の一次資料で照合
- キャンセルは既に実行されたツールの副作用を取り消さない。再起動・期限切れ・キャッシュ上限で外れた返信の削除は追跡しない

Nodeの依存追加はありません。RakutenAI SDKの終了処理にはpnpmパッチを適用しています。
Windowsでは一時フォルダー内をカレントにしたまま削除できないので、
既存のprefs・同期状態のテストはカレントを戻してから片付けるようにしています。
