# Mobs Level Range Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Min Lv / Max Lv number-input filters to the Database tab's Mobs category, using `min_lvl`/`max_lvl` fields already present in `MOB_CATALOG` but never exposed as a filter.

**Architecture:** Two new `?minLv=`/`?maxLv=` query params on the existing `GET /api/db/mobs` route (in-memory `.filter()` over `MOB_CATALOG`, same shape as the existing `aggro`/`ecosystem` filters — overlap semantics, not strict containment), two new number inputs in `Database.tsx` next to the existing "Aggro only" toggle. New test file `tests/integration/db-mobs-filters.test.ts` (this route has no existing test coverage) seeding `MOB_CATALOG` directly rather than mocking `pool.execute`, since `/api/db/mobs` reads an in-memory array, not a live SQL query.

**Tech Stack:** Express route (`src/routes/db.ts`), React 18 + TypeScript (`client/src/components/pages/Database.tsx`), Vitest + supertest integration test.

## Global Constraints

- All backend fixes go in `src/routes/*.ts` — never the deprecated root `server.js`.
- Deploy only via `npm run docker:build && docker compose up -d --force-recreate`.
- `public/index.html`'s Vite-hashed bundle reference must be committed alongside any client change that triggers a rebuild.
- This repo has no client-side test harness. `Database.tsx` changes are verified live (build clean, deploy, exercise the feature in the browser via Playwright), not with client unit tests. Backend route changes ARE covered by Vitest + supertest.
- Overlap semantics: a mob whose own spawn range (`min_lvl`-`max_lvl`) overlaps the requested search range (`minLv`-`maxLv`) at all counts as a match — not strict containment. A mob spawning 68-72 must appear in a search for `minLv=70&maxLv=75`.

---

### Task 1: Level range filter — backend params, client inputs, new test file

**Files:**
- Modify: `src/routes/db.ts` (the `GET /api/db/mobs` route, currently lines 229-247)
- Modify: `client/src/components/pages/Database.tsx` (state declarations ~line 148-155, params assembly ~line 208-220, dependency arrays, `selectCat` ~line 436, toolbar rendering ~line 473-475)
- Create: `tests/integration/db-mobs-filters.test.ts` (no existing test file for this route)
- Modify: `public/index.html` (Vite bundle hash bump — commit alongside `Database.tsx`)

**Interfaces:**
- Consumes: `MOB_CATALOG` (`export let MOB_CATALOG: RowDataPacket[] = []` in `src/catalog.ts:148` — a plain mutable array, directly importable and reassignable in tests), `chipBtn`/number-input styling conventions already used by `zoneFilter`'s `<select>` (`client/src/components/pages/Database.tsx:461-463`).
- Produces: nothing consumed by other tasks — this is the only task in this plan.

- [ ] **Step 1: Add `minLv`/`maxLv` query params to `GET /api/db/mobs`**

Open `src/routes/db.ts`. Find this exact block:

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
```

Replace it with:

```ts
  router.get('/api/db/mobs', requireAuth, (req, res) => {
    const q         = ((req.query.q as string) || '').trim().toLowerCase();
    const zone      = ((req.query.zone as string) || '').trim().toLowerCase();
    const region    = (req.query.region as string) || null;
    const ecosystem = (req.query.ecosystem as string) || null;
    const aggro     = req.query.aggro === '1';
    const minLv     = req.query.minLv ? parseInt(req.query.minLv as string) : null;
    const maxLv     = req.query.maxLv ? parseInt(req.query.maxLv as string) : null;
    const sort      = (req.query.sort as string) || '';
    const page      = Math.max(0, parseInt((req.query.page as string) || '0'));
    let rows = MOB_CATALOG;
    if (q)         rows = rows.filter(r => (r.name as string).toLowerCase().includes(q));
    if (zone)      rows = rows.filter(r => r.zone && (r.zone as string).toLowerCase().includes(zone));
    if (region)    rows = rows.filter(r => _mobRegionMatch((r.zone as string) || '', region));
    if (ecosystem) rows = rows.filter(r => r.ecosystem === ecosystem);
    if (aggro)     rows = rows.filter(r => r.aggro === 1);
    if (minLv !== null && !isNaN(minLv)) rows = rows.filter(r => (r.max_lvl as number) >= minLv);
    if (maxLv !== null && !isNaN(maxLv)) rows = rows.filter(r => (r.min_lvl as number) <= maxLv);
    const MOB_SORT = new Set(['name', 'zone', 'min_lvl', 'max_lvl', 'family', 'aggro', 'spawns', 'ecosystem']);
    if (sort === 'level') rows = [...rows].sort(cmpBy('max_lvl', sortDir(req)));
    else if (MOB_SORT.has(sort)) rows = [...rows].sort(cmpBy(sort, sortDir(req)));
    res.json(rows.slice(page * DB_PAGE, page * DB_PAGE + DB_PAGE));
  });
