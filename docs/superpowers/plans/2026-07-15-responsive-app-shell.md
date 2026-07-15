# Responsive App Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app shell (sidebar + surrounding frame) respond correctly at desktop, tablet, and phone widths, per `docs/superpowers/specs/2026-07-15-responsive-app-shell-design.md`.

**Architecture:** A `useBreakpoint()` hook resolves the viewport to `'desktop' | 'tablet' | 'phone'` via `matchMedia`. `AppShell` reads that value and renders `Sidebar` in one of three variants (`full` / `rail` / `drawer`); on phone width it also renders a slim top bar with a hamburger button. Nav item definitions (`NAV`/`ADMIN_NAV`) and a `getPageTitle()` helper move into a new shared `navConfig.ts` so both components can use them without duplication.

**Tech Stack:** React 18, TypeScript, react-router-dom v7 (`NavLink`, `useLocation`), inline styles (no CSS/Tailwind classes for this feature — see spec's "Approach" section for why).

## Global Constraints

- Breakpoints: `desktop` ≥ 1024px, `tablet` 768–1023px, `phone` < 768px (exact values from spec).
- Scope is shell-only: `AppShell.tsx`, `Sidebar.tsx`, plus the two new support files. No page-content files change.
- **No test framework exists in `client/`** (checked `client/package.json` — no vitest/jest/testing-library). Each task's verification step is `npx tsc -b --noEmit` (run from `client/`) for type correctness, plus a manual browser check via `npm run dev`, per this repo's CLAUDE.md guidance ("For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete"). This replaces automated TDD steps for this plan.
- Desktop (`full`) sidebar visuals must stay pixel-identical to the current `Sidebar.tsx` — no unrelated visual changes.

---

### Task 1: `useBreakpoint` hook

**Files:**
- Create: `client/src/hooks/useBreakpoint.ts`

**Interfaces:**
- Produces: `useBreakpoint(): 'desktop' | 'tablet' | 'phone'` — a React hook, imported by `AppShell.tsx` in Task 4.

- [ ] **Step 1: Write the hook**

```typescript
import { useState, useEffect } from 'react';

export type Breakpoint = 'desktop' | 'tablet' | 'phone';

const QUERIES: Record<Breakpoint, string> = {
  desktop: '(min-width: 1024px)',
  tablet: '(min-width: 768px) and (max-width: 1023px)',
  phone: '(max-width: 767px)',
};

function resolve(): Breakpoint {
  if (window.matchMedia(QUERIES.desktop).matches) return 'desktop';
  if (window.matchMedia(QUERIES.tablet).matches) return 'tablet';
  return 'phone';
}

export function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(resolve);

  useEffect(() => {
    const mqls = Object.values(QUERIES).map((q) => window.matchMedia(q));
    const onChange = () => setBreakpoint(resolve());
    mqls.forEach((mql) => mql.addEventListener('change', onChange));
    onChange();
    return () => mqls.forEach((mql) => mql.removeEventListener('change', onChange));
  }, []);

  return breakpoint;
}
```

- [ ] **Step 2: Type-check**

Run (from `client/`): `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/hooks/useBreakpoint.ts
git commit -m "feat: add useBreakpoint hook for responsive shell"
```

---

### Task 2: Shared nav config (`navConfig.ts`)

**Files:**
- Create: `client/src/navConfig.ts`
- Modify: `client/src/components/layout/Sidebar.tsx:1-27` (imports `NAV`/`ADMIN_NAV` instead of defining them; no other change in this task)

**Interfaces:**
- Consumes: nothing new.
- Produces: `NavItem` type, `NAV: NavItem[]`, `ADMIN_NAV: NavItem[]`, `getPageTitle(pathname: string): string` — all imported by `Sidebar.tsx` (this task) and `AppShell.tsx` (Task 4).

- [ ] **Step 1: Create the shared config file**

```typescript
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
```

- [ ] **Step 2: Update `Sidebar.tsx` to import from the new file**

In `client/src/components/layout/Sidebar.tsx`, replace lines 1–27 (the imports plus the local `NAV`/`ADMIN_NAV` array definitions) with:

```typescript
import React, { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useStore } from '../../store';
import { api } from '../../api';
import { NAV, ADMIN_NAV } from '../../navConfig';
```

Leave the rest of the file (the `Sidebar` and `SidebarLink` components) unchanged for now — variant support is added in Task 3.

- [ ] **Step 3: Type-check**

Run (from `client/`): `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual regression check**

Run `npm run dev` in `client/`, open the app in a desktop-width browser window, log in, and confirm the sidebar renders identically to before (same nav items, same admin section, same footer) — this task must not change any visible behavior.

- [ ] **Step 5: Commit**

```bash
git add client/src/navConfig.ts client/src/components/layout/Sidebar.tsx
git commit -m "refactor: extract shared nav config from Sidebar"
```

---

### Task 3: Sidebar variant support (`full` / `rail` / `drawer`)

**Files:**
- Modify: `client/src/components/layout/Sidebar.tsx` (full rewrite of the `Sidebar` and `SidebarLink` components below the imports from Task 2)

**Interfaces:**
- Consumes: `NAV`, `ADMIN_NAV` from `../../navConfig` (Task 2).
- Produces: `Sidebar(props: { variant: 'full' | 'rail' | 'drawer'; open?: boolean; onClose?: () => void; onNavigate?: () => void })` — the new prop signature `AppShell.tsx` will call in Task 4. `variant` is required; `open`/`onClose`/`onNavigate` are only meaningful (and only need to be passed) for `variant="drawer"`.

- [ ] **Step 1: Replace the rest of `Sidebar.tsx`**

Everything in the file from the `export function Sidebar()` line onward becomes:

```typescript
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
        transition: 'transform .2s ease',
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
      <aside style={asideStyle}>
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
```

- [ ] **Step 2: Type-check**

Run (from `client/`): `npx tsc -b --noEmit`
Expected: an error at the call site in `AppShell.tsx` (`<Sidebar />` with no `variant` prop) — expected at this point, since Task 4 hasn't updated the caller yet. Confirm the *only* error is that missing-prop error at `AppShell.tsx`, not something inside `Sidebar.tsx` itself.

- [ ] **Step 3: Temporary manual visual check (rail + drawer), then revert**

This variant logic can't be exercised for real until `AppShell.tsx` is wired up in Task 4, but it can be eyeballed now with a throwaway edit:

1. Temporarily change the `<Sidebar />` call in `client/src/components/layout/AppShell.tsx` to `<Sidebar variant="rail" />` and run `npm run dev`. Confirm: 56px-wide icon-only sidebar, hovering a nav icon shows its label as a native tooltip, admin section (if logged in as admin) still shows its icons.
2. Change it to `<Sidebar variant="drawer" open={true} onClose={() => {}} />`. Confirm: full-width sidebar rendered as an overlay on top of content with a dim backdrop behind it, and pressing Escape has no visible effect yet (there's no state wired to actually close — that's fine, Task 4 wires it for real).
3. Revert `AppShell.tsx` back to its original `<Sidebar />` call (or leave it — Task 4 rewrites this file's Sidebar call anyway, but don't commit an intermediate variant value).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/layout/Sidebar.tsx
git commit -m "feat: add full/rail/drawer variants to Sidebar"
```

(If Step 3 left a temporary edit in `AppShell.tsx`, make sure it's reverted — `git status` should show only `Sidebar.tsx` changed before this commit.)

---

### Task 4: `AppShell` responsive wiring + full verification

**Files:**
- Modify: `client/src/components/layout/AppShell.tsx` (full rewrite)

**Interfaces:**
- Consumes: `useBreakpoint()` from `../../hooks/useBreakpoint` (Task 1); `getPageTitle` from `../../navConfig` (Task 2); `Sidebar` with the `{ variant, open?, onClose?, onNavigate? }` props (Task 3).
- Produces: nothing new consumed elsewhere — `AppShell` is the route element mounted directly in `App.tsx`, already wired.

- [ ] **Step 1: Rewrite `AppShell.tsx`**

```typescript
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
```

- [ ] **Step 2: Type-check**

Run (from `client/`): `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification across all three breakpoints**

Run `npm run dev` in `client/`, open the app in a browser, log in, and use devtools' responsive/device toolbar (or just resize the window) to check each mode:

1. **Desktop (≥1024px width):** Sidebar is the full 200px version, identical to before this plan. No top bar above the content.
2. **Tablet (768–1023px width):** Sidebar narrows to a 56px icon-only rail. Hovering each icon shows its label as a tooltip. No top bar.
3. **Phone (<768px width):** No inline sidebar. A 48px top bar appears with a ☰ button and the current page's title (navigate to a few different tabs and confirm the title updates — e.g. "Database" on `/db`, "Characters" on `/chars`). Tapping ☰ slides the full sidebar in from the left with a dim backdrop behind it. Tapping the backdrop, pressing Escape, or clicking a nav link all close the drawer. Navigating via a drawer link actually changes the page (drawer closes and content updates).
4. **Resize check:** With the drawer open at phone width, widen the window past 768px — confirm the drawer/backdrop disappear and the rail/full sidebar takes over cleanly (no stuck overlay).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/layout/AppShell.tsx
git commit -m "feat: wire responsive breakpoints into AppShell (rail sidebar, phone drawer + top bar)"
```
