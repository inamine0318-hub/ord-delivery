// ============================================================
// ORD (Okinawa Resort Delivery) バックエンド（TypeScript版）
// Square Webhook 受信 → Square Orders API 詳細取得 → 加盟店/ドライバーへの
// LINE Messaging API (Flex Message) 通知
// データはSQLite（node:sqlite、backend/data/ord.db）に永続化。
// 加盟店・配送パートナー・管理者はID/パスワード+JWTでログインする。
//
// 【重要】Square/LINEは実際のアカウント・APIキーを使用していません。
// SQUARE_ACCESS_TOKEN / LINE_CHANNEL_ACCESS_TOKEN が未設定の間は、実際の外部APIへは
// 接続せず、Webhookペイロードのデータをそのまま使いコンソールへログ出力するだけの
// 安全な動作になります。本番投入前に必ずREADME.mdの「本番投入前の注意」を確認してください。
// ============================================================

import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { Client, Environment } from 'square';
import { messagingApi } from '@line/bot-sdk';
import { db } from './db';
import { hashPassword, verifyPassword, signToken, verifyToken, requireAuth } from './auth';

const app = express();
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
// データモデル（SQLiteに永続化。backend/data/ord.db、サーバー再起動でも消えない）
// ============================================================
type OrderStatus = 'RECEIVED' | 'PREPARING' | 'READY_FOR_PICKUP' | 'DELIVERING' | 'COMPLETED';

interface Store {
  id: number;
  name: string;
  lineUserId: string;
  commissionRate: number; // ORDが徴収する手数料率（0〜1、例:0.15 = 15%）
  area: string; // 主な営業エリア（例:恩納村、北谷町）。自動配車の距離代替指標として使用
}
interface Driver {
  id: number;
  name: string;
  lineUserId: string;
  status: 'IDLE' | 'BUSY';
  area: string; // 主な稼働エリア。実際のGPS連携（Phase2）までの距離代替指標
}
interface OrderItem {
  name: string;
  quantity: string;
  note?: string;
}
interface Money {
  amount: number; // 通貨の最小単位（JPYは1円単位、小数を持たない）
  currency: string;
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
  customerLineId: string | null; // お客様がLINE通知を希望した場合のLINE User ID（任意）
  totalMoney: Money | null; // 注文金額（Square Orders APIから取得、または連携元ペイロードのtotal_moneyで代替）
  area: string | null; // お届け先エリア（ORDフロントのホテルデータ由来。自動配車の距離代替指標）
  completedAt: string | null; // 配達完了(COMPLETED)になった時刻。平均配達時間の算出に使用
}

// 加盟店ごとのcommissionRateが未設定/不正な場合に使うデフォルト手数料率。
// 実際の料率は事業判断（社長決裁）で確定させる前提の暫定値。
const DEFAULT_COMMISSION_RATE = 0.15;
// 配送パートナーへの1件あたり報酬（固定報酬モデルの簡易版。距離連動制等は将来拡張）
const DRIVER_PAYOUT_PER_DELIVERY = 400;

// ============================================================
// DBアクセス層（行⇔アプリ内型のマッピング）
// ============================================================
interface StoreRow {
  id: number;
  name: string;
  line_user_id: string;
  commission_rate: number;
  username: string;
  password_hash: string;
  area: string;
}
interface DriverRow {
  id: number;
  name: string;
  line_user_id: string;
  status: string;
  username: string;
  password_hash: string;
  area: string;
}
interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
}
interface OrderRow {
  id: number;
  square_order_id: string;
  items_json: string;
  villa_name: string;
  room_number: string;
  status: string;
  store_id: number | null;
  driver_id: number | null;
  created_at: string;
  customer_line_id: string | null;
  total_money_json: string | null;
  area: string | null;
  completed_at: string | null;
}

const rowToStore = (r: StoreRow): Store => ({ id: r.id, name: r.name, lineUserId: r.line_user_id, commissionRate: r.commission_rate, area: r.area });
const rowToDriver = (r: DriverRow): Driver => ({ id: r.id, name: r.name, lineUserId: r.line_user_id, status: r.status as 'IDLE' | 'BUSY', area: r.area });
const rowToOrder = (r: OrderRow): Order => ({
  id: r.id,
  squareOrderId: r.square_order_id,
  items: JSON.parse(r.items_json),
  villaName: r.villa_name,
  roomNumber: r.room_number,
  status: r.status as OrderStatus,
  storeId: r.store_id,
  driverId: r.driver_id,
  createdAt: r.created_at,
  customerLineId: r.customer_line_id,
  totalMoney: r.total_money_json ? JSON.parse(r.total_money_json) : null,
  area: r.area,
  completedAt: r.completed_at,
});

