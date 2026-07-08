# Mobs Organization Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Database tab's Mobs category three new ways to narrow the list: a Region filter (San d'Oria/Bastok/Windurst/Jeuno/Aht Urhgan/Adoulin — already implemented server-side, never wired up), an Ecosystem filter (23 real categories like Beastmen/Vermin/Undead/Dragon — also already implemented server-side, never wired up), and a new Aggro-only toggle.

**Architecture:** `region` and `ecosystem` already work as query params on `GET /api/db/mobs` — this plan adds a third param (`?aggro=1`, filtering the `aggro` column `MOB_CATALOG` already carries) and a new counts endpoint (`GET /api/db/mob-ecosystems`) so the client only renders chips for ecosystems that actually have mobs, mirroring `/api/db/npc-roles`'s shape. The client adds three new toolbar rows to the Mobs category and reuses the NPCs feature's region-chip list and helpers (renamed from `NPC_REGIONS` to `REGIONS` since it's not NPC-specific).

**Tech Stack:** Node.js/Express (backend, `src/routes/db.ts`), React 18 + TypeScript (client, `client/src/components/pages/Database.tsx`, `client/src/api.ts`).

## Global Constraints

- All backend changes go in `src/routes/*.ts` — never the deprecated root `server.js` (per repo CLAUDE.md).
- No `catalog.ts`/SQL changes are needed or in scope. `loadMobCatalog()`'s SQL already selects `MIN(mp.aggro) AS aggro` and `MOB_CATALOG` already carries it on every row (verified directly against the unchanged source, confirmed via `git log -L`) — this plan only adds a filter param and a counts route on top of data that already exists.
- The ecosystem chip list is **dynamic** (derived from live DB data via `/api/db/mob-ecosystems`), unlike NPC roles' fixed 4-entry set — do not hardcode ecosystem names anywhere in the client. `NULL`/unclassified ecosystem values (~15,812 spawn-point rows with no species/pool match) must never appear as a filter chip.
- Region, Ecosystem, and Aggro filters combine with AND semantics with each other and the existing zone dropdown/search box, and reset together with those on category switch — same convention as every other filter in this file.
- Mobs gets its **own** filter state (`mobsRegionFilter`, `mobsEcosystemFilter`) distinct from the NPCs category's `regionFilter`/`roleFilter` — the two categories can't be filtered simultaneously, but each category's state must reset independently on category switch, matching how `typeFilter` (Items) and `jobFilter` (Abilities) are already kept separate.
- No new client-side test infrastructure — client changes are verified live (Playwright), matching every prior `Database.tsx` change in this repo's history. No new pure logic exists in this plan worth a unit test (unlike the NPC roles feature's regex classifier) — this is a query param plus in-memory filtering, the same shape as the Items filter fix, which was also verified live only.
- Test credentials for live verification: `Sora` / `YourPassword1` (throwaway, admin tier).
- Baseline test count before this plan: **106/106** (`npx vitest run`) — expected to remain 106/106 throughout, since no backend unit is added.

---

### Task 1: Backend — `aggro` filter param + `GET /api/db/mob-ecosystems`

**Files:**
- Modify: `src/routes/db.ts` (add `aggro` query param to the existing `/api/db/mobs` route; add a new route directly after it)

**Interfaces:**
- Produces (consumed by Task 2):
  - `GET /api/db/mobs?aggro=1` — new optional param, combines with the existing `q`/`zone`/`region`/`ecosystem` params (AND semantics, via the same sequential `rows = rows.filter(...)` pattern already used by the other params in this route).
  - `GET /api/db/mob-ecosystems` → `{ ecosystem: string; cnt: number }[]`, sorted by `cnt` descending, one entry per **non-null** ecosystem value present in `MOB_CATALOG`.

- [ ] **Step 1: Add the `aggro` param and the new route**

Find in `src/routes/db.ts`:

