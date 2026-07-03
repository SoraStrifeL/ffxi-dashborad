import React, { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useStore } from '../../store';
import { api } from '../../api';
import { useWS } from '../../hooks/useWS';

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
