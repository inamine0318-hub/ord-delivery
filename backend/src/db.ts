// ============================================================
// SQLite永続化層（Node.js標準の node:sqlite を使用。追加のネイティブ依存なし）
// サーバー再起動でも注文・加盟店・配送パートナー・管理者アカウントが消えないようにする。
// 【本番投入時の備考】アクセス集中・複数プロセスでのスケールが必要になった場合は
// PostgreSQL等への移行を検討すること（テーブル構造はそのまま概ね流用可能な設計）。
// ============================================================
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'ord.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    line_user_id TEXT NOT NULL,
    commission_rate REAL NOT NULL DEFAULT 0,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    area TEXT NOT NULL DEFAULT '恩納村'
  );

  CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    line_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'IDLE',
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    area TEXT NOT NULL DEFAULT '恩納村'
  );

  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    square_order_id TEXT NOT NULL,
    items_json TEXT NOT NULL,
    villa_name TEXT NOT NULL,
    room_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'RECEIVED',
    store_id INTEGER,
    driver_id INTEGER,
    created_at TEXT NOT NULL,
    customer_line_id TEXT,
    total_money_json TEXT,
    area TEXT,
    completed_at TEXT,
    display_no TEXT,
    payment_status TEXT DEFAULT 'PENDING',
    payment_attempt_no INTEGER DEFAULT 1,
    payment_link_id TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS processed_webhook_events (
    event_id TEXT PRIMARY KEY,
    processed_at TEXT NOT NULL
  );

  -- 料金ルール設定（STEP2-D-1）。配送料・最低注文額・ドライバー報酬・遠隔ドライバーボーナスの
  -- 金額をコード変更なしで調整できるよう、設定値としてDBに保持する。
  -- 区間の意味は「range_min を"超え"、range_max "以下"」（下限exclusive・上限inclusive）で統一。
  -- range_min が NULL の行は「下限なし＝0以上を含む」、range_max が NULL の行は上限なし
  -- （=is_consultation=1、自動価格を出さず「要相談」として扱う区間）を意味する。
  -- 【最重要・境界値の誤判定防止】「0分」「0km」を含む最初の区間を表現する際は、
  -- range_min に数値の 0 を入れてはならない。0を入れると「0を超える」という意味になり
  -- (value > 0)、ちょうど0分・0kmが範囲外に落ちてしまう。必ず range_min = NULL を使うこと
  -- （NULL は「value > NULL」という比較をせず「下限チェックなし＝常に真」として扱う設計）。
  -- 例：0～20分は range_min=NULL, range_max=20（0分・20分をどちらも含む）。
  --     21～30分は range_min=20, range_max=30（20分は含まない＝前の区間、30分は含む）。
  --     5km以下は range_min=NULL, range_max=5（0km・5kmをどちらも含む）。
  --     5km超～10km以下は range_min=5, range_max=10（5kmは含まない＝前の区間、10kmは含む）。
  -- STEP2-D-2で料金判定ロジックを実装する際は、この規約（value > range_min かつ
  -- value <= range_max、range_min===NULLなら下限チェック省略）をそのまま使用すること。
  -- 【重要】このテーブルはSTEP2-D-1時点では定義・シードのみ。実際の料金計算ロジックへの
  -- 接続（このテーブルを参照して金額を決定する処理）はSTEP2-D-2で実装する。
  CREATE TABLE IF NOT EXISTS pricing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_type TEXT NOT NULL, -- 'DELIVERY_FEE' | 'MINIMUM_ORDER' | 'DRIVER_REWARD' | 'REMOTE_DISPATCH_BONUS'
    unit TEXT NOT NULL, -- 'MINUTES'(店舗→顧客の実走行時間) | 'KM'(ドライバー拠点→店舗の距離)
    range_min REAL,
    range_max REAL,
    amount INTEGER,
    is_consultation INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 宿泊施設マスター（STEP2-D-3-B）。ホテル・ヴィラ等を種別問わず統一管理する汎用マスター
  -- （STEP2-D-3設計確認で「hotels」という名称は不採用と確定済み）。
  -- idはindex.html側のHOTELS配列のid('h1'〜'h10')とそのまま対応させる（将来の一本化を見据えた設計）。
  -- latitude/longitudeは「その施設の代表配送地点」（正面玄関・フロント等）を意味し、
  -- 部屋そのものの座標ではない。部屋番号は既存のorders.room_numberで別途管理する。
  -- activeは「顧客側で利用可能な宿泊施設かどうか」を表す運用フラグ。
  -- 【重要】座標未確定（address/latitude/longitudeのいずれかがNULL）の間はactive=0で登録する
  -- （座標未確定の施設を顧客の注文選択肢に出さないための安全ゲート、STEP2-D-3-A確定事項）。
  -- ただし active=0 は必ずしも「座標未確定」だけを意味するわけではなく、座標確定後も
  -- 運用上の理由で意図的にinactiveにできる（active単体では理由まで区別しない設計。
  -- 理由の区別が必要になった場合は将来別途状態列を検討する）。
  CREATE TABLE IF NOT EXISTS accommodations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    area TEXT NOT NULL,
    address TEXT,
    latitude REAL,
    longitude REAL,
    location_source TEXT DEFAULT 'MANUAL',
    location_updated_at TEXT,
    active INTEGER NOT NULL DEFAULT 0
  );

  -- ============================================================
  -- 商品マスター基盤 STEP1（原本管理・AI下書き・正式商品version）。
  -- 【重要】今回はDB基盤のみ。AI抽出処理・checkoutの参照先切替・index.html切替・
  -- 既存30商品の移行はいずれも行わない（priceCatalog.ts/index.htmlのSTORES配列が
  -- 引き続き唯一の参照元であり、この3テーブルはまだどこからも読み書きされない）。
  -- store_idはstores.idとの「アプリケーション上の関連」として扱い、既存方針
  -- （stores.id/catalog_store_idの分離、FK制約を追加しない方針）をそのまま踏襲する。
  -- ============================================================

  -- 加盟店から提出された正規メニュー原本の追跡台帳。
  -- 原本ファイルの実体（画像/PDF/Excel）はSQLiteに格納せず、file_referenceで参照するのみ。
  -- file_hashにより「同じ原本の再アップロードか、新しい版か」を後から判定できるようにする。
  -- 物理削除APIは今回もこの先も作らない（原本の追跡台帳は消えてはならない）。
  CREATE TABLE IF NOT EXISTS menu_source_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL,
    file_reference TEXT NOT NULL,
    original_filename TEXT,
    mime_type TEXT,
    file_size INTEGER,
    file_hash TEXT,
    uploaded_at TEXT NOT NULL,
    uploaded_by TEXT,
    notes TEXT
  );

  -- AIが将来作成する下書き領域（今回はAI処理自体を実装しない。テーブルのみ用意する）。
  -- statusはDRAFT/NEEDS_REVIEW/APPROVED/REJECTEDを扱う想定（DB側にCHECK制約は設けない。
  -- 既存のOrderStatus/PaymentStatus等と同じく、値の妥当性検証はアプリケーション側の責務とする）。
  -- 「画像から価格が読み取れない」等の場合にAIが推測で確定させないための安全弁として、
  -- needs_reviewフラグとconfidence（確信度）を分けて保持する。
  CREATE TABLE IF NOT EXISTS product_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_document_id INTEGER,
    store_id INTEGER NOT NULL,
    extracted_name TEXT,
    extracted_name_en TEXT,
    extracted_description TEXT,
    extracted_description_en TEXT,
    extracted_merchant_price INTEGER,
    extracted_container_fee INTEGER,
    markup_rate REAL,
    computed_ord_price INTEGER,
    calculation_basis TEXT,
    confidence REAL,
    needs_review INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- ORDの正式商品マスター（version方式）。
  -- 【最重要】価格・名称・説明の変更は既存rowのUPDATEでは絶対に行わない。新しいversionを
  -- 新規INSERTし、置き換えられた旧versionはsuperseded_atを設定するだけで物理削除しない
  -- （orders.accommodation_latitude等、既存の「注文時点の値をスナップショットし、マスター
  -- 変更の影響を受けない」という設計思想と同じ考え方を商品マスターにも適用したもの）。
  -- product_keyは同一商品の全versionに共通する識別子（store_idやproduct_idとは別軸）。
  -- calculation_basisには "(1700 + 100) * 1.4" のような計算根拠の文字列を保存し、
  -- merchant_price/container_fee/markup_rateの各値と併せて後から検算できるようにする。
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_key TEXT NOT NULL,
    store_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    name_en TEXT,
    description TEXT,
    description_en TEXT,
    merchant_price INTEGER,
    container_fee INTEGER,
    markup_rate REAL,
    ord_price INTEGER NOT NULL,
    image_reference TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    source_draft_id INTEGER,
    approved_by TEXT,
    approved_at TEXT,
    created_at TEXT NOT NULL,
    superseded_at TEXT
  );

  -- 【2026-09-23・STEP C-2 Stage 6・社長承認】backend-uitestから移植。
  -- 注文明細のVersion価格スナップショット（商品マスター未接続の明細はNULLのまま保存）。
  CREATE TABLE IF NOT EXISTS order_line_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_key TEXT,
    product_version INTEGER,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    merchant_price INTEGER,
    container_fee INTEGER,
    markup_rate REAL,
    ord_price_unit INTEGER,
    created_at TEXT NOT NULL
  );

  -- 【2026-09-24・社長承認・本番反映】商品の選択肢／追加オプションの汎用構造。
  -- 「Organic Sodaだけ」「Coffeeだけ」のような個別ハードコードを避け、どの加盟店・商品でも
  -- 使い回せる形にする。1商品に複数グループ、1グループに複数選択肢を持てる。
  -- group_type='FLAVOR'（単一選択・追加料金なし想定）／'ADDON'（複数選択可・price_deltaあり）。
  -- backend-uitestで実装・検証済みの内容をそのまま反映。
  CREATE TABLE IF NOT EXISTS product_option_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_key TEXT NOT NULL,
    group_type TEXT NOT NULL, -- 'FLAVOR' | 'ADDON'
    label TEXT NOT NULL,
    label_en TEXT,
    selection_type TEXT NOT NULL, -- 'SINGLE' | 'MULTI'
    required INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS product_option_choices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    label_en TEXT,
    price_delta INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (group_id) REFERENCES product_option_groups(id)
  );

  -- 精算バッチ（加盟店・ドライバー共通）。amountは作成時に一度だけ確定し、以後の
  -- status変更では絶対に再計算・更新しない（advanceSettlementStatus()で強制）。
  CREATE TABLE IF NOT EXISTS settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payee_type TEXT NOT NULL, -- 'STORE' | 'DRIVER'
    payee_id INTEGER NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'UNSETTLED', -- UNSETTLED→CONFIRMED→READY_FOR_PAYMENT→PAID→VERIFIED（一方向のみ）
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    paid_at TEXT,
    paid_by TEXT,
    transfer_reference TEXT,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS settlement_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    order_line_item_id INTEGER,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  -- 【2026-09-23・社長承認】LINE公式アカウントを友だち追加した際に届くuserIdを一時保管する。
  -- 加盟店・ドライバーはフォーム経由で先に登録されるため（Googleスプレッドシート側）、
  -- どのLINEユーザーがどの加盟店/ドライバーかは自動判定できない。管理画面から手動で
  -- 割り当てるまでは未割り当てのまま一覧表示する。
  CREATE TABLE IF NOT EXISTS line_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT NOT NULL UNIQUE,
    followed_at TEXT NOT NULL,
    assigned_role TEXT, -- 'STORE' | 'DRIVER'
    assigned_id INTEGER,
    assigned_at TEXT
  );