```

Note the overlap semantics: `minLv` filters on `max_lvl >= minLv` (the mob's *ceiling* must reach at least the search floor) and `maxLv` filters on `min_lvl <= maxLv` (the mob's *floor* must not exceed the search ceiling) — this is what makes a mob spawning 68-72 match a search of `minLv=70&maxLv=75`.

- [ ] **Step 2: Create `tests/integration/db-mobs-filters.test.ts`**

This route has no existing test file. Create it following the mount/auth pattern of `tests/integration/db-items-filters.test.ts`, but seed `MOB_CATALOG` directly (it's an in-memory array, not a live SQL query — mocking `pool.execute` doesn't apply to this route):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock audit before importing routes that call it
import { vi } from 'vitest';
vi.mock('../../src/audit', () => ({
  audit:                  vi.fn(),
  setBroadcastAuditEvent: vi.fn(),
  broadcastAuditEvent:    null,
}));

import { issueToken } from '../../src/auth';
import { createDbRouter } from '../../src/routes/db';
import * as catalog from '../../src/catalog';

const mockPool = { execute: vi.fn(async () => [[]]) } as any;

const app = express();
app.use(express.json());
app.use(createDbRouter(mockPool));

const TOKEN = issueToken({ accid: 1, tier: 'admin', login: 'Sora' });

// GET /api/db/mobs filters MOB_CATALOG in memory (populated at startup from
// a live SQL query, but the route itself never touches the DB per-request)
// — seed it directly rather than mocking pool.execute.
beforeEach(() => {
  catalog.MOB_CATALOG.length = 0;
  catalog.MOB_CATALOG.push(
    { name: 'Low Bat', zone: 'Valkurm Dunes', min_lvl: 5, max_lvl: 8, aggro: 0, ecosystem: 'Bird' } as any,
    { name: 'Mid Crab', zone: 'Valkurm Dunes', min_lvl: 68, max_lvl: 72, aggro: 1, ecosystem: 'Vermin' } as any,
    { name: 'High Wyrm', zone: 'Valkurm Dunes', min_lvl: 90, max_lvl: 95, aggro: 0, ecosystem: 'Dragon' } as any,
  );
});

describe('GET /api/db/mobs level range filter', () => {
  it('minLv alone returns mobs whose max_lvl reaches at least minLv', async () => {
    const res = await request(app)
      .get('/api/db/mobs?minLv=70')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const names = res.body.map((r: any) => r.name);
    expect(names).toEqual(['Mid Crab', 'High Wyrm']);
  });

  it('maxLv alone returns mobs whose min_lvl does not exceed maxLv', async () => {
    const res = await request(app)
      .get('/api/db/mobs?maxLv=10')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const names = res.body.map((r: any) => r.name);
    expect(names).toEqual(['Low Bat']);
  });

  it('minLv and maxLv together use overlap semantics, not strict containment', async () => {
    const res = await request(app)
      .get('/api/db/mobs?minLv=70&maxLv=75')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const names = res.body.map((r: any) => r.name);
    // Mid Crab (68-72) overlaps 70-75 even though it's not fully contained
    // within it — that's the overlap semantics this filter is built on.
    expect(names).toEqual(['Mid Crab']);
  });

  it('combines with the aggro filter (AND semantics)', async () => {
    const res = await request(app)
      .get('/api/db/mobs?minLv=60&aggro=1')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const names = res.body.map((r: any) => r.name);
    // High Wyrm matches minLv=60 but aggro=0, so only Mid Crab (aggro=1) remains
    expect(names).toEqual(['Mid Crab']);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/db/mobs?minLv=70');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run the new test file to verify it passes**

Run: `npx vitest run tests/integration/db-mobs-filters.test.ts`
Expected: 5/5 tests pass. If any fail, re-check Step 1's exact filter logic — a common mistake is swapping which bound (`min_lvl`/`max_lvl`) each param compares against.

- [ ] **Step 4: Add `mobsMinLv`/`mobsMaxLv` client state, wire into `load()`, reset in `selectCat`**

Open `client/src/components/pages/Database.tsx`. Find this exact line (state declarations):

```tsx
  const [aggroFilter, setAggroFilter] = useState(false);
