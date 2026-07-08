# Items Filter Fix + Slot/Skill/Rare Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Items category's mislabeled type chips (they currently show the wrong category for every item) and add slot/weapon-skill/rare-ex filtering that the backend already half-supports but the UI never exposed.

**Architecture:** Two small, independent surfaces. (1) A pure data-table swap in `client/src/components/pages/Database.tsx` — the existing `ITEM_TYPE` map is replaced with the schema's real 8-value enum, verified against `/home/sora/ffxi/sql/item_basic.sql` and live `GET /api/db/items?type=N` responses. (2) A second-level, conditionally-rendered chip row (same `chipBtn` component already used for Job/Type/Quest-log chips) that appears under the type chips: Slot chips when Equipment is selected, Weapon-skill chips when Weapon is selected, plus an independent Rare/Ex toggle — all backed by query params on the existing `GET /api/db/items` route, one of which (`rareex`) is new.

**Tech Stack:** Express + mysql2 (backend, `src/routes/db.ts`), React 18 + TypeScript (client, `client/src/components/pages/Database.tsx`), no new dependencies.

## Global Constraints

- All backend changes go in `src/routes/*.ts` — never the deprecated root `server.js` (per repo CLAUDE.md).
- Deploy only via `docker compose build && docker compose up -d --force-recreate` (per repo CLAUDE.md) — used for the final live-verification task only; earlier tasks verify via `curl` against the already-running dev/prod container on `localhost:3001` or via `npx vite build` + `vite` dev-server proxy if a full rebuild isn't warranted yet.
- No new client-side test infrastructure: this codebase's `vitest.config.ts` only covers `tests/**/*.test.ts` against backend `src/` — there is no client unit-test harness, and every prior `Database.tsx`/`src/routes/db.ts` change in this repo's history was verified live (curl + Playwright), not unit-tested. Follow that established precedent; do not introduce a new client test runner for this change.
- Test credentials for live verification: `Sora` / `YourPassword1` (throwaway, admin tier).

---

### Task 1: Backend — add `rareex` filter param to `GET /api/db/items`

**Files:**
- Modify: `src/routes/db.ts:38-90` (the `GET /api/db/items` handler)

**Interfaces:**
- Consumes: nothing new — reads `req.query.rareex`, same pattern as the existing (already-present, currently client-unused) `req.query.rare`.
- Produces: `GET /api/db/items?rareex=1` now additionally filters to `(ib.flags & 0xC000) != 0` (0x8000 `FLAG_RARE` | 0x4000 `FLAG_EX`), combinable with every other existing param (`type`, `skill`, `slot`, `q`, `sort`, `dir`, `page`). This is what Task 4's client toggle will call.

- [ ] **Step 1: Add the `rareex` param and its filter clause**

Open `src/routes/db.ts`. In the `GET /api/db/items` handler, find this existing block (around line 45):

```ts
      const rareOnly = req.query.rare === '1';
```

Add a new line directly after it:

```ts
      const rareOnly = req.query.rare === '1';
      const rareExOnly = req.query.rareex === '1';
```

Then find this existing line (around line 72):

```ts
      if (rareOnly) extra.push('AND (ib.flags & 0x8000) != 0');
```

Add a new line directly after it:

```ts
      if (rareOnly) extra.push('AND (ib.flags & 0x8000) != 0');
      if (rareExOnly) extra.push('AND (ib.flags & 0xC000) != 0');
```

- [ ] **Step 2: Rebuild and restart the server for live verification**

```bash
cd /home/sora/Downloads/ffxi-dashboard
npm run build:all
docker compose build && docker compose up -d --force-recreate
```

Wait for the container to report ready:

```bash
docker compose logs --tail=20 dashboard
```

Expected: `FFXI Dashboard running on port 3000` in the log, no errors.

- [ ] **Step 3: Verify live via curl**

```bash
TOK=$(curl -s -X POST http://localhost:3001/api/login -H 'Content-Type: application/json' -d '{"login":"Sora","password":"YourPassword1"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s "http://localhost:3001/api/db/items?rareex=1" -H "Authorization: Bearer $TOK" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(len(d), 'rows')
assert len(d) > 0, 'expected at least one rare/ex item'
assert all((r['flags'] & 0xC000) != 0 for r in d), 'found a row without RARE or EX flag set'
print('all rows have RARE or EX flag set: OK')
"
```

