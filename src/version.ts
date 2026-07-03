// ════════════════════════════════════════════════════════════════════
//  version.ts — build/version info for /api/version (troubleshooting)
//  ────────────────────────────────────────────────────────────────────
//  Resolved once at startup. In Docker the commit + build date are baked
//  in as GIT_COMMIT / BUILD_DATE env vars (see Dockerfile build args);
//  bare-metal falls back to reading the short commit from git at runtime.
// ════════════════════════════════════════════════════════════════════
import { execSync } from 'child_process';
import { version as pkgVersion } from '../package.json';

function resolveCommit(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface VersionInfo {
  version:   string;
  commit:    string;
  buildDate: string;
  node:      string;
  startedAt: string;
}

const startedAt = new Date().toISOString();

export const VERSION_INFO: VersionInfo = {
  version:   pkgVersion,
  commit:    resolveCommit(),
  buildDate: process.env.BUILD_DATE || 'unknown',
  node:      process.version,
  startedAt,
};
