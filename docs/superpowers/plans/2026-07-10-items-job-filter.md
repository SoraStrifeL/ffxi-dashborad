# Items Job Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Job filter chip row to the Database tab's Items category (Equipment + Weapon types), using the `ie.jobs` bitmask that's already selected by `GET /api/db/items` and already parsed correctly in the item detail panel, but never exposed as a filter.

> **Correction (post-implementation, 2026-07-10):** this plan's code — `params.push(job)` in Step 1, the `job=8` test expectations in Step 2, and the "already parsed correctly" claim above — used a wrong job-mask bit index (`job_id`, not LSB's real `job_id - 1`). See `docs/superpowers/specs/2026-07-10-items-job-filter-design.md`'s "Correction" callout and commit `2177ba6` for the actual fix that shipped. This plan document is left as-executed (a historical record of what was actually run, including the bug); it is not a live reference — do not copy code from it without checking the spec's correction first.

**Architecture:** One new `?job=N` query param on the existing `GET /api/db/items` route (bitwise check against `ie.jobs`, same shape as the existing `slot`/`skill` params), one new chip row in `Database.tsx` gated the same way the existing Slot/Weapon-skill rows are, reusing the already-defined `JOB_ABBR` constant.

**Tech Stack:** Express route (`src/routes/db.ts`), React 18 + TypeScript (`client/src/components/pages/Database.tsx`), Vitest + supertest integration test.

## Global Constraints

- All backend fixes go in `src/routes/*.ts` — never the deprecated root `server.js`.
- Deploy only via `npm run docker:build && docker compose up -d --force-recreate`.
- `public/index.html`'s Vite-hashed bundle reference must be committed alongside any client change that triggers a rebuild (established repo convention, unbroken on every recent commit touching client files).
- This repo has no client-side test harness (no Vitest/RTL under `client/`). `Database.tsx` changes are verified live (build clean, deploy, exercise the feature in the browser via Playwright), not with client unit tests. Backend route changes ARE covered by Vitest + supertest (see `tests/integration/db-items-filters.test.ts`).

---

### Task 1: Job filter — backend param, client chip row, tests

**Files:**
- Modify: `src/routes/db.ts` (the `GET /api/db/items` route, right where `slotBit`/`skillFilter`-equivalent params are parsed and applied — currently around lines 39-90)
- Modify: `client/src/components/pages/Database.tsx` (state declarations ~line 154-157, params assembly ~line 209-212, dependency arrays ~line 261/263, `selectTypeFilter` ~line 436-438, `selectCat` ~line 433-435, toolbar rendering ~line 487-497)
- Modify: `tests/integration/db-items-filters.test.ts` (add job-filter test cases to the existing file)
- Modify: `public/index.html` (Vite bundle hash bump — commit alongside `Database.tsx`, per Global Constraints)

**Interfaces:**
- Consumes: `JOB_ABBR` (`client/src/components/pages/Database.tsx:645`, already defined — `['MON','WAR','MNK','WHM','BLM','RDM','THF','PLD','DRK','BST','BRD','RNG','SAM','NIN','DRG','SMN','BLU','COR','PUP','DNC','SCH','GEO','RUN']`, index 0 is an unused placeholder — real FFXI job ids start at 1 for WAR), `chipBtn(label, value, current, setter)` (already defined, used by every other filter chip).
- Produces: nothing consumed by other tasks — this is the only task in this plan.

- [ ] **Step 1: Add the `job` query param to `GET /api/db/items`**

Open `src/routes/db.ts`. Find this exact line (in the `GET /api/db/items` handler, right after `slotBit` is parsed):

```ts
      const slotBit = req.query.slot ? parseInt(req.query.slot as string) : null;
```

Add a new line immediately after it:

```ts
      const slotBit = req.query.slot ? parseInt(req.query.slot as string) : null;
      const job     = req.query.job  ? parseInt(req.query.job as string)  : null;
```

Then find this exact line (the `slotBit` filter application, right before `params.push(DB_PAGE, page * DB_PAGE);`):

```ts
      if (slotBit !== null && !isNaN(slotBit)) { extra.push('AND (ie.slot & ?) != 0'); params.push(slotBit); }
      params.push(DB_PAGE, page * DB_PAGE);
```

Replace it with:

```ts
      if (slotBit !== null && !isNaN(slotBit)) { extra.push('AND (ie.slot & ?) != 0'); params.push(slotBit); }
      if (job !== null && !isNaN(job)) { extra.push('AND (ie.jobs >> ?) & 1 = 1'); params.push(job); }
      params.push(DB_PAGE, page * DB_PAGE);
```

No other changes needed in this file — `ie.jobs` is already in the `SELECT` list for this route.

- [ ] **Step 2: Add job-filter test cases to `tests/integration/db-items-filters.test.ts`**

Open `tests/integration/db-items-filters.test.ts`. Find this exact block (the last test before the closing `});` of the `describe`):

