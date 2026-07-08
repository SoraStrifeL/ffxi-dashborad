# NPC Dialogue Display — Design

## Problem

The Database tab's NPCs category shows only NPC ID/Zone/X/Z in the detail
panel — no way to see what an NPC actually says in-game. The existing
Dialog category (Client Reference group) shows a zone's raw DAT dialog
array by sequential index, which is not linked to any specific NPC.

Goal: show real, per-NPC dialogue text in the NPC detail panel.

## Verified facts driving the design

Spot-checked live against the mounted LSB script tree
(`/home/sora/ffxi/scripts`) and the running dashboard before designing:

- **NPC scripts are matchable by (zone, name) directly.** DB NPC `Nembet`
  in zone `Southern_San_dOria_[S]` (DB `zone_settings.name`, confirmed via
  `GET /api/zones`) matches
  `scripts/zones/Southern_San_dOria_[S]/npcs/Nembet.lua` exactly — no
  normalization needed for the common case. Same directory-naming
  convention already relied on elsewhere in this codebase (Dialog
  category, Map, Scripts browser).
- **NPC scripts reference dialogue via named constants**, not raw numbers:
  `player:showText(npc, ID.text.ITEM_DELIVERY_DIALOG)` where
  `local ID = zones[xi.zone.SOUTHERN_SAN_DORIA_S]`.
- **Each zone's `IDs.lua` defines those constants with the actual English
  text inline as a comment**:
  `ITEM_DELIVERY_DIALOG = 11237, -- If'n ye have goods tae deliver, then
  Nembet be yer man!` — spot-checked across 3 different zones
  (Southern San d'Oria [S], Bastok Markets, Windurst Waters, Ranguemont
  Pass), comments consistently present on every entry sampled.
- **This numbering is unrelated to the existing per-zone Dialog category's
  array-index numbering** (`src/dat/index.ts`'s `getDialog()`, which
  returns a zone-local `string[]` indexed 0,1,2,... from the DAT file).
  `IDs.lua`'s numbers (6385, 11237, ...) are a different, larger id space.
  This feature does not touch or reuse the existing Dialog category's
  data path — it's a new, independent extraction from the Lua script tree.
- **This is scripts-only, not DAT-dependent.** No dependency on
  `datEnabled` / the client DAT mount — only `LSB_SCRIPTS_DIR`, same as
  the existing Quest walkthrough feature. Degrades gracefully (empty
  result) when scripts aren't mounted, per this repo's established
  mount-degradation convention.

## Decisions (confirmed with user)

1. Show **all** dialogue lines a script references, not just the first —
   each labeled with its constant name, since a script commonly has
   several conditional/alternate lines (before/after a quest, different
   NPC moods, etc.), not one fixed greeting.
2. When no script matches, or a matched script references no dialogue
   constants at all, show an **explicit "No dialogue found for this NPC."**
   note — consistent with how Items/Abilities/Quests already handle their
   own "nothing available" case, never a silently-omitted section.
3. Auto-fetch on detail-panel open (same trigger point as the existing
   Quest walkthrough auto-fetch), not a manual button — dialogue is core
   NPC info, not a supplementary external lookup like the existing NPC
   Wiki button (which stays, unrelated, both coexist).
4. Endpoint is `requireAuth` only, not admin-gated — it returns extracted
   text, not raw script source, same tier as the quest walkthrough (which
   all users already see), not the admin-only raw script viewer
   (`/api/questscript`, gated by `requireAdmin` because it exposes full
   Lua source + `getCharVar` names).

## Backend changes

### `src/npc-dialog.ts` (new file)

`src/catalog.ts` is already large and its existing Lua-parsing helpers are
all single-purpose top-level functions; this feature's script-lookup +
`IDs.lua`-parsing + per-zone caching is a self-contained, independently
testable unit — same reasoning that gave the DAT enrichment matching logic
its own `src/dat/index.ts` module rather than folding into an existing
file. `src/routes/db.ts` imports from here.

