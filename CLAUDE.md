# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the project

**Docker (preferred):**
```bash
docker compose build        # rebuild image after code changes
docker compose up -d        # start container
docker compose logs -f      # tail logs
```
After `docker compose build`, restart the running container in Portainer (not via `docker compose up` again) to deploy the new image without altering the container configuration. **Exception:** if `docker-compose.yml` env vars changed (e.g. `WINDOWER_API_KEY`), use `docker compose up -d` to recreate the container.

**Bare-metal (dev/test):**
```bash
npm install
DASHBOARD_JWT_SECRET=$(openssl rand -hex 32) node server.js
```

There are no tests, no lint step, and no build step — `node server.js` is the only runtime.

**First-time DB setup:** apply `sql/dashboard_queue.sql` against the LSB `xidb` database once:
```bash
mariadb -u xiadmin -p xidb < sql/dashboard_queue.sql
```

**Required env:** `DASHBOARD_JWT_SECRET` must be set or the server exits immediately. `WINDOWER_API_KEY` must be set for the Windower position endpoint. Copy `.env.example` → `.env` and fill it in.

## Architecture

Single-file Node.js backend (`server.js`) with a single-page HTML frontend (`public/index.html`).

```
Browser
  ├── WebSocket (ws://)   ← live push every 3 s (stats, players, positions)
  └── REST /api/*         ← initial loads and actions

server.js
  ├── mysql2 pool (10 connections) → LandSandBoat MariaDB
  ├── setInterval(pollAndBroadcast, 3000) — DB poll; broadcasts only on change
  ├── startPosWatcher() — reads /ffxi-log/dashboard_positions.json every 1 s
  ├── windowerPositions Map — in-memory live positions from Windower addon (see below)
  ├── ensureLogTail() / spawn('tail') — per-file log streaming for Console tab
  └── auth.js — bcrypt + JWT middleware

Windower4 client (Wine/Linux gaming PC)
  └── Dashboard addon → POST /api/windower/position every 2 s
```

**No framework other than Express.** All REST routes, WebSocket logic, Lua/blob parsers, and in-memory caches live in `server.js`.

## Auth

Two tiers, determined at login time and encoded in the JWT:
- `admin` — account owns any character with `gmlevel >= 1`
- `player` — everything else; scoped to their own characters only

Middleware: `auth.requireAuth` (all non-public routes) and `auth.requireAdmin` (admin-only routes). WS clients send `{type:'auth', data:{token}}` within 5 s or the connection is closed.

Legacy non-bcrypt accounts are rejected with a 409 telling the user to log into the game once to upgrade their hash.

## Edit queue (`dashboard_queue` table)

Admin actions are inserted as rows into `dashboard_queue`; a C++ module in the LSB map server polls the table every 3 s and executes them against live characters.

Supported actions: `additem`, `delitem`, `setgil`, `addgil`, `setskill`, `luaexec`.

- `charid = 0` + `action = luaexec` → runs Lua globally in the map server VM, regardless of character online status.
- Offline characters get status `deferred` and are retried on next poll.
- `PLAYER_ALLOWED_ACTIONS` set in `server.js:575` is empty; populate it to allow player-tier self-service queue entries.

## Runtime file mounts (Docker volumes)

These paths are only available inside the container — graceful degradation applies when absent:

| Container path | Purpose |
|---|---|
| `/ffxi-log/` | Server logs + `dashboard_positions.json` (live pos feed) |
| `/ffxi-settings/` | `main.lua`, `map.lua`, `login.lua` — read/written by `/api/settings/rates` |
| `/ffxi-scripts/` | Lua enum/catalog files: `quests.lua`, `effect.lua`, `merit.lua`, `key_item.lua`, `title.lua`, `roe_records.lua`, `missions.lua`, `quests/<area>/` |

All Lua catalogs (quests, effects, merits, key items, titles, missions, RoE records) are parsed once at startup into in-memory lookup maps. Quest rewards are also parsed at startup by scanning every quest Lua file under `/ffxi-scripts/quests/`.

## Map images

Map PNGs live in `public/maps/` and are served statically. `buildZoneMaps()` at startup scans this directory and matches filenames to zone IDs via `zone_settings.name` normalization. Multi-floor zones use the suffix `_N.png` (e.g. `tavnazian_safehold_1.png`).

`public/maps.json` is a pre-generated index for human reference; the server does not read it at runtime.

## Key design patterns

- **Broadcast-on-change:** `pollAndBroadcast` JSON-stringifies a diff key before broadcasting; zones with no watchers get no zone-specific push.
- **WebSocket zone watching:** clients send `{type:'watch_zone', data:{zoneId}}` to subscribe to `zone_players` messages for map overlays.
- **Zone-to-NPC mapping:** `(npcid >> 12) - 4096` extracts zone ID from the packed NPC/mob ID — used in all `/api/npcs/:zone` and `/api/mobs/:zone` queries.
- **Blob decoding:** binary columns `keyitems`, `titles`, `zones`, `eminence`, `missions`, `assault`, `campaign` on the `chars` table are decoded server-side in `server.js` (functions `decodeKeyItems`, `decodeBitfield`, `decodeEminence`, `decodeMissions`, etc.).
- **Wiki cache:** BG-wiki quest descriptions are fetched on demand and cached in-memory for 24 h (`WIKI_CACHE` Map). No persistence across restarts.
- **Settings writes:** `/api/settings/rates` (POST) edits `main.lua`/`map.lua`/`login.lua` in-place using regex replace — the LSB server must be reloaded separately for changes to take effect.

## Windower addon integration

The `Dashboard` Windower4 addon (`addons/Dashboard/Dashboard.lua` on the gaming PC) sends the player's live position to the dashboard every 2 seconds.

**Endpoint:** `POST /api/windower/position`  
**Auth:** `x-windower-key: <WINDOWER_API_KEY>` header (no JWT — game client can't do the login flow)  
**Body:**
```json
{ "name": "Sora", "zone": 230, "x": 12.5, "y": 0.0, "z": -45.3, "hp": 1000, "mp": 500, "tp": 0 }
```
**Behaviour:**
- Stored in `windowerPositions` Map (keyed by character name); entries expire after 30 s of no update
- Immediately broadcasts `zone_players` to WebSocket clients watching that zone
- Also broadcasts `windower_positions` (full map) to all connected clients

**`WINDOWER_API_KEY`** is set in `.env` and passed into the container via `docker-compose.yml`. To rotate the key, update `.env` and run `docker compose up -d` to recreate the container, then update `api_key` in `addons/Dashboard/data/settings.xml` on the gaming PC.