```ts
  router.get('/api/db/mobs', requireAuth, (req, res) => {
    const q         = ((req.query.q as string) || '').trim().toLowerCase();
    const zone      = ((req.query.zone as string) || '').trim().toLowerCase();
    const region    = (req.query.region as string) || null;
    const ecosystem = (req.query.ecosystem as string) || null;
    const sort      = (req.query.sort as string) || '';
    const page      = Math.max(0, parseInt((req.query.page as string) || '0'));
    let rows = MOB_CATALOG;
    if (q)         rows = rows.filter(r => (r.name as string).toLowerCase().includes(q));
    if (zone)      rows = rows.filter(r => r.zone && (r.zone as string).toLowerCase().includes(zone));
    if (region)    rows = rows.filter(r => _mobRegionMatch((r.zone as string) || '', region));
    if (ecosystem) rows = rows.filter(r => r.ecosystem === ecosystem);
    const MOB_SORT = new Set(['name', 'zone', 'min_lvl', 'max_lvl', 'family', 'aggro', 'spawns', 'ecosystem']);
    if (sort === 'level') rows = [...rows].sort(cmpBy('max_lvl', sortDir(req)));
    else if (MOB_SORT.has(sort)) rows = [...rows].sort(cmpBy(sort, sortDir(req)));
    res.json(rows.slice(page * DB_PAGE, page * DB_PAGE + DB_PAGE));
  });
```

Replace with:

```ts
  router.get('/api/db/mobs', requireAuth, (req, res) => {
    const q         = ((req.query.q as string) || '').trim().toLowerCase();
    const zone      = ((req.query.zone as string) || '').trim().toLowerCase();
    const region    = (req.query.region as string) || null;
    const ecosystem = (req.query.ecosystem as string) || null;
    const aggro     = req.query.aggro === '1';
    const sort      = (req.query.sort as string) || '';
    const page      = Math.max(0, parseInt((req.query.page as string) || '0'));
    let rows = MOB_CATALOG;
    if (q)         rows = rows.filter(r => (r.name as string).toLowerCase().includes(q));
    if (zone)      rows = rows.filter(r => r.zone && (r.zone as string).toLowerCase().includes(zone));
    if (region)    rows = rows.filter(r => _mobRegionMatch((r.zone as string) || '', region));
    if (ecosystem) rows = rows.filter(r => r.ecosystem === ecosystem);
    if (aggro)     rows = rows.filter(r => r.aggro === 1);
    const MOB_SORT = new Set(['name', 'zone', 'min_lvl', 'max_lvl', 'family', 'aggro', 'spawns', 'ecosystem']);
    if (sort === 'level') rows = [...rows].sort(cmpBy('max_lvl', sortDir(req)));
    else if (MOB_SORT.has(sort)) rows = [...rows].sort(cmpBy(sort, sortDir(req)));
    res.json(rows.slice(page * DB_PAGE, page * DB_PAGE + DB_PAGE));
  });

  router.get('/api/db/mob-ecosystems', requireAuth, (_req, res) => {
    const counts: Record<string, number> = {};
    for (const row of MOB_CATALOG) {
      const eco = row.ecosystem as string | null;
      if (!eco) continue;
      counts[eco] = (counts[eco] || 0) + 1;
    }
    res.json(Object.entries(counts).map(([ecosystem, cnt]) => ({ ecosystem, cnt })).sort((a, b) => b.cnt - a.cnt));
  });
```

- [ ] **Step 2: Rebuild**

```bash
cd /home/sora/Downloads/ffxi-dashboard
npm run build:all
```

Expected: exit 0, no TypeScript errors.

- [ ] **Step 3: Deploy and verify live via curl**

```bash
npm run docker:build && docker compose up -d --force-recreate
docker compose logs --tail=20 dashboard
```

Expected: `FFXI Dashboard running on port 3000`, no errors.

