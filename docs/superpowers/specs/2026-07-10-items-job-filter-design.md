# Items Job Filter — Design

## Problem

The Database tab's Items category has Type, Slot (Main/Sub/etc), Weapon-skill,
and Rare/Ex filter chips, but no way to narrow equipment to "what my job can
wear" — despite the data already being fully present. `GET /api/db/items`
already selects `ie.jobs` (a per-item bitmask of equippable jobs) on every
row, and the detail panel already parses it correctly:

```ts
const jobsMask = Number(data.jobs ?? 0);
const jobList = JOB_ABBR.slice(1).filter((_, i) => (jobsMask >> (i + 1)) & 1);
```

(`JOB_ABBR[0]` is an unused placeholder — FFXI job ids start at 1 for WAR;
`JOB_ABBR.slice(1)` walks real jobs 1-22, checking bit `i+1` of the mask.)
This is exactly the same shape as every other filter added this session
(NPC region/role, Mobs region/ecosystem/aggro, Items slot/skill): backend
data already exists, just never wired into a filter chip or query param.

## Decision (confirmed with user)

Add a Job filter chip row, gated to `typeFilter === 6 || typeFilter === 7`
(Equipment + Weapon) — the same gate as the existing Slot and Weapon-skill
rows, since only rows with an `item_equipment` join carry a `jobs` mask.
Reuses the already-defined `JOB_ABBR` constant (no new labels/ordering to
invent) and the same bit-shift convention already proven correct in the
detail panel.

## Backend change

### `src/routes/db.ts` — `GET /api/db/items`

New `?job=N` param (N = real job id 1-22, matching `JOB_ABBR` index):

```ts
const job = req.query.job ? parseInt(req.query.job as string) : null;
// ...
if (job !== null && !isNaN(job)) { extra.push('AND (ie.jobs >> ?) & 1 = 1'); params.push(job); }
```

Same shape as the existing `slotBit`/`skill` filters — one more `extra.push`
line, one more bound param. No SQL/catalog changes elsewhere; `ie.jobs` is
already selected.

## Client change (`Database.tsx`)

- New state: `jobFilterItems` (`number | null`) — named distinctly from the
  existing `jobFilter` (Abilities' own job-chip state) to avoid the two
  categories aliasing each other's filter, matching the established
  pattern from Mobs' `mobsRegionFilter` vs NPCs' `regionFilter`.
- New toolbar row (Items only, gated `typeFilter === 6 || typeFilter === 7`,
  placed alongside the existing Slot/Weapon-skill rows): `JOB_ABBR.slice(1)`
  mapped to chips, each sending `job = i + 1` (real job id) — mirrors the
  detail panel's own indexing exactly, so "PLD chip selected" and "PLD in
  this item's detail panel job list" agree by construction.
- Wired into `load()`'s params (gated `cat === 'items' && (typeFilter === 6
  || typeFilter === 7)`) and both dependency arrays; reset in `selectCat`
  and `selectTypeFilter` (which already resets `slotFilter`/`skillFilter`
  on type switch — `jobFilterItems` joins that reset).
- No detail-panel changes — the job list is already shown there today.

## Data flow

`GET /api/db/items?type=6&job=8` (PLD) → SQL adds
`AND (ie.jobs >> 8) & 1 = 1` → client renders. No changes to
`loadCatalogs()`/startup, since this route already queries the live DB per
request (Items, unlike Mobs/NPCs, isn't served from an in-memory catalog).

## Error handling

None new — same shape as `slot`/`skill`, degrades identically (absent/
invalid `job` param is simply not applied, matching existing `isNaN` guards).

## Testing

Extend the existing `tests/integration/db-items-filters.test.ts` (added for
the slot/skill filter fix) with cases for: job filter alone, job combined
with type=6, job combined with type=7, job combined with slot AND skill
together (the three-way combination the Equipment/Weapon toolbar now allows
simultaneously). Same mocked-pool assertion style already used in that file
(assert on the SQL clause + bound params, not real DB rows).
