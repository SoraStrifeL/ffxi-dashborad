import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock audit before importing routes that call it
vi.mock('../../src/audit', () => ({
  audit:                  vi.fn(),
  setBroadcastAuditEvent: vi.fn(),
  broadcastAuditEvent:    null,
}));

import * as authModule from '../../src/auth';
import { createAuthRouter } from '../../src/routes/auth';

const mockPool = {} as any;
const app = express();
app.use(express.json());
app.use(createAuthRouter(mockPool));

beforeEach(() => vi.clearAllMocks());

describe('POST /api/login', () => {
  it('returns 401 for invalid credentials', async () => {
    vi.spyOn(authModule, 'authenticate').mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/api/login')
      .send({ login: 'nobody', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('returns 409 for legacy (non-bcrypt) password hash', async () => {
    vi.spyOn(authModule, 'authenticate').mockResolvedValueOnce({ error: 'legacy_password' });
    const res = await request(app)
      .post('/api/login')
      .send({ login: 'olduser', password: 'anything' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/upgrade/i);
  });

  it('returns token, tier, and login on success', async () => {
    vi.spyOn(authModule, 'authenticate').mockResolvedValueOnce({
      accid: 1, tier: 'admin', login: 'Sora',
    });
    vi.spyOn(authModule, 'issueToken').mockReturnValueOnce('signed-jwt-token');

    const res = await request(app)
      .post('/api/login')
      .send({ login: 'Sora', password: 'YourPassword1' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('signed-jwt-token');
    expect(res.body.tier).toBe('admin');
    expect(res.body.login).toBe('Sora');
  });

  it('returns 200 for player tier', async () => {
    vi.spyOn(authModule, 'authenticate').mockResolvedValueOnce({
      accid: 99, tier: 'player', login: 'Taru',
    });
    vi.spyOn(authModule, 'issueToken').mockReturnValueOnce('player-token');

    const res = await request(app)
      .post('/api/login')
      .send({ login: 'Taru', password: 'pass' });

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('player');
  });

  it('returns 429 after exceeding rate limit (11 rapid requests)', async () => {
    vi.spyOn(authModule, 'authenticate').mockResolvedValue(null);
    const login = `ratelimit-test-${Date.now()}`;

    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const r = await request(app).post('/api/login').send({ login, password: 'x' });
      lastStatus = r.status;
    }
    expect(lastStatus).toBe(429);
  });
});