function getAllStores(): Store[] {
  return (db.prepare('SELECT * FROM stores ORDER BY id').all() as unknown as StoreRow[]).map(rowToStore);
}
function getStoreById(id: number): Store | undefined {
  const row = db.prepare('SELECT * FROM stores WHERE id = ?').get(id) as StoreRow | undefined;
  return row ? rowToStore(row) : undefined;
}
function getStoreRowByUsername(username: string): StoreRow | undefined {
  return db.prepare('SELECT * FROM stores WHERE username = ?').get(username) as StoreRow | undefined;
}
function insertStore(name: string, lineUserId: string, commissionRate: number, username: string, passwordHash: string, area: string): Store {
  const info = db
    .prepare('INSERT INTO stores (name, line_user_id, commission_rate, username, password_hash, area) VALUES (?,?,?,?,?,?)')
    .run(name, lineUserId, commissionRate, username, passwordHash, area);
  return { id: Number(info.lastInsertRowid), name, lineUserId, commissionRate, area };
}

function getAllDrivers(): Driver[] {
  return (db.prepare('SELECT * FROM drivers ORDER BY id').all() as unknown as DriverRow[]).map(rowToDriver);
}
function getDriverById(id: number): Driver | undefined {
  const row = db.prepare('SELECT * FROM drivers WHERE id = ?').get(id) as DriverRow | undefined;
  return row ? rowToDriver(row) : undefined;
}
function getDriverRowByUsername(username: string): DriverRow | undefined {
  return db.prepare('SELECT * FROM drivers WHERE username = ?').get(username) as DriverRow | undefined;
}
function insertDriver(name: string, lineUserId: string, username: string, passwordHash: string, area: string): Driver {
  const info = db
    .prepare("INSERT INTO drivers (name, line_user_id, status, username, password_hash, area) VALUES (?,?,'IDLE',?,?,?)")
    .run(name, lineUserId, username, passwordHash, area);
  return { id: Number(info.lastInsertRowid), name, lineUserId, status: 'IDLE', area };
}
function updateDriverStatus(id: number, status: 'IDLE' | 'BUSY') {
  db.prepare('UPDATE drivers SET status = ? WHERE id = ?').run(status, id);
}

function getAdminRowByUsername(username: string): AdminRow | undefined {
  return db.prepare('SELECT * FROM admins WHERE username = ?').get(username) as AdminRow | undefined;
}
function seedDefaultAdminIfEmpty() {
  const { c } = db.prepare('SELECT COUNT(*) as c FROM admins').get() as { c: number };
  if (c > 0) return;
  const password = crypto.randomBytes(6).toString('hex');
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run('admin', hashPassword(password));
  console.log('==================================================');
  console.log('[初回起動] 管理者アカウントを作成しました');
  console.log('  ユーザー名: admin');
  console.log('  初期パスワード: ' + password);
  console.log('  ※この画面にしか表示されません。必ず控えて安全な場所に保管してください。');
  console.log('==================================================');
}
seedDefaultAdminIfEmpty();

