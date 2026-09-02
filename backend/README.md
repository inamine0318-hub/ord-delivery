# ORD Backend（TypeScript版）— Square Webhook → LINE Messaging API 連携

「Okinawa Resort Delivery（ORD）」のお客様がSquareで注文・決済した内容を受け取り、
管理画面で加盟店様・配送パートナーを紐付けて「手配開始」すると、それぞれのLINE公式
アカウントへ自動でFlex Message通知（ワンタップアクションボタン付き）を送るバックエンドです。

Node.js + Express + TypeScript、公式SDK（`square`, `@line/bot-sdk`）を使用しています。
データはSQLite（Node.js標準の`node:sqlite`、`backend/data/ord.db`）に永続化されるため、
サーバーを再起動しても注文・加盟店・配送パートナー・管理者アカウントは消えません。

**Square/LINEは実際のアカウント・APIキーを一切使用していません。**
`SQUARE_ACCESS_TOKEN` / `LINE_CHANNEL_ACCESS_TOKEN` が未設定（デフォルト）の間は、
実際の外部APIへは接続せず、Webhookペイロードのデータをそのまま使ってコンソールへ
ログ出力するだけの安全なモック動作になります。

## 認証（加盟店・配送パートナー・管理者の3ロール）

加盟店・配送パートナーの登録や、注文一覧・手配・精算・経営サマリーなどの管理系APIは
すべてログイン必須です（JWT）。初回起動時に管理者アカウント`admin`が自動作成され、
**ランダムな初期パスワードが起動ログにのみ表示されます**（控えておいてください）。

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"role":"ADMIN","username":"admin","password":"（起動ログに表示された初期パスワード）"}'
# → { "ok": true, "token": "eyJ...", ... }
```

取得した`token`を以降のAPIリクエストに `Authorization: Bearer <token>` として付与します。
加盟店・配送パートナーも同じ`/api/auth/login`から`role`を`STORE`/`DRIVER`にしてログインでき、
自分の精算情報（`/api/stores/:id/settlement`, `/api/drivers/:id/settlement`）のみ閲覧できます
（他店舗・他ドライバーの精算は403で拒否されます）。

`/admin`画面はブラウザCookie（`ord_admin_session`）でログイン状態を保持します。
未ログイン時はログインフォームが表示され、`admin`アカウントでログインすると
管理画面（経営サマリー・加盟店/配送パートナー登録・受注一覧・収益シミュレーター）が見られます。

## できること（実際に動作確認済み）

- `POST /api/auth/login` — 加盟店/配送パートナー/管理者共通のログイン窓口（JWT発行）
- `POST /api/stores`, `GET /api/stores` — 加盟店の登録（ID/パスワード必須）・一覧取得（ADMIN限定）
- `POST /api/drivers`, `GET /api/drivers` — 配送パートナーの登録（ID/パスワード必須）・一覧取得（ADMIN限定）
- `POST /webhooks/square` — Square注文Webhookの受信（署名検証は省略、認証不要でSquareから直接呼ばれる想定）。`SQUARE_ACCESS_TOKEN`が
  設定されていれば実際に `squareClient.ordersApi.retrieveOrder()` で詳細取得を試み、
  未設定または取得失敗時はWebhookペイロード自体のデータ（`total_money`含む）で代替する
- `GET /api/orders` — 受注一覧API（ADMIN限定）
- `GET /admin` — ログイン必須の管理画面（加盟店/ドライバー登録フォーム＋経営サマリー＋
  収益シミュレーター＋受注一覧＋手配開始ボタン）
- `POST /api/orders/:id/dispatch` — 指定した加盟店・配送パートナーへLINE Flex Message
  （調理開始リクエスト／配達オファー）を送信し、注文ステータスを`PREPARING`に更新（ADMIN限定）
- `POST /webhooks/line` — LINEのFlex Messageボタン押下（postback）を受け取り、
  ステータスを `PREPARING → READY_FOR_PICKUP → DELIVERING → COMPLETED` と更新（認証不要でLINEから直接呼ばれる想定）
- `GET /api/stores/:id/settlement`, `GET /api/drivers/:id/settlement` — 精算情報（ADMIN、または本人のみ）
- `GET /api/revenue/summary`, `GET /api/revenue-simulator` — 経営サマリー・収益シミュレーター（ADMIN限定）
- `GET /api/orders/:id/dispatch-candidates` — 自動配車の候補ランキング（ADMIN限定）。①待機中ドライバー優先
  ②お届け先エリアと一致するドライバー優先 ③現在の配達件数が少ない順、で並べ替える。実際のGPS/地図連携（Phase2）
  が入るまでは、店舗・ドライバー・注文それぞれの「主なエリア」の一致有無を距離の代替指標として使用している。
  `/admin`画面の未手配注文の配送パートナー選択肢にもこの順で自動反映される
- `GET /api/kpi` — KPIダッシュボード（ADMIN限定）: 本日注文数・本日売上・平均配達時間（全期間の完了注文ベース）・
  加盟店ランキング（全期間売上順）・ドライバー稼働率

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

初回起動時、コンソールに管理者アカウント`admin`の初期パスワードが表示されます
（**この時しか表示されないので必ず控えてください**）。
起動すると `http://localhost:3001/admin` で管理画面が見られます。
型チェックのみ行う場合は `npx tsc --noEmit` を実行してください（`npx tsc --noEmit` で
エラー0件、`npm run build` でのビルド、DB永続化・認証・アクセス制御を含む一連の動作を
実際にサーバー起動→curlで検証済みです）。

