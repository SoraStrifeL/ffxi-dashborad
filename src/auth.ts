// ════════════════════════════════════════════════════════════════════
//  auth.ts — dashboard authentication using the GAME's account system
//  ────────────────────────────────────────────────────────────────────
//  Login = game login. Verifies the submitted password against the
//  bcrypt hash stored in `accounts.password`, the SAME way the LSB login
//  server does (BCrypt::validatePassword). Never stores the password.
//
//  Tiers:
//    admin  — account owns at least one character with gmlevel >= ADMIN_GM_LEVEL
//    player — any other valid account; scoped to their own characters only
// ════════════════════════════════════════════════════════════════════
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { RequestHandler } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { AuthUser } from './types';
import { loadDashboardSettings } from './settings';

export const ADMIN_GM_LEVEL = 1; // kept for server.js compat; auth.ts reads from settings

const JWT_SECRET = process.env.DASHBOARD_JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('FATAL: DASHBOARD_JWT_SECRET env var missing or too short (need >=16 chars).');
  console.error('Set it before starting, e.g. in dev.docker-compose.yml or the shell.');
  process.exit(1);
}
// After the guard above JWT_SECRET is guaranteed to be a string
const SECRET = JWT_SECRET as string;

// Detects the LSB bcrypt hash format ($2a/$2b/$2y/$2x$...), mirroring
// isBcryptHash() in src/login/auth_session.cpp.
function isBcryptHash(h: unknown): boolean {
  return typeof h === 'string'
    && h.length >= 60
    && h[0] === '$' && h[1] === '2'
    && (h[2] === 'a' || h[2] === 'b' || h[2] === 'y' || h[2] === 'x')
    && h[3] === '$';
}

// Dummy hash used when the account doesn't exist, to keep response time
// consistent and prevent username enumeration via timing.
const DUMMY_HASH = '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// Returns { accid, tier, login } on success, or null on any failure.
export async function authenticate(
  pool: Pool,
  login: string,
  password: string,
): Promise<{ accid: number; tier: 'admin' | 'player'; login: string } | { error: string } | null> {
  if (!login || !password) return null;
  if (login.length > 16 || password.length > 32) return null;

  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT id, status, password FROM accounts WHERE login = ? LIMIT 1', [login]);

  if (rows.length === 0) {
    await bcrypt.compare(password, DUMMY_HASH);
    return null;
  }

  const acc = rows[0];

  if (Number(acc.status) !== 1) return null;

  if (!isBcryptHash(acc.password)) {
    return { error: 'legacy_password' };
  }

  const ok = await bcrypt.compare(password, acc.password as string);
  if (!ok) return null;

  const ds = loadDashboardSettings();
  const adminLevel = ds.adminGmLevel ?? 1;

  const [gmRows] = await pool.execute<RowDataPacket[]>(
    'SELECT MAX(gmlevel) AS maxgm FROM chars WHERE accid = ?', [acc.id]);
  const maxGm = gmRows.length ? Number(gmRows[0].maxgm || 0) : 0;

  if (ds.allowPlayerLogin === false && maxGm < adminLevel) return null;

  const tier: 'admin' | 'player' = maxGm >= adminLevel ? 'admin' : 'player';

  return { accid: acc.id as number, tier, login };
}

export function issueToken(identity: { accid: number; tier: string; login: string }): string {
  const ds = loadDashboardSettings();
  const ttl = `${Math.max(1, Math.min(720, ds.tokenTtlHours ?? 24))}h`;
  return jwt.sign(
    { accid: identity.accid, tier: identity.tier, login: identity.login },
    SECRET,
    { expiresIn: ttl as `${number}h` });
}

// Express middleware: verifies the Bearer token, attaches req.user.
export const requireAuth: RequestHandler = (req, res, next) => {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'no token' }); return; }
  try {
    req.user = jwt.verify(token, SECRET) as AuthUser;
    next();
  } catch (_e) {
    res.status(401).json({ error: 'invalid or expired token' });
  }
};

// Express middleware: requires admin tier.
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!req.user || req.user.tier !== 'admin') {
    res.status(403).json({ error: 'admin only' });
    return;
  }
  next();
};

// Helper: does this request's user own the given charid?
export async function userOwnsChar(pool: Pool, accid: number, charid: number): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT 1 FROM chars WHERE charid = ? AND accid = ? LIMIT 1', [charid, accid]);
  return rows.length > 0;
}

// Verifies a raw JWT string; throws on invalid/expired.
export function verifyToken(token: string): AuthUser {
  return jwt.verify(token, SECRET) as AuthUser;
}
