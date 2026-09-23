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
import path from 'node:path';
import { Client, Environment } from 'square';
import { messagingApi, validateSignature as validateLineSignature } from '@line/bot-sdk';
import PDFDocument from 'pdfkit';

// PDFKit標準フォント(Helvetica)は日本語非対応のため、同梱のNoto Sans JP（OFLライセンス、
// 再配布可）を明示的に指定する。CJKフォント未指定のままdoc.text()すると文字化けする。
const JP_FONT_PATH = path.join(__dirname, '..', 'assets', 'fonts', 'NotoSansJP-Regular.otf');
import { db } from './db';
import { hashPassword, verifyPassword, signToken, verifyToken, requireAuth } from './auth';
import { DELIVERY_FEE, CONTAINER_FEE, findProductById, findProductsByName } from './priceCatalog';
import { captureRawBody, isValidSquareWebhookSignature } from './webhookSecurity';
import { tryMarkWebhookEventProcessed, runInTransaction } from './webhookEvents';
import { calculateDriverReward, calculateDeliveryFee, calculateMinimumOrder, checkMinimumOrder } from './pricingRules';
import { resolveRestaurantToCustomerPricing, resolveDriverToRestaurantPricing } from './deliveryRoutePricing';
import type { LatLng } from './googleMapsClient';