データベースファイルは`backend/data/ord.db`に作成されます（`.gitignore`済み、
リポジトリには含まれません）。まっさらな状態からやり直したい場合はこのファイルを
削除して再起動してください（削除すると管理者アカウントも再作成され、新しい初期
パスワードが発行されます）。

## 動作テスト手順（実際に確認した一連の流れ）

```bash
# 0. 管理者ログイン（起動ログに表示された初期パスワードを使用）
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"role":"ADMIN","username":"admin","password":"（起動ログのパスワード）"}'
# → tokenを控えて、以降 -H "Authorization: Bearer <token>" を付与する

TOKEN="（上で取得したtoken）"

# 1. 加盟店を登録（ID/パスワード必須、手数料率は任意・省略時15%）
curl -X POST http://localhost:3001/api/stores \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"琉球食堂 ちゅら島","lineUserId":"Ustore001","commissionRate":0.15,"username":"churashima1","password":"pass1234"}'

# 2. 配送パートナーを登録
curl -X POST http://localhost:3001/api/drivers \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"金城さん","lineUserId":"Udriver001","username":"kinjo1","password":"pass1234"}'

# 3. Square注文Webhookをシミュレーション（認証不要）
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
          ],
          "total_money": {"amount": 3600, "currency": "JPY"}
        }
      }
    }
  }'

# 4. 手配開始（加盟店ID=1, ドライバーID=1へ紐付け）
curl -X POST http://localhost:3001/api/orders/1/dispatch \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"storeId":1,"driverId":1}'
# → コンソールにLINE Flex MessageのJSONがログ出力される（LINE_CHANNEL_ACCESS_TOKEN未設定時）

# 5. LINEボタン押下（postback）をシミュレーション（認証不要）
curl -X POST http://localhost:3001/webhooks/line \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"postback","postback":{"data":"action=DRIVER_COMPLETE&orderId=1"}}]}'
# → 注文ステータスがCOMPLETEDに、ドライバーがIDLEに戻る

# 6. 加盟店の精算を確認
curl http://localhost:3001/api/stores/1/settlement -H "Authorization: Bearer $TOKEN"
```

`http://localhost:3001/admin` を開き、`admin`アカウントでログインすると、
上記の状態がブラウザ上でも確認できます（日本語を含むJSONをcurlで送る場合、
Git Bash環境では文字化けすることがあるため、JSONファイルに保存して
`--data-binary "@ファイル名"`で送ることを推奨します）。

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
