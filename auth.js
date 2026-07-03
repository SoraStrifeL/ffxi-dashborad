// ════════════════════════════════════════════════════════════════════
//  auth.js — dashboard authentication using the GAME's account system
//  ────────────────────────────────────────────────────────────────────
//  Login = game login. Verifies the submitted password against the
//  bcrypt hash stored in `accounts.password`, the SAME way the LSB login
//  server does (BCrypt::validatePassword). Never stores the password.
//
//  Tiers:
//    admin  — account owns at least one character with gmlevel >= ADMIN_GM_LEVEL
//    player — any other valid account; scoped to their own characters only
//
//  Security stance:
//    - password verified against bcrypt hash; never stored or logged
//    - banned accounts (status != 1) rejected, matching the game
//    - session = signed JWT with { accid, tier }, expiring
//    - JWT secret from env (DASHBOARD_JWT_SECRET); refuse to run without it
//    - legacy non-bcrypt accounts: rejected with a clear message telling
//      them to log into the GAME once (which auto-upgrades them to bcrypt),
//      rather than us re-implementing MariaDB PASSWORD() in Node
// ════════════════════════════════════════════════════════════════════
const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');

const ADMIN_GM_LEVEL = 1;                 // gmlevel >= this on any char => admin tier
const TOKEN_TTL      = '24h';             // session lifetime

const JWT_SECRET = process.env.DASHBOARD_JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('FATAL: DASHBOARD_JWT_SECRET env var missing or too short (need >=16 chars).');
  console.error('Set it before starting, e.g. in dev.docker-compose.yml or the shell.');
  process.exit(1);
}

// Detects the LSB bcrypt hash format ($2a/$2b/$2y/$2x$...), mirroring
// isBcryptHash() in src/login/auth_session.cpp.
function isBcryptHash(h) {
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
// `pool` is the shared mysql2/promise pool from server.js.
async function authenticate(pool, login, password) {
  if (!login || !password) return null;
  if (login.length > 16 || password.length > 32) return null;   // match game's input limits

  const [rows] = await pool.execute(
    'SELECT id, status, password FROM accounts WHERE login = ? LIMIT 1', [login]);

  if (rows.length === 0) {
    // Run a dummy compare so the response time is indistinguishable from a
    // real failed login — prevents username enumeration via timing.
    await bcrypt.compare(password, DUMMY_HASH);
    return null;
  }

  const acc = rows[0];

  // status: 1 = normal/active in LSB. Anything else (banned/inactive) is rejected.
  if (Number(acc.status) !== 1) return null;

  // Only bcrypt accounts are verifiable here. Legacy hashes can't be checked
  // without re-implementing MariaDB PASSWORD(); we refuse rather than weaken.
  if (!isBcryptHash(acc.password)) {
    return { error: 'legacy_password' };
  }

  const ok = await bcrypt.compare(password, acc.password);
  if (!ok) return null;

  // Determine tier: admin if any owned character is a GM.
  const [gmRows] = await pool.execute(
    'SELECT MAX(gmlevel) AS maxgm FROM chars WHERE accid = ?', [acc.id]);
  const maxGm = gmRows.length ? Number(gmRows[0].maxgm || 0) : 0;
  const tier  = maxGm >= ADMIN_GM_LEVEL ? 'admin' : 'player';

  return { accid: acc.id, tier, login };
}

function issueToken(identity) {
  return jwt.sign(
    { accid: identity.accid, tier: identity.tier, login: identity.login },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL });
}

// ── Per-request account-state revocation ─────────────────────────────
// A JWT stays valid until it expires (24h). Re-check the live account on
// each request so banned/deleted accounts are rejected and a demoted admin
// loses admin mid-session. Cached briefly to avoid a per-request DB hit.
let _authPool = null;
function initAuthPool(pool) { _authPool = pool; }

const _stateCache = new Map();   // accid -> { state, exp }
const STATE_TTL_MS = 15000;

// Returns { ok, tier } for the live account, or null to skip the check
// (no pool wired, or DB error → fail-open; signature already verified).
async function currentAccountState(accid) {
  if (!_authPool) return null;
  const now = Date.now();
  const hit = _stateCache.get(accid);
  if (hit && hit.exp > now) return hit.state;

  let state;
  try {
    const [rows] = await _authPool.execute(
      `SELECT a.status, MAX(c.gmlevel) AS maxgm
         FROM accounts a LEFT JOIN chars c ON c.accid = a.id
        WHERE a.id = ? GROUP BY a.id`, [accid]);
    if (rows.length === 0 || Number(rows[0].status) !== 1) {
      state = { ok: false, tier: 'player' };
    } else {
      const maxGm = Number(rows[0].maxgm || 0);
      state = { ok: true, tier: maxGm >= ADMIN_GM_LEVEL ? 'admin' : 'player' };
    }
  } catch (e) {
    state = null; // fail-open on DB error
  }
  _stateCache.set(accid, { state, exp: now + STATE_TTL_MS });
  return state;
}

// Express middleware: verifies the Bearer token, re-checks the live account
// state, and attaches req.user (with a refreshed tier).
async function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no token' });
  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);   // { accid, tier, login, iat, exp }
  } catch (e) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
  const state = await currentAccountState(user.accid);
  if (state && !state.ok) return res.status(401).json({ error: 'account disabled' });
  if (state) user.tier = state.tier;
  req.user = user;
  next();
}

// Express middleware: requires admin tier.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.tier !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  next();
}

// Helper: does this request's user own the given charid?
// Used to scope player-tier access to their own characters.
async function userOwnsChar(pool, accid, charid) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM chars WHERE charid = ? AND accid = ? LIMIT 1', [charid, accid]);
  return rows.length > 0;
}

// Verifies a raw JWT string; throws on invalid/expired.
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = {
  authenticate, issueToken, requireAuth, requireAdmin, userOwnsChar, verifyToken, initAuthPool,
  ADMIN_GM_LEVEL,
};