const app = express();
app.use(cors({ credentials: true, origin: true }));
// verify: 既存のJSONパース処理（req.bodyの内容・挙動）は一切変更せず、
// パース対象になった生バイト列だけを追加でreq.rawBodyへ保持する（Square Webhook署名検証用、STEP2-C-6）。
// 二重パースは行わない。全ルートに適用されるが、req.bodyの既存挙動には影響しない。
app.use(express.json({ verify: captureRawBody }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || '';
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
// 【2026-09-23追加】/webhooks/lineの署名検証(x-line-signature)用。チャネルアクセストークンとは別の値。
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';

const squareConfigured = SQUARE_ACCESS_TOKEN.length > 0;
const lineConfigured = LINE_CHANNEL_ACCESS_TOKEN.length > 0;
const lineWebhookSecurityConfigured = LINE_CHANNEL_SECRET.length > 0;

// ============================================================
// Square Sandbox/Production 切替基盤（STEP2-C-7A）
// 【重要】ここではSquare通信は一切行わない。Square Clientが「どちらの環境に接続する設定に
// なっているか」を決めるだけであり、SQUARE_ENVIRONMENT=production にしただけで実際に
// 本番決済が動き出すような処理（CreatePaymentLink等）は今回まだ実装していない。
// ============================================================
type SquareEnvironmentSetting = 'sandbox' | 'production';

// SQUARE_ENVIRONMENT の値を検証する。許可値は 'sandbox' / 'production' のみ。
// 未設定の場合は安全側のデフォルトとして 'sandbox' を採用する（既存のハードコード動作と同じ）。
// 'test'/'prod'/'live'等の不正な値が明示的に設定された場合は、設定ミスの早期発見のため
// 起動時に明確なエラーで停止させる（Square未接続のローカル開発時は SQUARE_ENVIRONMENT 自体を
// 設定しない運用が通常のため、この検証によって既存の開発フローが壊れることはない）。
function resolveSquareEnvironment(raw: string | undefined): SquareEnvironmentSetting {
  if (!raw) return 'sandbox';
  if (raw === 'sandbox' || raw === 'production') return raw;
  throw new Error(
    `SQUARE_ENVIRONMENT の値が不正です（受け取った値: "${raw}"）。'sandbox' または 'production' のいずれかを指定してください。`
  );
}
const SQUARE_ENVIRONMENT: SquareEnvironmentSetting = resolveSquareEnvironment(process.env.SQUARE_ENVIRONMENT);
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID || '';
// Webhook署名検証用（Phase A）。未設定の場合、isValidSquareWebhookSignature()は
// 必ずfalseを返す設計のため、署名検証は安全側（拒否）に倒れる。
const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || '';
const SQUARE_WEBHOOK_NOTIFICATION_URL = process.env.SQUARE_WEBHOOK_NOTIFICATION_URL || '';
// Square Payment Link決済後、お客様をORD側へ戻すためのリダイレクト先（Phase A）。
// 未設定の場合はcheckoutOptions自体を省略する（Squareの既定の決済完了ページが表示される）。
// 値をこのファイルにハードコードしない。
const ORD_CHECKOUT_REDIRECT_URL = process.env.ORD_CHECKOUT_REDIRECT_URL || '';

// Square決済機能（CreatePaymentLink）を実際に使う直前に呼び出す設定検証ヘルパー（Phase Aで接続）。
interface SquareConfigValidation {
  ok: boolean;
  errors: string[];
}
function validateSquareConfigForPayments(): SquareConfigValidation {
  const errors: string[] = [];
  if (!SQUARE_ACCESS_TOKEN) errors.push('SQUARE_ACCESS_TOKEN が未設定です');
  if (!SQUARE_LOCATION_ID) errors.push('SQUARE_LOCATION_ID が未設定です');
  // SQUARE_ENVIRONMENT は resolveSquareEnvironment() が起動時に既に検証済み
  // （不正な値であればこの行に到達する前に起動時エラーで停止している）
  return { ok: errors.length === 0, errors };
}

// Square公式SDKクライアント（トークン未設定時はnullのまま。実接続を試みない）
const squareClient: Client | null = squareConfigured
  ? new Client({
      environment: SQUARE_ENVIRONMENT === 'production' ? Environment.Production : Environment.Sandbox,
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
// Order Status（調理・配送の進捗）とは別軸の、決済の成否のみを表す状態。
// PENDING = 決済未確定（この状態の注文は手配・通知・地図表示・アラートの対象外にする）。
// COMPLETEDになって初めて通常業務フローに乗せてよい。
type PaymentStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED';

interface Store {
  id: number;
  name: string;
  lineUserId: string;
  commissionRate: number; // ORDが徴収する手数料率（0〜1、例:0.15 = 15%）
  area: string; // 主な営業エリア（例:恩納村、北谷町）。自動配車の距離代替指標として使用
  // Phase B-3: DB側(ensureColumnで追加済み)には存在していたが、この型に反映されておらず
  // GET /api/stores等から参照できなかった列を追加で公開する（新しい列の追加ではない）。
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  locationSource: string | null;
  locationUpdatedAt: string | null;
  catalogStoreId: string | null; // priceCatalog.tsのstoreId（例:'s1'）。stores.idとは絶対に混同しないこと
  active: number; // 1=新規注文可能, 0=新規注文不可
}
interface Driver {
  id: number;
  name: string;
  lineUserId: string;
  status: 'IDLE' | 'BUSY';
  area: string; // 主な稼働エリア。実際のGPS連携（Phase2）までの距離代替指標
  baseLatitude: number | null;
  baseLongitude: number | null;
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
  displayNo: string | null; // お客様向けORD注文番号（フロントのorder.no、例:ORD-20260913-001）。squareOrderIdとは別物
  paymentStatus: PaymentStatus; // 決済状態（Order Statusとは別軸）
  paymentAttemptNo: number; // 決済試行回数（再決済のたびに増分、idempotencyKey生成に使用予定）
  paymentLinkId: string; // Square Payment LinkのID（未発行の間は空文字）
  accommodationId: string | null; // 宿泊施設ID（accommodations.id、例:'h1'）。Phase B
  accommodationLatitude: number | null; // 注文時点の宿泊施設座標のsnapshot。マスター変更の影響を受けない
  accommodationLongitude: number | null;
  buildingVillaNumber: string | null; // 同一住所に複数棟が存在する施設向けの識別情報（任意）
  guestName: string | null; // Phase B-2A: 配送先での宛名（必須項目、checkoutハンドラで検証）
  phoneNumber: string | null; // Phase B-2A: 配送時の顧客連絡先（必須項目）。厳格な形式チェックはしない
  deliveryLocation: string | null; // Phase B-2A: 配送場所（必須項目）。DB上はTEXT、値の集合はDELIVERY_LOCATIONSで管理
  deliveryInstructions: string | null; // Phase B-2A: 配送指示（任意項目）
  // 【2026-09-20】正式ドライバー報酬ルール接続：店舗→配送先のGoogle Routes実測時間（分、丸めない）
  // とドライバー報酬（円）。checkout時点でGoogle Routes実測が成功した場合のみ確定する。
  // 60分超（要相談）の場合はdriverRewardはNULL（¥0や仮の金額にしない、summarizeDriverPayout参照）。
  deliveryTimeMinutes: number | null;
  driverReward: number | null;
  // 【STEP・2026-09-23社長承認】配送料（checkout時に確定したtiered配送料、¥400/コミッション
  // モデルとは無関係）と、注文時点で算出できたORD推定利益（商品マスター未接続の明細が
  // 1件でもあれば算出せずnullのまま。遠方出動ボーナスはこの時点では未確定のため含まない、
  // あくまで「推定」であり正式な精算額はsettlement基盤側で確定する）。
  deliveryFee: number | null;
  estimatedOrdProfit: number | null;
}

// Phase B-2A: delivery_locationの候補値（将来のUI実装で使用）。DB側にCHECK制約は設けず、
// この配列はTypeScript側での参考管理に留める（今回UI自体は変更しない）。
const DELIVERY_LOCATIONS = ['HOTEL_FRONT_DESK', 'VILLA_ENTRANCE', 'ROOM', 'MEETING_POINT', 'OTHER'] as const;

// 加盟店手数料は0固定（2026-09-22社長確定：ORDは加盟店から手数料を一切徴収しない。
// 収益は顧客向け販売価格への上乗せのみ。詳細はproject-ord-master-pricing-dataメモリ参照）。
// このモジュール自体は概算の簡易実装であり、正確なORD収益（上乗せベース）の計算は
// STEP C-2（checkoutと商品マスターの接続）完了後に別途実装する。
const DEFAULT_COMMISSION_RATE = 0;
// 【2026-09-20】固定¥400報酬モデルは正式ドライバー報酬ルール（店舗→配送先のGoogle Routes
// 車移動時間のみで判定、30分以下¥800/31-50分¥1,000/51-60分¥1,300/60分超要相談）へ置き換え、
// 現行処理からは排除済み。orders.driver_rewardがNULLの注文は「未確定・要確認」として扱い、
// ¥0として計上しない（summarizeDriverPayout参照）。checkout/dispatchへのGoogle Routes接続
// （driver_rewardの自動計算・保存）は別フェーズのため、接続されるまでdriver_rewardは常にNULL
// のままとなる点に注意。

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
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  location_source: string | null;
  location_updated_at: string | null;
  catalog_store_id: string | null;
  active: number;
}
interface DriverRow {
  id: number;
  name: string;
  line_user_id: string;
  status: string;
  username: string;
  password_hash: string;
  area: string;
  // STEP2-D-3-B: ドライバー拠点座標（本人申告の活動拠点。DB側にはensureColumnで追加済みだが
  // これまでこの型に反映されておらず参照できなかった列を、STEP C-2 Stage 3で公開する）。
  base_latitude: number | null;
  base_longitude: number | null;
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
  display_no: string | null;
  payment_status: string;
  payment_attempt_no: number;
  payment_link_id: string;
  accommodation_id: string | null;
  accommodation_latitude: number | null;
  accommodation_longitude: number | null;
  building_villa_number: string | null;
  guest_name: string | null;
  phone_number: string | null;
  delivery_location: string | null;
  delivery_instructions: string | null;
  delivery_time_minutes: number | null;
  driver_reward: number | null;
  delivery_fee: number | null;
  estimated_ord_profit: number | null;
}

const rowToStore = (r: StoreRow): Store => ({
  id: r.id,
  name: r.name,
  lineUserId: r.line_user_id,
  commissionRate: r.commission_rate,
  area: r.area,
  address: r.address,
  latitude: r.latitude,
  longitude: r.longitude,
  locationSource: r.location_source,
  locationUpdatedAt: r.location_updated_at,
  catalogStoreId: r.catalog_store_id,
  active: r.active,
});
const rowToDriver = (r: DriverRow): Driver => ({
  id: r.id,
  name: r.name,
  lineUserId: r.line_user_id,
  status: r.status as 'IDLE' | 'BUSY',
  area: r.area,
  baseLatitude: r.base_latitude,
  baseLongitude: r.base_longitude,
});
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
  displayNo: r.display_no,
  paymentStatus: (r.payment_status as PaymentStatus) || 'PENDING',
  paymentAttemptNo: r.payment_attempt_no,
  paymentLinkId: r.payment_link_id || '',
  accommodationId: r.accommodation_id,
  accommodationLatitude: r.accommodation_latitude,
  accommodationLongitude: r.accommodation_longitude,
  buildingVillaNumber: r.building_villa_number,
  guestName: r.guest_name,
  phoneNumber: r.phone_number,
  deliveryLocation: r.delivery_location,
  deliveryInstructions: r.delivery_instructions,
  deliveryTimeMinutes: r.delivery_time_minutes,
  driverReward: r.driver_reward,
  deliveryFee: r.delivery_fee,
  estimatedOrdProfit: r.estimated_ord_profit,
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
  return {
    id: Number(info.lastInsertRowid),
    name,
    lineUserId,
    commissionRate,
    area,
    // 新規登録時点ではDBのDEFAULT値のまま（address/latitude/longitude/location_source/
    // location_updated_atはNULL、catalog_store_idはNULL、activeは0）。今回この登録処理自体は
    // 変更しない（catalog_store_id・座標の設定手段を追加するのはPhase B-3のスコープ外）。
    address: null,
    latitude: null,
    longitude: null,
    locationSource: null,
    locationUpdatedAt: null,
    catalogStoreId: null,
    active: 0,
  };
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
  // 新規登録時点ではbase_latitude/base_longitudeはDB側DEFAULT(NULL)のまま
  // （拠点座標の設定手段を追加するのは今回のスコープ外、既存のPhase2方針を踏襲）。
  return { id: Number(info.lastInsertRowid), name, lineUserId, status: 'IDLE', area, baseLatitude: null, baseLongitude: null };
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
      `INSERT INTO orders (square_order_id, items_json, villa_name, room_number, status, store_id, driver_id, created_at, customer_line_id, total_money_json, area, display_no, payment_status, payment_attempt_no, payment_link_id, accommodation_id, accommodation_latitude, accommodation_longitude, building_villa_number, guest_name, phone_number, delivery_location, delivery_instructions, delivery_time_minutes, driver_reward, delivery_fee, estimated_ord_profit)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      o.area,
      o.displayNo,
      o.paymentStatus,
      o.paymentAttemptNo,
      o.paymentLinkId,
      o.accommodationId,
      o.accommodationLatitude,
      o.accommodationLongitude,
      o.buildingVillaNumber,
      o.guestName,
      o.phoneNumber,
      o.deliveryLocation,
      o.deliveryInstructions,
      o.deliveryTimeMinutes,
      o.driverReward,
      o.deliveryFee,
      o.estimatedOrdProfit
    );
  return { ...o, id: Number(info.lastInsertRowid), completedAt: null };
}
// catalog_store_id（priceCatalog.tsのstoreId、例:'s1'）からstores.idを解決する（Phase B）。
// 【重要】顧客ブラウザから送信されたstore_idは一切信用しない。商品マスターから解決した
// catalog_store_idのみをこの関数の入力として使う。
interface StoreResolution {
  id: number;
  active: number;
  latitude: number | null;
  longitude: number | null;
}
function getStoreByCatalogId(catalogStoreId: string): StoreResolution | undefined {
  return db.prepare('SELECT id, active, latitude, longitude FROM stores WHERE catalog_store_id = ?').get(catalogStoreId) as
    | StoreResolution
    | undefined;
}
// accommodation_idの実在確認（Phase B）。存在しない/非activeな場合はundefinedを返す責務は
// 呼び出し側に持たせ、この関数自体は生データを返すだけにする。
interface AccommodationResolution {
  id: string;
  active: number;
  latitude: number | null;
  longitude: number | null;
}
function getAccommodationById(id: string): AccommodationResolution | undefined {
  return db.prepare('SELECT id, active, latitude, longitude FROM accommodations WHERE id = ?').get(id) as
    | AccommodationResolution
    | undefined;
}

// ============================================================
// Phase B-3: 宿泊施設(accommodations)・加盟店(stores)マスタ管理用の関数
// 【重要】getAccommodationById()（checkout専用、id/active/latitude/longitudeのみ）とは別の
// 関数として追加する。checkout側のロジック・戻り値の形は一切変更しない。
// ============================================================
interface AccommodationRow {
  id: string;
  name: string;
  area: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  location_source: string | null;
  location_updated_at: string | null;
  active: number;
}
interface Accommodation {
  id: string;
  name: string;
  area: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  locationSource: string | null;
  locationUpdatedAt: string | null;
  active: number; // 1=新規注文時に選択可能, 0=選択不可
}
const rowToAccommodation = (r: AccommodationRow): Accommodation => ({
  id: r.id,
  name: r.name,
  area: r.area,
  address: r.address,
  latitude: r.latitude,
  longitude: r.longitude,
  locationSource: r.location_source,
  locationUpdatedAt: r.location_updated_at,
  active: r.active,
});
function getAllAccommodations(): Accommodation[] {
  return (db.prepare('SELECT * FROM accommodations ORDER BY id').all() as unknown as AccommodationRow[]).map(rowToAccommodation);
}
function getAccommodationDetail(id: string): Accommodation | undefined {
  const row = db.prepare('SELECT * FROM accommodations WHERE id = ?').get(id) as AccommodationRow | undefined;
  return row ? rowToAccommodation(row) : undefined;
}
// active切り替えのみ。物理削除・座標更新機能はPhase B-3のスコープ外のため用意しない。
function updateAccommodationActive(id: string, active: boolean): Accommodation | undefined {
  db.prepare('UPDATE accommodations SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return getAccommodationDetail(id);
}
// stores側は既存のgetStoreById()がSELECT * を使っておりrowToStore()拡張だけで詳細取得を賄えるため、
// 重複した取得関数は追加しない。activeの切り替えのみ新設する。
function updateStoreActive(id: number, active: boolean): Store | undefined {
  db.prepare('UPDATE stores SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return getStoreById(id);
}

// ============================================================
// 商品マスター基盤 STEP2：手動Draft作成 → 確認 → Approve/Reject → products version作成
// 【重要】このAPI群はcheckout・index.html・priceCatalog.tsのどこからも参照されない、
// 完全に独立した管理機能である。既存の商品購入フローには一切影響しない。
// ============================================================
interface ProductDraftRow {
  id: number;
  source_document_id: number | null;
  store_id: number;
  extracted_name: string | null;
  extracted_name_en: string | null;
  extracted_description: string | null;
  extracted_description_en: string | null;
  extracted_merchant_price: number | null;
  extracted_container_fee: number | null;
  markup_rate: number | null;
  computed_ord_price: number | null;
  calculation_basis: string | null;
  confidence: number | null;
  needs_review: number;
  status: string;
  created_at: string;
  updated_at: string;
  rejection_reason: string | null;
  extracted_container_count: number | null;
  extracted_category: string | null;
}
interface ProductDraft {
  id: number;
  sourceDocumentId: number | null;
  storeId: number;
  extractedName: string | null;
  extractedNameEn: string | null;
  extractedDescription: string | null;
  extractedDescriptionEn: string | null;
  extractedMerchantPrice: number | null;
  extractedContainerFee: number | null;
  markupRate: number | null;
  computedOrdPrice: number | null;
  calculationBasis: string | null;
  confidence: number | null;
  needsReview: boolean;
  status: string; // 'DRAFT' | 'NEEDS_REVIEW' | 'APPROVED' | 'REJECTED'（DB側にCHECK制約は設けない既存方針）
  createdAt: string;
  updatedAt: string;
  rejectionReason: string | null;
  extractedContainerCount: number | null; // 商品マスター完成版：容器の個数（監査用メタデータ）
  extractedCategory: string | null; // 商品マスター完成版：Food/Dessert/Drink等（監査用メタデータ）
}
const rowToProductDraft = (r: ProductDraftRow): ProductDraft => ({
  id: r.id,
  sourceDocumentId: r.source_document_id,
  storeId: r.store_id,
  extractedName: r.extracted_name,
  extractedNameEn: r.extracted_name_en,
  extractedDescription: r.extracted_description,
  extractedDescriptionEn: r.extracted_description_en,
  extractedMerchantPrice: r.extracted_merchant_price,
  extractedContainerFee: r.extracted_container_fee,
  markupRate: r.markup_rate,
  computedOrdPrice: r.computed_ord_price,
  calculationBasis: r.calculation_basis,
  confidence: r.confidence,
  needsReview: !!r.needs_review,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  rejectionReason: r.rejection_reason,
  extractedContainerCount: r.extracted_container_count,
  extractedCategory: r.extracted_category,
});

interface ProductRow {
  id: number;
  product_key: string;
  store_id: number;
  version: number;
  name: string;
  name_en: string | null;
  description: string | null;
  description_en: string | null;
  merchant_price: number | null;
  container_fee: number | null;
  markup_rate: number | null;
  ord_price: number;
  image_reference: string | null;
  status: string;
  source_draft_id: number | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  superseded_at: string | null;
  square_catalog_item_id: string | null;
  container_count: number | null;
  category: string | null;
  gokun_nuki_available: number;
}
interface Product {
  id: number;
  productKey: string;
  storeId: number;
  version: number;
  name: string;
  nameEn: string | null;
  description: string | null;
  descriptionEn: string | null;
  merchantPrice: number | null;
  containerFee: number | null;
  markupRate: number | null;
  ordPrice: number;
  imageReference: string | null;
  status: string; // 'ACTIVE' | 'INACTIVE'
  sourceDraftId: number | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  supersededAt: string | null; // null = 現行版
  squareCatalogItemId: string | null; // 商品マスター完成版：Square Catalog連携用の外部参照ID。ORDが正本。
  containerCount: number | null; // 商品マスター完成版：容器の個数（監査用メタデータ）
  category: string | null; // 商品マスター完成版：Food/Dessert/Drink等（監査用メタデータ）
  gokunNukiAvailable: boolean; // 【2026-09-23社長承認】五葷抜き選択可否（同額オプション）
}
const rowToProduct = (r: ProductRow): Product => ({
  id: r.id,
  productKey: r.product_key,
  storeId: r.store_id,
  version: r.version,
  name: r.name,
  nameEn: r.name_en,
  description: r.description,
  descriptionEn: r.description_en,
  merchantPrice: r.merchant_price,
  containerFee: r.container_fee,
  markupRate: r.markup_rate,
  ordPrice: r.ord_price,
  imageReference: r.image_reference,
  status: r.status,
  sourceDraftId: r.source_draft_id,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  createdAt: r.created_at,
  supersededAt: r.superseded_at,
  squareCatalogItemId: r.square_catalog_item_id,
  containerCount: r.container_count,
  category: r.category,
  gokunNukiAvailable: !!r.gokun_nuki_available,
});

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

// ORD価格計算式（B-4/商品マスターSTEP1で確定済み）: (加盟店価格 + 容器代) × (1 + 上乗せ率)。
// ドリンクのように容器代が¥0の商品も同じ式でそのまま扱える（容器代の値自体で区別されるため、
// 「料理/ドリンク」という区分をこの関数に持ち込む必要はない）。
// 【重要】この関数の戻り値のみを正式なord_priceとして採用する。クライアント送信の
// computed_ord_priceは、Draft作成時・承認時のいずれにおいても信用しない。
function computeOrdPrice(merchantPrice: unknown, containerFee: unknown, markupRate: unknown): number | null {
  if (!isFiniteNonNegative(merchantPrice) || !isFiniteNonNegative(containerFee) || !isFiniteNonNegative(markupRate)) {
    return null;
  }
  return Math.round((merchantPrice + containerFee) * (1 + markupRate));
}
function buildCalculationBasis(merchantPrice: number, containerFee: number, markupRate: number): string {
  return `(${merchantPrice} + ${containerFee}) * ${1 + markupRate}`;
}

// 商品マスター完成版：容器代・容器数の参考ルール（社長承認の正式基準）。
// 【重要】これはDraft作成・承認画面での「参考値・監査根拠」としてのみ使用し、
// extracted_container_fee/container_feeを自動的に上書き・強制計算する用途には使わない
// （例外商品を許容するため。AIが判断した値も自動確定しない既存方針の踏襲）。
const CONTAINER_RULE_REFERENCE: Record<string, { fee: number; count: number }> = {
  'ドリンク': { fee: 0, count: 0 },
  '通常フード': { fee: 50, count: 1 },
  'ラーメン等': { fee: 100, count: 2 },
  'カレー': { fee: 100, count: 2 },
};
// category/container_count/container_feeの組み合わせが既知の基準と明らかに矛盾していないかを判定する。
// categoryが未知/未設定、またはcontainerCount/containerFeeが未設定の場合は「判定不能」として
// 不整合なし扱いにする（推測で不整合と決めつけない）。
function detectContainerRuleInconsistency(
  category: string | null,
  containerCount: number | null,
  containerFee: number | null
): boolean {
  if (!category) return false;
  const ref = CONTAINER_RULE_REFERENCE[category];
  if (!ref) return false; // 未知のcategoryは判定不能（新カテゴリの可能性があり、推測で拒否しない）
  const feeMismatch = containerFee != null && containerFee !== ref.fee;
  const countMismatch = containerCount != null && containerCount !== ref.count;
  return feeMismatch || countMismatch;
}

// STEP3：原本(menu_source_documents)の読み取り専用アクセス。作成・更新・削除APIは今回追加しない
// （原本アップロード機能自体はAI取り込みと合わせて別STEPで実装する想定）。
interface MenuSourceDocumentRow {
  id: number;
  store_id: number;
  file_reference: string;
  original_filename: string | null;
  mime_type: string | null;
  file_size: number | null;
  file_hash: string | null;
  uploaded_at: string;
  uploaded_by: string | null;
  notes: string | null;
}
interface MenuSourceDocument {
  id: number;
  storeId: number;
  fileReference: string;
  originalFilename: string | null;
  mimeType: string | null;
  fileSize: number | null;
  fileHash: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
  notes: string | null;
}
const rowToMenuSourceDocument = (r: MenuSourceDocumentRow): MenuSourceDocument => ({
  id: r.id,
  storeId: r.store_id,
  fileReference: r.file_reference,
  originalFilename: r.original_filename,
  mimeType: r.mime_type,
  fileSize: r.file_size,
  fileHash: r.file_hash,
  uploadedAt: r.uploaded_at,
  uploadedBy: r.uploaded_by,
  notes: r.notes,
});
function getMenuSourceDocumentById(id: number): MenuSourceDocument | undefined {
  const row = db.prepare('SELECT * FROM menu_source_documents WHERE id = ?').get(id) as MenuSourceDocumentRow | undefined;
  return row ? rowToMenuSourceDocument(row) : undefined;
}

// STEP3：新規商品のproduct_keyをBackend側で安全に自動生成する（'P001'形式）。
// 【重要】ブラウザから送られたproduct_keyを新規商品キーとして信用しない。
// 過去にsupersededされた行も含め、productsテーブルに存在する全product_keyのうち
// 'P'+数字 形式のものの最大値を求め、次の番号を採番する（product_keyはSTEP2追加調査で
// 確認済みの通り、店舗をまたいでグローバルに一意でなければならないため、全店舗・全version
// を対象にスキャンする）。
function generateNextProductKey(): string {
  const rows = db.prepare('SELECT DISTINCT product_key FROM products').all() as { product_key: string }[];
  let maxNum = 0;
  for (const r of rows) {
    const m = /^P(\d+)$/.exec(r.product_key);
    if (m) {
      const n = Number(m[1]);
      if (n > maxNum) maxNum = n;
    }
  }
  return 'P' + String(maxNum + 1).padStart(3, '0');
}

function getAllProductDrafts(): ProductDraft[] {
  return (db.prepare('SELECT * FROM product_drafts ORDER BY id DESC').all() as unknown as ProductDraftRow[]).map(rowToProductDraft);
}
function getProductDraftById(id: number): ProductDraft | undefined {
  const row = db.prepare('SELECT * FROM product_drafts WHERE id = ?').get(id) as ProductDraftRow | undefined;
  return row ? rowToProductDraft(row) : undefined;
}

interface InsertProductDraftInput {
  storeId: number;
  sourceDocumentId: number | null;
  extractedName: string | null;
  extractedNameEn: string | null;
  extractedDescription: string | null;
  extractedDescriptionEn: string | null;
  extractedMerchantPrice: number | null;
  extractedContainerFee: number | null;
  markupRate: number | null;
  confidence: number | null;
  needsReviewRequested: boolean; // クライアントが明示的に要確認を希望した場合。falseにする方向へは強制できない
  extractedContainerCount: number | null; // 商品マスター完成版
  extractedCategory: string | null; // 商品マスター完成版
}
// 【重要】computed_ord_price/calculation_basisはこの関数が必ずBackend側で算出し、
// 呼び出し元（POST /api/product-drafts）からクライアント送信値を一切受け取らない。
// merchant_price/container_fee/markup_rateのいずれかが未確定・不正な場合はcomputed_ord_price=null、
// needs_review=trueを強制する（推測で埋めない）。
// 商品マスター完成版：category/container_count/container_feeの組み合わせに明らかな不整合が
// 検知された場合もneeds_review=trueを強制する（社長承認：承認時はこれを400でハードブロックする）。
function insertProductDraft(input: InsertProductDraftInput): ProductDraft {
  const now = new Date().toISOString();
  const computedOrdPrice = computeOrdPrice(input.extractedMerchantPrice, input.extractedContainerFee, input.markupRate);
  const calculationBasis =
    computedOrdPrice !== null
      ? buildCalculationBasis(input.extractedMerchantPrice as number, input.extractedContainerFee as number, input.markupRate as number)
      : null;
  const containerInconsistent = detectContainerRuleInconsistency(input.extractedCategory, input.extractedContainerCount, input.extractedContainerFee);
  const needsReview = input.needsReviewRequested || computedOrdPrice === null || containerInconsistent;
  const status = needsReview ? 'NEEDS_REVIEW' : 'DRAFT';

  const info = db
    .prepare(
      `INSERT INTO product_drafts (source_document_id, store_id, extracted_name, extracted_name_en, extracted_description, extracted_description_en, extracted_merchant_price, extracted_container_fee, markup_rate, computed_ord_price, calculation_basis, confidence, needs_review, status, created_at, updated_at, extracted_container_count, extracted_category)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.sourceDocumentId,
      input.storeId,
      input.extractedName,
      input.extractedNameEn,
      input.extractedDescription,
      input.extractedDescriptionEn,
      input.extractedMerchantPrice,
      input.extractedContainerFee,
      input.markupRate,
      computedOrdPrice,
      calculationBasis,
      input.confidence,
      needsReview ? 1 : 0,
      status,
      now,
      now,
      input.extractedContainerCount,
      input.extractedCategory
    );
  return getProductDraftById(Number(info.lastInsertRowid))!;
}

function markProductDraftRejected(id: number, rejectionReason: string | null): ProductDraft | undefined {
  db.prepare("UPDATE product_drafts SET status = 'REJECTED', rejection_reason = ?, updated_at = ? WHERE id = ?").run(
    rejectionReason,
    new Date().toISOString(),
    id
  );
  return getProductDraftById(id);
}
function markProductDraftApproved(id: number): void {
  db.prepare("UPDATE product_drafts SET status = 'APPROVED', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

function getCurrentProducts(): Product[] {
  return (db.prepare('SELECT * FROM products WHERE superseded_at IS NULL ORDER BY product_key').all() as unknown as ProductRow[]).map(
    rowToProduct
  );
}
function getProductVersionsByKey(productKey: string): Product[] {
  return (db.prepare('SELECT * FROM products WHERE product_key = ? ORDER BY version').all(productKey) as unknown as ProductRow[]).map(
    rowToProduct
  );
}
function getCurrentProductByKey(productKey: string): ProductRow | undefined {
  return db.prepare('SELECT * FROM products WHERE product_key = ? AND superseded_at IS NULL').get(productKey) as
    | ProductRow
    | undefined;
}
// 【STEP C-2】checkoutの商品解決を商品マスター(products)優先にするための照合。
// product_keyが分からない場合（現行index.htmlはproduct_key未送信）のフォールバックとして、
// 「同一加盟店・同一商品名・現行version・掲載中(ACTIVE)」で一意に絞り込む。
// 複数件ヒットする場合は一意に特定できないため、安全側でundefinedを返す（推測しない）。
function getCurrentProductByStoreAndName(storeId: number, name: string): ProductRow | undefined {
  const rows = db
    .prepare("SELECT * FROM products WHERE store_id = ? AND name = ? AND superseded_at IS NULL AND status = 'ACTIVE'")
    .all(storeId, name) as unknown as ProductRow[];
  return rows.length === 1 ? rows[0] : undefined;
}

// 【2026-09-23社長承認】五葷抜き対応可否は価格に影響しない属性のため、価格変更のような
// version履歴を作らず、現行versionの行を直接UPDATEする（store.activeの切替と同じ考え方）。
function updateProductGokunNukiAvailable(productKey: string, available: boolean): Product | undefined {
  const current = getCurrentProductByKey(productKey);
  if (!current) return undefined;
  db.prepare('UPDATE products SET gokun_nuki_available = ? WHERE id = ?').run(available ? 1 : 0, current.id);
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(current.id) as unknown as ProductRow;
  return rowToProduct(row);
}

interface CreateProductVersionInput {
  productKey: string;
  storeId: number;
  name: string;
  nameEn: string | null;
  description: string | null;
  descriptionEn: string | null;
  merchantPrice: number;
  containerFee: number;
  markupRate: number;
  ordPrice: number;
  sourceDraftId: number | null;
  approvedBy: string;
  containerCount: number | null; // 商品マスター完成版：Draftの値をそのまま採用（NULLならNULL、旧版から自動継承しない）
  category: string | null; // 同上
  // 商品マスター完成版：square_catalog_item_id。
  // undefined = 未指定（通常の価格改定シナリオ）→ 旧Versionから自動継承する。
  // string|null = 明示的に指定（Square側で商品を作り直した場合等）→ その値を優先する（継承しない）。
  squareCatalogItemId?: string | null;
  gokunNukiAvailable?: boolean; // 未指定時は現行version(あれば)の値を引き継ぐ。新規商品はfalse
}
// 【最重要】既存versionをUPDATEしない。旧versionはsuperseded_atを設定するだけで残し、
// 新versionを新規INSERTする。両方の操作を単一トランザクションにまとめ、途中で失敗した場合は
// 「旧versionだけsuperseded済みで新versionが存在しない」状態を防ぐ（runInTransaction、
// Phase Aで既に実装済みの汎用ヘルパーをそのまま再利用する）。
function createProductVersion(input: CreateProductVersionInput): Product {
  return runInTransaction(() => {
    const current = getCurrentProductByKey(input.productKey);
    const now = new Date().toISOString();
    const nextVersion = current ? current.version + 1 : 1;
    // square_catalog_item_id：リクエストで明示的に指定されていればそれを優先、
    // 未指定(undefined)なら旧Versionから自動継承する（新規商品で旧Versionが無ければnull）。
    const squareCatalogItemId =
      input.squareCatalogItemId !== undefined ? input.squareCatalogItemId : current?.square_catalog_item_id ?? null;
    const gokunNukiAvailable = input.gokunNukiAvailable ?? !!current?.gokun_nuki_available;

    if (current) {
      db.prepare('UPDATE products SET superseded_at = ? WHERE id = ?').run(now, current.id);
    }

    const info = db
      .prepare(
        `INSERT INTO products (product_key, store_id, version, name, name_en, description, description_en, merchant_price, container_fee, markup_rate, ord_price, status, source_draft_id, approved_by, approved_at, created_at, container_count, category, square_catalog_item_id, gokun_nuki_available)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', ?,?,?,?,?,?,?,?)`
      )
      .run(
        input.productKey,
        input.storeId,
        nextVersion,
        input.name,
        input.nameEn,
        input.description,
        input.descriptionEn,
        input.merchantPrice,
        input.containerFee,
        input.markupRate,
        input.ordPrice,
        input.sourceDraftId,
        input.approvedBy,
        now,
        now,
        input.containerCount,
        input.category,
        squareCatalogItemId,
        gokunNukiAvailable ? 1 : 0
      );
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as ProductRow;
    return rowToProduct(row);
  });
}

// ============================================================
// 精算基盤（テスト環境限定、社長承認済み設計）
// 【重要】今回はDB基盤＋計算ロジックのみ。checkout/productsの実接続・REST API化・管理画面表示は
// 別フェーズとして明確にスコープ外とする（現状のcheckoutはpriceCatalog.tsのみ参照しており、
// productsテーブルを一切参照していないため、実際の注文からorder_line_itemsを自動生成する
// 仕組みはまだ存在しない。合成データによるロジック検証のみを今回の範囲とする）。
// 既存のcommissionRateForStore()（%コミッション）・calculateOrdProfit()（Square手数料込み
// 混合利益、pricingRules.ts）はいずれも変更・削除せず、そのまま共存させる（今回の精算基盤とは
// 別モデルとして併存）。なお固定¥400ドライバー報酬モデルは2026-09-20に正式ドライバー報酬
// ルールへ置き換え済み（DRIVER_PAYOUT_PER_DELIVERYは削除済み、summarizeDriverPayout参照）。
// ============================================================

interface OrderLineItemRow {
  id: number;
  order_id: number;
  product_key: string | null;
  product_version: number | null;
  product_name: string;
  quantity: number;
  merchant_price: number | null;
  container_fee: number | null;
  markup_rate: number | null;
  ord_price_unit: number | null;
  created_at: string;
  gokun_nuki_requested: number;
}
interface OrderLineItem {
  id: number;
  orderId: number;
  productKey: string | null;
  productVersion: number | null;
  productName: string;
  quantity: number;
  merchantPrice: number | null;
  containerFee: number | null;
  markupRate: number | null;
  ordPriceUnit: number | null;
  createdAt: string;
  gokunNukiRequested: boolean; // 【2026-09-23社長承認】注文時点でお客様が五葷抜きを選択したか
}
const rowToOrderLineItem = (r: OrderLineItemRow): OrderLineItem => ({
  id: r.id,
  orderId: r.order_id,
  productKey: r.product_key,
  productVersion: r.product_version,
  productName: r.product_name,
  quantity: r.quantity,
  merchantPrice: r.merchant_price,
  containerFee: r.container_fee,
  markupRate: r.markup_rate,
  ordPriceUnit: r.ord_price_unit,
  createdAt: r.created_at,
  gokunNukiRequested: !!r.gokun_nuki_requested,
});

interface SettlementRow {
  id: number;
  payee_type: string;
  payee_id: number;
  period_start: string;
  period_end: string;
  amount: number;
  status: string;
  created_at: string;
  confirmed_at: string | null;
  paid_at: string | null;
  paid_by: string | null;
  transfer_reference: string | null;
  notes: string | null;
}
interface Settlement {
  id: number;
  payeeType: string; // 'STORE' | 'DRIVER'
  payeeId: number;
  periodStart: string;
  periodEnd: string;
  amount: number; // 作成時に一度だけ確定。advanceSettlementStatus()では絶対に変更しない
  status: string; // 'UNSETTLED' | 'CONFIRMED' | 'READY_FOR_PAYMENT' | 'PAID' | 'VERIFIED'
  createdAt: string;
  confirmedAt: string | null;
  paidAt: string | null;
  paidBy: string | null;
  transferReference: string | null;
  notes: string | null;
}
const rowToSettlement = (r: SettlementRow): Settlement => ({
  id: r.id,
  payeeType: r.payee_type,
  payeeId: r.payee_id,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  amount: r.amount,
  status: r.status,
  createdAt: r.created_at,
  confirmedAt: r.confirmed_at,
  paidAt: r.paid_at,
  paidBy: r.paid_by,
  transferReference: r.transfer_reference,
  notes: r.notes,
});

interface SettlementItemRow {
  id: number;
  settlement_id: number;
  order_id: number;
  order_line_item_id: number | null;
  amount: number;
  created_at: string;
}
interface SettlementItem {
  id: number;
  settlementId: number;
  orderId: number;
  orderLineItemId: number | null; // NULL = ドライバー精算（注文単位）。非NULL = 加盟店精算（明細単位）
  amount: number;
  createdAt: string;
}
const rowToSettlementItem = (r: SettlementItemRow): SettlementItem => ({
  id: r.id,
  settlementId: r.settlement_id,
  orderId: r.order_id,
  orderLineItemId: r.order_line_item_id,
  amount: r.amount,
  createdAt: r.created_at,
});

// ---- 純粋計算関数（正式ルール：社長承認済み） ----
// 加盟店売上 = 加盟店定価 + 容器代
function computeMerchantSalesUnit(merchantPrice: number, containerFee: number): number {
  return merchantPrice + containerFee;
}
// 商品粗利益（1個あたり） = ORD単価 - 加盟店売上（単価）
// 【重要】ORD単価自体は既存のcomputeOrdPrice()（(merchantPrice+containerFee)×(1+markupRate)）を
// そのまま再利用する。新しい価格計算式をここに作らない。
function computeProductGrossProfitUnit(ordPriceUnit: number, merchantSalesUnit: number): number {
  return ordPriceUnit - merchantSalesUnit;
}
// ドライバー合計報酬 = 基本報酬 + 遠距離加算
function computeDriverTotalReward(driverReward: number, remoteDispatchBonus: number): number {
  return driverReward + remoteDispatchBonus;
}
// 配送粗利益 = 配送売上（お客様が支払う配送料） - ドライバー合計報酬
function computeDeliveryGrossProfit(deliverySales: number, driverTotalReward: number): number {
  return deliverySales - driverTotalReward;
}
// ORD粗利益（1注文） = 商品粗利益合計 + 配送粗利益
// 【重要】Square手数料等は含めない（それらはcalculateOrdProfit()側の別モデルの責務であり、
// 混同しない。将来Square手数料・返金等を追加する場合も、この3段階の外側の別計算として扱う）。
function computeOrdGrossProfitForOrder(
  lineItems: { merchantPrice: number; containerFee: number; ordPriceUnit: number; quantity: number }[],
  deliverySales: number,
  driverTotalReward: number
): number {
  const productGrossProfitTotal = lineItems.reduce((sum, li) => {
    const merchantSalesUnit = computeMerchantSalesUnit(li.merchantPrice, li.containerFee);
    const profitUnit = computeProductGrossProfitUnit(li.ordPriceUnit, merchantSalesUnit);
    return sum + profitUnit * li.quantity;
  }, 0);
  return productGrossProfitTotal + computeDeliveryGrossProfit(deliverySales, driverTotalReward);
}

// 精算対象として適格かどうかの判定。
// 「決済完了」= paymentStatus==='COMPLETED'、「正式成立・必要な完了条件を満たす」= status==='COMPLETED'
// （配達完了）。いずれか一方でも満たさない注文（未決済・調理中・配達中・キャンセル等）は
// 推測で精算対象に含めない（社長承認済みの絞り込み条件）。
function isOrderEligibleForSettlement(order: { paymentStatus: string; status: string }): boolean {
  return order.paymentStatus === 'COMPLETED' && order.status === 'COMPLETED';
}

function insertOrderLineItem(input: {
  orderId: number;
  productKey: string | null;
  productVersion: number | null;
  productName: string;
  quantity: number;
  merchantPrice: number | null;
  containerFee: number | null;
  markupRate: number | null;
  ordPriceUnit: number | null;
  gokunNukiRequested?: boolean;
}): OrderLineItem {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO order_line_items (order_id, product_key, product_version, product_name, quantity, merchant_price, container_fee, markup_rate, ord_price_unit, created_at, gokun_nuki_requested)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      input.orderId,
      input.productKey,
      input.productVersion,
      input.productName,
      input.quantity,
      input.merchantPrice,
      input.containerFee,
      input.markupRate,
      input.ordPriceUnit,
      now,
      input.gokunNukiRequested ? 1 : 0
    );
  const row = db.prepare('SELECT * FROM order_line_items WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as OrderLineItemRow;
  return rowToOrderLineItem(row);
}
function getOrderLineItemsByOrderId(orderId: number): OrderLineItem[] {
  return (db.prepare('SELECT * FROM order_line_items WHERE order_id = ? ORDER BY id').all(orderId) as unknown as OrderLineItemRow[]).map(
    rowToOrderLineItem
  );
}

function getSettlementById(id: number): Settlement | undefined {
  const row = db.prepare('SELECT * FROM settlements WHERE id = ?').get(id) as SettlementRow | undefined;
  return row ? rowToSettlement(row) : undefined;
}
function getSettlementItemsBySettlementId(settlementId: number): SettlementItem[] {
  return (
    db.prepare('SELECT * FROM settlement_items WHERE settlement_id = ? ORDER BY id').all(settlementId) as unknown as SettlementItemRow[]
  ).map(rowToSettlementItem);
}

// 【重要】1注文=1加盟店の既存前提（Phase Bで確定済み）に基づき、注文明細は必ず単一のstore_idに
// 帰属する（order_line_items自体はstore_idを持たず、orders.store_id経由でのみ加盟店に紐づく）。
// 精算対象＝「決済完了・配達完了」かつ「まだどの精算にも計上されていない」明細/注文のみ。
function getUnsettledStoreLineItems(
  storeId: number,
  periodStart: string,
  periodEnd: string
): { orderId: number; orderLineItemId: number; amount: number }[] {
  const rows = db
    .prepare(
      `SELECT oli.id as order_line_item_id, oli.order_id, oli.quantity, oli.merchant_price, oli.container_fee
       FROM order_line_items oli
       JOIN orders o ON o.id = oli.order_id
       LEFT JOIN settlement_items si ON si.order_line_item_id = oli.id
       WHERE o.store_id = ?
         AND o.payment_status = 'COMPLETED'
         AND o.status = 'COMPLETED'
         AND o.created_at >= ? AND o.created_at <= ?
         AND si.id IS NULL
         AND oli.merchant_price IS NOT NULL
         AND oli.container_fee IS NOT NULL`
    )
    .all(storeId, periodStart, periodEnd) as { order_line_item_id: number; order_id: number; quantity: number; merchant_price: number; container_fee: number }[];
  return rows.map(r => ({
    orderId: r.order_id,
    orderLineItemId: r.order_line_item_id,
    amount: computeMerchantSalesUnit(r.merchant_price, r.container_fee) * r.quantity,
  }));
}
function getUnsettledDriverOrders(
  driverId: number,
  periodStart: string,
  periodEnd: string
): { orderId: number; amount: number }[] {
  const rows = db
    .prepare(
      `SELECT o.id as order_id, o.driver_reward, o.remote_dispatch_bonus
       FROM orders o
       LEFT JOIN settlement_items si ON si.order_id = o.id AND si.order_line_item_id IS NULL
       WHERE o.driver_id = ?
         AND o.payment_status = 'COMPLETED'
         AND o.status = 'COMPLETED'
         AND o.created_at >= ? AND o.created_at <= ?
         AND si.id IS NULL
         AND o.driver_reward IS NOT NULL
         AND o.remote_dispatch_bonus IS NOT NULL`
    )
    .all(driverId, periodStart, periodEnd) as { order_id: number; driver_reward: number; remote_dispatch_bonus: number }[];
  return rows.map(r => ({
    orderId: r.order_id,
    amount: computeDriverTotalReward(r.driver_reward, r.remote_dispatch_bonus),
  }));
}

interface SettlementCandidate {
  orderId: number;
  orderLineItemId: number | null; // NULL = ドライバー精算
  amount: number;
}
// 【最重要】settlements.amountはここで一度だけ確定する。以後advanceSettlementStatus()は
// amountを絶対に変更しない。同一期間の重複作成・同一明細/注文の二重計上は、それぞれ
// idx_settlements_unique_period / idx_settlement_items_line_once・driver_order_onceの
// DB制約により例外がスローされる（runInTransactionでROLLBACKされ、部分的な作成は残らない）。
function createSettlement(
  payeeType: 'STORE' | 'DRIVER',
  payeeId: number,
  periodStart: string,
  periodEnd: string,
  candidates: SettlementCandidate[]
): Settlement {
  if (candidates.length === 0) {
    throw new Error('精算対象が0件のため精算を作成できません');
  }
  const totalAmount = candidates.reduce((sum, c) => sum + c.amount, 0);
  return runInTransaction(() => {
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO settlements (payee_type, payee_id, period_start, period_end, amount, status, created_at)
         VALUES (?,?,?,?,?, 'UNSETTLED', ?)`
      )
      .run(payeeType, payeeId, periodStart, periodEnd, totalAmount, now);
    const settlementId = Number(info.lastInsertRowid);
    for (const c of candidates) {
      db.prepare(
        `INSERT INTO settlement_items (settlement_id, order_id, order_line_item_id, amount, created_at) VALUES (?,?,?,?,?)`
      ).run(settlementId, c.orderId, c.orderLineItemId, c.amount, now);
    }
    return getSettlementById(settlementId)!;
  });
}

const SETTLEMENT_STATUS_ORDER = ['UNSETTLED', 'CONFIRMED', 'READY_FOR_PAYMENT', 'PAID', 'VERIFIED'] as const;
type SettlementStatus = (typeof SETTLEMENT_STATUS_ORDER)[number];
// 【最重要】一方向遷移のみ許可（逆行・同一ステータスへの再設定は例外を投げる）。
// amountは絶対に更新しない（UPDATE文の対象列にamountを含めないことで構造的に保証する）。
function advanceSettlementStatus(
  id: number,
  newStatus: SettlementStatus,
  extra: { paidBy?: string; transferReference?: string } = {}
): Settlement {
  const current = getSettlementById(id);
  if (!current) throw new Error(`settlement id=${id} が見つかりません`);
  const curIdx = SETTLEMENT_STATUS_ORDER.indexOf(current.status as SettlementStatus);
  const newIdx = SETTLEMENT_STATUS_ORDER.indexOf(newStatus);
  if (curIdx === -1 || newIdx === -1 || newIdx <= curIdx) {
    throw new Error(`ステータスは一方向にのみ遷移できます（現在:${current.status} → 指定:${newStatus}は許可されません）`);
  }
  const now = new Date().toISOString();
  const sets: string[] = ['status = ?'];
  const params: (string | number)[] = [newStatus];
  if (newStatus === 'CONFIRMED') {
    sets.push('confirmed_at = ?');
    params.push(now);
  }
  if (newStatus === 'PAID') {
    sets.push('paid_at = ?');
    params.push(now);
    if (extra.paidBy) {
      sets.push('paid_by = ?');
      params.push(extra.paidBy);
    }
    if (extra.transferReference) {
      sets.push('transfer_reference = ?');
      params.push(extra.transferReference);
    }
  }
  params.push(id);
  db.prepare(`UPDATE settlements SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getSettlementById(id)!;
}

// ============================================================
// 【STEP C-2 Stage 5・2026-09-22社長承認】精算処理を呼び出す管理画面用API（新設）。
// 既存の getUnsettledStoreLineItems / getUnsettledDriverOrders / createSettlement /
// advanceSettlementStatus はこれまでテストコードからしか呼び出せなかった（本番未接続）。
// 二重登録・二重精算はcreateSettlement()が依拠するDB制約（idx_settlements_unique_period等）
// にそのまま任せ、ここでは制約違反の例外をユーザーフレンドリーなエラーに変換するのみ。
// ============================================================
function isDuplicateSettlementError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes('UNIQUE constraint failed');
}

app.post('/api/settlements/stores/:id', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const storeId = Number(req.params.id);
  const { periodStart, periodEnd } = req.body as { periodStart?: string; periodEnd?: string };
  if (!periodStart || !periodEnd) {
    return res.status(400).json({ ok: false, error: 'periodStart, periodEnd は必須です' });
  }
  const store = getStoreById(storeId);
  if (!store) return res.status(404).json({ ok: false, error: '加盟店が見つかりません' });

  const unsettled = getUnsettledStoreLineItems(storeId, periodStart, periodEnd);
  if (unsettled.length === 0) {
    return res.status(400).json({ ok: false, error: 'この期間・加盟店には精算対象の明細がありません' });
  }
  try {
    const settlement = createSettlement(
      'STORE',
      storeId,
      periodStart,
      periodEnd,
      unsettled.map(u => ({ orderId: u.orderId, orderLineItemId: u.orderLineItemId, amount: u.amount }))
    );
    res.status(201).json({ ok: true, settlement });
  } catch (e) {
    if (isDuplicateSettlementError(e)) {
      return res.status(409).json({ ok: false, error: 'この期間の加盟店精算は既に作成済みです（または対象明細の一部が既に別の精算に計上済みです）' });
    }
    console.error('[精算API] 加盟店精算の作成に失敗しました:', e instanceof Error ? e.message : String(e));
    res.status(500).json({ ok: false, error: '精算の作成に失敗しました' });
  }
});

app.post('/api/settlements/drivers/:id', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const driverId = Number(req.params.id);
  const { periodStart, periodEnd } = req.body as { periodStart?: string; periodEnd?: string };
  if (!periodStart || !periodEnd) {
    return res.status(400).json({ ok: false, error: 'periodStart, periodEnd は必須です' });
  }
  const driver = getDriverById(driverId);
  if (!driver) return res.status(404).json({ ok: false, error: 'ドライバーが見つかりません' });

  const unsettled = getUnsettledDriverOrders(driverId, periodStart, periodEnd);
  if (unsettled.length === 0) {
    return res.status(400).json({ ok: false, error: 'この期間・ドライバーには精算対象の注文がありません（配送完了・決済完了・遠方出動ボーナス確定済みの注文のみが対象です）' });
  }
  try {
    const settlement = createSettlement(
      'DRIVER',
      driverId,
      periodStart,
      periodEnd,
      unsettled.map(u => ({ orderId: u.orderId, orderLineItemId: null, amount: u.amount }))
    );
    res.status(201).json({ ok: true, settlement });
  } catch (e) {
    if (isDuplicateSettlementError(e)) {
      return res.status(409).json({ ok: false, error: 'この期間のドライバー精算は既に作成済みです（または対象注文の一部が既に別の精算に計上済みです）' });
    }
    console.error('[精算API] ドライバー精算の作成に失敗しました:', e instanceof Error ? e.message : String(e));
    res.status(500).json({ ok: false, error: '精算の作成に失敗しました' });
  }
});

app.post('/api/settlements/:id/advance', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const settlementId = Number(req.params.id);
  const { newStatus, paidBy, transferReference } = req.body as {
    newStatus?: string;
    paidBy?: string;
    transferReference?: string;
  };
  if (!newStatus || !SETTLEMENT_STATUS_ORDER.includes(newStatus as SettlementStatus)) {
    return res.status(400).json({ ok: false, error: `newStatusは次のいずれかである必要があります: ${SETTLEMENT_STATUS_ORDER.join(', ')}` });
  }
  try {
    const settlement = advanceSettlementStatus(settlementId, newStatus as SettlementStatus, { paidBy, transferReference });
    res.json({ ok: true, settlement });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[精算API] 精算ステータスの更新に失敗しました:', message);
    res.status(400).json({ ok: false, error: message });
  }
});

function updateOrderDispatch(id: number, storeId: number, driverId: number, status: OrderStatus) {
  db.prepare('UPDATE orders SET store_id = ?, driver_id = ?, status = ? WHERE id = ?').run(storeId, driverId, status, id);
}
// 【STEP C-2 Stage 3・2026-09-22社長承認】遠方出動ボーナスは配送手配（ドライバー確定）時に
// のみ計算できる（checkout時点ではドライバー未定のため算出不能）。算出できた場合のみ非null、
// 座標未確定・API失敗・21km超(Consultation)の場合はnullのまま保存する（推測値を作らない）。
// nullのままの注文は、精算基盤(getUnsettledDriverOrders)側の既存仕様により
// 自動的に精算対象外のままになる（架空の金額で精算されることはない）。
function updateOrderRemoteDispatchBonus(id: number, remoteDispatchBonus: number | null) {
  db.prepare('UPDATE orders SET remote_dispatch_bonus = ? WHERE id = ?').run(remoteDispatchBonus, id);
}
// Square Order IDから対象ORD注文を検索する（Phase A、Webhook payment.updatedでの照合に使用）
function getOrderBySquareOrderId(squareOrderId: string): Order | undefined {
  if (!squareOrderId) return undefined;
  const row = db.prepare('SELECT * FROM orders WHERE square_order_id = ?').get(squareOrderId) as OrderRow | undefined;
  return row ? rowToOrder(row) : undefined;
}
// Payment Link発行成功時にsquare_order_id/payment_link_idを保存する（Phase A）。
// payment_statusはここでは変更しない（Payment Link生成 ≠ 決済完了のため）。
function updateOrderPaymentLink(id: number, squareOrderId: string, paymentLinkId: string) {
  db.prepare('UPDATE orders SET square_order_id = ?, payment_link_id = ? WHERE id = ?').run(squareOrderId, paymentLinkId, id);
}
// Square Webhookのpayment.updatedでPayment.status確定時のみ呼び出す（Phase A）。
function updateOrderPaymentStatus(id: number, paymentStatus: PaymentStatus) {
  db.prepare('UPDATE orders SET payment_status = ? WHERE id = ?').run(paymentStatus, id);
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
  if (getStoreRowByUsername(username)) {
    return res.status(409).json({ ok: false, error: 'そのユーザー名は既に使用されています' });
  }
  // 加盟店手数料は0固定（クライアントからの指定は受け付けない。上のDEFAULT_COMMISSION_RATE参照）
  const store = insertStore(name, lineUserId, DEFAULT_COMMISSION_RATE, username, hashPassword(password), area || '恩納村');
  res.status(201).json({ ok: true, store });
});

