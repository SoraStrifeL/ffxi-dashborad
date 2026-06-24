import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { requirePermission } from '../../src/rbac';
import { requireAuth } from '../../src/auth';
import { issueToken } from '../../src/auth';

// Mock audit so route files that import it don't write to disk
vi.mock('../../src/audit', () => ({
  audit:                  vi.fn(),
  setBroadcastAuditEvent: vi.fn(),
  broadcastAuditEvent:    null,
}));

function makeToken(tier: 'admin' | 'player'): string {
  return issueToken({ accid: tier === 'admin' ? 1 : 2, tier, login: tier });
}

// Minimal route that requires manage:accounts
const app = express();
app.use(express.json());
app.get('/test/admin-only',
  requireAuth,
  requirePermission('manage:accounts'),
  (_req, res) => res.json({ ok: true }),
);
app.get('/test/player-ok',
  requireAuth,
  requirePermission('view:characters'),
  (_req, res) => res.json({ ok: true }),
);

describe('requirePermission middleware', () => {
  it('allows admin to access manage:accounts route', async () => {
    const res = await request(app)
      .get('/test/admin-only')
      .set('Authorization', `Bearer ${makeToken('admin')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('blocks player from manage:accounts route with 403', async () => {
    const res = await request(app)
      .get('/test/admin-only')
      .set('Authorization', `Bearer ${makeToken('player')}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permission denied/);
  });

  it('allows player to access view:characters route', async () => {
    const res = await request(app)
      .get('/test/player-ok')
      .set('Authorization', `Bearer ${makeToken('player')}`);
    expect(res.status).toBe(200);
  });

  it('returns 401 with no token', async () => {
    const res = await request(app).get('/test/admin-only');
    expect(res.status).toBe(401);
  });

  it('returns 401 with malformed token', async () => {
    const res = await request(app)
      .get('/test/admin-only')
      .set('Authorization', 'Bearer not.a.real.token');
    expect(res.status).toBe(401);
  });
});
