import { Router } from 'express';
import { Pool } from 'mysql2/promise';
import * as auth from '../auth';
import { audit } from '../audit';

export function createAuthRouter(pool: Pool): Router {
  const router = Router();

  // ── Login rate limiter ───────────────────────────────────────────────────────
  const loginAttempts = new Map<string, { start: number; count: number }>();
  function checkLoginRateLimit(key: string): boolean {
    const now = Date.now(), window = 15 * 60 * 1000, max = 10;
    let e = loginAttempts.get(key);
    if (!e || now - e.start > window) { e = { start: now, count: 0 }; loginAttempts.set(key, e); }
    return ++e.count > max;
  }
  setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [k, e] of loginAttempts) if (e.start < cutoff) loginAttempts.delete(k);
  }, 5 * 60 * 1000);

  router.post('/api/login', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const { login, password } = (req.body as { login?: string; password?: string }) || {};
    if (checkLoginRateLimit(`ip:${ip}`) || (login && checkLoginRateLimit(`acct:${String(login).toLowerCase()}`))) {
      audit(String(login || 'unknown'), 'auth.login.ratelimit', undefined, { ip });
      res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      return;
    }
    try {
      const identity = await auth.authenticate(pool, login || '', password || '');
      if (!identity) {
        audit(String(login || 'unknown'), 'auth.login.failure', undefined, { ip, reason: 'invalid credentials' });
        res.status(401).json({ error: 'invalid credentials' });
        return;
      }
      if ('error' in identity && identity.error === 'legacy_password') {
        audit(String(login || 'unknown'), 'auth.login.failure', undefined, { ip, reason: 'legacy_password' });
        res.status(409).json({ error: 'Log into the game once to upgrade your account security, then try again.' });
        return;
      }
      if ('error' in identity) {
        audit(String(login || 'unknown'), 'auth.login.failure', undefined, { ip, reason: 'auth error' });
        res.status(401).json({ error: 'invalid credentials' });
        return;
      }
      audit(identity.login, 'auth.login.success', undefined, { ip, tier: identity.tier });
      res.json({ token: auth.issueToken(identity), tier: identity.tier, login: identity.login });
    } catch (e) {
      console.error('Login error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