- New function `resolveNpcDialog(zoneName: string, npcName: string): { found: boolean; scriptPath?: string; lines: { const: string; id: number; text: string }[] }`.
  - Locate script: `path.join(LSB_SCRIPTS_DIR, 'zones', zoneName, 'npcs', <npcName>.lua)` exact match first; on miss, brute-force scan that directory with the same `normalize()` fuzzy-match fallback already used by `/api/questscript` in `src/routes/characters.ts:377`.
  - Not found (directory missing, e.g. scripts unmounted, or no matching file) → `{ found: false, lines: [] }`.
  - Regex-scan the script's text for `/\.text\.([A-Za-z0-9_]+)/g`, dedup preserving first-seen order.
  - Lazily parse + cache (`Map<string, Record<string, {id:number; text:string}>>`, keyed by zone name — mirrors `dialogCache` in `src/dat/index.ts:182`) the zone's `IDs.lua`: extract the substring between the first `text\s*=\s*\{` and its matching `}` (brace-depth scan, not a naive non-nested regex — `IDs.lua` has sibling `mob = {...}` / `npc = {...}` tables after it), then per line match `/^\s*([A-Z0-9_]+)\s*=\s*(\d+),?\s*(?:--\s*(.*))?$/`.
  - Resolve each referenced constant against the parsed table; skip silently if a constant isn't found there (e.g. defined in a different zone's shared table — rare, no data available, not an error).
  - Return `{ found: true, scriptPath, lines }` (`lines` may be empty if the script has zero `.text.` references — still `found: true`, since a script did match).

### `src/routes/db.ts`

- New route `GET /api/db/npcs/dialog`, `requireAuth`: reads `req.query.name` and `req.query.zone`, calls `resolveNpcDialog`, returns its result as JSON.

## Client changes

### `client/src/components/pages/Database.tsx`

- New type `NpcDialog = { loading: boolean; found: boolean; lines: { const: string; id: number; text: string }[] }`, module-level (same reasoning as the existing `Enrichment` type — `DetailView` is a module-level function and needs the same shape).
- New state `npcDialog: NpcDialog | null`, reset alongside the existing detail-panel reset points (`openDetail` start, close button).
- In `openDetail`'s `cat === 'npcs'` branch (currently falls into the generic `setDetailData(row)` catch-all at line 329): split NPCs into their own branch, `setDetailData(row)` then fetch `api.npcDialog(String(row.name ?? ''), String(row.zone ?? ''))`, setting `npcDialog` through `{loading:true,...}` → resolved state, mirroring the existing quest-walkthrough fetch's try/catch/loading shape.
- In `DetailView`'s `cat === 'npcs'` case (line 824-833): add a "Dialogue" section after the existing NPC ID/Zone/X/Z rows — loading indicator while `npcDialog.loading`; once resolved, each line rendered as quoted text with its `const` name as a small label; if `!npcDialog.found || npcDialog.lines.length === 0`, render `"No dialogue found for this NPC."`.
- `client/src/api.ts`: new `npcDialog(name: string, zone: string) => req<NpcDialogResponse>(...)` helper, following the existing helper-per-endpoint convention.

## Data flow

`openDetail(npcs row)` → `api.npcDialog(name, zone)` → `GET /api/db/npcs/dialog?name=...&zone=...` → `resolveNpcDialog()` (script lookup + `IDs.lua` parse, both cached) → JSON response → `npcDialog` state → `DetailView` renders the Dialogue section. No changes to the existing Dialog category, Wiki button, or any other NPC data path.

## Error handling

Matches this repo's established pattern for scripts-tree access: missing
`LSB_SCRIPTS_DIR` mount, missing zone directory, missing NPC file, or a
malformed `IDs.lua` all resolve to `{ found: false, lines: [] }` rather
than throwing — the route wraps `resolveNpcDialog` in try/catch and
returns a 500 only on a genuine unexpected error, same shape as
`/api/questscript`.

## Testing

- Unit tests for the two pure pieces: the `IDs.lua` `text` table parser
  (brace-scanning + line regex) and the `.text.CONST` reference extractor
  — both operate on in-memory string fixtures, no filesystem dependency,
  same style as `tests/unit/dat-enrichment.test.ts`.
- Live verification (this repo's established convention for
  `Database.tsx`/`src/routes/*.ts` changes — no client test harness
  exists): open `Nembet` in Southern San d'Oria [S], confirm
  `ITEM_DELIVERY_DIALOG`'s exact text appears; open an NPC with no
  matching script (or a shop-only NPC with no `.text.` references) and
  confirm the "No dialogue found" note appears instead of an error or a
  silent gap.
