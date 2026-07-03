# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the project

**Docker (preferred):**
```bash
docker compose build                        # rebuild image after code changes
docker compose up -d --force-recreate       # deploy new image
docker compose logs -f                      # tail logs
```
Use `docker compose up -d --force-recreate` after every build to swap to the new image.

**Bare-metal (non-Docker) — Linux/macOS/Windows:**
Runs the **same `src/` code as Docker** — build once, then run the compiled output.
```bash
npm install
npm run build:all                                   # compile backend (tsc) + client (Vite)
DASHBOARD_JWT_SECRET=$(openssl rand -hex 32) npm start   # → node dist/server.js
```
- `npm run serve` does `build:all` + start in one step.
- `npm run dev` runs `src/server.ts` directly via ts-node (no build; iterative dev).
- Windows: `set DASHBOARD_JWT_SECRET=<random-string>` then `npm start`.
- Load `.env` on any platform: `npx dotenv -e .env -- npm start`.

**Redis is optional bare-metal.** With no `REDIS_URL` set, the server uses an
in-memory cache (wiki cache, rate-limit state, refresh tokens) — fine for a
single instance. Set `REDIS_URL` (or `USE_REDIS=1`) to use Redis; it falls back
to memory automatically if Redis is unreachable. See `src/cache.ts`.

**Bare-metal needs no `/ffxi-*` mounts** — absent Lua catalogs, logs, and
settings dirs degrade gracefully (empty catalogs, no live positions). Point
`LSB_SCRIPTS_DIR` / `LSB_SETTINGS_DIR` / `LSB_LOG_DIR` at a local LSB checkout
to enable those features (see `.env.example`).

> **Important:** `src/` is the single source of truth for both Docker and
> bare-metal. **All backend fixes go in `src/routes/*.ts` / `src/*.ts`.** The
> root `server.js` is a **deprecated** legacy monolith kept only behind
> `npm run start:legacy`; it is heavily out of date (missing token
> revocation, refresh tokens, input validation, the dashboard console, etc.)
> and should not be used or extended.

**First-time DB setup:** apply `sql/dashboard_queue.sql` against the LSB `xidb` database once:
```bash
mariadb -u xiadmin -p xidb < sql/dashboard_queue.sql
```

**Required env:** `DASHBOARD_JWT_SECRET` must be set or the server exits immediately. `WINDOWER_API_KEY` must be set for the Windower position endpoint. Copy `.env.example` → `.env` and fill it in.

## Architecture

TypeScript Node.js backend (`src/server.ts` → `dist/server.js`) with a React 18 SPA frontend (`client/`).

```
Browser
  ├── WebSocket (ws://)   ← live push every 3 s (stats, players, positions)
  └── REST /api/*         ← initial loads and actions

src/server.ts  (compiled → dist/server.js, what Docker runs)
  ├── mysql2 pool (10 connections) → LandSandBoat MariaDB
  ├── Redis (src/cache.ts) — wiki HTML cache, rate-limit state
  ├── setInterval(pollAndBroadcast, 3000) — DB poll; broadcasts only on change
  ├── startPosWatcher() — reads /ffxi-log/dashboard_positions.json every 1 s
  ├── windowerPositions Map — in-memory live positions from Windower addon
  ├── src/routes/*.ts — one file per feature area (auth, db, characters, map, …)
  ├── src/catalog.ts — startup loaders for Lua catalogs + in-memory lookup maps
  ├── src/ws.ts — WebSocket hub + zone-watch subscriptions
  └── src/auth.ts — bcrypt + JWT middleware

client/  (Vite + React 18 + TypeScript + Tailwind CSS v4)
  └── src/components/pages/  — one file per tab (Map.tsx, Database.tsx, …)

server.js  (root — bare-metal dev only, NOT compiled into Docker image)

Windower4 client (Wine/Linux gaming PC)
  └── Dashboard addon → POST /api/windower/position every 2 s
```

**No framework other than Express on the backend.** All REST routes are split across `src/routes/*.ts`.

## Auth

Two tiers, determined at login time and encoded in the JWT:
- `admin` — account owns any character with `gmlevel >= 1`
- `player` — everything else; scoped to their own characters only

