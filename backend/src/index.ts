// ============================================================
// ORD (Okinawa Resort Delivery) バックエンド（TypeScript版・モック実装）
// Square Webhook 受信 → Square Orders API 詳細取得 → 加盟店/ドライバーへの
// LINE Messaging API (Flex Message) 通知
//
// 【重要】これはモックプログラムです。実際のSquare/LINEアカウント・APIキーは
// 使用していません。SQUARE_ACCESS_TOKEN / LINE_CHANNEL_ACCESS_TOKEN が未設定の
// 間は、実際の外部APIへは接続せず、Webhookペイロードのデータをそのまま使い
// コンソールへログ出力するだけの安全な動作になります。
// 本番投入前に必ずREADME.mdの「本番投入前の注意」を確認してください。
// ============================================================

import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { Client, Environment } from 'square';
import { messagingApi } from '@line/bot-sdk';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

const squareConfigured = SQUARE_ACCESS_TOKEN.length > 0;
const lineConfigured = LINE_CHANNEL_ACCESS_TOKEN.length > 0;

// Square公式SDKクライアント（トークン未設定時はnullのまま。実接続を試みない）
const squareClient: Client | null = squareConfigured
  ? new Client({
      environment: Environment.Sandbox,
      bearerAuthCredentials: { accessToken: SQUARE_ACCESS_TOKEN },
    })
  : null;

// LINE公式SDK Messaging APIクライアント（トークン未設定時はnullのまま）
const lineClient: messagingApi.MessagingApiClient | null = lineConfigured
  ? new messagingApi.MessagingApiClient({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN })
  : null;

// ============================================================
// データモデル（インメモリDB。プロセス再起動で消えます。本番はDBに置き換え）
// ============================================================
type OrderStatus = 'RECEIVED' | 'PREPARING' | 'READY_FOR_PICKUP' | 'DELIVERING' | 'COMPLETED';

interface Store {
  id: number;
  name: string;
  lineUserId: string;
}
interface Driver {
  id: number;
  name: string;
  lineUserId: string;
  status: 'IDLE' | 'BUSY';
}
interface OrderItem {
  name: string;
  quantity: string;
  note?: string;
}
interface Order {
  id: number;
  squareOrderId: string;
  items: OrderItem[];
  villaName: string;
  roomNumber: string;
  status: OrderStatus;
  storeId: number | null;
  driverId: number | null;
  createdAt: string;
}

const stores: Store[] = [];
const drivers: Driver[] = [];
const orders: Order[] = [];
let nextStoreId = 1;
let nextDriverId = 1;
let nextOrderId = 1;

// ============================================================
// 加盟店・ドライバー管理API
// ============================================================
app.post('/api/stores', (req: Request, res: Response) => {
  const { name, lineUserId } = req.body as { name?: string; lineUserId?: string };
  if (!name || !lineUserId) {
    return res.status(400).json({ ok: false, error: 'name と lineUserId は必須です' });
  }
  const store: Store = { id: nextStoreId++, name, lineUserId };
  stores.push(store);
  res.status(201).json({ ok: true, store });
});

app.get('/api/stores', (_req: Request, res: Response) => {
  res.json(stores);
});

app.post('/api/drivers', (req: Request, res: Response) => {
  const { name, lineUserId } = req.body as { name?: string; lineUserId?: string };
  if (!name || !lineUserId) {
    return res.status(400).json({ ok: false, error: 'name と lineUserId は必須です' });
  }
  const driver: Driver = { id: nextDriverId++, name, lineUserId, status: 'IDLE' };
  drivers.push(driver);
  res.status(201).json({ ok: true, driver });
});

app.get('/api/drivers', (_req: Request, res: Response) => {
  res.json(drivers);
});

// ============================================================
// ヴィラ名・部屋番号の抽出提案（Square Orders APIの実データ、または
// Webhookペイロードのnote欄のいずれからも同じ形式で抽出できるようにする）
//
// Squareには汎用の「注文カスタムフィールド」APIは無いため、以下いずれかを想定:
//  (A) Square Online「カスタム質問」機能で「ヴィラ名」「部屋番号」を入力させ、
//      fulfillments[].deliveryDetails.note / pickupDetails.note に格納する（推奨）
//  (B) 対面POSレジで、会計担当が同フォーマットの文字列を手入力する運用にする
// 詳細はREADME.md参照。
// ============================================================
function parseDeliveryInfo(note: string | undefined | null) {
  const villaMatch = /ヴィラ名[:：]\s*([^\/\n]+)/.exec(note || '');
  const roomMatch = /部屋番号[:：]\s*([^\/\n]+)/.exec(note || '');
  return {
    villaName: villaMatch ? villaMatch[1].trim() : '(未入力)',
    roomNumber: roomMatch ? roomMatch[1].trim() : '(未入力)',
  };
}

