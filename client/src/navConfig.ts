export interface NavItem {
  to: string;
  icon: string;
  label: string;
  perm?: string;
}

// perm: required permission from /api/me/permissions; entries without one are
// visible to everyone (their read endpoints only need auth)
export const NAV: NavItem[] = [
  { to: '/',         icon: '⬡',  label: 'Dashboard' },
  { to: '/chars',    icon: '⚔',  label: 'Characters', perm: 'view:characters' },
  { to: '/map',      icon: '🗺',  label: 'Map',        perm: 'view:characters' },
  { to: '/db',       icon: '📚', label: 'Database',   perm: 'view:db' },
  { to: '/timers',   icon: '⏱',  label: 'Timers' },
  { to: '/roe',      icon: '📜', label: 'RoE Records' },
  { to: '/console',  icon: '⌨',  label: 'Console',    perm: 'run:console' },
  { to: '/settings', icon: '⚙',  label: 'Settings',   perm: 'manage:settings' },
];

export const ADMIN_NAV: NavItem[] = [
  { to: '/admin',    icon: '🛡',  label: 'Admin' },
  { to: '/accounts', icon: '👤', label: 'Accounts' },
  { to: '/scripts',  icon: '📝', label: 'Scripts' },
  { to: '/docker',   icon: '🐳', label: 'Docker' },
  { to: '/github',   icon: '🐙', label: 'GitHub' },
  { to: '/lsb',      icon: '🔄', label: 'LSB' },
];

// Longest `to` prefix match against pathname (so `/chars/5` resolves to the
// "Characters" entry); `/` only matches the exact root path.
export function getPageTitle(pathname: string): string {
  const all = [...NAV, ...ADMIN_NAV];
  let best: NavItem | null = null;
  for (const item of all) {
    if (item.to === '/') {
      if (pathname === '/') best = item;
      continue;
    }
    if (pathname === item.to || pathname.startsWith(item.to + '/')) {
      if (!best || item.to.length > best.to.length) best = item;
    }
  }
  return best?.label ?? 'Dashboard';
}