```ts
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/db/items?slot=1');
    expect(res.status).toBe(401);
  });
});
```

Replace it with (three new tests inserted before the unauthenticated-request test, which stays last):

```ts
  it('applies the job filter when type=6 (Equipment)', async () => {
    const res = await request(app)
      .get('/api/db/items?type=6&job=8')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const [sql, params] = lastCall();
    expect(sql).toContain('ib.type=?');
    expect(sql).toContain('(ie.jobs >> ?) & 1 = 1');
    expect(params).toEqual(['%%', 6, 8, 50, 0]);
  });

  it('applies the job filter when type=7 (Weapon)', async () => {
    const res = await request(app)
      .get('/api/db/items?type=7&job=8')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const [sql, params] = lastCall();
    expect(sql).toContain('ib.type=?');
    expect(sql).toContain('(ie.jobs >> ?) & 1 = 1');
    expect(params).toEqual(['%%', 7, 8, 50, 0]);
  });

  it('combines the job filter with slot and weapon-skill filters together', async () => {
    const res = await request(app)
      .get('/api/db/items?type=7&slot=1&skill=1&job=8')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const [sql, params] = lastCall();
    expect(sql).toContain('ib.type=?');
    expect(sql).toContain('iw.skill=?');
    expect(sql).toContain('(ie.slot & ?) != 0');
    expect(sql).toContain('(ie.jobs >> ?) & 1 = 1');
    expect(params).toEqual(['%%', 7, 1, 1, 8, 50, 0]);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/db/items?slot=1');
    expect(res.status).toBe(401);
  });
});
```

The three-way-combination test's expected params order matters: it must match the exact order the route pushes params in — `type` (added first in the handler), then `skill`, then `slotBit`, then `job` (the new param, pushed last since Step 1 places it right before the `DB_PAGE`/offset push). Re-read `src/routes/db.ts`'s full param-push order after Step 1 if this test fails on param order — the order is determined by which `if` blocks appear first in the handler, not by query-string order.

- [ ] **Step 3: Run the test file to verify it fails (job filter not yet implemented client-side is irrelevant here — the SERVER change from Step 1 must already be in place before this step, so these tests should PASS if Step 1 was done correctly; this step is a sanity check, not a red/green TDD step, since Step 1 already contains the full server implementation)**

Run: `npx vitest run tests/integration/db-items-filters.test.ts`
Expected: all tests pass, including the 3 new ones (10 total in this file). If any of the 3 new tests fail, re-check Step 1's exact placement — a common mistake is placing the `job` param push in the wrong order relative to `slotBit`.

- [ ] **Step 4: Add the `jobFilterItems` state, wire it into `load()`, and reset it on category/type switch**

Open `client/src/components/pages/Database.tsx`. Find this exact line (state declarations):

```tsx
  const [skillFilter, setSkillFilter] = useState<number | null>(null);
```

Add immediately after it:

```tsx
  const [skillFilter, setSkillFilter] = useState<number | null>(null);
  const [jobFilterItems, setJobFilterItems] = useState<number | null>(null);
```

Find this exact line (params assembly in `load()`):

```tsx
    if (cat === 'items' && (typeFilter === 6 || typeFilter === 7) && skillFilter !== null) params.skill = skillFilter;
```

Add immediately after it:

```tsx
    if (cat === 'items' && (typeFilter === 6 || typeFilter === 7) && skillFilter !== null) params.skill = skillFilter;
    if (cat === 'items' && (typeFilter === 6 || typeFilter === 7) && jobFilterItems !== null) params.job = jobFilterItems;
```

Find this exact line (the `load` `useCallback` dependency array):

```tsx
  }, [cat, page, search, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]);
```

Replace it with:

```tsx
  }, [cat, page, search, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, jobFilter, typeFilter, slotFilter, skillFilter, jobFilterItems, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]);
```

Find this exact line (the `useEffect(() => { load(true); }, [...])` right after it):

