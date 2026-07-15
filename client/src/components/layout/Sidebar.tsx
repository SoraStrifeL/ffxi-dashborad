import React, { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useStore } from '../../store';
import { api } from '../../api';
import { NAV, ADMIN_NAV } from '../../navConfig';

export type SidebarVariant = 'full' | 'rail' | 'drawer';

interface SidebarProps {
  variant: SidebarVariant;
  open?: boolean;
  onClose?: () => void;
  onNavigate?: () => void;
}

export function Sidebar({ variant, open = false, onClose, onNavigate }: SidebarProps) {
  const user   = useStore((s) => s.user);
  const perms  = useStore((s) => s.permissions);
  const stats  = useStore((s) => s.stats);
  const logout = useStore((s) => s.logout);

  const [ver, setVer] = useState<{ version: string; commit: string; buildDate: string } | null>(null);
  useEffect(() => { api.version().then(setVer).catch(() => {}); }, []);

  const isRail = variant === 'rail';
  const isDrawer = variant === 'drawer';
  const online = stats?.online_players ?? 0;

  // Close the drawer on Escape while it's open.
  useEffect(() => {
    if (!isDrawer || !open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDrawer, open, onClose]);

  const width = isRail ? 56 : 200;

  const asideStyle: React.CSSProperties = isDrawer
    ? {
        position: 'fixed',
        top: 0,
        bottom: 0,
        left: 0,
        width,
        background: 'var(--color-surface)',
        borderRight: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 100,
        transform: `translateX(${open ? '0' : '-100%'})`,
        visibility: open ? 'visible' : 'hidden',
        transition: 'transform .2s ease, visibility .2s ease',
      }
    : {
        width,
        background: 'var(--color-surface)',
        borderRight: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      };

  return (
    <>
      {isDrawer && open && (
        <div
          onClick={onClose}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 99 }}
        />
      )}
      <aside style={asideStyle} aria-hidden={isDrawer && !open}>
        {/* Brand */}
        <div style={{
          padding: isRail ? '18px 8px 14px' : '18px 16px 14px',
          borderBottom: '1px solid var(--color-border)',
          textAlign: isRail ? 'center' : 'left',
        }}>
          <div
            style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text1)', marginBottom: isRail ? 0 : 2 }}
            title={isRail ? 'FFXI Dashboard' : undefined}
          >
            {isRail ? '⚔' : '⚔ FFXI Dashboard'}
          </div>
          {!isRail && (
            <div style={{ fontSize: 11, color: 'var(--color-text3)' }}>
              <span style={{ color: 'var(--color-teal)', fontWeight: 600 }}>{online}</span> online
            </div>
          )}
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: '8px 8px', overflowY: 'auto' }}>
          {!isRail && (
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--color-text3)', padding: '8px 8px 6px' }}>
              General
            </div>
          )}
          {NAV.filter((item) => !item.perm || perms.includes(item.perm)).map((item) => (
            <SidebarLink key={item.to} {...item} isRail={isRail} onNavigate={onNavigate} />
          ))}

          {user?.tier === 'admin' && (
            <>
              {!isRail && (
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--color-text3)', padding: '14px 8px 6px' }}>
                  Admin
                </div>
              )}
              {ADMIN_NAV.map((item) => (
                <SidebarLink key={item.to} {...item} isRail={isRail} onNavigate={onNavigate} />
              ))}
            </>
          )}
        </nav>

        {/* Footer */}
        <div style={{ padding: isRail ? '12px 8px' : '12px 16px', borderTop: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, justifyContent: isRail ? 'center' : 'flex-start' }}>
            <div
              title={isRail ? `${user?.login ?? '?'} (${user?.tier ?? ''})` : undefined}
              style={{
                width: 28, height: 28, borderRadius: '50%',
                background: user?.tier === 'admin' ? 'rgba(240,160,80,.15)' : 'rgba(124,106,247,.15)',
                border: `1px solid ${user?.tier === 'admin' ? 'rgba(240,160,80,.3)' : 'rgba(124,106,247,.3)'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, color: user?.tier === 'admin' ? 'var(--color-gold)' : 'var(--color-accent)',
                flexShrink: 0,
              }}
            >
              {user?.login?.[0]?.toUpperCase() ?? '?'}
            </div>
            {!isRail && (
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user?.login}
                </div>
                <div style={{ fontSize: 10, color: user?.tier === 'admin' ? 'var(--color-gold)' : 'var(--color-accent)' }}>
                  {user?.tier}
                </div>
              </div>
            )}
          </div>
          <button
            onClick={logout}
            className="btn btn-ghost btn-sm"
            title={isRail ? 'Log out' : undefined}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {isRail ? '⏻' : 'Log out'}
          </button>
          {ver && !isRail && (
            <div
              title={`build ${ver.buildDate}`}
              style={{ marginTop: 8, textAlign: 'center', fontSize: 10, color: 'var(--color-text3)', fontFamily: 'var(--font-mono)' }}
            >
              v{ver.version} · {ver.commit.slice(0, 7)}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function SidebarLink({ to, icon, label, isRail, onNavigate }: {
  to: string; icon: string; label: string; isRail: boolean; onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      onClick={onNavigate}
      title={isRail ? label : undefined}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: isRail ? 0 : 10,
        justifyContent: isRail ? 'center' : 'flex-start',
        padding: isRail ? '10px 4px' : '8px 10px',
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
      {!isRail && label}
    </NavLink>
  );
}
