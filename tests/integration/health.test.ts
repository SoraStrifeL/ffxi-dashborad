import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createHealthRouter } from '../../src/routes/health';

// Mock ioredis so redisClient() returns null (no real Redis in CI)
vi.mock('ioredis', () => ({
  default: class FakeRedis {
    on() { return this; }
    connect() { return Promise.reject(new Error('no redis')); }
    ping() { return Promise.reject(new Error('no redis')); }
  },
}));
// After mocking ioredis, import cache so initRedis() wires up (but won't connect)
await import('../../src/cache');

const mockPool = {
  execute: vi.fn().mockResolvedValue([[{ '1': 1 }], []]),
};

const app = express();
app.use(express.json());
app.use(createHealthRouter(mockPool as any));

describe('GET /api/health', () => {
  it('returns 200 with ok status when DB responds', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('ok');
    expect(typeof res.body.version).toBe('string');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('includes memory stats', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.memory).toMatchObject({
      heapUsedMb:  expect.any(Number),
      heapTotalMb: expect.any(Number),
      rssMb:       expect.any(Number),
    });
  });

  it('shows redis as unavailable when Redis is not connected', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.redis).toBe('unavailable');
  });

  it('returns 503 when DB query throws', async () => {
    mockPool.execute.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.db).toBe('unreachable');
  });

  it('is accessible without authentication', async () => {
    // No Authorization header — should still return health data
    const res = await request(app).get('/api/health');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
