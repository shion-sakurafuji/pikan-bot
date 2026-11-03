# pikan-bot

「100年前の今日」の史実を調査・検証し、日本時間の1日3枠でXへ投稿するためのTypeScriptアプリです。

## 実装

- 既存のOpenAI Responses APIとWeb検索を使い、1回につき最大8候補を調査します。
- 3件の検証済み候補がそろわない場合、追加調査は最大2回です。
- 候補の元出典を優先し、候補あたり最大4 URL、全体で最大32 URLを取得します。同じURLは一度だけ取得します。
- 本文は1資料4,000文字、1候補12,000文字までです。主要事実と日付の引用が取得本文に実在し、日付が一致し、信頼できる出典が1件以上ある候補だけを採用します。
- 日次の確定内容、出典、予定時刻、投稿状態は `data/historical-posts.json` に保存します。準備済みの日は再調査しません。
- 投稿枠は日本時間の07:30、12:05、18:15です。投稿処理は保存済みデータだけを読み、送信前予約と結果不明時の再送抑止を行います。
- `data/post-history.json` の既存履歴も重複確認に利用します。

## 検証

```sh
npm ci
npm run typecheck
npm test
```

テストはOpenAIとXをモックし、外部API通信や実投稿を行いません。

## 自動実行の状態

GitHub Actions定義は `.github/workflows/post-historical-events.yml.disabled` に置かれ、無効のままです。このリポジトリでは自動実行も本番投稿も有効化していません。実APIを使った調査・検証とXへの投稿は未確認です。

有効化する場合は、まずテスト用アカウントと投稿内容を人手で確認してください。運用前にWorkflowを `.yml` として有効化し、Actions変数 `PIKAN_AUTOPUBLISH_ENABLED=true` とSecrets `OPENAI_API_KEY`、`OPENAI_MODEL`、`X_API_KEY`、`X_API_SECRET`、`X_ACCESS_TOKEN`、`X_ACCESS_TOKEN_SECRET` を設定する必要があります。履歴保存のため、Actionsに `contents: write` 権限が必要です。これらの操作はこの変更では行っていません。

## VPSからのdispatch

`scripts/dispatch.py` はGitHub REST APIの `workflow_dispatch` を呼び出し、投稿日をVPSのローカル時刻ではなく `Asia/Tokyo` で決定します。VPS上で `GITHUB_REPOSITORY=owner/pikan-bot` と `GH_TOKEN`（Actions write権限のあるトークン）を設定し、枠ごとに次を実行します。

```sh
python3 scripts/dispatch.py 0730
python3 scripts/dispatch.py 1205
python3 scripts/dispatch.py 1815
```

通常実行は `post_to_x=true` を送ります。準備だけの場合は `--prepare-only` を付けます。スクリプトのVPS配置、Workflowの有効化、cron設定はこの変更では行っていません。

投稿要求がタイムアウトした場合、状態は `unknown` として再送を止めます。X側で投稿済みかを人手で確認してから、履歴を安全に解決してください。自動照合は未実装です。

## 既存の大喜利機能

既存の大喜利生成・X投稿コードは残しています。`npm run dev` は大喜利側のエントリーポイントであり、歴史投稿のスケジュール実行ではありません。