app.get('/api/stores', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json(getAllStores());
});

// Phase B-3: 店舗詳細取得・active切り替え（マスタ管理用）。checkout側の解決ロジックは変更しない。
app.get('/api/stores/:id', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const store = getStoreById(id);
  if (!store) return res.status(404).json({ ok: false, error: '店舗が見つかりません' });
  res.json({ ok: true, store });
});

app.patch('/api/stores/:id/active', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { active } = req.body as { active?: unknown };
  if (typeof active !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'active は boolean(true/false) で指定してください' });
  }
  const store = updateStoreActive(id, active);
  if (!store) return res.status(404).json({ ok: false, error: '店舗が見つかりません' });
  res.json({ ok: true, store });
});

// Phase B-3: 宿泊施設マスタの一覧・詳細取得・active切り替え。Google Places/Geocoding/Routes接続、
// 実在施設データの投入、座標の推測入力は行わない（今回のスコープ外）。
app.get('/api/accommodations', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json(getAllAccommodations());
});

app.get('/api/accommodations/:id', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const accommodation = getAccommodationDetail(req.params.id);
  if (!accommodation) return res.status(404).json({ ok: false, error: '宿泊施設が見つかりません' });
  res.json({ ok: true, accommodation });
});

app.patch('/api/accommodations/:id/active', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const { active } = req.body as { active?: unknown };
  if (typeof active !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'active は boolean(true/false) で指定してください' });
  }
  const accommodation = updateAccommodationActive(req.params.id, active);
  if (!accommodation) return res.status(404).json({ ok: false, error: '宿泊施設が見つかりません' });
  res.json({ ok: true, accommodation });
});

// ============================================================
// 商品マスター基盤 STEP2：Draft作成 → 一覧/詳細 → Approve/Reject → 正式商品(version)一覧・履歴
// 【重要】いずれもcheckout・index.htmlからは一切参照されない、ADMIN専用の管理APIである。
// ============================================================
app.post('/api/product-drafts', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const storeId = Number(body.store_id);
  if (!Number.isInteger(storeId) || storeId <= 0) {
    return res.status(400).json({ ok: false, error: 'store_id は正の整数で指定してください' });
  }
  if (!getStoreById(storeId)) {
    return res.status(404).json({ ok: false, error: `store_id=${storeId} の加盟店が見つかりません` });
  }

  const sourceDocumentId =
    body.source_document_id === null || body.source_document_id === undefined || body.source_document_id === ''
      ? null
      : Number(body.source_document_id);
  if (sourceDocumentId !== null && (!Number.isInteger(sourceDocumentId) || sourceDocumentId <= 0)) {
    return res.status(400).json({ ok: false, error: 'source_document_id は正の整数またはnullで指定してください' });
  }
  // STEP3：source_document_idが指定された場合、実在するmenu_source_documentsであることを検証する
  // （推測でIDだけ受け入れず、存在しないIDは拒否する）。
  if (sourceDocumentId !== null && !getMenuSourceDocumentById(sourceDocumentId)) {
    return res.status(404).json({ ok: false, error: `source_document_id=${sourceDocumentId} の原本が見つかりません` });
  }

  const toStringOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const toNumberOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

  const extractedMerchantPrice = toNumberOrNull(body.extracted_merchant_price);
  const extractedContainerFee = toNumberOrNull(body.extracted_container_fee);
  const markupRate = toNumberOrNull(body.markup_rate);
  const confidence = toNumberOrNull(body.confidence);
  const extractedContainerCount = toNumberOrNull(body.extracted_container_count); // 商品マスター完成版
  const extractedCategory = toStringOrNull(body.extracted_category); // 商品マスター完成版

  // 【重要】body.computed_ord_price / body.calculation_basis は意図的に一切読み取らない。
  // クライアント送信の計算結果を信用せず、insertProductDraft()内でBackendが必ず再計算する。
  if (body.status !== undefined && body.status !== 'DRAFT' && body.status !== 'NEEDS_REVIEW') {
    return res.status(400).json({ ok: false, error: '新規作成時のstatusはDRAFTまたはNEEDS_REVIEWのみ指定できます' });
  }

  const draft = insertProductDraft({
    storeId,
    sourceDocumentId,
    extractedName: toStringOrNull(body.extracted_name),
    extractedNameEn: toStringOrNull(body.extracted_name_en),
    extractedDescription: toStringOrNull(body.extracted_description),
    extractedDescriptionEn: toStringOrNull(body.extracted_description_en),
    extractedMerchantPrice,
    extractedContainerFee,
    markupRate,
    confidence,
    needsReviewRequested: body.status === 'NEEDS_REVIEW' || body.needs_review === true,
    extractedContainerCount,
    extractedCategory,
  });
  res.status(201).json({ ok: true, draft });
});

app.get('/api/product-drafts', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json(getAllProductDrafts());
});

app.get('/api/product-drafts/:id', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const draft = getProductDraftById(Number(req.params.id));
  if (!draft) return res.status(404).json({ ok: false, error: 'Draftが見つかりません' });
  res.json({ ok: true, draft });
});

app.post('/api/product-drafts/:id/reject', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const draft = getProductDraftById(Number(req.params.id));
  if (!draft) return res.status(404).json({ ok: false, error: 'Draftが見つかりません' });
  if (draft.status === 'APPROVED' || draft.status === 'REJECTED') {
    return res.status(400).json({ ok: false, error: `このDraftは既に${draft.status}状態のためRejectできません` });
  }
  const { rejection_reason } = req.body as { rejection_reason?: unknown };
  const reason = typeof rejection_reason === 'string' && rejection_reason.trim() !== '' ? rejection_reason.trim() : null;
  const updated = markProductDraftRejected(draft.id, reason);
  res.json({ ok: true, draft: updated });
});

app.post('/api/product-drafts/:id/approve', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const draft = getProductDraftById(Number(req.params.id));
  if (!draft) return res.status(404).json({ ok: false, error: 'Draftが見つかりません' });
  if (draft.status === 'APPROVED' || draft.status === 'REJECTED') {
    return res.status(400).json({ ok: false, error: `このDraftは既に${draft.status}状態のためApproveできません` });
  }

  // STEP3：product_keyはUIの選択式リストから渡される「既存商品の更新」か、未指定の
  // 「新規商品登録」かのいずれか。自由入力のproduct_keyで新規登録することは許可しない
  // （ブラウザから送られた新規product_keyを信用しない。新規時はBackendが必ず自動採番する）。
  const { product_key } = req.body as { product_key?: unknown };
  const rawProductKey = typeof product_key === 'string' ? product_key.trim() : '';
  const isNewProduct = rawProductKey === '';

  if (!draft.extractedName) {
    return res.status(400).json({ ok: false, error: '商品名(extracted_name)が未確定のDraftは承認できません' });
  }

  // 【最重要】DraftのcomputedOrdPriceを無条件に信用せず、Backend側で
  // merchant_price/container_fee/markup_rateから必ず再計算する。再計算できない
  // （＝価格根拠が不十分な）Draftは承認を拒否する。
  const recalculatedOrdPrice = computeOrdPrice(draft.extractedMerchantPrice, draft.extractedContainerFee, draft.markupRate);
  if (recalculatedOrdPrice === null) {
    return res
      .status(400)
      .json({ ok: false, error: '加盟店価格・容器代・上乗せ率が未確定または不正なため、価格を検証できず承認できません' });
  }

  // 商品マスター完成版（社長承認：ハードブロック方式）：category/container_count/container_feeの
  // 組み合わせが基準と明らかに矛盾している場合は承認を拒否する。AIが判断した値を自動修正せず、
  // 人間が値を確認・修正して不整合が解消された状態で再度承認operationを行う必要がある。
  if (detectContainerRuleInconsistency(draft.extractedCategory, draft.extractedContainerCount, draft.extractedContainerFee)) {
    return res.status(400).json({
      ok: false,
      error: `category="${draft.extractedCategory}"の基準に対してcontainer_fee/container_countが一致しません。値を確認・修正してから承認してください。`,
    });
  }

  // square_catalog_item_id：bodyにキーが存在する場合のみ明示的な変更として扱う（undefinedなら
  // createProductVersion()側で旧Versionから自動継承する）。今回Square API通信・検証は行わない。
  const squareCatalogItemIdOverride: string | null | undefined =
    'square_catalog_item_id' in (req.body as Record<string, unknown>)
      ? typeof (req.body as Record<string, unknown>).square_catalog_item_id === 'string' &&
        (req.body as Record<string, unknown>).square_catalog_item_id !== ''
        ? ((req.body as Record<string, unknown>).square_catalog_item_id as string)
        : null
      : undefined;

  let productKey: string;
  if (isNewProduct) {
    // 新規商品登録：ブラウザ送信値は一切使わず、Backendが安全に次番号を採番する。
    productKey = generateNextProductKey();
  } else {
    // 既存商品の更新：UIの選択式リストに存在するはずのproduct_keyを受け取る。
    // 自由入力を想定しないため、実在しない/現行版がないproduct_keyは明確なエラーとして拒否する。
    const existingCurrent = getCurrentProductByKey(rawProductKey);
    if (!existingCurrent) {
      return res
        .status(400)
        .json({ ok: false, error: `product_key="${rawProductKey}" の現行商品が見つかりません（既存商品一覧から選択してください）` });
    }
    if (existingCurrent.store_id !== draft.storeId) {
      // product_keyは商品を跨いで使い回さない前提のため、店舗が食い違う場合は明確な入力ミスとして拒否する。
      return res.status(400).json({
        ok: false,
        error: `product_key="${rawProductKey}" は既に別の店舗(store_id=${existingCurrent.store_id})の商品として登録されています`,
      });
    }
    productKey = rawProductKey;
  }

  const product = createProductVersion({
    productKey,
    storeId: draft.storeId,
    name: draft.extractedName,
    nameEn: draft.extractedNameEn,
    description: draft.extractedDescription,
    descriptionEn: draft.extractedDescriptionEn,
    merchantPrice: draft.extractedMerchantPrice as number,
    containerFee: draft.extractedContainerFee as number,
    markupRate: draft.markupRate as number,
    ordPrice: recalculatedOrdPrice,
    sourceDraftId: draft.id,
    approvedBy: req.auth!.name,
    containerCount: draft.extractedContainerCount,
    category: draft.extractedCategory,
    squareCatalogItemId: squareCatalogItemIdOverride,
  });
  markProductDraftApproved(draft.id);

  res.status(201).json({ ok: true, product });
});

app.get('/api/products', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json(getCurrentProducts());
});

app.get('/api/products/:productKey/versions', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const versions = getProductVersionsByKey(req.params.productKey);
  res.json(versions);
});

// 【2026-09-23社長承認】五葷抜きトグル機能。価格に影響しない属性のため専用の軽量PATCHを用意する
// （storeのactive切替と同じ設計）。
app.patch('/api/products/:productKey/gokun-nuki', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const { available } = req.body as { available?: unknown };
  if (typeof available !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'available は boolean(true/false) で指定してください' });
  }
  const product = updateProductGokunNukiAvailable(req.params.productKey, available);
  if (!product) return res.status(404).json({ ok: false, error: '商品が見つかりません' });
  res.json({ ok: true, product });
});

// STEP3：Draftの元資料(menu_source_documents)を確認するための読み取り専用API。
// 作成・更新・削除APIは今回追加しない（原本アップロード機能は別STEP）。
app.get('/api/menu-source-documents/:id', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const document = getMenuSourceDocumentById(Number(req.params.id));
  if (!document) return res.status(404).json({ ok: false, error: '原本が見つかりません' });
  res.json({ ok: true, document });
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
function extractFromRawPayload(rawOrder: any): {
  items: OrderItem[];
  note: string;
  totalMoney: Money | null;
  area: string | null;
  displayNo: string | null;
} {
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
  // display_no も実際のSquare Webhookには存在しないフィールド。ORDフロント(index.html)が
  // お客様向けORD注文番号（order.no）を連携送信時に付与する。square_order_idとは明確に別物。
  const displayNo: string | null = typeof rawOrder.display_no === 'string' ? rawOrder.display_no : null;
  return { items, note, totalMoney, area, displayNo };
}

// 座標の数値・範囲チェックのみを行う純粋関数（Phase B）。googleMapsClient.tsとは独立させ、
// 依存を持たない。外部API通信は一切発生しない。
function isValidCoordinate(latitude: unknown, longitude: unknown): boolean {
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) return false;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) return false;
  if (latitude < -90 || latitude > 90) return false;
  if (longitude < -180 || longitude > 180) return false;
  return true;
}

// ============================================================
// 注文金額のBackend側検証・再計算（STEP2-C-5、金額改ざん対策）
// 【重要】ブラウザ(index.html)から送られてくるunit price・subtotal・delivery fee・
// container fee・totalは一切信用しない。ここで計算したBackend正規値のみを正式な
// 注文金額として扱う。
//
// 【現状の制約】index.html は現時点で product_id / store_id を送信していない
// （line_itemsにはname/quantityのみ）。そのため、現在実際に流れているデータでは
// 商品名(name)によるマッチングのみが機能する。product_id/store_idによる厳密な
// ID照合・店舗整合性チェックはロジックとして実装済みだが、index.html側の送信内容が
// 拡張されるまでは実際には使われない（今回はindex.htmlを変更しない範囲のため）。
// ============================================================
interface ValidatedLineItem {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  matchedBy: 'id' | 'name';
  storeId: string; // priceCatalog.ts上のcatalog_store_id（例:'s1'）。Phase Bの加盟店解決に使用
  // 【STEP C-2】商品マスター(products)から解決できた場合のみ非null。order_line_itemsへの
  // Version価格スナップショット保存に使う。priceCatalog.tsフォールバックで解決した場合はすべてnull
  // （架空の対応関係を作らない）。
  productKey: string | null;
  productVersion: number | null;
  merchantPrice: number | null;
  containerFee: number | null;
  markupRate: number | null;
  gokunNukiRequested: boolean; // 【2026-09-23社長承認】五葷抜き選択。商品がgokun_nuki_available=falseの場合は常にfalseに強制する
}
interface OrderValidationResult {
  ok: boolean;
  error?: string;
  items?: ValidatedLineItem[];
  subtotal?: number;
  deliveryFee?: number;
  containerFee?: number;
  recalculatedTotal?: number;
  amountMismatch?: boolean; // クライアント送信totalとBackend再計算値が異なっていたか（参考情報）
  usedIdMatching?: boolean; // product_id/store_idによる厳密照合が使えたか
}

