import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { Login } from './components/pages/Login';
import { Dashboard } from './components/pages/Dashboard';
import { Characters, CharacterDetail } from './components/pages/Characters';
import { Database } from './components/pages/Database';
import { Console } from './components/pages/Console';
import { Settings } from './components/pages/Settings';
import { Admin } from './components/pages/Admin';
import { Docker } from './components/pages/Docker';
import { GitHub } from './components/pages/GitHub';
import { LSB } from './components/pages/LSB';
import { Timers } from './components/pages/Timers';
import { Scripts } from './components/pages/Scripts';
import { Accounts } from './components/pages/Accounts';
import { RoE } from './components/pages/RoE';

// Lazy-loaded: Map pulls in PIXI.js (~the bulk of the bundle) — split it out
// so every other tab loads without it
const MapPage = React.lazy(() => import('./components/pages/Map').then(m => ({ default: m.MapPage })));

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<AppShell />}>
          <Route index element={<Dashboard />} />
          <Route path="chars" element={<Characters />} />
          <Route path="chars/:id" element={<CharacterDetail />} />
          <Route path="map" element={
            <React.Suspense fallback={<div style={{ padding: 24, color: 'var(--color-text3)' }}>Loading map…</div>}>
              <MapPage />
            </React.Suspense>
          } />
          <Route path="db" element={<Database />} />
          <Route path="console" element={<Console />} />
          <Route path="settings" element={<Settings />} />
          <Route path="admin" element={<Admin />} />
          <Route path="docker" element={<Docker />} />
          <Route path="github" element={<GitHub />} />
          <Route path="lsb" element={<LSB />} />
          <Route path="timers" element={<Timers />} />
          <Route path="scripts" element={<Scripts />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="roe" element={<RoE />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