// Webhookペイロード（Squareから届く生JSON。snake_caseの想定）から
// 商品一覧・ノートを抽出するフォールバック処理（Square Orders APIが未接続、
// または取得に失敗した場合に使用）
function extractFromRawPayload(rawOrder: any): { items: OrderItem[]; note: string } {
  const items: OrderItem[] = (rawOrder.line_items || []).map((li: any) => ({
    name: li.name || '(商品名不明)',
    quantity: String(li.quantity || '1'),
    note: (li.modifiers || []).map((m: any) => m.name).join(', ') || undefined,
  }));
  const note: string =
    rawOrder.note ||
    rawOrder.fulfillments?.[0]?.pickup_details?.note ||
    rawOrder.fulfillments?.[0]?.delivery_details?.note ||
    '';
  return { items, note };
}

// ============================================================
// Square Webhook 受信 (`order.created` / `payment.updated`)
//
// 【本番投入前の注意】Squareは `x-square-hmacsha256-signature` ヘッダーで
// ペイロードの署名検証を必須としています。このモックでは検証を省略しています。
// 本番投入時は SQUARE_WEBHOOK_SIGNATURE_KEY を使い、必ず署名検証を実装してください。
// ============================================================
app.post('/webhooks/square', async (req: Request, res: Response) => {
  const payload = req.body;
  const dataObject = payload?.data?.object;
  const rawOrder = dataObject?.order || dataObject?.payment;

  if (!rawOrder) {
    return res.status(400).json({ ok: false, error: '不正なペイロード: order情報が見つかりません' });
  }

  const squareOrderId: string = rawOrder.id || `mock-${Date.now()}`;
  let items: OrderItem[] = [];
  let note = '';

  // Square Orders APIで詳細取得（実接続時のみ）。取得できなければWebhookペイロードで代替する。
  if (squareConfigured && squareClient && rawOrder.id) {
    try {
      const { result } = await squareClient.ordersApi.retrieveOrder(rawOrder.id);
      const order = result.order;
      if (order) {
        items = (order.lineItems || []).map(li => ({
          name: li.name || '(商品名不明)',
          quantity: li.quantity || '1',
        }));
        const fulfillment = order.fulfillments?.[0];
        note =
          fulfillment?.deliveryDetails?.recipient?.displayName ||
          fulfillment?.deliveryDetails?.note ||
          fulfillment?.pickupDetails?.note ||
          '';
      }
    } catch (e) {
      console.error('[Square Orders API] 取得に失敗、Webhookペイロードのデータで代替します:', e);
    }
  }

  if (items.length === 0) {
    const fallback = extractFromRawPayload(rawOrder);
    items = fallback.items;
    note = note || fallback.note;
  }

  const delivery = parseDeliveryInfo(note);

  const order: Order = {
    id: nextOrderId++,
    squareOrderId,
    items,
    villaName: delivery.villaName,
    roomNumber: delivery.roomNumber,
    status: 'RECEIVED',
    storeId: null,
    driverId: null,
    createdAt: new Date().toISOString(),
  };
  orders.push(order);
  console.log('[Square Webhook受信]', JSON.stringify(order, null, 2));
  res.status(200).json({ ok: true, orderId: order.id });
});

app.get('/api/orders', (_req: Request, res: Response) => {
  res.json(orders);
});

// ---------- 簡易管理画面 ----------
app.get('/admin', (_req: Request, res: Response) => {
  res.send(renderAdminHtml());
});