// SquareのOrderLineItem.quantityは文字列型のため、安全に整数へ変換する。
// NaN・Infinity・小数・0以下は不正として扱う（現状のORDに数量上限は存在しないため上限は設けない）。
function sanitizeQuantity(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null; // NaN, Infinity, -Infinity
  if (!Number.isInteger(n)) return null; // 小数
  if (n < 1) return null; // 0以下
  return n;
}

function validateAndRecalculateOrder(rawOrder: any): OrderValidationResult {
  const storeId: string | null = typeof rawOrder.store_id === 'string' ? rawOrder.store_id : null;
  const rawLineItems: any[] = Array.isArray(rawOrder.line_items) ? rawOrder.line_items : [];

  if (rawLineItems.length === 0) {
    return { ok: false, error: '商品明細(line_items)が空です' };
  }

  // 【STEP C-2・2026-09-22社長承認】商品マスター(products)優先、未掲載/未接続の店舗のみ
  // 旧priceCatalog.tsにフォールバックする。storeIdが商品マスター側のcatalog_store_idと
  // 一致する加盟店が見つかった場合にのみ商品マスターを参照する（見つからなければ完全に
  // 旧経路のまま、フォールバック側の挙動は一切変更しない）。
  const masterStore = storeId ? getStoreByCatalogId(storeId) : undefined;

  const items: ValidatedLineItem[] = [];
  let usedIdMatching = false;

  for (const li of rawLineItems) {
    const quantity = sanitizeQuantity(li?.quantity);
    if (quantity === null) {
      return { ok: false, error: `数量が不正です（${JSON.stringify(li?.quantity)}）` };
    }

    const productId = typeof li?.product_id === 'string' ? li.product_id : null;
    const rawName = typeof li?.name === 'string' ? li.name : '';
    // 【2026-09-23社長承認】五葷抜きトグル。お客様が選択した場合のみtrue送信される想定
    // （未送信・false送信はすべて「選択なし」として扱う）。
    const gokunNukiRequested = li?.gokun_nuki === true;

    // ---- ① 商品マスター(products)側の解決を先に試みる ----
    if (masterStore) {
      // product_idが商品マスターのproduct_key形式（例:'P001'）で送信されていれば、まずそれで照合する。
      const masterProduct: ProductRow | undefined =
        (productId ? getCurrentProductByKey(productId) : undefined) ?? getCurrentProductByStoreAndName(masterStore.id, rawName);

      if (masterProduct) {
        if (masterProduct.store_id !== masterStore.id) {
          // 別店舗の商品を、指定店舗の注文として送信するケース（改ざん）。フォールバックせず即拒否。
          return { ok: false, error: `商品「${masterProduct.name}」は指定された店舗「${storeId}」には属していません` };
        }
        if (gokunNukiRequested && !masterProduct.gokun_nuki_available) {
          // 五葷抜きに対応していない商品への選択は改ざん・不正入力として即座に拒否する（推測で許可しない）。
          return { ok: false, error: `商品「${masterProduct.name}」は五葷抜きに対応していません` };
        }
        items.push({
          name: masterProduct.name,
          quantity,
          unitPrice: masterProduct.ord_price,
          lineTotal: masterProduct.ord_price * quantity,
          matchedBy: productId && getCurrentProductByKey(productId) ? 'id' : 'name',
          storeId: storeId!,
          productKey: masterProduct.product_key,
          productVersion: masterProduct.version,
          merchantPrice: masterProduct.merchant_price,
          containerFee: masterProduct.container_fee,
          markupRate: masterProduct.markup_rate,
          gokunNukiRequested,
        });
        usedIdMatching = usedIdMatching || items[items.length - 1].matchedBy === 'id';
        continue; // ①で解決できたので②(旧priceCatalog経路)には進まない
      }
      // masterStoreは存在するが該当商品が商品マスターに見つからない場合は、
      // 意図的に②へフォールバックする（商品マスター移行途中の商品を売れなくしないため）。
    }

    if (gokunNukiRequested) {
      // 商品マスター未接続（旧priceCatalog経路）では対応可否を検証できないため、常に拒否する。
      return { ok: false, error: `商品「${rawName}」は五葷抜きに対応していません` };
    }

    // ---- ② 旧priceCatalog.tsへのフォールバック（既存ロジック、無変更） ----
    let matched = productId ? findProductById(productId) : undefined;
    let matchedBy: 'id' | 'name' = 'id';

    if (productId && !matched && !masterStore) {
      // product_idが送信されているのに正規カタログに存在しない場合は、
      // 商品名によるフォールバック照合を試みず即座に拒否する。
      // （フォールバックを許すと「偽のproduct_id＋本物の商品名」の組み合わせで
      //   改ざん検知をすり抜けられてしまうため）
      // 【STEP C-2】masterStoreが存在する場合はここで拒否せず、商品マスター側で
      // 見つからなかっただけの可能性があるため、下の商品名照合に進む。
      return { ok: false, error: `商品「${li?.name}」（product_id: ${productId}）は正規の商品リストに存在しません` };
    }

    if (matched && storeId && matched.storeId !== storeId) {
      // 別店舗の商品IDを別店舗の注文として送信するケース（改ざん）
      return { ok: false, error: `商品「${matched.name}」は店舗「${matched.storeId}」の商品であり、指定された店舗「${storeId}」には属していません` };
    }

    if (!matched) {
      // ここに到達するのは product_id 自体が送信されていない場合のみ
      // （現状のindex.htmlの実際の送信形式。将来product_idが送られるようになれば通らない経路）
      const name = rawName;
      const candidates = findProductsByName(name);
      const filtered = storeId ? candidates.filter(c => c.storeId === storeId) : candidates;
      if (filtered.length === 1) {
        matched = filtered[0];
        matchedBy = 'name';
      } else if (filtered.length > 1) {
        // 店舗指定がなく、同名商品が複数店舗にまたがって存在するため一意に特定できない
        return { ok: false, error: `商品「${name}」が複数店舗に存在し、店舗を特定できません（store_idが必要です）` };
      }
    } else {
      usedIdMatching = true;
    }

    if (!matched) {
      return { ok: false, error: `商品「${li?.name}」（product_id: ${productId ?? '未指定'}）は正規の商品リストに存在しません` };
    }

    items.push({
      name: matched.name,
      quantity,
      unitPrice: matched.price,
      lineTotal: matched.price * quantity,
      matchedBy,
      storeId: matched.storeId,
      productKey: null,
      productVersion: null,
      merchantPrice: null,
      containerFee: null,
      markupRate: null,
      gokunNukiRequested: false,
    });
  }

  const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
  // 【STEP C-2・2026-09-22社長承認】容器代は商品マスター側でord_priceに織り込み済みのため、
  // ここで別途加算しない（旧priceCatalog.tsフォールバック時のCONTAINER_FEEは常に0であり、
  // このコメント追加は挙動変更を伴わない）。配送料のみ、店舗→顧客の実測時間に基づく
  // 正式な配送手数料ルール(STEP C-2b、後続のcheckoutハンドラ側)で決定するため、
  // ここでは旧来の固定値DELIVERY_FEEを引き続き暫定値として返す（呼び出し側が上書きする）。
  const deliveryFee = DELIVERY_FEE;
  const containerFee = CONTAINER_FEE;
  const recalculatedTotal = subtotal + deliveryFee + containerFee;

  const clientTotal =
    rawOrder.total_money && typeof rawOrder.total_money.amount === 'number' ? rawOrder.total_money.amount : null;
  const amountMismatch = clientTotal !== null && clientTotal !== recalculatedTotal;

  return { ok: true, items, subtotal, deliveryFee, containerFee, recalculatedTotal, amountMismatch, usedIdMatching };
}

// ============================================================
// Square Webhook 受信（Phase A、正式仕様）
// 【重要】これは「Squareが決済結果をORDへ通知する」専用のエンドポイント。
// 顧客からの注文受付は POST /api/orders/checkout が専任し、このエンドポイントでは
// 新規注文の作成(insertOrder)を一切行わない（役割の完全分離、Phase Aで確定）。
// Square Webhookのpayload envelope型はSquare SDKに型定義が存在しないため、
// 今回必要な最小限のフィールドのみを手動定義する（推測でフィールド名を作らない。
// Square wire formatはsnake_caseであり、既存のextractFromRawPayload()等が
// rawOrder.customer_line_id / rawOrder.total_money のようにsnake_caseで
// 扱っている既存コード規約とも一致する）。
// ============================================================
interface SquareWebhookPaymentPayload {
  event_id?: string;
  type?: string;
  data?: {
    object?: {
      payment?: {
        id?: string;
        order_id?: string;
        reference_id?: string;
        status?: string;
      };
    };
  };
}

app.post('/webhooks/square', (req: Request, res: Response) => {
  // 1. 署名検証（raw bodyを使用。express.json({verify:captureRawBody})が既にreq.rawBodyへ
  //    生バイト列を保持済み、STEP2-C-6基盤をそのまま利用）。
  const signatureHeader = req.header('x-square-hmacsha256-signature');
  const validSignature = isValidSquareWebhookSignature({
    rawBody: req.rawBody,
    signatureHeader,
    signatureKey: SQUARE_WEBHOOK_SIGNATURE_KEY,
    notificationUrl: SQUARE_WEBHOOK_NOTIFICATION_URL,
  });
  if (!validSignature) {
    // 署名鍵/通知URL未設定の場合もisValidSquareWebhookSignature()は必ずfalseを返すため、
    // ここで安全側（拒否）に倒れる。秘密情報はログへ一切出力しない。
    console.error('[Square Webhook] 署名検証に失敗したため処理を拒否しました');
    return res.status(401).json({ ok: false, error: '署名が無効です' });
  }

  const payload = req.body as SquareWebhookPaymentPayload;
  const eventId = payload.event_id;
  if (!eventId) {
    return res.status(400).json({ ok: false, error: 'event_idが見つかりません' });
  }

  // 2. イベント種別の確認。Phase Aで扱うのはpayment.updatedのみ。
  if (payload.type !== 'payment.updated') {
    console.log(`[Square Webhook] 未対応のイベント種別のため業務処理は行いません: ${payload.type}`);
    return res.status(200).json({ ok: true, skipped: true });
  }

  const payment = payload.data?.object?.payment;
  const squareOrderId = payment?.order_id;
  const referenceId = payment?.reference_id;
  const paymentStatus = payment?.status;

  try {
    // 3. event_id重複防止 + payment_status更新を単一トランザクションで実行
    //    （イベント記録だけ残り業務処理が反映されない、という不整合を防ぐ）。
    const result = runInTransaction(() => {
      const isNewEvent = tryMarkWebhookEventProcessed(eventId);
      if (!isNewEvent) {
        return { outcome: 'duplicate' as const };
      }

      // 優先順位1: Payment.order_id → orders.square_order_id
      let order = squareOrderId ? getOrderBySquareOrderId(squareOrderId) : undefined;
      // 優先順位2（フォールバック）: Payment.reference_id → orders.id
      // referenceIdはcheckout時にString(orders.id)として自分たちが設定した値のため、
      // square_order_idでの照合が失敗した場合の補助手段として使う。
      if (!order && referenceId) {
        const numericId = Number(referenceId);
        if (Number.isInteger(numericId)) order = getOrderById(numericId);
      }

      if (!order) {
        // 対象ORD注文が見つからない場合、新規注文を作成することは絶対にしない。
        return { outcome: 'not_found' as const };
      }

      if (paymentStatus === 'COMPLETED') {
        updateOrderPaymentStatus(order.id, 'COMPLETED');
      } else if (paymentStatus === 'CANCELED' || paymentStatus === 'FAILED') {
        updateOrderPaymentStatus(order.id, 'FAILED');
      }
      // APPROVED/PENDING等はまだ確定していない状態のため、既存のpayment_statusを変更しない
      // （Square Payment.status===COMPLETEDの場合のみpayment_status=COMPLETEDにする、というPhase Aの原則）。

      return { outcome: 'matched' as const, orderId: order.id };
    });

    if (result.outcome === 'duplicate') {
      console.log(`[Square Webhook] event_id=${eventId} は処理済みのため無視します（重複）`);
      return res.status(200).json({ ok: true, duplicate: true });
    }
    if (result.outcome === 'not_found') {
      console.warn(`[Square Webhook] 対応するORD注文が見つかりません（square_order_id=${squareOrderId ?? '(なし)'}, reference_id=${referenceId ?? '(なし)'}）`);
      return res.status(200).json({ ok: true, matched: false });
    }

    console.log(`[Square Webhook] 注文#${result.orderId} のPayment.statusを確認しました（${paymentStatus}）`);
    res.status(200).json({ ok: true, orderId: result.orderId });
  } catch (e) {
    console.error('[Square Webhook] 処理中にエラーが発生しました:', e instanceof Error ? e.message : String(e));
    res.status(500).json({ ok: false, error: 'Webhook処理中にエラーが発生しました' });
  }
});

// ============================================================
// お客様向け通常注文受付API（STEP2-C-7B）
// 【重要】これは「お客様→ORD」の注文受付専用エンドポイントであり、
// 「Square→ORD」の決済結果通知専用である POST /webhooks/square とは完全に別物。
// 今回はSquare通信を一切行わない。square_order_id / payment_link_id は
// 常に空文字のまま、payment_status は常に PENDING で登録する
// （Square CreatePaymentLinkの実装はSTEP2-C-7Cで行う）。
//
// リクエストボディの形式は、既存の syncOrderToBackend()（index.html、今回未変更）が
// /webhooks/square へ送っているものと同一のフラットな構造をそのまま受け取れるようにした
// （display_no, note, line_items, customer_line_id, total_money, area, store_id）。
// これにより、将来 index.html の送信先をこのAPIへ切り替える際の互換性を保っている
// （ただし今回 index.html 自体は一切変更していない）。
// ============================================================

// 二重送信の簡易対策：新しいDBテーブルは作らず、インメモリのMapのみで
// 「直近数秒以内に送られた、内容が完全に一致するリクエスト」を検出して拒否する。
// 【重要な限界】サーバー再起動でリセットされる／複数プロセス構成では効かない／
// 時間窓を超えて意図的に再送された場合は防げない、という制約がある簡易対策であり、
// Square CreatePaymentLinkのidempotencyKeyのような正式な冪等性保証ではない
// （STEP2-C-7Cでidempotency keyが導入されるまでの暫定的な軽減策）。
const recentCheckoutRequests = new Map<string, number>();
const CHECKOUT_DUPLICATE_WINDOW_MS = 5000;
function pruneOldCheckoutRequests(now: number) {
  for (const [key, ts] of recentCheckoutRequests) {
    if (now - ts > CHECKOUT_DUPLICATE_WINDOW_MS) recentCheckoutRequests.delete(key);
  }
}
function checkoutRequestKey(rawOrder: any, recalculatedTotal: number): string {
  return JSON.stringify({
    displayNo: typeof rawOrder.display_no === 'string' ? rawOrder.display_no : null,
    storeId: typeof rawOrder.store_id === 'string' ? rawOrder.store_id : null,
    items: (Array.isArray(rawOrder.line_items) ? rawOrder.line_items : []).map((li: any) => ({
      productId: li?.product_id ?? null,
      name: li?.name ?? null,
      quantity: li?.quantity ?? null,
    })),
    total: recalculatedTotal,
  });
}

// ============================================================
// Square Payment Link生成（Phase A）
// 【重要】client.checkoutApi.createPaymentLink() を使用する（client.paymentLinksApiは
// このSDKバージョンには存在しない、Phase 0で実物のSDK型定義を確認済み）。
// line itemsはBackend再計算済みの値のみを使用し、クライアント送信価格は一切使わない。
// 【重複発行について】checkoutは常に新規注文(insertOrder)を1件作成するだけであり、
// 既存注文に対して再度Payment Linkを発行するエンドポイントはPhase Aには存在しないため、
// 「既存payment_link_idの再利用」が必要になる状況はこの関数の呼び出し経路上発生しない。
// 将来「決済リンク再送信」機能を追加する場合は、同一idempotencyKeyであれば
// Square側が同一リンクを返す仕様（Square公式の冪等性保証）を利用すればよい。
// ============================================================
interface CreateOrderPaymentLinkResult {
  ok: boolean;
  paymentLinkId?: string;
  squareOrderId?: string;
  paymentLinkUrl?: string;
  error?: string;
}

async function createSquarePaymentLinkForOrder(
  orderId: number,
  paymentAttemptNo: number,
  items: ValidatedLineItem[],
  deliveryFee: number
): Promise<CreateOrderPaymentLinkResult> {
  const configCheck = validateSquareConfigForPayments();
  if (!configCheck.ok || !squareClient) {
    return { ok: false, error: `Square決済設定が不足しています: ${configCheck.errors.join(', ')}` };
  }

  const idempotencyKey = `${orderId}-${paymentAttemptNo}`;

  try {
    // 【STEP C-2 Stage 4・2026-09-22社長承認】配送料を独立したline itemとしてSquareの
    // 決済金額に反映する（従来は商品明細のみで、内部記録の合計と実請求額が乖離していた）。
    // 容器代は商品マスターのord_priceに既に織り込み済みのため、ここには追加しない。
    const lineItems = items.map(i => ({
      name: i.name,
      quantity: String(i.quantity), // Square SDK上quantityは必須のstring型
      basePriceMoney: { amount: BigInt(i.unitPrice), currency: 'JPY' }, // Money.amountはbigint型
    }));
    if (deliveryFee > 0) {
      lineItems.push({
        name: '配送料',
        quantity: '1',
        basePriceMoney: { amount: BigInt(deliveryFee), currency: 'JPY' },
      });
    }
    const { result } = await squareClient.checkoutApi.createPaymentLink({
      idempotencyKey,
      order: {
        locationId: SQUARE_LOCATION_ID,
        referenceId: String(orderId),
        lineItems,
      },
      // ORD_CHECKOUT_REDIRECT_URL未設定の場合はcheckoutOptions自体を省略する
      // （Squareの既定の決済完了ページが表示される。URLを推測してハードコードしない）。
      ...(ORD_CHECKOUT_REDIRECT_URL ? { checkoutOptions: { redirectUrl: ORD_CHECKOUT_REDIRECT_URL } } : {}),
    });

    const paymentLink = result.paymentLink;
    if (!paymentLink?.id || !paymentLink.orderId || !paymentLink.url) {
      return { ok: false, error: 'Square Payment Linkの応答形式が不正です' };
    }
    return { ok: true, paymentLinkId: paymentLink.id, squareOrderId: paymentLink.orderId, paymentLinkUrl: paymentLink.url };
  } catch (e) {
    // Square Access Token等の秘密情報がエラーオブジェクトに含まれる可能性があるため、
    // ログにはエラーメッセージのみを出力し、例外オブジェクト全体は出力しない。
    console.error('[Square CreatePaymentLink] 呼び出しに失敗しました:', e instanceof Error ? e.message : String(e));
    return { ok: false, error: 'Square Payment Linkの生成に失敗しました' };
  }
}

// 【2026-09-21・テスト専用注入口】ORD_TEST_HOOKS='true' の場合のみ有効。
// 未設定時（本番・通常のbackend-uitest起動）はこのオブジェクトが参照されることすらなく、
// 既存の実装（createSquarePaymentLinkForOrder / updateOrderPaymentLink）がそのまま呼ばれる
// （動作は一切変わらない）。Square APIへは実接続しない方針のため、checkoutの実HTTP経路上で
// 「Payment Link発行成功→直後のDB更新失敗」を模擬・再現するために使う（社長承認・2026-09-21）。
type CheckoutTestHooks = {
  createSquarePaymentLinkForOrder?: typeof createSquarePaymentLinkForOrder;
  updateOrderPaymentLink?: typeof updateOrderPaymentLink;
};
const __checkoutTestHooks: CheckoutTestHooks = {};
export function __setCheckoutTestHooks(hooks: CheckoutTestHooks | null): void {
  if (process.env.ORD_TEST_HOOKS !== 'true') {
    throw new Error('ORD_TEST_HOOKS=trueの場合のみ使用可能なテスト専用関数です（本番では呼び出し不可）');
  }
  if (hooks === null) {
    delete __checkoutTestHooks.createSquarePaymentLinkForOrder;
    delete __checkoutTestHooks.updateOrderPaymentLink;
  } else {
    Object.assign(__checkoutTestHooks, hooks);
  }
}

