import { describe, it, expect } from 'vitest';
import { issueToken, verifyToken, ADMIN_GM_LEVEL } from '../../src/auth';

// DASHBOARD_JWT_SECRET is set to 'test-secret-that-is-long-enough-hmac' via vitest.config.ts

describe('ADMIN_GM_LEVEL', () => {
  it('is 1', () => expect(ADMIN_GM_LEVEL).toBe(1));
});

describe('issueToken / verifyToken round-trip', () => {
  const identity = { accid: 42, tier: 'admin' as const, login: 'Sora' };

  it('issues a non-empty JWT string', () => {
    const token = issueToken(identity);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // header.payload.signature
  });

  it('decodes to the original fields', () => {
    const token   = issueToken(identity);
    const decoded = verifyToken(token);
    expect(decoded.accid).toBe(42);
    expect(decoded.tier).toBe('admin');
    expect(decoded.login).toBe('Sora');
  });

  it('contains iat and exp claims', () => {
    const decoded = verifyToken(issueToken(identity));
    expect(decoded.iat).toBeGreaterThan(0);
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  it('player tier round-trips correctly', () => {
    const playerToken = issueToken({ accid: 7, tier: 'player', login: 'Taru' });
    const decoded     = verifyToken(playerToken);
    expect(decoded.tier).toBe('player');
    expect(decoded.login).toBe('Taru');
  });

  it('throws on a malformed token string', () => {
    expect(() => verifyToken('not.a.token')).toThrow();
  });

  it('throws on a structurally valid but tampered token', () => {
    const token   = issueToken(identity);
    const parts   = token.split('.');
    parts[1]      = Buffer.from(JSON.stringify({ accid: 999, tier: 'admin', login: 'Hacker' })).toString('base64url');
    expect(() => verifyToken(parts.join('.'))).toThrow();
  });

  it('two tokens for the same identity are identical in payload', () => {
    const t1 = verifyToken(issueToken(identity));
    const t2 = verifyToken(issueToken(identity));
    expect(t1.accid).toBe(t2.accid);
    expect(t1.login).toBe(t2.login);
  });
});
