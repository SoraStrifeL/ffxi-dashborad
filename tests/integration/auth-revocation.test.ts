import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import { requireAuth, requireAdmin, issueToken, initAuthPool } from '../../src/auth';

vi.mock('../../src/audit', () => ({
  audit:                  vi.fn(),
  setBroadcastAuditEvent: vi.fn(),
  broadcastAuditEvent:    null,
}));

// Build a fake pool whose account-state query returns the given row set.
// `execute` returns [rows] shaped like mysql2/promise.
function fakePool(rowsFor: (accid: number) => any[] | Error): Pool {
  return {
    execute: vi.fn(async (_sql: string, params: any[]) => {
      const accid = Number(params[0]);
      const out = rowsFor(accid);
      if (out instanceof Error) throw out;
      return [out];
    }),
  } as unknown as Pool;
}

function app() {
  const a = express();
  a.get('/whoami', requireAuth, (req, res) => res.json({ tier: req.user!.tier }));
  a.get('/admin', requireAuth, requireAdmin, (_req, res) => res.json({ ok: true }));
  return a;
}

// Distinct accids per test — requireAuth caches state for 15s keyed by accid.
describe('requireAuth per-request revocation', () => {
  it('allows an active account and refreshes tier to admin', async () => {
    initAuthPool(fakePool(() => [{ status: 1, maxgm: 4 }]));
    const token = issueToken({ accid: 1001, tier: 'admin', login: 'Sora' });
    const res = await request(app()).get('/admin').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a banned account (status != 1) with 401', async () => {
    initAuthPool(fakePool(() => [{ status: 0, maxgm: 4 }]));
    const token = issueToken({ accid: 1002, tier: 'admin', login: 'Sora' });
    const res = await request(app()).get('/whoami').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/disabled/);
  });

  it('rejects a deleted account (no rows) with 401', async () => {
    initAuthPool(fakePool(() => []));
    const token = issueToken({ accid: 1003, tier: 'admin', login: 'Ghost' });
    const res = await request(app()).get('/whoami').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('downgrades a demoted admin to player mid-session', async () => {
    // token claims admin, but the live account now has no GM chars
    initAuthPool(fakePool(() => [{ status: 1, maxgm: 0 }]));
    const token = issueToken({ accid: 1004, tier: 'admin', login: 'ExGm' });
    const who = await request(app()).get('/whoami').set('Authorization', `Bearer ${token}`);
    expect(who.body.tier).toBe('player');
    const adm = await request(app()).get('/admin').set('Authorization', `Bearer ${token}`);
    expect(adm.status).toBe(403);
  });

  it('fails open (allows) when the DB query errors', async () => {
    initAuthPool(fakePool(() => new Error('db down')));
    const token = issueToken({ accid: 1005, tier: 'player', login: 'Taru' });
    const res = await request(app()).get('/whoami').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('player');
  });

  it('still 401s on a missing token before any DB check', async () => {
    initAuthPool(fakePool(() => [{ status: 1, maxgm: 4 }]));
    const res = await request(app()).get('/whoami');
    expect(res.status).toBe(401);
  });
});
