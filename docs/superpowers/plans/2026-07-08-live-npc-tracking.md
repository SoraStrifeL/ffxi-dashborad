# Live NPC Tracking on the Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire live NPC positions into the Map tab, mirroring the existing live mob-tracking pattern, using position data the server already broadcasts every ~1s.

**Architecture:** Single client-side change to `client/src/components/pages/Map.tsx`'s existing WS `positions` message handler. No backend changes — `dashboard_positions.json` → `startPosWatcher()` (`src/ws.ts`) → WS `positions` message already carries live NPC data; the client currently receives and discards it.

**Tech Stack:** React 18 + TypeScript (client/), no new dependencies.

## Global Constraints

- All backend fixes go in `src/routes/*.ts` / `src/*.ts` — never the deprecated root `server.js`. (Not applicable here — no backend changes in this plan.)
- Deploy only via `npm run docker:build && docker compose up -d --force-recreate`.
- `public/index.html`'s Vite-hashed bundle reference must be committed alongside any `Database.tsx`/`Map.tsx`/client change that triggers a rebuild — established repo convention (confirmed 7/7 unbroken on recent commits touching `Database.tsx`; the same build pipeline covers `Map.tsx`).
- This repo has no client test harness (no Vitest/RTL config under `client/`). `Map.tsx` changes are verified live only (build clean, deploy, exercise the feature in the browser via Playwright) — do not attempt to add client unit tests as part of this plan.

---

### Task 1: Wire live NPC positions into the Map tab's WS handler

**Files:**
- Modify: `client/src/components/pages/Map.tsx:706-722` (the `positions` WS message branch inside `wsHandler`)
- Modify: `public/index.html` (Vite bundle hash bump from the client rebuild — commit alongside, per Global Constraints)

**Interfaces:**
- Consumes: `PosEntry` (`client/src/types.ts:139-146`, fields `i,n,x,y,z,z_id`), `NpcEntry` (`client/src/types.ts:162-168`, fields `npcid,name,pos_x,pos_y,pos_z`), the existing `drawEntities(mobs: MobEntry[], npcs: NpcEntry[], lay: Layers, dFilter: number)` function (`client/src/components/pages/Map.tsx:337`).
- Produces: nothing consumed by other tasks — this is the only task in this plan.

This repo has no client test harness, so this task is verified live (build + deploy + Playwright) rather than with a unit test, matching the established pattern for every other `Map.tsx`/`Database.tsx` change in this project.

- [ ] **Step 1: Add the live-NPC branch to the `positions` WS handler**

Open `client/src/components/pages/Map.tsx` and find this exact block (currently lines 706-722):

```tsx
    if (type === 'positions' && zone !== null) {
      const pos = d as { players?: PosEntry[]; npcs?: PosEntry[]; mobs?: PosEntry[] };
      const liveMobs = (pos.mobs ?? []).filter((m) => m.z_id === zone && (m.x !== 0 || m.z !== 0));
      const updatedMobs: MobEntry[] = liveMobs.map((m) => {
        const st = mobStaticMapRef.current.get(m.i) ?? {};
        return { mobid: m.i, name: m.n, pos_x: m.x, pos_y: m.y, pos_z: m.z, ...st } as MobEntry;
      });
      // Pop/kill detection
      if (prevMobIdsRef.current.size > 0) {
        const curIds = new Set(updatedMobs.map((m) => m.mobid));
        updatedMobs.forEach((m) => { if (!prevMobIdsRef.current.has(m.mobid)) onMobPop(m); });
        prevMobIdsRef.current.forEach((id) => { if (!curIds.has(id)) onMobKill(prevMobNamesRef.current.get(id) ?? ''); });
      }
      prevMobNamesRef.current = new Map(updatedMobs.map((m) => [m.mobid, m.name]));
      prevMobIdsRef.current   = new Set(prevMobNamesRef.current.keys());
      drawEntities(updatedMobs, dbNpcs, layers, detectFilter);
    }
```

Replace it with (only the last two lines change — a new `liveNpcs`/`updatedNpcs` block is inserted before the `drawEntities` call, and `dbNpcs` in that call becomes `updatedNpcs`):

