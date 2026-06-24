import { describe, it, expect } from 'vitest';
import { hasPermission, ROLE_PERMISSIONS, type Permission } from '../../src/rbac';

describe('ROLE_PERMISSIONS', () => {
  it('admin has all 12 permissions', () => {
    expect(ROLE_PERMISSIONS.admin).toHaveLength(12);
  });

  it('player has exactly view:characters and view:db', () => {
    expect(ROLE_PERMISSIONS.player).toEqual(
      expect.arrayContaining(['view:characters', 'view:db']),
    );
    expect(ROLE_PERMISSIONS.player).toHaveLength(2);
  });

  it('all permissions are unique within each role', () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      expect(new Set(perms).size, `${role} has duplicate permissions`).toBe(perms.length);
    }
  });
});

describe('hasPermission', () => {
  const adminPerms: Permission[] = [
    'view:characters', 'edit:characters',
    'view:accounts',   'manage:accounts',
    'run:console',     'manage:settings', 'manage:scripts',
    'view:db',         'manage:timers',   'upload:images',
    'submit:queue',    'view:queue',
  ];

  it.each(adminPerms)('admin has "%s"', perm => {
    expect(hasPermission('admin', perm)).toBe(true);
  });

  it('player has view:characters', () =>
    expect(hasPermission('player', 'view:characters')).toBe(true));
  it('player has view:db', () =>
    expect(hasPermission('player', 'view:db')).toBe(true));

  it.each([
    'manage:accounts', 'run:console', 'manage:settings',
    'manage:scripts',  'manage:timers', 'upload:images',
    'submit:queue',    'view:queue',  'edit:characters',
  ] as Permission[])('player does NOT have "%s"', perm => {
    expect(hasPermission('player', perm)).toBe(false);
  });

  it('unknown tier has no permissions', () => {
    expect(hasPermission('superuser', 'view:characters')).toBe(false);
    expect(hasPermission('', 'view:db')).toBe(false);
  });
});
