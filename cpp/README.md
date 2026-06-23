# dashboard_queue.cpp — LSB Map Server Module

This C++ module must be installed on the **LandSandBoat map server** for two features to work:

| Feature | Without module |
|---|---|
| Admin edit queue (`additem`, `delitem`, `setgil`, `addgil`, `setskill`, `luaexec`) | Rows are inserted but never executed |
| Live position feed (player/NPC/mob dots on zone map) | `dashboard_positions.json` is never written; map overlay shows no entities |

The dashboard's Node.js server and all read-only features work fine without it.

---

## Installation

### 1. Copy the file

```bash
cp cpp/dashboard_queue.cpp /opt/stacks/ffxi/modules/custom/cpp/dashboard_queue.cpp
```

Adjust the path if your LSB install is elsewhere.

### 2. Register the module

Add one line to `/opt/stacks/ffxi/modules/init.txt`:

```
custom/cpp/dashboard_queue.cpp
```

### 3. Rebuild the LSB image

```bash
cd /opt/stacks/ffxi
docker compose build ffxi-map
```

Then restart the map server container (via Portainer or `docker compose up -d ffxi-map`).

---

## What it does

**Every second:** calls `writePosFeed()` — iterates all zones via `zoneutils::ForEachZone`, collects every online player, NPC, and mob with their coordinates, and writes a JSON snapshot to `/server/log/dashboard_positions.json` using an atomic tmp→rename. The dashboard Node.js process watches this file's mtime and broadcasts a `positions` WebSocket event whenever it changes.

**Every 3 seconds:** polls `dashboard_queue` for `pending` rows (up to 20 per poll) and executes them:

| Action | Implementation |
|---|---|
| `additem` | `charutils::AddItem(PChar, LOC_INVENTORY, itemId, qty)` |
| `delitem` | `PChar->getStorage(LOC_INVENTORY)->SearchItem(itemId)` → `charutils::UpdateItem(..., -qty)` |
| `setgil` / `addgil` | `CItem* PGil = PChar->getStorage(LOC_INVENTORY)->GetItem(0)` → `charutils::UpdateItem(..., diff)` |
| `setskill` | `PChar->RealSkills.skill[id] = level * 10` → `charutils::BuildingCharSkillsTable` → `charutils::SaveCharSkills` |
| `luaexec` | `lua.safe_script(params)` — runs arbitrary Lua in the live map-server VM |

Characters not currently loaded in this process are marked `deferred` and retried on the next poll.

---

## Position feed file format

```json
{
  "players": [{"i":1,"n":"Sora","x":12.5,"y":0.0,"z":-45.3,"z_id":230,"j":6,"l":75}],
  "npcs":    [{"i":4198401,"n":"Shantotto","x":5.0,"y":0.0,"z":3.2,"z_id":236}],
  "mobs":    [{"i":17170433,"n":"Goblin Thug","x":-23.1,"y":0.0,"z":8.7,"z_id":101}]
}
```

Fields: `i`=entity ID, `n`=name, `x/y/z`=world position, `z_id`=zone ID, `j`=main job (players), `l`=main level (players).