```tsx
    if (type === 'positions' && zone !== null) {
      const pos = d as { players?: PosEntry[]; npcs?: PosEntry[]; mobs?: PosEntry[] };
      const liveMobs = (pos.mobs ?? []).filter((m) => m.z_id === zone && (m.x !== 0 || m.z !== 0));
      const updatedMobs: MobEntry[] = liveMobs.map((m) => {
        const st = mobStaticMapRef.current.get(m.i) ?? {};
        return { mobid: m.i, name: m.n, pos_x: m.x, pos_y: m.y, pos_z: m.z, ...st } as MobEntry;
      });
      // Pop/kill detection
      if (prevMobIdsRef.current.size > 0) {
        const curIds = new Set(updatedMobs.map((m) => m.mobid));
        updatedMobs.forEach((m) => { if (!prevMobIdsRef.current.has(m.mobid)) onMobPop(m); });
        prevMobIdsRef.current.forEach((id) => { if (!curIds.has(id)) onMobKill(prevMobNamesRef.current.get(id) ?? ''); });
      }
      prevMobNamesRef.current = new Map(updatedMobs.map((m) => [m.mobid, m.name]));
      prevMobIdsRef.current   = new Set(prevMobNamesRef.current.keys());

      const liveNpcs = (pos.npcs ?? []).filter((n) => n.z_id === zone && (n.x !== 0 || n.z !== 0));
      const updatedNpcs: NpcEntry[] = liveNpcs.map((n) => ({
        npcid: n.i, name: n.n, pos_x: n.x, pos_y: n.y, pos_z: n.z,
      }));

      drawEntities(updatedMobs, updatedNpcs, layers, detectFilter);
    }
```

`NpcEntry` has no extra static-only fields to merge in (unlike `MobEntry`, which merges `aggro`/`detects`/`family`/`links`/`mJob` from `mobStaticMapRef`) — the `PosEntry` → `NpcEntry` mapping is a direct field rename, no static-data lookup needed. `dbNpcs` (React state, used for the sidebar NPC count badge, name search, and teleport-NPC list) is intentionally left untouched — only the value passed into `drawEntities` for drawing goes live, exactly matching how `dbMobs` already works today (mobs' live positions are computed into a local `updatedMobs` var each message and never written back to the `dbMobs` state either).

- [ ] **Step 2: Type-check and build**

Run: `npm run build:all`
Expected: exit 0, no TypeScript errors. `NpcEntry` and `PosEntry` are both already imported in `Map.tsx` (used by the existing mob branch and by `dbNpcs`'s type), so no new imports are needed.

- [ ] **Step 3: Deploy and verify live in the browser**

```bash
npm run docker:build
docker compose up -d --force-recreate
```

Then, using Playwright (headless chromium, login via the test admin account, click the "Map" sidebar link — do not `page.goto()` a client route directly, this is an SPA and direct navigation doesn't render the route), verify:

1. Select a populated zone (a zone with players/mobs/NPCs currently online — check `docker exec ffxi-dashboard node -e "const d=require('/ffxi-log/dashboard_positions.json'); console.log([...new Set(d.npcs.filter(n=>n.x||n.z).map(n=>n.z_id))].slice(0,10))"` for candidate zone IDs with live NPC data).
2. Confirm NPC dots render on the map (not just at their static snapshot positions — cross-check a couple of NPC coordinates from the rendered canvas state or exposed debug data against the current contents of `dashboard_positions.json` for that zone at the same moment).
3. Wait ~2-3s and confirm the WS `positions` message keeps arriving (e.g. via a `console.log` temporarily added and removed, or by observing a moving NPC's position update) without the page needing a manual refresh.
4. Switch to a different zone and back; confirm no stale NPC dots from the previous zone appear (the `filter((n) => n.z_id === zone ...)` should already prevent this, but verify — this guards against the exact class of bug fixed twice already this session in `Database.tsx`'s filter gating).
5. Confirm mob live-tracking (dot movement, pop/kill toasts) still works unaffected — this change touches the same code block as the existing mob logic, so a regression there is the most likely failure mode.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/pages/Map.tsx public/index.html
git commit -m "$(cat <<'EOF'
map: wire live NPC positions into the Map tab

Mobs and players already update in real time via the WS 'positions'
message (sourced from dashboard_positions.json, updated ~1s by LSB).
NPCs were the one gap: the server already broadcasts live NPC
positions in the same message, but Map.tsx discarded pos.npcs and
left NPC dots frozen at their initial zone-load snapshot. Mirrors the
existing mob live-tracking pattern; dbNpcs (sidebar count/search/
teleport list) stays backed by the static snapshot, matching how
dbMobs already works today.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** the spec's single requirement (wire `pos.npcs` into `drawEntities` the same way `pos.mobs` already is, no backend changes, no pop/kill log for NPCs) is fully covered by Task 1, Step 1.
- **No placeholders:** all code blocks are complete, copy-pasteable, and match the verified current file content exactly (re-read via the `Read` tool immediately before writing this plan).
- **Type consistency:** `NpcEntry`/`PosEntry`/`MobEntry` field names used in Step 1 match their definitions in `client/src/types.ts:139-168` exactly (`npcid`/`name`/`pos_x`/`pos_y`/`pos_z` for `NpcEntry`; `i`/`n`/`x`/`y`/`z`/`z_id` for `PosEntry`).
