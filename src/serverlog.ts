// ════════════════════════════════════════════════════════════════════
//  serverlog.ts — capture the dashboard's OWN console output
//  ────────────────────────────────────────────────────────────────────
//  installServerLog() wraps console.{log,info,warn,error} so every line
//  the dashboard prints is also pushed into an in-memory ring buffer and
//  fanned out to live listeners. The Console page subscribes to the
//  'dashboard' source over WebSocket to tail these lines. Nothing is
//  written to disk — this streams what would otherwise only reach
//  `docker logs` straight to the browser.
// ════════════════════════════════════════════════════════════════════

import { format } from 'util';

type Listener = (lines: string[]) => void;

const RING_MAX = 500;                 // lines of backlog kept for late subscribers
const ring: string[] = [];
const listeners = new Set<Listener>();

function ts(): string {
  return new Date().toISOString().slice(11, 19); // HH:MM:SS (UTC)
}

function fmt(args: unknown[]): string {
  // util.format applies the same printf-style substitution (%s/%d/%o, Error
  // stacks, object inspection) that console.log itself uses.
  return `${ts()} ${format(...args)}`;
}

function emit(line: string): void {
  ring.push(line);
  if (ring.length > RING_MAX) ring.shift();
  listeners.forEach(fn => { try { fn([line]); } catch { /* listener errors never break logging */ } });
}

export function recentServerLog(): string[] { return ring.slice(); }
export function onServerLog(fn: Listener): void { listeners.add(fn); }
export function offServerLog(fn: Listener): void { listeners.delete(fn); }

let installed = false;
export function installServerLog(): void {
  if (installed) return;
  installed = true;
  const orig = {
    log:   console.log.bind(console),
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
  };
  // Each wrapper still writes to the real stream (so `docker logs` is
  // unchanged) and then mirrors the line into the ring/listeners.
  console.log   = (...a: unknown[]) => { orig.log(...a);   emit(fmt(a)); };
  console.info  = (...a: unknown[]) => { orig.info(...a);  emit(fmt(a)); };
  console.warn  = (...a: unknown[]) => { orig.warn(...a);  emit(fmt(a)); };
  console.error = (...a: unknown[]) => { orig.error(...a); emit(fmt(a)); };
}