Expected output: a row count followed by `all rows have RARE or EX flag set: OK`. If the assertion fails, re-check the flag arithmetic in Step 1 (0xC000, not 0x4000 or 0x8000 alone).

- [ ] **Step 4: Commit**

```bash
git add src/routes/db.ts
git commit -m "$(cat <<'EOF'
routes: add rareex filter param to GET /api/db/items

Matches ib.flags against RARE|EX (0xC000) combined, unlike the existing
rare param which only checks the RARE bit alone. Backs the Items
Rare/Ex toggle chip added client-side in a later commit.
EOF
)"
```

---

### Task 2: Client — fix the `ITEM_TYPE` map (bug fix, no new UI)

**Files:**
- Modify: `client/src/components/pages/Database.tsx:573-582` (the `ITEM_TYPE` map)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ITEM_TYPE: Record<number, string>` now maps `1..8` correctly (`General/Linkshell/Furnishing/Puppet/Usable/Equipment/Weapon/Currency`), consumed by (a) the type-chip labels at line 445, (b) the detail panel's `Type` `DRow` at line 674. Task 3 also reads this map's keys `6` and `7` by number to decide which second-level filter row to show — those literal numbers (not new named constants) are what Task 3 branches on.

- [ ] **Step 1: Replace the map**

Open `client/src/components/pages/Database.tsx`. Find:

```ts
// item_basic.type values
const ITEM_TYPE: Record<number, string> = {
  0:'Basic', 1:'Armor', 2:'Weapon', 3:'Linkshell', 4:'Gil', 5:'Key Item', 6:'Food',
  7:'Crystal', 8:'Voucher', 9:'Slip', 10:'Linkshell 2', 11:'Instinct', 12:'Coupon',
  13:'Chocobo Ticket', 14:'Seasonal', 15:'Avatar', 16:'Temporary', 17:'Jug Pet', 18:'NPC',
  19:'Furnishing', 20:'Plant', 21:'Flowerpot', 22:'Mannequin', 23:'Book', 24:'Strap',
  25:'Dice', 26:'Ninja Tool', 27:'Fishing', 28:'Bait', 29:'Pet', 30:'Automaton',
  31:'Armor Set', 32:'Stall', 33:'Event', 34:'Misc', 36:'Fellow', 37:'Emerald',
  38:'Training', 39:'Record', 40:'Meal', 41:'Crest', 42:'Fetish', 43:'Merit',
  44:'Ability', 45:'TP', 46:'Ranged', 47:'Throwing',
};
```

Replace with:

```ts
// item_basic.type values — verified against /home/sora/ffxi/sql/item_basic.sql
// (@GENERAL_TYPE=1 .. @CURRENCY_TYPE=8) and live GET /api/db/items?type=N
// for N=1..8. The old map here did not match this schema at all.
const ITEM_TYPE: Record<number, string> = {
  1: 'General', 2: 'Linkshell', 3: 'Furnishing', 4: 'Puppet',
  5: 'Usable', 6: 'Equipment', 7: 'Weapon', 8: 'Currency',
};

// item_equipment.slot bit indices, used both for the Items detail panel's
// "Slot" row and the Equipment second-level filter chips (Task 3).
const SLOT_NAMES = ['Main','Sub','Range','Ammo','Head','Body','Hands','Legs','Feet','Neck','Waist','L.Ear','R.Ear','L.Ring','R.Ring','Back'];

