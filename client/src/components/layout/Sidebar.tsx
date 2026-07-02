import React from 'react';
import { NavLink } from 'react-router-dom';
import { useStore } from '../../store';

const NAV = [
  { to: '/',         icon: '⬡',  label: 'Dashboard' },
  { to: '/chars',    icon: '⚔',  label: 'Characters' },
  { to: '/map',      icon: '🗺',  label: 'Map' },
  { to: '/db',       icon: '📚', label: 'Database' },
  { to: '/timers',   icon: '⏱',  label: 'Timers' },
  { to: '/roe',      icon: '📜', label: 'RoE Records' },
  { to: '/console',  icon: '⌨',  label: 'Console' },
  { to: '/settings', icon: '⚙',  label: 'Settings' },
];

const ADMIN_NAV = [
  { to: '/admin',    icon: '🛡',  label: 'Admin' },
  { to: '/accounts', icon: '👤', label: 'Accounts' },
  { to: '/scripts',  icon: '📝', label: 'Scripts' },
  { to: '/docker',   icon: '🐳', label: 'Docker' },
  { to: '/github',   icon: '🐙', label: 'GitHub' },
  { to: '/lsb',      icon: '🔄', label: 'LSB' },
];

export function Sidebar() {
  const user   = useStore((s) => s.user);
  const stats  = useStore((s) => s.stats);
  const logout = useStore((s) => s.logout);

  const online = stats?.online_players ?? 0;

  return (
    <aside style={{
      width: 200,
      background: 'var(--color-surface)',
      borderRight: '1px solid var(--color-border)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
    }}>
      {/* Brand */}
      <div style={{ padding: '18px 16px 14px', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text1)', marginBottom: 2 }}>
          ⚔ FFXI Dashboard
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text3)' }}>
          <span style={{ color: 'var(--color-teal)', fontWeight: 600 }}>{online}</span> online
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '8px 8px', overflowY: 'auto' }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--color-text3)', padding: '8px 8px 6px' }}>
          General
        </div>
        {NAV.map((item) => (
          <SidebarLink key={item.to} {...item} />
        ))}

        {user?.tier === 'admin' && (
          <>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--color-text3)', padding: '14px 8px 6px' }}>
              Admin
            </div>
            {ADMIN_NAV.map((item) => (
              <SidebarLink key={item.to} {...item} />
            ))}
          </>
        )}
      </nav>

      {/* Footer */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            background: user?.tier === 'admin' ? 'rgba(240,160,80,.15)' : 'rgba(124,106,247,.15)',
            border: `1px solid ${user?.tier === 'admin' ? 'rgba(240,160,80,.3)' : 'rgba(124,106,247,.3)'}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, color: user?.tier === 'admin' ? 'var(--color-gold)' : 'var(--color-accent)',
          }}>
            {user?.login?.[0]?.toUpperCase() ?? '?'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.login}
            </div>
            <div style={{ fontSize: 10, color: user?.tier === 'admin' ? 'var(--color-gold)' : 'var(--color-accent)' }}>
              {user?.tier}
            </div>
          </div>
        </div>
        <button
          onClick={logout}
          className="btn btn-ghost btn-sm"
          style={{ width: '100%', justifyContent: 'center' }}
        >
          Log out
        </button>
      </div>
    </aside>
  );
}

function SidebarLink({ to, icon, label }: { to: string; icon: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 500,
        color: isActive ? 'var(--color-text1)' : 'var(--color-text3)',
        background: isActive ? 'var(--color-surface2)' : 'transparent',
        textDecoration: 'none',
        transition: 'all .12s',
        marginBottom: 2,
      })}
    >
      <span style={{ fontSize: 15, width: 20, textAlign: 'center' }}>{icon}</span>
      {label}
    </NavLink>
  );
}
