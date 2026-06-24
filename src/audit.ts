import fs from 'fs';
import path from 'path';

const AUDIT_FILE = process.env.AUDIT_FILE ?? path.join(__dirname, '..', 'data', 'audit.log');
const MAX_TAIL   = 10_000;

export interface AuditEntry {
  ts:      string;
  user:    string;
  action:  string;
  target?: string;
  meta?:   Record<string, unknown>;
}

// Set by ws.ts after WebSocket init to push audit events to admin clients in real time
export let broadcastAuditEvent: ((entry: AuditEntry) => void) | null = null;
export function setBroadcastAuditEvent(fn: (entry: AuditEntry) => void): void {
  broadcastAuditEvent = fn;
}

export function audit(
  user:    string,
  action:  string,
  target?: string,
  meta?:   Record<string, unknown>,
): void {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    user,
    action,
    ...(target !== undefined ? { target } : {}),
    ...(meta   !== undefined ? { meta }   : {}),
  };
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  } catch { /* non-fatal */ }
  broadcastAuditEvent?.(entry);
}

export function readAuditLog(limit = 200): AuditEntry[] {
  try {
    const content = fs.readFileSync(AUDIT_FILE, 'utf8');
    const lines   = content.trim().split('\n').filter(Boolean);
    const tail    = lines.slice(-Math.min(limit, MAX_TAIL));
    return tail.map(l => JSON.parse(l) as AuditEntry).reverse();
  } catch {
    return [];
  }
}