Middleware: `requireAuth` and `requireAdmin` from `src/auth.ts`. WS clients send `{type:'auth', data:{token}}` within 5 s or the connection is closed.

Legacy non-bcrypt accounts are rejected with a 409 telling the user to log into the game once to upgrade their hash.

## Edit queue (`dashboard_queue` table)

Admin actions are inserted as rows into `dashboard_queue`; a C++ module in the LSB map server polls the table every 3 s and executes them against live characters.

Supported actions: `additem`, `delitem`, `setgil`, `addgil`, `setskill`, `luaexec`.

- `charid = 0` + `action = luaexec` → runs Lua globally in the map server VM, regardless of character online status.
- Offline characters get status `deferred` and are retried on next poll.
- `PLAYER_ALLOWED_ACTIONS` is a `Set<string>` exported from `src/catalog.ts` (currently empty); populate it to allow player-tier self-service queue entries.

## Runtime file mounts (Docker volumes)

These paths are only available inside the container — graceful degradation applies when absent:

| Container path | Purpose |
|---|---|
| `/ffxi-log/` | Server logs + `dashboard_positions.json` (live pos feed) |
| `/ffxi-settings/` | `main.lua`, `map.lua`, `login.lua` — read/written by `/api/settings/rates` |
| `/ffxi-scripts/` | Lua enum/catalog files: `quests.lua`, `effect.lua`, `merit.lua`, `key_item.lua`, `title.lua`, `roe_records.lua`, `missions.lua`, `quests/<area>/` |

All Lua catalogs (quests, effects, merits, key items, titles, missions, RoE records) are parsed once at startup by `src/catalog.ts` into in-memory lookup maps. Quest rewards are also parsed at startup by scanning every quest Lua file under `/ffxi-scripts/quests/`.

The key item list is pre-sorted at startup into `KEY_ITEM_SORTED` (sorted by ID) so the `/api/db/keyitems` endpoint can filter+slice without re-sorting on every request.

## Map images

Map PNGs live in `public/maps/` and are served statically. `buildZoneMaps()` at startup scans this directory and matches filenames to zone IDs via `zone_settings.name` normalization. Multi-floor zones use the suffix `_N.png` (e.g. `tavnazian_safehold_1.png`).

`public/maps.json` is a pre-generated index for human reference; the server does not read it at runtime.

## Map tab (`client/src/components/pages/Map.tsx`)

Built with PIXI.js v7. Key design:

- **Pan/zoom** applied directly to `app.stage` (scale + position). All entities and the background sprite live on `app.stage` with `sortableChildren = true`.
- **Background sprite** has `zIndex = 0`; entity layers have `zIndex = 1–4` (mob, npc, player, overlay).
- **Coordinate systems:** `worldToContainer(x, z)` → stage-local coords for PIXI objects; `containerToScreen(cx, cy)` → screen-space for DOM tooltips. World `x` = east/west (DB `pos_x`), world `z` = north/south (DB `pos_z`). FFXI in-game HUD and DB both use X = east/west, Y = elevation, Z = north/south.
- **Stale closure guard:** the PIXI overlay ticker captures its `drawOverlay` function at mount time. `zoneDrawRef` and `boundsDrawRef` mirror the `zone` and `bounds` state as refs so `drawOverlay` always reads current values without depending on React re-renders.
- **Calibration:** two-click anchor system (`calAnchorA`, `calAnchorB`) computes world→container scale from two known points. Saved calibrations are fetched at startup and merged over DB auto-bounds.

## Key design patterns

- **Broadcast-on-change:** `pollAndBroadcast` JSON-stringifies a diff key before broadcasting; zones with no watchers get no zone-specific push.
- **WebSocket zone watching:** clients send `{type:'watch_zone', data:{zoneId}}` to subscribe to `zone_players` messages for map overlays.
- **Zone-to-NPC mapping:** `(npcid >> 12) - 4096` extracts zone ID from the packed NPC/mob ID — used in all `/api/npcs/:zone` and `/api/mobs/:zone` queries.
- **Blob decoding:** binary columns `keyitems`, `titles`, `zones`, `eminence`, `missions`, `assault`, `campaign` on the `chars` table are decoded server-side (functions in `src/routes/characters.ts`).
- **Wiki cache:** BG-wiki quest descriptions are fetched on demand and cached via Redis for 24 h. Persists across restarts (unlike the old in-memory `WIKI_CACHE` Map).
- **Settings writes:** `/api/settings/rates` (POST) edits `main.lua`/`map.lua`/`login.lua` in-place using regex replace — the LSB server must be reloaded separately for changes to take effect.