app.post('/api/orders/checkout', async (req: Request, res: Response) => {
  const rawOrder = req.body;
  if (!rawOrder || typeof rawOrder !== 'object' || Array.isArray(rawOrder)) {
    return res.status(400).json({ ok: false, error: '不正なリクエストボディです' });
  }

  // 金額・商品・数量・店舗整合性の検証と再計算（STEP2-C-5で作成済みのロジックをそのまま再利用。
  // 重複実装はしていない）。ブラウザ送信のtotal_moneyはここでは正式金額として使用しない。
  let validation;
  try {
    validation = validateAndRecalculateOrder(rawOrder);
  } catch (e) {
    console.error('[注文受付API] 金額検証中に予期しないエラー:', e);
    return res.status(500).json({ ok: false, error: '注文内容の検証中にエラーが発生しました' });
  }
  if (!validation.ok) {
    return res.status(400).json({ ok: false, error: validation.error });
  }

  // 配送先情報の抽出は既存のextractFromRawPayload()/parseDeliveryInfo()をそのまま再利用する
  const fallback = extractFromRawPayload(rawOrder);
  const delivery = parseDeliveryInfo(fallback.note);
  if (delivery.villaName === '(未入力)' || delivery.roomNumber === '(未入力)') {
    return res.status(400).json({ ok: false, error: '配送先情報（ヴィラ名・部屋番号）が指定されていません' });
  }

  // ============================================================
  // 【Phase B】商品 → 加盟店解決
  // 【重要】クライアント送信のstore_idは一切信用しない。validation.items（商品マスターから
  // Backendが解決したcatalog_store_id）だけを根拠にする。
  // ============================================================
  const catalogStoreIds = Array.from(new Set(validation.items!.map(i => i.storeId)));
  if (catalogStoreIds.length > 1) {
    // 【1注文＝1加盟店】既存のindex.html(addToCart)の制約をBackend側でも保証する。
    // 推測での分割・特定の店舗への統合は行わず、注文そのものを拒否する。
    return res
      .status(400)
      .json({ ok: false, error: '複数の加盟店の商品が同一注文に含まれています（1注文につき1加盟店のみ対応しています）' });
  }
  const catalogStoreId = catalogStoreIds[0];
  const storeResolution = getStoreByCatalogId(catalogStoreId);
  if (!storeResolution) {
    // stores側にこのcatalog_store_idがまだ登録されていない。推測でstores.idを生成しない。
    // 顧客都合の入力ミスではなくORD側のマスタ未整備が原因のため503（サービス一時停止）とする。
    console.error(`[注文受付API] catalog_store_id="${catalogStoreId}"に対応する加盟店がstoresに登録されていません`);
    return res.status(503).json({ ok: false, error: '現在この店舗のお取り扱いを一時的に休止しています' });
  }
  if (!storeResolution.active) {
    return res.status(503).json({ ok: false, error: '現在この店舗は新規注文を受け付けていません' });
  }
  // storeResolution.latitude/longitudeは今回未使用（Google Routes接続は次Phase）。
  // 「取得できる構造になっていること」のみ確認済みで、料金計算には一切使用しない。

  // ============================================================
  // 【Phase B】宿泊施設(accommodation_id)の検証
  // accommodation_idは必須。未送信・空文字・空白のみはすべて400で拒否する。
  // 座標(latitude/longitude)がNULL・非数値・NaN・範囲外のいずれかであれば、
  // 推測・補正せず503（ORD側マスタ未整備）で拒否する。
  // ============================================================
  const rawAccommodationId = typeof rawOrder.accommodation_id === 'string' ? rawOrder.accommodation_id.trim() : '';
  if (!rawAccommodationId) {
    return res.status(400).json({ ok: false, error: '宿泊施設(accommodation_id)が指定されていません' });
  }
  const accommodation = getAccommodationById(rawAccommodationId);
  if (!accommodation) {
    return res.status(400).json({ ok: false, error: `指定された宿泊施設(accommodation_id: ${rawAccommodationId})が見つかりません` });
  }
  if (!accommodation.active) {
    return res.status(400).json({ ok: false, error: '指定された宿泊施設は現在選択できません' });
  }
  if (!isValidCoordinate(accommodation.latitude, accommodation.longitude)) {
    console.error(`[注文受付API] accommodation_id="${accommodation.id}"の座標が未登録または不正です`);
    return res.status(503).json({ ok: false, error: '現在この宿泊施設への配送は一時的にご利用いただけません' });
  }
  const accommodationId = accommodation.id;
  const accommodationLatitude = accommodation.latitude as number;
  const accommodationLongitude = accommodation.longitude as number;
  const buildingVillaNumber = typeof rawOrder.building_villa_number === 'string' ? rawOrder.building_villa_number : null;

  // ============================================================
  // 【Phase B-2A】注文配送情報（ゲスト名・電話番号・配送場所は必須、配送指示は任意）
  // 【重要】noteやparseDeliveryInfo()とは完全に独立したトップレベルフィールドとして扱う。
  // 既存のnote送信・villa_name/room_number抽出には一切影響しない。
  // ============================================================
  const guestNameRaw = typeof rawOrder.guest_name === 'string' ? rawOrder.guest_name.trim() : '';
  if (!guestNameRaw) {
    return res.status(400).json({ ok: false, error: 'ゲスト名(guest_name)が指定されていません' });
  }
  const phoneNumberRaw = typeof rawOrder.phone_number === 'string' ? rawOrder.phone_number.trim() : '';
  if (!phoneNumberRaw) {
    // 外国人旅行者の利用を想定し、国番号を含む形式等への厳格なフォーマット検証は行わない。
    // 文字列であり、trim後に空でないことのみ確認する。
    return res.status(400).json({ ok: false, error: '電話番号(phone_number)が指定されていません' });
  }
  const deliveryLocationRaw = typeof rawOrder.delivery_location === 'string' ? rawOrder.delivery_location.trim() : '';
  if (!deliveryLocationRaw) {
    // DB側にCHECK制約は設けず、DELIVERY_LOCATIONSへの厳密な一致もここでは強制しない
    // （UI実装（Phase B-2）で候補値を確定してから、必要なら値の妥当性検証を追加する）。
    return res.status(400).json({ ok: false, error: '配送場所(delivery_location)が指定されていません' });
  }
  const deliveryInstructionsRaw = typeof rawOrder.delivery_instructions === 'string' ? rawOrder.delivery_instructions.trim() : '';
  const guestName = guestNameRaw;
  const phoneNumber = phoneNumberRaw;
  const deliveryLocation = deliveryLocationRaw;
  const deliveryInstructions = deliveryInstructionsRaw || null; // 任意項目。空ならNULL

  // 【STEP C-2・2026-09-22社長承認】配送料は店舗→顧客の実測時間が確定するまで
  // 正式な金額を出せない（旧DELIVERY_FEE固定値はこの時点では暫定値）ため、
  // Google Routes実測後にtiered計算へ差し替える。ここでは仮値として保持する。
  let recalculatedTotal = validation.recalculatedTotal!;

  // ============================================================
  // 【2026-09-20・社長承認】正式ドライバー報酬ルールのcheckout接続
  // 判定基準は店舗→配送先のGoogle Routes車移動時間のみ（ドライバー拠点→店舗の時間は
  // 含めない、remote_dispatch_bonusとは別軸）。resolveRestaurantToCustomerPricing()は
  // 顧客向け配送料金のみを返す設計のため、ドライバー報酬は同じ実測時間を使い
  // calculateDriverReward()を別途明示的に呼び出す（新規の推測ロジックは作らない）。
  // 失敗時・60分超時は推測値を作らず、注文自体を作成しない。二重送信記録は
  // このGoogle Routes判定が成功した場合にのみ行う（失敗時は即時再試行を許可する）。
  // ============================================================
  const restaurantLocation: LatLng | null =
    storeResolution.latitude !== null && storeResolution.longitude !== null
      ? { latitude: storeResolution.latitude, longitude: storeResolution.longitude }
      : null;
  const customerLocation: LatLng = { latitude: accommodationLatitude, longitude: accommodationLongitude };
  const routePricing = await resolveRestaurantToCustomerPricing(db, restaurantLocation, customerLocation, new Date());
  if (routePricing.mapsStatus !== 'SUCCESS' || routePricing.restaurantToCustomerDurationMinutes === null) {
    console.error(
      `[注文受付API] Google Routes実測に失敗したため注文を作成しません（status: ${routePricing.mapsStatus}）。推測値は使用しません。`
    );
    return res
      .status(503)
      .json({ ok: false, error: '現在この配送先への配送条件を確定できないため、ご注文を受け付けられません。しばらくしてから再度お試しください。' });
  }
  const deliveryTimeMinutes = routePricing.restaurantToCustomerDurationMinutes;
  const driverRewardTier = calculateDriverReward(db, deliveryTimeMinutes);
  if (driverRewardTier.isConsultation) {
    // 60分超：自動確定できないため注文を作成しない。0円・仮の金額は保存しない。
    return res.status(503).json({
      ok: false,
      error: '配送先までの移動時間が長いため、自動でのご注文受付ができません（要相談）。ORD運営までお問い合わせください。',
    });
  }
  const driverReward = driverRewardTier.amount;

  // ============================================================
  // 【STEP C-2・2026-09-22社長承認】配送料・最低注文額のcheckout時リアルタイム反映
  // 判定基準はドライバー報酬と同じ実測deliveryTimeMinutes（店舗→顧客）。
  // 推測値は使わず、Consultation区分・未達なら注文自体を作成しない。
  // ============================================================
  const deliveryFeeTier = calculateDeliveryFee(db, deliveryTimeMinutes);
  if (deliveryFeeTier.isConsultation || deliveryFeeTier.amount === null) {
    return res.status(503).json({
      ok: false,
      error: '配送先までの移動時間が長いため、配送料を自動確定できません（要相談）。ORD運営までお問い合わせください。',
    });
  }
  const deliveryFee = deliveryFeeTier.amount;

  const minimumOrderTier = calculateMinimumOrder(db, deliveryTimeMinutes);
  const minimumOrderCheck = checkMinimumOrder({
    minimumOrderAmount: minimumOrderTier.amount,
    customerFoodSubtotal: validation.subtotal!,
  });
  if (!minimumOrderCheck.minimumOrderMet) {
    if (minimumOrderTier.isConsultation || minimumOrderTier.amount === null) {
      return res.status(503).json({
        ok: false,
        error: '配送先までの移動時間が長いため、最低注文金額を自動確定できません（要相談）。ORD運営までお問い合わせください。',
      });
    }
    return res.status(400).json({
      ok: false,
      error: `最低注文金額（¥${minimumOrderTier.amount.toLocaleString('ja-JP')}）に達していません（不足額: ¥${minimumOrderCheck.minimumOrderShortfall!.toLocaleString('ja-JP')}）`,
    });
  }

  // 旧priceCatalog.ts固定値だったdeliveryFeeを、上で確定したtiered配送料に差し替えて
  // 正式金額を再計算する（容器代は商品マスターのord_priceに既に織り込み済みのため
  // containerFeeはvalidation側の値=0のまま変更しない）。
  recalculatedTotal = validation.subtotal! + deliveryFee + validation.containerFee!;

  // 二重送信の簡易チェック（上記コメント参照）。Google Routes判定成功後にのみ記録する。
  const now = Date.now();
  pruneOldCheckoutRequests(now);
  const dupKey = checkoutRequestKey(rawOrder, recalculatedTotal);
  if (recentCheckoutRequests.has(dupKey)) {
    return res.status(409).json({ ok: false, error: '同一内容の注文が直前に送信されています。しばらく待ってから再度お試しください。' });
  }
  recentCheckoutRequests.set(dupKey, now);

  let createdOrderId: number | null = null;
  try {
    // 【STEP C-2・2026-09-22社長承認】注文本体(orders)と、商品マスターVersion価格の
    // スナップショット(order_line_items)を、同一トランザクションで登録する。
    // 片方だけ登録されて片方が失敗する状態（注文はあるのに明細スナップショットが無い等）を
    // DBレベルで防ぐため。既存のinsertOrder()/insertOrderLineItem()自体は無変更、
    // ここでの呼び出し方だけを変更する。
    // 【STEP・2026-09-23社長承認】ORD推定利益（商品マスター接続済みの明細のみで算出可能）。
    // 1件でも旧priceCatalog.tsフォールバック明細(merchantPrice=null)が混ざる注文は、
    // 正確な利益を算出できないため推定しない（架空の数字を作らない）。
    // 遠方出動ボーナスは配送手配時まで未確定のため、このestimatedOrdProfitには含めない
    // （＝実際の確定利益は、遠方出動ボーナスが発生する注文ではこの推定値よりやや低くなる）。
    const allLineItemsHaveMasterData = validation.items!.every(i => i.merchantPrice !== null && i.containerFee !== null);
    const estimatedOrdProfit = allLineItemsHaveMasterData
      ? computeOrdGrossProfitForOrder(
          validation.items!.map(i => ({
            merchantPrice: i.merchantPrice!,
            containerFee: i.containerFee!,
            ordPriceUnit: i.unitPrice,
            quantity: i.quantity,
          })),
          deliveryFee,
          driverReward! // isConsultationチェック済みのため非null（TierLookupResultの型定義上は素通りしない）
        )
      : null;

    const order = runInTransaction(() => {
      const created = insertOrder({
        squareOrderId: '', // このSTEPではSquare未使用のため常に空文字
        items: validation.items!.map(i => ({ name: i.name, quantity: String(i.quantity) })),
        villaName: delivery.villaName,
        roomNumber: delivery.roomNumber,
        status: 'RECEIVED', // Order Statusは既存仕様のまま。決済前かどうかはpayment_statusで別管理する
        storeId: storeResolution.id, // 【Phase B】商品マスターから解決した加盟店(数値ID)。クライアント送信値は不使用
        driverId: null,
        createdAt: new Date().toISOString(),
        customerLineId: typeof rawOrder.customer_line_id === 'string' ? rawOrder.customer_line_id : null,
        // 正式金額はBackend再計算値のみ。ブラウザのtotal_moneyは採用しない
        totalMoney: { amount: recalculatedTotal, currency: 'JPY' },
        area: fallback.area,
        displayNo: fallback.displayNo,
        paymentStatus: 'PENDING',
        paymentAttemptNo: 1,
        paymentLinkId: '',
        deliveryTimeMinutes,
        driverReward,
        deliveryFee,
        estimatedOrdProfit,
        accommodationId,
        accommodationLatitude,
        accommodationLongitude,
        buildingVillaNumber,
        guestName,
        phoneNumber,
        deliveryLocation,
        deliveryInstructions,
      });

      // 商品マスターから解決できた明細(productKeyが非null)だけでなく、旧priceCatalog経路の
      // 明細(productKey=null)もあわせて全件スナップショット保存する。将来productKeyがnullの
      // 行を見れば「その注文時点では商品マスター未接続だった」と判別できる（架空の対応を作らない）。
      validation.items!.forEach(i => {
        insertOrderLineItem({
          orderId: created.id,
          productKey: i.productKey,
          productVersion: i.productVersion,
          productName: i.name,
          quantity: i.quantity,
          merchantPrice: i.merchantPrice,
          containerFee: i.containerFee,
          markupRate: i.markupRate,
          ordPriceUnit: i.unitPrice,
          gokunNukiRequested: i.gokunNukiRequested,
        });
      });

      return created;
    });
    createdOrderId = order.id; // 【2026-09-21】ここ以降の例外は「登録済み注文」に対するものと区別する

    if (validation.amountMismatch) {
      console.warn(
        `[注文受付API] クライアント送信額とBackend再計算額が不一致のため、Backend再計算値を採用しました（注文#${order.id}、再計算値: ¥${recalculatedTotal}）`
      );
    }

    // Square Payment Linkを発行する（Phase A、正式決済フローの中核）。
    // 【重要】失敗しても、上で作成した注文(PENDING)自体は削除しない
    // （ORD側の設定・API不備が原因であり、顧客都合の失敗ではないため）。
    // また、Payment Link生成の成功はpayment_statusをCOMPLETEDにする理由にはならない。
    // 【テスト専用】ORD_TEST_HOOKS='true'の場合のみ、__checkoutTestHooksの差し替えが有効になる。
    const doCreatePaymentLink =
      (process.env.ORD_TEST_HOOKS === 'true' && __checkoutTestHooks.createSquarePaymentLinkForOrder) ||
      createSquarePaymentLinkForOrder;
    const paymentLinkResult = await doCreatePaymentLink(order.id, order.paymentAttemptNo, validation.items!, deliveryFee);
    if (!paymentLinkResult.ok) {
      console.error(`[注文受付API] 注文#${order.id}のPayment Link生成に失敗しました: ${paymentLinkResult.error}`);
      return res.status(502).json({
        ok: false,
        orderId: order.id,
        error: `注文は登録されましたが、決済リンクの生成に失敗しました: ${paymentLinkResult.error}`,
      });
    }

    const doUpdateOrderPaymentLink =
      (process.env.ORD_TEST_HOOKS === 'true' && __checkoutTestHooks.updateOrderPaymentLink) || updateOrderPaymentLink;
    doUpdateOrderPaymentLink(order.id, paymentLinkResult.squareOrderId!, paymentLinkResult.paymentLinkId!);

    res.status(201).json({
      ok: true,
      orderId: order.id,
      displayNo: order.displayNo,
      paymentStatus: order.paymentStatus, // PENDINGのまま。Payment Link生成 ≠ 決済完了
      totalMoney: order.totalMoney,
      paymentLinkUrl: paymentLinkResult.paymentLinkUrl,
    });
  } catch (e) {
    if (createdOrderId !== null) {
      // insertOrder()自体は成功済み。以降(Payment Link発行後のDB更新等)で例外が発生した。
      // 注文データは削除しない（既存仕様維持）。payment_status/statusもここでは変更しない。
      console.error(`[注文受付API] 注文#${createdOrderId}は登録済みだが、決済処理中に例外が発生しました:`, e);
      res.status(500).json({
        ok: false,
        orderId: createdOrderId,
        error: '注文は登録されましたが、決済処理中にエラーが発生しました。ORD運営までお問い合わせください。',
      });
    } else {
      console.error('[注文受付API] 注文のDB登録に失敗しました:', e);
      res.status(500).json({ ok: false, error: '注文の登録に失敗しました。時間をおいて再度お試しください。' });
    }
  }
});

app.get('/api/orders', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json(getAllOrders());
});

// ============================================================
// 収益化：手数料精算・配送パートナー報酬・経営サマリー・収益シミュレーター
// 【注意】あくまで概算計算です。実際の入出金・請求書発行・税務処理は別途必要です。
// ============================================================

// 加盟店の精算（完了注文の売上合計・ORD手数料・加盟店への支払額）。ADMIN、または本人（加盟店）のみ閲覧可
// 【2026-09-23社長承認】加盟店手数料は0円が正式方針のため、以前の「売上×手数料率」計算は廃止。
// 加盟店お支払額は、order_line_items（checkout時の価格スナップショット）から
// 「加盟店定価(merchant_price)+容器代(container_fee)」を明細ごとに合算して算出する
// （＝配送料はここに含まれない。配送料はドライバー報酬の原資であり加盟店には支払わない）。
// 商品マスター未接続の明細（merchant_price=null）は金額に含めず、件数のみ別途返す
// （0円とみなさない＝架空の数字を作らない）。
interface StoreSettlementSummary {
  orderCount: number;
  grossAmount: number;
  merchantPayout: number;
  unresolvedLineItemCount: number;
}
function getStoreSettlementSummary(storeId: number): StoreSettlementSummary {
  const completed = getAllOrders().filter(
    o => o.storeId === storeId && o.status === 'COMPLETED' && o.paymentStatus === 'COMPLETED' && o.totalMoney
  );
  const grossAmount = completed.reduce((sum, o) => sum + (o.totalMoney?.amount || 0), 0);

  const lineItemRows = db
    .prepare(
      `SELECT oli.merchant_price, oli.container_fee, oli.quantity
       FROM order_line_items oli
       JOIN orders o ON o.id = oli.order_id
       WHERE o.store_id = ? AND o.status = 'COMPLETED' AND o.payment_status = 'COMPLETED'`
    )
    .all(storeId) as { merchant_price: number | null; container_fee: number | null; quantity: number }[];

  const resolved = lineItemRows.filter(r => r.merchant_price !== null && r.container_fee !== null);
  const unresolvedLineItemCount = lineItemRows.length - resolved.length;
  const merchantPayout = resolved.reduce(
    (sum, r) => sum + computeMerchantSalesUnit(r.merchant_price as number, r.container_fee as number) * r.quantity,
    0
  );

  return { orderCount: completed.length, grossAmount, merchantPayout, unresolvedLineItemCount };
}

app.get('/api/stores/:id/settlement', requireAuth('ADMIN', 'STORE'), (req: Request, res: Response) => {
  const storeId = Number(req.params.id);
  if (req.auth!.role === 'STORE' && req.auth!.id !== storeId) {
    return res.status(403).json({ ok: false, error: '他の加盟店の精算情報は閲覧できません' });
  }
  const store = getStoreById(storeId);
  if (!store) return res.status(404).json({ ok: false, error: '加盟店が見つかりません' });

  const summary = getStoreSettlementSummary(storeId);

  res.json({
    ok: true,
    storeId,
    storeName: store.name,
    orderCount: summary.orderCount,
    grossAmount: summary.grossAmount,
    netPayout: summary.merchantPayout,
    unresolvedLineItemCount: summary.unresolvedLineItemCount,
    currency: 'JPY',
    note:
      summary.unresolvedLineItemCount > 0
        ? `${summary.unresolvedLineItemCount}件の明細が商品マスター未接続のため、お支払額の計算に含まれていません。`
        : null,
  });
});

// 配送パートナーの精算（正式ドライバー報酬ルール、店舗→配送先のGoogle Routes車移動時間のみで
// 判定。driver_rewardがNULLの注文は¥0ではなく「未確定・要確認」として分離集計する。
// 【重要】checkout/dispatchへのGoogle Routes接続（別フェーズ）が完了するまで、driver_rewardは
// 常にNULLのままのため、confirmedDeliveryCount/confirmedPayoutTotalは常に0、全件が
// pendingとして計上される。これは意図した挙動であり、¥0を「確定した報酬額」として誤認しない
// ための設計。
interface DriverCompletedOrderRow {
  id: number;
  completed_at: string | null;
  villa_name: string;
  room_number: string;
  driver_reward: number | null;
}
function getDriverCompletedOrders(driverId: number): DriverCompletedOrderRow[] {
  return db
    .prepare(`SELECT id, completed_at, villa_name, room_number, driver_reward FROM orders WHERE driver_id = ? AND status = 'COMPLETED' ORDER BY id`)
    .all(driverId) as unknown as DriverCompletedOrderRow[];
}
interface DriverPayoutSummary {
  confirmedDeliveryCount: number;
  confirmedPayoutTotal: number;
  pendingDeliveryCount: number;
  pendingOrderIds: number[];
}
function summarizeDriverPayout(rows: DriverCompletedOrderRow[]): DriverPayoutSummary {
  const confirmed = rows.filter(r => r.driver_reward !== null);
  const pending = rows.filter(r => r.driver_reward === null);
  return {
    confirmedDeliveryCount: confirmed.length,
    confirmedPayoutTotal: confirmed.reduce((sum, r) => sum + (r.driver_reward as number), 0),
    pendingDeliveryCount: pending.length,
    pendingOrderIds: pending.map(r => r.id),
  };
}

// 配送パートナーの精算。ADMIN、または本人（配送パートナー）のみ閲覧可
app.get('/api/drivers/:id/settlement', requireAuth('ADMIN', 'DRIVER'), (req: Request, res: Response) => {
  const driverId = Number(req.params.id);
  if (req.auth!.role === 'DRIVER' && req.auth!.id !== driverId) {
    return res.status(403).json({ ok: false, error: '他の配送パートナーの精算情報は閲覧できません' });
  }
  const driver = getDriverById(driverId);
  if (!driver) return res.status(404).json({ ok: false, error: 'ドライバーが見つかりません' });

  const rows = getDriverCompletedOrders(driverId);
  const summary = summarizeDriverPayout(rows);

  res.json({
    ok: true,
    driverId,
    driverName: driver.name,
    confirmedDeliveryCount: summary.confirmedDeliveryCount,
    confirmedPayoutTotal: summary.confirmedPayoutTotal,
    pendingDeliveryCount: summary.pendingDeliveryCount,
    pendingOrderIds: summary.pendingOrderIds,
    currency: 'JPY',
    note:
      summary.pendingDeliveryCount > 0
        ? `${summary.pendingDeliveryCount}件の配達報酬が未確定です。確認・確定後に再集計してください。`
        : null,
  });
});

// ============================================================
// 精算のCSV・PDF出力（加盟店への請求・配送パートナー報酬の証憑として使用）
// ============================================================
function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(values: Array<string | number>): string {
  return values.map(csvCell).join(',') + '\r\n';
}

