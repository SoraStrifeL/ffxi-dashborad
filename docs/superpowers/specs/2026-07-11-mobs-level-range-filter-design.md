# Mobs Level Range Filter — Design

## Problem

The Database tab's Mobs category has Region, Ecosystem, and Aggro-only
filters (shipped 2026-07-08), plus `min_lvl`/`max_lvl` columns in the
results table — but no way to narrow to "what's around my level." Finding
level-appropriate mobs currently means sorting by level and scrolling.
`MOB_CATALOG` already carries `min_lvl`/`max_lvl` per row (from
`loadMobCatalog()`'s `MIN(m.minLevel)`/`MAX(m.maxLevel)`), so this is the
same "free win" shape as every other filter added this session.

## Decision (confirmed with user)

Two number inputs (Min Lv / Max Lv), placed next to the existing
"Aggro only" toggle. Filters using **overlap semantics**: a mob whose own
spawn range is `min_lvl`-`max_lvl` matches a search range if the two
ranges overlap at all — e.g. a mob spawning 68-72 shows up for a search of
70-75, since it's still relevant to a level-70-75 player. This matches how
players actually think about "what can I fight," not a strict-containment
match that would hide adjacent-level mobs. Updates instantly on change,
same interaction as every other Mobs filter (Region/Ecosystem/Aggro/zone
dropdown), not a submit-triggered search like the free-text search box.

## Backend change

### `src/routes/db.ts` — `GET /api/db/mobs`

New `?minLv=`/`?maxLv=` params (either or both may be present):

```ts
const minLv = req.query.minLv ? parseInt(req.query.minLv as string) : null;
const maxLv = req.query.maxLv ? parseInt(req.query.maxLv as string) : null;
// ...
if (minLv !== null && !isNaN(minLv)) rows = rows.filter(r => (r.max_lvl as number) >= minLv);
if (maxLv !== null && !isNaN(maxLv)) rows = rows.filter(r => (r.min_lvl as number) <= maxLv);
```

Same shape as the existing `aggro`/`ecosystem` filters — in-memory
`.filter()` over `MOB_CATALOG`, no SQL/catalog changes (both columns are
already selected). Two independent filters (not one range check) so either
bound can be used alone — e.g. `?minLv=70` alone means "70 and up," no
upper bound.

## Client change (`Database.tsx`)

- New state: `mobsMinLv`, `mobsMaxLv` (`number | null` each).
- New number inputs (Mobs only, placed next to the existing "Aggro only"
  chip): plain `<input type="number">` styled to match the existing
  `zoneFilter` `<select>` (same padding/border/background), narrow width
  (~60px), placeholders "Min Lv" / "Max Lv".
- Wired into `load()`'s params (gated `cat === 'mobs'`) and both dependency
  arrays; reset in `selectCat` alongside every other filter.
- No detail-panel changes — level range is already shown there today (via
  the existing `min_lvl`/`max_lvl` columns).

## Data flow

`GET /api/db/mobs?minLv=70&maxLv=75` → in-memory filter on `MOB_CATALOG`
(`max_lvl >= 70 AND min_lvl <= 75`) → client renders. No changes to
`loadCatalogs()`/startup.

## Error handling

None new — same shape as every existing numeric-ish param in this route
(`isNaN` guard, absent/invalid param simply not applied).

## Testing

No `tests/integration/db-mobs-filters.test.ts` exists yet — create it,
following the mount/auth pattern of `tests/integration/db-items-filters.test.ts`
(supertest + `createDbRouter`), but `GET /api/db/mobs` filters
`MOB_CATALOG` (an exported mutable in-memory array populated at startup,
`export let MOB_CATALOG: RowDataPacket[] = []` in `src/catalog.ts`), not a
live SQL query — so seed `MOB_CATALOG` directly by importing and
reassigning it in the test file (e.g. in a `beforeEach`), rather than
mocking `pool.execute`. Cases: minLv alone, maxLv alone, both together
(overlap semantics — confirm a mob whose range partially overlaps the
search range is included, and one entirely outside it is excluded),
combined with an existing filter (aggro) for AND-semantics coverage.