## Database tab (`/api/db/*`)

All routes live in `src/routes/db.ts`. All endpoints require `requireAuth`. Search uses the `q` query param; zone filter uses the zone **name** string (e.g. `East_Ronfaure`), not zone ID.

| Category | Endpoint | Notes |
|---|---|---|
| Items | `/api/db/items` | Paginated (DB_PAGE=50), sortable, filterable by type/flags/slot/skill |
| NPCs | `/api/db/npcs` | Paginated, zone-filterable (substring match on zone name) |
| Mobs | `/api/db/mobs` | Paginated, zone-filterable (substring match on zone name) |
| Zones | `/api/db/zones` | All zones (non-paged) |
| Jobs | `/api/db/jobs` | Returns `{job, max, count}[]` — max level and leveled-character count per job; filtered client-side |
| Skills | `/api/db/skills` | All skill ranks + level-99 caps from `skill_ranks` JOIN `skill_caps`; JS-filtered |
| Abilities | `/api/db/abilities` | Paginated; filterable by job chip (`?job=1..22`) |
| Quests | `/api/db/quests` | Paginated (`?page=N&q=...&log=N`) from `QUEST_CATALOG` in-memory map |
| Key Items | `/api/db/keyitems` | Paginated from `KEY_ITEM_SORTED` (pre-sorted at startup) |
| Trusts | `/api/db/trusts` | All trust ciphers from `item_basic`; label built by stripping cipher_of_/alter_ego_ affixes; possessive 's' stripped unless name is in `TRUST_NATURAL_S` (e.g. 'iris'); Roman numeral suffixes (Ii→II) normalized |
| Mounts | `/api/db/mounts` | All mount items (name LIKE '♪%') from `item_basic` |

**`DB_PAGE = 50`** is defined in `src/catalog.ts` and as a constant in `client/src/components/pages/Database.tsx`. Both must match.

**`NON_PAGED`** categories (`zones`, `jobs`, `skills`, `trusts`, `mounts`) return all results in one call — the Load More button is suppressed for these.

## Windower addon integration

The `Dashboard` Windower4 addon (`addons/Dashboard/Dashboard.lua` on the gaming PC) sends the player's live position to the dashboard every 2 seconds.

**Endpoint:** `POST /api/windower/position` (handled in `src/routes/windower.ts`)
**Auth:** `x-windower-key: <WINDOWER_API_KEY>` header (no JWT — game client can't do the login flow)
**Body:**
```json
{ "name": "Sora", "zone": 230, "x": 12.5, "y": -45.3, "z": 0.0, "hp": 1000, "mp": 500, "tp": 0 }
```

> **Coordinate convention:** Windower4's Lua API reads game memory where **`y` = north/south** and **`z` = elevation** — the opposite of the LandSandBoat DB (`pos_y` = elevation, `pos_z` = north/south). `normalizeWindower()` in `src/routes/windower.ts` swaps them: `pos_z = p.y`, `pos_y = p.z`. Do not change this mapping without understanding the game-memory vs DB axis difference.

**Behaviour:**
- Stored in `windowerPositions` Map (keyed by character name); entries expire after 30 s of no update
- Immediately broadcasts `zone_players` to WebSocket clients watching that zone
- Also broadcasts `windower_positions` (full map) to all connected clients
- Position is normalized to DB field names (`charname`, `pos_x`, `pos_z`, etc.) via a DB lookup on the character name

**`WINDOWER_API_KEY`** is set in `.env` and passed into the container via `docker-compose.yml`. To rotate the key, update `.env` and run `docker compose up -d --force-recreate` to recreate the container, then update `api_key` in `addons/Dashboard/data/settings.xml` on the gaming PC.