`);

// 商品マスター基盤STEP1のindex。
// menu_source_documents: store別の原本一覧取得、file_hashによる重複/再アップロード判定を高速化。
db.exec('CREATE INDEX IF NOT EXISTS idx_menu_source_documents_store_id ON menu_source_documents(store_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_menu_source_documents_file_hash ON menu_source_documents(file_hash)');
// product_drafts: 原本1件に紐づく下書き一覧の取得を高速化。
db.exec('CREATE INDEX IF NOT EXISTS idx_product_drafts_source_document_id ON product_drafts(source_document_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_product_drafts_store_id ON product_drafts(store_id)');
// products: 同一product_keyの全version検索を高速化。
db.exec('CREATE INDEX IF NOT EXISTS idx_products_product_key ON products(product_key)');
db.exec('CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id)');
// 【重要】1つのproduct_keyにつき「現在有効なversion(superseded_at IS NULL)」は常に1件のみに
// なるべきという業務ルールを、既存のidx_stores_catalog_store_idと同じ部分UNIQUE INDEXの
// 手法でDBレベルでも保証する（アプリケーション側のバグで同時に2件の「最新版」が
// できてしまうことを防ぐ安全弁。将来のversion追加ロジックは、新versionをINSERTする前に
// 必ず旧versionのsuperseded_atを設定するトランザクションにすること）。
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_products_current_version ON products(product_key) WHERE superseded_at IS NULL'
);
// 商品マスター基盤STEP2：同一product_key + versionの重複を防止する（例：P007のVersion1が
// 誤って2回INSERTされることをDBレベルで防ぐ）。STEP1時点ではproductsに実データが
// 存在しない（0件）ため、既存データへの影響はない。
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_products_key_version ON products(product_key, version)');

// 【2026-09-23・STEP C-2 Stage 6】精算基盤のindex（backend-uitestから移植）。
db.exec('CREATE INDEX IF NOT EXISTS idx_settlements_payee ON settlements(payee_type, payee_id)');
// 【重要】同一payee_type/payee_id/period_start/period_endの精算をDBレベルで重複作成禁止
// （社長承認済み。同一期間を2回集計しても2件目はDB制約で拒否される）。
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_unique_period ON settlements(payee_type, payee_id, period_start, period_end)'
);
db.exec('CREATE INDEX IF NOT EXISTS idx_settlement_items_settlement_id ON settlement_items(settlement_id)');
// 【最重要・二重振込防止】同一order_line_item（加盟店精算）・同一order_id(ドライバー精算)が
// 複数のsettlementに計上されることをDBレベルで禁止する（部分UNIQUE INDEX）。
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_items_line_once ON settlement_items(order_line_item_id) WHERE order_line_item_id IS NOT NULL'
);
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_items_driver_order_once ON settlement_items(order_id) WHERE order_line_item_id IS NULL'
);

// 既存DBに新しいカラムを安全に追加する簡易マイグレーション（テーブルごと作り直さない）
function ensureColumn(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('stores', 'area', "TEXT NOT NULL DEFAULT '恩納村'");
ensureColumn('drivers', 'area', "TEXT NOT NULL DEFAULT '恩納村'");
ensureColumn('orders', 'area', 'TEXT');
ensureColumn('orders', 'completed_at', 'TEXT');
ensureColumn('orders', 'display_no', 'TEXT');
ensureColumn('orders', 'payment_status', "TEXT DEFAULT 'PENDING'");
ensureColumn('orders', 'payment_attempt_no', 'INTEGER DEFAULT 1');
ensureColumn('orders', 'payment_link_id', "TEXT DEFAULT ''");
// STEP2-D-1: 料金ルール計算結果を注文ごとに保存する列（すべてNULL許容。
// 計算ロジック自体はSTEP2-D-2以降で実装するため、STEP2-D-1時点では常にNULLのまま）。
ensureColumn('orders', 'delivery_time_minutes', 'INTEGER');
ensureColumn('orders', 'delivery_fee', 'INTEGER');
ensureColumn('orders', 'minimum_order_amount', 'INTEGER');
ensureColumn('orders', 'driver_reward', 'INTEGER');
ensureColumn('orders', 'remote_dispatch_bonus', 'INTEGER');
ensureColumn('orders', 'estimated_ord_profit', 'INTEGER');

// STEP2-D-3-B: 位置情報データ基盤（すべてNULL許容。Google Maps API接続・料金ロジックへの
// 接続は別STEPで行うため、今回追加した列に既存データへの値投入は一切行わない）。
ensureColumn('stores', 'address', 'TEXT');
ensureColumn('stores', 'latitude', 'REAL');
ensureColumn('stores', 'longitude', 'REAL');
ensureColumn('stores', 'location_source', 'TEXT');
ensureColumn('stores', 'location_updated_at', 'TEXT');

// Phase B: ORD側の業務上の店舗識別子（priceCatalog.tsのstoreId、例:'s1'）とSQLite内部の
// 数値idを橋渡しする列。NULLを許容しつつ、値が入る場合は重複を禁止する（下のUNIQUE INDEX参照）。
// checkout時の店舗解決ロジック自体は今回実装しない（別STEP）。
ensureColumn('stores', 'catalog_store_id', 'TEXT');
// 1=新規注文可能、0=新規注文停止。新規登録直後は安全側でactive=0とし、
// 座標登録・商品確認が済んでから運用者が明示的にactive=1へ切り替える運用を前提とする。
ensureColumn('stores', 'active', 'INTEGER NOT NULL DEFAULT 0');
// SQLiteのALTER TABLE ADD COLUMNはUNIQUE制約を直接付与できないため、列追加後に
// 部分UNIQUE INDEXとして一意性を強制する（catalog_store_idがNULLの行は対象外＝複数のNULLを許容）。
db.exec(
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_catalog_store_id ON stores(catalog_store_id) WHERE catalog_store_id IS NOT NULL'
);

// ドライバーの正確な自宅住所ではなく、本人申告の活動拠点を保持する列。
// リアルタイムGPS列・service_area列は今回追加しない（STEP2-D-3-B設計確認で確定済み）。
ensureColumn('drivers', 'base_label', 'TEXT');
ensureColumn('drivers', 'base_latitude', 'REAL');
ensureColumn('drivers', 'base_longitude', 'REAL');
ensureColumn('drivers', 'base_updated_at', 'TEXT');

// restaurant→customer（顧客配送時間の判定基準。delivery_time_minutesと対になる距離の監査用データ）
ensureColumn('orders', 'restaurant_to_customer_distance_km', 'REAL');
ensureColumn('orders', 'delivery_maps_lookup_status', 'TEXT');
ensureColumn('orders', 'delivery_maps_lookup_at', 'TEXT');
// driver base→restaurant（Remote Dispatch Bonusの判定根拠。restaurant→customerとは別区分、混同しないこと）
ensureColumn('orders', 'driver_to_restaurant_distance_km', 'REAL');
ensureColumn('orders', 'remote_maps_lookup_status', 'TEXT');
ensureColumn('orders', 'remote_maps_lookup_at', 'TEXT');
// 宿泊施設のsnapshot（accommodationsマスターの座標が後日変更されても、過去注文の料金根拠が
// 変わらないようにするための、注文時点の座標の固定保存。name/addressは既存のvilla_name列と
// 重複するため追加しない、STEP2-D-3-B設計確認で確定済み）。
ensureColumn('orders', 'accommodation_id', 'TEXT');
ensureColumn('orders', 'accommodation_latitude', 'REAL');
ensureColumn('orders', 'accommodation_longitude', 'REAL');
// Phase B: 同一住所に複数の建物・ヴィラが存在する施設向けの識別項目（顧客入力、任意）。
ensureColumn('orders', 'building_villa_number', 'TEXT');

// Phase B-2A: 注文配送情報（ゲスト名・電話番号・配送場所・配送指示）。すべてNULL許容の列として
// 追加し、必須/任意の判定はindex.ts側のcheckoutハンドラで行う（DB側にCHECK制約は設けない、
// 既存のOrderStatus/PaymentStatus等と同じ設計方針）。noteやparseDeliveryInfo()とは独立した
// トップレベル項目であり、既存のnote処理には一切影響しない。
ensureColumn('orders', 'guest_name', 'TEXT');
ensureColumn('orders', 'phone_number', 'TEXT');
ensureColumn('orders', 'delivery_location', 'TEXT');
ensureColumn('orders', 'delivery_instructions', 'TEXT');

// 商品マスター基盤STEP2：Draftを却下(REJECTED)する際の理由を保存する任意列。
// RejectされてもproductsのACTIVE行には一切影響しない（product_draftsのみの追加列）。
ensureColumn('product_drafts', 'rejection_reason', 'TEXT');

// 【2026-09-23・社長承認】五葷抜き(ごくんぬき)トグル機能。価格に影響しない同額オプションのため
// 新しい商品versionや金額テーブルは不要で、対応可否フラグ＋注文時の選択有無のみで完結する。
// きのこパスタ等、五葷抜き版が別価格・別商品として独立登録されているものにはこのフラグを立てない
// （そちらは既にトグル不要な別商品として扱う。gokun_nuki_available=1はあくまで「同額で選べる」商品向け）。
ensureColumn('products', 'gokun_nuki_available', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('order_line_items', 'gokun_nuki_requested', 'INTEGER NOT NULL DEFAULT 0');
// 【2026-09-24・社長承認・本番反映】選択したフレーバー／追加オプションの注文時スナップショット
// （JSON配列文字列）。上記gokun_nuki_requestedとは完全に独立した追加列で、既存の五葷抜き機能・
// 既存注文データには一切影響しない。
ensureColumn('order_line_items', 'selected_options', 'TEXT');

// 【2026-09-23・社長承認・ORDブランドサイト構築】お客様向け公開画面に必要な店舗紹介情報。
// commission_rate等の内部運用列とは異なり、これらはすべて公開API(/api/public/stores)で
// そのまま返してよい値のみ（パスワードハッシュ等は含まない）。
ensureColumn('stores', 'logo_url', 'TEXT');
ensureColumn('stores', 'description', 'TEXT');
ensureColumn('stores', 'description_en', 'TEXT');
ensureColumn('stores', 'tags', 'TEXT'); // JSON配列文字列（例:'["Vegan","Gluten-Free"]'）
ensureColumn('stores', 'genre', 'TEXT');
// 【2026-09-24・社長承認】店舗代表画像（外観・雰囲気を紹介する画像）用。logo_urlとは完全に別管理。
// 商品写真(products.image_reference)とも無関係。backend-uitestで検証済みの内容を本番へ反映。
ensureColumn('stores', 'photo_url', 'TEXT');

// 【2026-09-23・ORDブランドサイト構築】メニューカテゴリ表示用。backend-uitestには既存の列
// （container_count/square_catalog_item_id等と共に追加済み）だが、本番backendには存在しなかった
// ため移植する。既存64品目へのカテゴリ値バックフィルは別スクリプトで行う（このensureColumnは
// 列追加のみ、値の投入は行わない）。
ensureColumn('products', 'category', 'TEXT');

// 2026-09-22：加盟店手数料ゼロ方針の確定に伴うデータ修正。
// 過去に0.15（15%）で作成された既存加盟店データを0に更新する（何度実行しても安全な冪等処理）。
// 新規作成分はDEFAULT_COMMISSION_RATE（index.ts側、0固定）で対応済みのため対象外にはならない。
db.exec('UPDATE stores SET commission_rate = 0 WHERE commission_rate <> 0');

// pricing_rules の初期シード（テーブルが空の場合のみ。既存データがあれば一切上書きしない）
function seedPricingRulesIfEmpty() {
  const { c } = db.prepare('SELECT COUNT(*) as c FROM pricing_rules').get() as { c: number };
  if (c > 0) return;

  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO pricing_rules (rule_type, unit, range_min, range_max, amount, is_consultation, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  type Rule = [number | null, number | null, number | null, boolean, number];
  const timeRules = (ruleType: string, rows: Rule[]) => {
    rows.forEach(([min, max, amount, isConsultation, sortOrder]) => {
      insert.run(ruleType, 'MINUTES', min, max, amount, isConsultation ? 1 : 0, sortOrder, now, now);
    });
  };

  // 顧客配送料（店舗→顧客の実走行時間）
  // 0以上20以下=¥500 / 20超30以下=¥1,000 / 30超40以下=¥2,000 / 40超50以下=¥3,500 /
  // 50超60以下=¥5,000 / 60超=要相談（0分・20分・60分を含み、60分超は含まないことに注意）
  timeRules('DELIVERY_FEE', [
    [null, 20, 500, false, 1],
    [20, 30, 1000, false, 2],
    [30, 40, 2000, false, 3],
    [40, 50, 3500, false, 4],
    [50, 60, 5000, false, 5],
    [60, null, null, true, 6],
  ]);

  // 最低注文額（店舗→顧客の実走行時間）
  // 0以上20以下=¥10,000 / 20超30以下=¥10,000 / 30超40以下=¥12,000 / 40超50以下=¥12,000 /
  // 50超60以下=¥15,000 / 60超=要相談
  // 【修正】50超60以下は以前¥20,000と誤って設定されていた。確定ルールに合わせ¥15,000に統一。
  // 【2026-09-23修正】40超50以下は以前¥15,000と誤って設定されていた。2026-09-22に社長が
  // 訂正した正式確定値（¥12,000）に統一（[[project-ord-master-pricing-data]]参照）。
  timeRules('MINIMUM_ORDER', [
    [null, 20, 10000, false, 1],
    [20, 30, 10000, false, 2],
    [30, 40, 12000, false, 3],
    [40, 50, 12000, false, 4],
    [50, 60, 15000, false, 5],
    [60, null, null, true, 6],
  ]);

  // ドライバー基本報酬（店舗→顧客の実走行時間、燃料費込み）
  // 0以上20以下=¥800 / 20超30以下=¥1,000 / 30超40以下=¥1,300 / 40超50以下=¥1,600 /
  // 50超60以下=¥2,000 / 60超=要相談
  timeRules('DRIVER_REWARD', [
    [null, 20, 800, false, 1],
    [20, 30, 1000, false, 2],
    [30, 40, 1300, false, 3],
    [40, 50, 1600, false, 4],
    [50, 60, 2000, false, 5],
    [60, null, null, true, 6],
  ]);

  // 遠隔ドライバーボーナス（ドライバー拠点→店舗の距離、km）
  // 0以上5以下=¥0 / 5超10以下=+¥300 / 10超15以下=+¥500 / 15超20以下=+¥1,000 /
  // 20超=要相談（0km・5km・20kmを含み、20km超は含まないことに注意）
  const kmRules: Rule[] = [
    [null, 5, 0, false, 1],
    [5, 10, 300, false, 2],
    [10, 15, 500, false, 3],
    [15, 20, 1000, false, 4],
    [20, null, null, true, 5],
  ];
  kmRules.forEach(([min, max, amount, isConsultation, sortOrder]) => {
    insert.run('REMOTE_DISPATCH_BONUS', 'KM', min, max, amount, isConsultation ? 1 : 0, sortOrder, now, now);
  });
}
seedPricingRulesIfEmpty();

// 【2026-09-23・STEP C-2 Stage 6・社長承認】ドライバー報酬の旧6段階(20分刻み)を
// 正式3段階制(¥800/¥1,000/¥1,300/要相談、2026-09-20社長最終確定)へ移行する。
// seedPricingRulesIfEmpty()は「テーブルが空の場合のみ」しか実行されないため、
// 既にデータが入っている本番DBには効果がなかった（backend-uitestは2026-09-20に
// 別途この移行を実施済み、本番のみ未対応だった）。
// 冪等処理：旧6段階の行（sort_order 6件かつ40-50分の金額が1600円）が残っている場合のみ
// 削除→3段階を再投入する。既に3段階になっていれば何もしない。
function migrateDriverRewardTo3TierIfLegacy() {
  const legacyRow = db
    .prepare("SELECT COUNT(*) as c FROM pricing_rules WHERE rule_type = 'DRIVER_REWARD' AND range_min = 40 AND range_max = 50 AND amount = 1600")
    .get() as { c: number };
  if (legacyRow.c === 0) return; // 既に移行済み、または該当データなし

  db.prepare("DELETE FROM pricing_rules WHERE rule_type = 'DRIVER_REWARD'").run();

  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO pricing_rules (rule_type, unit, range_min, range_max, amount, is_consultation, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  type Rule = [number | null, number | null, number | null, boolean, number];
  const rows: Rule[] = [
    [null, 30, 800, false, 1],
    [30, 50, 1000, false, 2],
    [50, 60, 1300, false, 3],
    [60, null, null, true, 4],
  ];
  rows.forEach(([min, max, amount, isConsultation, sortOrder]) => {
    insert.run('DRIVER_REWARD', 'MINUTES', min, max, amount, isConsultation ? 1 : 0, sortOrder, now, now);
  });
}
migrateDriverRewardTo3TierIfLegacy();

// 【2026-09-23・社長承認】最低注文額の41〜50分区分を、誤った¥15,000から
// 正式確定値¥12,000（2026-09-22社長訂正）へ修正する。冪等処理：該当行が
// 既に¥12,000になっていれば何も起きない。
db.exec("UPDATE pricing_rules SET amount = 12000 WHERE rule_type = 'MINIMUM_ORDER' AND range_min = 40 AND range_max = 50 AND amount = 15000");

// accommodations の初期シード（テーブルが空の場合のみ。既存データがあれば一切上書きしない）。
// index.html の HOTELS 配列（h1〜h10）から id/name/area のみを手動転記したもの
// （priceCatalog.tsがSTORESの価格関連項目だけを複製した前例と同じ考え方）。
// feature/icon/roomsは表示専用のため複製しない。address/latitude/longitudeは未確定のためNULL、
// activeは座標未確定の間は必ず0（STEP2-D-3-A/Bで確定済みの安全ゲート）。
// 【重要】住所・座標の推測入力、Geocoding/Places API呼び出しは一切行わない。
function seedAccommodationsIfEmpty() {
  const { c } = db.prepare('SELECT COUNT(*) as c FROM accommodations').get() as { c: number };
  if (c > 0) return;

  const insert = db.prepare(
    `INSERT INTO accommodations (id, name, area, address, latitude, longitude, location_source, location_updated_at, active)
     VALUES (?, ?, ?, NULL, NULL, NULL, 'MANUAL', NULL, 0)`
  );
  const hotels: [string, string, string][] = [
    ['h1', 'コーラルテラス恩納', '恩納村'],
    ['h2', '読谷ムーンリーフリゾート', '読谷村'],
    ['h3', '名護グリーンベイホテル', '名護市'],
    ['h4', '北谷サンセットコースト', '北谷町'],
    ['h5', '恩納シーサイドコーラルヴィラ', '恩納村'],
    ['h6', '読谷ザ・ラグーンリゾート', '読谷村'],
    ['h7', '名護フォレストヒルズヴィラ', '名護市'],
    ['h8', '北谷マリーナビューホテル', '北谷町'],
    ['h9', '恩納ザ・パームリゾート&スパ', '恩納村'],
    ['h10', '読谷コーラルサンズヴィラ', '読谷村'],
  ];
  hotels.forEach(([id, name, area]) => insert.run(id, name, area));
}
seedAccommodationsIfEmpty();
