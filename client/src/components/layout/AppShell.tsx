import React, { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useStore } from '../../store';
import { api, getToken, refreshAccessToken } from '../../api';
import { useWS } from '../../hooks/useWS';

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

  if (!token) return null;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <Sidebar />
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </main>
    </div>
  );
}
