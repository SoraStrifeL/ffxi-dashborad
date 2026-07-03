import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import bcrypt from 'bcrypt';
import { authenticate } from '../../src/auth';
import * as settings from '../../src/settings';
import type { Pool } from 'mysql2/promise';

// Covers the full player/admin login decision path against a mocked pool:
// bcrypt verification, tier resolution from gmlevel, legacy-hash rejection,
// account status, and the allowPlayerLogin gate.

let HASH: string;
beforeAll(async () => {
  HASH = await bcrypt.hash('TestPass123', 4); // low cost — test only
});

function mockPool(account: Record<string, unknown> | null, maxgm: number | null): Pool {
  return {
    execute: vi.fn(async (sql: string) => {
      if (sql.includes('FROM accounts')) return [account ? [account] : []];
      if (sql.includes('MAX(gmlevel)')) return [[{ maxgm }]];
      throw new Error('unexpected sql: ' + sql);
    }),
  } as unknown as Pool;
}

const DS_BASE: settings.DashboardSettings = {
  serverName: 't', motd: '', autoSwitchZone: true, autologin: false,
  tokenTtlHours: 24, adminGmLevel: 1, loginRateLimitMax: 10, allowPlayerLogin: true,
};

function mockSettings(patch: Partial<settings.DashboardSettings> = {}) {
  vi.spyOn(settings, 'loadDashboardSettings').mockReturnValue({ ...DS_BASE, ...patch });
}

afterEach(() => vi.restoreAllMocks());

describe('authenticate', () => {
  it('valid credentials + no GM characters → player tier', async () => {
    mockSettings();
    const pool = mockPool({ id: 7, status: 1, password: HASH }, 0);
    const r = await authenticate(pool, 'taru', 'TestPass123');
    expect(r).toEqual({ accid: 7, tier: 'player', login: 'taru' });
  });

  it('valid credentials + gmlevel >= adminGmLevel → admin tier', async () => {
    mockSettings({ adminGmLevel: 4 });
    const pool = mockPool({ id: 1, status: 1, password: HASH }, 4);
    const r = await authenticate(pool, 'sora', 'TestPass123');
    expect(r).toEqual({ accid: 1, tier: 'admin', login: 'sora' });
  });

  it('gmlevel below adminGmLevel → player tier, not admin', async () => {
    mockSettings({ adminGmLevel: 4 });
    const pool = mockPool({ id: 2, status: 1, password: HASH }, 3);
    const r = await authenticate(pool, 'juniorgm', 'TestPass123');
    expect(r).toEqual({ accid: 2, tier: 'player', login: 'juniorgm' });
  });

  it('wrong password → null', async () => {
    mockSettings();
    const pool = mockPool({ id: 7, status: 1, password: HASH }, 0);
    expect(await authenticate(pool, 'taru', 'WrongPass')).toBeNull();
  });

  it('unknown login → null (with dummy compare)', async () => {
    mockSettings();
    expect(await authenticate(mockPool(null, null), 'ghost', 'TestPass123')).toBeNull();
  });

  it('disabled account (status != 1) → null even with valid password', async () => {
    mockSettings();
    const pool = mockPool({ id: 7, status: 0, password: HASH }, 0);
    expect(await authenticate(pool, 'banned', 'TestPass123')).toBeNull();
  });

  it('legacy non-bcrypt hash → legacy_password error', async () => {
    mockSettings();
    const pool = mockPool({ id: 7, status: 1, password: '5f4dcc3b5aa765d61d8327deb882cf99' }, 0);
    expect(await authenticate(pool, 'oldacct', 'TestPass123')).toEqual({ error: 'legacy_password' });
  });

  it('allowPlayerLogin=false blocks player-tier accounts', async () => {
    mockSettings({ allowPlayerLogin: false });
    const pool = mockPool({ id: 7, status: 1, password: HASH }, 0);
    expect(await authenticate(pool, 'taru', 'TestPass123')).toBeNull();
  });

  it('allowPlayerLogin=false still admits admins', async () => {
    mockSettings({ allowPlayerLogin: false, adminGmLevel: 4 });
    const pool = mockPool({ id: 1, status: 1, password: HASH }, 4);
    const r = await authenticate(pool, 'sora', 'TestPass123');
    expect(r).toEqual({ accid: 1, tier: 'admin', login: 'sora' });
  });

  it('rejects oversized login/password without touching the DB', async () => {
    mockSettings();
    const pool = mockPool({ id: 7, status: 1, password: HASH }, 0);
    expect(await authenticate(pool, 'x'.repeat(17), 'TestPass123')).toBeNull();
    expect(await authenticate(pool, 'taru', 'x'.repeat(33))).toBeNull();
    expect((pool.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