app.get('/api/stores/:id/settlement.csv', requireAuth('ADMIN', 'STORE'), (req: Request, res: Response) => {
  const storeId = Number(req.params.id);
  if (req.auth!.role === 'STORE' && req.auth!.id !== storeId) return res.status(403).send('他の加盟店の精算情報は閲覧できません');
  const store = getStoreById(storeId);
  if (!store) return res.status(404).send('加盟店が見つかりません');

  const completed = getAllOrders().filter(
    o => o.storeId === storeId && o.status === 'COMPLETED' && o.paymentStatus === 'COMPLETED' && o.totalMoney
  );
  let csv = '﻿'; // Excelでの文字化け防止のBOM
  csv += csvRow(['注文ID', '完了日時', 'お届け先', '商品', '注文金額(配送料込み)', '加盟店お支払額(商品代のみ)']);
  let payoutTotal = 0;
  let unresolvedCount = 0;
  completed.forEach(o => {
    const gross = o.totalMoney?.amount || 0;
    const lineItems = getOrderLineItemsByOrderId(o.id);
    let orderPayout = 0;
    let orderHasUnresolved = false;
    lineItems.forEach(li => {
      if (li.merchantPrice === null || li.containerFee === null) {
        orderHasUnresolved = true;
        return;
      }
      orderPayout += computeMerchantSalesUnit(li.merchantPrice, li.containerFee) * li.quantity;
    });
    if (orderHasUnresolved) unresolvedCount++;
    payoutTotal += orderPayout;
    csv += csvRow([
      o.id,
      o.completedAt || '',
      `${o.villaName} / ${o.roomNumber}`,
      o.items.map(i => `${i.name}×${i.quantity}`).join('; '),
      gross,
      orderHasUnresolved ? `${orderPayout}（一部算出不能）` : orderPayout,
    ]);
  });
  csv += csvRow([]);
  csv += csvRow(['お支払額合計', '', '', '', '', payoutTotal]);
  if (unresolvedCount > 0) csv += csvRow([`※${unresolvedCount}件の注文に商品マスター未接続の明細が含まれます`]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="settlement_store${storeId}.csv"`);
  res.send(csv);
});

app.get('/api/drivers/:id/settlement.csv', requireAuth('ADMIN', 'DRIVER'), (req: Request, res: Response) => {
  const driverId = Number(req.params.id);
  if (req.auth!.role === 'DRIVER' && req.auth!.id !== driverId) return res.status(403).send('他の配送パートナーの精算情報は閲覧できません');
  const driver = getDriverById(driverId);
  if (!driver) return res.status(404).send('ドライバーが見つかりません');

  const rows = getDriverCompletedOrders(driverId);
  const summary = summarizeDriverPayout(rows);
  let csv = '﻿';
  csv += csvRow(['注文ID', '完了日時', 'お届け先', '状態', '報酬額']);
  rows.forEach(o => {
    const villa = `${o.villa_name} / ${o.room_number}`;
    if (o.driver_reward !== null) {
      csv += csvRow([o.id, o.completed_at || '', villa, '確定', o.driver_reward]);
    } else {
      csv += csvRow([o.id, o.completed_at || '', villa, '要確認（報酬未確定）', '']);
    }
  });
  csv += csvRow([]);
  csv += csvRow(['確定合計', '', '', '', summary.confirmedPayoutTotal]);
  csv += csvRow(['未確定件数', '', '', '', summary.pendingDeliveryCount]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="settlement_driver${driverId}.csv"`);
  res.send(csv);
});

app.get('/api/stores/:id/settlement.pdf', requireAuth('ADMIN', 'STORE'), (req: Request, res: Response) => {
  const storeId = Number(req.params.id);
  if (req.auth!.role === 'STORE' && req.auth!.id !== storeId) return res.status(403).send('他の加盟店の精算情報は閲覧できません');
  const store = getStoreById(storeId);
  if (!store) return res.status(404).send('加盟店が見つかりません');

  const summary = getStoreSettlementSummary(storeId);
  const completed = getAllOrders().filter(
    o => o.storeId === storeId && o.status === 'COMPLETED' && o.paymentStatus === 'COMPLETED' && o.totalMoney
  );

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="settlement_store${storeId}.pdf"`);
  const doc = new PDFDocument({ margin: 40 });
  doc.font(JP_FONT_PATH);
  doc.pipe(res);
  doc.fontSize(18).text('ORD 加盟店様お支払明細書', { align: 'center' });
  doc.moveDown();
  doc.fontSize(11);
  doc.text(`加盟店: ${store.name}（加盟店手数料0円、商品代金は満額お支払い）`);
  doc.text(`発行日: ${new Date().toISOString().slice(0, 10)}`);
  doc.text(`対象注文件数: ${summary.orderCount}件`);
  doc.moveDown();
  doc.text(`売上合計(配送料込み): ¥${summary.grossAmount.toLocaleString('ja-JP')}`);
  doc.fontSize(13).text(`お支払額(商品代のみ): ¥${summary.merchantPayout.toLocaleString('ja-JP')}`, { underline: true });
  if (summary.unresolvedLineItemCount > 0) {
    doc.fontSize(10).fillColor('red').text(`※${summary.unresolvedLineItemCount}件の明細が商品マスター未接続のため、上記お支払額に含まれていません。`);
    doc.fillColor('black');
  }
  doc.moveDown();
  doc.fontSize(9).text('内訳', { underline: true });
  completed.forEach(o => {
    const lineItems = getOrderLineItemsByOrderId(o.id);
    let orderPayout = 0;
    let hasUnresolved = false;
    lineItems.forEach(li => {
      if (li.merchantPrice === null || li.containerFee === null) {
        hasUnresolved = true;
        return;
      }
      orderPayout += computeMerchantSalesUnit(li.merchantPrice, li.containerFee) * li.quantity;
    });
    const label = hasUnresolved ? `¥${orderPayout.toLocaleString('ja-JP')}（一部算出不能）` : `¥${orderPayout.toLocaleString('ja-JP')}`;
    doc.text(`#${o.id}  ${o.completedAt ? o.completedAt.slice(0, 16).replace('T', ' ') : ''}  ${o.villaName}  ${label}`);
  });
  doc.end();
});

app.get('/api/drivers/:id/settlement.pdf', requireAuth('ADMIN', 'DRIVER'), (req: Request, res: Response) => {
  const driverId = Number(req.params.id);
  if (req.auth!.role === 'DRIVER' && req.auth!.id !== driverId) return res.status(403).send('他の配送パートナーの精算情報は閲覧できません');
  const driver = getDriverById(driverId);
  if (!driver) return res.status(404).send('ドライバーが見つかりません');

  const rows = getDriverCompletedOrders(driverId);
  const summary = summarizeDriverPayout(rows);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="settlement_driver${driverId}.pdf"`);
  const doc = new PDFDocument({ margin: 40 });
  doc.font(JP_FONT_PATH);
  doc.pipe(res);
  doc.fontSize(18).text('ORD 配送パートナー報酬明細書', { align: 'center' });
  doc.moveDown();
  doc.fontSize(11);
  doc.text(`配送パートナー: ${driver.name}`);
  doc.text(`発行日: ${new Date().toISOString().slice(0, 10)}`);
  doc.text(`完了配達件数: ${rows.length}件（確定 ${summary.confirmedDeliveryCount}件／未確定 ${summary.pendingDeliveryCount}件）`);
  doc.moveDown();
  doc.fontSize(13).text(`確定お支払額: ¥${summary.confirmedPayoutTotal.toLocaleString('ja-JP')}`, { underline: true });
  if (summary.pendingDeliveryCount > 0) {
    doc.fontSize(10).fillColor('red').text(`※${summary.pendingDeliveryCount}件の報酬が未確定です。確認・確定後に再集計してください。`);
    doc.fillColor('black');
  }
  doc.moveDown();
  doc.fontSize(9).text('内訳', { underline: true });
  rows.forEach(o => {
    const label = o.driver_reward !== null ? `¥${o.driver_reward.toLocaleString('ja-JP')}` : '要確認（報酬未確定）';
    doc.text(`#${o.id}  ${o.completed_at ? o.completed_at.slice(0, 16).replace('T', ' ') : ''}  ${o.villa_name}  ${label}`);
  });
  doc.end();
});

// 経営サマリー（全加盟店・全ドライバー合算のORD粗利）
// 【STEP・2026-09-23社長承認】ORDの実際の収益源（顧客向け40%上乗せ）に基づく経営サマリー。
// 加盟店手数料(commissionRate)は正式に0円のため、以前のような「手数料収益」は存在しない。
// 各注文のestimated_ord_profit（checkout時点で商品マスター接続済みの明細のみ算出、
// 遠方出動ボーナス確定前の推定値）を合算する。算出できなかった注文は件数のみ別途表示する
// （0円とみなして合算に含めない＝架空の数字を作らない）。
function revenueSummary() {
  const allOrders = getAllOrders();
  const completed = allOrders.filter(o => o.status === 'COMPLETED' && o.totalMoney);
  const grossAmount = completed.reduce((sum, o) => sum + (o.totalMoney?.amount || 0), 0);

  const profitRows = db
    .prepare(`SELECT estimated_ord_profit FROM orders WHERE status = 'COMPLETED'`)
    .all() as { estimated_ord_profit: number | null }[];
  const ordGrossProfit = profitRows.reduce((sum, r) => sum + (r.estimated_ord_profit ?? 0), 0);
  const ordGrossProfitPendingCount = profitRows.filter(r => r.estimated_ord_profit === null).length;

  // ドライバー報酬は確定分（driver_reward非NULL）のみを合算し、未確定分は¥0とみなさず
  // 件数のみ別途カウントする（checkout/dispatch未接続の間は全件が未確定になる想定通りの挙動）。
  const driverRewardRows = db
    .prepare(`SELECT driver_reward FROM orders WHERE status = 'COMPLETED' AND driver_id IS NOT NULL`)
    .all() as { driver_reward: number | null }[];
  const driverPayoutTotal = driverRewardRows.reduce((sum, r) => sum + (r.driver_reward ?? 0), 0);
  const driverPayoutPendingCount = driverRewardRows.filter(r => r.driver_reward === null).length;

  return {
    completedOrderCount: completed.length,
    grossAmount,
    driverPayoutTotal,
    driverPayoutPendingCount,
    ordGrossProfit,
    ordGrossProfitPendingCount,
    currency: 'JPY',
  };
}

app.get('/api/revenue/summary', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json({ ok: true, ...revenueSummary() });
});

// 収益シミュレーター（実データ不要。想定値から月商・ORD粗利を試算する）
// 【2026-09-23社長承認】ORDの実際の収益源は加盟店手数料ではなく、顧客向け上乗せ（デフォルト40%）
// と配送マージン（配送料 - ドライバー報酬）。computeOrdGrossProfitForOrder()と同じ考え方で試算する。
app.get('/api/revenue-simulator', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  const dailyOrders = Number(q.dailyOrders) || 20;
  // 加盟店お支払額（定価+容器代の合算・上乗せ前の金額）の注文あたり平均想定値
  const avgMerchantSalesValue = q.avgMerchantSalesValue !== undefined && q.avgMerchantSalesValue !== '' ? Number(q.avgMerchantSalesValue) : 1800;
  // 上乗せ率は加盟店ごとに個別設定されうる値であり、ここではGAJIMARUで採用している40%を
  // シミュレーション上の仮定値として採用する（正式な全社共通デフォルトではない）。
  const SIMULATOR_MARKUP_RATE_DEFAULT = 0.4;
  const markupRate = q.markupRate !== undefined && q.markupRate !== '' ? Number(q.markupRate) : SIMULATOR_MARKUP_RATE_DEFAULT;
  const days = Number(q.days) || 30;
  // 注文あたりの配送料（顧客負担）の想定値
  const avgDeliveryFee = q.avgDeliveryFee !== undefined && q.avgDeliveryFee !== '' ? Number(q.avgDeliveryFee) : 500;
  // 【重要】¥1,000は正式な一律報酬ではない。正式ドライバー報酬ルール（30分以下¥800／
  // 31-50分¥1,000／51-60分¥1,300／60分超要相談）のうち、中距離区分（31-50分）の値を
  // シミュレーション上の仮定値として採用しているだけであり、実際の報酬は配達ごとの
  // 距離区分（Google Routes実測時間）に基づいて決まる。この仮定値と実際の精算額
  // （/api/drivers/:id/settlementで返るconfirmedPayoutTotal）を混同しないこと。
  const DRIVER_PAYOUT_SIMULATION_DEFAULT = 1000;
  const driverPayoutPerDelivery =
    q.driverPayoutPerDelivery !== undefined && q.driverPayoutPerDelivery !== ''
      ? Number(q.driverPayoutPerDelivery)
      : DRIVER_PAYOUT_SIMULATION_DEFAULT;

  const totalOrders = dailyOrders * days;
  const avgOrdProductPrice = avgMerchantSalesValue * (1 + markupRate);
  const grossGmv = totalOrders * (avgOrdProductPrice + avgDeliveryFee);
  const productGrossProfitTotal = Math.round(totalOrders * avgMerchantSalesValue * markupRate);
  const driverPayoutTotal = totalOrders * driverPayoutPerDelivery;
  const deliveryGrossProfitTotal = totalOrders * avgDeliveryFee - driverPayoutTotal;
  const ordGrossProfit = productGrossProfitTotal + deliveryGrossProfitTotal;

  res.json({
    ok: true,
    assumptions: {
      dailyOrders,
      avgMerchantSalesValue,
      markupRate,
      avgDeliveryFee,
      days,
      driverPayoutPerDelivery,
      driverPayoutAssumption:
        '中距離区分（31〜50分）の仮定値。正式な一律報酬ではなく、実際の報酬は配達ごとの距離区分（Google Routes実測時間）に基づく。',
    },
    totalOrders,
    grossGmv,
    productGrossProfitTotal,
    deliveryGrossProfitTotal,
    driverPayoutTotal,
    driverPayoutNote: 'このシミュレーション値は試算用の仮定であり、実際の精算額（/api/drivers/:id/settlementのconfirmedPayoutTotal）とは別物です。',
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
// 地図連携：加盟店・配達先・配送パートナーを一画面で確認する
// 【重要】Google Maps APIキーが未提供のため、Google Maps JavaScript APIは使用していません。
// 代わりにAPIキー不要のOpenStreetMap（Leaflet.js）を使用しています。また、実際のGPS座標も
// まだ取得できていないため、エリア名（恩納村・北谷町等）の市町村中心座標＋簡易オフセットによる
// 「おおよその位置」表示です。実際の正確な現在地ではありません（Phase2でGPS連携が入り次第、
// 正確な位置に置き換え可能な設計にしてあります）。
// ============================================================
const AREA_COORDS: Record<string, { lat: number; lng: number }> = {
  恩納村: { lat: 26.5039, lng: 127.8419 },
  読谷村: { lat: 26.3953, lng: 127.7369 },
  名護市: { lat: 26.5917, lng: 127.9767 },
  北谷町: { lat: 26.3122, lng: 127.7639 },
};
function approxLocation(area: string | null, seed: number): { lat: number; lng: number; approx: boolean } {
  const base = (area && AREA_COORDS[area]) || AREA_COORDS['恩納村'];
  // 同一エリア内の複数地点が完全に重ならないよう、id由来の小さな決定的オフセットを加える
  const offset = ((seed % 7) - 3) * 0.006;
  return { lat: base.lat + offset, lng: base.lng + offset * 0.6, approx: true };
}
app.get('/api/map/overview', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  const allOrders = getAllOrders();
  const stores = getAllStores().map(s => ({ type: 'store', id: s.id, name: s.name, area: s.area, ...approxLocation(s.area, s.id) }));
  const drivers = getAllDrivers().map(d => ({
    type: 'driver',
    id: d.id,
    name: d.name,
    area: d.area,
    status: d.status,
    ...approxLocation(d.area, d.id + 100),
  }));
  const activeOrders = allOrders
    // 決済未確定の注文は「進行中の配達案件」として地図に表示しない（決済が済むまでは実務上の案件ではないため）
    .filter(o => o.status !== 'COMPLETED' && o.paymentStatus === 'COMPLETED')
    .map(o => ({
      type: 'order',
      id: o.id,
      villaName: o.villaName,
      status: o.status,
      area: o.area,
      ...approxLocation(o.area, o.id + 200),
    }));
  res.json({ ok: true, stores, drivers, orders: activeOrders });
});

// ============================================================
// 通知強化：注文遅延・加盟店未確認・ドライバー未応答を自動検知する
// 【注意】専用の運営(オペレーション)用LINEアカウントが未整備のため、OPS_LINE_USER_ID が
// 設定されていればそこへLINE通知、未設定時は/adminのアラートパネルとコンソールログのみ。
// ============================================================
const ALERT_THRESHOLD_MINUTES = {
  orderNotDispatched: 10, // 注文受付のまま未手配
  storeNotConfirmed: 15, // 手配後、加盟店が調理開始/完了の反応をしていない
  driverNotResponding: 15, // 手配後、配送パートナーが受託・集荷していない
};
const OPS_LINE_USER_ID = process.env.OPS_LINE_USER_ID || '';
interface AlertItem {
  orderId: number;
  type: 'ORDER_NOT_DISPATCHED' | 'STORE_NOT_CONFIRMED' | 'DRIVER_NOT_RESPONDING';
  message: string;
  minutesElapsed: number;
}
function minutesSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
}
function computeAlerts(): AlertItem[] {
  const alerts: AlertItem[] = [];
  for (const o of getAllOrders()) {
    // 決済未確定(PENDING/FAILED/REFUNDED)の注文は、まだ加盟店に手配できる状態ではないため
    // 「未手配です」という誤ったアラートの対象外にする（決済待ちの正常な状態のため）。
    if (o.status === 'RECEIVED' && o.paymentStatus === 'COMPLETED') {
      const elapsed = minutesSince(o.createdAt);
      if (elapsed >= ALERT_THRESHOLD_MINUTES.orderNotDispatched) {
        alerts.push({ orderId: o.id, type: 'ORDER_NOT_DISPATCHED', message: `注文#${o.id}（${o.villaName}）が受付から${elapsed}分間未手配です`, minutesElapsed: elapsed });
      }
    } else if (o.status === 'PREPARING') {
      const elapsed = minutesSince(o.createdAt);
      if (elapsed >= ALERT_THRESHOLD_MINUTES.storeNotConfirmed) {
        alerts.push({ orderId: o.id, type: 'STORE_NOT_CONFIRMED', message: `注文#${o.id}（${o.villaName}）は手配後${elapsed}分経過していますが加盟店の調理完了確認がありません`, minutesElapsed: elapsed });
      }
      if (elapsed >= ALERT_THRESHOLD_MINUTES.driverNotResponding) {
        alerts.push({ orderId: o.id, type: 'DRIVER_NOT_RESPONDING', message: `注文#${o.id}（${o.villaName}）は手配後${elapsed}分経過していますが配送パートナーが応答していません`, minutesElapsed: elapsed });
      }
    }
  }
  return alerts;
}
// 同じアラートを繰り返し通知しないための既送信済みキー集合（インメモリ、サーバー再起動でリセット）
const notifiedAlertKeys = new Set<string>();
async function checkAlertsAndNotify() {
  for (const alert of computeAlerts()) {
    const key = `${alert.orderId}:${alert.type}`;
    if (notifiedAlertKeys.has(key)) continue;
    notifiedAlertKeys.add(key);
    console.warn(`[運営アラート] ${alert.message}`);
    if (OPS_LINE_USER_ID) {
      try {
        await pushLine(OPS_LINE_USER_ID, {
          type: 'flex',
          altText: `【ORD運営アラート】${alert.message}`,
          contents: {
            type: 'bubble',
            body: {
              type: 'box',
              layout: 'vertical',
              contents: [{ type: 'text', text: `⚠️ ${alert.message}`, wrap: true, weight: 'bold' }],
            },
          },
        });
      } catch (e) {
        console.error('[運営アラートLINE通知エラー]', e);
      }
    }
  }
}
setInterval(() => {
  checkAlertsAndNotify().catch(e => console.error('[アラートチェックエラー]', e));
}, 60 * 1000);

app.get('/api/alerts', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json({ ok: true, alerts: computeAlerts() });
});

// ============================================================
// 分析：売れ筋ランキング・時間帯分析・曜日分析・リピート率
// 【注意】実運用データが十分に蓄積されるまでは統計的な集計であり、機械学習による
// 需要予測ではありません。データ量が増えた段階で本格的な予測モデルの導入を検討してください。
// ============================================================
const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
function analyticsDashboard() {
  const allOrders = getAllOrders();

  const itemCounts = new Map<string, number>();
  allOrders.forEach(o => o.items.forEach(i => itemCounts.set(i.name, (itemCounts.get(i.name) || 0) + Number(i.quantity || '1'))));
  const topItems = [...itemCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 10);

  const hourly = Array.from({ length: 24 }, () => 0);
  const byDow = Array.from({ length: 7 }, () => 0);
  allOrders.forEach(o => {
    const d = new Date(o.createdAt);
    hourly[d.getHours()]++;
    byDow[d.getDay()]++;
  });
  const hourlyDistribution = hourly.map((count, hour) => ({ hour, count }));
  const dayOfWeekDistribution = byDow.map((count, i) => ({ day: DOW_LABELS[i], count }));

  // リピート率：ヴィラ名+部屋番号を簡易的な「同一お客様」の代替キーとして使用
  // （会員アカウント等の永続的な顧客IDが未実装のための近似指標）
  const guestKey = (o: Order) => `${o.villaName}::${o.roomNumber}`;
  const guestOrderCounts = new Map<string, number>();
  allOrders.forEach(o => guestOrderCounts.set(guestKey(o), (guestOrderCounts.get(guestKey(o)) || 0) + 1));
  const totalGuests = guestOrderCounts.size;
  const repeatGuests = [...guestOrderCounts.values()].filter(c => c > 1).length;
  const repeatRate = totalGuests > 0 ? Math.round((repeatGuests / totalGuests) * 100) : 0;

  return { topItems, hourlyDistribution, dayOfWeekDistribution, repeatRate, totalGuests, repeatGuests };
}
app.get('/api/analytics', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json({ ok: true, ...analyticsDashboard() });
});

