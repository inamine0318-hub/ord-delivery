// ============================================================
// ORD (Okinawa Resort Delivery) バックエンド モック実装
// Square Webhook 受信 → 受注データ抽出 → LINE Messaging API (Flex Message) 通知
//
// 【重要】これはモックプログラムです。実際のSquare/LINEアカウント・APIキーは
// 使用していません。本番投入前に必ずREADME.mdの「本番投入前の注意」を確認してください。
// ============================================================

require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

const MOCK_MODE = process.env.MOCK_MODE !== 'false'; // デフォルトはモック（true）
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const MERCHANT_LINE_USER_ID = process.env.MERCHANT_LINE_USER_ID || 'MOCK_MERCHANT_UID';
const DRIVER_LINE_USER_ID = process.env.DRIVER_LINE_USER_ID || 'MOCK_DRIVER_UID';
const PORT = process.env.PORT || 3001;

// ---------- インメモリ Orders テーブル（プロセス再起動で消えます。本番はDBに置き換え） ----------
let orders = [];
let nextId = 1;

// ============================================================
// タスク3: 「Square ➔ アプリ連携」の解消ロジック
// ヴィラ名・部屋番号の抽出方法の提案（詳細はREADME.md参照）
//
// Squareには汎用の「注文カスタムフィールド」APIは無いため、以下いずれかで対応する:
//  (A) Square OnlineのCheckoutで「カスタム質問(Custom Question)」機能を使い、
//      「ヴィラ名」「部屋番号」を必須入力項目として追加する（推奨・実装コスト低）。
//      回答内容はWebhookペイロードの order.fulfillments[].pickup_details.note
//      または注文全体の note フィールドに格納される。
//  (B) POS実店舗レジでは、会計時にスタッフが note 欄へ
//      「ヴィラ名:○○ / 部屋番号:○○」の形式で手入力する運用ルールにする。
// このモックでは、どちらの経路でも note フィールドに上記フォーマットの文字列が
// 入っている前提で、以下の parseDeliveryInfo() で正規表現抽出する。
// ============================================================
function parseDeliveryInfo(note) {
  const villaMatch = /ヴィラ名[:：]\s*([^\/\n]+)/.exec(note || '');
  const roomMatch = /部屋番号[:：]\s*([^\/\n]+)/.exec(note || '');
  return {
    villaName: villaMatch ? villaMatch[1].trim() : '(未入力)',
    roomNumber: roomMatch ? roomMatch[1].trim() : '(未入力)',
  };
}

// ============================================================
// タスク1: Square Webhook 受信エンドポイント（モック）
//
// 【本番投入前の注意】Squareは `x-square-hmacsha256-signature` ヘッダーで
// ペイロードの署名検証を必須としています。このモックでは検証を省略しています。
// 本番投入時は SQUARE_WEBHOOK_SIGNATURE_KEY を使い、必ず署名検証を実装してください
// （検証を省略すると第三者が偽の注文データを送り込めてしまいます）。
// ============================================================
app.post('/webhook/square', (req, res) => {
  const payload = req.body;
  const eventType = payload.type || 'unknown';
  const dataObject = payload.data && payload.data.object;
  const orderData = dataObject && (dataObject.order || dataObject.payment);

  if (!orderData) {
    return res.status(400).json({ ok: false, error: '不正なペイロード: order情報が見つかりません' });
  }

  const lineItems = (orderData.line_items || []).map(li => ({
    name: li.name || '(商品名不明)',
    quantity: li.quantity || '1',
    options: (li.modifiers || []).map(m => m.name).join(', '),
  }));

  const note =
    orderData.note ||
    (orderData.fulfillments &&
      orderData.fulfillments[0] &&
      orderData.fulfillments[0].pickup_details &&
      orderData.fulfillments[0].pickup_details.note) ||
    '';
  const delivery = parseDeliveryInfo(note);

  const order = {
    id: nextId++,
    squareOrderId: orderData.id || `mock-${Date.now()}`,
    eventType,
    lineItems,
    villaName: delivery.villaName,
    roomNumber: delivery.roomNumber,
    rawNote: note,
    status: 'received', // 'received' → 'dispatched'
    receivedAt: new Date().toISOString(),
  };
  orders.push(order);
  console.log('[Webhook受信]', JSON.stringify(order, null, 2));
  res.status(200).json({ ok: true, orderId: order.id });
});

// ---------- 受注一覧API ----------
app.get('/orders', (req, res) => {
  res.json(orders);
});

// ---------- 簡易管理画面（モック） ----------
app.get('/admin', (req, res) => {
  res.send(renderAdminHtml());
});

