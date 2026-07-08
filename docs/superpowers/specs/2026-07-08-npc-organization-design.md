# NPC Organization Options — Design

## Problem

The Database tab's NPCs category has only a search box and a per-zone
dropdown. There is no way to narrow to a whole region (San d'Oria, Bastok,
etc.) or to tell NPC roles apart (shopkeeper vs. quest-giver vs. generic) —
every row looks the same regardless of what the NPC actually does in-game.

## Verified facts driving the design

- **A `region` filter already exists and works server-side**, for both
  `/api/db/npcs` and `/api/db/mobs` (`src/routes/db.ts:203,209` /
  `:218,225`), backed by `NPC_REGION_SQL` / `_mobRegionMatch()` in
  `src/catalog.ts:212-232` (regions: `san_doria`, `bastok`, `windurst`,
  `jeuno`, `aht_urhgan`, `adoulin`). It has simply never been wired up in
  the client — no UI anywhere sends `?region=`. This is a zero-backend-risk
  win: expose it as chips.
- **NPCs have no DB column for "role."** LSB encodes NPC behavior entirely
  in each NPC's Lua script (`scripts/zones/<Zone>/npcs/<Name>.lua`), not in
  `npc_list`. Spot-checked and counted live against the mounted
  `SERVER_SCRIPTS_ROOT` tree (~3,380 NPC scripts total):
  - `xi.shop.*` calls → 279 scripts (reliable "Shop/Vendor" signal —
    e.g. `xi.shop.general(player, stock, ...)`).
  - `xi.quest.*` references → 282 scripts ("Quest" signal).
  - `xi.mission.*` references → 103 scripts ("Mission" signal).
  - `xi.homepoint.*` references → 121 scripts ("Homepoint/Warp" signal).
  - **"Guard" has no reliable signature** — guard NPCs are not individually
    scripted (zero `*guard*`-named script files found), so this role is not
    derivable and is explicitly out of scope.
- An NPC's script can trip more than one signature (e.g. a vendor whose
  dialogue also branches on quest status) — roles are a set, not a single
  category, unlike Items' `type` column.
- This reuses the same `SERVER_SCRIPTS_ROOT` mount and script-locating
  convention already established by the NPC Dialogue Display feature
  (`src/npc-dialog.ts`) — not `LSB_SCRIPTS_DIR`, which has no `zones/`
  subtree.

## Decisions (confirmed with user)

1. Role scope: all 4 detectable roles (Shop, Quest, Mission, Homepoint), no
   Guard tag.
2. Region filter included alongside role tags (same toolbar), using the
   already-working backend param.
3. Role classification is a **one-time startup scan**, not tied to the
   existing 5-minute `NPC_CATALOG` DB refresh — Lua script files on disk
   don't change at runtime, so rescanning ~3,380 files every 5 minutes would
   be pure waste. This mirrors how this repo's other Lua-derived catalogs
   (quests, effects, key items) are parsed once at startup, while only the
   DB-driven parts of `NPC_CATALOG` refresh periodically.
4. Role filter chips are single-select (click one role to filter, "All" to
   reset) — same interaction as every other filter row in `Database.tsx`
   (job filter, item type filter, quest log filter). Selecting a role shows
   NPCs whose role set includes it, regardless of any other roles they also
   have.
5. Role chips are gated on non-zero counts (mirrors the Items type-chip
   `itemTypes.length > 0` gating) so an unmounted scripts tree degrades to
   simply not showing the role row, not a row of all-zero chips.
6. Detail panel shows a NPC's roles inline (e.g. "Roles: Shop, Quest") when
   non-empty; omitted entirely when empty — this is a minor supplementary
   tag, not a primary feature needing an explicit "none found" note (unlike
   the Dialogue section).

## Backend changes

### `src/npc-roles.ts` (new file)

- `scanNpcRoles(): Map<string, string[]>` — walks
  `${SERVER_SCRIPTS_ROOT}/zones/*/npcs/*.lua` once, reads each file (each
  read wrapped in its own try/catch — one bad file doesn't abort the whole
  scan), and tests the raw text against 4 regexes:
  `/xi\.shop\./`, `/xi\.quest\./`, `/xi\.mission\./`, `/xi\.homepoint\./`.
  Records the matched role name(s) per file.
- Map is keyed `` `${zoneDirName}::${npcFileBaseName}` ``, exact-match only
  — this is a bulk classification pass over the whole tree, not the
  single-NPC fuzzy lookup `resolveNpcDialog` does. An NPC catalog row with
  no matching script key simply gets `role: []`.
