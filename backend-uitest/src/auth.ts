// ============================================================
// 認証（加盟店・配送パートナー・管理者の3ロール、パスワードハッシュ+JWT）
// 【本番投入時の備考】JWT_SECRET は必ず .env で強力なランダム値に変更すること。
// 未設定の場合は開発用の固定値にフォールバックし、起動時に警告を表示する。
// ============================================================
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction } from 'express';

export type Role = 'ADMIN' | 'STORE' | 'DRIVER';

export interface AuthPayload {
  role: Role;
  id: number;
  name: string;
}

const JWT_SECRET = process.env.JWT_SECRET || 'ord-dev-secret-CHANGE-ME';
if (!process.env.JWT_SECRET) {
  console.warn('[警告] JWT_SECRETが未設定です。開発用の固定値を使用しています。本番投入前に.envで必ず変更してください。');
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  // 管理画面(/admin)はブラウザCookie経由でも同じJWTを送る
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.split(';').map(s => s.trim()).find(s => s.startsWith('ord_admin_session='));
    if (match) return decodeURIComponent(match.split('=')[1]);
  }
  return null;
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthPayload;
  } catch {
    return null;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

// 指定ロールのいずれかでログイン済みであることを要求するミドルウェア
export function requireAuth(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);
    const payload = token ? verifyToken(token) : null;
    if (!payload) return res.status(401).json({ ok: false, error: 'ログインが必要です' });
    if (!allowedRoles.includes(payload.role)) {
      return res.status(403).json({ ok: false, error: 'この操作を行う権限がありません' });
    }
    req.auth = payload;
    next();
  };
}