```tsx
  useEffect(() => { load(true); }, [cat, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

Replace it with:

```tsx
  useEffect(() => { load(true); }, [cat, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, jobFilter, typeFilter, slotFilter, skillFilter, jobFilterItems, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

Find this exact line (`selectCat`, which resets every filter on category switch):

```tsx
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setRegionFilter(null); setRoleFilter(null); setMobsRegionFilter(null); setMobsEcosystemFilter(null); setAggroFilter(false); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setRareExFilter(false); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
```

Replace it with:

```tsx
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setRegionFilter(null); setRoleFilter(null); setMobsRegionFilter(null); setMobsEcosystemFilter(null); setAggroFilter(false); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setJobFilterItems(null); setRareExFilter(false); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
```

Find this exact line (`selectTypeFilter`, which resets Slot/Weapon-skill on type switch — `jobFilterItems` must join this reset too, since switching from Equipment to e.g. General should clear a job filter that no longer applies):

```tsx
  function selectTypeFilter(v: number | null) {
    setTypeFilter(v); setSlotFilter(null); setSkillFilter(null);
  }
```

Replace it with:

```tsx
  function selectTypeFilter(v: number | null) {
    setTypeFilter(v); setSlotFilter(null); setSkillFilter(null); setJobFilterItems(null);
  }
```

- [ ] **Step 5: Render the Job filter chip row**

Find this exact block (the existing Weapon-skill chip row):

```tsx
        {hasTypeFilter && (typeFilter === 6 || typeFilter === 7) && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, skillFilter, setSkillFilter)}
            {Object.entries(WEAPON_SKILL_NAMES).map(([id, name]) => chipBtn(name, Number(id), skillFilter, setSkillFilter))}
          </div>
        )}
```

Add a new block immediately after it (before the next sibling — `{hasQuestLogFilter && questLogs.length > 0 && (`):

```tsx
        {hasTypeFilter && (typeFilter === 6 || typeFilter === 7) && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, jobFilterItems, setJobFilterItems)}
            {JOB_ABBR.slice(1).map((abbr, i) => chipBtn(abbr, i + 1, jobFilterItems, setJobFilterItems))}
          </div>
        )}
```

`JOB_ABBR.slice(1)` skips the unused placeholder at index 0; `i + 1` sends the real FFXI job id (1-22), matching the exact bit-shift convention already used by the detail panel's `jobList` (`client/src/components/pages/Database.tsx:769`) and the server-side `(ie.jobs >> ?) & 1 = 1` check added in Step 1 — so "PLD chip selected" and "PLD shown in this item's own detail panel" refer to the same bit by construction.

- [ ] **Step 6: Type-check and build**

Run: `npm run build:all`
Expected: exit 0, no TypeScript errors.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass (baseline was 114; this task adds 3 new tests in Step 2, so expect 117 passing, 13 test files unchanged).

- [ ] **Step 8: Deploy and verify live in the browser**

```bash
npm run docker:build
docker compose up -d --force-recreate
```

Then, using Playwright (headless chromium, login via the test admin account `Sora`/`YourPassword1`, click the "Database" sidebar link then "Items" — this is an SPA, do not `page.goto()` a sub-route directly), verify:

1. Select "Equipment" type. Confirm a new Job chip row appears (All, WAR, MNK, WHM, ... RUN — 22 chips plus All) alongside the existing Slot and Weapon-skill rows.
2. Click "PLD". Confirm the row count changes and every visible row's detail panel (click a row to open it) shows "PLD" in its Job list — cross-check with a direct API call: `GET /api/db/items?type=6&job=8` should return only items whose `jobs` bitmask has bit 8 set.
3. Combine "PLD" with a Slot chip (e.g. "Body") and confirm results narrow further (AND semantics) — cross-check `GET /api/db/items?type=6&job=8&slot=16` (Body is `SLOT_NAMES` index 4, bit `1<<4=16`) returns a subset of the job-only result.
4. Switch to "Weapon" type. Confirm the Job row persists and re-renders correctly (not stuck showing Equipment-only results) — click "PLD" and confirm weapon results narrow to PLD-usable weapons.
5. Switch to a non-Equipment/Weapon type (e.g. "General"). Confirm the Job row disappears and clicking back to "Equipment" shows "All" selected (reset), not a stale "PLD" selection.
6. Switch categories away from Items and back. Confirm the Job filter is reset (matches `selectCat`'s existing reset behavior for every other filter).

- [ ] **Step 9: Commit**

```bash
git add src/routes/db.ts client/src/components/pages/Database.tsx tests/integration/db-items-filters.test.ts public/index.html
git commit -m "$(cat <<'EOF'
database: add Job filter chip row for Items (Equipment + Weapon)

ie.jobs is already selected by GET /api/db/items and already parsed
correctly in the item detail panel's job list, but was never exposed
as a filter. New ?job=N param does the same bitwise check server-side
((ie.jobs >> N) & 1 = 1); client chip row reuses JOB_ABBR and the same
index+1 bit convention the detail panel already uses, so a selected
job chip and an item's own displayed job list agree by construction.
Gated to Equipment/Weapon types (the only rows with a jobs mask),
resets on type and category switch like every other filter.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** the spec's two requirements (new `?job=N` backend param with bitwise check; new Job chip row gated to Equipment/Weapon reusing `JOB_ABBR`) are both fully covered — Step 1 (backend), Steps 4-5 (client state/wiring/rendering).
- **No placeholders:** all code blocks are complete and copy-pasteable, matching the verified current file content exactly (re-read via the `Read`/`Bash` tools immediately before writing this plan).
- **Type consistency:** `jobFilterItems` is `number | null` throughout (state declaration, params assembly, `selectCat`/`selectTypeFilter` resets, dependency arrays, chip rendering) — no naming drift from `jobFilter` (the pre-existing, distinct Abilities-category state).
