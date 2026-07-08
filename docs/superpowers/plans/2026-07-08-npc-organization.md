# NPC Organization Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Database tab's NPCs category two new ways to narrow the list: a Region filter (San d'Oria/Bastok/Windurst/Jeuno/Aht Urhgan/Adoulin — already implemented server-side, never wired up), and best-effort Role tags (Shop, Quest, Mission, Homepoint) inferred once at startup by scanning each NPC's own Lua script for distinctive `xi.*` API calls.

**Architecture:** A new backend module (`src/npc-roles.ts`) walks the LSB script tree once at server startup and classifies each NPC script by which of 4 known-reliable `xi.*` namespaces it calls. The resulting map is applied onto the in-memory `NPC_CATALOG` (a new `applyNpcRoles()` in `src/catalog.ts`), re-applied after every 5-minute DB refresh but never re-scanned from disk. `GET /api/db/npcs` gains `region`/`role` filter params (region was already implemented, just unused); a new `GET /api/db/npc-roles` exposes per-role counts so the client only renders chips for roles that actually have matches. The client adds two new chip rows to the NPCs toolbar and one new detail-panel row.

**Tech Stack:** Node.js `fs`/`path` (backend, `src/npc-roles.ts`, `src/catalog.ts`, `src/server.ts`, `src/routes/db.ts`), React 18 + TypeScript (client, `client/src/components/pages/Database.tsx`, `client/src/api.ts`), Vitest (new unit tests for the pure classification function).

## Global Constraints

- All backend changes go in `src/routes/*.ts` / `src/*.ts` — never the deprecated root `server.js` (per repo CLAUDE.md).
- Role detection reads from `SERVER_SCRIPTS_ROOT` (`src/catalog.ts:818`, env `LSB_SERVER_SCRIPTS_DIR`, default `/ffxi-server-scripts`) — **not** `LSB_SCRIPTS_DIR`. Same reasoning as the NPC Dialogue Display feature: only `SERVER_SCRIPTS_ROOT`'s mount has a `zones/` subtree at all.
- Only 4 roles are detected: `shop` (`xi.shop.`), `quest` (`xi.quest.`), `mission` (`xi.mission.`), `homepoint` (`xi.homepoint.`). There is deliberately **no** "guard" role — guard NPCs are not individually scripted, so no reliable signature exists. Do not add a Guard tag.
- Role classification is a **one-time startup scan**, not tied to the existing 5-minute `NPC_CATALOG` DB-refresh `setInterval` in `src/server.ts`. Lua script files on disk don't change at runtime.
- Missing `SERVER_SCRIPTS_ROOT` mount, a missing `zones/` subtree, or an individual unreadable script file must all degrade to an empty/partial result — never throw. Same convention as `src/npc-dialog.ts`'s `resolveNpcDialog`.
- Role filter chips are single-select (click one to filter, "All" to reset) and only rendered for roles with a non-zero count — same interaction/gating as the existing Items type-chip row.
- No new client-side test infrastructure — client changes are verified live (Playwright), not unit-tested, matching every prior `Database.tsx` change in this repo's history.
- Test credentials for live verification: `Sora` / `YourPassword1` (throwaway, admin tier).
- Baseline test count before this plan: **101/101** (`npx vitest run`, confirmed 2026-07-08).

---

### Task 1: Backend — `src/npc-roles.ts` module + unit tests

**Files:**
- Create: `src/npc-roles.ts`
- Test: `tests/unit/npc-roles.test.ts`

**Interfaces:**
- Consumes: `SERVER_SCRIPTS_ROOT` (exported `string`, `src/catalog.ts:818`) — read-only, not modified.
- Produces (consumed by Task 2):
  - `export const NPC_ROLE_PATTERNS: Record<string, RegExp>` (keys, in order: `shop`, `quest`, `mission`, `homepoint`)
  - `export function classifyNpcScript(source: string): string[]` — pure, no filesystem access, also used directly by unit tests
  - `export function scanNpcRoles(): Map<string, string[]>` — keyed `` `${zoneDirName}::${npcFileBaseName}` ``, values are non-empty role arrays only (entries with zero matched roles are omitted)

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/npc-roles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyNpcScript } from '../../src/npc-roles';

