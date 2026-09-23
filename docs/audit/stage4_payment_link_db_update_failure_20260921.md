# Stage 4検証結果：Payment Link発行成功後のDB更新失敗ハンドリング（2026-09-21）

## 概要

`backend/src/index.ts`のcheckoutハンドラに実装済みの`createdOrderId`分岐ロジック（`insertOrder()`成功後の例外を正確に区別する処理）について、本番backend/srcを隔離環境へコピーし、隔離環境側にテスト注入口を追加したうえで、実際のHTTPリクエスト経由の動作確認を実施した。

## 検証方法

- 本番`backend/src`を隔離ディレクトリへコピーし（本番`backend/`は無変更）、コピー限定でPayment Link発行・DB更新のテスト注入口を追加した
- 実際にサーバープロセスを起動し、`POST /api/orders/checkout`へ実HTTPリクエストを送信して検証した

## 模擬した失敗条件

Payment Link発行成功（Square実通信なし・模擬）→ 直後のDB更新（`updateOrderPaymentLink`）が失敗

## 確認結果

- HTTPステータス：500
- レスポンスに`orderId: 1`を含む
- 該当注文がDBに保持されている（削除されない）
- `status='RECEIVED'`、`payment_status='PENDING'`を維持
- `square_order_id=''`、`payment_link_id=''`（未反映のまま）
- 本番`backend/`への変更：なし（Git差分ゼロを都度確認）

## 注記

Square実サービスとの実通信は行っていない（Payment Link発行成功はテスト注入による模擬）
