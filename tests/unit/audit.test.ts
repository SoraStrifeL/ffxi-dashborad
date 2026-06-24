import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point audit to a temp file so tests don't touch data/audit.log
const tmpLog = path.join(os.tmpdir(), `ffxi-audit-test-${process.pid}.log`);
process.env.AUDIT_FILE = tmpLog;

// Import AFTER setting env so the module captures the correct path
const { audit, readAuditLog, setBroadcastAuditEvent } = await import('../../src/audit');

beforeEach(() => {
  try { fs.unlinkSync(tmpLog); } catch {}
});
afterEach(() => {
  try { fs.unlinkSync(tmpLog); } catch {}
});

describe('audit()', () => {
  it('writes a valid JSON line to the log file', () => {
    audit('Sora', 'test.action', 'char:1', { extra: 'data' });
    const content = fs.readFileSync(tmpLog, 'utf8').trim();
    const entry = JSON.parse(content);
    expect(entry.user).toBe('Sora');
    expect(entry.action).toBe('test.action');
    expect(entry.target).toBe('char:1');
    expect(entry.meta).toEqual({ extra: 'data' });
    expect(new Date(entry.ts).getTime()).toBeGreaterThan(0);
  });

  it('omits target and meta when not provided', () => {
    audit('Sora', 'auth.login.success');
    const entry = JSON.parse(fs.readFileSync(tmpLog, 'utf8').trim());
    expect(entry).not.toHaveProperty('target');
    expect(entry).not.toHaveProperty('meta');
  });

  it('appends multiple entries on successive calls', () => {
    audit('A', 'first');
    audit('B', 'second');
    const lines = fs.readFileSync(tmpLog, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).user).toBe('A');
    expect(JSON.parse(lines[1]).user).toBe('B');
  });

  it('calls broadcastAuditEvent when registered', () => {
    const cb = vi.fn();
    setBroadcastAuditEvent(cb);
    audit('Sora', 'queue.action', 'char:1');
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][0]).toMatchObject({ user: 'Sora', action: 'queue.action' });
    setBroadcastAuditEvent(vi.fn()); // reset
  });
});

describe('readAuditLog()', () => {
  it('returns entries in reverse chronological order', () => {
    const lines = [
      { ts: '2026-01-01T00:00:00.000Z', user: 'A', action: 'first' },
      { ts: '2026-01-02T00:00:00.000Z', user: 'B', action: 'second' },
      { ts: '2026-01-03T00:00:00.000Z', user: 'C', action: 'third' },
    ];
    fs.writeFileSync(tmpLog, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const entries = readAuditLog(10);
    expect(entries).toHaveLength(3);
    expect(entries[0].action).toBe('third');
    expect(entries[2].action).toBe('first');
  });

  it('respects the limit parameter', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', user: 'U', action: `action-${i}` }),
    );
    fs.writeFileSync(tmpLog, lines.join('\n'));
    expect(readAuditLog(3)).toHaveLength(3);
  });

  it('returns empty array when file does not exist', () => {
    // tmpLog was deleted in beforeEach — file doesn't exist
    expect(readAuditLog()).toEqual([]);
  });

  it('does not throw on a malformed line', () => {
    fs.writeFileSync(
      tmpLog,
      'not-json\n' + JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', user: 'U', action: 'ok' }),
    );
    expect(() => readAuditLog()).not.toThrow();
  });
});
