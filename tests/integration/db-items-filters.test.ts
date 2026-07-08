import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock audit before importing routes that call it
vi.mock('../../src/audit', () => ({
  audit:                  vi.fn(),
  setBroadcastAuditEvent: vi.fn(),
  broadcastAuditEvent:    null,
}));

import { issueToken } from '../../src/auth';
import { createDbRouter } from '../../src/routes/db';

const execute = vi.fn(async () => [[]]);
const mockPool = { execute } as any;

const app = express();
app.use(express.json());
app.use(createDbRouter(mockPool));

const TOKEN = issueToken({ accid: 1, tier: 'admin', login: 'Sora' });

function lastCall(): [string, unknown[]] {
  const [sql, params] = execute.mock.calls[execute.mock.calls.length - 1];
  return [sql as string, params as unknown[]];
}

beforeEach(() => execute.mockClear());

// GET /api/db/items — filters must combine correctly regardless of which
// item `type` is selected. Regression coverage for a bug where the client
// only sent `slot` alongside `type=6` (Equipment), silently dropping the
// slot filter for `type=7` (Weapon) even though the server-side bitwise
// slot clause below was always type-agnostic.
describe('GET /api/db/items filters', () => {
  it('applies the slot filter when type=6 (Equipment)', async () => {
    const res = await request(app)
      .get('/api/db/items?type=6&slot=1')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const [sql, params] = lastCall();
    expect(sql).toContain('ib.type=?');
    expect(sql).toContain('(ie.slot & ?) != 0');
    expect(params).toEqual(['%%', 6, 1, 50, 0]);
  });

  it('applies the slot filter when type=7 (Weapon)', async () => {
    const res = await request(app)
      .get('/api/db/items?type=7&slot=1')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const [sql, params] = lastCall();
    expect(sql).toContain('ib.type=?');
    expect(sql).toContain('(ie.slot & ?) != 0');
    expect(params).toEqual(['%%', 7, 1, 50, 0]);
  });

  it('applies the slot filter with no type filter at all', async () => {
    const res = await request(app)
      .get('/api/db/items?slot=1')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const [sql, params] = lastCall();
    expect(sql).not.toContain('ib.type=?');
    expect(sql).toContain('(ie.slot & ?) != 0');
    expect(params).toEqual(['%%', 1, 50, 0]);
  });

  it('combines the slot filter and the weapon-skill filter together', async () => {
    const res = await request(app)
      .get('/api/db/items?type=7&slot=1&skill=1')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const [sql, params] = lastCall();
    expect(sql).toContain('ib.type=?');
    expect(sql).toContain('iw.skill=?');
    expect(sql).toContain('(ie.slot & ?) != 0');
    expect(params).toEqual(['%%', 7, 1, 1, 50, 0]);
  });

  it('applies the rare/ex flag filter', async () => {
    const res = await request(app)
      .get('/api/db/items?rareex=1')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const [sql, params] = lastCall();
    expect(sql).toContain('(ib.flags & 0xC000) != 0');
    expect(params).toEqual(['%%', 50, 0]);
  });

  it('applies the search term as a name LIKE clause', async () => {
    const res = await request(app)
      .get('/api/db/items?q=Ridill')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const [sql, params] = lastCall();
    expect(sql).toContain('ib.name USING utf8) LIKE ?');
    expect(params).toEqual(['%Ridill%', 50, 0]);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/db/items?slot=1');
    expect(res.status).toBe(401);
  });
});
