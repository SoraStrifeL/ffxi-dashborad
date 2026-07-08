# Items Filter Fix + Slot/Skill/Rare Filters — Design

## Problem

The Items category's type chips in Database.tsx (Armor/Weapon/Linkshell/Gil/
Key Item/Food/Crystal/Voucher/...) don't work: clicking "Weapon" returns
linkshells, clicking "Armor" returns fishing rods, and the "Type" row in the
item detail panel mislabels equipment as "Food". Separately, there's no way
to narrow Equipment by slot, Weapon by weapon skill, or toggle Rare/Ex —
even though the backend already supports all three.

## Root cause (verified)

`ITEM_TYPE` in `client/src/components/pages/Database.tsx:573` is a 47-entry
map that doesn't correspond to this schema's `item_basic.type` column at
all. Verified against the authoritative source, `/home/sora/ffxi/sql/item_basic.sql`
(`@GENERAL_TYPE=1` .. `@CURRENCY_TYPE=8`), and cross-checked live via
`GET /api/db/items?type=N` for N=1..8 — every sampled row matches the SQL
source's enum, not the client's map:

| type | Client label (wrong) | Correct label (verified) |
|---|---|---|
| 1 | Armor | General |
| 2 | Weapon | Linkshell |
| 3 | Linkshell | Furnishing |
| 4 | Gil | Puppet |
| 5 | Key Item | Usable |
| 6 | Food | Equipment |
| 7 | Crystal | Weapon |
| 8 | Voucher | Currency |

Types 9-47 in the old map don't exist in `item_basic.type` at all (dead
entries from some other classification system).

`item_weapon.skill` (1-15) was separately verified live against
`GET /api/db/items?type=7&skill=N` and matches the SQL source's AH-category
weapon list exactly: 1 H2H, 2 Dagger, 3 Sword, 4 Greatsword, 5 Axe,
6 Greataxe, 7 Scythe, 8 Polearm, 9 Katana, 10 Greatkatana, 11 Club,
12 Staff, 13 Bow, 14 Instrument, 15 Ammunition.

`item_equipment.slot` is an existing bitmask already correctly decoded
elsewhere in the same file (`SLOT_NAMES`, used in the Items detail panel) —
no new verification needed, just reuse.

## Decisions (confirmed with user)

1. Fix the type-chip mapping (8 correct labels, drop the 39 bogus ones).
2. Add a second-level chip row that appears conditionally under the type
   chips: Slot chips when Equipment is selected, Weapon-skill chips when
   Weapon is selected. Both reuse existing, already-working backend query
   params (`slot`, `skill`) — no new list/count endpoint needed.
3. Add a standalone Rare/Ex toggle chip next to search, independent of
   type, requiring one small backend addition.

## Changes

### `client/src/components/pages/Database.tsx`

- Replace `ITEM_TYPE` (line 573-582) with the corrected 8-entry map.
- Add `WEAPON_SKILL_NAMES` (index 1-15, per table above).
- Add `slotFilter` / `skillFilter` state (mirrors existing `typeFilter`
  state shape: `number | null`).
- Add `rareExFilter` state: `boolean`.
- Render a second `chipBtn` row, conditional on `typeFilter`:
  - `typeFilter === 6` (Equipment) → `SLOT_NAMES` chips → sets `slotFilter`
    → sent as `slot` param (bitmask, same as backend already expects).
  - `typeFilter === 7` (Weapon) → `WEAPON_SKILL_NAMES` chips → sets
    `skillFilter` → sent as `skill` param.
  - Any other type, or `typeFilter === null` → no second row.
- Selecting a new top-level type chip clears `slotFilter`/`skillFilter`
  (same reset pattern `selectCat` already uses when switching categories).
- Add a `Rare/Ex` toggle chip near the search box (visible for the Items
  category regardless of `typeFilter`) → sends `rareex=1` when active.
- Wire `slotFilter`, `skillFilter`, `rareExFilter` into the existing
  `load()` params-building block and its effect dependency array, the same
  way `typeFilter` is already wired.
- Detail panel's `Type` `DRow` (line 674) picks up the corrected map
  automatically — no separate change needed there.

### `src/routes/db.ts`

- Add one new query param on `GET /api/db/items`: `rareex=1` →
  `(ib.flags & 0xC000) != 0` (0x8000 `FLAG_RARE` | 0x4000 `FLAG_EX`),
  additive to the existing `extra`/`params` filter-building block. The
  existing `rare`/`flagmask`/`flagval` params are left as-is (still
  unused by the client, harmless, not in scope to remove).

## Data flow

Unchanged shape — this only changes which query params the client sends
and which static label maps it uses. No new endpoints, no new blob
decoding, no schema changes.

## Error handling

No new error paths. `slot`/`skill` params already `parseInt` + `isNaN`
guarded server-side (existing code); `rareex` follows the same
`req.query.rareex === '1'` boolean-flag pattern as the existing `rare`
param.

## Testing

- Live verification (per this repo's `verify` process, not unit tests):
  click each of the 8 corrected type chips and confirm the detail panel's
  "Type" row and the sample item names match the table above.
- Click Equipment → click a slot chip (e.g. Legs) → confirm only
  leg-slot items appear (e.g. Bronze Subligar).
- Click Weapon → click a skill chip (e.g. Axe) → confirm only axes appear.
- Toggle Rare/Ex → confirm results narrow to flagged items only, in
  combination with a type chip and without one.
- Switch type chips back and forth → confirm the second-level filter
  resets (no stale slot/skill filter silently applied to the wrong type).
