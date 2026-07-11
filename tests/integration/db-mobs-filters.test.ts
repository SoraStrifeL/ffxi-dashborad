import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock audit before importing routes that call it
import { vi } from 'vitest';
vi.mock('../../src/audit', () => ({
  audit:                  vi.fn(),
  setBroadcastAuditEvent: vi.fn(),
  broadcastAuditEvent:    null,
}));

import { issueToken } from '../../src/auth';
import { createDbRouter } from '../../src/routes/db';
import * as catalog from '../../src/catalog';

const mockPool = { execute: vi.fn(async () => [[]]) } as any;

const app = express();
app.use(express.json());
app.use(createDbRouter(mockPool));

const TOKEN = issueToken({ accid: 1, tier: 'admin', login: 'Sora' });

// GET /api/db/mobs filters MOB_CATALOG in memory (populated at startup from
// a live SQL query, but the route itself never touches the DB per-request)
// — seed it directly rather than mocking pool.execute.
beforeEach(() => {
  catalog.MOB_CATALOG.length = 0;
  catalog.MOB_CATALOG.push(
    { name: 'Low Bat', zone: 'Valkurm Dunes', min_lvl: 5, max_lvl: 8, aggro: 0, ecosystem: 'Bird' } as any,
    { name: 'Mid Crab', zone: 'Valkurm Dunes', min_lvl: 68, max_lvl: 72, aggro: 1, ecosystem: 'Vermin' } as any,
    { name: 'High Wyrm', zone: 'Valkurm Dunes', min_lvl: 90, max_lvl: 95, aggro: 0, ecosystem: 'Dragon' } as any,
  );
});

describe('GET /api/db/mobs level range filter', () => {
  it('minLv alone returns mobs whose max_lvl reaches at least minLv', async () => {
    const res = await request(app)
      .get('/api/db/mobs?minLv=70')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const names = res.body.map((r: any) => r.name);
    expect(names).toEqual(['Mid Crab', 'High Wyrm']);
  });

  it('maxLv alone returns mobs whose min_lvl does not exceed maxLv', async () => {
    const res = await request(app)
      .get('/api/db/mobs?maxLv=10')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const names = res.body.map((r: any) => r.name);
    expect(names).toEqual(['Low Bat']);
  });

  it('minLv and maxLv together use overlap semantics, not strict containment', async () => {
    const res = await request(app)
      .get('/api/db/mobs?minLv=70&maxLv=75')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const names = res.body.map((r: any) => r.name);
    // Mid Crab (68-72) overlaps 70-75 even though it's not fully contained
    // within it — that's the overlap semantics this filter is built on.
    expect(names).toEqual(['Mid Crab']);
  });

  it('combines with the aggro filter (AND semantics)', async () => {
    const res = await request(app)
      .get('/api/db/mobs?minLv=60&aggro=1')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const names = res.body.map((r: any) => r.name);
    // High Wyrm matches minLv=60 but aggro=0, so only Mid Crab (aggro=1) remains
    expect(names).toEqual(['Mid Crab']);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/db/mobs?minLv=70');
    expect(res.status).toBe(401);
  });
});