// item_weapon.skill values — verified live against GET /api/db/items?type=7&skill=N
// for N=1..15, matches /home/sora/ffxi/sql/item_basic.sql's AH weapon category list.
const WEAPON_SKILL_NAMES: Record<number, string> = {
  1: 'H2H', 2: 'Dagger', 3: 'Sword', 4: 'Greatsword', 5: 'Axe', 6: 'Greataxe',
  7: 'Scythe', 8: 'Polearm', 9: 'Katana', 10: 'Greatkatana', 11: 'Club',
  12: 'Staff', 13: 'Bow', 14: 'Instrument', 15: 'Ammunition',
};
```

- [ ] **Step 2: Remove the now-duplicate local `SLOT_NAMES` inside `DetailView`**

In the same file, find (inside `function DetailView`, the `if (cat === 'items') {` block):

```ts
  if (cat === 'items') {
    const slots = Number(data.slot ?? 0);
    const SLOT_NAMES = ['Main','Sub','Range','Ammo','Head','Body','Hands','Legs','Feet','Neck','Waist','L.Ear','R.Ear','L.Ring','R.Ring','Back'];
    const equippedSlots = SLOT_NAMES.filter((_, i) => (slots >> i) & 1);
```

Replace with (drop the local `const SLOT_NAMES = [...]` line — it now shadows the module-level one added in Step 1, and the shadow copy is dead weight):

```ts
  if (cat === 'items') {
    const slots = Number(data.slot ?? 0);
    const equippedSlots = SLOT_NAMES.filter((_, i) => (slots >> i) & 1);
```

- [ ] **Step 3: Rebuild the client**

```bash
cd /home/sora/Downloads/ffxi-dashboard
npm run build:all
```

Expected: exit 0, no TypeScript errors. (If `SLOT_NAMES` reports as unused or duplicate-declared, confirm Step 2's edit landed — `DetailView` and the main component are both module-level and must not have two `SLOT_NAMES` declarations in overlapping scope.)

- [ ] **Step 4: Deploy and verify live**

```bash
docker compose build && docker compose up -d --force-recreate
```

Using Playwright (chromium at `/home/sora/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`, `playwright-core` available in `<scratchpad>/node_modules`), log in as `Sora`/`YourPassword1`, open Database → Items, and for each of the 8 corrected type chips, click it and screenshot the first result row's detail panel. Confirm:
- Clicking "Equipment" returns armor (e.g. search `bronze_subligar`, confirm `Type: Equipment` in the detail panel, not `Type: Food`).
- Clicking "Weapon" returns weapons (e.g. sample row name contains a known weapon like `cesti` or `dagger`, not a linkshell).
- Clicking "Linkshell" returns linkshells (e.g. sample row name contains `linkshell` or `linkpearl`).

- [ ] **Step 5: Commit**

```bash
git add public/index.html client/src/components/pages/Database.tsx
git commit -m "$(cat <<'EOF'
database: fix mislabeled Items type chips

ITEM_TYPE mapped item_basic.type values to the wrong category names
entirely (clicking "Weapon" returned linkshells, "Armor" returned
fishing rods) — verified against /home/sora/ffxi/sql/item_basic.sql,
the real enum is General/Linkshell/Furnishing/Puppet/Usable/Equipment/
Weapon/Currency for 1-8, not the 47-entry map that was here before.

Also hoists SLOT_NAMES to module scope so the upcoming Equipment
slot-filter chips (next commit) can reuse the same array the detail
panel already uses.
EOF
)"
```

(`public/index.html`'s asset hash changes on every client build and is committed alongside source changes per this repo's established pattern — same as every prior task in this feature area.)

---

### Task 3: Client — second-level Slot/Weapon-skill filter chips

**Files:**
- Modify: `client/src/components/pages/Database.tsx`
  - State declarations (~line 149)
  - `load()` params-building block (~line 196) and its two dependency arrays (~line 239, 241)
  - `selectCat` (~line 401)
  - Toolbar render block (~line 442-447)

**Interfaces:**
- Consumes: `ITEM_TYPE` (for the `6`/`7` type-id checks), `SLOT_NAMES`, `WEAPON_SKILL_NAMES`, `chipBtn` — all from Task 2 / pre-existing.
- Produces: `slotFilter: number | null` and `skillFilter: number | null` state, consumed by `load()`'s params block. Task 4 does not depend on these directly (Rare/Ex is independent) but does reuse the same reset pattern in `selectCat`.

- [ ] **Step 1: Add state**

Find (around line 149):

```ts
  const [typeFilter, setTypeFilter] = useState<number | null>(null);
```

Add directly after it:

```ts
  const [typeFilter, setTypeFilter] = useState<number | null>(null);
  const [slotFilter, setSlotFilter] = useState<number | null>(null);
  const [skillFilter, setSkillFilter] = useState<number | null>(null);
```

- [ ] **Step 2: Wire a type-change handler that resets the second-level filter**

Find (around line 400-402):

```ts
  function selectCat(key: Category) {
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setJobFilter(null); setTypeFilter(null); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
  }
```

Replace with:

```ts
  function selectCat(key: Category) {
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
  }

  function selectTypeFilter(v: number | null) {
    setTypeFilter(v); setSlotFilter(null); setSkillFilter(null);
  }
```

- [ ] **Step 3: Wire the two new params into `load()`**

Find (around line 196):

```ts
    if (cat === 'items' && typeFilter !== null) params.type = typeFilter;
```

Replace with:

```ts
    if (cat === 'items' && typeFilter !== null) params.type = typeFilter;
    if (cat === 'items' && typeFilter === 6 && slotFilter !== null) params.slot = slotFilter;
    if (cat === 'items' && typeFilter === 7 && skillFilter !== null) params.skill = skillFilter;
```

- [ ] **Step 4: Add both to the two dependency arrays**

Find (around line 239):

```ts
  }, [cat, page, search, zoneFilter, jobFilter, typeFilter, questLogFilter, sortKey, sortDir, dialogZone]);