```bash
TOK=$(curl -s -X POST http://localhost:3001/api/login -H 'Content-Type: application/json' -d '{"login":"Sora","password":"YourPassword1"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Counts endpoint — no null/empty ecosystem entries, sorted descending by count
curl -s "http://localhost:3001/api/db/mob-ecosystems" -H "Authorization: Bearer $TOK" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
assert len(rows) > 15, f'expected 20+ ecosystem categories, got {len(rows)}'
assert all(r['ecosystem'] for r in rows), 'found a falsy/null ecosystem entry'
assert rows == sorted(rows, key=lambda r: -r['cnt']), 'not sorted descending by cnt'
print(f'OK: {len(rows)} ecosystems, top: {rows[0]}')
"

# Ecosystem filter — every returned row has the requested ecosystem
curl -s "http://localhost:3001/api/db/mobs?ecosystem=Beastmen&page=0" -H "Authorization: Bearer $TOK" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
assert len(rows) > 0, 'expected at least one Beastmen mob'
assert all(r.get('ecosystem') == 'Beastmen' for r in rows), 'found a row with the wrong ecosystem'
print(f'OK: {len(rows)} rows, all Beastmen, e.g. {rows[0][\"name\"]}')
"

# Aggro filter — every returned row has aggro === 1
curl -s "http://localhost:3001/api/db/mobs?aggro=1&page=0" -H "Authorization: Bearer $TOK" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
assert len(rows) > 0, 'expected at least one aggro mob'
assert all(r.get('aggro') == 1 for r in rows), 'found a row with aggro != 1'
print(f'OK: {len(rows)} rows, all aggro, e.g. {rows[0][\"name\"]}')
"

# Region filter — every returned row's zone contains "Bastok"
curl -s "http://localhost:3001/api/db/mobs?region=bastok&page=0" -H "Authorization: Bearer $TOK" | python3 -c "
import sys, json
rows = json.load(sys.stdin)
assert len(rows) > 0, 'expected at least one Bastok mob'
assert all('bastok' in r['zone'].lower() for r in rows), 'found a row outside Bastok'
print(f'OK: {len(rows)} rows, all in Bastok, e.g. {rows[0][\"name\"]}')
"
```

