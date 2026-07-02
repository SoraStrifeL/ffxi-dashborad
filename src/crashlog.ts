// ── Crash log ─────────────────────────────────────────────────────────────────
// Captures uncaughtException / unhandledRejection to data/crash.log so crashes
// survive container restarts and are viewable in Settings → Crash Log.
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './catalog';

const CRASH_LOG_FILE = path.join(DATA_DIR, 'crash.log');
const MAX_CRASH_ENTRIES = 100;

export interface CrashEntry {
  ts: string;
  type: string;
  message: string;
  stack: string | null;
}

const CRASH_LOG: CrashEntry[] = [];

function writeCrashEntry(type: string, err: unknown): void {
  const entry: CrashEntry = {
    ts: new Date().toISOString(),
    type,
    message: (err instanceof Error ? err.message : String(err)) || 'unknown error',
    stack: err instanceof Error ? err.stack ?? null : null,
  };
  CRASH_LOG.push(entry);
  const overflow = CRASH_LOG.length > MAX_CRASH_ENTRIES;
  if (overflow) CRASH_LOG.shift();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(CRASH_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
    if (overflow) {
      const lines = fs.readFileSync(CRASH_LOG_FILE, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(CRASH_LOG_FILE, lines.slice(-MAX_CRASH_ENTRIES).join('\n') + '\n', 'utf8');
    }
  } catch (_) { /* non-fatal */ }
}

// Load persisted entries from previous runs
try {
  fs.readFileSync(CRASH_LOG_FILE, 'utf8').split('\n').filter(Boolean)
    .slice(-MAX_CRASH_ENTRIES).forEach(l => { try { CRASH_LOG.push(JSON.parse(l) as CrashEntry); } catch (_) { /* skip bad line */ } });
} catch (_) { /* no file yet */ }

export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => {
    console.error('[CRASH] uncaughtException:', err);
    writeCrashEntry('uncaughtException', err);
    process.exit(1); // let Docker restart us in a clean state
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error('[CRASH] unhandledRejection:', err);
    writeCrashEntry('unhandledRejection', err);
    // No exit: route handlers and pollers all catch; a transient DB rejection
    // shouldn't crash-loop the container. The log entry preserves the evidence.
  });
}

export function readCrashLog(): CrashEntry[] {
  return [...CRASH_LOG].reverse();
}

export function clearCrashLog(): void {
  CRASH_LOG.length = 0;
  try { fs.writeFileSync(CRASH_LOG_FILE, '', 'utf8'); } catch (_) { /* non-fatal */ }
}
