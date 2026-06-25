import fs from 'fs';
import path from 'path';
import type { RequestHandler } from 'express';
import { DATA_DIR } from './catalog';

export type Permission =
  | 'view:characters'
  | 'edit:characters'
  | 'view:accounts'
  | 'manage:accounts'
  | 'run:console'
  | 'manage:settings'
  | 'manage:scripts'
  | 'view:db'
  | 'manage:timers'
  | 'upload:images'
  | 'submit:queue'
  | 'view:queue';

export const ALL_PERMISSIONS: Permission[] = [
  'view:characters', 'edit:characters',
  'view:accounts',   'manage:accounts',
  'run:console',     'manage:settings', 'manage:scripts',
  'view:db',         'manage:timers',   'upload:images',
  'submit:queue',    'view:queue',
];

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  player: [
    'view:characters',
    'view:db',
  ],
};

// ── Per-account overrides ─────────────────────────────────────────────────────
const PERMS_FILE = path.join(DATA_DIR, 'permissions.json');

type OverrideMap = Record<string, Permission[]>;

let _overridesCache: OverrideMap | null = null;
let _overridesTs = 0;

function loadOverrides(): OverrideMap {
  if (_overridesCache && Date.now() - _overridesTs < 5000) return _overridesCache;
  try {
    _overridesCache = JSON.parse(fs.readFileSync(PERMS_FILE, 'utf8')) as OverrideMap;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[rbac] permissions.json read error:', (e as Error).message);
    }
    _overridesCache = {};
  }
  _overridesTs = Date.now();
  return _overridesCache;
}

export function saveOverrides(map: OverrideMap): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PERMS_FILE, JSON.stringify(map, null, 2), 'utf8');
  _overridesCache = map;
  _overridesTs = Date.now();
}

export function getAccountOverrides(accid: number): Permission[] {
  return loadOverrides()[String(accid)] ?? [];
}

export function setAccountOverrides(accid: number, perms: Permission[]): void {
  const map = { ...loadOverrides() };
  if (perms.length === 0) {
    delete map[String(accid)];
  } else {
    map[String(accid)] = perms;
  }
  saveOverrides(map);
}

export function hasPermission(tier: string, perm: Permission, accid?: number): boolean {
  if ((ROLE_PERMISSIONS[tier] ?? []).includes(perm)) return true;
  if (accid !== undefined) return loadOverrides()[String(accid)]?.includes(perm) ?? false;
  return false;
}

export function requirePermission(perm: Permission): RequestHandler {
  return (req, res, next) => {
    if (!req.user) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!hasPermission(req.user.tier, perm, req.user.accid)) {
      res.status(403).json({ error: `permission denied: ${perm}` });
      return;
    }
    next();
  };
}