Expected: all four checks print `OK: ...` with no assertion errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS, 106/106 (unchanged — this task is backend-route-only, no new unit tests, covered by the live curl checks above per this repo's established convention for `src/routes/*.ts` additions).

- [ ] **Step 5: Commit**

```bash
git add src/routes/db.ts
git commit -m "$(cat <<'EOF'
routes: filter mobs by aggro, add GET /api/db/mob-ecosystems

The aggro column already exists on every MOB_CATALOG row (loadMobCatalog's
SQL has selected MIN(mp.aggro) AS aggro since the original TypeScript
conversion) — this just exposes it as a ?aggro=1 filter, alongside the
existing ?region=/?ecosystem= params which were already implemented
server-side but never used by any client. New GET /api/db/mob-ecosystems
returns per-ecosystem counts (excluding the ~15,812 spawn points with no
species/pool match) so the client can gate which filter chips it renders.
EOF
)"
```

---

### Task 2: Client — Region, Ecosystem, and Aggro filter chips for Mobs

**Files:**
- Modify: `client/src/api.ts` (add one helper)
- Modify: `client/src/components/pages/Database.tsx`
  - Module-level constants (~line 646): rename `NPC_REGIONS` → `REGIONS`
  - State declarations (~line 149-160)
  - Data fetch (~line 189)
  - `load()` params + both dependency arrays (~line 202-255)
  - `selectCat` (~line 425-427)
  - Toolbar JSX (~line 463-464 for the Aggro toggle; ~line 496-507 for the two new chip rows, and updating the existing NPCs region row's `NPC_REGIONS` reference)

**Interfaces:**
- Consumes: `api.dbMobEcosystems` (new), Task 1's `GET /api/db/mob-ecosystems`; Task 1's `?region=`/`?ecosystem=`/`?aggro=` params on `GET /api/db/mobs` (via the existing generic `api.dbMobs(params)` call, no signature change needed there).
- Produces: nothing consumed by a later task — this is the last task in the plan.

- [ ] **Step 1: Add the API helper**

In `client/src/api.ts`, find:

```ts
  dbNpcRoles: () => req<{ role: string; cnt: number }[]>('/api/db/npc-roles'),
```

Add directly after it:

```ts
  dbNpcRoles: () => req<{ role: string; cnt: number }[]>('/api/db/npc-roles'),
  dbMobEcosystems: () => req<{ ecosystem: string; cnt: number }[]>('/api/db/mob-ecosystems'),
```

- [ ] **Step 2: Rename `NPC_REGIONS` to `REGIONS`**

In `client/src/components/pages/Database.tsx`, find:

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
```

Replace with:

```ts
// Matches src/catalog.ts's NPC_REGION_SQL keys exactly — six geographic
// regions the backend filters NPCs and Mobs by (?region=). Not
// NPC-specific despite the original name — both categories reuse this.
const REGIONS: { key: string; label: string }[] = [
  { key: 'san_doria', label: "San d'Oria" },
  { key: 'bastok', label: 'Bastok' },
  { key: 'windurst', label: 'Windurst' },
  { key: 'jeuno', label: 'Jeuno' },
  { key: 'aht_urhgan', label: 'Aht Urhgan' },
  { key: 'adoulin', label: 'Adoulin' },
];
```

Find the NPCs toolbar row that references the old name:

```ts
        {cat === 'npcs' && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All regions', null, regionFilter, setRegionFilter)}
            {NPC_REGIONS.map(r => chipBtnStr(r.label, r.key, regionFilter, setRegionFilter))}
          </div>
        )}
```

Replace with:

```ts
        {cat === 'npcs' && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All regions', null, regionFilter, setRegionFilter)}
            {REGIONS.map(r => chipBtnStr(r.label, r.key, regionFilter, setRegionFilter))}
          </div>
        )}
```

- [ ] **Step 3: Add state**

Find:

```ts
  const [regionFilter, setRegionFilter] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
```

Replace with:

```ts
  const [regionFilter, setRegionFilter] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [mobsRegionFilter, setMobsRegionFilter] = useState<string | null>(null);
  const [mobsEcosystemFilter, setMobsEcosystemFilter] = useState<string | null>(null);
  const [aggroFilter, setAggroFilter] = useState(false);
```

Find:

```ts
  const [npcRoles, setNpcRoles] = useState<{ role: string; cnt: number }[]>([]);
```

Replace with:

```ts
  const [npcRoles, setNpcRoles] = useState<{ role: string; cnt: number }[]>([]);
  const [mobEcosystems, setMobEcosystems] = useState<{ ecosystem: string; cnt: number }[]>([]);
```

- [ ] **Step 4: Fetch ecosystem counts once**

Find:

```ts
  useEffect(() => { api.dbNpcRoles().then(setNpcRoles).catch(() => {}); }, []);
```

Add directly after it:

```ts
  useEffect(() => { api.dbNpcRoles().then(setNpcRoles).catch(() => {}); }, []);
  useEffect(() => { api.dbMobEcosystems().then(setMobEcosystems).catch(() => {}); }, []);
```

- [ ] **Step 5: Wire the params into `load()`**

Find:

```ts
    if (cat === 'npcs' && regionFilter) params.region = regionFilter;
    if (cat === 'npcs' && roleFilter) params.role = roleFilter;
    if (cat === 'quests' && questLogFilter !== null) params.log = questLogFilter;
```

Replace with:

```ts
    if (cat === 'npcs' && regionFilter) params.region = regionFilter;
    if (cat === 'npcs' && roleFilter) params.role = roleFilter;
    if (cat === 'mobs' && mobsRegionFilter) params.region = mobsRegionFilter;
    if (cat === 'mobs' && mobsEcosystemFilter) params.ecosystem = mobsEcosystemFilter;
    if (cat === 'mobs' && aggroFilter) params.aggro = 1;
    if (cat === 'quests' && questLogFilter !== null) params.log = questLogFilter;