function getAllOrders(): Order[] {
  return (db.prepare('SELECT * FROM orders ORDER BY id').all() as unknown as OrderRow[]).map(rowToOrder);
}
function getOrderById(id: number): Order | undefined {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
  return row ? rowToOrder(row) : undefined;
}
function insertOrder(o: Omit<Order, 'id' | 'completedAt'>): Order {
  const info = db
    .prepare(
      `INSERT INTO orders (square_order_id, items_json, villa_name, room_number, status, store_id, driver_id, created_at, customer_line_id, total_money_json, area)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      o.squareOrderId,
      JSON.stringify(o.items),
      o.villaName,
      o.roomNumber,
      o.status,
      o.storeId,
      o.driverId,
      o.createdAt,
      o.customerLineId,
      o.totalMoney ? JSON.stringify(o.totalMoney) : null,
      o.area
    );
  return { ...o, id: Number(info.lastInsertRowid), completedAt: null };
}
function updateOrderDispatch(id: number, storeId: number, driverId: number, status: OrderStatus) {
  db.prepare('UPDATE orders SET store_id = ?, driver_id = ?, status = ? WHERE id = ?').run(storeId, driverId, status, id);
}
function updateOrderStatus(id: number, status: OrderStatus) {
  if (status === 'COMPLETED') {
    db.prepare('UPDATE orders SET status = ?, completed_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
  } else {
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
  }
}

// ============================================================
// 認証API（加盟店・配送パートナー・管理者共通のログイン窓口）
// ============================================================
app.post('/api/auth/login', (req: Request, res: Response) => {
  const { role, username, password } = req.body as { role?: string; username?: string; password?: string };
  if (!role || !username || !password) {
    return res.status(400).json({ ok: false, error: 'role, username, password は必須です' });
  }

  if (role === 'ADMIN') {
    const row = getAdminRowByUsername(username);
    if (!row || !verifyPassword(password, row.password_hash)) return res.status(401).json({ ok: false, error: 'ユーザー名またはパスワードが違います' });
    const token = signToken({ role: 'ADMIN', id: row.id, name: row.username });
    return res.json({ ok: true, token, role: 'ADMIN', id: row.id, name: row.username });
  }
  if (role === 'STORE') {
    const row = getStoreRowByUsername(username);
    if (!row || !verifyPassword(password, row.password_hash)) return res.status(401).json({ ok: false, error: 'ユーザー名またはパスワードが違います' });
    const token = signToken({ role: 'STORE', id: row.id, name: row.name });
    return res.json({ ok: true, token, role: 'STORE', id: row.id, name: row.name });
  }
  if (role === 'DRIVER') {
    const row = getDriverRowByUsername(username);
    if (!row || !verifyPassword(password, row.password_hash)) return res.status(401).json({ ok: false, error: 'ユーザー名またはパスワードが違います' });
    const token = signToken({ role: 'DRIVER', id: row.id, name: row.name });
    return res.json({ ok: true, token, role: 'DRIVER', id: row.id, name: row.name });
  }
  return res.status(400).json({ ok: false, error: 'role は ADMIN / STORE / DRIVER のいずれかを指定してください' });
});

// ============================================================
// 加盟店・ドライバー管理API（登録はADMINのみ）
// ============================================================
app.post('/api/stores', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const { name, lineUserId, commissionRate, username, password, area } = req.body as {
    name?: string;
    lineUserId?: string;
    commissionRate?: number;
    username?: string;
    password?: string;
    area?: string;
  };
  if (!name || !lineUserId || !username || !password) {
    return res.status(400).json({ ok: false, error: 'name, lineUserId, username, password は必須です' });
  }
  if (getStoreRowByUsername(username)) {
    return res.status(409).json({ ok: false, error: 'そのユーザー名は既に使用されています' });
  }
  const rate =
    typeof commissionRate === 'number' && commissionRate >= 0 && commissionRate <= 1 ? commissionRate : DEFAULT_COMMISSION_RATE;
  const store = insertStore(name, lineUserId, rate, username, hashPassword(password), area || '恩納村');
  res.status(201).json({ ok: true, store });
});

app.get('/api/stores', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json(getAllStores());
});

app.post('/api/drivers', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const { name, lineUserId, username, password, area } = req.body as {
    name?: string;
    lineUserId?: string;
    username?: string;
    password?: string;
    area?: string;
  };
  if (!name || !lineUserId || !username || !password) {
    return res.status(400).json({ ok: false, error: 'name, lineUserId, username, password は必須です' });
  }
  if (getDriverRowByUsername(username)) {
    return res.status(409).json({ ok: false, error: 'そのユーザー名は既に使用されています' });
  }
  const driver = insertDriver(name, lineUserId, username, hashPassword(password), area || '恩納村');
  res.status(201).json({ ok: true, driver });
});

app.get('/api/drivers', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json(getAllDrivers());
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
function extractFromRawPayload(rawOrder: any): { items: OrderItem[]; note: string; totalMoney: Money | null; area: string | null } {
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
  // total_money は実際のSquare Webhookペイロードにも存在する形式（snake_case、amountは
  // JPYのように小数点を持たない通貨ではそのまま円額）。ORDフロント(index.html)がSquare未接続の
  // 開発中に送るモックpayloadでも同じ形式を使っているため、フォールバックとして共通利用できる。
  const totalMoney: Money | null =
    rawOrder.total_money && typeof rawOrder.total_money.amount === 'number'
      ? { amount: rawOrder.total_money.amount, currency: rawOrder.total_money.currency || 'JPY' }
      : null;
  // area も実際のSquare Webhookには存在しないフィールド。ORDフロント(index.html)が
  // ホテルデータの area（恩納村/読谷村/名護市/北谷町）を連携送信時に付与する（自動配車の距離代替指標）。
  const area: string | null = typeof rawOrder.area === 'string' ? rawOrder.area : null;
  return { items, note, totalMoney, area };
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
  let totalMoney: Money | null = null;

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
        // Money.amount は bigint 型のため、JSONで安全に扱えるnumberへ変換する
        if (order.totalMoney?.amount != null) {
          totalMoney = { amount: Number(order.totalMoney.amount), currency: order.totalMoney.currency || 'JPY' };
        }
      }
    } catch (e) {
      console.error('[Square Orders API] 取得に失敗、Webhookペイロードのデータで代替します:', e);
    }
  }

  const fallback = extractFromRawPayload(rawOrder);
  if (items.length === 0) items = fallback.items;
  note = note || fallback.note;
  totalMoney = totalMoney || fallback.totalMoney;

  const delivery = parseDeliveryInfo(note);

  const order = insertOrder({
    squareOrderId,
    items,
    villaName: delivery.villaName,
    roomNumber: delivery.roomNumber,
    status: 'RECEIVED',
    storeId: null,
    driverId: null,
    createdAt: new Date().toISOString(),
    // customer_line_id は実際のSquare Webhookには存在しないフィールド。ORDフロント
    // (index.html)からの連携送信時のみ、お客様がLINE通知を希望した場合に付与される。
    customerLineId: typeof rawOrder.customer_line_id === 'string' ? rawOrder.customer_line_id : null,
    totalMoney,
    area: fallback.area,
  });
  console.log('[Square Webhook受信]', JSON.stringify(order, null, 2));
  res.status(200).json({ ok: true, orderId: order.id });
});

app.get('/api/orders', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json(getAllOrders());
});

// ============================================================
// 収益化：手数料精算・配送パートナー報酬・経営サマリー・収益シミュレーター
// 【注意】あくまで概算計算です。実際の入出金・請求書発行・税務処理は別途必要です。
// ============================================================
function commissionRateForStore(storeId: number | null): number {
  const store = storeId != null ? getStoreById(storeId) : undefined;
  return store ? store.commissionRate : DEFAULT_COMMISSION_RATE;
}

// 加盟店の精算（完了注文の売上合計・ORD手数料・加盟店への支払額）。ADMIN、または本人（加盟店）のみ閲覧可
app.get('/api/stores/:id/settlement', requireAuth('ADMIN', 'STORE'), (req: Request, res: Response) => {
  const storeId = Number(req.params.id);
  if (req.auth!.role === 'STORE' && req.auth!.id !== storeId) {
    return res.status(403).json({ ok: false, error: '他の加盟店の精算情報は閲覧できません' });
  }
  const store = getStoreById(storeId);
  if (!store) return res.status(404).json({ ok: false, error: '加盟店が見つかりません' });

  const completed = getAllOrders().filter(o => o.storeId === storeId && o.status === 'COMPLETED' && o.totalMoney);
  const grossAmount = completed.reduce((sum, o) => sum + (o.totalMoney?.amount || 0), 0);
  const commissionAmount = Math.round(grossAmount * store.commissionRate);
  const netPayout = grossAmount - commissionAmount;

  res.json({
    ok: true,
    storeId,
    storeName: store.name,
    commissionRate: store.commissionRate,
    orderCount: completed.length,
    grossAmount,
    commissionAmount,
    netPayout,
    currency: 'JPY',
  });
});

// 配送パートナーの精算（完了配達件数×固定報酬）。ADMIN、または本人（配送パートナー）のみ閲覧可
app.get('/api/drivers/:id/settlement', requireAuth('ADMIN', 'DRIVER'), (req: Request, res: Response) => {
  const driverId = Number(req.params.id);
  if (req.auth!.role === 'DRIVER' && req.auth!.id !== driverId) {
    return res.status(403).json({ ok: false, error: '他の配送パートナーの精算情報は閲覧できません' });
  }
  const driver = getDriverById(driverId);
  if (!driver) return res.status(404).json({ ok: false, error: 'ドライバーが見つかりません' });

  const deliveryCount = getAllOrders().filter(o => o.driverId === driverId && o.status === 'COMPLETED').length;
  const payoutAmount = deliveryCount * DRIVER_PAYOUT_PER_DELIVERY;

  res.json({
    ok: true,
    driverId,
    driverName: driver.name,
    deliveryCount,
    payoutPerDelivery: DRIVER_PAYOUT_PER_DELIVERY,
    payoutAmount,
    currency: 'JPY',
  });
});

// 経営サマリー（全加盟店・全ドライバー合算のORD粗利）
function revenueSummary() {
  const allOrders = getAllOrders();
  const completed = allOrders.filter(o => o.status === 'COMPLETED' && o.totalMoney);
  const grossAmount = completed.reduce((sum, o) => sum + (o.totalMoney?.amount || 0), 0);
  const commissionAmount = completed.reduce(
    (sum, o) => sum + Math.round((o.totalMoney?.amount || 0) * commissionRateForStore(o.storeId)),
    0
  );
  const deliveryCount = allOrders.filter(o => o.status === 'COMPLETED' && o.driverId).length;
  const driverPayoutTotal = deliveryCount * DRIVER_PAYOUT_PER_DELIVERY;
  const ordGrossProfit = commissionAmount - driverPayoutTotal;
  return { completedOrderCount: completed.length, grossAmount, commissionAmount, driverPayoutTotal, ordGrossProfit, currency: 'JPY' };
}

app.get('/api/revenue/summary', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json({ ok: true, ...revenueSummary() });
});

// 収益シミュレーター（実データ不要。想定値から月商・ORD粗利を試算する）
app.get('/api/revenue-simulator', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  const dailyOrders = Number(q.dailyOrders) || 20;
  const avgOrderValue = Number(q.avgOrderValue) || 2500;
  const commissionRate = q.commissionRate !== undefined && q.commissionRate !== '' ? Number(q.commissionRate) : DEFAULT_COMMISSION_RATE;
  const days = Number(q.days) || 30;
  const driverPayoutPerDelivery =
    q.driverPayoutPerDelivery !== undefined && q.driverPayoutPerDelivery !== '' ? Number(q.driverPayoutPerDelivery) : DRIVER_PAYOUT_PER_DELIVERY;

  const totalOrders = dailyOrders * days;
  const grossGmv = totalOrders * avgOrderValue;
  const ordCommissionRevenue = Math.round(grossGmv * commissionRate);
  const driverPayoutTotal = totalOrders * driverPayoutPerDelivery;
  const ordGrossProfit = ordCommissionRevenue - driverPayoutTotal;

  res.json({
    ok: true,
    assumptions: { dailyOrders, avgOrderValue, commissionRate, days, driverPayoutPerDelivery },
    totalOrders,
    grossGmv,
    ordCommissionRevenue,
    driverPayoutTotal,
    ordGrossProfit,
    ordGrossProfitPerDay: Math.round(ordGrossProfit / days),
    currency: 'JPY',
  });
});

// ============================================================
// 自動配車：距離（エリア一致）・待機中ドライバー・現在の配達件数を考慮した候補表示
// 【注意】実際のGPS/地図連携（Phase2）が入るまでの簡易代替指標として、ドライバー・
// 注文それぞれの「主な稼働/お届け先エリア」の一致有無を距離の代替に使っている。
// ============================================================
interface DispatchCandidate {
  driver: Driver;
  activeDeliveryCount: number;
  sameArea: boolean;
  reason: string;
}
function rankDriverCandidates(order: Order): DispatchCandidate[] {
  const allOrders = getAllOrders();
  const candidates: DispatchCandidate[] = getAllDrivers().map(driver => {
    const activeDeliveryCount = allOrders.filter(o => o.driverId === driver.id && o.status !== 'COMPLETED').length;
    const sameArea = order.area != null && driver.area === order.area;
    const reason = [
      driver.status === 'IDLE' ? '待機中' : '配達中',
      sameArea ? `${driver.area}エリア一致` : `${driver.area}エリア`,
      `現在の配達件数${activeDeliveryCount}件`,
    ].join('・');
    return { driver, activeDeliveryCount, sameArea, reason };
  });
  candidates.sort((a, b) => {
    if ((a.driver.status === 'IDLE') !== (b.driver.status === 'IDLE')) return a.driver.status === 'IDLE' ? -1 : 1;
    if (a.sameArea !== b.sameArea) return a.sameArea ? -1 : 1;
    return a.activeDeliveryCount - b.activeDeliveryCount;
  });
  return candidates;
}

app.get('/api/orders/:id/dispatch-candidates', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const order = getOrderById(Number(req.params.id));
  if (!order) return res.status(404).json({ ok: false, error: '注文が見つかりません' });
  const ranked = rankDriverCandidates(order).map(c => ({
    driverId: c.driver.id,
    name: c.driver.name,
    status: c.driver.status,
    area: c.driver.area,
    activeDeliveryCount: c.activeDeliveryCount,
    sameArea: c.sameArea,
    reason: c.reason,
  }));
  res.json({ ok: true, orderId: order.id, orderArea: order.area, candidates: ranked });
});

// ============================================================
// KPIダッシュボード：本日注文数・本日売上・平均配達時間・加盟店ランキング・ドライバー稼働率
// ============================================================
function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}
function kpiDashboard() {
  const allOrders = getAllOrders();
  const todayOrders = allOrders.filter(o => isToday(o.createdAt));
  const todayOrderCount = todayOrders.length;
  const todayRevenue = todayOrders.filter(o => o.totalMoney).reduce((sum, o) => sum + (o.totalMoney?.amount || 0), 0);

  const completedWithTimes = allOrders.filter(o => o.status === 'COMPLETED' && o.completedAt);
  const avgDeliveryMinutes = completedWithTimes.length
    ? Math.round(
        completedWithTimes.reduce((sum, o) => sum + (new Date(o.completedAt!).getTime() - new Date(o.createdAt).getTime()) / 60000, 0) /
          completedWithTimes.length
      )
    : null;

  const storeRanking = getAllStores()
    .map(s => {
      const completed = allOrders.filter(o => o.storeId === s.id && o.status === 'COMPLETED' && o.totalMoney);
      const revenue = completed.reduce((sum, o) => sum + (o.totalMoney?.amount || 0), 0);
      return { storeId: s.id, name: s.name, orderCount: completed.length, revenue };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const drivers = getAllDrivers();
  const busyCount = drivers.filter(d => d.status === 'BUSY').length;
  const driverUtilizationRate = drivers.length ? Math.round((busyCount / drivers.length) * 100) : 0;

  return {
    todayOrderCount,
    todayRevenue,
    avgDeliveryMinutes,
    storeRanking,
    driverUtilizationRate,
    busyDriverCount: busyCount,
    totalDriverCount: drivers.length,
    currency: 'JPY',
  };
}

app.get('/api/kpi', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json({ ok: true, ...kpiDashboard() });
});

// ============================================================
// 管理画面（ログイン必須。Cookie(ord_admin_session)にJWTを保持する）
// ============================================================
function renderAdminLoginHtml(error?: string): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>ORD 管理者ログイン</title>
<style>
body{font-family:"Hiragino Sans","Yu Gothic",sans-serif;background:#14181C;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
form{background:#fff;color:#1F2D3A;padding:32px;border-radius:12px;width:280px;}
h2{margin-top:0;font-size:16px;}
input{width:100%;box-sizing:border-box;padding:10px;margin-bottom:10px;border:1px solid #E7E0D2;border-radius:6px;font-size:13px;}
button{width:100%;padding:10px;background:#0086A8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;}
.err{color:#C0392B;font-size:12px;margin-bottom:10px;}
</style></head>
<body>
<form method="POST" action="/admin/login">
  <h2>ORD 管理者ログイン</h2>
  ${error ? `<div class="err">${error}</div>` : ''}
  <input name="username" placeholder="ユーザー名" autofocus>
  <input name="password" type="password" placeholder="パスワード">
  <button type="submit">ログイン</button>
</form>
</body></html>`;
}

app.post('/admin/login', (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const row = username ? getAdminRowByUsername(username) : undefined;
  if (!row || !password || !verifyPassword(password, row.password_hash)) {
    return res.status(401).send(renderAdminLoginHtml('ユーザー名またはパスワードが違います'));
  }
  const token = signToken({ role: 'ADMIN', id: row.id, name: row.username });
  res.cookie('ord_admin_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 });
  res.redirect('/admin');
});

app.get('/admin/logout', (_req: Request, res: Response) => {
  res.clearCookie('ord_admin_session');
  res.redirect('/admin');
});

app.get('/admin', (req: Request, res: Response) => {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith('ord_admin_session='));
  const token = match ? decodeURIComponent(match.split('=')[1]) : null;
  const authed = token ? verifyToken(token) : null;
  if (!authed || authed.role !== 'ADMIN') {
    return res.send(renderAdminLoginHtml());
  }
  res.send(renderAdminHtml());
});

function renderAdminHtml(): string {
  const stores = getAllStores();
  const drivers = getAllDrivers();
  const orders = getAllOrders();

  const storeOptions = (selected: number | null) =>
    stores.map(s => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${s.name}</option>`).join('');
  const driverOptions = (selected: number | null) =>
    drivers.map(d => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${d.name}（${d.status}）</option>`).join('');
  // 未手配の注文は自動配車の候補ランキング順にドライバー選択肢を並べる（①待機中優先 ②エリア一致優先 ③配達件数が少ない順）
  const driverSelectForOrder = (order: Order) => {
    if (order.status !== 'RECEIVED') return `<select id="driver-${order.id}">${driverOptions(order.driverId)}</select>`;
    const ranked = rankDriverCandidates(order);
    if (ranked.length === 0) return `<select id="driver-${order.id}"><option value="">(配送パートナー未登録)</option></select>`;
    const opts = ranked
      .map((c, i) => `<option value="${c.driver.id}" ${i === 0 ? 'selected' : ''}>${i + 1}位: ${c.driver.name}（${c.reason}）</option>`)
      .join('');
    return `<select id="driver-${order.id}">${opts}</select>`;
  };

  const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;
  const rows = orders
    .map(
      o => `
    <tr>
      <td>${o.id}</td>
      <td>${o.squareOrderId}</td>
      <td>${o.villaName} / ${o.roomNumber}${o.area ? `（${o.area}）` : ''}</td>
      <td>${o.items.map(i => `${i.name}×${i.quantity}`).join('<br>') || '(商品情報なし)'}</td>
      <td>${o.totalMoney ? yen(o.totalMoney.amount) : '(金額情報なし)'}</td>
      <td>${o.status}</td>
      <td>
        <select id="store-${o.id}">${storeOptions(o.storeId)}</select>
        ${driverSelectForOrder(o)}
      </td>
      <td>${o.status === 'RECEIVED' ? `<button onclick="dispatchOrder(${o.id})">手配開始</button>` : '手配済み'}</td>
    </tr>`
    )
    .join('');

  const kpi = kpiDashboard();
  const storeRankingRows = kpi.storeRanking
    .map((s, i) => `<li>${i + 1}位: ${s.name}　${s.orderCount}件　${yen(s.revenue)}</li>`)
    .join('');

  const rev = revenueSummary();
  const storeSettlementRows = stores
    .map(s => `<li>${s.name}（手数料率${Math.round(s.commissionRate * 100)}%） <button onclick="viewStoreSettlement(${s.id})">精算を見る</button></li>`)
    .join('');
  const driverSettlementRows = drivers
    .map(d => `<li>${d.name} <button onclick="viewDriverSettlement(${d.id})">精算を見る</button></li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>ORD 受注管理（TypeScript版）</title>
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
.logout{float:right;font-size:12px;color:#0086A8;}
</style></head>
<body>
<a class="logout" href="/admin/logout">ログアウト</a>
<h2>ORD 受注管理（TypeScript版）</h2>
<p>Square連携: <span class="badge">${squareConfigured ? '実接続' : '未設定（Webhookペイロードのデータのみ使用）'}</span>
LINE連携: <span class="badge">${lineConfigured ? '実送信' : '未設定（コンソールログのみ）'}</span></p>

<fieldset>
  <legend>本日のKPI</legend>
  <p>本日注文数: <b>${kpi.todayOrderCount}</b>件　本日売上: <b>${yen(kpi.todayRevenue)}</b></p>
  <p>平均配達時間（全期間・完了注文ベース）: <b>${kpi.avgDeliveryMinutes != null ? kpi.avgDeliveryMinutes + '分' : '(データなし)'}</b></p>
  <p>ドライバー稼働率: <b>${kpi.driverUtilizationRate}%</b>（稼働中${kpi.busyDriverCount}/${kpi.totalDriverCount}名）</p>
  <p>加盟店ランキング（全期間売上順）:</p>
  <ul>${storeRankingRows || '<li>(データなし)</li>'}</ul>
</fieldset>

<fieldset>
  <legend>経営サマリー（完了注文ベース・概算）</legend>
  <p>完了注文数: <b>${rev.completedOrderCount}</b>件　総売上(GMV): <b>${yen(rev.grossAmount)}</b></p>
  <p>ORD手数料収益: <b>${yen(rev.commissionAmount)}</b>　配送パートナー報酬支払: <b>${yen(rev.driverPayoutTotal)}</b></p>
  <p>ORD粗利（手数料収益－配送報酬）: <b style="color:#0086A8;">${yen(rev.ordGrossProfit)}</b></p>
</fieldset>

<fieldset>
  <legend>加盟店 登録</legend>
  <input id="store-name" placeholder="店舗名">
  <input id="store-line" placeholder="LINE User ID">
  <input id="store-commission" placeholder="手数料率(%) 例:15" style="width:110px;">
  <input id="store-area" placeholder="主なエリア 例:恩納村" style="width:130px;">
  <input id="store-username" placeholder="ログインID">
  <input id="store-password" type="password" placeholder="パスワード">
  <button onclick="createStore()">登録</button>
  <p>登録済み: ${stores.map(s => `${s.name}(${s.area})`).join('、') || '(なし)'}</p>
  <ul>${storeSettlementRows || '<li>(なし)</li>'}</ul>
</fieldset>

<fieldset>
  <legend>配送パートナー 登録</legend>
  <input id="driver-name" placeholder="ドライバー名">
  <input id="driver-line" placeholder="LINE User ID">
  <input id="driver-area" placeholder="主な稼働エリア 例:恩納村" style="width:150px;">
  <input id="driver-username" placeholder="ログインID">
  <input id="driver-password" type="password" placeholder="パスワード">
  <button onclick="createDriver()">登録</button>
  <p>登録済み: ${drivers.map(d => `${d.name}(${d.status}・${d.area})`).join('、') || '(なし)'}</p>
  <ul>${driverSettlementRows || '<li>(なし)</li>'}</ul>
</fieldset>

<fieldset>
  <legend>収益シミュレーター（実データ不要・想定値から試算）</legend>
  <input id="sim-dailyOrders" placeholder="1日あたり注文数" value="20" style="width:150px;">
  <input id="sim-avgOrderValue" placeholder="客単価(円)" value="2500" style="width:120px;">
  <input id="sim-commissionRate" placeholder="手数料率(%)" value="15" style="width:110px;">
  <input id="sim-days" placeholder="日数" value="30" style="width:80px;">
  <input id="sim-driverPayout" placeholder="配送報酬/件(円)" value="400" style="width:130px;">
  <button onclick="runSimulator()">試算する</button>
  <p id="sim-result" style="white-space:pre-wrap;"></p>
</fieldset>

<table>
<tr><th>ID</th><th>Square注文ID</th><th>お届け先</th><th>商品</th><th>金額</th><th>状態</th><th>加盟店/ドライバー割当</th><th>操作</th></tr>
${rows || '<tr><td colspan="8">注文はまだありません（README.mdのcurlコマンドでテスト送信できます）</td></tr>'}
</table>

<script>
async function createStore(){
  const name = document.getElementById('store-name').value;
  const lineUserId = document.getElementById('store-line').value;
  const commissionPercent = document.getElementById('store-commission').value;
  const commissionRate = commissionPercent ? Number(commissionPercent)/100 : undefined;
  const area = document.getElementById('store-area').value;
  const username = document.getElementById('store-username').value;
  const password = document.getElementById('store-password').value;
  const res = await fetch('/api/stores', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name, lineUserId, commissionRate, area, username, password})});
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  location.reload();
}
async function viewStoreSettlement(id){
  const res = await fetch('/api/stores/'+id+'/settlement');
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  alert(d.storeName+' の精算\\n完了注文数: '+d.orderCount+'件\\n売上合計: ¥'+d.grossAmount.toLocaleString()+'\\nORD手数料('+Math.round(d.commissionRate*100)+'%): ¥'+d.commissionAmount.toLocaleString()+'\\n加盟店お支払額: ¥'+d.netPayout.toLocaleString());
}
async function viewDriverSettlement(id){
  const res = await fetch('/api/drivers/'+id+'/settlement');
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  alert(d.driverName+' の精算\\n完了配達件数: '+d.deliveryCount+'件\\n報酬単価: ¥'+d.payoutPerDelivery.toLocaleString()+'\\nお支払額: ¥'+d.payoutAmount.toLocaleString());
}
async function runSimulator(){
  const params = new URLSearchParams({
    dailyOrders: document.getElementById('sim-dailyOrders').value,
    avgOrderValue: document.getElementById('sim-avgOrderValue').value,
    commissionRate: String(Number(document.getElementById('sim-commissionRate').value)/100),
    days: document.getElementById('sim-days').value,
    driverPayoutPerDelivery: document.getElementById('sim-driverPayout').value,
  });
  const res = await fetch('/api/revenue-simulator?'+params.toString());
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  document.getElementById('sim-result').textContent =
    '期間合計注文数: '+d.totalOrders.toLocaleString()+'件\\n'+
    '総売上(GMV): ¥'+d.grossGmv.toLocaleString()+'\\n'+
    'ORD手数料収益: ¥'+d.ordCommissionRevenue.toLocaleString()+'\\n'+
    '配送パートナー報酬支払: ¥'+d.driverPayoutTotal.toLocaleString()+'\\n'+
    'ORD粗利: ¥'+d.ordGrossProfit.toLocaleString()+'（1日あたり ¥'+d.ordGrossProfitPerDay.toLocaleString()+'）';
}
async function createDriver(){
  const name = document.getElementById('driver-name').value;
  const lineUserId = document.getElementById('driver-line').value;
  const area = document.getElementById('driver-area').value;
  const username = document.getElementById('driver-username').value;
  const password = document.getElementById('driver-password').value;
  const res = await fetch('/api/drivers', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name, lineUserId, area, username, password})});
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
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

function buildCustomerFlex(order: Order, status: 'PREPARING' | 'COMPLETED'): messagingApi.FlexMessage {
  const isPreparing = status === 'PREPARING';
  return {
    type: 'flex',
    altText: isPreparing ? '【ORD】ご注文を受け付けました' : '【ORD】お届け完了しました',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#14181C',
        paddingAll: '12px',
        contents: [
          {
            type: 'text',
            text: isPreparing ? '【ORD】ご注文を受け付けました' : '【ORD】お届けが完了しました',
            weight: 'bold',
            size: 'md',
            color: '#ffffff',
            wrap: true,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `お届け先: ${order.villaName}`, wrap: true, weight: 'bold' },
          { type: 'text', text: `部屋番号: ${order.roomNumber}`, wrap: true },
          {
            type: 'text',
            text: isPreparing ? 'ただいま加盟店様にて調理を開始しました。しばらくお待ちください。' : 'ご注文の品をお届けしました。ご利用ありがとうございました。',
            wrap: true,
            size: 'sm',
            color: '#666666',
          },
          { type: 'text', text: `注文ID: ${order.squareOrderId}`, size: 'xs', color: '#888888' },
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
// 手配開始（管理画面から加盟店・ドライバーを紐付けて実行、ADMINのみ）
// ============================================================
app.post('/api/orders/:id/dispatch', requireAuth('ADMIN'), async (req: Request, res: Response) => {
  const order = getOrderById(Number(req.params.id));
  if (!order) return res.status(404).json({ ok: false, error: '注文が見つかりません' });

  const { storeId, driverId } = req.body as { storeId?: number; driverId?: number };
  const store = getStoreById(storeId ?? order.storeId ?? -1);
  const driver = getDriverById(driverId ?? order.driverId ?? -1);

  if (!store) return res.status(400).json({ ok: false, error: '加盟店が指定/紐付けされていません（先に加盟店を登録してください）' });
  if (!driver) return res.status(400).json({ ok: false, error: 'ドライバーが指定/紐付けされていません（先にドライバーを登録してください）' });

  const updatedOrder: Order = { ...order, storeId: store.id, driverId: driver.id, status: 'PREPARING' };

  try {
    await pushLine(store.lineUserId, buildStoreFlex(updatedOrder));
    await pushLine(driver.lineUserId, buildDriverFlex(updatedOrder));
    updateOrderDispatch(order.id, store.id, driver.id, 'PREPARING');
    updateDriverStatus(driver.id, 'BUSY');
    if (updatedOrder.customerLineId) {
      await pushLine(updatedOrder.customerLineId, buildCustomerFlex(updatedOrder, 'PREPARING'));
    }
    res.json({ ok: true, order: updatedOrder });
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
      const order = getOrderById(orderId);
      if (!order) return;

      let newStatus: OrderStatus | null = null;
      switch (action) {
        case 'STORE_START':
          newStatus = 'PREPARING';
          break;
        case 'STORE_READY':
          newStatus = 'READY_FOR_PICKUP';
          break;
        case 'DRIVER_ACCEPT':
          newStatus = 'READY_FOR_PICKUP';
          break;
        case 'DRIVER_PICKUP':
          newStatus = 'DELIVERING';
          break;
        case 'DRIVER_COMPLETE':
          newStatus = 'COMPLETED';
          if (order.driverId) updateDriverStatus(order.driverId, 'IDLE');
          break;
        default:
          console.log(`  → 未知のaction: ${action}`);
          return;
      }
      updateOrderStatus(order.id, newStatus);
      if (newStatus === 'COMPLETED' && order.customerLineId) {
        pushLine(order.customerLineId, buildCustomerFlex({ ...order, status: newStatus }, 'COMPLETED')).catch(e =>
          console.error('[お客様LINE通知エラー]', e)
        );
      }
      console.log(`  → 注文#${orderId} ステータス更新: ${newStatus}`);
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