```

Add immediately after it:

```tsx
  const [aggroFilter, setAggroFilter] = useState(false);
  const [mobsMinLv, setMobsMinLv] = useState<number | null>(null);
  const [mobsMaxLv, setMobsMaxLv] = useState<number | null>(null);
```

Find this exact line (params assembly in `load()`):

```tsx
    if (cat === 'mobs' && aggroFilter) params.aggro = 1;
```

Add immediately after it:

```tsx
    if (cat === 'mobs' && aggroFilter) params.aggro = 1;
    if (cat === 'mobs' && mobsMinLv !== null) params.minLv = mobsMinLv;
    if (cat === 'mobs' && mobsMaxLv !== null) params.maxLv = mobsMaxLv;
```

Find the `load` `useCallback`'s dependency array — it currently ends with (search for `aggroFilter, jobFilter` to locate it):

```tsx
  }, [cat, page, search, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, jobFilter, typeFilter, slotFilter, skillFilter, jobFilterItems, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]);
```

Replace it with:

```tsx
  }, [cat, page, search, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, mobsMinLv, mobsMaxLv, jobFilter, typeFilter, slotFilter, skillFilter, jobFilterItems, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]);
```

Find the matching `useEffect(() => { load(true); }, [...])` right after it:

```tsx
  useEffect(() => { load(true); }, [cat, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, jobFilter, typeFilter, slotFilter, skillFilter, jobFilterItems, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

Replace it with:

```tsx
  useEffect(() => { load(true); }, [cat, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, mobsMinLv, mobsMaxLv, jobFilter, typeFilter, slotFilter, skillFilter, jobFilterItems, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

Find this exact line (`selectCat`, which resets every filter on category switch):

```tsx
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setRegionFilter(null); setRoleFilter(null); setMobsRegionFilter(null); setMobsEcosystemFilter(null); setAggroFilter(false); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setJobFilterItems(null); setRareExFilter(false); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
```

Replace it with:

```tsx
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setRegionFilter(null); setRoleFilter(null); setMobsRegionFilter(null); setMobsEcosystemFilter(null); setAggroFilter(false); setMobsMinLv(null); setMobsMaxLv(null); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setJobFilterItems(null); setRareExFilter(false); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
```

- [ ] **Step 5: Render the Min Lv / Max Lv number inputs**

Find this exact line (the "Aggro only" chip):

```tsx
          {cat === 'mobs' && chipBtn('Aggro only', 1, aggroFilter ? 1 : null, (v) => setAggroFilter(v === 1))}
```

Add immediately after it (before the row-count `<span>`):

```tsx
          {cat === 'mobs' && chipBtn('Aggro only', 1, aggroFilter ? 1 : null, (v) => setAggroFilter(v === 1))}
          {cat === 'mobs' && (
            <>
              <input type="number" placeholder="Min Lv" value={mobsMinLv ?? ''}
                onChange={(e) => setMobsMinLv(e.target.value === '' ? null : Number(e.target.value))}
                style={{ background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '7px 9px', borderRadius: 7, fontSize: 12, width: 64 }} />
              <input type="number" placeholder="Max Lv" value={mobsMaxLv ?? ''}
                onChange={(e) => setMobsMaxLv(e.target.value === '' ? null : Number(e.target.value))}
                style={{ background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '7px 9px', borderRadius: 7, fontSize: 12, width: 64 }} />
            </>
          )}
```

- [ ] **Step 6: Type-check and build**

Run: `npm run build:all`
Expected: exit 0, no TypeScript errors.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass (baseline was 118; this task adds 5 new tests in a new file, so expect 123 passing, 14 test files).

- [ ] **Step 8: Deploy and verify live in the browser**

```bash
npm run docker:build
docker compose up -d --force-recreate
```

Then, using Playwright (headless chromium, login via `Sora`/`YourPassword1`, click "Database" then "Mobs" — this is an SPA, do not `page.goto()` a sub-route directly), verify:

1. Select the Mobs category. Confirm "Min Lv" and "Max Lv" number inputs appear next to the "Aggro only" chip.
2. Type "70" into Min Lv. Confirm the row count changes. Cross-check with a direct API call: `GET /api/db/mobs?minLv=70` should return only mobs whose `max_lvl >= 70`.
3. Also type "75" into Max Lv (Min Lv still 70). Confirm the row count narrows further (or stays the same, never grows) compared to Min Lv alone. Cross-check: `GET /api/db/mobs?minLv=70&maxLv=75`.
4. Find (via the cross-check API calls) a mob whose range only partially overlaps 70-75 (e.g. spawns 65-72) and confirm it's included in the browser results — this is the overlap-semantics behavior, not strict containment.
5. Combine with an existing filter (e.g. "Aggro only") and confirm results narrow further (AND semantics).
6. Switch category away from Mobs and back. Confirm Min Lv / Max Lv are cleared (reset to placeholder, not retaining a stale value).

- [ ] **Step 9: Commit**

```bash
git add src/routes/db.ts client/src/components/pages/Database.tsx tests/integration/db-mobs-filters.test.ts public/index.html
git commit -m "$(cat <<'EOF'
database: add Min Lv/Max Lv range filter for Mobs

min_lvl/max_lvl already exist in MOB_CATALOG (used for the table
columns and level sort) but were never filterable. New ?minLv=/?maxLv=
params use overlap semantics (a mob spawning 68-72 matches a search of
70-75) rather than strict containment, since that's what's actually
useful when looking for "what can I fight around my level." New test
file tests/integration/db-mobs-filters.test.ts (this route had no
prior coverage) seeds MOB_CATALOG directly rather than mocking
pool.execute, since /api/db/mobs filters an in-memory array populated
at startup, not a live SQL query per request.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** the spec's requirements (new `?minLv=`/`?maxLv=` backend params with overlap semantics; new number inputs next to Aggro-only; AND-composition with existing filters; reset on category switch) are all covered by Steps 1, 4, 5.
- **No placeholders:** all code blocks are complete and copy-pasteable, matching the verified current file content exactly (re-read via `Read`/`Bash` immediately before writing this plan).
- **Type consistency:** `mobsMinLv`/`mobsMaxLv` are `number | null` throughout (state, params assembly, `selectCat` reset, dependency arrays, input rendering) — no naming collision with any existing state (`mobsRegionFilter`/`mobsEcosystemFilter` are the only other `mobs`-prefixed state, distinct names).