- Missing `SERVER_SCRIPTS_ROOT` mount (directory doesn't exist) → returns
  an empty map, never throws — same degradation convention as
  `resolveNpcDialog`.
- Called once at server startup (alongside the other one-time Lua catalog
  loaders), cached as a module-level `NPC_ROLE_MAP`, **not** re-invoked by
  the existing 5-minute `setInterval` that refreshes `NPC_CATALOG`.

### `src/catalog.ts`

- `loadNpcCatalog()` attaches `role: string[]` to each row by looking up
  `` `${row.zone}::${row.name}` `` in the cached `NPC_ROLE_MAP` (default
  `[]` on miss). This lookup re-runs on every 5-minute catalog refresh (DB
  rows can change), but reads from the already-computed static map — no
  rescanning of the script tree.

### `src/routes/db.ts`

- `GET /api/db/npcs` gains `?role=shop|quest|mission|homepoint`: filters
  `NPC_CATALOG` rows where `row.role.includes(role)`.
- New `GET /api/db/npc-roles`, `requireAuth`: returns `{role, cnt}[]`
  computed in-memory from the current `NPC_CATALOG` (counts of NPCs whose
  `role` array includes each of the 4 known role names). No DB query, no
  Redis cache needed — it's a cheap in-memory pass over an already-loaded
  array, unlike `/api/db/item-types` which aggregates a live SQL table.

## Client changes (`Database.tsx`)

- New state: `regionFilter: string | null`, `roleFilter: string | null`,
  `npcRoles: {role: string; cnt: number}[]` (fetched once via
  `api.dbNpcRoles()`, same lifecycle as the existing `itemTypes` fetch).
- New toolbar rows, NPCs category only:
  - **Region chips**: `All / San d'Oria / Bastok / Windurst / Jeuno / Aht
    Urhgan / Adoulin` — static list (same hardcoded-array pattern as
    `JOB_ABBR`), wired to `region` query param. Always shown for NPCs (no
    count-gating needed — it's a fixed geographic list, not data-derived).
  - **Role chips**: `All` + one chip per entry in `npcRoles` with `cnt > 0`
    (label-cased: Shop, Quest, Mission, Homepoint), wired to `role` query
    param. Rendered only when `npcRoles` has at least one non-zero entry.
- Both filters reset on category switch (`selectCat`), combine freely with
  the existing zone dropdown and search box, and are added to `load()`'s
  param composition and its dependency arrays (`useCallback` + `useEffect`)
  — same wiring shape as `slotFilter`/`skillFilter` in the Items fix.
- Detail panel (`cat === 'npcs'` case in `DetailView`): one new row below
  the existing ID/Zone/X/Z block — `Roles: {row.role.join(', ')}` — only
  rendered when `row.role.length > 0`. No new fetch: `role` already arrives
  on the row from `/api/db/npcs`.
- `client/src/api.ts`: new `dbNpcRoles: () => req<{role:string; cnt:number}[]>('/api/db/npc-roles')`.

## Data flow

Startup: `scanNpcRoles()` walks the script tree once → `NPC_ROLE_MAP`
(module-level, static for process lifetime) → `loadNpcCatalog()` attaches
`role` to each row on every 5-min refresh, reading (not recomputing) that
map.

Request: `GET /api/db/npcs?region=bastok&role=shop` → filters `NPC_CATALOG`
by both → client renders rows with a `role` field on each → detail panel
shows it inline when present.

No changes to the existing Dialogue section, Wiki button, zone dropdown, or
search — this is additive, parallel filtering.

## Error handling

Matches this repo's established scripts-tree convention: missing
`SERVER_SCRIPTS_ROOT` mount, missing `zones/` subtree, or an individual
unreadable script file all resolve to an empty/partial role map rather than
throwing. The `/api/db/npc-roles` route itself can't fail in a way that
needs a 500 — it's pure in-memory computation over data that's already
loaded, no I/O at request time.

## Testing

- Unit tests for the pure classification function (given script text,
  which of the 4 roles match) in `tests/unit/npc-roles.test.ts` — cases:
  single-role match, multi-role match (e.g. shop + quest in one script),
  zero-role match, same in-memory-fixture style as
  `tests/unit/dat-enrichment.test.ts`.
- Live verification (no client test harness exists, per this repo's
  established convention for `Database.tsx` changes): confirm Region chips
  narrow the NPC list to the correct zones; confirm the Shop role chip
  includes a known vendor NPC (e.g. Kazham's Nuh Celodehki) and excludes a
  non-vendor; confirm region + role + zone dropdown + search all combine
  correctly; confirm the detail panel shows "Roles: ..." for a tagged NPC
  and omits the line for an untagged one.