function renderAdminHtml() {
  const rows = orders
    .map(
      o => `
    <tr>
      <td>${o.id}</td>
      <td>${o.squareOrderId}</td>
      <td>${o.villaName} / ${o.roomNumber}</td>
      <td>${o.lineItems.map(li => `${li.name}×${li.quantity}${li.options ? `(${li.options})` : ''}`).join('<br>') || '(商品情報なし)'}</td>
      <td>${o.status}</td>
      <td>${o.status === 'received' ? `<button onclick="dispatchOrder(${o.id})">手配開始</button>` : '手配済み'}</td>
    </tr>`
    )
    .join('');
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>ORD 受注管理（モック）</title>
<style>
body{font-family:"Hiragino Sans","Yu Gothic",sans-serif;padding:24px;background:#f7f6f2;color:#1F2D3A;}
h2{margin-bottom:4px;} p{color:#6B7680;font-size:13px;}
table{width:100%;border-collapse:collapse;background:#fff;margin-top:16px;}
th,td{border:1px solid #E7E0D2;padding:8px;font-size:13px;text-align:left;vertical-align:top;}
th{background:#14181C;color:#fff;}
button{background:#0086A8;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12.5px;}
.badge{display:inline-block;background:#E8A33D;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;}
</style></head>
<body>
<h2>ORD 受注管理（モック）</h2>
<p>Square Webhookで受信した注文一覧です。MOCK_MODE=${MOCK_MODE} <span class="badge">${MOCK_MODE ? 'LINE実送信なし・ログのみ' : 'LINE実送信あり'}</span></p>
<p>「手配開始」を押すと、加盟店様・配送パートナーのLINEへFlex Messageを送信します（モック時はサーバーのコンソールにJSONを出力）。</p>
<table>
<tr><th>ID</th><th>Square注文ID</th><th>お届け先</th><th>商品</th><th>状態</th><th>操作</th></tr>
${rows || '<tr><td colspan="6">注文はまだありません（下記curlコマンドでテスト送信できます）</td></tr>'}
</table>
<script>
async function dispatchOrder(id){
  const res = await fetch('/orders/'+id+'/dispatch', {method:'POST'});
  const data = await res.json();
  alert(data.ok ? '手配完了：LINE通知を送信しました（詳細はサーバーのコンソールログ参照）' : 'エラー: '+data.error);
  location.reload();
}
</script>
</body></html>`;
}

// ============================================================
// タスク2: LINE Messaging API (Flex Message) 送信機能
// ============================================================
async function sendLineMessage(to, flexMessage) {
  if (MOCK_MODE) {
    console.log('----- [LINE送信モック] -----');
    console.log('宛先:', to);
    console.log(JSON.stringify(flexMessage, null, 2));
    console.log('----------------------------');
    return { mock: true };
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [flexMessage] }),
  });
  return res.json();
}

function buildMerchantFlex(order) {
  return {
    type: 'flex',
    altText: `【調理指示】${order.villaName}向け ご注文`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0086A8',
        paddingAll: '12px',
        contents: [{ type: 'text', text: '調理指示', weight: 'bold', size: 'lg', color: '#ffffff' }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `お届け先: ${order.villaName} ${order.roomNumber}`, wrap: true, weight: 'bold' },
          ...order.lineItems.map(li => ({
            type: 'text',
            text: `・${li.name} ×${li.quantity}${li.options ? `（${li.options}）` : ''}`,
            wrap: true,
            size: 'sm',
          })),
          { type: 'text', text: `注文ID: ${order.squareOrderId}`, size: 'xs', color: '#888888', margin: 'md' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#0086A8',
            action: { type: 'postback', label: '調理開始', data: `action=cook_start&orderId=${order.id}` },
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'postback', label: '調理完了（ドライバー呼出）', data: `action=cook_done&orderId=${order.id}` },
          },
        ],
      },
    },
  };
}

function buildDriverFlex(order) {
  return {
    type: 'flex',
    altText: `【配達依頼】${order.villaName}へお届け`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#14181C',
        paddingAll: '12px',
        contents: [{ type: 'text', text: '配達依頼', weight: 'bold', size: 'lg', color: '#ffffff' }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `お届け先: ${order.villaName} ${order.roomNumber}`, wrap: true, weight: 'bold' },
          { type: 'text', text: `注文ID: ${order.squareOrderId}`, size: 'xs', color: '#888888' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#14181C',
            action: { type: 'postback', label: '案件を受託する', data: `action=accept&orderId=${order.id}` },
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'postback', label: 'ピックアップ完了', data: `action=pickup&orderId=${order.id}` },
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'postback', label: '配達完了', data: `action=deliver&orderId=${order.id}` },
          },
        ],
      },
    },
  };
}

// ---------- 手配開始（管理者操作 or 自動トリガー） ----------
app.post('/orders/:id/dispatch', async (req, res) => {
  const order = orders.find(o => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ ok: false, error: '注文が見つかりません' });
  try {
    await sendLineMessage(MERCHANT_LINE_USER_ID, buildMerchantFlex(order));
    await sendLineMessage(DRIVER_LINE_USER_ID, buildDriverFlex(order));
    order.status = 'dispatched';
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================
// LINE Webhook（ボタン押下=postbackイベントの受信、モック）
// 【本番投入前の注意】こちらもLINE署名検証(x-line-signature)を省略しています。
// ============================================================
app.post('/webhook/line', (req, res) => {
  const events = req.body.events || [];
  events.forEach(ev => {
    if (ev.type === 'postback') {
      console.log('[LINE postback受信]', ev.postback.data);
      const params = new URLSearchParams(ev.postback.data);
      const action = params.get('action');
      const orderId = Number(params.get('orderId'));
      const order = orders.find(o => o.id === orderId);
      if (order) {
        console.log(`  → 注文#${orderId} に対するアクション: ${action}`);
        // 本番では action の値に応じて order.status を更新し、
        // 必要であれば関連ロール（お客様側アプリ等）へ再通知する処理をここに追加する。
      }
    }
  });
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`ORD backend (mock) listening on http://localhost:${PORT}`);
  console.log(`管理画面: http://localhost:${PORT}/admin`);
  console.log(`MOCK_MODE: ${MOCK_MODE} — LINEへの実送信は${MOCK_MODE ? '行いません（コンソールログのみ）' : '実際に行います'}`);
});
