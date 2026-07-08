# Mobs Organization Options — Design

## Problem

The Database tab's Mobs category, like NPCs before it, has only a search box
and a per-zone dropdown. There's no way to narrow to a whole nation, filter
by monster family/ecosystem (Beastmen, Undead, Dragon, etc.), or isolate
aggressive mobs — every row looks the same regardless of type.

## Verified facts driving the design

- **`region` already works server-side for Mobs** (`src/routes/db.ts`'s
  `GET /api/db/mobs`, same `_mobRegionMatch`/`NPC_REGION_SQL` helper the
  NPCs feature just wired up), just never called by any client. Zero
  backend risk — same free win as the NPCs region filter.
- **`ecosystem` already works server-side too** (`?ecosystem=` on the same
  route), also never called by the client. Verified live against the
  running DB: 23 real, non-null ecosystem categories with substantial
  counts (Beastmen 16,645 down to SupremeBeings 130), plus ~15,812
  spawn-point rows with no species/pool match at all (`ecosystem IS NULL`
  — placeholder/unused spawns) which must never surface as a filter
  option.
- **No `aggro` filter exists yet.** `aggro` is already shown as a column
  (checkmark) in the Mobs table, sourced from the `/api/db/mobs/detail`
  per-row query — but `MOB_CATALOG` (the in-memory list `/api/db/mobs`
  serves from) doesn't carry it at all today; `loadMobCatalog()`'s SQL
  needs one more aggregate column.
- Confirmed live: `mob_pools.aggro` is a plain `0`/`1`/`NULL` flag,
  aggregated the same way (`MIN(mp.aggro)`) as every other per-mob stat
  already in this query (`family`, `ecosystem`, `links`).

## Decisions (confirmed with user)

1. Ecosystem is a **chip row** (not a dropdown), despite having 23 options
   — user chose consistency with every other filter in this file over
   fewer visible options. It wraps (`flexWrap: 'wrap'`), same as every
   other chip row already does.
2. Region + Ecosystem + Aggro are bundled into one pass (not ecosystem
   alone) — region and the ecosystem-counts endpoint are both cheap wins
   already sitting in/near the backend.
3. All three filters combine with AND semantics with each other and the
   existing zone dropdown/search box, and reset together on category
   switch — same convention as every other filter in this file.
4. The region chip list (`San d'Oria`/`Bastok`/`Windurst`/`Jeuno`/
   `Aht Urhgan`/`Adoulin`) is not NPC-specific — it's renamed from
   `NPC_REGIONS` to `REGIONS` and reused as-is for Mobs, rather than
   duplicating an identical constant.

## Backend changes

### `src/catalog.ts`

- `loadMobCatalog()`'s SQL gains `MIN(mp.aggro) AS aggro` to the existing
  `SELECT`/`GROUP BY` (which already joins `mob_pools mp`) — one line, no
  new join.

### `src/routes/db.ts`

- `GET /api/db/mobs` gains `?aggro=1`: filters `row.aggro === 1`.
  (`?region=` and `?ecosystem=` already exist, unchanged.)
- New `GET /api/db/mob-ecosystems`, `requireAuth`: returns
  `{ecosystem, cnt}[]` computed in-memory from `MOB_CATALOG`, counting
  only non-null ecosystem values (mirrors `/api/db/npc-roles`'s shape and
  reasoning — cheap in-memory pass, no DB query, no cache needed).

## Client changes (`Database.tsx`)

- Rename the NPCs feature's `NPC_REGIONS` constant to `REGIONS` (drop the
  NPC-specific name now that Mobs reuses it) and update its one call site
  in the NPCs toolbar accordingly.
- New state: `mobsRegionFilter`, `mobsEcosystemFilter` (`string | null`),
  `aggroFilter` (`boolean`), `mobEcosystems` (`{ecosystem:string;
  cnt:number}[]`, fetched once via new `api.dbMobEcosystems()`).
  (Separate from NPCs' `regionFilter`/`roleFilter` state — Mobs and NPCs
  are different categories that can't be filtered simultaneously, but
  keeping the state distinct avoids one category's filter bleeding into
  the other's toolbar on category switch, which is how every existing
  per-category filter in this file already works, e.g. `typeFilter` vs
  `jobFilter`.)
- Toolbar (Mobs category only): Region chip row (`REGIONS`, reused),
  Ecosystem chip row (`mobEcosystems`, gated on non-empty, one chip per
  real ecosystem value — no relabeling needed, the DB strings are already
  display-ready), and an `Aggro only` toggle chip next to the row-count
  text (identical pattern to Items' `Rare/Ex` toggle).
- Wired into `load()`'s params (gated on `cat === 'mobs'`) and both
  dependency arrays; reset in `selectCat`.
- No detail-panel changes — `ecosystem`/`aggro` are already shown there
  today (via the existing `/api/db/mobs/detail` fetch), this only adds
  list-level filtering.

## Data flow

`loadMobCatalog()` (startup + existing 5-min refresh, one new aggregate
column, no new scanning step) → `GET /api/db/mobs?region=&ecosystem=&aggro=`
filters `MOB_CATALOG` → client renders. `GET /api/db/mob-ecosystems`
computed fresh from `MOB_CATALOG` per call. No changes to the Mobs detail
panel, Wiki button, or Map link.

## Error handling

No new failure surface — this is a SQL column addition plus in-memory
filtering, not a filesystem/script dependency like the NPC roles feature.
Empty `MOB_CATALOG` (DB unreachable) degrades exactly as it already does
today: empty rows, empty ecosystem chip list, `/api/db/mob-ecosystems`
returns `[]`.

## Testing

No new pure logic worth a unit test — this is a SQL column plus
straightforward filters/chips, the same shape as the Items filter fix,
which was verified live only. Live verification: confirm Region, Ecosystem,
and Aggro chips each narrow results correctly, combine with each other and
the existing zone dropdown/search box, and reset correctly on category
switch.