// ============================================================
// 管理画面（ログイン必須。Cookie(ord_admin_session)にJWTを保持する）
// ============================================================
function renderAdminLoginHtml(error?: string): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ORD 管理者ログイン</title>
<style>
body{font-family:"Hiragino Sans","Yu Gothic",sans-serif;background:#14181C;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;}
form{background:#fff;color:#1F2D3A;padding:32px;border-radius:12px;width:280px;max-width:100%;}
h2{margin-top:0;font-size:16px;}
input{width:100%;box-sizing:border-box;padding:10px;margin-bottom:10px;border:1px solid #E7E0D2;border-radius:6px;font-size:13px;}
button{width:100%;padding:10px;background:#0086A8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;}
.err{color:#C0392B;font-size:12px;margin-bottom:10px;}
</style></head>
<body>
<form method="POST" action="/admin/login">
  <h2>🌺 ORD 管理者ログイン</h2>
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
  const accommodations = getAllAccommodations(); // Phase B-3: マスタ状況の表示・active切り替えのみに使用
  const productDrafts = getAllProductDrafts(); // STEP3: 商品マスター管理画面用
  const currentProducts = getCurrentProducts(); // STEP3: 商品マスター管理画面用（現行versionのみ）
  const unassignedLineContacts = getUnassignedLineContacts(); // LINE友だち追加：未割り当て一覧
  const storeNameById = (id: number) => stores.find(s => s.id === id)?.name || `#${id}`;
  // 管理画面日本語化（3002テスト環境のみ）：DB上の生のstatus値は変更せず、表示用ラベルのみ日本語化する。
  const draftStatusLabelJa = (status: string): string =>
    ({ DRAFT: '下書き', NEEDS_REVIEW: '要確認', APPROVED: '承認済み', REJECTED: '却下済み' } as Record<string, string>)[status] || status;
  const productStatusLabelJa = (status: string): string =>
    ({ ACTIVE: '有効', INACTIVE: '無効' } as Record<string, string>)[status] || status;

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
      <td>${o.displayNo || '(未設定)'}</td>
      <td>${o.squareOrderId || '未設定'}</td>
      <td>${o.villaName} / ${o.roomNumber}${o.area ? `（${o.area}）` : ''}</td>
      <td>${o.items.map(i => `${i.name}×${i.quantity}`).join('<br>') || '(商品情報なし)'}</td>
      <td>${o.totalMoney ? yen(o.totalMoney.amount) : '(金額情報なし)'}</td>
      <td>${o.status}</td>
      <td>
        <select id="store-${o.id}">${storeOptions(o.storeId)}</select>
        ${driverSelectForOrder(o)}
      </td>
      <td>${o.paymentStatus !== 'COMPLETED' ? '決済待ち' : o.status === 'RECEIVED' ? `<button onclick="dispatchOrder(${o.id})">手配開始</button>` : '手配済み'}</td>
    </tr>`
    )
    .join('');

  const kpi = kpiDashboard();
  const storeRankingRows = kpi.storeRanking
    .map((s, i) => `<li>${i + 1}位: ${s.name}　${s.orderCount}件　${yen(s.revenue)}</li>`)
    .join('');

  const rev = revenueSummary();
  const storeSettlementRows = stores
    .map(
      s => `<li>${s.name}（手数料率${Math.round(s.commissionRate * 100)}%・${s.area}）
      <br><span style="font-size:11px;color:var(--sub);">状態: ${s.active ? '✅有効(active)' : '⛔無効(inactive)'}　カタログID: ${s.catalogStoreId || '(未設定)'}　座標: ${s.latitude != null && s.longitude != null ? '設定済み' : '未設定'}</span><br>
      <button onclick="viewStoreSettlement(${s.id})">精算を見る</button>
      <button class="secondary" onclick="toggleStoreActive(${s.id}, ${s.active ? 'false' : 'true'})">${s.active ? '無効にする' : '有効にする'}</button>
      <a class="btn secondary" href="/api/stores/${s.id}/settlement.csv">CSV</a>
      <a class="btn secondary" href="/api/stores/${s.id}/settlement.pdf">PDF</a></li>`
    )
    .join('');
  // Phase B-3: 宿泊施設マスタの状態表示・active切り替えのみ（座標登録・住所編集UIは今回作らない）
  const accommodationRows = accommodations
    .map(
      a => `<li>${a.name}（${a.area}）
      <br><span style="font-size:11px;color:var(--sub);">状態: ${a.active ? '✅有効(active)' : '⛔無効(inactive)'}　座標: ${a.latitude != null && a.longitude != null ? '設定済み' : '未設定'}</span><br>
      <button class="secondary" onclick="toggleAccommodationActive('${a.id}', ${a.active ? 'false' : 'true'})">${a.active ? '無効にする' : '有効にする'}</button></li>`
    )
    .join('');
  const driverSettlementRows = drivers
    .map(
      d => `<li>${d.name}（${d.area}）
      <button onclick="viewDriverSettlement(${d.id})">精算を見る</button>
      <a class="btn secondary" href="/api/drivers/${d.id}/settlement.csv">CSV</a>
      <a class="btn secondary" href="/api/drivers/${d.id}/settlement.pdf">PDF</a></li>`
    )
    .join('');

  // STEP3: 商品Draft一覧（フィルタはStore/Status/Needs Reviewの3種、行のdata属性を見てJS側で絞り込む）
  const productDraftRows = productDrafts
    .map(
      d => `<tr data-store-id="${d.storeId}" data-status="${d.status}" data-needs-review="${d.needsReview ? '1' : '0'}">
      <td>${d.id}</td>
      <td>${storeNameById(d.storeId)}</td>
      <td>${d.extractedName || '(未設定)'}</td>
      <td>${d.extractedNameEn || ''}</td>
      <td>${d.extractedMerchantPrice != null ? yen(d.extractedMerchantPrice) : '-'}</td>
      <td>${d.extractedContainerFee != null ? yen(d.extractedContainerFee) : '-'}</td>
      <td>${d.extractedContainerCount ?? '-'}</td>
      <td>${d.extractedCategory || '-'}</td>
      <td>${d.markupRate != null ? Math.round(d.markupRate * 100) + '%' : '-'}</td>
      <td>${d.computedOrdPrice != null ? yen(d.computedOrdPrice) : '-'}</td>
      <td>${draftStatusLabelJa(d.status)}</td>
      <td>${d.needsReview ? 'はい' : 'いいえ'}</td>
      <td>${d.confidence ?? '-'}</td>
      <td>${d.createdAt}</td>
      <td><button onclick="viewDraft(${d.id})">確認・審査</button></td>
    </tr>`
    )
    .join('');

  // STEP3: 現行商品マスター一覧（superseded_at IS NULLの現行versionのみ）
  const productRows = currentProducts
    .map(
      p => `<tr>
      <td>${p.productKey}</td>
      <td>${storeNameById(p.storeId)}</td>
      <td>${p.version}</td>
      <td>${p.name}</td>
      <td>${p.nameEn || ''}</td>
      <td>${p.merchantPrice != null ? yen(p.merchantPrice) : '-'}</td>
      <td>${p.containerFee != null ? yen(p.containerFee) : '-'}</td>
      <td>${p.markupRate != null ? Math.round(p.markupRate * 100) + '%' : '-'}</td>
      <td>${yen(p.ordPrice)}</td>
      <td>${productStatusLabelJa(p.status)}</td>
      <td><input type="checkbox" ${p.gokunNukiAvailable ? 'checked' : ''} onchange="toggleGokunNuki('${p.productKey}', this.checked)"></td>
      <td>${p.approvedBy || '-'}</td>
      <td>${p.approvedAt || '-'}</td>
      <td>${p.category || '-'}</td>
      <td>${p.containerCount ?? '-'}</td>
      <td>${p.squareCatalogItemId || '-'}</td>
      <td><button class="secondary" onclick="viewVersionHistory('${p.productKey}')">バージョン履歴</button></td>
    </tr>`
    )
    .join('');
  const productDraftStoreFilterOptions = stores.map(s => `<option value="${s.id}">${s.name}</option>`).join('');

  const alerts = computeAlerts();
  const alertsHtml = alerts.length
    ? alerts.map(a => `<div class="alert-item">⚠️ ${a.message}</div>`).join('')
    : `<p>現在アラートはありません（未手配${ALERT_THRESHOLD_MINUTES.orderNotDispatched}分・加盟店未確認/配送未応答${ALERT_THRESHOLD_MINUTES.storeNotConfirmed}分を超えると表示されます）</p>`;

  const analytics = analyticsDashboard();
  const maxItemCount = Math.max(1, ...analytics.topItems.map(i => i.count));
  const topItemsHtml =
    analytics.topItems
      .map(
        i => `<div class="bar-row"><span style="width:110px;">${i.name}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((i.count / maxItemCount) * 100)}%"></div></div><span>${i.count}</span></div>`
      )
      .join('') || '<p>データがありません</p>';
  const maxHourCount = Math.max(1, ...analytics.hourlyDistribution.map(h => h.count));
  const hourlyHtml = analytics.hourlyDistribution
    .filter(h => h.count > 0)
    .map(
      h => `<div class="bar-row"><span style="width:50px;">${h.hour}時台</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((h.count / maxHourCount) * 100)}%"></div></div><span>${h.count}</span></div>`
    )
    .join('') || '<p>データがありません</p>';
  const maxDowCount = Math.max(1, ...analytics.dayOfWeekDistribution.map(d => d.count));
  const dowHtml = analytics.dayOfWeekDistribution
    .map(
      d => `<div class="bar-row"><span style="width:30px;">${d.day}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((d.count / maxDowCount) * 100)}%"></div></div><span>${d.count}</span></div>`
    )
    .join('');

  const mapStores = stores.map(s => ({ ...approxLocation(s.area, s.id), name: s.name, kind: 'store', detail: s.area }));
  const mapDrivers = drivers.map(d => ({ ...approxLocation(d.area, d.id + 100), name: d.name, kind: 'driver', detail: `${d.status}・${d.area}` }));
  const mapOrders = orders
    // 決済未確定の注文は「進行中の配達案件」として地図に表示しない（決済が済むまでは実務上の案件ではないため）
    .filter(o => o.status !== 'COMPLETED' && o.paymentStatus === 'COMPLETED')
    .map(o => ({ ...approxLocation(o.area, o.id + 200), name: o.villaName, kind: 'order', detail: o.status }));
  const mapDataJson = JSON.stringify([...mapStores, ...mapDrivers, ...mapOrders]);

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ORD 受注管理</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
:root{--ocean:#0086A8;--palm:#2E9E6B;--gold:#C9A15A;--ink:#14181C;--bg:#F7F6F2;--card:#FFFFFF;--text:#1F2D3A;--sub:#6B7680;--border:#E7E0D2;}
[data-theme="dark"]{--bg:#0F1216;--card:#1B2027;--text:#EDEFF2;--sub:#9AA4AE;--border:#2A313A;}
*{box-sizing:border-box;}
body{font-family:"Hiragino Sans","Yu Gothic",sans-serif;margin:0;padding:20px;background:var(--bg);color:var(--text);}
h1{font-size:19px;margin:0;} h3{margin:0 0 10px;font-size:14px;}
p{color:var(--sub);font-size:13px;margin:4px 0;} b{color:var(--text);}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;}
.badge{display:inline-block;background:var(--gold);color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;margin-right:4px;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:16px;}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;}
.card.full{grid-column:1/-1;}
input,select{padding:7px;font-size:12.5px;margin:0 4px 6px 0;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);}
button,.btn{background:var(--ocean);color:#fff;border:none;padding:7px 13px;border-radius:6px;cursor:pointer;font-size:12.5px;text-decoration:none;display:inline-block;}
button.secondary,.btn.secondary{background:var(--sub);}
ul{padding-left:18px;margin:6px 0;} li{font-size:12.5px;margin-bottom:6px;}
.alert-item{background:#FDECEA;color:#B3261E;padding:8px 10px;border-radius:8px;font-size:12.5px;margin-bottom:6px;}
[data-theme="dark"] .alert-item{background:#3A1F1E;color:#FF8A80;}
.bar-row{display:flex;align-items:center;gap:8px;font-size:12px;margin:4px 0;color:var(--text);}
.bar-track{flex:1;background:var(--border);border-radius:4px;height:10px;overflow:hidden;}
.bar-fill{background:var(--palm);height:100%;}
.table-scroll{overflow-x:auto;border-radius:8px;}
table{width:100%;border-collapse:collapse;background:var(--card);min-width:820px;}
th,td{border:1px solid var(--border);padding:8px;font-size:12.5px;text-align:left;vertical-align:top;}
th{background:var(--ink);color:#fff;}
#map{height:320px;border-radius:8px;}
.theme-toggle{cursor:pointer;font-size:16px;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 10px;}
.logout{font-size:12px;color:var(--ocean);text-decoration:none;}
/* STEP3: 商品マスター管理画面用の汎用モーダル（既存Admin UIには専用モーダルがなかったため新設） */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);align-items:center;justify-content:center;z-index:1000;padding:16px;}
.modal-overlay.open{display:flex;}
.modal-box{background:var(--card);color:var(--text);border-radius:12px;padding:18px;max-width:560px;width:100%;max-height:85vh;overflow-y:auto;}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.modal-header h3{margin:0;}
.modal-close{cursor:pointer;font-size:18px;color:var(--sub);line-height:1;}
.modal-section{margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border);}
.modal-section:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0;}
.modal-section h4{margin:0 0 8px;font-size:11.5px;color:var(--sub);text-transform:uppercase;letter-spacing:.03em;}
.field-row{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;margin:4px 0;}
.field-row span{color:var(--sub);}
.field-row b{text-align:right;}
textarea{width:100%;box-sizing:border-box;padding:7px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);font-family:inherit;}
@media(max-width:640px){body{padding:12px;} .grid{grid-template-columns:1fr;}}
</style></head>
<body>
<div class="topbar">
  <div><h1>🌺 ORD 受注管理</h1>
  <span class="badge">Square: ${squareConfigured ? '実接続' : '未設定'}</span>
  <span class="badge">LINE: ${lineConfigured ? '実送信' : '未設定'}</span>
  <span class="badge" style="${lineWebhookSecurityConfigured ? '' : 'background:#c0392b;color:#fff;'}">LINE署名検証: ${lineWebhookSecurityConfigured ? '有効' : '未設定（要対応）'}</span></div>
  <div><button class="theme-toggle" onclick="toggleTheme()">🌓 表示切替</button> <a class="logout" href="/admin/logout">ログアウト</a></div>
</div>

${alerts.length ? `<div class="card full" style="border-color:#B3261E;"><h3>⚠️ 運営アラート</h3>${alertsHtml}</div>` : ''}

<div class="grid">
  <div class="card">
    <h3>📊 本日のKPI</h3>
    <p>本日注文数: <b>${kpi.todayOrderCount}</b>件　本日売上: <b>${yen(kpi.todayRevenue)}</b></p>
    <p>平均配達時間（全期間）: <b>${kpi.avgDeliveryMinutes != null ? kpi.avgDeliveryMinutes + '分' : '(データなし)'}</b></p>
    <p>ドライバー稼働率: <b>${kpi.driverUtilizationRate}%</b>（稼働中${kpi.busyDriverCount}/${kpi.totalDriverCount}名）</p>
    <p>加盟店ランキング（全期間売上順）:</p>
    <ul>${storeRankingRows || '<li>(データなし)</li>'}</ul>
  </div>

  <div class="card">
    <h3>💰 経営サマリー（完了注文ベース・概算）</h3>
    <p>完了注文数: <b>${rev.completedOrderCount}</b>件　総売上(GMV): <b>${yen(rev.grossAmount)}</b></p>
    <p>配送報酬支払(確定分): <b>${yen(rev.driverPayoutTotal)}</b>${rev.driverPayoutPendingCount > 0 ? `　<span style="color:#c0392b;">未確定${rev.driverPayoutPendingCount}件あり</span>` : ''}</p>
    <p>ORD粗利（40%上乗せベース）: <b style="color:var(--ocean);">${yen(rev.ordGrossProfit)}</b>${rev.ordGrossProfitPendingCount > 0 ? `　<span style="color:#c0392b;">算出不能${rev.ordGrossProfitPendingCount}件あり</span>` : ''}</p>
    <p style="font-size:12px;color:#888;">※加盟店手数料は0円が正式方針で、ORDの収益は顧客向け40%上乗せ分のみです。「算出不能」の注文は、商品マスター未接続の商品（旧priceCatalog.ts経由）が含まれるため利益を算出できず、0円ではなく件数のみ表示しています。</p>
  </div>

  <div class="card">
    <h3>📈 分析（売れ筋・時間帯・曜日・リピート率）</h3>
    <p>売れ筋ランキング:</p>
    ${topItemsHtml}
    <p style="margin-top:10px;">時間帯別注文数:</p>
    ${hourlyHtml}
    <p style="margin-top:10px;">曜日別注文数:</p>
    ${dowHtml}
    <p style="margin-top:10px;">リピート率: <b>${analytics.repeatRate}%</b>（${analytics.repeatGuests}/${analytics.totalGuests}組、ヴィラ名+部屋番号ベースの簡易集計）</p>
  </div>

  <div class="card">
    <h3>🗺️ 地図（加盟店・配送パートナー・お届け先の概況）</h3>
    <p>※Google Maps APIキー未設定のためOpenStreetMapを使用。エリア中心座標からの概算位置です（実際の正確な位置ではありません）</p>
    <div id="map"></div>
  </div>

  <div class="card">
    <h3>🏪 加盟店 登録</h3>
    <input id="store-name" placeholder="店舗名">
    <input id="store-line" placeholder="LINE User ID">
    <input id="store-area" placeholder="主なエリア 例:恩納村" style="width:130px;">
    <input id="store-username" placeholder="ログインID">
    <input id="store-password" type="password" placeholder="パスワード">
    <button onclick="createStore()">登録</button>
    <ul>${storeSettlementRows || '<li>(なし)</li>'}</ul>
  </div>

  <div class="card">
    <h3>🏨 宿泊施設マスタ</h3>
    <p>座標未設定の宿泊施設はcheckoutで選択できません（安全側でactive=0が初期値）。実住所・座標の登録・Google API連携は本画面の対象外です。</p>
    <ul>${accommodationRows || '<li>(なし)</li>'}</ul>
  </div>

  <div class="card">
    <h3>🛵 配送パートナー 登録</h3>
    <input id="driver-name" placeholder="ドライバー名">
    <input id="driver-line" placeholder="LINE User ID">
    <input id="driver-area" placeholder="主な稼働エリア 例:恩納村" style="width:150px;">
    <input id="driver-username" placeholder="ログインID">
    <input id="driver-password" type="password" placeholder="パスワード">
    <button onclick="createDriver()">登録</button>
    <ul>${driverSettlementRows || '<li>(なし)</li>'}</ul>
  </div>

  <div class="card">
    <h3>💬 LINE友だち追加：未割り当て一覧</h3>
    <p style="font-size:12px;color:#888;">加盟店・ドライバーがORD公式LINEを友だち追加すると、ここに表示されます。どの加盟店/ドライバーか選んで「割り当て」を押してください。</p>
    <ul>
    ${
      unassignedLineContacts.length === 0
        ? '<li>(未割り当ての連絡先はありません)</li>'
        : unassignedLineContacts
            .map(
              c => `<li>
        追加日時: ${c.followedAt.slice(0, 16).replace('T', ' ')}　userId: ${c.lineUserId.slice(0, 8)}...
        <select id="line-role-${c.id}" onchange="toggleLineAssignTarget(${c.id})">
          <option value="STORE">加盟店</option>
          <option value="DRIVER">ドライバー</option>
        </select>
        <select id="line-target-${c.id}">${storeOptions(null)}</select>
        <button onclick="assignLineContact(${c.id})">割り当て</button>
      </li>`
            )
            .join('')
    }
    </ul>
  </div>

  <div class="card">
    <h3>🎛 収益シミュレーター（実データ不要・想定値から試算）</h3>
    <p style="font-size:12px;color:#888;">※加盟店手数料は0円が正式方針です。ORDの収益は「商品上乗せ分」と「配送マージン（配送料-ドライバー報酬）」の2本立てで試算します。上乗せ率は加盟店ごとに異なりえます（ここではGAJIMARUの40%を仮定値として使用）。</p>
    <input id="sim-dailyOrders" placeholder="1日あたり注文数" value="20" style="width:150px;">
    <input id="sim-avgMerchantSalesValue" placeholder="注文あたり加盟店お支払額(円)" value="1800" style="width:190px;">
    <input id="sim-markupRate" placeholder="上乗せ率(%)" value="40" style="width:110px;">
    <input id="sim-avgDeliveryFee" placeholder="配送料/件(円)" value="500" style="width:130px;">
    <input id="sim-days" placeholder="日数" value="30" style="width:80px;">
    <input id="sim-driverPayout" placeholder="配送報酬/件(円、仮定値)" value="1000" style="width:130px;" title="正式な一律報酬ではなく中距離区分(31-50分)を仮定した試算値">
    <button onclick="runSimulator()">試算する</button>
    <p id="sim-result" style="white-space:pre-wrap;"></p>
  </div>
</div>

<div class="card full">
  <h3>📦 注文一覧</h3>
  <div class="table-scroll">
  <table>
  <tr><th>ID</th><th>ORD注文番号</th><th>Square注文ID</th><th>お届け先</th><th>商品</th><th>金額</th><th>状態</th><th>加盟店/ドライバー割当</th><th>操作</th></tr>
  ${rows || '<tr><td colspan="9">注文はまだありません（README.mdのcurlコマンドでテスト送信できます）</td></tr>'}
  </table>
  </div>
</div>

<div class="card full">
  <h3>📝 商品下書き</h3>
  <p>AI（今回未実装）または手動で作成された商品下書きです。承認すると、商品マスターへ正式なバージョンとして登録されます。</p>
  <div style="margin-bottom:10px;">
    <select id="draft-filter-store" onchange="filterDrafts()"><option value="">加盟店：すべて</option>${productDraftStoreFilterOptions}</select>
    <select id="draft-filter-status" onchange="filterDrafts()">
      <option value="">状態：すべて</option>
      <option value="DRAFT">下書き</option>
      <option value="NEEDS_REVIEW">要確認</option>
      <option value="APPROVED">承認済み</option>
      <option value="REJECTED">却下済み</option>
    </select>
    <select id="draft-filter-needs-review" onchange="filterDrafts()">
      <option value="">要確認：すべて</option>
      <option value="1">はい</option>
      <option value="0">いいえ</option>
    </select>
  </div>
  <div class="table-scroll">
  <table id="draft-table">
  <tr><th>ID</th><th>加盟店</th><th>商品名</th><th>英語名</th><th>加盟店価格</th><th>容器代</th><th>容器数</th><th>カテゴリ</th><th>上乗せ率</th><th>ORD価格</th><th>状態</th><th>要確認</th><th>AI信頼度</th><th>作成日時</th><th>操作</th></tr>
  ${productDraftRows || '<tr><td colspan="15">下書きはまだありません</td></tr>'}
  </table>
  </div>
</div>

<div class="card full">
  <h3>🗂 商品マスター（現行バージョン一覧）</h3>
  <div class="table-scroll">
  <table>
  <tr><th>商品キー（Product Key）</th><th>加盟店</th><th>バージョン</th><th>商品名</th><th>英語名</th><th>加盟店価格</th><th>容器代</th><th>上乗せ率</th><th>ORD価格</th><th>状態</th><th>五葷抜き</th><th>承認者</th><th>承認日時</th><th>カテゴリ</th><th>容器数</th><th>Square Catalog Item ID</th><th>操作</th></tr>
  ${productRows || '<tr><td colspan="17">承認済みの商品はまだありません</td></tr>'}
  </table>
  </div>
</div>

<div id="ord-modal-overlay" class="modal-overlay">
  <div class="modal-box">
    <div class="modal-header"><h3 id="ord-modal-title"></h3><span class="modal-close" onclick="closeModal()">✕</span></div>
    <div id="ord-modal-body"></div>
  </div>
</div>

<script>
const CURRENT_PRODUCTS = ${JSON.stringify(currentProducts)};
const ORD_STORES = ${JSON.stringify(stores.map(s => ({ id: s.id, name: s.name })))};
const ORD_DRIVERS = ${JSON.stringify(drivers.map(d => ({ id: d.id, name: d.name })))};
</script>
<script>
function toggleLineAssignTarget(contactId){
  const role = document.getElementById('line-role-'+contactId).value;
  const list = role === 'STORE' ? ORD_STORES : ORD_DRIVERS;
  const select = document.getElementById('line-target-'+contactId);
  select.innerHTML = list.map(x => '<option value="'+x.id+'">'+x.name+'</option>').join('');
}
async function assignLineContact(contactId){
  const role = document.getElementById('line-role-'+contactId).value;
  const targetId = Number(document.getElementById('line-target-'+contactId).value);
  const res = await fetch('/api/line-contacts/'+contactId+'/assign', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({role, targetId})});
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  location.reload();
}
async function createStore(){
  const name = document.getElementById('store-name').value;
  const lineUserId = document.getElementById('store-line').value;
  const area = document.getElementById('store-area').value;
  const username = document.getElementById('store-username').value;
  const password = document.getElementById('store-password').value;
  const res = await fetch('/api/stores', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name, lineUserId, area, username, password})});
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  location.reload();
}
async function toggleStoreActive(id, next){
  const res = await fetch('/api/stores/'+id+'/active', {method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({active: next})});
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  location.reload();
}
async function toggleGokunNuki(productKey, available){
  const res = await fetch('/api/products/'+productKey+'/gokun-nuki', {method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({available})});
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
}
async function toggleAccommodationActive(id, next){
  const res = await fetch('/api/accommodations/'+id+'/active', {method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({active: next})});
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  location.reload();
}
async function viewStoreSettlement(id){
  const res = await fetch('/api/stores/'+id+'/settlement');
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  const unresolvedNote = d.unresolvedLineItemCount > 0 ? ('\\n※商品マスター未接続の明細'+d.unresolvedLineItemCount+'件は含まれていません') : '';
  alert(d.storeName+' の精算\\n完了注文数: '+d.orderCount+'件\\n売上合計(配送料込み): ¥'+d.grossAmount.toLocaleString()+'\\n加盟店お支払額(商品代のみ): ¥'+d.netPayout.toLocaleString()+unresolvedNote);
}
async function viewDriverSettlement(id){
  const res = await fetch('/api/drivers/'+id+'/settlement');
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  const pendingNote = d.pendingDeliveryCount > 0 ? ('\\n※未確定'+d.pendingDeliveryCount+'件（注文ID: '+d.pendingOrderIds.join(',')+'）確認が必要です') : '';
  alert(d.driverName+' の精算\\n確定配達件数: '+d.confirmedDeliveryCount+'件\\n確定お支払額: ¥'+d.confirmedPayoutTotal.toLocaleString()+pendingNote);
}
async function runSimulator(){
  const params = new URLSearchParams({
    dailyOrders: document.getElementById('sim-dailyOrders').value,
    avgMerchantSalesValue: document.getElementById('sim-avgMerchantSalesValue').value,
    markupRate: String(Number(document.getElementById('sim-markupRate').value)/100),
    avgDeliveryFee: document.getElementById('sim-avgDeliveryFee').value,
    days: document.getElementById('sim-days').value,
    driverPayoutPerDelivery: document.getElementById('sim-driverPayout').value,
  });
  const res = await fetch('/api/revenue-simulator?'+params.toString());
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  document.getElementById('sim-result').textContent =
    '期間合計注文数: '+d.totalOrders.toLocaleString()+'件\\n'+
    '総売上(GMV・配送料込み): ¥'+d.grossGmv.toLocaleString()+'\\n'+
    '商品上乗せ粗利: ¥'+d.productGrossProfitTotal.toLocaleString()+'\\n'+
    '配送マージン(配送料-報酬): ¥'+d.deliveryGrossProfitTotal.toLocaleString()+'\\n'+
    '配送パートナー報酬支払(試算・仮定値ベース): ¥'+d.driverPayoutTotal.toLocaleString()+'\\n'+
    '　※'+d.assumptions.driverPayoutAssumption+'\\n'+
    '　※'+d.driverPayoutNote+'\\n'+
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
// ---------- STEP3: 商品マスター管理画面（Product Drafts / Product Master） ----------
function openModal(title, bodyHtml){
  document.getElementById('ord-modal-title').textContent = title;
  document.getElementById('ord-modal-body').innerHTML = bodyHtml;
  document.getElementById('ord-modal-overlay').classList.add('open');
}
function closeModal(){
  document.getElementById('ord-modal-overlay').classList.remove('open');
}
function filterDrafts(){
  const store = document.getElementById('draft-filter-store').value;
  const status = document.getElementById('draft-filter-status').value;
  const needsReview = document.getElementById('draft-filter-needs-review').value;
  document.querySelectorAll('#draft-table tr[data-store-id]').forEach(function(tr){
    const okStore = !store || tr.getAttribute('data-store-id') === store;
    const okStatus = !status || tr.getAttribute('data-status') === status;
    const okNeeds = !needsReview || tr.getAttribute('data-needs-review') === needsReview;
    tr.style.display = (okStore && okStatus && okNeeds) ? '' : 'none';
  });
}
function yenJs(n){ return n == null ? '-' : '¥' + Number(n).toLocaleString('ja-JP'); }
// 管理画面日本語化（3002テスト環境のみ）：APIが返す生のstatus値は変更せず、表示ラベルのみ日本語化する。
function draftStatusLabelJs(status){
  return ({DRAFT:'下書き', NEEDS_REVIEW:'要確認', APPROVED:'承認済み', REJECTED:'却下済み'})[status] || status;
}
// 商品マスター完成版：Backend側のCONTAINER_RULE_REFERENCE/detectContainerRuleInconsistency()と
// 同一の参考値・判定ロジックを表示専用に再現（実際の承認可否はBackendが最終判断する。
// このJS側の判定は「承認前にUI上で警告を出す」ための表示補助に過ぎない）。
const CONTAINER_RULE_REFERENCE_JS = {
  'ドリンク': {fee:0, count:0}, '通常フード': {fee:50, count:1}, 'ラーメン等': {fee:100, count:2}, 'カレー': {fee:100, count:2}
};
function detectContainerRuleInconsistencyJs(category, containerCount, containerFee){
  if(!category) return false;
  const ref = CONTAINER_RULE_REFERENCE_JS[category];
  if(!ref) return false;
  const feeMismatch = containerFee != null && containerFee !== ref.fee;
  const countMismatch = containerCount != null && containerCount !== ref.count;
  return feeMismatch || countMismatch;
}

async function viewDraft(id){
  const res = await fetch('/api/product-drafts/'+id);
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  const draft = d.draft;

  let sourceHtml = '<p>元資料の情報を取得できませんでした</p>';
  if (draft.sourceDocumentId){
    const docRes = await fetch('/api/menu-source-documents/'+draft.sourceDocumentId);
    const docData = await docRes.json();
    if (docData.ok){
      const doc = docData.document;
      sourceHtml =
        '<div class="field-row"><span>ファイル名</span><b>'+(doc.originalFilename || '(不明)')+'</b></div>'+
        '<div class="field-row"><span>ファイル形式（MIME Type）</span><b>'+(doc.mimeType || '-')+'</b></div>'+
        '<div class="field-row"><span>サイズ</span><b>'+(doc.fileSize != null ? doc.fileSize + ' bytes' : '-')+'</b></div>'+
        '<div class="field-row"><span>アップロード日時</span><b>'+doc.uploadedAt+'</b></div>'+
        '<div class="field-row"><span>アップロード者</span><b>'+(doc.uploadedBy || '-')+'</b></div>'+
        '<div class="field-row"><span>ファイルハッシュ</span><b style="word-break:break-all;">'+(doc.fileHash || '-')+'</b></div>';
    } else {
      sourceHtml = '<p>元資料の情報を取得できませんでした</p>';
    }
  }

  const canDecide = draft.status === 'DRAFT' || draft.status === 'NEEDS_REVIEW';
  const containerInconsistent = detectContainerRuleInconsistencyJs(draft.extractedCategory, draft.extractedContainerCount, draft.extractedContainerFee);
  const storeProducts = CURRENT_PRODUCTS.filter(function(p){ return p.storeId === draft.storeId; });
  const existingOptions = storeProducts.map(function(p){
    return '<option value="'+p.productKey+'">'+p.productKey+' — '+p.name+' (v'+p.version+', '+yenJs(p.ordPrice)+')</option>';
  }).join('');

  const inconsistencyWarningHtml = containerInconsistent
    ? '<div class="notice-box" style="border-color:#B3261E;color:#B3261E;">⚠️ 容器代・容器数がカテゴリ「'+draft.extractedCategory+'」の基準（'+
      'ドリンク:¥0/0個、通常フード:¥50/1個、ラーメン等:¥100/2個、カレー:¥100/2個'+
      '）と一致しません。承認する前に値を確認・修正してください。</div>'
    : '';

  const approveSectionHtml = containerInconsistent
    ? '<div class="modal-section"><h4>承認</h4><div class="notice-box" style="border-color:#B3261E;color:#B3261E;">⚠️ 容器代・容器数の不整合が解消されるまで承認できません（Backend側でも400エラーとして拒否されます）。</div></div>'
    : '<div class="modal-section"><h4>承認</h4>'+
      '<label style="display:block;font-size:12.5px;margin:4px 0;"><input type="radio" name="approve-mode-'+id+'" value="new" checked onchange="toggleApproveMode('+id+')"> 新商品として登録</label>'+
      '<label style="display:block;font-size:12.5px;margin:4px 0;"><input type="radio" name="approve-mode-'+id+'" value="existing" onchange="toggleApproveMode('+id+')" '+(storeProducts.length===0?'disabled':'')+'> 既存商品を更新'+(storeProducts.length===0?'（この加盟店には既存商品がありません）':'')+'</label>'+
      '<div id="approve-existing-'+id+'" style="display:none;margin-top:8px;"><select id="approve-existing-select-'+id+'">'+existingOptions+'</select></div>'+
      '<button style="margin-top:10px;" onclick="approveDraft('+id+')">承認</button>'+
      '</div>';

  const decideHtml = canDecide ? (
    approveSectionHtml+
    '<div class="modal-section"><h4>却下</h4>'+
    '<textarea id="reject-reason-'+id+'" rows="2" placeholder="却下理由（任意）"></textarea>'+
    '<button class="secondary" style="margin-top:8px;" onclick="rejectDraft('+id+')">却下</button>'+
    '</div>'
  ) : '<div class="modal-section"><p>この下書きは既に'+draftStatusLabelJs(draft.status)+'状態のため、承認・却下できません。</p></div>';

  const body =
    '<div class="modal-section"><h4>原本情報</h4>'+
    '<div class="field-row"><span>元資料ID（source_document_id）</span><b>'+(draft.sourceDocumentId ?? '(なし)')+'</b></div>'+
    sourceHtml+
    '</div>'+
    '<div class="modal-section"><h4>抽出された商品情報</h4>'+
    '<div class="field-row"><span>商品名</span><b>'+(draft.extractedName || '(未設定)')+'</b></div>'+
    '<div class="field-row"><span>英語名</span><b>'+(draft.extractedNameEn || '-')+'</b></div>'+
    '<div class="field-row"><span>説明</span><b>'+(draft.extractedDescription || '-')+'</b></div>'+
    '<div class="field-row"><span>英語説明</span><b>'+(draft.extractedDescriptionEn || '-')+'</b></div>'+
    '</div>'+
    '<div class="modal-section"><h4>ORD価格情報（価格根拠を一目で確認）</h4>'+
    '<div class="field-row"><span>加盟店価格</span><b>'+yenJs(draft.extractedMerchantPrice)+'</b></div>'+
    '<div class="field-row"><span>容器代</span><b>'+yenJs(draft.extractedContainerFee)+'</b></div>'+
    '<div class="field-row"><span>容器数</span><b>'+(draft.extractedContainerCount ?? '-')+'</b></div>'+
    '<div class="field-row"><span>カテゴリ</span><b>'+(draft.extractedCategory || '-')+'</b></div>'+
    '<div class="field-row"><span>上乗せ率</span><b>'+(draft.markupRate != null ? Math.round(draft.markupRate*100)+'%' : '-')+'</b></div>'+
    '<div class="field-row"><span>ORD価格（下書き・参考値）</span><b>'+yenJs(draft.computedOrdPrice)+'</b></div>'+
    '<div class="field-row"><span>計算根拠</span><b>'+(draft.calculationBasis || '-')+'</b></div>'+
    '<div class="notice-box">⚠️ ここに表示されているORD価格は参考値です。承認時に、バックエンドが加盟店価格・容器代・上乗せ率から価格を再計算します。再計算された価格のみが正式なORD価格として登録されます。</div>'+
    inconsistencyWarningHtml+
    '</div>'+
    '<div class="modal-section"><h4>AI / 確認状況</h4>'+
    '<div class="field-row"><span>AI信頼度</span><b>'+(draft.confidence ?? '-')+'</b></div>'+
    '<div class="field-row"><span>要確認</span><b>'+(draft.needsReview ? 'はい' : 'いいえ')+'</b></div>'+
    '<div class="field-row"><span>状態</span><b>'+draftStatusLabelJs(draft.status)+'</b></div>'+
    (draft.rejectionReason ? '<div class="field-row"><span>却下理由</span><b>'+draft.rejectionReason+'</b></div>' : '')+
    '</div>'+
    decideHtml;

  openModal('商品下書き #'+id, body);
}

function toggleApproveMode(id){
  const mode = document.querySelector('input[name="approve-mode-'+id+'"]:checked').value;
  document.getElementById('approve-existing-'+id).style.display = mode === 'existing' ? 'block' : 'none';
}

async function approveDraft(id){
  const modeInput = document.querySelector('input[name="approve-mode-'+id+'"]:checked');
  const mode = modeInput ? modeInput.value : 'new';
  let productKey = null;
  if (mode === 'existing'){
    const sel = document.getElementById('approve-existing-select-'+id);
    if (!sel || !sel.value){ alert('既存商品を選択してください。'); return; }
    productKey = sel.value;
  }
  const confirmMsg = mode === 'existing'
    ? 'この下書きは、選択した既存商品の新しいバージョンとして登録されます。\\n現在のバージョンは履歴として保持されます。\\n続行しますか？'
    : 'この下書きは、新しい有効な商品（Version 1）として登録されます。\\n続行しますか？';
  if (!confirm(confirmMsg)) return;
  const res = await fetch('/api/product-drafts/'+id+'/approve', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(mode === 'existing' ? {product_key: productKey} : {}),
  });
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  alert('承認しました。商品「'+d.product.productKey+'」のバージョン'+d.product.version+'が有効になりました。');
  closeModal();
  location.reload();
}