function renderAdminHtml(): string {
  const storeOptions = (selected: number | null) =>
    stores.map(s => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${s.name}</option>`).join('');
  const driverOptions = (selected: number | null) =>
    drivers.map(d => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${d.name}（${d.status}）</option>`).join('');

  const rows = orders
    .map(
      o => `
    <tr>
      <td>${o.id}</td>
      <td>${o.squareOrderId}</td>
      <td>${o.villaName} / ${o.roomNumber}</td>
      <td>${o.items.map(i => `${i.name}×${i.quantity}`).join('<br>') || '(商品情報なし)'}</td>
      <td>${o.status}</td>
      <td>
        <select id="store-${o.id}">${storeOptions(o.storeId)}</select>
        <select id="driver-${o.id}">${driverOptions(o.driverId)}</select>
      </td>
      <td>${o.status === 'RECEIVED' ? `<button onclick="dispatchOrder(${o.id})">手配開始</button>` : '手配済み'}</td>
    </tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>ORD 受注管理（モック・TypeScript版）</title>
<style>
body{font-family:"Hiragino Sans","Yu Gothic",sans-serif;padding:24px;background:#f7f6f2;color:#1F2D3A;}
h2{margin-bottom:4px;} p{color:#6B7680;font-size:13px;}
table{width:100%;border-collapse:collapse;background:#fff;margin-top:16px;}
th,td{border:1px solid #E7E0D2;padding:8px;font-size:13px;text-align:left;vertical-align:top;}
th{background:#14181C;color:#fff;}
button{background:#0086A8;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:12.5px;}
select{font-size:12px;margin-bottom:4px;display:block;}
.badge{display:inline-block;background:#E8A33D;color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;}
fieldset{background:#fff;border:1px solid #E7E0D2;border-radius:8px;padding:12px;margin-bottom:16px;}
input{padding:6px;font-size:12.5px;margin-right:6px;}
</style></head>
<body>
<h2>ORD 受注管理（モック・TypeScript版）</h2>
<p>Square連携: <span class="badge">${squareConfigured ? '実接続' : '未設定（Webhookペイロードのデータのみ使用）'}</span>
LINE連携: <span class="badge">${lineConfigured ? '実送信' : '未設定（コンソールログのみ）'}</span></p>

<fieldset>
  <legend>加盟店 登録</legend>
  <input id="store-name" placeholder="店舗名">
  <input id="store-line" placeholder="LINE User ID">
  <button onclick="createStore()">登録</button>
  <p>登録済み: ${stores.map(s => s.name).join('、') || '(なし)'}</p>
</fieldset>

<fieldset>
  <legend>配送パートナー 登録</legend>
  <input id="driver-name" placeholder="ドライバー名">
  <input id="driver-line" placeholder="LINE User ID">
  <button onclick="createDriver()">登録</button>
  <p>登録済み: ${drivers.map(d => `${d.name}(${d.status})`).join('、') || '(なし)'}</p>
</fieldset>

<table>
<tr><th>ID</th><th>Square注文ID</th><th>お届け先</th><th>商品</th><th>状態</th><th>加盟店/ドライバー割当</th><th>操作</th></tr>
${rows || '<tr><td colspan="7">注文はまだありません（README.mdのcurlコマンドでテスト送信できます）</td></tr>'}
</table>

<script>
async function createStore(){
  const name = document.getElementById('store-name').value;
  const lineUserId = document.getElementById('store-line').value;
  await fetch('/api/stores', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name, lineUserId})});
  location.reload();
}
async function createDriver(){
  const name = document.getElementById('driver-name').value;
  const lineUserId = document.getElementById('driver-line').value;
  await fetch('/api/drivers', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name, lineUserId})});
  location.reload();
}
async function dispatchOrder(id){
  const storeId = document.getElementById('store-'+id).value;
  const driverId = document.getElementById('driver-'+id).value;
  const res = await fetch('/api/orders/'+id+'/dispatch', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({storeId: Number(storeId), driverId: Number(driverId)}),
  });
  const data = await res.json();
  alert(data.ok ? '手配完了：LINE通知を送信しました' : 'エラー: '+data.error);
  location.reload();
}
</script>
</body></html>`;
}

// ============================================================
// LINE Flex Message 構築
// ============================================================
function buildStoreFlex(order: Order): messagingApi.FlexMessage {
  return {
    type: 'flex',
    altText: `【ORD】調理開始リクエスト - ${order.villaName}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0086A8',
        paddingAll: '12px',
        contents: [
          { type: 'text', text: '【ORD】調理開始リクエスト', weight: 'bold', size: 'md', color: '#ffffff' },
          { type: 'text', text: `${order.villaName} / ${order.roomNumber}`, size: 'sm', color: '#ffffff' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: order.items.map(i => ({
          type: 'text',
          text: `・${i.name} ×${i.quantity}${i.note ? `（${i.note}）` : ''}`,
          wrap: true,
          size: 'sm',
        })),
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
            action: { type: 'postback', label: '調理開始', data: `action=STORE_START&orderId=${order.id}` },
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'postback', label: '調理完了（ドライバー呼出）', data: `action=STORE_READY&orderId=${order.id}` },
          },
        ],
      },
    },
  };
}

function buildDriverFlex(order: Order): messagingApi.FlexMessage {
  return {
    type: 'flex',
    altText: `【ORD】配達オファー - ${order.villaName}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#14181C',
        paddingAll: '12px',
        contents: [{ type: 'text', text: '【ORD】配達オファー', weight: 'bold', size: 'md', color: '#ffffff' }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `お届け先: ${order.villaName}`, wrap: true, weight: 'bold' },
          { type: 'text', text: `部屋番号: ${order.roomNumber}`, wrap: true },
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
            action: { type: 'postback', label: '案件を受託する', data: `action=DRIVER_ACCEPT&orderId=${order.id}` },
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'postback', label: 'ピックアップ完了', data: `action=DRIVER_PICKUP&orderId=${order.id}` },
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'postback', label: '配達完了', data: `action=DRIVER_COMPLETE&orderId=${order.id}` },
          },
        ],
      },
    },
  };
}