```

Find:

```ts
  }, [cat, page, search, zoneFilter, regionFilter, roleFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]);

  useEffect(() => { load(true); }, [cat, zoneFilter, regionFilter, roleFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

Replace with:

```ts
  }, [cat, page, search, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]);

  useEffect(() => { load(true); }, [cat, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 6: Reset the new filters on category switch**

Find:

```ts
  function selectCat(key: Category) {
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setRegionFilter(null); setRoleFilter(null); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setRareExFilter(false); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
  }
```

Replace with:

```ts
  function selectCat(key: Category) {
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setRegionFilter(null); setRoleFilter(null); setMobsRegionFilter(null); setMobsEcosystemFilter(null); setAggroFilter(false); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setRareExFilter(false); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
  }
```

- [ ] **Step 7: Render the Aggro toggle next to the row count**

Find:

```ts
          {cat === 'items' && chipBtn('Rare/Ex', 1, rareExFilter ? 1 : null, (v) => setRareExFilter(v === 1))}
          <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>{rows.length} rows</span>
```

Replace with:

```ts
          {cat === 'items' && chipBtn('Rare/Ex', 1, rareExFilter ? 1 : null, (v) => setRareExFilter(v === 1))}
          {cat === 'mobs' && chipBtn('Aggro only', 1, aggroFilter ? 1 : null, (v) => setAggroFilter(v === 1))}
          <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>{rows.length} rows</span>
```

- [ ] **Step 8: Render the Region and Ecosystem chip rows for Mobs**

Find the NPCs role-chip row, which is the last row in the toolbar's filter-rows block:

```ts
        {cat === 'npcs' && npcRoles.some(r => r.cnt > 0) && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All roles', null, roleFilter, setRoleFilter)}
            {npcRoles.filter(r => r.cnt > 0).map(r => chipBtnStr(NPC_ROLE_LABELS[r.role] ?? r.role, r.role, roleFilter, setRoleFilter))}
          </div>
        )}
        </div>
```

Replace with:

```ts
        {cat === 'npcs' && npcRoles.some(r => r.cnt > 0) && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All roles', null, roleFilter, setRoleFilter)}
            {npcRoles.filter(r => r.cnt > 0).map(r => chipBtnStr(NPC_ROLE_LABELS[r.role] ?? r.role, r.role, roleFilter, setRoleFilter))}
          </div>
        )}
        {cat === 'mobs' && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All regions', null, mobsRegionFilter, setMobsRegionFilter)}
            {REGIONS.map(r => chipBtnStr(r.label, r.key, mobsRegionFilter, setMobsRegionFilter))}
          </div>
        )}
        {cat === 'mobs' && mobEcosystems.length > 0 && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All', null, mobsEcosystemFilter, setMobsEcosystemFilter)}
            {mobEcosystems.map(e => chipBtnStr(e.ecosystem, e.ecosystem, mobsEcosystemFilter, setMobsEcosystemFilter))}
          </div>
        )}
        </div>
