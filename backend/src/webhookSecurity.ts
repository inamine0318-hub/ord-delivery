// ============================================================
// Square Webhook 安全基盤（STEP2-C-6）
// 【重要】この関数群は基盤のみであり、既存の POST /webhooks/square にはまだ
// 組み込んでいない（既存のデモ・テストフローを壊さないため）。
// 正式なWebhookへの組み込みはSTEP2-C-8で行う。
// ============================================================
import crypto from 'node:crypto';
import { Request } from 'express';

// express.json({ verify: ... }) で保持する生ボディを型として追加する。
// req.body（パース済みJSON）の既存挙動には一切影響しない、追加のプロパティ。
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

// express.json() の verify オプションにそのまま渡せる関数。
// 既存のJSONパース処理（express.jsonのデフォルト動作）を一切変更せず、
// パース対象になったバイト列をそのまま req.rawBody に保持するだけ。
// 二重パースは行わない（express.json自身が行うパース結果は従来通りreq.bodyに入る）。
export function captureRawBody(req: Request, _res: unknown, buf: Buffer): void {
  req.rawBody = Buffer.from(buf);
}

export interface SquareSignatureVerificationInput {
  rawBody: Buffer | undefined;
  signatureHeader: string | undefined;
  signatureKey: string | undefined;
  notificationUrl: string | undefined;
}

/**
 * Square Webhookの `x-square-hmacsha256-signature` を検証する。
 *
 * 計算式はSquare公式SDK(`square`パッケージ)の`WebhooksHelper.isValidWebhookEventSignature`と
 * 同一（HMAC-SHA256(notificationUrl + rawBody, signatureKey) をBase64化し、
 * ヘッダー値と比較）。ただし、SDK標準実装は単純な`===`比較でありtiming-safeではないため、
 * ここでは`crypto.timingSafeEqual`によるタイミング攻撃耐性のある比較に置き換えて実装している
 * （SDKの関数を直接使わない理由）。
 *
 * @returns 正しい署名ならtrue。rawBody/ヘッダー/鍵/URLのいずれかが欠落・不正、または
 *          署名が一致しない場合はすべてfalse（例外は投げない）。
 */
export function isValidSquareWebhookSignature(input: SquareSignatureVerificationInput): boolean {
  const { rawBody, signatureHeader, signatureKey, notificationUrl } = input;

  if (!rawBody || rawBody.length === 0) return false;
  if (!signatureHeader) return false;
  if (!signatureKey) return false;
  if (!notificationUrl) return false;

  try {
    const payload = Buffer.from(notificationUrl + rawBody.toString('utf-8'), 'utf-8');
    const expectedBase64 = crypto.createHmac('sha256', Buffer.from(signatureKey, 'utf-8')).update(payload).digest('base64');

    const expectedBuf = Buffer.from(expectedBase64, 'utf-8');
    const actualBuf = Buffer.from(signatureHeader, 'utf-8');

    // timingSafeEqualは長さが異なるとthrowするため、事前に長さを確認する
    // （長さが違う時点で不一致であり、これ自体はタイミング攻撃の対象にならない情報のため安全）
    if (expectedBuf.length !== actualBuf.length) return false;

    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    // 予期しない入力（不正なエンコーディング等）は安全側に倒してfalseとする
    return false;
  }
}

// Signature Key・Notification URLは環境変数から取得する想定（値そのものはこのファイルに置かない）。
// 呼び出し側で `process.env.SQUARE_WEBHOOK_SIGNATURE_KEY` / `process.env.SQUARE_WEBHOOK_NOTIFICATION_URL`
// を読み、このファイルの関数へ渡す設計とする。
