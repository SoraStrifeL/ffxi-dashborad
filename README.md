# FFXI Server Dashboard

A real-time web dashboard for [LandSandBoat](https://github.com/LandSandBoat/server) private FFXI servers.

Connects directly to the LSB MariaDB database and pushes live updates over WebSocket. Admin tier is derived automatically from in-game GM level — no separate user management needed.

---

## Features

| Tab | Who | What |
|---|---|---|
| **Map** | All | Zone map with live player/NPC/mob dots; 2-point calibration; Windower live position overlay |
| **Characters** | All | Sortable table; click for full detail — jobs, inventory, equipment, blobs, effects, quests, missions |
| **Zones** | All | All zones ranked by population |
| **Timers** | All | NM pop timer tracker; import directly from server DB |
| **DB** | All | Searchable: Mobs, NPCs, Items (with augments/stats), Quests (with BG-wiki descriptions + charvar status), Zones |
| **Accounts** | Admin | Status, priv, session info |
| **Console** | Admin | Live log tail (map/world/connect/search) + Lua console; execute Lua directly on the live map-server VM |
| **Scripts** | Admin | Save/run reusable Lua snippets; browse and edit server-side Lua files |

**Admin actions via edit queue:** `additem`, `delitem`, `setgil`, `addgil`, `setskill`, `luaexec`

**GM Quick Actions panel** (online characters): Warp to Zone, Home Point, Force Logout, Set Job/Level, Gear Management

---

## Requirements

- [LandSandBoat](https://github.com/LandSandBoat/server) server already running with its MariaDB (`xidb`) accessible
- **Docker path:** Docker Engine + Docker Compose v2
- **Bare-metal path:** Node.js 22+ and npm
- `dashboard_queue.cpp` C++ module installed on the map server (required for edit queue and live position feed — see [C++ Module](#cpp-module) below)

---

## Installation — Docker (recommended)

### 1. Copy and configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Find your LSB Docker network: docker network ls
LSB_NETWORK=landsandboat_default

DB_HOST=db          # LSB database service name (check your docker-compose.yml)
DB_PASS=changeme    # match your LSB DB password

# Required — generate a random secret:
DASHBOARD_JWT_SECRET=$(openssl rand -hex 32)

# Optional — Windower addon live positions
WINDOWER_API_KEY=$(openssl rand -hex 24)
```

### 2. Apply the database schema (once)

```bash
# Run from the host where MariaDB is accessible
mariadb -u xiadmin -p xidb < sql/dashboard_queue.sql
```

### 3. Review `docker-compose.yml` volume mounts

The compose file includes several optional mounts. Comment out any paths that don't exist on your host:

| Mount | Purpose | Required? |
|---|---|---|
| `ffxi_ffxi-logs:/ffxi-log:ro` | Live log tail + position feed | Optional |
| `/opt/stacks/ffxi/settings:/ffxi-settings` | Rate/settings editor | Optional |
| `/opt/stacks/ffxi/scripts/globals/quests.lua` | Quest data | Optional |
| `/opt/stacks/ffxi/scripts/enum/*.lua` | Key items, titles, merits, effects | Optional |
| `/opt/stacks/ffxi/scripts/globals/roe_records.lua` | RoE records | Optional |
| `/opt/stacks/ffxi/scripts/globals/missions.lua` | Missions | Optional |
| `/opt/stacks/ffxi/scripts/quests:/ffxi-scripts/quests:ro` | Quest scripts | Optional |
| `/opt/stacks/ffxi/scripts:/ffxi-server-scripts` | Script browser | Optional |

Adjust paths if your LSB install is not at `/opt/stacks/ffxi/`.

### 4. Build and start

```bash
docker compose build
docker compose up -d
docker compose logs -f   # watch startup
```

Open `http://<host>:3001` in a browser.

> **Redeploying after code changes:** `docker compose build` then restart the container in Portainer (or `docker compose up -d --force-recreate`).  
> **Exception:** if you changed env vars in `.env`, always use `docker compose up -d` to recreate the container.

### 5. Get map images

Map PNGs are not included in the repo (648 MB). Download the Remapster wiki packs and drop the PNGs into `public/maps/`:

1. Go to the [Remapster releases page](https://github.com/remapster/remapster/releases) and download `wiki-pack-1.zip` and `wiki-pack-2.zip`
2. Extract all `.png` files into `public/maps/`
3. No restart needed — maps are served statically and matched at startup

The dashboard works without map images; overlays render on a dark background.

**Alternative — extract from your game install:**

```bash
pip install Pillow
python3 extract_maps.py "/path/to/FINAL FANTASY XI/ROM/115" ./public/maps
```

---

## Installation — Bare-metal

### 1. Install dependencies

```bash
node --version   # need 22+
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — set `DB_HOST` to the IP/hostname of your MariaDB instance (not the Docker service name):

```env
DB_HOST=192.168.1.10
DB_PASS=changeme
DASHBOARD_JWT_SECRET=$(openssl rand -hex 32)
```

Load the file before starting:
```bash
# Option A — export manually
export $(grep -v '^#' .env | xargs)

# Option B — use dotenv-cli
npx dotenv-cli node server.js
```

### 3. Apply the database schema (once)

```bash
mariadb -u xiadmin -p xidb < sql/dashboard_queue.sql
```

### 4. Start

```bash
node server.js
# → FFXI Dashboard running on port 3000
```

Open `http://localhost:3000`.

> The process must stay running. Use `pm2`, `systemd`, or `screen` for persistence.

### 5. Get map images

Same as the Docker path — extract the Remapster wiki packs into `public/maps/`.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `localhost` | MariaDB host (`db` for Docker, IP for bare-metal) |
| `DB_PORT` | `3306` | MariaDB port |
| `DB_USER` | `xiadmin` | Database user |
| `DB_PASS` | `changeme` | Database password |
| `DB_NAME` | `xidb` | Database name |
| `PORT` | `3000` | Dashboard HTTP/WS port (inside container) |
| `DASHBOARD_JWT_SECRET` | *(required)* | Random secret for JWTs — `openssl rand -hex 32` |
| `CORS_ORIGIN` | *(unset)* | Restrict CORS — e.g. `http://192.168.1.10:3001`. Leave unset to block all cross-origin. |
| `WINDOWER_API_KEY` | *(unset)* | Shared key for Windower addon position updates. Leave unset to disable the endpoint. |
| `LSB_NETWORK` | `landsandboat_default` | Docker network (docker-compose only) |

---

## Auth

Login uses your **game account credentials** — the same `accounts` table and bcrypt hash the LSB login server uses. No separate dashboard user management.

- **Admin** — account owns any character with `gmlevel >= 1`
- **Player** — all other valid accounts; scoped to their own characters

Legacy non-bcrypt accounts (pre-2023 LSB) are rejected with a message telling the user to log into the game once (the game client auto-upgrades the hash on login).

Sessions are signed JWTs with a 24-hour TTL stored in the browser.

---

## Edit queue

Admin actions insert rows into the `dashboard_queue` table. The C++ module on the map server polls every 3 s and executes them against live characters.

| Action | Params | Effect |
|---|---|---|
| `additem` | `{item:<itemId>, qty:<1–99>}` | Add item to inventory |
| `delitem` | `{item:<itemId>, qty:<n>}` | Remove item from inventory |
| `setgil` | `{gil:<0–2 000 000 000>}` | Set gil to exact amount |
| `addgil` | `{gil:<signed delta>}` | Add or subtract gil |
| `setskill` | `{skill:<skillId>, level:<0–999>}` | Set any skill level |
| `luaexec` | *(raw Lua)* | Execute Lua on the live map-server VM |

Rows targeting offline characters are marked `deferred` and retried on next poll.  
`luaexec` with `charid = 0` runs globally — no target character needed.

---

## C++ module {#cpp-module}

The edit queue and live position feed require a custom C++ module installed on the LSB map server.

**Source:** `modules/custom/cpp/dashboard_queue.cpp` in your LSB install  
**Register:** add `custom/cpp/dashboard_queue` to `modules/init.txt`  
**Rebuild:** `docker compose build` (LSB image, not this dashboard)

Without the module the dashboard still displays all database data, but:
- Admin actions are queued but never executed
- The live position feed (`/ffxi-log/dashboard_positions.json`) is never written

---

## Windower addon (optional)

The `Dashboard` Windower4 addon sends the player's live zone position every 2 seconds.

1. Set `WINDOWER_API_KEY` in `.env` and redeploy
2. Copy `addons/Dashboard/` to your Windower `addons/` folder on the gaming PC
3. In `addons/Dashboard/data/settings.xml`, set `api_key` and `dashboard_url` to match

The endpoint is `POST /api/windower/position` authenticated with `x-windower-key: <key>`.  
On zone change, the addon can also `POST /api/windower/zone_entities` with a full entity dump (NPCs + mobs) for map overlay.

---

## Persistent data

| File | Contents |
|---|---|
| `data/timers.json` | NM pop timers (created on first save) |
| `data/scripts.json` | Saved Lua scripts — seeded with 14 preset scripts on first run |
| `calibrations.json` | Zone map 2-point calibrations (created at runtime, git-ignored) |
| `public/uploads/` | Custom images for items/NPCs/mobs (created at startup) |

In Docker, `./data` is bind-mounted so `timers.json` and `scripts.json` survive container recreation.

---

## Architecture

```
Browser
  ├── WebSocket (ws://)   ← live push every 3 s (stats, players, positions)
  └── REST /api/*         ← initial loads, actions, DB queries

server.js (Node.js + Express)
  ├── mysql2 pool (10 conns) → LandSandBoat MariaDB (xidb)
  ├── setInterval(pollAndBroadcast, 3000) — DB diff → WS broadcast
  ├── startPosWatcher() — reads /ffxi-log/dashboard_positions.json every 1 s
  ├── windowerPositions Map — live positions from Windower addon (30 s TTL)
  ├── windowerZoneEntities Map — entity dump per zone from Windower addon
  ├── ensureLogTail() / spawn('tail') — per-file log streaming (Console tab)
  └── auth.js — bcrypt verify + JWT sign/verify

dashboard_queue.cpp (LSB map server module)
  ├── Polls dashboard_queue table every 3 s
  ├── Applies actions via LSB internal C++ APIs (addItem, UpdateItem, etc.)
  └── Writes /ffxi-log/dashboard_positions.json every 1 s (all chars + NPCs + mobs)
```

**Key patterns:**
- **Broadcast-on-change:** diff hash checked before each WS push — no redundant traffic
- **Zone watching:** clients send `{type:'watch_zone', data:{zoneId}}` for zone-specific pushes
- **Zone-to-NPC mapping:** `(npcid >> 12) - 4096` extracts zone ID from packed NPC/mob ID
- **Blob decoding:** `keyitems`, `titles`, `zones`, `eminence`, `missions`, `assault`, `campaign` decoded server-side
- **Wiki cache:** BG-wiki fetches cached 24 h in-memory; no persistence across restarts
- **Settings writes:** `main.lua` / `map.lua` / `login.lua` edited in-place via regex; LSB reload required

---

## Database tables used

All tables are standard LandSandBoat schema. The only addition is `dashboard_queue` (see `sql/dashboard_queue.sql`).

| Table | Used for |
|---|---|
| `chars` | Character list, stats, position, home zone |
| `char_stats` | HP, MP, job, level |
| `char_jobs` | All 22 job levels + genkai |
| `char_look` | Race (for display) |
| `char_inventory` | Gil, inventory items |
| `char_equip` | Equipped gear slots |
| `char_effects` | Active buffs/debuffs |
| `accounts` | Auth, status, priv |
| `accounts_sessions` | Online detection |
| `zone_settings` | Zone names + IDs |
| `npc_list` | NPC positions for map overlay |
| `mob_spawn_points` | Mob positions + group |
| `mob_groups` | Mob names, respawn times, zone |
| `item_basic` | Item names, flags |
| `item_equipment` | Weapon stats, equip slots, job mask |
| `item_mods` | Stat modifiers |
| `exp_base` | EXP per level thresholds |
| `roe_records` | Records of Eminence definitions |
| `dashboard_queue` | Admin action queue *(added by this project)* |