async function rejectDraft(id){
  const reason = document.getElementById('reject-reason-'+id).value;
  const res = await fetch('/api/product-drafts/'+id+'/reject', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({rejection_reason: reason}),
  });
  const d = await res.json();
  if(!d.ok){ alert('エラー: '+d.error); return; }
  alert('却下しました。');
  closeModal();
  location.reload();
}

async function viewVersionHistory(productKey){
  const res = await fetch('/api/products/'+encodeURIComponent(productKey)+'/versions');
  const versions = await res.json();
  const body = versions.map(function(v){
    return '<div class="modal-section">'+
      '<div class="field-row"><span>バージョン</span><b>'+v.version+' '+(v.supersededAt ? '（過去バージョン）' : '（現行バージョン）')+'</b></div>'+
      '<div class="field-row"><span>加盟店価格</span><b>'+yenJs(v.merchantPrice)+'</b></div>'+
      '<div class="field-row"><span>容器代</span><b>'+yenJs(v.containerFee)+'</b></div>'+
      '<div class="field-row"><span>上乗せ率</span><b>'+(v.markupRate != null ? Math.round(v.markupRate*100)+'%' : '-')+'</b></div>'+
      '<div class="field-row"><span>ORD価格</span><b>'+yenJs(v.ordPrice)+'</b></div>'+
      '<div class="field-row"><span>承認者</span><b>'+(v.approvedBy || '-')+'</b></div>'+
      '<div class="field-row"><span>承認日時</span><b>'+(v.approvedAt || '-')+'</b></div>'+
      '<div class="field-row"><span>元Draft ID（Source Draft ID）</span><b>'+(v.sourceDraftId ?? '-')+'</b></div>'+
      '<div class="field-row"><span>カテゴリ</span><b>'+(v.category || '-')+'</b></div>'+
      '<div class="field-row"><span>容器数</span><b>'+(v.containerCount ?? '-')+'</b></div>'+
      '<div class="field-row"><span>Square Catalog Item ID</span><b>'+(v.squareCatalogItemId || '-')+'</b></div>'+
      '<div class="field-row"><span>置き換えられた日時</span><b>'+(v.supersededAt || '-')+'</b></div>'+
      '</div>';
  }).join('') || '<p>バージョン履歴がありません。</p>';
  openModal('バージョン履歴：'+productKey, body);
}

function toggleTheme(){
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('ord_admin_theme', next); } catch(e) {}
}
(function initTheme(){
  try {
    const saved = localStorage.getItem('ord_admin_theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    else if (window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.setAttribute('data-theme', 'dark');
  } catch(e) {}
})();
</script>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function initMap(){
  const points = ${mapDataJson};
  if (!points.length || !window.L) return;
  const map = L.map('map').setView([points[0].lat, points[0].lng], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);
  const colors = { store: '#C9A15A', driver: '#0086A8', order: '#2E9E6B' };
  const icons = { store: '🏪', driver: '🛵', order: '📦' };
  points.forEach(p => {
    L.circleMarker([p.lat, p.lng], { radius: 9, color: colors[p.kind], fillColor: colors[p.kind], fillOpacity: 0.85 })
      .addTo(map)
      .bindPopup(icons[p.kind] + ' ' + p.name + '（' + p.detail + '）');
  });
})();
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
          { type: 'text', text: `ORD注文番号: ${order.displayNo || '(未設定)'}`, size: 'xs', color: '#888888' },
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
          { type: 'text', text: `ORD注文番号: ${order.displayNo || '(未設定)'}`, size: 'xs', color: '#888888' },
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

  // 安全ガード：管理画面が「手配開始」ボタンを表示するのはstatus==='RECEIVED'の注文のみ（既存仕様）。
  // API自体にも同じ条件を課し、それ以外の状態の注文はAPIを直接呼び出されても
  // 加盟店・ドライバーへの通知やステータス更新を一切実行しないようにする。
  // さらに、決済が確定していない(paymentStatus!=='COMPLETED')注文は、たとえOrder Statusが
  // RECEIVEDであっても手配してはならない（決済前安全基盤、STEP2-C-3）。
  if (order.status !== 'RECEIVED') {
    return res.status(409).json({ ok: false, error: `この注文は現在「${order.status}」状態のため手配できません（手配可能なのはRECEIVEDの注文のみです）` });
  }
  if (order.paymentStatus !== 'COMPLETED') {
    return res.status(409).json({ ok: false, error: `この注文は決済が確定していません（決済状態: ${order.paymentStatus}）。決済確定後に手配してください。` });
  }

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

    // 【STEP C-2 Stage 3・2026-09-22社長承認】遠方出動ボーナスをここで確定する。
    // ドライバー拠点・店舗いずれかの座標が未確定の場合は、推測せずnullのまま保存する。
    if (driver.baseLatitude !== null && driver.baseLongitude !== null && store.latitude !== null && store.longitude !== null) {
      const driverBase: LatLng = { latitude: driver.baseLatitude, longitude: driver.baseLongitude };
      const storeLocation: LatLng = { latitude: store.latitude, longitude: store.longitude };
      const [dispatchPricing] = await resolveDriverToRestaurantPricing(db, [driverBase], storeLocation);
      const remoteDispatchBonus =
        dispatchPricing.mapsStatus === 'SUCCESS' && !dispatchPricing.remoteDispatchBonus.isConsultation
          ? dispatchPricing.remoteDispatchBonus.amount
          : null;
      updateOrderRemoteDispatchBonus(order.id, remoteDispatchBonus);
    } else {
      console.warn(`[手配API] ドライバー#${driver.id}または店舗#${store.id}の拠点座標が未登録のため、遠方出動ボーナスを算出できませんでした（注文#${order.id}）`);
    }
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
// ============================================================
// 【STEP・2026-09-23社長承認】LINE友だち追加(follow)受付
// 加盟店・ドライバーはGoogleフォーム経由で先に登録されるため、LINEのfollowイベントだけでは
// 「どの加盟店/ドライバーか」を自動判定できない（推測しない）。友だち追加されたuserIdは
// いったん未割り当てのまま保管し、管理画面から手動でstores/driversに割り当てる。
// ============================================================
interface LineContactRow {
  id: number;
  line_user_id: string;
  followed_at: string;
  assigned_role: string | null;
  assigned_id: number | null;
  assigned_at: string | null;
}
interface LineContact {
  id: number;
  lineUserId: string;
  followedAt: string;
  assignedRole: string | null;
  assignedId: number | null;
  assignedAt: string | null;
}
const rowToLineContact = (r: LineContactRow): LineContact => ({
  id: r.id,
  lineUserId: r.line_user_id,
  followedAt: r.followed_at,
  assignedRole: r.assigned_role,
  assignedId: r.assigned_id,
  assignedAt: r.assigned_at,
});
function recordLineFollow(lineUserId: string): void {
  const existing = db.prepare('SELECT id FROM line_contacts WHERE line_user_id = ?').get(lineUserId);
  if (existing) return; // 既知のuserIdは再登録しない（再フォロー時の重複防止）
  db.prepare('INSERT INTO line_contacts (line_user_id, followed_at) VALUES (?, ?)').run(lineUserId, new Date().toISOString());
}
function getUnassignedLineContacts(): LineContact[] {
  return (
    db.prepare('SELECT * FROM line_contacts WHERE assigned_role IS NULL ORDER BY followed_at DESC').all() as unknown as LineContactRow[]
  ).map(rowToLineContact);
}
function getLineContactById(id: number): LineContact | undefined {
  const row = db.prepare('SELECT * FROM line_contacts WHERE id = ?').get(id) as LineContactRow | undefined;
  return row ? rowToLineContact(row) : undefined;
}
// 割り当てと同時に、対象のstores/drivers.line_user_idを実際に更新する（ここが一番重要）。
function assignLineContact(contactId: number, role: 'STORE' | 'DRIVER', targetId: number): void {
  const contact = getLineContactById(contactId);
  if (!contact) throw new Error(`line_contact id=${contactId} が見つかりません`);
  if (contact.assignedRole) throw new Error('この連絡先は既に割り当て済みです');

  runInTransaction(() => {
    if (role === 'STORE') {
      if (!getStoreById(targetId)) throw new Error(`store id=${targetId} が見つかりません`);
      db.prepare('UPDATE stores SET line_user_id = ? WHERE id = ?').run(contact.lineUserId, targetId);
    } else {
      if (!getDriverById(targetId)) throw new Error(`driver id=${targetId} が見つかりません`);
      db.prepare('UPDATE drivers SET line_user_id = ? WHERE id = ?').run(contact.lineUserId, targetId);
    }
    db.prepare('UPDATE line_contacts SET assigned_role = ?, assigned_id = ?, assigned_at = ? WHERE id = ?').run(
      role,
      targetId,
      new Date().toISOString(),
      contactId
    );
  });
}

app.get('/api/line-contacts/unassigned', requireAuth('ADMIN'), (_req: Request, res: Response) => {
  res.json({ ok: true, contacts: getUnassignedLineContacts() });
});

app.post('/api/line-contacts/:id/assign', requireAuth('ADMIN'), (req: Request, res: Response) => {
  const contactId = Number(req.params.id);
  const { role, targetId } = req.body as { role?: string; targetId?: number };
  if (role !== 'STORE' && role !== 'DRIVER') {
    return res.status(400).json({ ok: false, error: 'roleはSTOREまたはDRIVERを指定してください' });
  }
  if (!Number.isInteger(targetId) || (targetId as number) <= 0) {
    return res.status(400).json({ ok: false, error: 'targetIdは正の整数で指定してください' });
  }
  try {
    assignLineContact(contactId, role, targetId as number);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

interface MockPostbackEvent {
  type: string;
  postback?: { data: string };
  source?: { userId?: string };
}

app.post('/webhooks/line', (req: Request, res: Response) => {
  // 【2026-09-23追加】x-line-signature検証（express.json({verify:captureRawBody})が
  // 既にreq.rawBodyへ生バイト列を保持済み、Square Webhookと同じ基盤をそのまま利用）。
  // LINE_CHANNEL_SECRET未設定の間（ローカル開発・テスト用）は検証をスキップし警告のみ出す。
  // 設定済みなのに検証に失敗した場合は401で即座に拒否し、以降の処理を一切行わない。
  if (lineWebhookSecurityConfigured) {
    const signatureHeader = req.header('x-line-signature');
    if (!req.rawBody || !signatureHeader || !validateLineSignature(req.rawBody, LINE_CHANNEL_SECRET, signatureHeader)) {
      console.error('[LINE Webhook] 署名検証に失敗したため処理を拒否しました');
      return res.status(401).send('Invalid signature');
    }
  } else {
    console.warn('[LINE Webhook] LINE_CHANNEL_SECRET未設定のため署名検証をスキップしています（本番投入前に必ず設定すること）');
  }

  const events: MockPostbackEvent[] = req.body?.events || [];
  events.forEach(ev => {
    if (ev.type === 'follow' && ev.source?.userId) {
      console.log('[LINE友だち追加受信]', ev.source.userId);
      recordLineFollow(ev.source.userId);
      return;
    }
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

// 【2026-09-20】テストからExpress appを直接利用できるようにする（ORD_SKIP_LISTEN環境変数）。
// 未設定時の既存動作（起動時に自動でlistenする、本番相当の実行方法）は変更しない。
// テスト側でORD_SKIP_LISTEN='true'を指定し、importしたappに対して自分でlisten()する。
if (process.env.ORD_SKIP_LISTEN !== 'true') {
  app.listen(PORT, () => {
    console.log(`ORD backend (TypeScript) listening on http://localhost:${PORT}`);
    console.log(`管理画面: http://localhost:${PORT}/admin`);
    console.log(`Square連携: ${squareConfigured ? '実接続' : '未設定（Webhookペイロードのデータのみ使用）'}`);
    console.log(`LINE連携: ${lineConfigured ? '実送信' : '未設定（コンソールログのみ）'}`);
    console.log(`LINE Webhook署名検証: ${lineWebhookSecurityConfigured ? '有効' : '未設定（本番投入前に必ずLINE_CHANNEL_SECRETを設定すること）'}`);
  });
}

export { app };
