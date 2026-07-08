# FFXi.dll Map-Registration Investigation — Design

## Problem

Map calibration (`data/calibrations.json`) is built from NPC/mob-extent
auto-bounds plus DAT-derived geometry (`tools/build-calibrations.js`,
`tools/decode-dat.js`) and refined in-game via 2-point manual click
calibration or the autocal fast path. It gets close but isn't
pixel-perfect on every zone — decorative map-sheet margins and
DAT-vs-district-map mismatches (Jeuno/Adoulin/small towns) mean some
zones' NPC/mob dots sit slightly off.

The exact fix already stubbed out in `addons/Dashboard/CALIBRATION.md`
is `get_map_data(x,y,z)` — Windower's own call for translating world
coordinates to map pixel coordinates. A prior session searched
`FFXiMain.dll` (2.9 MB) for the registration table backing that call and
found nothing. `FFXi.dll` (93 KB, same retail client at
`FINAL FANTASY XI/FFXi.dll`) has not been searched — it's small enough to
read in full with `objdump`, unlike `FFXiMain.dll`.

## Goal

Determine whether `FFXi.dll` contains a per-zone map-registration table
(scale/offset mapping world coords → map pixel coords) or the code that
computes one. This is a research spike, not a guaranteed feature.

## Approach

**Phase 1 — static scan.** `strings` over `FFXi.dll` for
zone/map-related text; manually parse the PE section table (Python
`struct`, stdlib only — no `pefile`) and walk `.data`/`.rdata` as
float32 arrays, looking for clusters matching known values already in
`data/calibrations.json` (per-zone scale/offset/dimensions).

**Phase 2 — deep dive (only if Phase 1 is inconclusive).**
`objdump -d -M intel` the full binary (small enough to read whole),
identify exported functions, and trace by hand from any function that
touches the Phase-1-matched data (or, absent a match, any function
doing per-zone-sized float array work) to see whether it computes a
world→pixel transform.

## Output

- `tools/inspect-ffxi-dll.py` — standalone research script (stdlib
  only), not wired into the build/calibration pipeline.
- A findings writeup (reported back to the user, and saved to memory).
- **If a real table/transform is found:** stop here and come back with
  a follow-up spec to wire it into `build-calibrations.js` /
  `data/calibrations.json` — that's separate scoped work, not part of
  this investigation.
- **If nothing conclusive after Phase 2:** document the negative
  result in memory (same treatment as the `FFXiMain.dll` dead end) and
  stop. No escalation past `objdump`-level static disassembly (no
  dynamic tracing/debugging the running client).

## Non-goals

- No changes to the live calibration pipeline as part of this task.
- No dynamic analysis (attaching a debugger to a running client) —
  static analysis only, matching the existing DAT reverse-engineering
  precedent in this repo.
- No redistribution of `FFXi.dll` or any extracted binary content —
  `FINAL FANTASY XI/` stays gitignored; only derived *facts* (numeric
  tables, offsets, structure layout) get written to memory or committed
  code, never the file itself or copyrighted assets.
