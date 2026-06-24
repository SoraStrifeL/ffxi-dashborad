"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAdmin = exports.requireAuth = exports.ADMIN_GM_LEVEL = void 0;
exports.authenticate = authenticate;
exports.issueToken = issueToken;
exports.userOwnsChar = userOwnsChar;
exports.verifyToken = verifyToken;
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
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
exports.ADMIN_GM_LEVEL = 1;
const TOKEN_TTL = '24h';
const JWT_SECRET = process.env.DASHBOARD_JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) {
    console.error('FATAL: DASHBOARD_JWT_SECRET env var missing or too short (need >=16 chars).');
    console.error('Set it before starting, e.g. in dev.docker-compose.yml or the shell.');
    process.exit(1);
}
// After the guard above JWT_SECRET is guaranteed to be a string
const SECRET = JWT_SECRET;
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
async function authenticate(pool, login, password) {
    if (!login || !password)
        return null;
    if (login.length > 16 || password.length > 32)
        return null;
    const [rows] = await pool.execute('SELECT id, status, password FROM accounts WHERE login = ? LIMIT 1', [login]);
    if (rows.length === 0) {
        await bcrypt_1.default.compare(password, DUMMY_HASH);
        return null;
    }
    const acc = rows[0];
    if (Number(acc.status) !== 1)
        return null;
    if (!isBcryptHash(acc.password)) {
        return { error: 'legacy_password' };
    }
    const ok = await bcrypt_1.default.compare(password, acc.password);
    if (!ok)
        return null;
    const [gmRows] = await pool.execute('SELECT MAX(gmlevel) AS maxgm FROM chars WHERE accid = ?', [acc.id]);
    const maxGm = gmRows.length ? Number(gmRows[0].maxgm || 0) : 0;
    const tier = maxGm >= exports.ADMIN_GM_LEVEL ? 'admin' : 'player';
    return { accid: acc.id, tier, login };
}
function issueToken(identity) {
    return jsonwebtoken_1.default.sign({ accid: identity.accid, tier: identity.tier, login: identity.login }, SECRET, { expiresIn: TOKEN_TTL });
}
// Express middleware: verifies the Bearer token, attaches req.user.
const requireAuth = (req, res, next) => {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) {
        res.status(401).json({ error: 'no token' });
        return;
    }
    try {
        req.user = jsonwebtoken_1.default.verify(token, SECRET);
        next();
    }
    catch (_e) {
        res.status(401).json({ error: 'invalid or expired token' });
    }
};
exports.requireAuth = requireAuth;
// Express middleware: requires admin tier.
const requireAdmin = (req, res, next) => {
    if (!req.user || req.user.tier !== 'admin') {
        res.status(403).json({ error: 'admin only' });
        return;
    }
    next();
};
exports.requireAdmin = requireAdmin;
// Helper: does this request's user own the given charid?
async function userOwnsChar(pool, accid, charid) {
    const [rows] = await pool.execute('SELECT 1 FROM chars WHERE charid = ? AND accid = ? LIMIT 1', [charid, accid]);
    return rows.length > 0;
}
// Verifies a raw JWT string; throws on invalid/expired.
function verifyToken(token) {
    return jsonwebtoken_1.default.verify(token, SECRET);
}
