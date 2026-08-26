# ORD Backend（モック・TypeScript版）— Square Webhook → LINE Messaging API 連携

「Okinawa Resort Delivery（ORD）」のお客様がSquareで注文・決済した内容を受け取り、
管理画面で加盟店様・配送パートナーを紐付けて「手配開始」すると、それぞれのLINE公式
アカウントへ自動でFlex Message通知（ワンタップアクションボタン付き）を送るバックエンドです。

Node.js + Express + TypeScript、公式SDK（`square`, `@line/bot-sdk`）を使用しています。

**このプログラムは実際のSquare/LINEアカウント・APIキーを一切使用していません。**
`SQUARE_ACCESS_TOKEN` / `LINE_CHANNEL_ACCESS_TOKEN` が未設定（デフォルト）の間は、
実際の外部APIへは接続せず、Webhookペイロードのデータをそのまま使ってコンソールへ
ログ出力するだけの安全なモック動作になります。

## できること（実際に動作確認済み）

- `POST /api/stores`, `GET /api/stores` — 加盟店の登録・一覧取得
- `POST /api/drivers`, `GET /api/drivers` — 配送パートナーの登録・一覧取得
- `POST /webhooks/square` — Square注文Webhookのモック受信。`SQUARE_ACCESS_TOKEN`が
  設定されていれば実際に `squareClient.ordersApi.retrieveOrder()` で詳細取得を試み、
  未設定または取得失敗時はWebhookペイロード自体のデータで代替する
- `GET /api/orders` — 受注一覧API
- `GET /admin` — 加盟店/ドライバー登録フォーム＋受注一覧＋手配開始ボタンのある簡易管理画面
- `POST /api/orders/:id/dispatch` — 指定した加盟店・配送パートナーへLINE Flex Message
  （調理開始リクエスト／配達オファー）を送信し、注文ステータスを`PREPARING`に更新
- `POST /webhooks/line` — LINEのFlex Messageボタン押下（postback）を受け取り、
  ステータスを `PREPARING → READY_FOR_PICKUP → DELIVERING → COMPLETED` と更新

## セットアップ

```bash
cd backend
npm install
cp .env.example .env
npm run dev   # tsx watchで起動（開発用、ファイル変更を自動反映）
# または
npm start     # tsxで一度だけ起動
# 本番相当のビルド:
npm run build && npm run start:prod
```

起動すると `http://localhost:3001/admin` で管理画面が見られます。
型チェックのみ行う場合は `npx tsc --noEmit` を実行してください（このモックは
`npx tsc --noEmit` でエラー0件、`npm run build` でのビルドも実際に確認済みです）。

## 動作テスト手順（実際に確認した一連の流れ）

```bash
# 1. 加盟店を登録
curl -X POST http://localhost:3001/api/stores \
  -H "Content-Type: application/json" \
  -d '{"name":"琉球食堂 ちゅら島","lineUserId":"Ustore001"}'

# 2. 配送パートナーを登録
curl -X POST http://localhost:3001/api/drivers \
  -H "Content-Type: application/json" \
  -d '{"name":"金城さん","lineUserId":"Udriver001"}'

# 3. Square注文Webhookをシミュレーション
curl -X POST http://localhost:3001/webhooks/square \
  -H "Content-Type: application/json" \
  -d '{
    "type": "order.created",
    "data": {
      "object": {
        "order": {
          "id": "sq-order-001",
          "note": "ヴィラ名:コーラルテラス恩納 / 部屋番号:805",
          "line_items": [
            {"name": "ソーキそば", "quantity": "2", "modifiers": []}
          ]
        }
      }
    }
  }'

# 4. 手配開始（加盟店ID=1, ドライバーID=1へ紐付け）
curl -X POST http://localhost:3001/api/orders/1/dispatch \
  -H "Content-Type: application/json" \
  -d '{"storeId":1,"driverId":1}'
# → コンソールにLINE Flex MessageのJSONがログ出力される（LINE_CHANNEL_ACCESS_TOKEN未設定時）

# 5. LINEボタン押下（postback）をシミュレーション
curl -X POST http://localhost:3001/webhooks/line \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"postback","postback":{"data":"action=DRIVER_COMPLETE&orderId=1"}}]}'
# → 注文ステータスがCOMPLETEDに、ドライバーがIDLEに戻る
```

`http://localhost:3001/admin` を開くと、上記の状態がブラウザ上でも確認できます。

## ヴィラ名・部屋番号の入力方法についての提案

Squareには汎用の「注文カスタムフィールド」APIは存在しないため、以下いずれかで対応します。

- **(A) Square Online「カスタム質問（Custom Question）」機能を使う（推奨）**
  チェックアウト画面に「ヴィラ名」「部屋番号」を必須入力の質問項目として追加します。
  回答内容は Square Orders API の `order.fulfillments[].deliveryDetails.note` /
  `pickupDetails.note`、またはWebhookペイロードの対応するnoteフィールドに格納されるため、
  このバックエンドの `parseDeliveryInfo()` でそのまま抽出できます。
- **(B) 実店舗POSレジでの運用ルール化**
  対面決済時にスタッフが会計画面のnote欄へ「ヴィラ名:○○ / 部屋番号:○○」の形式で
  手入力する運用にする方法です。すぐに始められますが入力ブレのリスクがあります。

## 本番投入前の注意（未実装・要対応の項目）

- **Square/LINE Webhookの署名検証が未実装**：`x-square-hmacsha256-signature` /
  `x-line-signature` の検証を省略しています。省略したままだと第三者が偽のデータを
  送り込めてしまうため、本番投入前に必ず実装してください。
- **データがインメモリ保存のみ**：サーバー再起動で全て消えます。本番はデータベース
  （PostgreSQL、Firestore等）に置き換える必要があります。
- **認証・アクセス制御なし**：`/admin`や各APIに認証がなく、誰でもアクセスできる状態です。
- **HTTPS化・公開URLの用意が必要**：Square/LINEのWebhookは公開HTTPS URLへの配信が
  前提です。ローカル開発中は ngrok 等のトンネリングツールで一時的な公開URLを用意するか、
  Render/Railway等へのデプロイが必要です。
- **Square Orders APIのfulfillment/recipient周りのフィールド利用は簡略化した提案**：
  実際の運用に合わせてカスタム質問の設定内容とコードの抽出ロジックを突き合わせて
  調整してください。