async function pushLine(to: string, message: messagingApi.FlexMessage): Promise<void> {
  if (!lineConfigured || !lineClient) {
    console.log('----- [LINE送信モック（LINE_CHANNEL_ACCESS_TOKEN未設定）] -----');
    console.log('宛先:', to);
    console.log(JSON.stringify(message, null, 2));
    console.log('--------------------------------------------------------');
    return;
  }
  await lineClient.pushMessage({ to, messages: [message] });
}

// ============================================================
// 手配開始（管理画面から加盟店・ドライバーを紐付けて実行）
// ============================================================
app.post('/api/orders/:id/dispatch', async (req: Request, res: Response) => {
  const order = orders.find(o => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ ok: false, error: '注文が見つかりません' });

  const { storeId, driverId } = req.body as { storeId?: number; driverId?: number };
  const store = stores.find(s => s.id === (storeId ?? order.storeId ?? undefined));
  const driver = drivers.find(d => d.id === (driverId ?? order.driverId ?? undefined));

  if (!store) return res.status(400).json({ ok: false, error: '加盟店が指定/紐付けされていません（先に加盟店を登録してください）' });
  if (!driver) return res.status(400).json({ ok: false, error: 'ドライバーが指定/紐付けされていません（先にドライバーを登録してください）' });

  order.storeId = store.id;
  order.driverId = driver.id;

  try {
    await pushLine(store.lineUserId, buildStoreFlex(order));
    await pushLine(driver.lineUserId, buildDriverFlex(order));
    order.status = 'PREPARING';
    driver.status = 'BUSY';
    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============================================================
// LINE Webhook（ボタン押下=postbackイベントの受信）
// 【本番投入前の注意】LINE署名検証(x-line-signature)を省略しています。
// ============================================================
interface MockPostbackEvent {
  type: string;
  postback?: { data: string };
}

app.post('/webhooks/line', (req: Request, res: Response) => {
  const events: MockPostbackEvent[] = req.body?.events || [];
  events.forEach(ev => {
    if (ev.type === 'postback' && ev.postback) {
      console.log('[LINE postback受信]', ev.postback.data);
      const params = new URLSearchParams(ev.postback.data);
      const action = params.get('action');
      const orderId = Number(params.get('orderId'));
      const order = orders.find(o => o.id === orderId);
      if (!order) return;

      switch (action) {
        case 'STORE_START':
          order.status = 'PREPARING';
          break;
        case 'STORE_READY':
          order.status = 'READY_FOR_PICKUP';
          break;
        case 'DRIVER_ACCEPT':
          order.status = 'READY_FOR_PICKUP';
          break;
        case 'DRIVER_PICKUP':
          order.status = 'DELIVERING';
          break;
        case 'DRIVER_COMPLETE':
          order.status = 'COMPLETED';
          if (order.driverId) {
            const driver = drivers.find(d => d.id === order.driverId);
            if (driver) driver.status = 'IDLE';
          }
          break;
        default:
          console.log(`  → 未知のaction: ${action}`);
          return;
      }
      console.log(`  → 注文#${orderId} ステータス更新: ${order.status}`);
    }
  });
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`ORD backend (TypeScript) listening on http://localhost:${PORT}`);
  console.log(`管理画面: http://localhost:${PORT}/admin`);
  console.log(`Square連携: ${squareConfigured ? '実接続' : '未設定（Webhookペイロードのデータのみ使用）'}`);
  console.log(`LINE連携: ${lineConfigured ? '実送信' : '未設定（コンソールログのみ）'}`);
});
