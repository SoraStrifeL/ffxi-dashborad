# Items Job Filter — Design

## Problem

The Database tab's Items category has Type, Slot (Main/Sub/etc), Weapon-skill,
and Rare/Ex filter chips, but no way to narrow equipment to "what my job can
wear" — despite the data already being fully present. `GET /api/db/items`
already selects `ie.jobs` (a per-item bitmask of equippable jobs) on every
row, and the detail panel already attempts to parse it:

```ts
const jobsMask = Number(data.jobs ?? 0);
const jobList = JOB_ABBR.slice(1).filter((_, i) => (jobsMask >> (i + 1)) & 1);
```

(`JOB_ABBR[0]` is an unused placeholder — FFXI job ids start at 1 for WAR;
`JOB_ABBR.slice(1)` walks real jobs 1-22.) This is exactly the same shape as
every other filter added this session (NPC region/role, Mobs
region/ecosystem/aggro, Items slot/skill): backend data already exists,
just never wired into a filter chip or query param.

> **Correction (post-implementation, 2026-07-10):** the detail panel's
> `(jobsMask >> (i + 1)) & 1` formula above is **wrong**, not "already
> correct" as originally claimed here — this was only caught by deep live
> verification of the new filter, not by writing this spec. LSB's actual
> equip-permission check (`charutils.cpp:2368`) is
> `PItem->getJobs() & (1 << (PChar->GetMJob() - 1))` — bit position is
> **job_id − 1**, not `i + 1` against the sliced array (which equals
> `job_id` for `JOB_ABBR.slice(1)`, i.e. off by one). Verified against the
> live DB: Chevalier's Armet (PLD-exclusive AF) has `jobs = 64` = bit 6;
> PLD's job id is 7; `1 << (7-1) = 64` matches exactly, `1 << 7 = 128` does
> not. The correct formula, for both the detail panel and the new filter
> below, is bit index `job_id - 1` (equivalently, sliced-array index `i`
> with no `+1`). Every `?job=N`/bit-shift value below that assumed `i + 1`
> or `>> job` must be read as corrected to `i`/`>> (job - 1)` — see the
> Backend and Client sections, both updated in place.

## Decision (confirmed with user)

Add a Job filter chip row, gated to `typeFilter === 6 || typeFilter === 7`
(Equipment + Weapon) — the same gate as the existing Slot and Weapon-skill
rows, since only rows with an `item_equipment` join carry a `jobs` mask.
Reuses the already-defined `JOB_ABBR` constant (no new labels/ordering to
invent) and the same bit-shift convention already proven correct in the
detail panel.

## Backend change

### `src/routes/db.ts` — `GET /api/db/items`

New `?job=N` param (N = real job id 1-22, matching FFXI's job id convention
— WAR=1 … PLD=7 … RUN=22 — the same ids `JOBS_LIST` and `JOB_ABBR` already
use elsewhere in this codebase). The client keeps sending the real job id;
the bit tested is `job - 1` (LSB's actual convention, see the Problem
section's correction):

```ts
const job = req.query.job ? parseInt(req.query.job as string) : null;
// ...
if (job !== null && !isNaN(job)) { extra.push('AND (ie.jobs >> ?) & 1 = 1'); params.push(job - 1); }
```

Same shape as the existing `slotBit`/`skill` filters — one more `extra.push`
line, one more bound param (now `job - 1`, not `job`, per the correction
above). No SQL/catalog changes elsewhere; `ie.jobs` is already selected.

## Client change (`Database.tsx`)

- New state: `jobFilterItems` (`number | null`) — named distinctly from the
  existing `jobFilter` (Abilities' own job-chip state) to avoid the two
  categories aliasing each other's filter, matching the established
  pattern from Mobs' `mobsRegionFilter` vs NPCs' `regionFilter`.
- New toolbar row (Items only, gated `typeFilter === 6 || typeFilter === 7`,
  placed alongside the existing Slot/Weapon-skill rows): `JOB_ABBR.slice(1)`
  mapped to chips, each sending `job = i + 1` (the real FFXI job id — this
  send-side value is unchanged by the correction; only the *bit tested*
  server-side and in the detail-panel fix changes, per above).
- Wired into `load()`'s params (gated `cat === 'items' && (typeFilter === 6
  || typeFilter === 7)`) and both dependency arrays; reset in `selectCat`
  and `selectTypeFilter` (which already resets `slotFilter`/`skillFilter`
  on type switch — `jobFilterItems` joins that reset).
- **Detail-panel fix (added by the correction above):** change
  `(jobsMask >> (i + 1)) & 1` to `(jobsMask >> i) & 1` at
  `client/src/components/pages/Database.tsx:769` — this is a pre-existing
  bug this task's live verification exposed, not new-filter scope, but
  leaving it unfixed would mean the filter (once corrected) shows accurate
  results while the detail panel opened from those same results still
  displays the wrong job list. Fixed together per explicit user decision.

## Data flow

`GET /api/db/items?type=6&job=7` (PLD) → SQL adds
`AND (ie.jobs >> 6) & 1 = 1` (bit `job - 1 = 6`) → client renders. No
changes to `loadCatalogs()`/startup, since this route already queries the
live DB per request (Items, unlike Mobs/NPCs, isn't served from an
in-memory catalog).

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
