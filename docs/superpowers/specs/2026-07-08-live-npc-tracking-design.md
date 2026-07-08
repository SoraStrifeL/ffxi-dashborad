# Live NPC Tracking on the Map — Design

## Problem

The Map tab already has real-time position tracking for mobs (via the
WS `positions` message, sourced from the LSB server's
`dashboard_positions.json`, which updates every ~1s with live
positions for every player/NPC/mob on the server) and players (via
`zone_players`, sourced from Windower reports). NPCs are the one gap:
the server already broadcasts live NPC positions in the same
`positions` message, but `Map.tsx`'s WS handler
(`client/src/components/pages/Map.tsx:706-722`) destructures
`pos.npcs` and never uses it — NPC dots stay frozen at whatever
position was in the initial `api.npcs(zone)` snapshot fetched on zone
load.

Confirmed live against the running server: `dashboard_positions.json`
is actively updating (~1-3s cadence) with real nonzero coordinates for
tens of thousands of NPCs across all zones — the data has been ready
and unused this whole time.

## Decision (confirmed with user)

Wire up live NPC positions the same way mobs already work. No
backend changes — the data is already flowing. No pop/kill-style event
log for NPCs (that's `onMobPop`/`onMobKill`, a mob-specific
spawn/despawn tracking feature; NPCs don't spawn/despawn the same way,
so it doesn't apply).

## Client change (`Map.tsx`)

In the `positions` WS handler, add an NPC branch mirroring the
existing mob one:

```ts
if (type === 'positions' && zone !== null) {
  const pos = d as { players?: PosEntry[]; npcs?: PosEntry[]; mobs?: PosEntry[] };
  const liveMobs = (pos.mobs ?? []).filter((m) => m.z_id === zone && (m.x !== 0 || m.z !== 0));
  const updatedMobs: MobEntry[] = liveMobs.map((m) => { /* unchanged */ });
  // ...pop/kill detection unchanged...

  const liveNpcs = (pos.npcs ?? []).filter((n) => n.z_id === zone && (n.x !== 0 || n.z !== 0));
  const updatedNpcs: NpcEntry[] = liveNpcs.map((n) => ({
    npcid: n.i, name: n.n, pos_x: n.x, pos_y: n.y, pos_z: n.z,
  }));

  drawEntities(updatedMobs, updatedNpcs, layers, detectFilter);
}
```

`NpcEntry` (`client/src/types.ts:162`) has no extra static-only fields
beyond id/name/position (unlike `MobEntry`, which carries
aggro/detects/family merged in from a separate static map) — so the
`PosEntry` → `NpcEntry` mapping is a direct 1:1 field rename, no
static-data merge needed.

The `dbNpcs` React state (used for the sidebar NPC count badge, name
search, and the teleport-NPC list) is left untouched, exactly matching
how `dbMobs` already works today — only the drawn dot positions go
live; the list/search/badge stay backed by the static per-zone
snapshot.

## Data flow

Unchanged end-to-end: `dashboard_queue.cpp` (LSB, already deployed) →
`dashboard_positions.json` → `startPosWatcher()` (`src/ws.ts`, already
running) → WS `positions` message → `Map.tsx`. This design only
changes what the client *does* with data already arriving.

## Error handling

None new. `pos.npcs` defaults to `[]` if absent (same as the existing
`pos.mobs ?? []` pattern) — a zone with no live NPC data simply draws
zero live NPC dots, same degrade-gracefully behavior mobs already
have.

## Testing

No new pure logic worth a unit test (this repo has no client test
harness, and `Map.tsx` changes are established as "verify live only").
Live verification: confirm NPC dots move on the map when server-side
NPC positions change, confirm dots stay put when a zone has no live
NPC data (falls back to nothing extra, not a crash), confirm switching
zones doesn't leak a previous zone's NPC positions into the new one.
