# ORD Backend（モック）— Square Webhook → LINE Messaging API 連携

「Okinawa Resort Delivery（ORD）」のお客様がSquareで注文・決済した内容を受け取り、
加盟店様・配送パートナーのLINE公式アカウントへ自動でFlex Message通知を送るバックエンドの
試作（モック）です。

**このプログラムは実際のSquare/LINEアカウント・APIキーを一切使用していません。**
実際のWebhookペイロード構造・Flex Messageのデータ構造・処理フローを再現した動作確認用のモックです。

## できること（実際に動作確認済み）

1. `POST /webhook/square` — Squareの注文Webhookを模したJSONを受け取り、商品名・数量・オプション・
   ノート欄から抽出した「ヴィラ名・部屋番号」をインメモリの注文一覧に保存する
2. `GET /orders` — 受信した注文一覧をJSONで返す
3. `GET /admin` — 受注一覧を確認できる簡易管理画面（ブラウザで開けます）
4. `POST /orders/:id/dispatch` — 「手配開始」。加盟店様・配送パートナー宛のLINE Flex Messageを
   組み立てて送信する（`MOCK_MODE=true`の間は実送信せず、内容をコンソールにログ出力するだけ）
5. `POST /webhook/line` — LINEのFlex Messageボタン押下（postback）を受け取るエンドポイント（モック）

## セットアップ

```bash
cd backend
npm install
cp .env.example .env
npm start
```

起動すると `http://localhost:3001/admin` で管理画面が見られます。

## 動作テスト方法

サーバー起動後、別ターミナルから以下を実行すると、Square注文Webhookのシミュレーションができます。

```bash
curl -X POST http://localhost:3001/webhook/square \
  -H "Content-Type: application/json" \
  -d '{
    "type": "order.created",
    "data": {
      "object": {
        "order": {
          "id": "sq-order-test-001",
          "note": "ヴィラ名:コーラルテラス恩納 / 部屋番号:805",
          "line_items": [
            {"name": "ソーキそば", "quantity": "2", "modifiers": [{"name":"麺硬め"}]},
            {"name": "サーターアンダギー(3個)", "quantity": "1", "modifiers": []}
          ]
        }
      }
    }
  }'
```

その後 `http://localhost:3001/admin` を開くと注文が表示され、「手配開始」ボタンを押すと
サーバーのコンソールにLINE Flex Messageの内容（JSON）がログ出力されます。

## タスク3への回答：Squareでの「ヴィラ名・部屋番号」入力方法の提案

Squareには汎用の「注文カスタムフィールド」APIは存在しないため、以下いずれかの方法で対応します。

- **(A) Square Online「カスタム質問（Custom Question）」機能を使う（推奨）**
  Square Onlineのオンライン注文設定で、チェックアウト画面に「ヴィラ名」「部屋番号」を
  必須入力の質問項目として追加できます。回答内容はWebhookペイロードの
  `order.fulfillments[].pickup_details.note`、または注文全体の `note` フィールドに
  格納されるため、このバックエンドの `parseDeliveryInfo()` でそのまま抽出できます。
  実装コストが低く、レジ担当者の手入力ミスも防げるためこちらを推奨します。

- **(B) 実店舗POSレジでの運用ルール化**
  対面決済時にスタッフが会計画面の note 欄へ「ヴィラ名:○○ / 部屋番号:○○」の形式で
  手入力する運用にする方法です。すぐに始められますが、入力形式のブレ・入力漏れのリスクが
  (A)より高くなります。

本モックの `parseDeliveryInfo()` は、上記どちらの経路であっても
`ヴィラ名:○○ / 部屋番号:○○` という文字列が note に入っていれば正しく抽出できるように
実装しています。

## 本番投入前の注意（未実装・要対応の項目）

このモックは「動作するプロトタイプ」であり、本番運用にはそのまま使えません。以下は
実装省略している、または簡略化している箇所です。

- **Square Webhookの署名検証が未実装**：本番では `x-square-hmacsha256-signature` ヘッダーを
  使った署名検証が必須です。省略したままだと第三者が偽の注文データを送り込めてしまいます。
- **LINE Webhookの署名検証が未実装**：同様に `x-line-signature` の検証が必要です。
- **注文データがインメモリ保存のみ**：サーバー再起動で全て消えます。本番はデータベース
  （PostgreSQL、Firestore等）に置き換える必要があります。
- **LINE通知の送信は`MOCK_MODE=true`の間コンソールログのみ**：実際に送信するには
  LINE Developersコンソールでチャネルを作成し、`LINE_CHANNEL_ACCESS_TOKEN`・
  加盟店様/配送パートナーの`userId`を`.env`に設定した上で`MOCK_MODE=false`にしてください。
- **postback受信後のステータス更新ロジックが未実装**：`/webhook/line`はpostbackの内容を
  ログ出力するだけで、実際の注文ステータス更新やお客様アプリへの再通知は行っていません。
- **認証・アクセス制御なし**：`/admin`や各APIに認証がなく、誰でもアクセスできる状態です。
- **HTTPS化・公開URLの用意が必要**：Square/LINEのWebhookは公開HTTPS URLへの配信が前提です。
  ローカル開発中は ngrok 等のトンネリングツールで一時的な公開URLを用意してください。
