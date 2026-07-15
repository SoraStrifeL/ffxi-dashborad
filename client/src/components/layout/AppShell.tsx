import React, { useEffect, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useStore } from '../../store';
import { api, getToken, refreshAccessToken } from '../../api';
import { useWS } from '../../hooks/useWS';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { getPageTitle } from '../../navConfig';

// Seconds until the access token expires (Infinity if unreadable).
function secsToExpiry(token: string | null): number {
  if (!token) return Infinity;
  try {
    const p = JSON.parse(atob(token.split('.')[1] || ''));
    return typeof p.exp === 'number' ? p.exp - Date.now() / 1000 : Infinity;
  } catch { return Infinity; }
}

export function AppShell() {
  const token    = useStore((s) => s.token);
  const setUser  = useStore((s) => s.setUser);
  const setPermissions = useStore((s) => s.setPermissions);
  const logout   = useStore((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();

  const breakpoint = useBreakpoint();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useWS();

  useEffect(() => {
    if (!token) { navigate('/login', { replace: true }); return; }
    api.me().then(setUser).catch(() => { logout(); navigate('/login', { replace: true }); });
    api.mePermissions().then(r => setPermissions(r.permissions)).catch(() => setPermissions([]));
  }, [token, setUser, setPermissions, logout, navigate]);

  // Proactively refresh the short-lived access token before it expires, so
  // idle sessions and WebSocket reconnects always have a valid token.
  useEffect(() => {
    if (!token) return;
    const iv = setInterval(() => {
      if (secsToExpiry(getToken()) < 120) refreshAccessToken();
    }, 30_000);
    return () => clearInterval(iv);
  }, [token]);

  // Force-close the drawer on any breakpoint change, so resizing back down
  // to phone never shows a stale open drawer.
  useEffect(() => { setDrawerOpen(false); }, [breakpoint]);

  if (!token) return null;

  if (breakpoint === 'phone') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div style={{
          height: 48, flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '0 12px',
          background: 'var(--color-surface)',
          borderBottom: '1px solid var(--color-border)',
        }}>
          <button
            onClick={() => setDrawerOpen(true)}
            className="btn btn-ghost btn-sm"
            aria-label="Open navigation"
            style={{ padding: '4px 8px' }}
          >
            ☰
          </button>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text1)' }}>
            {getPageTitle(location.pathname)}
          </div>
        </div>
        <Sidebar
          variant="drawer"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onNavigate={() => setDrawerOpen(false)}
        />
        <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <Sidebar variant={breakpoint === 'tablet' ? 'rail' : 'full'} />
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </main>
    </div>
  );
}
