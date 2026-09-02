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
    commission_rate REAL NOT NULL DEFAULT 0.15,
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
    completed_at TEXT
  );
`);

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
