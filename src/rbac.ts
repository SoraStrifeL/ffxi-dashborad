import type { RequestHandler } from 'express';

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

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: [
    'view:characters', 'edit:characters',
    'view:accounts',   'manage:accounts',
    'run:console',     'manage:settings', 'manage:scripts',
    'view:db',         'manage:timers',   'upload:images',
    'submit:queue',    'view:queue',
  ],
  player: [
    'view:characters',
    'view:db',
  ],
};

export function hasPermission(tier: string, perm: Permission): boolean {
  return (ROLE_PERMISSIONS[tier] ?? []).includes(perm);
}

export function requirePermission(perm: Permission): RequestHandler {
  return (req, res, next) => {
    if (!req.user) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!hasPermission(req.user.tier, perm)) {
      res.status(403).json({ error: `permission denied: ${perm}` });
      return;
    }
    next();
  };
}