```

Replace with:

```ts
  }, [cat, page, search, zoneFilter, jobFilter, typeFilter, slotFilter, skillFilter, questLogFilter, sortKey, sortDir, dialogZone]);
```

Find (around line 241):

```ts
  useEffect(() => { load(true); }, [cat, zoneFilter, jobFilter, typeFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

Replace with:

```ts
  useEffect(() => { load(true); }, [cat, zoneFilter, jobFilter, typeFilter, slotFilter, skillFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 5: Render the second-level chip row and switch the type chips to the new handler**

Find (around line 442-447):

```ts
        {hasTypeFilter && itemTypes.length > 0 && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, typeFilter, setTypeFilter)}
            {itemTypes.map(t => chipBtn(ITEM_TYPE[t.type] ?? `Type ${t.type}`, t.type, typeFilter, setTypeFilter))}
          </div>
        )}
```

Replace with:

```ts
        {hasTypeFilter && itemTypes.length > 0 && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, typeFilter, selectTypeFilter)}
            {itemTypes.map(t => chipBtn(ITEM_TYPE[t.type] ?? `Type ${t.type}`, t.type, typeFilter, selectTypeFilter))}
          </div>
        )}
        {hasTypeFilter && typeFilter === 6 && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, slotFilter, setSlotFilter)}
            {SLOT_NAMES.map((name, i) => chipBtn(name, 1 << i, slotFilter, setSlotFilter))}
          </div>
        )}
        {hasTypeFilter && typeFilter === 7 && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, skillFilter, setSkillFilter)}
            {Object.entries(WEAPON_SKILL_NAMES).map(([id, name]) => chipBtn(name, Number(id), skillFilter, setSkillFilter))}
          </div>
        )}
```

- [ ] **Step 6: Rebuild**

```bash
cd /home/sora/Downloads/ffxi-dashboard
npm run build:all
```

Expected: exit 0, no TypeScript errors.

- [ ] **Step 7: Deploy and verify live**

```bash
docker compose build && docker compose up -d --force-recreate
```

Via Playwright: log in, open Database → Items, click the "Equipment" type chip, confirm a second row of 16 slot chips appears below it (Main/Sub/Range/Ammo/Head/Body/Hands/Legs/Feet/Neck/Waist/L.Ear/R.Ear/L.Ring/R.Ring/Back). Click "Legs" — confirm the row count drops and the first result's detail panel shows `Slot: Legs`. Then click the "Weapon" type chip — confirm the slot-chip row disappears and a 15-chip skill row (H2H/Dagger/Sword/.../Ammunition) appears instead. Click "Axe" — confirm results are all axes (e.g. `bronze_axe`, `brass_axe`). Then click "All" on the top-level type row — confirm both the skill row and any active slot/skill filter clear.

- [ ] **Step 8: Commit**

```bash
git add public/index.html client/src/components/pages/Database.tsx
git commit -m "$(cat <<'EOF'
database: add Slot filter (Equipment) and Weapon-skill filter (Weapon)

Both reuse backend query params (slot, skill) that GET /api/db/items
already supported but the client never sent. Second-level chip row
appears under the type chips, conditional on which type is selected,
and clears whenever the type selection changes.
EOF
)"
```

---

### Task 4: Client — Rare/Ex toggle chip + full verification checkpoint

**Files:**
- Modify: `client/src/components/pages/Database.tsx`
  - State declaration (~line 149, alongside Task 3's additions)
  - `load()` params-building block (~line 196) and its two dependency arrays (~line 239, 241)
  - `selectCat` (~line 401)
  - Toolbar render block (near the search form, ~line 416-420)

**Interfaces:**
- Consumes: `chipBtn`, Task 1's `rareex` backend param.
- Produces: `rareExFilter: boolean` state. Nothing downstream depends on this — it's the last piece of this plan.

- [ ] **Step 1: Add state**

Find (this line was added in Task 3 Step 1):

```ts
  const [skillFilter, setSkillFilter] = useState<number | null>(null);
