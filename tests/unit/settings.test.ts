import { describe, it, expect } from 'vitest';
import { readRate, writeRate } from '../../src/settings';

// Minimal Lua snippets that mirror the real server config format
const SAMPLE_MAIN_LUA = `
xi = xi or {}
xi.settings = xi.settings or {}
EXP_RATE                 = 1.0
BOOK_EXP_RATE            = 1.0
ROE_EXP_RATE             = 1.0
RISE_OF_THE_ZILART       = true
CHAINS_OF_PROMATHIA      = false
GIL_RATE                 = 1.0
HARVESTING_RATE          = 100
`;

describe('readRate', () => {
  it('reads a numeric rate', () => {
    expect(readRate(SAMPLE_MAIN_LUA, 'EXP_RATE')).toBe(1.0);
  });

  it('reads a bool true', () => {
    expect(readRate(SAMPLE_MAIN_LUA, 'RISE_OF_THE_ZILART', 'bool')).toBe(true);
  });

  it('reads a bool false', () => {
    expect(readRate(SAMPLE_MAIN_LUA, 'CHAINS_OF_PROMATHIA', 'bool')).toBe(false);
  });

  it('reads an integer rate', () => {
    expect(readRate(SAMPLE_MAIN_LUA, 'HARVESTING_RATE')).toBe(100);
  });

  it('returns null for a missing key', () => {
    expect(readRate(SAMPLE_MAIN_LUA, 'NONEXISTENT_KEY')).toBeNull();
  });

  it('returns null for missing bool key', () => {
    expect(readRate(SAMPLE_MAIN_LUA, 'NONEXISTENT_KEY', 'bool')).toBeNull();
  });

  it('does not match partial key names', () => {
    // EXP_RATE should not match BOOK_EXP_RATE
    expect(readRate('BOOK_EXP_RATE = 2.5\nEXP_RATE = 1.0\n', 'EXP_RATE')).toBe(1.0);
  });
});

describe('writeRate', () => {
  it('updates a numeric value', () => {
    const updated = writeRate(SAMPLE_MAIN_LUA, 'EXP_RATE', 3.0);
    expect(readRate(updated, 'EXP_RATE')).toBe(3.0);
    // Other rates unchanged
    expect(readRate(updated, 'GIL_RATE')).toBe(1.0);
  });

  it('updates a bool from true to false', () => {
    const updated = writeRate(SAMPLE_MAIN_LUA, 'RISE_OF_THE_ZILART', 'false', 'bool');
    expect(readRate(updated, 'RISE_OF_THE_ZILART', 'bool')).toBe(false);
  });

  it('updates a bool from false to true', () => {
    const updated = writeRate(SAMPLE_MAIN_LUA, 'CHAINS_OF_PROMATHIA', 'true', 'bool');
    expect(readRate(updated, 'CHAINS_OF_PROMATHIA', 'bool')).toBe(true);
  });

  it('returns unchanged content when key is not present', () => {
    const updated = writeRate(SAMPLE_MAIN_LUA, 'MISSING_KEY', 5.0);
    expect(updated).toBe(SAMPLE_MAIN_LUA);
  });

  it('preserves surrounding content', () => {
    const updated = writeRate(SAMPLE_MAIN_LUA, 'EXP_RATE', 2.5);
    expect(updated).toContain('BOOK_EXP_RATE');
    expect(updated).toContain('RISE_OF_THE_ZILART');
  });

  it('handles decimal precision', () => {
    const lua = 'DROP_RATE_MULTIPLIER = 1.0\n';
    const updated = writeRate(lua, 'DROP_RATE_MULTIPLIER', 1.5);
    expect(readRate(updated, 'DROP_RATE_MULTIPLIER')).toBe(1.5);
  });
});
