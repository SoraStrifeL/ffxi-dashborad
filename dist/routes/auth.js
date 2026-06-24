"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthRouter = createAuthRouter;
const express_1 = require("express");
const auth = __importStar(require("../auth"));
const audit_1 = require("../audit");
function createAuthRouter(pool) {
    const router = (0, express_1.Router)();
    // ── Login rate limiter ───────────────────────────────────────────────────────
    const loginAttempts = new Map();
    function checkLoginRateLimit(key) {
        const now = Date.now(), window = 15 * 60 * 1000, max = 10;
        let e = loginAttempts.get(key);
        if (!e || now - e.start > window) {
            e = { start: now, count: 0 };
            loginAttempts.set(key, e);
        }
        return ++e.count > max;
    }
    setInterval(() => {
        const cutoff = Date.now() - 15 * 60 * 1000;
        for (const [k, e] of loginAttempts)
            if (e.start < cutoff)
                loginAttempts.delete(k);
    }, 5 * 60 * 1000);
    router.post('/api/login', async (req, res) => {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const { login, password } = req.body || {};
        if (checkLoginRateLimit(`ip:${ip}`) || (login && checkLoginRateLimit(`acct:${String(login).toLowerCase()}`))) {
            (0, audit_1.audit)(String(login || 'unknown'), 'auth.login.ratelimit', undefined, { ip });
            res.status(429).json({ error: 'Too many login attempts. Try again later.' });
            return;
        }
        try {
            const identity = await auth.authenticate(pool, login || '', password || '');
            if (!identity) {
                (0, audit_1.audit)(String(login || 'unknown'), 'auth.login.failure', undefined, { ip, reason: 'invalid credentials' });
                res.status(401).json({ error: 'invalid credentials' });
                return;
            }
            if ('error' in identity && identity.error === 'legacy_password') {
                (0, audit_1.audit)(String(login || 'unknown'), 'auth.login.failure', undefined, { ip, reason: 'legacy_password' });
                res.status(409).json({ error: 'Log into the game once to upgrade your account security, then try again.' });
                return;
            }
            if ('error' in identity) {
                (0, audit_1.audit)(String(login || 'unknown'), 'auth.login.failure', undefined, { ip, reason: 'auth error' });
                res.status(401).json({ error: 'invalid credentials' });
                return;
            }
            (0, audit_1.audit)(identity.login, 'auth.login.success', undefined, { ip, tier: identity.tier });
            res.json({ token: auth.issueToken(identity), tier: identity.tier, login: identity.login });
        }
        catch (e) {
            console.error('Login error:', e);
            res.status(500).json({ error: 'Internal server error' });
        }
    });
    return router;
}
