// ============================================================
// Webhookイベントの重複防止・トランザクション基盤（STEP2-C-6）
// 【重要】この関数群は基盤のみであり、既存の POST /webhooks/square にはまだ
// 組み込んでいない。正式な統合はSTEP2-C-8で行う。
//
// STEP2-C-3で作成済みの processed_webhook_events テーブルをそのまま使用する
// （テーブル定義は今回一切変更していない）。
// ============================================================
import { db } from './db';

// SQLiteの制約違反系エラーコードは SQLITE_CONSTRAINT(=19) を下位バイトに持つ
// （例：PRIMARY KEY制約=1555, UNIQUE制約=2067。いずれも 1555 & 0xff === 19, 2067 & 0xff === 19）。
// 実機（node:sqlite）で実際にスローされるエラーの形状を確認したうえで実装している。
const SQLITE_CONSTRAINT_BASE = 19;
function isSqliteConstraintError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'errcode' in e &&
    typeof (e as { errcode?: unknown }).errcode === 'number' &&
    ((e as { errcode: number }).errcode & 0xff) === SQLITE_CONSTRAINT_BASE
  );
}

/**
 * event_id を「処理済み」として記録しようと試みる。
 *
 * 単純な「SELECTで存在確認→なければ処理→INSERT」という check-then-act 方式は、
 * 同じevent_idがほぼ同時に2回届いた場合のレースコンディションに弱いため採用しない。
 * 代わりに、INSERT自体を試み、PRIMARY KEY制約違反（=既に存在する）を検出する
 * "insert-first" 方式を採用する。
 *
 * @returns true  = 新規イベントとして記録できた（このevent_idは初めて処理してよい）
 *          false = 既に記録済み（重複。処理をスキップすべき）
 * @throws  制約違反以外の予期しないDBエラーはそのまま呼び出し元へ伝播させる
 *          （重複と本当のDB障害を混同しないため）
 */
export function tryMarkWebhookEventProcessed(eventId: string): boolean {
  try {
    db.prepare('INSERT INTO processed_webhook_events (event_id, processed_at) VALUES (?, ?)').run(eventId, new Date().toISOString());
    return true;
  } catch (e) {
    if (isSqliteConstraintError(e)) return false;
    throw e;
  }
}

export function isWebhookEventProcessed(eventId: string): boolean {
  const row = db.prepare('SELECT event_id FROM processed_webhook_events WHERE event_id = ?').get(eventId);
  return row !== undefined;
}

/**
 * イベント記録＋業務処理を単一のSQLiteトランザクションとして実行するためのヘルパー。
 *
 * node:sqlite の DatabaseSync には（better-sqlite3のような）専用の transaction() メソッドが
 * 存在しないため、標準のBEGIN/COMMIT/ROLLBACKをSQL文として明示的に実行する。
 *
 * 【STEP2-C-8での想定利用イメージ（今回は呼び出していない）】
 *   runInTransaction(() => {
 *     if (!tryMarkWebhookEventProcessed(event.id)) return; // 重複ならここで終了、以降は実行しない
 *     updateOrderStatus(orderId, 'RECEIVED');               // 業務処理
 *     // ここで例外が発生すればROLLBACKされ、
 *     // 「イベントだけ処理済みとして記録され、業務処理が反映されない」状態を防げる
 *   });
 *
 * @throws fn内で例外が発生した場合、ROLLBACKした上でその例外を再スローする
 */
export function runInTransaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