```

- [ ] **Step 9: Rebuild**

```bash
cd /home/sora/Downloads/ffxi-dashboard
npm run build:all
```

Expected: exit 0, no TypeScript errors. (This also confirms the `NPC_REGIONS` → `REGIONS` rename left no stale references — a leftover `NPC_REGIONS` anywhere would be a TypeScript compile error, not a silent bug.)

- [ ] **Step 10: Deploy and verify live**

```bash
npm run docker:build && docker compose up -d --force-recreate
```

Using Playwright (chromium at `/home/sora/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`, `playwright-core` — reuse the existing install in the scratchpad's `node_modules` if present), log in as `Sora`/`YourPassword1`, open Database → Mobs. Confirm:
- Three new controls appear: an "Aggro only" toggle chip next to the row count, a Region chip row ("All regions" / San d'Oria / Bastok / Windurst / Jeuno / Aht Urhgan / Adoulin), and an Ecosystem chip row (starting with "All", then real category names like "Beastmen", "Vermin", "Undead" — sorted by count descending, so the biggest categories appear first; no blank/null chip anywhere).
- Click "Bastok" — every visible row's Zone column contains "Bastok".
- Click "Beastmen" (or whichever ecosystem chip is largest) — combines with the region filter (both chips stay highlighted); every visible row's zone stays within Bastok. Confirm via a direct API check if the on-screen pagination badge doesn't visibly move (the "N rows" badge only reflects the loaded page, a known pre-existing characteristic — this is not a new bug, don't treat it as one): `curl` `/api/db/mobs?region=bastok` vs `/api/db/mobs?region=bastok&ecosystem=<chosen>` and confirm the second call's row count is smaller.
- Click "Aggro only" — combines with the other two (all three chips stay highlighted); confirm every visible row's Aggro column shows a checkmark.
- Click "All regions", "All" (ecosystem), and "Aggro only" again to reset all three — row count/rows return to the unfiltered state.
- Switch to NPCs and back to Mobs — confirm the NPCs region/role chips reset independently and the Mobs filters also reset (no cross-category bleed), consistent with `selectCat`'s existing reset behavior for every other filter.

- [ ] **Step 11: Commit**

```bash
git add client/src/api.ts client/src/components/pages/Database.tsx
git commit -m "$(cat <<'EOF'
database: add Mobs Region, Ecosystem, and Aggro filter chips

Region chips reuse the same list the NPCs feature wired up (renamed
NPC_REGIONS -> REGIONS since it's not NPC-specific). Ecosystem chips
are dynamic, sourced from the new GET /api/db/mob-ecosystems counts
endpoint so only real, non-null categories with actual mobs render.
Aggro-only is a simple boolean toggle, same pattern as Items' Rare/Ex
chip. All three combine with AND semantics and the existing zone
dropdown/search, and reset independently of the NPCs category's own
filter state on category switch.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Design spec's "Backend changes" (`?aggro=` param, `GET /api/db/mob-ecosystems`) → Task 1. "Client changes" (Region/Ecosystem/Aggro chips, `REGIONS` rename, `api.ts` helper) → Task 2. Decision 1 (ecosystem as chips, not dropdown) → Task 2 Step 8. Decision 2 (bundle all three) → both tasks together. Decision 3 (AND semantics, reset together) → Task 2 Steps 5-6. Decision 4 (`NPC_REGIONS` → `REGIONS` rename, reused not duplicated) → Task 2 Step 2. The `aggro`-already-exists correction (Global Constraints) → Task 1 Step 1's diff (only adds a filter line, no `catalog.ts` touch) and Step 3's live curl check.
- **Placeholder scan:** No TBD/TODO; every step has literal, complete code.
- **Type consistency:** `GET /api/db/mob-ecosystems`'s `{ecosystem, cnt}[]` shape (Task 1) matches `api.dbMobEcosystems()`'s return type (Task 2 Step 1) and the `mobEcosystems` state type (Task 2 Step 3) exactly — no renaming drift. `mobsRegionFilter`/`mobsEcosystemFilter`/`aggroFilter` names are used identically across state declaration (Step 3), `load()` params (Step 5), both dependency arrays (Step 5), `selectCat`'s reset (Step 6), and the toolbar JSX (Steps 7-8) — no `mobRegionFilter`-vs-`mobsRegionFilter` drift. `REGIONS` (renamed in Step 2) is referenced identically in both its NPCs call site (updated in Step 2) and its new Mobs call site (Step 8) — a stale `NPC_REGIONS` reference anywhere would fail Step 9's build, which doubles as a consistency check.