```

Add directly after it:

```ts
  const [skillFilter, setSkillFilter] = useState<number | null>(null);
  const [rareExFilter, setRareExFilter] = useState(false);
```

- [ ] **Step 2: Reset it in `selectCat`**

Find (this line was set in Task 3 Step 2):

```ts
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
```

Replace with:

```ts
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setRareExFilter(false); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
```

- [ ] **Step 3: Wire the param into `load()`**

Find (added in Task 3 Step 3):

```ts
    if (cat === 'items' && typeFilter === 7 && skillFilter !== null) params.skill = skillFilter;
```

Add directly after it:

```ts
    if (cat === 'items' && typeFilter === 7 && skillFilter !== null) params.skill = skillFilter;
    if (cat === 'items' && rareExFilter) params.rareex = 1;
```

- [ ] **Step 4: Add to both dependency arrays**

Find (updated in Task 3 Step 4):

```ts
  }, [cat, page, search, zoneFilter, jobFilter, typeFilter, slotFilter, skillFilter, questLogFilter, sortKey, sortDir, dialogZone]);
```

Replace with:

```ts
  }, [cat, page, search, zoneFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]);
```

Find (updated in Task 3 Step 4):

```ts
  useEffect(() => { load(true); }, [cat, zoneFilter, jobFilter, typeFilter, slotFilter, skillFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

Replace with:

```ts
  useEffect(() => { load(true); }, [cat, zoneFilter, jobFilter, typeFilter, slotFilter, skillFilter, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 5: Render the toggle chip next to search**

Find (around line 434):

```ts
          <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>{rows.length} rows</span>
        </div>
```

Replace with:

```ts
          {cat === 'items' && chipBtn('Rare/Ex', 1, rareExFilter ? 1 : null, (v) => setRareExFilter(v === 1))}
          <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>{rows.length} rows</span>
        </div>
```

- [ ] **Step 6: Rebuild**

```bash
cd /home/sora/Downloads/ffxi-dashboard
npm run build:all
```

Expected: exit 0, no TypeScript errors.

- [ ] **Step 7: Deploy**

```bash
docker compose build && docker compose up -d --force-recreate
docker compose logs --tail=20 dashboard
```

Expected: `FFXI Dashboard running on port 3000`, no errors.

- [ ] **Step 8: Full live verification checkpoint (Playwright)**

Log in as `Sora`/`YourPassword1`, open Database → Items, and confirm each of the following, screenshotting each state:

1. Click "Rare/Ex" alone (no type filter) — confirm the row count drops and every visible result is a known rare/ex item.
2. Click "Equipment" then "Legs" then "Rare/Ex" together — confirm results are rare/ex leg armor only (a small, non-empty set).
3. Click "All" on the type row — confirm the slot-chip row disappears, but "Rare/Ex" stays active (it's independent of type, per Task 4 Step 2's reset only firing on category switch, not type switch).
4. Click a different category in the sidebar (e.g. NPCs) then back to Items — confirm "Rare/Ex", the type filter, and any slot/skill filter have all reset to inactive (per `selectCat`).
5. Re-run the 8-type-chip walkthrough from Task 2 Step 4 once more end-to-end, to confirm nothing in Tasks 3-4 regressed it.

- [ ] **Step 9: Commit**

```bash
git add public/index.html client/src/components/pages/Database.tsx
git commit -m "$(cat <<'EOF'
database: add Rare/Ex toggle chip for Items

Independent of the type filter — combines with any type/slot/skill
selection. Backed by the rareex query param added to GET /api/db/items
in an earlier commit.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Section 1 (type-map fix) → Task 2. Section 2 (slot/skill second-level chips) → Task 3. Section 3 (Rare/Ex toggle + backend param) → Tasks 1 and 4. All three approved design sections have a task.
- **Placeholder scan:** No TBD/TODO; every step has literal code, not a description of code.
- **Type consistency:** `slotFilter`/`skillFilter`/`rareExFilter` are declared once (Tasks 3/4) and referenced with the same names in every later step. `selectTypeFilter` (Task 3 Step 2) is the only new function name introduced and it's used consistently in Task 3 Step 5. `SLOT_NAMES`/`WEAPON_SKILL_NAMES`/`ITEM_TYPE` (Task 2) are referenced by the same names in Task 3.