describe('classifyNpcScript', () => {
  it('detects a single role from a shop script', () => {
    const source = `
entity.onTrigger = function(player, npc)
    local stock = { { xi.item.FISH_MITHKABOB, 1134 } }
    xi.shop.general(player, stock, xi.fameArea.WINDURST)
end
`;
    expect(classifyNpcScript(source)).toEqual(['shop']);
  });

  it('detects multiple roles, in fixed order, when a script references more than one namespace', () => {
    const source = `
entity.onTrigger = function(player, npc)
    if player:getQuestStatus(xi.quest.log.WINDURST, xi.quest.id.windurst.SOME_QUEST) == xi.questStatus.QUEST_ACCEPTED then
        xi.shop.general(player, stock)
    end
end
`;
    expect(classifyNpcScript(source)).toEqual(['shop', 'quest']);
  });

  it('detects mission and homepoint roles independently', () => {
    expect(classifyNpcScript('xi.mission.getMissionStatus(player, xi.mission.log_id.WINDURST)')).toEqual(['mission']);
    expect(classifyNpcScript('xi.homepoint.set(player, npc)')).toEqual(['homepoint']);
  });

  it('returns an empty array for a script matching no known role', () => {
    expect(classifyNpcScript('entity.onTrigger = function(player, npc) player:showText(npc, ID.text.GREETING) end')).toEqual([]);
  });

  it('does not false-positive on unrelated text containing "shop" without the xi.shop. prefix', () => {
    expect(classifyNpcScript('-- This NPC used to run a shopping errand, not implemented')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/npc-roles.test.ts`
Expected: FAIL — `Cannot find module '../../src/npc-roles'` (the file doesn't exist yet).

- [ ] **Step 3: Write `src/npc-roles.ts`**

```ts
// ════════════════════════════════════════════════════════════════════
//  npc-roles.ts — best-effort NPC role classification from the LSB
//  script tree
//  ────────────────────────────────────────────────────────────────────
//  LSB has no DB column for what an NPC "does" — that's entirely
//  encoded in each NPC's Lua script. This module scans every NPC
//  script once and tags it with whichever of a small set of reliable
//  xi.* API namespaces it calls: xi.shop.* (vendor), xi.quest.*,
//  xi.mission.*, xi.homepoint.*. An NPC can match more than one.
//  There is no reliable signature for "guard" — guard NPCs are not
//  individually scripted — so that role is intentionally not detected.
//
//  Uses SERVER_SCRIPTS_ROOT (not LSB_SCRIPTS_DIR) — same reasoning as
//  npc-dialog.ts: only that mount's scripts tree has a zones/ subtree.
// ════════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import { SERVER_SCRIPTS_ROOT } from './catalog';

export const NPC_ROLE_PATTERNS: Record<string, RegExp> = {
  shop: /xi\.shop\./,
  quest: /xi\.quest\./,
  mission: /xi\.mission\./,
  homepoint: /xi\.homepoint\./,
};

/** Which of the known roles a script's source matches, in NPC_ROLE_PATTERNS'
 *  fixed key order (shop, quest, mission, homepoint). Pure — no filesystem
 *  access, safe to unit test directly. */
export function classifyNpcScript(source: string): string[] {
  return Object.keys(NPC_ROLE_PATTERNS).filter((role) => NPC_ROLE_PATTERNS[role].test(source));
}

/** Walks every zones/<Zone>/npcs/*.lua file once and classifies each.
 *  Keyed `${zoneDirName}::${npcFileBaseName}` (exact match only — this is
 *  a bulk pass over the whole tree, not the single-NPC fuzzy lookup
 *  resolveNpcDialog does in npc-dialog.ts). Missing SERVER_SCRIPTS_ROOT/
 *  zones, a zone with no npcs/ subdir, or an individual unreadable file
 *  all degrade to skipping that entry — never throws. Entries with zero
 *  matched roles are omitted from the map. */
export function scanNpcRoles(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const zonesDir = path.join(SERVER_SCRIPTS_ROOT, 'zones');
  let zoneDirs: string[] = [];
  try {
    zoneDirs = fs.readdirSync(zonesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return map; // scripts tree not mounted — empty map, matches this repo's mount-degradation convention
  }

  for (const zoneName of zoneDirs) {
    const npcsDir = path.join(zonesDir, zoneName, 'npcs');
    let files: string[] = [];
    try {
      files = fs.readdirSync(npcsDir).filter((f) => f.endsWith('.lua'));
    } catch {
      continue; // this zone has no npcs/ subdirectory
    }
    for (const file of files) {
      try {
        const source = fs.readFileSync(path.join(npcsDir, file), 'utf8');
        const roles = classifyNpcScript(source);
        if (roles.length) map.set(`${zoneName}::${file.replace(/\.lua$/, '')}`, roles);
      } catch {
        // one unreadable/malformed script shouldn't abort the whole scan
      }
    }
  }
  return map;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/npc-roles.test.ts`
Expected: PASS, 5/5 tests.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `npm test`
Expected: PASS, 106/106 (was 101/101 before this task — 5 new tests).

- [ ] **Step 6: Live sanity check against the real mounted scripts tree**

```bash
cd /home/sora/Downloads/ffxi-dashboard
LSB_SERVER_SCRIPTS_DIR=/home/sora/ffxi/scripts npx tsx -e "
import { scanNpcRoles } from './src/npc-roles';
const map = scanNpcRoles();
console.log('total classified scripts:', map.size);
console.log('Kazham::Nuh_Celodehki ->', map.get('Kazham::Nuh_Celodehki'));
"
```

(If `tsx` isn't available, use `npx ts-node` instead — same syntax.)

Expected output: `total classified scripts:` some number greater than 0 (order of several hundred, per the design spec's counts: ~279 shop + 282 quest + 103 mission + 121 homepoint scripts, with overlap), and `Kazham::Nuh_Celodehki -> [ 'shop' ]` (this NPC's script calls `xi.shop.general(...)`, verified directly against `/home/sora/ffxi/scripts/zones/Kazham/npcs/Nuh_Celodehki.lua` during design).

- [ ] **Step 7: Commit**

```bash
git add src/npc-roles.ts tests/unit/npc-roles.test.ts
git commit -m "$(cat <<'EOF'
feat: add NPC role classification module

Scans every NPC script once at import time and tags it with whichever
of 4 reliable xi.* API namespaces it calls (xi.shop./xi.quest./
xi.mission./xi.homepoint.) — LSB has no DB column for NPC "role", it's
entirely encoded in each NPC's own Lua script. No Guard role: guard
NPCs aren't individually scripted, so there's no reliable signature.

Uses SERVER_SCRIPTS_ROOT, not LSB_SCRIPTS_DIR — same reasoning as
npc-dialog.ts.
EOF
)"
```

---

### Task 2: Backend — wire role classification into the catalog + add `region`/`role` filtering routes

**Files:**
- Modify: `src/catalog.ts` (add `applyNpcRoles` export, directly after `loadNpcCatalog`)
- Modify: `src/server.ts` (import `scanNpcRoles`/`applyNpcRoles`, wire into startup + the 5-minute refresh interval)
- Modify: `src/routes/db.ts` (add `role` filter param to `/api/db/npcs`; add new `/api/db/npc-roles` route)

**Interfaces:**
- Consumes: `scanNpcRoles` from Task 1 (`./npc-roles`).
- Produces (consumed by Task 3):
  - Each `NPC_CATALOG` row gains a `role: string[]` field.
  - `GET /api/db/npcs?region=<key>&role=<role>` — both optional, combine with existing `q`/`zone` params.
  - `GET /api/db/npc-roles` → `{ role: string; cnt: number }[]`, always all 4 known roles (some may be `0`).

- [ ] **Step 1: Add `applyNpcRoles` to `src/catalog.ts`**

Find the end of `loadNpcCatalog` (currently ends around line 184):

```ts
export async function loadNpcCatalog(pool: Pool): Promise<void> {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(`
      SELECT n.npcid, CONVERT(n.name USING utf8) AS name, z.name AS zone, z.zoneid,
             ROUND(n.pos_x,2) AS x, ROUND(n.pos_y,2) AS y, ROUND(n.pos_z,2) AS z
      FROM npc_list n
      JOIN zone_settings z ON ((n.npcid>>12)&0xFFF)=z.zoneid
      WHERE n.name IS NOT NULL AND n.name NOT LIKE 'NPC[%'
      ORDER BY n.name`);
    NPC_CATALOG = rows;
    console.log(`[catalog] ${NPC_CATALOG.length} NPC entries loaded`);
  } catch (e) { console.error('[catalog] NPC load error:', (e as Error).message); }
}
```

Add directly after its closing `}`:

```ts
/** Attaches each NPC's inferred role tags onto the in-memory NPC_CATALOG
 *  rows, from a role map computed once at startup by npc-roles.ts's
 *  scanNpcRoles() (passed in by the caller, src/server.ts). Runs after
 *  every loadNpcCatalog() refresh so DB-driven catalog reloads don't wipe
 *  the role field — but this function itself never re-scans the script
 *  tree, since Lua files on disk don't change at runtime. */
export function applyNpcRoles(roleMap: Map<string, string[]>): void {
  for (const row of NPC_CATALOG) {
    row.role = roleMap.get(`${row.zone}::${row.name}`) || [];
  }
}
```

- [ ] **Step 2: Wire it into `src/server.ts`**

Find:

```ts
import { buildZoneMaps, loadMobCatalog, loadNpcCatalog, loadZoneCache, loadExpTable } from './catalog';
```

Replace with:

```ts
import { buildZoneMaps, loadMobCatalog, loadNpcCatalog, loadZoneCache, loadExpTable, applyNpcRoles } from './catalog';
import { scanNpcRoles } from './npc-roles';
```

Find:

```ts
async function loadCatalogs(): Promise<void> {
  await buildZoneMaps(pool);
  await loadExpTable(pool);
  await Promise.all([loadMobCatalog(pool), loadNpcCatalog(pool), loadZoneCache(pool)]);
}
```

Replace with:

```ts
// NPC role tags are derived from static Lua script files, not the DB, so
// they're scanned once here rather than on every 5-minute NPC_CATALOG DB
// refresh below — the script tree doesn't change at runtime.
const npcRoleMap = scanNpcRoles();

async function loadCatalogs(): Promise<void> {
  await buildZoneMaps(pool);
  await loadExpTable(pool);
  await Promise.all([loadMobCatalog(pool), loadNpcCatalog(pool), loadZoneCache(pool)]);
  applyNpcRoles(npcRoleMap);
}
```

Find:

```ts
setInterval(() => { loadMobCatalog(pool).catch(() => {}); loadNpcCatalog(pool).catch(() => {}); }, 5 * 60_000);
```

Replace with:

```ts
setInterval(() => { loadMobCatalog(pool).catch(() => {}); loadNpcCatalog(pool).then(() => applyNpcRoles(npcRoleMap)).catch(() => {}); }, 5 * 60_000);
```

- [ ] **Step 3: Add the `role` filter param and the new counts route in `src/routes/db.ts`**

Find:

```ts
  router.get('/api/db/npcs', requireAuth, (req, res) => {
    const q      = ((req.query.q as string) || '').trim().toLowerCase();
    const zone   = ((req.query.zone as string) || '').trim().toLowerCase();
    const region = (req.query.region as string) || null;
    const sort   = (req.query.sort as string) || '';
    const page   = Math.max(0, parseInt((req.query.page as string) || '0'));
    let rows = NPC_CATALOG;
    if (q)      rows = rows.filter(r => (r.name as string).toLowerCase().includes(q));
    if (zone)   rows = rows.filter(r => r.zone && (r.zone as string).toLowerCase().includes(zone));
    if (region) rows = rows.filter(r => _mobRegionMatch((r.zone as string) || '', region));
    const NPC_SORT = new Set(['npcid', 'name', 'zone', 'x', 'z']);
    if (NPC_SORT.has(sort)) rows = [...rows].sort(cmpBy(sort, sortDir(req)));
    res.json(rows.slice(page * DB_PAGE, page * DB_PAGE + DB_PAGE).map(r => ({ ...r, _total: undefined })));
  });
```

Replace with:

```ts
  router.get('/api/db/npcs', requireAuth, (req, res) => {
    const q      = ((req.query.q as string) || '').trim().toLowerCase();
    const zone   = ((req.query.zone as string) || '').trim().toLowerCase();
    const region = (req.query.region as string) || null;
    const role   = (req.query.role as string) || null;
    const sort   = (req.query.sort as string) || '';
    const page   = Math.max(0, parseInt((req.query.page as string) || '0'));
    let rows = NPC_CATALOG;
    if (q)      rows = rows.filter(r => (r.name as string).toLowerCase().includes(q));
    if (zone)   rows = rows.filter(r => r.zone && (r.zone as string).toLowerCase().includes(zone));
    if (region) rows = rows.filter(r => _mobRegionMatch((r.zone as string) || '', region));
    if (role)   rows = rows.filter(r => ((r.role as string[]) || []).includes(role));
    const NPC_SORT = new Set(['npcid', 'name', 'zone', 'x', 'z']);
    if (NPC_SORT.has(sort)) rows = [...rows].sort(cmpBy(sort, sortDir(req)));
    res.json(rows.slice(page * DB_PAGE, page * DB_PAGE + DB_PAGE).map(r => ({ ...r, _total: undefined })));
  });

  router.get('/api/db/npc-roles', requireAuth, (_req, res) => {
    const counts: Record<string, number> = { shop: 0, quest: 0, mission: 0, homepoint: 0 };
    for (const row of NPC_CATALOG) {
      for (const role of (row.role as string[]) || []) {
        if (role in counts) counts[role]++;
      }
    }
    res.json(Object.entries(counts).map(([role, cnt]) => ({ role, cnt })));
  });
```

- [ ] **Step 4: Rebuild**

```bash
cd /home/sora/Downloads/ffxi-dashboard
npm run build:all
```

Expected: exit 0, no TypeScript errors.

- [ ] **Step 5: Deploy and verify live via curl**

```bash
npm run docker:build && docker compose up -d --force-recreate
docker compose logs --tail=20 dashboard
```

Expected: `FFXI Dashboard running on port 3000`, no errors, no stack traces from the startup role scan.

```bash
TOK=$(curl -s -X POST http://localhost:3001/api/login -H 'Content-Type: application/json' -d '{"login":"Sora","password":"YourPassword1"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Counts endpoint — all 4 roles present, each with a positive count
curl -s "http://localhost:3001/api/db/npc-roles" -H "Authorization: Bearer $TOK" | python3 -m json.tool

# Role filter — every returned row's role array must include "shop"
curl -s "http://localhost:3001/api/db/npcs?role=shop&page=0" -H "Authorization: Bearer $TOK" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
assert len(rows) > 0, 'expected at least one shop NPC'
assert all('shop' in r.get('role', []) for r in rows), 'found a row missing the shop role'
print(f'OK: {len(rows)} rows, all tagged shop, e.g. {rows[0][\"name\"]} in {rows[0][\"zone\"]}')
"

# Region filter — every returned row's zone must be a Bastok zone
curl -s "http://localhost:3001/api/db/npcs?region=bastok&page=0" -H "Authorization: Bearer $TOK" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
assert len(rows) > 0, 'expected at least one Bastok NPC'
assert all('bastok' in r['zone'].lower() for r in rows), 'found a row outside Bastok'
print(f'OK: {len(rows)} rows, all in Bastok, e.g. {rows[0][\"name\"]} in {rows[0][\"zone\"]}')
"
```

Expected: `/api/db/npc-roles` returns 4 entries (`shop`, `quest`, `mission`, `homepoint`) with counts roughly matching the design spec's script-file counts (279/282/103/121) — possibly somewhat lower, since the DB↔script match here is exact-name-only (no fuzzy fallback), so a handful of NPCs whose DB name doesn't exactly match their script filename won't be tagged; that's expected, not a bug. Both `role=shop` and `region=bastok` scripts print `OK: ...` with no assertion errors.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS, 106/106 (unchanged from Task 1 — this task is backend-wiring/route-only, no new unit tests, covered by the live curl checks above per this repo's established convention for `src/routes/*.ts` route additions).

- [ ] **Step 7: Commit**

```bash
git add src/catalog.ts src/server.ts src/routes/db.ts
git commit -m "$(cat <<'EOF'
routes: filter NPCs by region/role, add GET /api/db/npc-roles

Wires npc-roles.ts's scanNpcRoles() into NPC_CATALOG (applied once at
startup and after every 5-minute DB refresh, but never re-scanning the
script tree itself — Lua files don't change at runtime). Exposes the
result as a new ?role= filter on GET /api/db/npcs, alongside the
existing ?region= param which was already implemented server-side but
never used by any client. New GET /api/db/npc-roles returns per-role
counts so the client can gate which filter chips it renders.
EOF
)"
```

---

### Task 3: Client — Region + Role filter chips, and a Roles row in the NPC detail panel

**Files:**
- Modify: `client/src/api.ts` (add one helper)
- Modify: `client/src/components/pages/Database.tsx`
  - Module-level constants (~line 626, after `WEAPON_SKILL_NAMES`)
  - `chipBtn` helper (~line 649) — add a string-keyed sibling
  - State declarations (~line 148-156)
  - Data fetch (~line 185)
  - `load()` params + both dependency arrays (~line 198-249)
  - `selectCat` (~line 419-421)
  - Toolbar JSX (~line 484-489, after the existing quest-log filter row)
  - `DetailView`'s `cat === 'npcs'` case (~line 837-843)

**Interfaces:**
- Consumes: `api.dbNpcRoles` (new), Task 2's `GET /api/db/npc-roles`; Task 2's `?region=`/`?role=` params on `GET /api/db/npcs` (via the existing generic `api.dbNpcs(params)` call, no signature change needed there).
- Produces: nothing consumed by a later task — this is the last task in the plan.

- [ ] **Step 1: Add the API helper**

In `client/src/api.ts`, find:

```ts
  dbItemTypes: () => req<{ type: number; cnt: number }[]>('/api/db/item-types'),
```

Add directly after it:

```ts
  dbItemTypes: () => req<{ type: number; cnt: number }[]>('/api/db/item-types'),
  dbNpcRoles: () => req<{ role: string; cnt: number }[]>('/api/db/npc-roles'),
```

- [ ] **Step 2: Add the static region/role label constants**

In `client/src/components/pages/Database.tsx`, find:

```ts
// item_weapon.skill values — verified live against GET /api/db/items?type=7&skill=N
// for N=1..15, matches /home/sora/ffxi/sql/item_basic.sql's AH weapon category list.
const WEAPON_SKILL_NAMES: Record<number, string> = {
  1: 'H2H', 2: 'Dagger', 3: 'Sword', 4: 'Greatsword', 5: 'Axe', 6: 'Greataxe',
  7: 'Scythe', 8: 'Polearm', 9: 'Katana', 10: 'Greatkatana', 11: 'Club',
  12: 'Staff', 13: 'Bow', 14: 'Instrument', 15: 'Ammunition',
};
```

Add directly after it:

```ts
// Matches src/catalog.ts's NPC_REGION_SQL keys exactly — six geographic
// regions the backend already filters NPCs/Mobs by (?region=), just never
// wired up in the client until now.
const NPC_REGIONS: { key: string; label: string }[] = [
  { key: 'san_doria', label: "San d'Oria" },
  { key: 'bastok', label: 'Bastok' },
  { key: 'windurst', label: 'Windurst' },
  { key: 'jeuno', label: 'Jeuno' },
  { key: 'aht_urhgan', label: 'Aht Urhgan' },
  { key: 'adoulin', label: 'Adoulin' },
];

// Matches the role keys src/npc-roles.ts's classifyNpcScript can return.
const NPC_ROLE_LABELS: Record<string, string> = {
  shop: 'Shop', quest: 'Quest', mission: 'Mission', homepoint: 'Homepoint',
};
```

- [ ] **Step 3: Add a string-keyed sibling to `chipBtn`**

`chipBtn` only accepts `number | null` values; region/role filters use string keys. Find:

```ts
function chipBtn(label: string, value: number | null, current: number | null, set: (v: number | null) => void) {
  const active = value === current;
  return (
    <button key={String(value)} onClick={() => set(active ? null : value)}
      style={{ padding: '3px 9px', borderRadius: 20, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer',
        background: active ? 'var(--color-accent)' : 'var(--color-surface2)',
        color: active ? '#fff' : 'var(--color-text3)' }}>
      {label}
    </button>
  );
}
```

Add directly after it:

```ts
function chipBtnStr(label: string, value: string | null, current: string | null, set: (v: string | null) => void) {
  const active = value === current;
  return (
    <button key={String(value)} onClick={() => set(active ? null : value)}
      style={{ padding: '3px 9px', borderRadius: 20, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer',
        background: active ? 'var(--color-accent)' : 'var(--color-surface2)',
        color: active ? '#fff' : 'var(--color-text3)' }}>
      {label}
    </button>
  );
}
```

- [ ] **Step 4: Add state**

Find:

```ts
  const [zoneFilter, setZoneFilter] = useState('');
  const [jobFilter, setJobFilter] = useState<number | null>(null);
```

Replace with:

```ts
  const [zoneFilter, setZoneFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [jobFilter, setJobFilter] = useState<number | null>(null);
```

Find:

```ts
  const [itemTypes, setItemTypes] = useState<{ type: number; cnt: number }[]>([]);
  const [questLogs, setQuestLogs] = useState<{ logId: number; name: string; total: number }[]>([]);
```

Replace with:

```ts
  const [itemTypes, setItemTypes] = useState<{ type: number; cnt: number }[]>([]);
  const [npcRoles, setNpcRoles] = useState<{ role: string; cnt: number }[]>([]);
  const [questLogs, setQuestLogs] = useState<{ logId: number; name: string; total: number }[]>([]);
```

- [ ] **Step 5: Fetch role counts once**

Find:

```ts
  useEffect(() => { api.dbItemTypes().then(setItemTypes).catch(() => {}); }, []);
```

Add directly after it:

```ts
  useEffect(() => { api.dbItemTypes().then(setItemTypes).catch(() => {}); }, []);
  useEffect(() => { api.dbNpcRoles().then(setNpcRoles).catch(() => {}); }, []);
```

- [ ] **Step 6: Wire the params into `load()`**

Find:

```ts
    if (cat === 'items' && rareExFilter) params.rareex = 1;
    if (cat === 'quests' && questLogFilter !== null) params.log = questLogFilter;
```

Replace with:

```ts
    if (cat === 'items' && rareExFilter) params.rareex = 1;
    if (cat === 'npcs' && regionFilter) params.region = regionFilter;
    if (cat === 'npcs' && roleFilter) params.role = roleFilter;
    if (cat === 'quests' && questLogFilter !== null) params.log = questLogFilter;
```

Find:

```ts
  }, [cat, page, search, zoneFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]);

  useEffect(() => { load(true); }, [cat, zoneFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

Replace with:

```ts
  }, [cat, page, search, zoneFilter, regionFilter, roleFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]);

  useEffect(() => { load(true); }, [cat, zoneFilter, regionFilter, roleFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 7: Reset both filters on category switch**

Find:

```ts
  function selectCat(key: Category) {
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setRareExFilter(false); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
  }
```

Replace with:

```ts
  function selectCat(key: Category) {
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setRegionFilter(null); setRoleFilter(null); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setRareExFilter(false); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
  }
```

- [ ] **Step 8: Render the Region and Role chip rows**

Find the existing quest-log filter row, which is the last row in the toolbar's filter-rows block:

```ts
        {hasQuestLogFilter && questLogs.length > 0 && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, questLogFilter, setQuestLogFilter)}
            {questLogs.filter(l => l.total > 0).map(l => chipBtn(l.name, l.logId, questLogFilter, setQuestLogFilter))}
          </div>
        )}
        </div>
```

Replace with:

```ts
        {hasQuestLogFilter && questLogs.length > 0 && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, questLogFilter, setQuestLogFilter)}
            {questLogs.filter(l => l.total > 0).map(l => chipBtn(l.name, l.logId, questLogFilter, setQuestLogFilter))}
          </div>
        )}
        {cat === 'npcs' && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All regions', null, regionFilter, setRegionFilter)}
            {NPC_REGIONS.map(r => chipBtnStr(r.label, r.key, regionFilter, setRegionFilter))}
          </div>
        )}
        {cat === 'npcs' && npcRoles.some(r => r.cnt > 0) && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All roles', null, roleFilter, setRoleFilter)}
            {npcRoles.filter(r => r.cnt > 0).map(r => chipBtnStr(NPC_ROLE_LABELS[r.role] ?? r.role, r.role, roleFilter, setRoleFilter))}
          </div>
        )}
        </div>
```

- [ ] **Step 9: Show roles in the NPC detail panel**

Find:

```ts
  if (cat === 'npcs') {
    return (
      <div>
        {data.npcid != null && <DRow k="NPC ID" v={String(data.npcid)} />}
        {data.zone  != null && <DRow k="Zone" v={fmtName(String(data.zone))} />}
        {data.x     != null && <DRow k="X" v={Number(data.x).toFixed(2)} />}
        {data.z     != null && <DRow k="Z" v={Number(data.z).toFixed(2)} />}
        <div style={{ marginTop: 10 }}>
```

Replace with:

```ts
  if (cat === 'npcs') {
    const roles = Array.isArray(data.role) ? (data.role as string[]) : [];
    return (
      <div>
        {data.npcid != null && <DRow k="NPC ID" v={String(data.npcid)} />}
        {data.zone  != null && <DRow k="Zone" v={fmtName(String(data.zone))} />}
        {data.x     != null && <DRow k="X" v={Number(data.x).toFixed(2)} />}
        {data.z     != null && <DRow k="Z" v={Number(data.z).toFixed(2)} />}
        {roles.length > 0 && <DRow k="Roles" v={roles.map(r => NPC_ROLE_LABELS[r] ?? r).join(', ')} />}
        <div style={{ marginTop: 10 }}>
```

(The rest of the `cat === 'npcs'` block — the Dialogue section — is unchanged.)

- [ ] **Step 10: Rebuild**

```bash
cd /home/sora/Downloads/ffxi-dashboard
npm run build:all
```

Expected: exit 0, no TypeScript errors.

- [ ] **Step 11: Deploy and verify live**

```bash
npm run docker:build && docker compose up -d --force-recreate
```

Using Playwright (chromium at `/home/sora/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`, `playwright-core` in the scratchpad's `node_modules`), log in as `Sora`/`YourPassword1`, open Database → NPCs. Confirm:
- Two new chip rows appear below the existing search/zone-dropdown toolbar: "All regions / San d'Oria / Bastok / Windurst / Jeuno / Aht Urhgan / Adoulin" and "All roles / Shop / Quest / Mission / Homepoint" (only roles with `cnt > 0` show — all 4 are expected to have matches).
- Click "Bastok" — the row count drops and every visible row's Zone column contains "Bastok".
- Click "Shop" — the row count drops again (combines with the region filter); open a row and confirm its detail panel shows a "Roles" line containing "Shop".
- Click "All regions" and "All roles" to reset both — row count returns to the unfiltered total.
- Open an NPC with no detected role (e.g. a random Southern San d'Oria one) and confirm the detail panel simply omits the "Roles" line (no "None" clutter) while Dialogue still renders normally below it.

- [ ] **Step 12: Commit**

```bash
git add client/src/api.ts client/src/components/pages/Database.tsx
git commit -m "$(cat <<'EOF'
database: add NPC Region and Role filter chips

Region chips (San d'Oria/Bastok/Windurst/Jeuno/Aht Urhgan/Adoulin) use
the ?region= param that already existed server-side but no client ever
called. Role chips (Shop/Quest/Mission/Homepoint) use the new ?role=
param backed by npc-roles.ts's script classification, gated to only
show roles with at least one match. Both combine freely with the
existing zone dropdown and search box. Detail panel gains a "Roles"
line when an NPC has any detected role.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Design spec's "Backend changes" (`src/npc-roles.ts`, `applyNpcRoles`, startup-only scanning, `region`/`role` params, `/api/db/npc-roles`) → Tasks 1-2. "Client changes" (state, chips, `api.ts` helper, detail panel row) → Task 3. Decision 1 (all 4 roles, no Guard) → Task 1's `NPC_ROLE_PATTERNS`. Decision 2 (region alongside roles) → Task 3 Step 8. Decision 3 (startup-only scan, not the 5-min interval) → Task 2 Step 2. Decision 4 (single-select role chips) → Task 3's `chipBtnStr` reuse (identical single-select interaction to every other chip row in this file). Decision 5 (count-gated role chips) → Task 3 Step 8's `npcRoles.some(r => r.cnt > 0)` / `.filter(r => r.cnt > 0)`. Decision 6 (detail panel shows roles only when non-empty, no explicit empty-state) → Task 3 Step 9.
- **Placeholder scan:** No TBD/TODO; every step has literal, complete code.
- **Type consistency:** `NPC_ROLE_PATTERNS`/`classifyNpcScript`/`scanNpcRoles` (Task 1) are consumed as-is by Task 2's `applyNpcRoles(roleMap: Map<string, string[]>)` and `scanNpcRoles()` call in `server.ts` — same `Map<string, string[]>` shape throughout. `row.role: string[]` (Task 2) matches what Task 3's client expects on each NPC row (`Array.isArray(data.role)` / `params.role` filter) and what `/api/db/npc-roles`'s `{role, cnt}[]` shape (Task 2) matches `api.dbNpcRoles()`'s return type (Task 3 Step 1) and the `npcRoles` state type (Task 3 Step 4). Role key strings (`shop`/`quest`/`mission`/`homepoint`) are identical across `NPC_ROLE_PATTERNS` (Task 1), the `/api/db/npc-roles` counts object (Task 2), and `NPC_ROLE_LABELS` (Task 3) — no renaming drift. `NPC_REGIONS` keys (`san_doria`/`bastok`/`windurst`/`jeuno`/`aht_urhgan`/`adoulin`, Task 3) match `NPC_REGION_SQL`'s existing keys in `src/catalog.ts:212-219` exactly (pre-existing, unmodified by this plan).
