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

// Returns { accid, tier, login } on success, or null on any failure.
// `pool` is the shared mysql2/promise pool from server.js.
async function authenticate(pool, login, password) {
  if (!login || !password) return null;
  if (login.length > 16 || password.length > 32) return null;   // match game's input limits

  const [rows] = await pool.execute(
    'SELECT id, status, password FROM accounts WHERE login = ? LIMIT 1', [login]);
  if (rows.length === 0) return null;

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

// Express middleware: verifies the Bearer token, attaches req.user.
function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);   // { accid, tier, login, iat, exp }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
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
  authenticate, issueToken, requireAuth, requireAdmin, userOwnsChar, verifyToken,
  ADMIN_GM_LEVEL,
};
