# FFXI Dashboard — To Do

## Completed
- [x] DB migration: `params` / `result` columns are now `TEXT`
- [x] FFXI server rebuilt — `setgil`, `addgil`, `luaexec` C++ actions live
- [x] Dashboard rebuilt — new server.js, log volume mounted, all endpoints active
- [x] `/api/stats` auth-gated
- [x] All non-quest endpoints secured with `auth.requireAuth`
- [x] `pool.query` → `pool.execute` (prepared statements) across all routes
- [x] 376 map PNGs in `public/maps/`
- [x] `maps.json` regenerated (153 zones, multi-floor grouped)
- [x] 2-point click calibration built into map view
- [x] Zone bounds auto-derived from NPC/mob positions at login (`/api/bounds` → 327 zones)
- [x] Console tab: live log streaming (map/world/connect/search) + Lua console
- [x] `luaexec` tested end-to-end: `status=done`
- [x] `setgil` / `addgil` tested in-game on Sora ✓
- [x] Lua console tested in browser — result returned within ~3 s ✓
- [x] `README` updated with queue actions, console tab docs
- [x] Live position feed: C++ writes `/server/log/dashboard_positions.json` every 1 s; Node.js reads file and broadcasts `{type:'positions'}` over WS; client updates map dots at 1-s cadence without waiting for 3-s DB poll
- [x] GM Quick Actions panel (online chars only): Warp to Zone, Home Point, Force Logout, Set Job/Level — all via Lua console
- [x] Dashboard rebuilt with above changes ✓
- [x] v3 queue action: `setskill` — Set any skill level (weapons, magic, crafts)

### Database Browser (DB Tab)
- [x] Database tab: Quests, Mobs, NPCs, Items — searchable, expandable rows
- [x] Items detail panel: weapon stats, equipment slots/jobs, usable charges, stat mods (60-entry mod map), Rare/Ex flags, drop sources, synth recipes, guild shop prices
- [x] Quests detail: NPC names + `!pos` coordinates, requirements (fame/level/rank/job/key item/prereq quest/mission), trade items, rewards (gil/exp/fame/bayld/item/key item/title)
- [x] Quest "scripted" badge — shows whether a Lua script was found for the quest
- [x] Quest requirements: charvar flags (e.g. `AssaultPromotion >= 25`) and server setting flags (e.g. `ENABLE_TOAU == 1`) parsed from `QUEST_AVAILABLE` blocks
- [x] Server setting flags show ✓/✗ based on actual current `main.lua` values (`/api/quest-settings`)
- [x] BG wiki integration: description, repeatable badge, quest type, prev/next quest chain — fetched on demand with 24h in-memory cache (`/api/db/quests/wiki`)
- [x] Character quest panel: wiki data (description, type, repeatable, chain) injected on first expand
- [x] Character quest panel: charVar current values shown vs. required threshold (green/red) — fetched via `/api/character/:charid/vars`
- [x] Quest script scan improved: added `Quest:new(xi.questLog.X, xi.quest.id.area.CONST)` fallback — coverage 385 → 457 scripted quests out of 1085 total

## Quest Coverage Summary (as of last scan)
| Log | Total | Scripted | No Script |
|---|---|---|---|
| Bastok | 93 | 80 | 13 |
| Aht Urhgan | 72 | 52 | 20 |
| San d'Oria | 82 | 56 | 26 |
| Jeuno | 145 | 73 | 72 |
| Crystal War | 95 | 43 | 52 |
| Other Areas | 67 | 43 | 24 |
| Windurst | 90 | 44 | 46 |
| Outlands | 56 | 23 | 33 |
| Adoulin | 97 | 13 | 84 |
| Abyssea | 192 | 30 | 162 |
| Coalition | 96 | 0 | 96 |
| **Total** | **1085** | **457** | **628** |

"No script" quests have no Lua implementation in the LSB codebase — not a dashboard gap.

## Needs FFXI server rebuild (via Portainer)
- [x] Activate live position feed: `ffxi-map` rebuilt; `dashboard_positions.json` confirmed writing to volume.

## Optional / Future
- [x] Fine-tune zone bounds with 2-point calibration for zones where auto-bounds feel off
- [x] `PLAYER_ALLOWED_ACTIONS` — populate if player self-service queue actions are ever wanted
- [x] v3 queue actions — gear slot edits: Gear Management section in GM panel; Equip (slot, inventory item) and Unequip Slot buttons via luaexec (`p:equip(slot,0,invSlot)` / `p:unequip(slot)`)
- [x] Standardize `/api/character/:id/quests` and `/api/character/:id/effects` from `pool.query` → `pool.execute`
- [x] Coalition quests (96 total) have zero Lua scripts in LSB — no data available until upstream implements them
- [x] Abyssea / Adoulin low script coverage (30/192 and 13/97) — upstream LSB gap, not dashboard gap
- [x] Lua Scripts library seeded: 14 preset scripts (player info, full heal, add gil/exp/merits/CP/JP/sparks/accolades, clear status, warp, set weather, spawn/despawn mob, add key item) — all API names verified against LSB C++ bindings
