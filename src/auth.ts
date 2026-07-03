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
import crypto from 'crypto';
import { RequestHandler } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { AuthUser } from './types';
import { loadDashboardSettings } from './settings';
import { cacheGetJSON, cacheSetJSON, cacheDel } from './cache';

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
  // Short-lived access token. accessTtlMinutes drives it; fall back to the
  // legacy tokenTtlHours only if accessTtlMinutes is unset.
  const mins = ds.accessTtlMinutes ?? (ds.tokenTtlHours ?? 1) * 60;
  const ttl = `${Math.max(1, Math.min(1440, mins))}m`;
  return jwt.sign(
    { accid: identity.accid, tier: identity.tier, login: identity.login },
    SECRET,
    { expiresIn: ttl as `${number}m`, algorithm: 'HS256' });
}

// ── Refresh tokens (rotating, single-use, Redis-backed) ──────────────
// The access token above is short-lived. A refresh token is an opaque
// random string stored in Redis (key refresh:<token> → {accid, login})
// with a longer TTL. /api/refresh rotates it: the presented token is
// deleted and a fresh access+refresh pair is issued, so a captured
// refresh token is single-use. Revoked/disabled accounts can't refresh.
interface RefreshRecord { accid: number; login: string }
const REFRESH_PREFIX = 'refresh:';

export async function issueRefreshToken(identity: { accid: number; login: string }): Promise<string> {
  const ds = loadDashboardSettings();
  const ttlSec = Math.max(1, Math.min(90, ds.refreshTtlDays ?? 7)) * 86400;
  const token = crypto.randomBytes(32).toString('hex');
  await cacheSetJSON(`${REFRESH_PREFIX}${token}`, { accid: identity.accid, login: identity.login } as RefreshRecord, ttlSec);
  return token;
}

export async function revokeRefreshToken(token: string): Promise<void> {
  if (!token) return;
  await cacheDel(`${REFRESH_PREFIX}${token}`);
}

// Rotate: validate + delete the old token, re-check account state, issue a
// fresh access+refresh pair. Returns null on unknown/expired/revoked.
export async function rotateRefreshToken(
  token: string,
): Promise<{ token: string; refreshToken: string; tier: 'admin' | 'player'; login: string } | null> {
  if (!token) return null;
  const rec = await cacheGetJSON<RefreshRecord>(`${REFRESH_PREFIX}${token}`);
  if (!rec) return null;
  await cacheDel(`${REFRESH_PREFIX}${token}`); // single-use: consume immediately

  const state = await currentAccountState(rec.accid);
  if (state && !state.ok) return null;          // account banned/deleted since issue
  const tier = state ? state.tier : 'player';   // null (no pool/DB error) → conservative

  const access  = issueToken({ accid: rec.accid, tier, login: rec.login });
  const refresh = await issueRefreshToken({ accid: rec.accid, login: rec.login });
  return { token: access, refreshToken: refresh, tier, login: rec.login };
}

// Pin the accepted algorithm on every verify: without this, jwt.verify
// honours the token header's `alg`, opening algorithm-confusion attacks
// (e.g. a forged `alg:none` or an RS256/HS256 key-confusion token).
const VERIFY_OPTS = { algorithms: ['HS256'] as jwt.Algorithm[] };

// ── Per-request account-state revocation ─────────────────────────────
// A JWT is a bearer credential valid until it expires (tokenTtlHours,
// default 24h). Verifying only the signature means a banned account or a
// demoted admin keeps access until the token expires. requireAuth calls
// currentAccountState() to re-check the live account on each request:
// banned/deleted accounts are rejected, and the tier is refreshed so a
// demoted admin loses admin mid-session. Results are cached briefly to
// avoid a DB round-trip on every API call.
let _authPool: Pool | null = null;
export function initAuthPool(pool: Pool): void { _authPool = pool; }

interface AccountState { ok: boolean; tier: 'admin' | 'player' }
const _stateCache = new Map<number, { state: AccountState | null; exp: number }>();
const STATE_TTL_MS = 15_000;

// Returns the live account state for `accid`, or null to signal "skip the
// check" — when no pool is wired (unit/integration tests) or the DB errors
// (fail-open; the signature was already verified). ok=false means the
// account is missing, banned (status!=1), or blocked by allowPlayerLogin.
export async function currentAccountState(accid: number): Promise<AccountState | null> {
  if (!_authPool) return null;
  const now = Date.now();
  const hit = _stateCache.get(accid);
  if (hit && hit.exp > now) return hit.state;

  let state: AccountState | null;
  try {
    const [rows] = await _authPool.execute<RowDataPacket[]>(
      `SELECT a.status, MAX(c.gmlevel) AS maxgm
         FROM accounts a LEFT JOIN chars c ON c.accid = a.id
        WHERE a.id = ? GROUP BY a.id`, [accid]);
    if (rows.length === 0 || Number(rows[0].status) !== 1) {
      state = { ok: false, tier: 'player' };
    } else {
      const ds = loadDashboardSettings();
      const adminLevel = ds.adminGmLevel ?? 1;
      const maxGm = Number(rows[0].maxgm || 0);
      if (ds.allowPlayerLogin === false && maxGm < adminLevel) {
        state = { ok: false, tier: 'player' };
      } else {
        state = { ok: true, tier: maxGm >= adminLevel ? 'admin' : 'player' };
      }
    }
  } catch (_e) {
    state = null; // fail-open on DB error — don't lock everyone out
  }
  _stateCache.set(accid, { state, exp: now + STATE_TTL_MS });
  return state;
}

// Express middleware: verifies the Bearer token, re-checks the live account
// state, and attaches req.user (with a refreshed tier).
export const requireAuth: RequestHandler = async (req, res, next) => {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'no token' }); return; }
  let user: AuthUser;
  try {
    user = jwt.verify(token, SECRET, VERIFY_OPTS) as AuthUser;
  } catch (_e) {
    res.status(401).json({ error: 'invalid or expired token' });
    return;
  }
  const state = await currentAccountState(user.accid);
  if (state && !state.ok) {
    res.status(401).json({ error: 'account disabled' });
    return;
  }
  if (state) user.tier = state.tier; // refresh tier (demotion takes effect)
  req.user = user;
  next();
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
  return jwt.verify(token, SECRET, VERIFY_OPTS) as AuthUser;
}
