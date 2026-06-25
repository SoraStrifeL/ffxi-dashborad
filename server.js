const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const multer    = require('multer');
const auth      = require('./auth');

// ── Dashboard settings (needed early for autologin gate) ─────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DASHBOARD_SETTINGS_PATH = path.join(DATA_DIR, 'dashboard.json');
const DASHBOARD_DEFAULTS = { serverName: 'FFXI Dashboard', motd: '', autoSwitchZone: true, autologin: process.env.AUTOLOGIN === 'true', allowPlayerLogin: true, tokenTtlHours: 24, adminGmLevel: 1, loginRateLimitMax: 10 };
function loadDashboardSettings() {
  try { return { ...DASHBOARD_DEFAULTS, ...JSON.parse(fs.readFileSync(DASHBOARD_SETTINGS_PATH, 'utf8')) }; }
  catch (_) { return { ...DASHBOARD_DEFAULTS }; }
}
function saveDashboardSettings(s) {
  fs.writeFileSync(DASHBOARD_SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8');
}

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── Database configuration ────────────────────────────────────────────────────
const DB_CONFIG_FILE = path.join(__dirname, 'data', 'db-config.json');
const DB_DEFAULTS = { DB_HOST:'localhost', DB_PORT:3306, DB_USER:'xiadmin', DB_PASS:'changeme', DB_NAME:'xidb' };
function loadDbConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8')); } catch(_) {}
  return {
    DB_HOST: saved.DB_HOST || process.env.DB_HOST || DB_DEFAULTS.DB_HOST,
    DB_PORT: saved.DB_PORT ? Number(saved.DB_PORT) : parseInt(process.env.DB_PORT || '') || DB_DEFAULTS.DB_PORT,
    DB_USER: saved.DB_USER || process.env.DB_USER || DB_DEFAULTS.DB_USER,
    DB_PASS: saved.DB_PASS || process.env.DB_PASS || DB_DEFAULTS.DB_PASS,
    DB_NAME: saved.DB_NAME || process.env.DB_NAME || DB_DEFAULTS.DB_NAME,
  };
}
function saveDbConfig(patch) {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8')); } catch(_) {}
  const updated = { ...current, ...patch };
  for (const k of Object.keys(updated)) {
    if (String(updated[k]) === (process.env[k] || String(DB_DEFAULTS[k]))) delete updated[k];
  }
  fs.mkdirSync(path.dirname(DB_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(DB_CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf8');
}
const _dbCfg = loadDbConfig();

// ── Connection pool (shared by REST + WS poller) ─────────────────────────────
const pool = mysql.createPool({
  host:             _dbCfg.DB_HOST,
  port:             _dbCfg.DB_PORT,
  user:             _dbCfg.DB_USER,
  password:         _dbCfg.DB_PASS,
  database:         _dbCfg.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:          0,
  enableKeepAlive:    true,
  keepAliveInitialDelay: 0,
});

const MAPS_DIR    = path.join(__dirname, 'public', 'maps');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
['items','npcs','mobs'].forEach(d => fs.mkdirSync(path.join(UPLOADS_DIR, d), { recursive: true }));

// ── Server-side calibration store ─────────────────────────────────────────────
const CAL_FILE = path.join(__dirname, 'calibrations.json');
let calStore = {};
try { calStore = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')); } catch(_) {}
function saveCalStore() {
  try { fs.writeFileSync(CAL_FILE, JSON.stringify(calStore, null, 2)); }
  catch(e) { console.error('[cal] save error:', e.message); }
}

// ── Windower live position store ───────────────────────────────────────────────
const WINDOWER_API_KEY = process.env.WINDOWER_API_KEY || '';
// charname → { name, zone, x, y, z, map_index, hp, mp, tp, ts }
const windowerPositions = new Map();
// Evict entries with no update in the last 30 s
setInterval(() => {
  const cutoff = Date.now() - 30_000;
  for (const [k, v] of windowerPositions) if (v.ts < cutoff) windowerPositions.delete(k);
}, 10_000);

// ── Windower zone entity store ─────────────────────────────────────────────────
// zoneId → { ts, entities: [{id, index, name, x, y, z, spawn_type, model_id}] }
const windowerZoneEntities = new Map();

const ALLOWED_IMG_MIME = new Set(['image/jpeg','image/png','image/gif','image/webp']);
function makeUploader(dest) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dest),
      filename:    (_req, _file, cb) => cb(null, _req._uploadFilename),
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      cb(ALLOWED_IMG_MIME.has(file.mimetype) ? null : new Error('Only image files are allowed'), ALLOWED_IMG_MIME.has(file.mimetype));
    },
  }).single('image');
}

// ── Zone → map filename(s): built at startup by scanning public/maps/ ─────────
// Normalized zone name: lowercase, strip '[](), replace [-\s] with _, collapse _.
function normZoneName(s) {
  return s.toLowerCase()
    .replace(/['\[\]()]/g, '')
    .replace(/[-\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

let ZONE_MAPS = {};
async function buildZoneMaps() {
  let files = [];
  try { files = fs.readdirSync(MAPS_DIR).filter(f => f.endsWith('.png')); } catch (_) {}

  // Group files by base name, stripping trailing _N numeric floor suffix.
  const groups = {};
  files.forEach(f => {
    const base = f.slice(0, -4).replace(/_\d+$/, '');
    (groups[base] = groups[base] || []).push(f);
  });
  Object.values(groups).forEach(g => g.sort((a, b) => {
    const n = s => parseInt(s.match(/_(\d+)\.png$/)?.[1] ?? 0);
    return n(a) - n(b);
  }));

  // Build normalized name → zoneid lookup from the DB.
  const nameToId = {};
  try {
    const [rows] = await pool.execute('SELECT zoneid, name FROM zone_settings');
    rows.forEach(r => { nameToId[normZoneName(r.name)] = r.zoneid; });
  } catch (_) { return; }

  // Match each file group to a zone.
  const result = {};
  Object.entries(groups).forEach(([base, fileList]) => {
    const zoneId = nameToId[base];
    if (zoneId != null) result[zoneId] = fileList;
    else console.log(`[maps] no zone match for: ${base}`);
  });

  ZONE_MAPS = result;
  console.log(`[maps] ${Object.keys(result).length} zones mapped from ${files.length} file(s)`);
}

// ── Shared queries ────────────────────────────────────────────────────────────
async function queryStats() {
  const [[{ total_players  }]] = await pool.execute('SELECT COUNT(*) AS total_players  FROM chars');
  const [[{ total_accounts }]] = await pool.execute('SELECT COUNT(*) AS total_accounts FROM accounts');
  const [[{ online_players }]] = await pool.execute('SELECT COUNT(*) AS online_players FROM accounts_sessions');
  const [[{ total_zones    }]] = await pool.execute('SELECT COUNT(*) AS total_zones    FROM zone_settings');
  return { total_players, total_accounts, online_players, total_zones };
}

async function queryPlayers() {
  const [rows] = await pool.execute(`
    SELECT c.charid, c.charname, c.pos_x, c.pos_y, c.pos_z, c.pos_zone,
           c.gmlevel, c.nation, c.playtime, c.timecreated, c.last_logout,
           z.name AS zone_name,
           cs.mjob, cs.mlvl, cs.sjob, cs.slvl, cs.hp, cs.mp,
           CASE WHEN ses.charid IS NOT NULL THEN 1 ELSE 0 END AS online
    FROM chars c
    LEFT JOIN zone_settings   z   ON c.pos_zone = z.zoneid
    LEFT JOIN char_stats      cs  ON c.charid   = cs.charid
    LEFT JOIN accounts_sessions ses ON c.charid = ses.charid
    ORDER BY c.charname
  `);
  return rows;
}

// ── WebSocket state ───────────────────────────────────────────────────────────
const clients = new Map(); // ws → { watchZone, logSub, user }

// ── Server log streaming ──────────────────────────────────────────────────────
const LOG_DIR   = '/ffxi-log';
const LOG_FILES = { map:'map-server.log', world:'world-server.log', connect:'connect-server.log', search:'search-server.log' };
const logTails  = new Map(); // fileKey → { proc, subs: Set<ws> }

function ensureLogTail(fileKey) {
  if (logTails.has(fileKey)) return;
  const proc = spawn('tail', ['-n', '100', '-f', `${LOG_DIR}/${LOG_FILES[fileKey]}`]);
  const entry = { proc, subs: new Set() };
  logTails.set(fileKey, entry);
  proc.stdout.on('data', chunk => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    const msg = JSON.stringify({ type: 'log', data: { file: fileKey, lines } });
    entry.subs.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
  });
  proc.stdout.on('error', e => console.error(`[log:${fileKey}] stdout error:`, e.message));
  proc.on('error', e => console.error(`[log:${fileKey}]`, e.message));
}

function subscribeLog(ws, fileKey) {
  if (!LOG_FILES[fileKey]) return;
  const state = clients.get(ws);
  if (!state) return;
  if (state.logSub === fileKey) return;
  if (state.logSub) unsubscribeLog(ws);
  state.logSub = fileKey;
  ensureLogTail(fileKey);
  logTails.get(fileKey).subs.add(ws);
}

function unsubscribeLog(ws) {
  const state = clients.get(ws);
  if (!state?.logSub) return;
  const entry = logTails.get(state.logSub);
  if (entry) {
    entry.subs.delete(ws);
    if (entry.subs.size === 0) { entry.proc.kill(); logTails.delete(state.logSub); }
  }
  state.logSub = null;
}
// ── Live position feed (written by dashboard_queue C++ module every 1 s) ──────
const POS_FILE = '/ffxi-log/dashboard_positions.json';

function startPosWatcher() {
  if (!fs.existsSync(POS_FILE)) {
    // File not yet available (module not loaded / first boot); check again in 10 s.
    setTimeout(startPosWatcher, 10000);
    return;
  }
  console.log('[pos] watching', POS_FILE);
  let lastMtime = 0;
  setInterval(() => {
    try {
      const { mtimeMs } = fs.statSync(POS_FILE);
      if (mtimeMs <= lastMtime) return;
      lastMtime = mtimeMs;
      const raw = fs.readFileSync(POS_FILE, 'utf8');
      const positions = JSON.parse(raw);
      if (clients.size > 0) broadcast('positions', positions);
    } catch (_) {}
  }, 1000);
}

let lastState = {};

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  clients.forEach((_, ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function broadcastToZone(zoneId, type, data) {
  const msg = JSON.stringify({ type, data });
  clients.forEach((state, ws) => {
    if (ws.readyState === WebSocket.OPEN && state.watchZone == zoneId) ws.send(msg);
  });
}

// ── Live poll (every 3 s) ─────────────────────────────────────────────────────
async function pollAndBroadcast() {
  if (clients.size === 0) return;
  try {
    const [stats, players] = await Promise.all([queryStats(), queryPlayers()]);

    if (JSON.stringify(stats) !== JSON.stringify(lastState.stats)) {
      broadcast('stats', stats);
      lastState.stats = stats;
    }

    const playersKey = JSON.stringify(
      players.map(p => ({ id: p.charid, x: p.pos_x, z: p.pos_z, zone: p.pos_zone, hp: p.hp, mp: p.mp }))
    );
    if (playersKey !== lastState.playersKey) {
      broadcast('players', players);
      lastState.playersKey = playersKey;

      const byZone = {};
      players.forEach(p => {
        (byZone[p.pos_zone] = byZone[p.pos_zone] || []).push(p);
      });
      Object.entries(byZone).forEach(([zoneId, zonePlayers]) => {
        broadcastToZone(zoneId, 'zone_players', { zoneId, players: zonePlayers });
      });
    }
  } catch (e) {
    console.error('[poll]', e.message);
  }
}

setInterval(pollAndBroadcast, 3000);

// ── WebSocket connections ─────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('[ws] client connected (%d total)', wss.clients.size);

  // Client must send {type:'auth',token} within 5 s or we close.
  const authTimeout = setTimeout(() => {
    if (!clients.has(ws)) ws.close(1008, 'auth timeout');
  }, 5000);

  async function acceptAuth(token) {
    let user;
    try { user = auth.verifyToken(token); }
    catch (_) { ws.close(1008, 'invalid token'); return; }

    clearTimeout(authTimeout);
    clients.set(ws, { watchZone: null, logSub: null, user });

    try {
      const [stats, players] = await Promise.all([queryStats(), queryPlayers()]);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stats',   data: stats   }));
        ws.send(JSON.stringify({ type: 'players', data: players }));
      }
    } catch (e) { console.error('[ws init]', e.message); }
  }

  ws.on('message', (msg) => {
    try {
      const { type, data } = JSON.parse(msg);
      if (!clients.has(ws)) {
        if (type === 'auth' && data?.token) acceptAuth(data.token);
        return;
      }
      if (type === 'watch_zone') clients.get(ws).watchZone = data.zoneId;
      if (type === 'log_sub'   && clients.get(ws).user.tier === 'admin') subscribeLog(ws, data.file);
      if (type === 'log_unsub') unsubscribeLog(ws);
    } catch (_) {}
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    unsubscribeLog(ws);
    clients.delete(ws);
    console.log('[ws] client disconnected');
  });
});

// ── REST endpoints ────────────────────────────────────────────────────────────
const _startTime = Date.now();
const _pkg = (() => { try { return require('./package.json'); } catch(_) { return {}; } })();

app.get('/api/health', async (_req, res) => {
  let dbOk = false;
  try { await pool.execute('SELECT 1'); dbOk = true; } catch(_) {}
  const mem = process.memoryUsage();
  const status = dbOk ? 200 : 503;
  res.status(status).json({
    status:  dbOk ? 'ok' : 'degraded',
    version: _pkg.version || 'unknown',
    uptime:  Math.floor((Date.now() - _startTime) / 1000),
    db:      dbOk ? 'ok' : 'unreachable',
    redis:   'unavailable',
    plugins: [],
    memory: {
      heapUsedMb:  +(mem.heapUsed  / 1024 / 1024).toFixed(1),
      heapTotalMb: +(mem.heapTotal / 1024 / 1024).toFixed(1),
      rssMb:       +(mem.rss       / 1024 / 1024).toFixed(1),
    },
  });
});

app.get('/api/stats', auth.requireAuth, async (_req, res) => {
  try { res.json(await queryStats()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/players', auth.requireAuth, async (_req, res) => {
  try { res.json(await queryPlayers()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Returns { zoneId: floorCount } for all zones with at least one map file on disk
app.get('/api/maps', (_req, res) => {
  const result = {};
  Object.entries(ZONE_MAPS).forEach(([zoneId, files]) => {
    const available = files.filter(f => fs.existsSync(path.join(MAPS_DIR, f)));
    if (available.length) result[zoneId] = available.length;
  });
  res.json(result);
});

app.get('/api/map/:zoneId', (req, res) => {
  const zoneId = parseInt(req.params.zoneId);
  const files  = ZONE_MAPS[zoneId];
  if (!files) return res.status(404).json({ error: 'No map for this zone' });
  const floor   = Math.max(0, Math.min(parseInt(req.query.floor || 0), files.length - 1));
  const filepath = path.join(MAPS_DIR, files[floor]);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Map file not found on disk' });
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filepath);
});

app.get('/api/npcs/:zone', auth.requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT npcid, CONVERT(name USING utf8) AS name, pos_x, pos_y, pos_z
      FROM npc_list
      WHERE (npcid >> 12) - 4096 = ?
        AND pos_x != 0 AND pos_z != 0
        AND pos_x BETWEEN -512 AND 512
        AND pos_z BETWEEN -512 AND 512
      ORDER BY name
    `, [parseInt(req.params.zone)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// mJob from mob_pools (minLevel/maxLevel not stored in DB — calculated server-side in LSB Lua)
app.get('/api/mobs/:zone', auth.requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT ms.mobid,
             ms.mobname AS name,
             ms.pos_x, ms.pos_y, ms.pos_z,
             mp.mJob, mp.aggro, mp.links,
             mss.family, mss.ecosystem
      FROM mob_spawn_points ms
      LEFT JOIN mob_groups mg ON ms.groupid = mg.groupid AND ((ms.mobid>>12)&0xFFF)=mg.zoneid
      LEFT JOIN mob_pools  mp ON mg.poolid  = mp.poolid
      LEFT JOIN mob_species_system mss ON mp.speciesid = mss.speciesID
      WHERE (ms.mobid >> 12) - 4096 = ?
        AND ms.pos_x != 0 AND ms.pos_z != 0
        AND ms.pos_x BETWEEN -512 AND 512
        AND ms.pos_z BETWEEN -512 AND 512
      ORDER BY ms.mobname
    `, [parseInt(req.params.zone)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auto-derived zone bounds from NPC + mob spawn positions (used to seed client ZONE_BOUNDS)
app.get('/api/bounds', auth.requireAuth, async (_req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT zone,
             MIN(pos_x) AS min_x, MAX(pos_x) AS max_x,
             MIN(pos_z) AS min_z, MAX(pos_z) AS max_z
      FROM (
        SELECT (npcid >> 12) - 4096 AS zone, pos_x, pos_z
        FROM npc_list
        WHERE pos_x BETWEEN -2000 AND 2000 AND pos_z BETWEEN -2000 AND 2000
        UNION ALL
        SELECT (mobid >> 12) - 4096 AS zone, pos_x, pos_z
        FROM mob_spawn_points
        WHERE pos_x != 0 AND pos_z != 0
          AND pos_x BETWEEN -2000 AND 2000 AND pos_z BETWEEN -2000 AND 2000
      ) t
      GROUP BY zone
      HAVING COUNT(*) >= 2
    `);
    const out = {};
    rows.forEach(r => {
      const padX = Math.max((r.max_x - r.min_x) * 0.12, 5);
      const padZ = Math.max((r.max_z - r.min_z) * 0.12, 5);
      out[r.zone] = {
        minX: +( r.min_x - padX).toFixed(1),
        maxX: +( r.max_x + padX).toFixed(1),
        minZ: +( r.min_z - padZ).toFixed(1),
        maxZ: +( r.max_z + padZ).toFixed(1),
      };
    });
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/calibrations', auth.requireAuth, (_req, res) => res.json(calStore));

app.post('/api/calibrations/:zoneId', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const zoneId = parseInt(req.params.zoneId);
  if (!Number.isFinite(zoneId)) return res.status(400).json({ error: 'Invalid zone' });
  const { minX, maxX, minZ, maxZ } = req.body || {};
  if ([minX, maxX, minZ, maxZ].some(v => typeof v !== 'number' || !isFinite(v)) || minX >= maxX || minZ >= maxZ)
    return res.status(400).json({ error: 'Invalid bounds' });
  calStore[zoneId] = { minX, maxX, minZ, maxZ };
  saveCalStore();
  res.json({ ok: true });
});

app.delete('/api/calibrations/:zoneId', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const zoneId = parseInt(req.params.zoneId);
  delete calStore[zoneId];
  saveCalStore();
  res.json({ ok: true });
});

app.get('/api/zones', auth.requireAuth, async (_req, res) => {
  if (ZONE_CACHE) { res.json(ZONE_CACHE); loadZoneCache(); return; }
  await loadZoneCache();
  res.json(ZONE_CACHE || []);
});

app.get('/api/db/zones/wiki', auth.requireAuth, async (req, res) => {
  try {
    const rawName = (req.query.name||'').trim();
    if (!rawName) return res.json({});
    const cacheKey = 'zone:' + rawName.toLowerCase();
    const cached = WIKI_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < WIKI_CACHE_TTL) return res.json(cached);
    const wikiName = rawName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('_');
    const wikiUrl = `https://www.bg-wiki.com/ffxi/${encodeURIComponent(wikiName)}`;
    const resp = await fetch(wikiUrl, { headers:{ 'User-Agent':'FFXIDashboard/1.0' }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return res.json({ wikiUrl, notFound: true });
    const html = await resp.text();
    const stripTags = s => s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&apos;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
    // Description: first real paragraph in parser-output
    let description = null;
    const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)];
    for (const [, p] of paras) {
      const t = stripTags(p);
      if (t.length > 40 && !/^\s*$/.test(t)) { description = t; break; }
    }
    // Infobox table rows: <th>Key</th><td>Value</td>
    const infoRows = {};
    const rowRe = /<tr[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/g;
    let m;
    while ((m = rowRe.exec(html)) !== null) {
      const k = stripTags(m[1]).replace(/:$/,'').trim();
      const v = stripTags(m[2]).trim();
      if (k && v) infoRows[k] = v;
    }
    // Connected zones: li items in "Connected" section
    const connM = html.match(/(?:Connected\s*(?:Zones?)?|Connections?)[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
    const connected = [];
    if (connM) {
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
      while ((m = liRe.exec(connM[1])) !== null) {
        const t = stripTags(m[1]);
        if (t) connected.push(t);
      }
    }
    const out = {
      description,
      region: infoRows['Region'] || infoRows['Conquest Region'] || null,
      levelRange: infoRows['Level Range'] || infoRows['Recommended Level'] || infoRows['Level'] || null,
      weather: infoRows['Weather'] || null,
      connected: connected.slice(0, 12),
      wikiUrl,
      cachedAt: Date.now(),
    };
    WIKI_CACHE.set(cacheKey, out);
    res.json(out);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/api/accounts', auth.requireAuth, auth.requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT a.id, a.login, a.status, a.priv, a.timecreate, a.timelastmodify
      FROM accounts a
      ORDER BY a.timelastmodify DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/characters/:zone', auth.requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT c.charid, c.charname, c.pos_x, c.pos_y, c.pos_z,
             c.nation, cs.mjob, cs.mlvl, cs.sjob, cs.slvl, cs.hp, cs.mp,
             CASE WHEN ses.charid IS NOT NULL THEN 1 ELSE 0 END AS online
      FROM chars c
      LEFT JOIN char_stats       cs  ON c.charid = cs.charid
      LEFT JOIN accounts_sessions ses ON c.charid = ses.charid
      WHERE c.pos_zone = ?
      ORDER BY c.charname
    `, [parseInt(req.params.zone)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Login rate limiter: max 10 attempts per 15 min, tracked by IP and by
//    account name so distributed IPs can't brute-force a single account. ───────
const loginAttempts = new Map();
function checkLoginRateLimit(key) {
  const now = Date.now(), window = 15 * 60 * 1000, max = 10;
  let e = loginAttempts.get(key);
  if (!e || now - e.start > window) { e = { start: now, count: 0 }; loginAttempts.set(key, e); }
  return ++e.count > max;
}
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, e] of loginAttempts) if (e.start < cutoff) loginAttempts.delete(k);
}, 5 * 60 * 1000);

app.post('/api/login', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  const { login, password } = req.body || {};
  // Check both IP and account name so neither can be abused independently.
  if (checkLoginRateLimit(`ip:${ip}`) || (login && checkLoginRateLimit(`acct:${String(login).toLowerCase()}`)))
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  try {
    const identity = await auth.authenticate(pool, login, password);
    if (!identity) return res.status(401).json({ error: 'invalid credentials' });
    if (identity.error === 'legacy_password') {
      return res.status(409).json({ error: 'Log into the game once to upgrade your account security, then try again.' });
    }
    res.json({ token: auth.issueToken(identity), tier: identity.tier, login: identity.login });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/autologin', async (_req, res) => {
  if (!loadDashboardSettings().autologin)
    return res.status(403).json({ error: 'disabled' });
  try {
    const [rows] = await pool.execute(
      'SELECT a.id, a.login FROM accounts a JOIN chars c ON c.accid = a.id WHERE a.status = 1 AND c.gmlevel >= ? ORDER BY c.gmlevel DESC LIMIT 1',
      [auth.ADMIN_GM_LEVEL]);
    if (!rows.length) return res.status(403).json({ error: 'no admin account found' });
    const { id, login } = rows[0];
    const identity = { accid: id, tier: 'admin', login };
    res.json({ token: auth.issueToken(identity), tier: identity.tier, login: identity.login });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/me', auth.requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.tier === 'admin';
    const [chars] = await pool.execute(
      `SELECT c.charid, c.charname, c.pos_zone, c.gmlevel, c.nation,
             z.name AS zone_name,
             cs.mjob, cs.mlvl, cs.sjob, cs.slvl, cs.hp, cs.mp,
             CASE WHEN ses.charid IS NOT NULL THEN 1 ELSE 0 END AS online
      FROM chars c
      LEFT JOIN zone_settings    z   ON c.pos_zone = z.zoneid
      LEFT JOIN char_stats       cs  ON c.charid   = cs.charid
      LEFT JOIN accounts_sessions ses ON c.charid  = ses.charid
      ${isAdmin ? '' : 'WHERE c.accid = ?'} ORDER BY c.charname`,
      isAdmin ? [] : [req.user.accid]);
    res.json({ tier: req.user.tier, login: req.user.login, accid: req.user.accid, characters: chars });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/character/:charid', auth.requireAuth, async (req, res) => {
  try {
    const charid = parseInt(req.params.charid);
    if (req.user.tier !== 'admin' && !(await auth.userOwnsChar(pool, req.user.accid, charid)))
      return res.status(403).json({ error: 'not your character' });
    const [[c]] = await pool.execute(`
      SELECT c.charid, c.charname, c.pos_zone, c.pos_x, c.pos_y, c.pos_z,
             c.gmlevel, c.nation, c.playtime, c.timecreated, c.last_logout, c.accid,
             c.home_zone, c.home_x, c.home_y, c.home_z,
             c.pos_prevzone, c.mentor, c.job_master, c.moghancement,
             z.name  AS zone_name,
             hz.name AS home_zone_name,
             pz.name AS prev_zone_name,
             cs.mjob, cs.mlvl, cs.sjob, cs.slvl, cs.hp, cs.mp,
             cl.race, cl.size AS char_size, cl.face,
             cj.genkai,
             cj.war, cj.mnk, cj.whm, cj.blm, cj.rdm, cj.thf,
             cj.pld, cj.drk, cj.bst, cj.brd, cj.rng, cj.sam,
             cj.nin, cj.drg, cj.smn, cj.blu, cj.cor, cj.pup,
             cj.dnc, cj.sch, cj.geo, cj.run,
             a.login AS account_login, a.status AS account_status, a.priv AS account_priv,
             CASE WHEN ses.charid IS NOT NULL THEN 1 ELSE 0 END AS online
      FROM chars c
      LEFT JOIN zone_settings     z   ON c.pos_zone    = z.zoneid
      LEFT JOIN zone_settings     hz  ON c.home_zone   = hz.zoneid
      LEFT JOIN zone_settings     pz  ON c.pos_prevzone= pz.zoneid
      LEFT JOIN char_stats        cs  ON c.charid      = cs.charid
      LEFT JOIN char_look         cl  ON c.charid    = cl.charid
      LEFT JOIN char_jobs         cj  ON c.charid    = cj.charid
      LEFT JOIN accounts          a   ON c.accid     = a.id
      LEFT JOIN accounts_sessions ses ON c.charid    = ses.charid
      WHERE c.charid = ? LIMIT 1`, [charid]);
    if (!c) return res.status(404).json({ error: 'character not found' });
    const [[gilRow]] = await pool.execute('SELECT quantity AS gil FROM char_inventory WHERE charid = ? AND itemId = 65535 LIMIT 1', [charid]);
    c.gil = gilRow ? gilRow.gil : 0;
    const [[gearRow]] = await pool.execute(`
      SELECT
        COALESCE(SUM(CASE WHEN im.modId = 2 THEN im.value ELSE 0 END), 0) AS gear_hp,
        COALESCE(SUM(CASE WHEN im.modId = 5 THEN im.value ELSE 0 END), 0) AS gear_mp
      FROM char_equip ce
      JOIN char_inventory ci
        ON ce.charid = ci.charid AND ce.containerid = ci.location AND ce.slotid = ci.slot
      LEFT JOIN item_mods im ON ci.itemId = im.itemId AND im.modId IN (2, 5)
      WHERE ce.charid = ?
    `, [charid]);
    c.gear_hp = gearRow ? Number(gearRow.gear_hp) : 0;
    c.gear_mp = gearRow ? Number(gearRow.gear_mp) : 0;
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/character/:charid/extended', auth.requireAuth, async (req, res) => {
  try {
    const charid = parseInt(req.params.charid);
    if (req.user.tier !== 'admin' && !(await auth.userOwnsChar(pool, req.user.accid, charid)))
      return res.status(403).json({ error: 'not your character' });

    const [
      [exp], [history], [profile], [points], [skills],
      [flags], [job_points], [merits], [spells],
      [pet], [chocobo], [unlocks], [storage], [bag_counts], [vars],
    ] = await Promise.all([
      pool.execute(`SELECT war,mnk,whm,blm,rdm,thf,pld,drk,bst,brd,rng,sam,nin,drg,smn,blu,cor,pup,dnc,sch,geo,run,merits,limits FROM char_exp WHERE charid=?`, [charid]),
      pool.execute(`SELECT enemies_defeated,times_knocked_out,battles_fought,spells_cast,abilities_used,ws_used,items_used,npc_interactions,chats_sent,distance_travelled,mh_entrances,joined_parties,joined_alliances,gm_calls FROM char_history WHERE charid=?`, [charid]),
      pool.execute(`SELECT rank_points,rank_sandoria,rank_bastok,rank_windurst,fame_sandoria,fame_bastok,fame_windurst,fame_norg,fame_jeuno,fame_adoulin,unity_leader FROM char_profile WHERE charid=?`, [charid]),
      pool.execute(`SELECT sandoria_cp,bastok_cp,windurst_cp,spark_of_eminence,shining_star,deeds,bayld,escha_silt,escha_beads,allied_notes,unity_accolades,current_accolades,current_hallmarks,total_hallmarks,gallantry,login_points,fellow_point,imperial_standing,ballista_point,infamy,prestige,domain_points,mog_segments,gallimaufry,kinetic_unit,cruor,traverser_stones,voidstones,resistance_credit,dominion_note,zeni_point,jetton,therion_ichor,leujaoam_assault_point,mamool_assault_point,lebros_assault_point,periqia_assault_point,ilrusi_assault_point,nyzul_isle_assault_point,temenos_units,apollyon_units,beastman_seal,kindred_seal,kindred_crest,high_kindred_crest,sacred_kindred_crest,ancient_beastcoin,valor_point,scyld,research_mark,guild_fishing,guild_woodworking,guild_smithing,guild_goldsmithing,guild_weaving,guild_leathercraft,guild_bonecraft,guild_alchemy,guild_cooking,fire_crystals,ice_crystals,wind_crystals,earth_crystals,lightning_crystals,water_crystals,light_crystals,dark_crystals,daily_tally,chocobuck_sandoria,chocobuck_bastok,chocobuck_windurst FROM char_points WHERE charid=?`, [charid]),
      pool.execute(`SELECT cs.skillid, cs.value, cs.rank,
        CASE cs.rank
          WHEN 0 THEN sc.r0 WHEN 1 THEN sc.r1 WHEN 2 THEN sc.r2 WHEN 3 THEN sc.r3
          WHEN 4 THEN sc.r4 WHEN 5 THEN sc.r5 WHEN 6 THEN sc.r6 WHEN 7 THEN sc.r7
          WHEN 8 THEN sc.r8 WHEN 9 THEN sc.r9 WHEN 10 THEN sc.r10 WHEN 11 THEN sc.r11
          WHEN 12 THEN sc.r12 WHEN 13 THEN sc.r13
        END AS cap
        FROM char_skills cs
        JOIN char_stats cst ON cst.charid = cs.charid
        JOIN skill_caps sc ON sc.level = cst.mlvl
        WHERE cs.charid=? ORDER BY cs.skillid`, [charid]),
      pool.execute(`SELECT gmModeEnabled, gmHiddenEnabled, muted FROM char_flags WHERE charid=?`, [charid]),
      pool.execute(`SELECT jobid, capacity_points, job_points, job_points_spent FROM char_job_points WHERE charid=? ORDER BY jobid`, [charid]),
      pool.execute(`SELECT meritid, upgrades FROM char_merit WHERE charid=? AND upgrades>0 ORDER BY meritid`, [charid]),
      pool.execute(`SELECT cs.spellid, sl.name, sl.\`group\` FROM char_spells cs LEFT JOIN spell_list sl ON cs.spellid=sl.spellid WHERE cs.charid=? ORDER BY sl.\`group\`, sl.name`, [charid]),
      pool.execute(`SELECT wyvernid, automatonid, adventuringfellowid AS fellowid, chocoboid, field_chocobo FROM char_pet WHERE charid=?`, [charid]),
      pool.execute(`SELECT first_name, last_name, stage, color, strength, endurance, discernment, receptivity, affection, energy FROM char_chocobos WHERE charid=?`, [charid]),
      pool.execute(`SELECT outpost_sandy, outpost_bastok, outpost_windy, mog_locker, runic_portal, maw FROM char_unlocks WHERE charid=?`, [charid]),
      pool.execute(`SELECT inventory, safe, locker, satchel, sack, \`case\`, wardrobe FROM char_storage WHERE charid=?`, [charid]),
      pool.execute(`SELECT location, COUNT(*) AS count FROM char_inventory WHERE charid=? AND NOT (location=0 AND itemId=65535) GROUP BY location ORDER BY location`, [charid]),
      pool.execute(`SELECT varname, value FROM char_vars WHERE charid=? ORDER BY varname LIMIT 200`, [charid]),
    ]);

    res.json({
      exp:        exp[0]      || null,
      history:    history[0]  || null,
      profile:    profile[0]  || null,
      points:     points[0]   || null,
      skills,
      flags:      flags[0]    || null,
      job_points: job_points.map(r => ({ ...r })),
      merits:     merits.map(r => ({ ...r, name: MERIT_NAMES[r.meritid] || `Merit ${r.meritid}` })),
      spells:     spells.map(r => ({ ...r, groupName: SPELL_GROUPS[r.group] || `Group ${r.group}` })),
      pet:        pet[0]      || null,
      chocobo:    chocobo[0]  || null,
      unlocks:    unlocks[0]  || null,
      storage:    storage[0]  || null,
      bag_counts,
      vars,
      expPerLevel: EXP_PER_LEVEL,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/inventory/:charid', auth.requireAuth, async (req, res) => {
  try {
    const charid = parseInt(req.params.charid);
    if (req.user.tier !== 'admin' && !(await auth.userOwnsChar(pool, req.user.accid, charid)))
      return res.status(403).json({ error: 'not your character' });
    const [rows] = await pool.execute(
      `SELECT ci.slot, ci.itemId, ci.quantity, ci.bazaar, CONVERT(ib.name USING utf8) AS name
      FROM char_inventory ci LEFT JOIN item_basic ib ON ci.itemId = ib.itemid
      WHERE ci.charid = ? AND ci.location = 0 AND ci.itemId != 65535 ORDER BY ci.slot`, [charid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Whitelist of actions players may queue for their own characters.
// Admins bypass this check entirely. Add action name strings here when
// player self-service queue entries are desired (e.g. 'requestwarp').
const PLAYER_ALLOWED_ACTIONS = new Set([]);

app.post('/api/queue', auth.requireAuth, async (req, res) => {
  try {
    const { charid, action, params } = req.body || {};
    if (!charid || !action) return res.status(400).json({ error: 'charid and action required' });
    if (req.user.tier !== 'admin') {
      if (!(await auth.userOwnsChar(pool, req.user.accid, charid))) return res.status(403).json({ error: 'not your character' });
      if (!PLAYER_ALLOWED_ACTIONS.has(action)) return res.status(403).json({ error: 'action not allowed for players' });
    }
    const paramStr = typeof params === 'string' ? params : JSON.stringify(params || {});
    await pool.execute('INSERT INTO dashboard_queue (charid, action, params, requested_by) VALUES (?, ?, ?, ?)', [charid, action, paramStr, req.user.login]);
    res.json({ queued: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/queue/recent/:charid', auth.requireAuth, async (req, res) => {
  try {
    const charid = parseInt(req.params.charid);
    if (req.user.tier !== 'admin' && !(await auth.userOwnsChar(pool, req.user.accid, charid)))
      return res.status(403).json({ error: 'not your character' });
    const [rows] = await pool.execute('SELECT id, action, params, status, result, created_at, processed_at FROM dashboard_queue WHERE charid = ? ORDER BY id DESC LIMIT 10', [charid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Single queue row — used to poll luaexec results
app.get('/api/queue/:id', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const [[row]] = await pool.execute(
      'SELECT id, action, status, result, created_at, processed_at FROM dashboard_queue WHERE id = ?',
      [parseInt(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lua console — admin only; params stored as raw Lua source (not JSON) to avoid escaping issues
app.post('/api/console', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { cmd } = req.body || {};
    if (!cmd || typeof cmd !== 'string') return res.status(400).json({ error: 'cmd required' });
    const [result] = await pool.execute(
      'INSERT INTO dashboard_queue (charid, action, params, requested_by) VALUES (0, "luaexec", ?, ?)',
      [cmd, req.user.login]);
    res.json({ id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quests ────────────────────────────────────────────────────────────────────
const QUEST_LOG_NAMES = ["San d'Oria",'Bastok','Windurst','Jeuno','Other Areas','Outlands','Aht Urhgan','Crystal War','Abyssea','Adoulin','Coalition'];
const QUEST_LOG_ENUM  = {SANDORIA:0,BASTOK:1,WINDURST:2,JEUNO:3,OTHER_AREAS:4,OUTLANDS:5,AHT_URHGAN:6,CRYSTAL_WAR:7,ABYSSEA:8,ADOULIN:9,COALITION:10};

function buildQuestCatalog() {
  const catalog = Array.from({length:11}, ()=>({}));
  // constToId: (logId, CONST_NAME) -> questId  — used for Quest:new() fallback resolution
  const constToId = {};
  try {
    const text = fs.readFileSync('/ffxi-scripts/quests.lua', 'utf8');
    const sectionRe = /\[xi\.quest\.area\[xi\.questLog\.([A-Z_]+)\]\]\s*=\s*\{([^}]+)\}/gs;
    let m;
    while ((m = sectionRe.exec(text)) !== null) {
      const logIdx = QUEST_LOG_ENUM[m[1]];
      if (logIdx === undefined) continue;
      const entryRe = /(\w+)\s*=\s*(\d+)/g;
      let e;
      while ((e = entryRe.exec(m[2])) !== null) {
        const qid = parseInt(e[2]);
        catalog[logIdx][qid] = e[1].replace(/_/g,' ').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());
        constToId[`${logIdx}:${e[1]}`] = qid;
      }
    }
  } catch(err) { console.warn('Quest catalog parse error:', err.message); }
  catalog._constToId = constToId;
  return catalog;
}
const QUEST_CATALOG = buildQuestCatalog();
const QUEST_CONST_TO_ID = QUEST_CATALOG._constToId;

// Subdirectory names matching QUEST_LOG_ENUM order
const QUEST_LOG_DIRS = ['sandoria','bastok','windurst','jeuno','otherAreas','outlands','ahtUrhgan','crystalWar','abyssea','adoulin','coalition'];

function _fmtConst(s){ return s.replace(/_/g,' ').toLowerCase().replace(/\b\w/g,c=>c.toUpperCase()); }

const FAME_AREA_NAMES = {
  0:'San d\'Oria',1:'Bastok',2:'Windurst',3:'Jeuno',4:'Selbina/Rabao',
  5:'Norg',6:'Abyssea-Konschtat',7:'Abyssea-Tahrongi',8:'Abyssea-La Theine',
  9:'Abyssea-Misareaux',10:'Abyssea-Vunkerl',11:'Abyssea-Attohwa',
  12:'Abyssea-Altepa',13:'Abyssea-Grauberg',14:'Abyssea-Uleguerand',15:'Adoulin'
};
const FAME_AREA_BY_NAME = Object.fromEntries(Object.entries(FAME_AREA_NAMES).map(([k,v])=>[
  Object.keys({SANDORIA:0,BASTOK:1,WINDURST:2,JEUNO:3,SELBINA_RABAO:4,NORG:5,
    ABYSSEA_KONSCHTAT:6,ABYSSEA_TAHRONGI:7,ABYSSEA_LATHEINE:8,ABYSSEA_MISAREAUX:9,
    ABYSSEA_VUNKERL:10,ABYSSEA_ATTOHWA:11,ABYSSEA_ALTEPA:12,ABYSSEA_GRAUBERG:13,
    ABYSSEA_ULEGUERAND:14,ADOULIN:15})[parseInt(k)], FAME_AREA_NAMES[k]
]));

// Job ID → name for requirement display
const JOB_NAMES_BY_CONST = {
  WAR:'WAR',MNK:'MNK',WHM:'WHM',BLM:'BLM',RDM:'RDM',THF:'THF',PLD:'PLD',DRK:'DRK',
  BST:'BST',BRD:'BRD',RNG:'RNG',SAM:'SAM',NIN:'NIN',DRG:'DRG',SMN:'SMN',BLU:'BLU',
  COR:'COR',PUP:'PUP',DNC:'DNC',SCH:'SCH',GEO:'GEO',RUN:'RUN'
};

function _parseRequirements(text) {
  const reqs = [];
  // Extract the QUEST_AVAILABLE check block (search wider window — 1200 chars after marker)
  const availIdx = text.indexOf('QUEST_AVAILABLE');
  const checkBlock = availIdx >= 0 ? text.slice(Math.max(0, availIdx - 300), availIdx + 1200) : text;

  // Fame requirement
  const fameRe = /getFameLevel\s*\(\s*xi\.fameArea\.(\w+)\s*\)\s*>=\s*(\d+)/g;
  let fm;
  while ((fm = fameRe.exec(checkBlock)) !== null) {
    const area = FAME_AREA_BY_NAME[fm[1]] || fm[1].replace(/_/g,' ');
    reqs.push({ type:'fame', area, level: parseInt(fm[2]) });
  }
  // Level requirement
  const lvlRe = /getMainLvl\s*\(\s*\)\s*>=\s*(\d+)/g;
  let lm;
  while ((lm = lvlRe.exec(checkBlock)) !== null) {
    reqs.push({ type:'level', min: parseInt(lm[1]) });
  }
  // Rank requirement
  const rankRe = /getRank\s*\([^)]*\)\s*>=\s*(\d+)/g;
  let rm;
  while ((rm = rankRe.exec(checkBlock)) !== null) {
    reqs.push({ type:'rank', min: parseInt(rm[1]) });
  }
  // Job requirement
  const jobRe = /getMainJob\s*\(\s*\)\s*==\s*xi\.job\.(\w+)/g;
  const jobsSeen = new Set();
  let jm;
  while ((jm = jobRe.exec(checkBlock)) !== null) {
    const j = JOB_NAMES_BY_CONST[jm[1]];
    if (j && !jobsSeen.has(j)) { jobsSeen.add(j); reqs.push({ type:'job', job: j }); }
  }
  // Key item required to start
  const kiAvailRe = /QUEST_AVAILABLE[^}]*?player:hasKeyItem\s*\(\s*xi\.(?:ki|keyItem)\.(\w+)\s*\)/gs;
  let km;
  const kiSeen = new Set();
  while ((km = kiAvailRe.exec(text)) !== null) {
    const ki = _fmtConst(km[1]);
    if (!kiSeen.has(ki)) { kiSeen.add(ki); reqs.push({ type:'keyItem', name: ki }); }
  }
  // Prerequisite quest
  const preRe = /hasCompletedQuest\s*\(\s*xi\.questLog\.(\w+)\s*,\s*xi\.quest\.id\.\w+\.(\w+)\s*\)/g;
  let pm;
  while ((pm = preRe.exec(checkBlock)) !== null) {
    reqs.push({ type:'quest', log: pm[1], name: _fmtConst(pm[2]) });
  }
  // hasCompletedMission
  const misRe = /hasCompletedMission\s*\(\s*xi\.mission\.log_id\.(\w+)\s*,\s*(\d+)\s*\)/g;
  let mm;
  while ((mm = misRe.exec(checkBlock)) !== null) {
    reqs.push({ type:'mission', log: mm[1], id: parseInt(mm[2]) });
  }
  // CharVar flags (e.g. getCharVar('AssaultPromotion') >= 25)
  const cvarRe = /getCharVar\s*\(\s*'([^']+)'\s*\)\s*(>=|==|<=|>|<|~=)\s*(\d+)/g;
  const cvarSeen = new Set();
  let cv;
  while ((cv = cvarRe.exec(checkBlock)) !== null) {
    const key = `${cv[1]}${cv[2]}${cv[3]}`;
    if (!cvarSeen.has(key)) { cvarSeen.add(key); reqs.push({ type:'charvar', name: cv[1], op: cv[2], value: parseInt(cv[3]) }); }
  }
  // Server setting flags (e.g. xi.settings.main.ENABLE_TOAU == 1)
  const settingRe = /xi\.settings\.main\.(\w+)\s*(==|~=|>=|>)\s*(\w+)/g;
  const settingSeen = new Set();
  let sv;
  while ((sv = settingRe.exec(checkBlock)) !== null) {
    const skey = sv[1];
    if (!settingSeen.has(skey)) {
      settingSeen.add(skey);
      const val = isNaN(sv[3]) ? sv[3] : parseInt(sv[3]);
      reqs.push({ type:'setting', name: sv[1], op: sv[2], value: val });
    }
  }
  return reqs;
}

// Parse quest-relevant settings from main.lua (override first, then default)
function _loadQuestSettings() {
  const keys = [
    'ENABLE_TRUST_QUESTS','ENABLE_TOAU','ENABLE_WOTG','ENABLE_COP','ENABLE_ABYSSEA',
    'ENABLE_SOA','ENABLE_ROV','ENABLE_TVR','ENABLE_MONSTROSITY','ENABLE_CHOCOBO_RAISING',
    'AF1_QUEST_LEVEL','AF2_QUEST_LEVEL','AF3_QUEST_LEVEL','ADVANCED_JOB_LEVEL','MAX_LEVEL',
    'OLDSCHOOL_G1','OLDSCHOOL_G2','ENABLE_MAGIAN_TRIALS',
  ];
  const result = {};
  const paths = ['/ffxi-settings/main.lua', '/ffxi-settings/default/main.lua'];
  for (const p of paths) {
    let txt = '';
    try { txt = fs.readFileSync(p, 'utf8'); } catch(e) { continue; }
    for (const k of keys) {
      if (result[k] !== undefined) continue;
      const m = txt.match(new RegExp(`\\b${k}\\s*=\\s*([^,\\n]+)`));
      if (m) {
        const raw = m[1].trim().replace(/--.*$/, '').trim();
        if (raw === 'true') result[k] = true;
        else if (raw === 'false') result[k] = false;
        else if (!isNaN(raw)) result[k] = Number(raw);
        else result[k] = raw;
      }
    }
  }
  return result;
}
const QUEST_SETTINGS = _loadQuestSettings();

function buildQuestRewards() {
  const rewards = {};
  QUEST_LOG_DIRS.forEach((dir, logId) => {
    rewards[logId] = {};
    const dirPath = `/ffxi-scripts/quests/${dir}`;
    let files;
    try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.lua')); }
    catch(e) { return; }
    files.forEach(file => {
      let text;
      try { text = fs.readFileSync(`${dirPath}/${file}`, 'utf8'); }
      catch(e) { return; }

      // Three ID formats: "Log ID: 0, Quest ID: 29", "!addquest 0 29", or Quest:new(xi.questLog.X, xi.quest.id.area.CONST)
      let questId = null;
      const m1 = text.match(/--\s*Log ID:\s*\d+,\s*Quest ID:\s*(\d+)/);
      if (m1) { questId = parseInt(m1[1]); }
      else {
        const m2 = text.match(/--\s*!addquest\s+\d+\s+(\d+)/);
        if (m2) questId = parseInt(m2[1]);
        else {
          const m3 = text.match(/Quest:new\s*\(\s*xi\.questLog\.(\w+)\s*,\s*xi\.quest\.id\.\w+\.(\w+)\s*\)/);
          if (m3) {
            const lid = QUEST_LOG_ENUM[m3[1]];
            if (lid === logId) questId = QUEST_CONST_TO_ID[`${logId}:${m3[2]}`] ?? null;
          }
        }
      }
      if (questId === null) return;

      // Parse NPC locations from header: "-- NpcName : !pos x y z zoneId"
      const npcs = [];
      const npcRe = /^--\s+(.+?)\s*:?\s*!pos\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)(?:\s+(\d+))?/gm;
      let nm;
      while ((nm = npcRe.exec(text)) !== null) {
        const name = nm[1].trim().replace(/\s+/g,' ');
        const x = parseFloat(nm[2]), y = parseFloat(nm[3]), z = parseFloat(nm[4]);
        const zoneId = nm[5] ? parseInt(nm[5]) : null;
        npcs.push({ name, x, y, z, zoneId });
      }

      const entry = npcs.length ? { npcs } : {};

      const rewardMatch = text.match(/quest\.reward\s*=\s*\{([^}]+)\}/s);
      if (rewardMatch) {
        const rt = rewardMatch[1];
        const g  = rt.match(/\bgil\s*=\s*(\d+)/);               if (g)  entry.gil      = parseInt(g[1]);
        const xp = rt.match(/\bexp\s*=\s*(\d+)/);               if (xp) entry.exp      = parseInt(xp[1]);
        const f  = rt.match(/\bfame\s*=\s*(\d+)/);              if (f)  entry.fame     = parseInt(f[1]);
        const fa = rt.match(/\bfameArea\s*=\s*xi\.fameArea\.(\w+)/); if (fa) entry.fameArea = FAME_AREA_BY_NAME[fa[1]] || fa[1].replace(/_/g,' ');
        const i  = rt.match(/\bitem\s*=\s*xi\.item\.(\w+)/);    if (i)  entry.item     = _fmtConst(i[1]);
        const t  = rt.match(/\btitle\s*=\s*xi\.title\.(\w+)/);  if (t)  entry.title    = _fmtConst(t[1]);
        const k  = rt.match(/\bkeyItem\s*=\s*xi\.ki\.(\w+)/);   if (k)  entry.keyItem  = _fmtConst(k[1]);
        const b  = rt.match(/\bbayld\s*=\s*(\d+)/);             if (b)  entry.bayld    = parseInt(b[1]);
      }

      // Trade items required (from quest body, not reward block)
      const tradeItems = [];
      const tradeSeen = new Set();
      const tradeRe = /tradeHas(?:Exactly)?\s*\(\s*trade\s*,\s*(?:\{\s*\{?\s*)?xi\.item\.(\w+)(?:\s*,\s*(\d+))?/g;
      let tr;
      while ((tr = tradeRe.exec(text)) !== null) {
        const name = _fmtConst(tr[1]);
        const qty = tr[2] ? parseInt(tr[2]) : 1;
        const key = `${name}×${qty}`;
        if (!tradeSeen.has(key)) { tradeSeen.add(key); tradeItems.push({ name, qty }); }
      }
      if (tradeItems.length) entry.tradeItems = tradeItems;

      const reqs = _parseRequirements(text);
      if (reqs.length) entry.reqs = reqs;

      if (Object.keys(entry).length) rewards[logId][questId] = entry;
    });
  });
  const total = Object.values(rewards).reduce((s,m)=>s+Object.keys(m).length,0);
  console.log(`[quests] ${total} quest entries loaded`);
  return rewards;
}
const QUEST_REWARDS = buildQuestRewards();

app.get('/api/character/:charid/quests', auth.requireAuth, async (req, res) => {
  try {
    const charid = parseInt(req.params.charid);
    if (req.user.tier !== 'admin' && !(await auth.userOwnsChar(pool, req.user.accid, charid)))
      return res.status(403).json({ error: 'not your character' });
    const [[row]] = await pool.execute('SELECT quests FROM chars WHERE charid = ?', [charid]);
    if (!row || !row.quests) return res.json([]);
    const blob = Buffer.isBuffer(row.quests) ? row.quests : Buffer.from(row.quests);
    const result = [];
    for (let logId = 0; logId < 11; logId++) {
      const base = logId * 64;
      const catalog = QUEST_CATALOG[logId];
      for (const [qidStr, name] of Object.entries(catalog)) {
        const questId = parseInt(qidStr);
        const byteIdx = questId >> 3;
        if (byteIdx >= 32) continue;
        const bit = 1 << (questId & 7);
        const isComplete = (blob[base + 32 + byteIdx] & bit) !== 0;
        const isActive   = (blob[base + byteIdx] & bit) !== 0;
        if (isComplete || isActive) {
          result.push({ logId, logName: QUEST_LOG_NAMES[logId], questId, name, status: isComplete ? 'complete' : 'active', reward: QUEST_REWARDS[logId]?.[questId] || null });
        }
      }
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Server Database search endpoints ─────────────────────────────────────────
const DB_PAGE = 50;

const ITEM_NUMERIC_COLS = { level:'ie.level', ilevel:'ie.ilevel', dmg:'iw.dmg', sell:'ib.BaseSell' };

app.get('/api/db/items', auth.requireAuth, async (req, res) => {
  try {
    const qRaw    = (req.query.q||'').trim();
    const sort    = req.query.sort||'';
    const numCol  = ITEM_NUMERIC_COLS[sort];
    const qNumVal = numCol && /^\d+$/.test(qRaw) ? parseInt(qRaw) : null;
    const typeBit = req.query.type ? parseInt(req.query.type) : null;
    const rareOnly = req.query.rare === '1';
    const flagMask = req.query.flagmask ? parseInt(req.query.flagmask) : null;
    const flagVal  = req.query.flagval  !== undefined ? parseInt(req.query.flagval||'0') : null;
    const skill = req.query.skill !== undefined && req.query.skill !== '' ? parseInt(req.query.skill) : null;
    const slotBit = req.query.slot ? parseInt(req.query.slot) : null;
    const page = Math.max(0, parseInt(req.query.page)||0);
    const sortMap = { level:'ie.level DESC, ib.itemid', ilevel:'ie.ilevel DESC, ib.itemid', sell:'ib.BaseSell DESC, ib.itemid', dmg:'iw.dmg DESC, ib.itemid', name:'ib.name ASC' };
    const orderBy = sortMap[sort] || 'ib.itemid';
    const params = [];
    const extra = [];
    if (qNumVal !== null) {
      extra.push(`AND ${numCol} >= ?`);
      params.push(qNumVal);
    } else {
      extra.push('AND CONVERT(ib.name USING utf8) LIKE ?');
      params.push(`%${qRaw}%`);
    }
    if (typeBit !== null) { extra.push('AND ib.type=?'); params.push(typeBit); }
    if (rareOnly) extra.push('AND (ib.flags & 0x8000) != 0');
    if (flagMask !== null && !isNaN(flagMask)) {
      extra.push(`AND (ib.flags & ?) = ?`);
      params.push(flagMask, isNaN(flagVal) ? flagMask : flagVal);
    }
    if (skill !== null && !isNaN(skill)) { extra.push('AND iw.skill=?'); params.push(skill); }
    if (slotBit !== null) { extra.push('AND (ie.slot & ?) != 0'); params.push(slotBit); }
    params.push(DB_PAGE, page * DB_PAGE);
    const [rows] = await pool.execute(
      `SELECT ib.itemid, CONVERT(ib.name USING utf8) AS name, ib.type, ib.flags, ib.stackSize, ib.BaseSell,
              ie.level, ie.ilevel, ie.slot, ie.jobs, iw.skill, iw.dmg, iw.dmgType, iw.delay
       FROM item_basic ib
       LEFT JOIN item_equipment ie ON ie.itemId=ib.itemid
       LEFT JOIN item_weapon iw ON iw.itemId=ib.itemid
       WHERE ib.name IS NOT NULL ${extra.join(' ')}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/db/items/wiki', auth.requireAuth, async (req, res) => {
  const rawName = (req.query.name||'').trim();
  if (!rawName) return res.json(null);
  const cacheKey = 'item:' + rawName.toLowerCase();
  const cached = WIKI_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < WIKI_CACHE_TTL) return res.json(cached);
  try {
    const slug = rawName.split('_')
      .map(w => w.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-'))
      .join('_');
    const url = `https://www.bg-wiki.com/ffxi/${encodeURIComponent(slug)}`;
    const resp = await fetch(url, { headers:{ 'User-Agent':'FFXI-Dashboard/1.0' }, signal: AbortSignal.timeout(7000) });
    if (!resp.ok) { WIKI_CACHE.set(cacheKey, null); return res.json(null); }
    const html = await resp.text();
    const strip = s => s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&#160;|&nbsp;/g,' ').replace(/&apos;|&#039;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
    const infoRows = {};
    const addRow = (rawKey, rawVal) => {
      const key = strip(rawKey).replace(/:$/, '').trim();
      const val = strip(rawVal).trim();
      if (key && val && !infoRows[key]) infoRows[key] = val;
    };
    // Layout A: <th>plain text key</th><td>value</td>  (Hi-Potion style)
    const thRe = /<th[^>]*>([^<]*)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
    let m;
    while ((m = thRe.exec(html)) !== null) addRow(m[1], m[2]);
    // Layout B: <td class="item-info-header">key</td><td class="item-info-body">value</td>  (Haubergeon style)
    const tdRe = /<td[^>]*item-info-header[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*item-info-body[^>]*>([\s\S]*?)<\/td>/g;
    while ((m = tdRe.exec(html)) !== null) addRow(m[1], m[2]);
    const ahRaw = infoRows['AH Listing'] || infoRows['AH  Listing'] || '';
    const ahM = ahRaw.match(/[➞→]\s*(.+)/);
    const cats = (html.match(/wgCategories.*?\[([^\]]+)\]/)||[])[1];
    const catList = cats ? (cats.match(/"([^"]+)"/g)||[]).map(s=>s.replace(/"/g,'')) : [];
    const result = {
      description:   infoRows['Description'] || null,
      flags:         infoRows['Flags'] || null,
      ahCategory:    ahM ? ahM[1].trim() : (ahRaw||null),
      itemType:      infoRows['Type'] || null,
      races:         infoRows['Races'] || null,
      validTargets:  infoRows['Valid Targets'] || null,
      categories:    catList,
      wikiUrl:       url,
      cachedAt:      Date.now(),
    };
    WIKI_CACHE.set(cacheKey, result);
    res.json(result);
  } catch(e) { res.json(null); }
});

app.get('/api/db/item-types', auth.requireAuth, async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT type, COUNT(*) AS cnt FROM item_basic WHERE name IS NOT NULL AND name != '' GROUP BY type ORDER BY type`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/db/items/:itemid', auth.requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.itemid);
    const [[basic]] = await pool.execute(
      `SELECT ib.itemid, CONVERT(ib.name USING utf8) AS name, ib.type, ib.stackSize, ib.BaseSell, ib.flags,
              ie.level, ie.ilevel, ie.slot, ie.rslot, ie.jobs, ie.shieldSize,
              iw.dmg, iw.delay, iw.skill, iw.dmgType,
              iu.maxCharges, iu.useDelay, iu.reuseDelay,
              iff.element AS furnElement, iff.storage AS furnStorage
       FROM item_basic ib
       LEFT JOIN item_equipment ie ON ie.itemId=ib.itemid
       LEFT JOIN item_weapon iw ON iw.itemId=ib.itemid
       LEFT JOIN item_usable iu ON iu.itemid=ib.itemid
       LEFT JOIN item_furnishing iff ON iff.itemid=ib.itemid
       WHERE ib.itemid=?`, [id]);
    if (!basic) return res.json(null);
    const [mods] = await pool.execute(
      `SELECT modId, value FROM item_mods WHERE itemId=? ORDER BY modId`, [id]);
    const [drops] = await pool.execute(
      `SELECT m.mobname AS name, z.name AS zone, dl.itemRate, dl.groupRate
       FROM mob_droplist dl
       JOIN mob_groups mg ON mg.dropid = dl.dropId
       JOIN mob_spawn_points m ON m.groupid = mg.groupid
       JOIN zone_settings z ON ((m.mobid>>12)&0xFFF) = z.zoneid
       WHERE dl.itemId=?
       GROUP BY m.mobname, ((m.mobid>>12)&0xFFF)
       ORDER BY dl.itemRate DESC LIMIT 20`, [id]);
    const [recipes] = await pool.execute(
      `SELECT sr.ID, sr.Wood, sr.Smith, sr.Gold, sr.Cloth, sr.Leather, sr.Bone, sr.Alchemy, sr.Cook,
              CONVERT(cr.name USING utf8) AS crystalName, sr.ResultQty,
              sr.Ingredient1, sr.Ingredient2, sr.Ingredient3, sr.Ingredient4,
              sr.Ingredient5, sr.Ingredient6, sr.Ingredient7, sr.Ingredient8,
              CONVERT(i1.name USING utf8) AS ing1, CONVERT(i2.name USING utf8) AS ing2,
              CONVERT(i3.name USING utf8) AS ing3, CONVERT(i4.name USING utf8) AS ing4
       FROM synth_recipes sr
       LEFT JOIN item_basic cr ON cr.itemid=sr.Crystal
       LEFT JOIN item_basic i1 ON i1.itemid=sr.Ingredient1
       LEFT JOIN item_basic i2 ON i2.itemid=sr.Ingredient2
       LEFT JOIN item_basic i3 ON i3.itemid=sr.Ingredient3
       LEFT JOIN item_basic i4 ON i4.itemid=sr.Ingredient4
       WHERE sr.Result=? OR sr.ResultHQ1=? OR sr.ResultHQ2=? OR sr.ResultHQ3=?
       LIMIT 5`, [id, id, id, id]);
    const [shops] = await pool.execute(
      `SELECT gs.guildid, gs.min_price, gs.max_price, gs.max_quantity
       FROM guild_shops gs WHERE gs.itemid=? LIMIT 5`, [id]);
    res.json({ ...basic, mods, drops, recipes, shops });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── In-memory catalogs (loaded at startup, refreshed every 5 min) ────────────
let MOB_CATALOG = [];   // [{name,zone,zoneid,min_lvl,max_lvl,spawns,family,ecosystem,aggro,links}]
let NPC_CATALOG = [];   // [{npcid,name,zone,zoneid,x,y,z}]
let ZONE_CACHE  = null; // full zones response, refreshed with player counts periodically

async function loadMobCatalog() {
  try {
    const [rows] = await pool.execute(`
      SELECT m.mobname AS name, z.name AS zone, ((m.mobid>>12)&0xFFF) AS zoneid,
             MIN(m.minLevel) AS min_lvl, MAX(m.maxLevel) AS max_lvl, COUNT(*) AS spawns,
             MIN(mss.family) AS family, MIN(mss.ecosystem) AS ecosystem,
             MIN(mp.aggro) AS aggro, MIN(mp.links) AS links
      FROM mob_spawn_points m
      JOIN zone_settings z ON ((m.mobid>>12)&0xFFF)=z.zoneid
      LEFT JOIN mob_groups mg ON m.groupid=mg.groupid AND ((m.mobid>>12)&0xFFF)=mg.zoneid
      LEFT JOIN mob_pools mp ON mg.poolid=mp.poolid
      LEFT JOIN mob_species_system mss ON mp.speciesid=mss.speciesID
      WHERE m.mobname IS NOT NULL
      GROUP BY m.mobname, ((m.mobid>>12)&0xFFF)
      ORDER BY m.mobname`);
    MOB_CATALOG = rows;
    console.log(`[catalog] ${MOB_CATALOG.length} mob entries loaded`);
  } catch(e) { console.error('[catalog] mob load error:', e.message); }
}

async function loadNpcCatalog() {
  try {
    const [rows] = await pool.execute(`
      SELECT n.npcid, CONVERT(n.name USING utf8) AS name, z.name AS zone, z.zoneid,
             ROUND(n.pos_x,2) AS x, ROUND(n.pos_y,2) AS y, ROUND(n.pos_z,2) AS z
      FROM npc_list n
      JOIN zone_settings z ON ((n.npcid>>12)&0xFFF)=z.zoneid
      WHERE n.name IS NOT NULL AND n.name NOT LIKE 'NPC[%'
      ORDER BY n.name`);
    NPC_CATALOG = rows;
    console.log(`[catalog] ${NPC_CATALOG.length} NPC entries loaded`);
  } catch(e) { console.error('[catalog] NPC load error:', e.message); }
}

async function loadZoneCache() {
  try {
    const [rows] = await pool.execute(`
      SELECT z.zoneid, z.name, z.zonetype, z.misc, z.zoneip, z.zoneport,
             COALESCE(pc.player_count,0) AS player_count,
             COALESCE(nc.npc_count,0) AS npc_count,
             COALESCE(mc.mob_count,0) AS mob_count
      FROM zone_settings z
      LEFT JOIN (
        SELECT c.pos_zone, COUNT(DISTINCT c.charid) AS player_count
        FROM chars c
        JOIN accounts_sessions ses ON c.charid=ses.charid
        GROUP BY c.pos_zone
      ) pc ON pc.pos_zone=z.zoneid
      LEFT JOIN (SELECT ((npcid>>12)&0xFFF) AS zoneid, COUNT(DISTINCT npcid) AS npc_count
                 FROM npc_list WHERE name IS NOT NULL AND name NOT LIKE 'NPC[%'
                 GROUP BY ((npcid>>12)&0xFFF)) nc ON nc.zoneid=z.zoneid
      LEFT JOIN (SELECT ((mobid>>12)&0xFFF) AS zoneid, COUNT(DISTINCT mobid) AS mob_count
                 FROM mob_spawn_points GROUP BY ((mobid>>12)&0xFFF)) mc ON mc.zoneid=z.zoneid
      GROUP BY z.zoneid, z.name, z.zonetype, z.misc, z.zoneip, z.zoneport
      ORDER BY z.name`);
    ZONE_CACHE = rows;
  } catch(e) { console.error('[catalog] zone cache error:', e.message); }
}

// Catalog helpers
function _mobRegionMatch(z, region) {
  if (!region) return true;
  const NR = NPC_REGION_SQL[region];
  if (!NR) return true;
  // reuse zone name patterns
  if (region === 'san_doria')  return /san_doria|oraguille/i.test(z);
  if (region === 'bastok')     return /bastok/i.test(z);
  if (region === 'windurst')   return /windurst|heavens_tower/i.test(z);
  if (region === 'jeuno')      return /jeuno/i.test(z);
  if (region === 'aht_urhgan') return /aht_urhgan|al_zahbi|arrapago|alzadaal|bhaflau|caedarva|aydeewa/i.test(z);
  if (region === 'adoulin')    return /adoulin|ceizak|foret|leafallia|kamihr|cirdas/i.test(z);
  return true;
}

const NPC_REGION_SQL = {
  "san_doria":  `(z.name LIKE '%San_dOria%' OR z.name LIKE '%Oraguille%')`,
  "bastok":     `z.name LIKE '%Bastok%'`,
  "windurst":   `(z.name LIKE '%Windurst%' OR z.name='Heavens_Tower')`,
  "jeuno":      `z.name LIKE '%Jeuno%'`,
  "aht_urhgan": `(z.name LIKE 'Aht_Urhgan%' OR z.name LIKE '%Al_Zahbi%' OR z.name LIKE '%Arrapago%' OR z.name LIKE 'Alzadaal%' OR z.name LIKE '%Bhaflau%' OR z.name LIKE 'Caedarva%' OR z.name LIKE 'Aydeewa%')`,
  "adoulin":    `(z.name LIKE '%Adoulin%' OR z.name LIKE 'Ceizak%' OR z.name LIKE 'Foret%' OR z.name='Leafallia' OR z.name LIKE '%Kamihr%' OR z.name LIKE 'Cirdas%')`,
};
const NPC_SORT_SQL = { name:'n.name ASC', zone:'z.name ASC, n.name ASC' };

app.get('/api/db/npcs', auth.requireAuth, (req, res) => {
  const q   = (req.query.q||'').trim().toLowerCase();
  const zone = (req.query.zone||'').trim().toLowerCase();
  const region = req.query.region || null;
  const sort = req.query.sort || '';
  const page = Math.max(0, parseInt(req.query.page)||0);
  let rows = NPC_CATALOG;
  if (q)      rows = rows.filter(r => r.name.toLowerCase().includes(q));
  if (zone)   rows = rows.filter(r => r.zone && r.zone.toLowerCase().includes(zone));
  if (region) rows = rows.filter(r => _mobRegionMatch(r.zone||'', region));
  if (sort === 'zone') rows = [...rows].sort((a,b) => (a.zone||'').localeCompare(b.zone||'')||a.name.localeCompare(b.name));
  else if (sort === 'name') rows = [...rows].sort((a,b) => a.name.localeCompare(b.name));
  // default order is already by name from preload
  const total = rows.length;
  res.json(rows.slice(page * DB_PAGE, page * DB_PAGE + DB_PAGE).map(r => ({...r, _total: undefined})));
});

app.get('/api/db/mobs', auth.requireAuth, (req, res) => {
  const q         = (req.query.q||'').trim().toLowerCase();
  const zone      = (req.query.zone||'').trim().toLowerCase();
  const region    = req.query.region || null;
  const ecosystem = req.query.ecosystem || null;
  const sort      = req.query.sort || '';
  const page      = Math.max(0, parseInt(req.query.page)||0);
  let rows = MOB_CATALOG;
  if (q)         rows = rows.filter(r => r.name.toLowerCase().includes(q));
  if (zone)      rows = rows.filter(r => r.zone && r.zone.toLowerCase().includes(zone));
  if (region)    rows = rows.filter(r => _mobRegionMatch(r.zone||'', region));
  if (ecosystem) rows = rows.filter(r => r.ecosystem === ecosystem);
  if (sort === 'zone')    rows = [...rows].sort((a,b) => (a.zone||'').localeCompare(b.zone||'')||a.name.localeCompare(b.name));
  else if (sort === 'level')  rows = [...rows].sort((a,b) => (b.max_lvl||0)-(a.max_lvl||0)||a.name.localeCompare(b.name));
  else if (sort === 'spawns') rows = [...rows].sort((a,b) => (b.spawns||0)-(a.spawns||0)||a.name.localeCompare(b.name));
  else if (sort === 'family') rows = [...rows].sort((a,b) => (a.family||'').localeCompare(b.family||'')||a.name.localeCompare(b.name));
  // default: by name (preload order)
  res.json(rows.slice(page * DB_PAGE, page * DB_PAGE + DB_PAGE));
});

app.get('/api/db/mobs/detail', auth.requireAuth, async (req, res) => {
  try {
    const name = (req.query.name||'').trim();
    const zoneid = parseInt(req.query.zone)||0;
    if (!name) return res.json({});
    const [[info]] = await pool.execute(
      `SELECT MIN(mss.family) AS family, MIN(mss.ecosystem) AS ecosystem,
              MIN(mss.detects) AS detects, MIN(mss.charmable) AS charmable,
              MIN(mss.Element) AS element,
              MIN(mp.aggro) AS aggro, MIN(mp.links) AS links, MIN(mp.mJob) AS mjob,
              MIN(mp.resist_id) AS resist_id, MIN(mg.dropid) AS dropid
       FROM mob_spawn_points m
       LEFT JOIN mob_groups mg ON m.groupid=mg.groupid AND ((m.mobid>>12)&0xFFF)=mg.zoneid
       LEFT JOIN mob_pools mp ON mg.poolid=mp.poolid
       LEFT JOIN mob_species_system mss ON mp.speciesid=mss.speciesID
       WHERE m.mobname=? AND ((m.mobid>>12)&0xFFF)=?`, [name, zoneid]);
    const result = { ...info };
    // Drops
    if (info && info.dropid) {
      const [drops] = await pool.execute(
        `SELECT CONVERT(ib.name USING utf8) AS item, ib.itemid,
                md.itemRate, md.groupRate, md.groupId, md.dropType
         FROM mob_droplist md
         JOIN item_basic ib ON md.itemId=ib.itemid
         WHERE md.dropId=? ORDER BY md.groupId, md.itemRate DESC`, [info.dropid]);
      result.drops = drops;
    }
    // Elemental resistances
    if (info && info.resist_id) {
      const [[res]] = await pool.execute(
        `SELECT fire_sdt, ice_sdt, wind_sdt, earth_sdt, lightning_sdt,
                water_sdt, light_sdt, dark_sdt, slash_sdt, pierce_sdt, h2h_sdt, impact_sdt
         FROM mob_resistances WHERE resist_id=?`, [info.resist_id]);
      result.resistances = res;
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/db/npcs/wiki', auth.requireAuth, async (req, res) => {
  try {
    const rawName = (req.query.name||'').trim();
    if (!rawName) return res.json({});
    const cacheKey = 'npc:' + rawName.toLowerCase();
    const cached = WIKI_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < WIKI_CACHE_TTL) return res.json(cached);
    const wikiName = rawName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('_');
    const wikiUrl = `https://www.bg-wiki.com/ffxi/${encodeURIComponent(wikiName)}`;
    const resp = await fetch(wikiUrl, { headers:{ 'User-Agent':'FFXIDashboard/1.0' }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return res.json({ wikiUrl, notFound: true });
    const html = await resp.text();
    // Extract description (first paragraph in mw-parser-output)
    const descM = html.match(/<div[^>]*class="mw-parser-output"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/);
    const stripTags = s => s.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
    const description = descM ? stripTags(descM[1]) : null;
    // Extract "Involved In" quests list
    const invM = html.match(/Involved In[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
    const quests = [];
    if (invM) {
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
      let m;
      while ((m = liRe.exec(invM[1])) !== null) quests.push(stripTags(m[1]));
    }
    const out = { description, quests, wikiUrl, cachedAt: Date.now() };
    WIKI_CACHE.set(cacheKey, out);
    res.json(out);
  } catch(e) { res.json({ error: e.message }); }
});

// In-process wiki cache: questKey → {description, repeatable, type, prevQuest, nextQuest, cachedAt}
const WIKI_CACHE = new Map();
const WIKI_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

const JOBS_LIST = ['war','mnk','whm','blm','rdm','thf','pld','drk','bst','brd','rng','sam','nin','drg','smn','blu','cor','pup','dnc','sch','geo','run'];

app.get('/api/db/jobs', auth.requireAuth, async (_req, res) => {
  try {
    const sel = JOBS_LIST.map(j => `cj.${j}`).join(', ');
    const [rows] = await pool.execute(`SELECT ${sel} FROM chars c JOIN char_jobs cj ON cj.charid = c.charid`);
    const stats = JOBS_LIST.map(job => {
      const leveled = rows.filter(r => r[job] > 1);
      return { job, max: leveled.length ? Math.max(...leveled.map(r => r[job])) : 0, count: leveled.length };
    });
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/db/trusts', auth.requireAuth, async (req, res) => {
  try {
    const q = ((req.query.q) || '').toLowerCase().trim();
    const [rows] = await pool.execute(
      `SELECT itemid, name FROM item_basic WHERE name LIKE 'cipher_of_%_alter_ego%' ORDER BY name`
    );
    const trusts = rows.map(r => {
      const isII = r.name.endsWith('_alter_ego_ii');
      const label = r.name
        .replace(/^cipher_of_/, '')
        .replace(/_alter_ego_ii$/, '')
        .replace(/_alter_ego.*$/, '')
        .replace(/\._/g, '. ')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase())
        + (isII ? ' II' : '');
      return { itemid: r.itemid, name: r.name, label };
    }).filter(r => !q || r.label.toLowerCase().includes(q));
    res.json(trusts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/db/abilities', auth.requireAuth, async (req, res) => {
  try {
    const q = `%${((req.query.q) || '').trim()}%`;
    const job = req.query.job !== undefined ? parseInt(req.query.job) : null;
    const page = Math.max(0, parseInt(req.query.page || '0'));
    const params = [q];
    let where = "WHERE a.name IS NOT NULL AND a.name != '' AND a.name LIKE ?";
    if (job !== null && !isNaN(job)) { where += ' AND a.job = ?'; params.push(job); }
    params.push(DB_PAGE, page * DB_PAGE);
    const [rows] = await pool.execute(
      `SELECT a.abilityId, a.name, a.job, a.level, a.recastTime, a.castTime, a.actionType, a.range, a.isAOE
       FROM abilities a ${where} ORDER BY a.job, a.level, a.abilityId LIMIT ? OFFSET ?`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/db/mounts', auth.requireAuth, async (req, res) => {
  try {
    const q = ((req.query.q) || '').toLowerCase().trim();
    const [rows] = await pool.execute(
      `SELECT itemid, name FROM item_basic WHERE name LIKE '♪%' ORDER BY itemid`
    );
    const mounts = rows.map(r => ({
      itemid: r.itemid,
      name: r.name,
      label: r.name.replace(/^♪/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    })).filter(r => !q || r.label.toLowerCase().includes(q));
    res.json(mounts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/db/keyitems', auth.requireAuth, (req, res) => {
  const q = ((req.query.q) || '').toLowerCase().trim();
  const page = Math.max(0, parseInt(req.query.page) || 0);
  const entries = Object.entries(KEY_ITEM_NAMES)
    .filter(([, name]) => !q || name.toLowerCase().includes(q))
    .sort(([a], [b]) => Number(a) - Number(b))
    .slice(page * DB_PAGE, (page + 1) * DB_PAGE)
    .map(([id, name]) => ({ id: Number(id), name }));
  res.json(entries);
});

app.get('/api/db/skills', auth.requireAuth, async (req, res) => {
  try {
    const q = ((req.query.q) || '').toLowerCase().trim();
    const [rows] = await pool.execute(
      `SELECT sr.skillid, sr.name,
         sr.war, sr.mnk, sr.whm, sr.blm, sr.rdm, sr.thf, sr.pld, sr.drk,
         sr.bst, sr.brd, sr.rng, sr.sam, sr.nin, sr.drg, sr.smn, sr.blu,
         sr.cor, sr.pup, sr.dnc, sr.sch, sr.geo, sr.run,
         sc.r0, sc.r1, sc.r2, sc.r3, sc.r4, sc.r5, sc.r6,
         sc.r7, sc.r8, sc.r9, sc.r10, sc.r11, sc.r12, sc.r13
       FROM skill_ranks sr
       JOIN skill_caps sc ON sc.level = 99
       WHERE sr.name IS NOT NULL AND sr.name != ''
       ORDER BY sr.skillid`
    );
    const ranks = q ? rows.filter(r => r.name.toLowerCase().includes(q)) : rows;
    res.json(ranks);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/quest-settings', auth.requireAuth, (_req, res) => {
  res.json(QUEST_SETTINGS);
});

app.get('/api/character/:charid/vars', auth.requireAuth, async (req, res) => {
  try {
    const charid = parseInt(req.params.charid);
    if (req.user.tier !== 'admin' && !(await auth.userOwnsChar(pool, req.user.accid, charid)))
      return res.status(403).json({ error: 'not your character' });
    const [rows] = await pool.execute(
      `SELECT varname, value FROM char_vars WHERE charid=? ORDER BY varname`, [charid]);
    const vars = {};
    for (const r of rows) vars[r.varname] = r.value;
    res.json(vars);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/character/:charid/setvar', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const charid = parseInt(req.params.charid);
    const { varname, value } = req.body || {};
    if (!varname) return res.status(400).json({ error: 'varname required' });
    if (value === null || value === undefined || value === '') {
      await pool.execute('DELETE FROM char_vars WHERE charid=? AND varname=?', [charid, varname]);
    } else {
      await pool.execute(
        'INSERT INTO char_vars (charid,varname,value) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value=?',
        [charid, varname, parseInt(value), parseInt(value)]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/questscript', auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const name = (req.query.name || '').trim();
    if (!name) return res.json({ found: false });
    const normalize = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const target = normalize(name);
    const questsRoot = path.join(SERVER_SCRIPTS_ROOT, 'quests');
    if (!fs.existsSync(questsRoot)) return res.json({ found: false, reason: 'scripts not mounted' });
    let found = null;
    for (const dir of fs.readdirSync(questsRoot)) {
      const dirPath = path.join(questsRoot, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith('.lua'))) {
        const fn = normalize(file.replace(/\.lua$/, ''));
        if (fn === target || fn.includes(target) || target.includes(fn)) {
          found = path.join('quests', dir, file);
          break;
        }
      }
      if (found) break;
    }
    if (!found) return res.json({ found: false });
    const content = fs.readFileSync(path.join(SERVER_SCRIPTS_ROOT, found), 'utf8');
    const vars = new Set();
    const pat = /[gs]etCharVar\s*\([^,)]+,\s*"([^"]+)"/gi;
    let m;
    while ((m = pat.exec(content)) !== null) vars.add(m[1]);
    res.json({ found: true, path: found, content, vars: [...vars].sort() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/db/quests/wiki', auth.requireAuth, async (req, res) => {
  const questName = (req.query.name||'').trim();
  if (!questName) return res.json(null);
  const cacheKey = questName.toLowerCase();
  const cached = WIKI_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < WIKI_CACHE_TTL) return res.json(cached);
  try {
    const slug = questName.replace(/ /g,'_').replace(/'/g,'%27');
    const url = `https://www.bg-wiki.com/ffxi/${slug}`;
    const resp = await fetch(url, { headers:{ 'User-Agent':'FFXI-Dashboard/1.0' }, signal: AbortSignal.timeout(6000) });
    if (!resp.ok) return res.json(null);
    const html = await resp.text();
    const strip = s => s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&#160;|&nbsp;/g,' ').replace(/&apos;|&#039;/g,"'").replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
    // BG-Wiki quest pages use <td>Label</td><td>Value</td> pairs (not <th>)
    const infoRows = {};
    const QUEST_KEYS = new Set(['Description','Starting NPC','Start NPC','Required Fame','Level Restriction','Level Restriction:','Repeatable','Rewards','Reward','Previous Quest','Next Quest','Pack','Title','Notes']);
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
    let m;
    while ((m = tdRe.exec(html)) !== null) {
      const key = strip(m[1]).replace(/:$/, '').trim();
      const val = strip(m[2]).trim();
      if (QUEST_KEYS.has(key) && val && !infoRows[key]) infoRows[key] = val;
    }
    // Categories
    const catM = html.match(/wgCategories.*?\[([^\]]+)\]/);
    const cats = catM ? (catM[1].match(/"([^"]+)"/g)||[]).map(s=>s.replace(/"/g,'')) : [];
    const repeatableRaw = infoRows['Repeatable'] || null;
    const repeatable = cats.includes('Repeatable Quests') || /yes/i.test(repeatableRaw||'');
    const areaFilter = ["San d'Oria","Bastok","Windurst","Jeuno","Outlands","Aht Urhgan","Crystal","Abyssea","Adoulin","Coalition","Southern","Northern","Eastern","Western","Port","Lower","Upper","Other"];
    const typeQuests = cats.filter(c=>c.endsWith('Quests')&&c!=='Quests'&&!c.includes('Repeatable')&&!areaFilter.some(a=>c.includes(a)));
    const questType = typeQuests[0] || null;
    const startNpc = infoRows['Starting NPC'] || infoRows['Start NPC'] || null;
    // Level requirement: "Level Restriction" row has e.g. "Level 40+ Warrior"
    const lvRaw = infoRows['Level Restriction'] || infoRows['Level Restriction:'] || '';
    const lvM = lvRaw.match(/(\d+)/);
    const levelReq = lvM ? parseInt(lvM[1]) : null;
    const wikiReward = infoRows['Reward'] || infoRows['Rewards'] || null;
    const prevQuest = infoRows['Previous Quest'] || null;
    const nextQuest = infoRows['Next Quest'] || null;
    const description = infoRows['Description'] || null;
    const result = { description, repeatable, repeatableRaw, questType, startNpc, levelReq, wikiReward, prevQuest, nextQuest, wikiUrl: url, cachedAt: Date.now() };
    WIKI_CACHE.set(cacheKey, result);
    res.json(result);
  } catch(e) { res.json(null); }
});

app.get('/api/db/quest-logs', auth.requireAuth, (_req, res) => {
  const counts = [];
  for (let i = 0; i < 11; i++) {
    const total = Object.keys(QUEST_CATALOG[i] || {}).length;
    const scripted = Object.keys(QUEST_REWARDS[i] || {}).length;
    counts.push({ logId: i, name: QUEST_LOG_NAMES[i], total, scripted });
  }
  res.json(counts);
});

app.get('/api/db/quests', auth.requireAuth, async (req, res) => {
  try {
    const q = (req.query.q||'').trim().toLowerCase();
    const log = req.query.log !== undefined ? parseInt(req.query.log) : null;
    const result = [];
    for (let logId = 0; logId < 11; logId++) {
      if (log !== null && logId !== log) continue;
      for (const [qidStr, name] of Object.entries(QUEST_CATALOG[logId])) {
        if (q && !name.toLowerCase().includes(q)) continue;
        const questId = parseInt(qidStr);
        result.push({ logId, logName: QUEST_LOG_NAMES[logId], questId, name,
                      reward: QUEST_REWARDS[logId]?.[questId] || null });
      }
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Status Effects ────────────────────────────────────────────────────────────
function prettyEffectName(key) {
  return key.split('_').map(w => {
    if (/^(I{1,3}|IV|VI{0,3}|IX|XI{0,3}|XII)$/.test(w)) return w;
    if (w.length <= 2 && /^[A-Z]+$/.test(w)) return w; // KO, HP, MP, TP, HP, GEO...
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function buildEffectNames() {
  const names = {};
  try {
    const text = fs.readFileSync('/ffxi-scripts/effect.lua', 'utf8');
    const re = /^\s+(\w+)\s*=\s*(\d+)/gm;
    let m;
    while ((m = re.exec(text)) !== null) {
      const id = parseInt(m[2]);
      if (!isNaN(id)) names[id] = prettyEffectName(m[1]);
    }
  } catch(err) { console.warn('Effect names parse error:', err.message); }
  return names;
}
const EFFECT_NAMES = buildEffectNames();

// ── Merit names ───────────────────────────────────────────────────────────────
function buildMeritNames() {
  const names = {};
  try {
    const text = fs.readFileSync('/ffxi-scripts/merit.lua', 'utf8');
    const cats = {};
    const catMatch = text.match(/local meritCategory\s*=\s*\{([\s\S]*?)\}/);
    if (catMatch) {
      const re = /(\w+)\s*=\s*(0x[0-9A-Fa-f]+)/g; let m;
      while ((m = re.exec(catMatch[1])) !== null) cats[m[1]] = parseInt(m[2], 16);
    }
    const re = /(\w+)\s*=\s*meritCategory\.(\w+)\s*\+\s*(0x[0-9A-Fa-f]+)/g; let m;
    while ((m = re.exec(text)) !== null) {
      const cat = cats[m[2]];
      if (cat !== undefined) {
        const id = cat + parseInt(m[3], 16);
        names[id] = m[1].split('_').map(w =>
          /^(HP|MP|TP|H2H|WS|STR|DEX|VIT|AGI|INT|MND|CHR)$/.test(w) ? w :
          w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        ).join(' ');
      }
    }
  } catch(err) { console.warn('Merit names parse error:', err.message); }
  return names;
}
const MERIT_NAMES = buildMeritNames();

const SPELL_GROUPS = {1:'Song',2:'Black Magic',3:'Blue Magic',4:'Ninjutsu',5:'Summon Magic',6:'White Magic',7:'Geomancy',8:'Trust'};

// Generic Lua enum parser: NAME = NUMBER
function buildLuaEnum(filepath) {
  const names = {};
  try {
    const text = fs.readFileSync(filepath, 'utf8');
    const re = /^\s{4}(\w+)\s*=\s*(\d+)/gm;
    let m;
    while ((m = re.exec(text)) !== null) names[parseInt(m[2])] = m[1];
  } catch(e) { console.warn(`[enum] ${filepath}:`, e.message); }
  return names;
}

const KEY_ITEM_NAMES = buildLuaEnum('/ffxi-scripts/key_item.lua');
const TITLE_NAMES    = buildLuaEnum('/ffxi-scripts/title.lua');
console.log(`[enum] ${Object.keys(KEY_ITEM_NAMES).length} key items, ${Object.keys(TITLE_NAMES).length} titles`);

// RoE records from roe_records.lua: [ID] = { -- Name\n  flags = set{'daily',...}, goal = N }
function buildRoeRecords() {
  const names = {};
  const records = {};
  try {
    const text = fs.readFileSync('/ffxi-scripts/roe_records.lua', 'utf8');
    // Find each record block: [ID] = {\n...until next [N] = { or end of table
    const blockRe = /\[(\d+)\]\s*=\s*\{([^[]*?)(?=\[\d+\]\s*=\s*\{|\s*\}$)/gs;
    let m;
    while ((m = blockRe.exec(text)) !== null) {
      const id = parseInt(m[1]);
      const body = m[2];
      const nameMatch = /--\s*(.+)/.exec(body);
      const name = nameMatch ? nameMatch[1].trim() : null;
      if (!name) continue;
      names[id] = name;
      const flagsMatch = /flags\s*=\s*set\s*\{([^}]*)\}/i.exec(body);
      const flags = flagsMatch ? flagsMatch[1].match(/'(\w+)'/g)?.map(s=>s.replace(/'/g,'')) || [] : [];
      const goalMatch = /goal\s*=\s*(\d+)/.exec(body);
      const goal = goalMatch ? parseInt(goalMatch[1]) : null;
      records[id] = { id, name, flags, goal };
    }
  } catch(e) { console.warn('[enum] roe_records.lua:', e.message); }
  return { names, records };
}
const { names: ROE_NAMES, records: ROE_RECORDS } = buildRoeRecords();
console.log(`[enum] ${Object.keys(ROE_NAMES).length} RoE records`);

// Searchable RoE record list for the timer tracker
app.get('/api/roe/records', auth.requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const type = req.query.type || 'all'; // daily | weekly | timed | all
  let list = Object.values(ROE_RECORDS);
  if (type !== 'all') list = list.filter(r => r.flags.includes(type));
  if (q) list = list.filter(r => r.name.toLowerCase().includes(q));
  res.json(list.slice(0, 100));
});

// Mission log_id constants (matches xi.mission.log_id in missions.lua)
const MISSION_LOG_LABELS = [
  "San d'Oria", 'Bastok', 'Windurst', 'Rise of the Zilart', 'ToAU',
  'Wings of the Goddess', 'Chains of Promathia', 'Assault', 'Campaign',
  'A Crystalline Prophecy', "A Moogle Kupo d'Etat",
  'A Shantotto Ascension', 'Seekers of Adoulin',
  "Return to Vana'diel", 'The Voracious Resurgence',
];
const _MISSION_KEY_TO_LOG = {
  SANDORIA:0,BASTOK:1,WINDURST:2,ZILART:3,TOAU:4,WOTG:5,COP:6,
  ASSAULT:7,CAMPAIGN:8,ACP:9,AMK:10,ASA:11,SOA:12,ROV:13,TVR:14,
};

function buildMissionNames() {
  const result = {};
  try {
    const text = fs.readFileSync('/ffxi-scripts/missions.lua', 'utf8');
    const sectionRe = /\[xi\.mission\.area\[xi\.mission\.log_id\.(\w+)\]\]\s*=\s*\{([^}]+)\}/gs;
    let sec;
    while ((sec = sectionRe.exec(text)) !== null) {
      const logId = _MISSION_KEY_TO_LOG[sec[1]];
      if (logId === undefined) continue;
      const nameMap = {};
      const re = /^\s{8}(\w+)\s*=\s*(\d+)/gm;
      let m;
      while ((m = re.exec(sec[2])) !== null) nameMap[parseInt(m[2])] = m[1];
      result[logId] = nameMap;
    }
  } catch(e) { console.warn('[enum] missions.lua:', e.message); }
  return result;
}
const MISSION_NAMES = buildMissionNames();
console.log(`[enum] ${Object.values(MISSION_NAMES).reduce((s,v)=>s+Object.keys(v).length,0)} mission entries across ${Object.keys(MISSION_NAMES).length} logs`);

// Decode missions blob: 15 areas × 70 bytes { uint16 current; uint16 su; uint16 sl; bool complete[64] }
function decodeMissions(buf) {
  if (!buf || buf.length < 15 * 70) return [];
  const out = [];
  for (let log = 0; log < 15; log++) {
    const off = log * 70;
    const current = buf.readUInt16LE(off);
    const names   = MISSION_NAMES[log] || {};
    const completed = [];
    for (let j = 0; j < 64; j++) {
      if (buf[off + 6 + j] !== 0) completed.push({ id: j, name: fmtMission(names[j]) });
    }
    if (current === 0 && completed.length === 0) continue;
    const curId   = current === 0xFFFF ? null : current;
    const curName = curId !== null ? fmtMission(names[curId]) : null;
    out.push({ log, label: MISSION_LOG_LABELS[log], current: curId, currentName: curName, completed });
  }
  return out;
}

// Decode assault blob: { uint16 current; bool complete[128]; } = 130 bytes
function decodeAssault(buf) {
  if (!buf || buf.length < 130) return null;
  const names = MISSION_NAMES[7] || {};
  const current = buf.readUInt16LE(0) || null;
  const completed = [];
  for (let j = 0; j < 128; j++) if (buf[2 + j] !== 0) completed.push({ id: j, name: fmtMission(names[j]) });
  return { current, currentName: current !== null ? fmtMission(names[current]) : null, completed };
}

// Decode campaign blob: { uint16 current; bool complete[512]; } = 514 bytes
function decodeCampaign(buf) {
  if (!buf || buf.length < 514) return null;
  const current = buf.readUInt16LE(0) || null;
  let count = 0;
  for (let j = 0; j < 512; j++) if (buf[2 + j] !== 0) count++;
  return { current, completedCount: count };
}

function fmtMission(n) {
  return n ? n.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : null;
}

// Decode a standard flat bitfield blob: bit N set → ID N (skip 0)
function decodeBitfield(buf, nameMap) {
  if (!buf) return [];
  const out = [];
  for (let n = 1; n < buf.length * 8; n++) {
    if (buf[n >> 3] & (1 << (n % 8))) out.push({ id: n, name: nameMap[n] || null });
  }
  return out;
}

// keyitems blob: 8 tables × (64-byte keyList + 64-byte seenList)
// keyItemId → table = floor(id/512), index = id%512
function decodeKeyItems(buf, nameMap) {
  if (!buf) return [];
  const out = [];
  for (let table = 0; table < 8; table++) {
    const base = table * 128; // keyList starts at base, seenList at base+64
    for (let i = 0; i < 512; i++) {
      if (buf[base + (i >> 3)] & (1 << (i % 8))) {
        const id = table * 512 + i;
        if (id > 0) out.push({ id, name: nameMap[id] || null });
      }
    }
  }
  return out;
}

// eminence blob: uint16 active[31](62B) + 2B pad + uint32 progress[31](124B) + uint8 complete[512](512B)
// complete starts at offset 188; each bit = one record ID
function decodeEminence(buf, nameMap) {
  if (!buf || buf.length < 700) return { completed: [], active: [] };
  const COMPLETE_OFFSET = 188;
  const completed = [];
  for (let n = 0; n < 4096; n++) {
    if (buf[COMPLETE_OFFSET + (n >> 3)] & (1 << (n % 8))) {
      completed.push({ id: n, name: nameMap[n] || null });
    }
  }
  const active = [];
  for (let slot = 0; slot < 31; slot++) {
    const id = buf.readUInt16LE(slot * 2);
    if (id > 0) {
      const progressOffset = 64 + slot * 4;
      const progress = buf.readUInt32LE(progressOffset);
      active.push({ id, name: nameMap[id] || null, progress });
    }
  }
  return { completed, active };
}

const DEBUFF_IDS = new Set([
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,28,29,30,31,
  128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,
  156,159,167,168,174,175,189,260,261,262,263,264,299,
]);

app.get('/api/character/:charid/effects', auth.requireAuth, async (req, res) => {
  try {
    const charid = parseInt(req.params.charid);
    if (req.user.tier !== 'admin' && !(await auth.userOwnsChar(pool, req.user.accid, charid)))
      return res.status(403).json({ error: 'not your character' });
    const [rows] = await pool.execute(
      'SELECT effectid, power, tick, duration, timestamp FROM char_effects WHERE charid = ? ORDER BY effectid',
      [charid]
    );
    const now = Math.floor(Date.now() / 1000);
    const result = rows.map(r => ({
      id: r.effectid,
      name: EFFECT_NAMES[r.effectid] || `Effect ${r.effectid}`,
      power: r.power,
      tick: r.tick,
      remaining: r.duration > 0 ? Math.max(0, r.timestamp + r.duration - now) : -1,
      isDebuff: DEBUFF_IDS.has(r.effectid),
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Equipment ─────────────────────────────────────────────────────────────────
app.get('/api/character/:charid/equipment', auth.requireAuth, async (req, res) => {
  try {
    const charid = parseInt(req.params.charid);
    if (req.user.tier !== 'admin' && !(await auth.userOwnsChar(pool, req.user.accid, charid)))
      return res.status(403).json({ error: 'not your character' });
    const [rows] = await pool.execute(`
      SELECT ce.equipslotid AS slot, ci.itemId,
             CONVERT(ib.name USING utf8) AS name
      FROM char_equip ce
      JOIN char_inventory ci
        ON ce.charid=ci.charid AND ce.containerid=ci.location AND ce.slotid=ci.slot
      LEFT JOIN item_basic ib ON ci.itemId=ib.itemid
      WHERE ce.charid=?
      ORDER BY ce.equipslotid
    `, [charid]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/character/:charid/blobs', auth.requireAuth, async (req, res) => {
  try {
    const charid = parseInt(req.params.charid);
    if (req.user.tier !== 'admin' && !(await auth.userOwnsChar(pool, req.user.accid, charid)))
      return res.status(403).json({ error: 'not your character' });

    const [[row]] = await pool.execute(
      'SELECT keyitems, titles, zones, eminence, missions, assault, campaign FROM chars WHERE charid=?', [charid]
    );
    if (!row) return res.status(404).json({ error: 'character not found' });

    // Fetch zone names for zones-visited decode
    const [zoneRows] = await pool.execute('SELECT zoneid, name FROM zone_settings');
    const zoneNameMap = {};
    zoneRows.forEach(z => { zoneNameMap[z.zoneid] = z.name; });

    const keyitems  = decodeKeyItems(row.keyitems,  KEY_ITEM_NAMES);
    const titles    = decodeBitfield(row.titles,    TITLE_NAMES);
    const zones     = decodeBitfield(row.zones,     zoneNameMap);
    const eminence  = decodeEminence(row.eminence,  ROE_NAMES);
    const missions  = decodeMissions(row.missions);
    const assault   = decodeAssault(row.assault);
    const campaign  = decodeCampaign(row.campaign);

    res.json({ keyitems, titles, zones, eminence, missions, assault, campaign });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/character/:charid/bags', auth.requireAuth, async (req, res) => {
  try {
    const charid = parseInt(req.params.charid);
    if (req.user.tier !== 'admin' && !(await auth.userOwnsChar(pool, req.user.accid, charid)))
      return res.status(403).json({ error: 'not your character' });
    const [items] = await pool.execute(`
      SELECT ci.location, ci.slot, ci.itemId, ci.quantity,
             CONVERT(ib.name USING utf8) AS name
      FROM char_inventory ci
      LEFT JOIN item_basic ib ON ci.itemId = ib.itemid
      WHERE ci.charid = ? AND ci.location NOT IN (0,2,3,17) AND ci.itemId != 0
      ORDER BY ci.location, ci.slot
    `, [charid]);
    const [[storage]] = await pool.execute(
      `SELECT safe,locker,satchel,\`case\`,wardrobe,wardrobe2,wardrobe3,wardrobe4,
              wardrobe5,wardrobe6,wardrobe7,wardrobe8 FROM char_storage WHERE charid=?`, [charid]
    );
    res.json({ items, storage: storage || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Game rates (settings/*.lua files) ────────────────────────────────────────
const PATH_CONFIG_FILE = path.join(__dirname, 'data', 'path-config.json');
function _readPathCfg() {
  try { return JSON.parse(fs.readFileSync(PATH_CONFIG_FILE, 'utf8')); } catch(_) { return {}; }
}
const _pathCfg = _readPathCfg();
const LSB_SCRIPTS_DIR  = _pathCfg.LSB_SCRIPTS_DIR  || process.env.LSB_SCRIPTS_DIR  || '/ffxi-scripts';
const LSB_SETTINGS_DIR = _pathCfg.LSB_SETTINGS_DIR || process.env.LSB_SETTINGS_DIR || '/ffxi-settings';
const LSB_LOG_DIR      = _pathCfg.LSB_LOG_DIR      || process.env.LSB_LOG_DIR      || '/ffxi-log';
const SETTINGS_DIR = LSB_SETTINGS_DIR;
const MAPS_DIR_ROOT = path.join(__dirname, 'public', 'maps');
const UPLOADS_DIR_ROOT = path.join(__dirname, 'public', 'uploads');

app.get('/api/dashboard/paths', auth.requireAuth, auth.requireAdmin, (_req, res) => {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(PATH_CONFIG_FILE, 'utf8')); } catch(_) {}
  res.json({
    effective: { LSB_SCRIPTS_DIR, LSB_SETTINGS_DIR, LSB_LOG_DIR,
                 MAPS_DIR: MAPS_DIR_ROOT, UPLOADS_DIR: UPLOADS_DIR_ROOT, DATA_DIR },
    saved,
    defaults: { LSB_SCRIPTS_DIR: '/ffxi-scripts', LSB_SETTINGS_DIR: '/ffxi-settings', LSB_LOG_DIR: '/ffxi-log' },
  });
});

app.post('/api/dashboard/paths', auth.requireAuth, auth.requireAdmin, (req, res) => {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(PATH_CONFIG_FILE, 'utf8')); } catch(_) {}
  const body = req.body || {};
  for (const key of ['LSB_SCRIPTS_DIR', 'LSB_SETTINGS_DIR', 'LSB_LOG_DIR']) {
    if (typeof body[key] === 'string') {
      const trimmed = body[key].trim();
      if (trimmed) current[key] = trimmed;
      else delete current[key];
    }
  }
  fs.writeFileSync(PATH_CONFIG_FILE, JSON.stringify(current, null, 2), 'utf8');
  res.json({ ok: true, saved: current, restartRequired: true });
});

// ── Database config routes ────────────────────────────────────────────────────
app.get('/api/dashboard/db', auth.requireAuth, auth.requireAdmin, (_req, res) => {
  const effective = loadDbConfig();
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8')); } catch(_) {}
  res.json({
    effective: { ...effective, DB_PASS: effective.DB_PASS ? '••••••••' : '' },
    saved: { ...saved, DB_PASS: saved.DB_PASS ? '••••••••' : undefined },
    hasPassword: !!effective.DB_PASS,
  });
});

app.post('/api/dashboard/db', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (typeof body.DB_HOST === 'string') patch.DB_HOST = body.DB_HOST.trim();
  if (body.DB_PORT) patch.DB_PORT = Math.max(1, Math.min(65535, parseInt(String(body.DB_PORT)) || 3306));
  if (typeof body.DB_USER === 'string') patch.DB_USER = body.DB_USER.trim();
  if (typeof body.DB_NAME === 'string') patch.DB_NAME = body.DB_NAME.trim();
  if (typeof body.DB_PASS === 'string' && !body.DB_PASS.includes('•')) patch.DB_PASS = body.DB_PASS;
  saveDbConfig(patch);
  res.json({ ok: true, restartRequired: true });
});

app.post('/api/dashboard/db/test', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  const body = req.body || {};
  const current = loadDbConfig();
  const cfg = {
    host:     (body.DB_HOST?.trim()) || current.DB_HOST,
    port:     body.DB_PORT ? parseInt(String(body.DB_PORT)) || 3306 : current.DB_PORT,
    user:     (body.DB_USER?.trim()) || current.DB_USER,
    password: (body.DB_PASS && !body.DB_PASS.includes('•')) ? body.DB_PASS : current.DB_PASS,
    database: (body.DB_NAME?.trim()) || current.DB_NAME,
    connectTimeout: 5000,
  };
  let conn;
  try {
    conn = await mysql.createConnection(cfg);
    const [rows] = await conn.query('SELECT VERSION() AS v, DATABASE() AS db');
    res.json({ ok: true, version: rows[0]?.v, database: rows[0]?.db });
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    if (conn) await conn.end().catch(()=>{});
  }
});

// ── LSB update checker ───────────────────────────────────────────────────────
const LSB_CONFIG_FILE = path.join(DATA_DIR, 'lsb-config.json');
const LSB_CFG_DEFAULTS = { serverPath:'', forkRepo:'', upstreamRepo:'LandSandBoat/server', upstreamBranch:'base', githubToken:'' };

function loadLsbConfig(){
  try { return { ...LSB_CFG_DEFAULTS, ...JSON.parse(fs.readFileSync(LSB_CONFIG_FILE,'utf8')) }; }
  catch(_){ return { ...LSB_CFG_DEFAULTS }; }
}
function saveLsbConfig(patch){
  let cur={}; try{ cur=JSON.parse(fs.readFileSync(LSB_CONFIG_FILE,'utf8')); }catch(_){}
  fs.mkdirSync(path.dirname(LSB_CONFIG_FILE),{recursive:true});
  fs.writeFileSync(LSB_CONFIG_FILE, JSON.stringify({...cur,...patch},null,2),'utf8');
}
function readLocalGitInfo(repoPath){
  try {
    const head=fs.readFileSync(path.join(repoPath,'.git','HEAD'),'utf8').trim();
    let sha,branch;
    if(head.startsWith('ref: ')){
      const ref=head.slice(5);
      branch=ref.replace(/^refs\/heads\//,'');
      const refFile=path.join(repoPath,'.git',ref);
      if(fs.existsSync(refFile)){ sha=fs.readFileSync(refFile,'utf8').trim(); }
      else {
        const pp=path.join(repoPath,'.git','packed-refs');
        const packed=fs.existsSync(pp)?fs.readFileSync(pp,'utf8'):'';
        const m=packed.match(new RegExp(`^([a-f0-9]{40})\\s+${ref.replace(/\//g,'\\/')}$`,'m'));
        sha=m?m[1]:'';
      }
    } else { sha=head; branch='(detached HEAD)'; }
    return { sha, shortSha:sha.slice(0,7), branch };
  } catch(_){ return null; }
}
const _lsbStatusCache=new Map();
const LSB_CACHE_TTL=5*60*1000;
async function ghFetch(url,token){
  const headers={'User-Agent':'FFXI-Dashboard/1.0','Accept':'application/vnd.github.v3+json'};
  if(token) headers['Authorization']=`Bearer ${token}`;
  const resp=await fetch(url,{headers,signal:AbortSignal.timeout(8000)});
  if(!resp.ok){ const msg=await resp.text().catch(()=>resp.statusText); throw new Error(`GitHub ${resp.status}: ${msg.slice(0,200)}`); }
  return resp.json();
}

app.get('/api/fs/browse', auth.requireAuth, auth.requireAdmin, (req,res)=>{
  const dirPath=path.resolve(req.query.path||'/');
  try {
    const entries=fs.readdirSync(dirPath,{withFileTypes:true});
    const dirs=entries.filter(e=>e.isDirectory())
      .map(e=>({name:e.name,path:path.join(dirPath,e.name)}))
      .sort((a,b)=>a.name.localeCompare(b.name));
    const parent=dirPath==='/'?null:path.dirname(dirPath);
    res.json({path:dirPath,parent,dirs});
  } catch(e){ res.status(400).json({error:e.message}); }
});

app.get('/api/lsb/config', auth.requireAuth, auth.requireAdmin, (req,res)=>{
  const cfg=loadLsbConfig();
  res.json({...cfg, githubToken:cfg.githubToken?'••••••••':''});
});
app.post('/api/lsb/config', auth.requireAuth, auth.requireAdmin, (req,res)=>{
  const body=req.body||{};
  const patch={};
  if(typeof body.serverPath==='string')     patch.serverPath=body.serverPath.trim();
  if(typeof body.forkRepo==='string')       patch.forkRepo=body.forkRepo.trim();
  if(typeof body.upstreamRepo==='string')   patch.upstreamRepo=body.upstreamRepo.trim();
  if(typeof body.upstreamBranch==='string') patch.upstreamBranch=body.upstreamBranch.trim();
  if(typeof body.githubToken==='string'&&!body.githubToken.includes('•')) patch.githubToken=body.githubToken.trim();
  saveLsbConfig(patch);
  _lsbStatusCache.clear();
  res.json({ok:true});
});

async function ghBranchHead(repo,branch,token){
  const d=await ghFetch(`https://api.github.com/repos/${repo}/branches/${branch}`,token);
  return {sha:d.commit.sha,shortSha:d.commit.sha.slice(0,7),date:d.commit.commit.committer.date,
    message:d.commit.commit.message.split('\n')[0],author:d.commit.commit.author.name};
}
async function ghCompare(repo,base,head,token){
  try {
    const cmp=await ghFetch(`https://api.github.com/repos/${repo}/compare/${base}...${head}`,token);
    return {status:cmp.status??'unknown',behindBy:cmp.behind_by??0,aheadBy:cmp.ahead_by??0,
      commits:(cmp.commits??[]).slice(-20).reverse().map(c=>({
        sha:c.sha.slice(0,7),message:c.commit.message.split('\n')[0],
        author:c.commit.author.name,date:c.commit.committer.date,url:c.html_url
      }))};
  } catch(_){ return null; }
}

app.get('/api/lsb/status', auth.requireAuth, auth.requireAdmin, async(req,res)=>{
  const cfg=loadLsbConfig();
  const hasFork=!!cfg.forkRepo, hasLocal=!!cfg.serverPath;
  if(!hasFork&&!hasLocal) return res.json({configured:false});
  const forceRefresh=req.query.refresh==='1';
  const cacheKey=`${cfg.serverPath}|${cfg.forkRepo}|${cfg.upstreamRepo}|${cfg.upstreamBranch}`;
  if(!forceRefresh){
    const hit=_lsbStatusCache.get(cacheKey);
    if(hit&&Date.now()-hit.ts<LSB_CACHE_TTL) return res.json({...hit.data,cached:true});
  }
  const token=cfg.githubToken||undefined;
  let upstream;
  try { upstream=await ghBranchHead(cfg.upstreamRepo,cfg.upstreamBranch,token); upstream.repo=cfg.upstreamRepo; upstream.branch=cfg.upstreamBranch; }
  catch(e){ return res.json({configured:true,error:e.message}); }

  let fork=null,forkVsUpstream=null,forkMissingCommits=[];
  if(hasFork){
    try {
      fork=await ghBranchHead(cfg.forkRepo,cfg.upstreamBranch,token);
      fork.repo=cfg.forkRepo; fork.branch=cfg.upstreamBranch;
      const cmp=await ghCompare(cfg.upstreamRepo,fork.sha,upstream.sha,token);
      if(cmp){ forkVsUpstream={status:cmp.status,behindBy:cmp.behindBy,aheadBy:cmp.aheadBy}; forkMissingCommits=cmp.commits; }
    } catch(e){ fork={error:e.message}; }
  }

  let local=null,localVsRef=null,localMissingCommits=[];
  if(hasLocal){
    const gitInfo=readLocalGitInfo(cfg.serverPath);
    if(!gitInfo){ local={error:`Cannot read .git/HEAD at: ${cfg.serverPath}`}; }
    else {
      local={...gitInfo};
      const refRepo=cfg.forkRepo||cfg.upstreamRepo;
      const refHead=fork?.sha||upstream.sha;
      if(local.sha&&local.sha.length===40){
        try { const lc=await ghFetch(`https://api.github.com/repos/${refRepo}/commits/${local.sha}`,token);
          local.date=lc.commit?.committer?.date??null; local.message=(lc.commit?.message??'').split('\n')[0]||null; } catch(_){}
        const cmp=await ghCompare(refRepo,local.sha,refHead,token);
        if(cmp){ localVsRef={status:cmp.status,behindBy:cmp.behindBy,aheadBy:cmp.aheadBy,comparedTo:refRepo}; localMissingCommits=cmp.commits; }
      }
    }
  }
  const data={configured:true,upstream,fork,local,forkVsUpstream,forkMissingCommits,localVsRef,localMissingCommits,
    upstreamRepo:cfg.upstreamRepo,forkRepo:cfg.forkRepo,checkedAt:new Date().toISOString()};
  _lsbStatusCache.set(cacheKey,{ts:Date.now(),data});
  res.json(data);
});

// ── Docker management ─────────────────────────────────────────────────────────
// ── GitHub file browser ───────────────────────────────────────────────────────
const GH_CONFIG_FILE=path.join(DATA_DIR,'github-config.json');
const GH_DEFAULTS={repo:'',branch:'base',token:'',paths:{LSB_SCRIPTS_DIR:'scripts',LSB_SETTINGS_DIR:'scripts'}};
function loadGithubFilesConfig(){
  try{ const s=JSON.parse(fs.readFileSync(GH_CONFIG_FILE,'utf8')); return{...GH_DEFAULTS,...s,paths:{...GH_DEFAULTS.paths,...(s.paths||{})}}; }
  catch(_){ return{...GH_DEFAULTS,paths:{...GH_DEFAULTS.paths}}; }
}
function saveGithubFilesConfig(patch){
  let cur={}; try{ cur=JSON.parse(fs.readFileSync(GH_CONFIG_FILE,'utf8')); }catch(_){}
  const merged={...GH_DEFAULTS,...cur,...patch,paths:{...GH_DEFAULTS.paths,...(cur.paths||{}),...(patch.paths||{})}};
  fs.mkdirSync(path.dirname(GH_CONFIG_FILE),{recursive:true});
  fs.writeFileSync(GH_CONFIG_FILE,JSON.stringify(merged,null,2),'utf8');
}
async function ghApiGet(url,token){
  const headers={'User-Agent':'FFXI-Dashboard/1.0','Accept':'application/vnd.github.v3+json'};
  if(token) headers['Authorization']=`Bearer ${token}`;
  const resp=await fetch(url,{headers,signal:AbortSignal.timeout(10000)});
  if(!resp.ok){ const msg=await resp.text().catch(()=>resp.statusText); throw new Error(`GitHub ${resp.status}: ${msg.slice(0,200)}`); }
  return resp.json();
}
app.get('/api/github/config', auth.requireAuth, auth.requireAdmin, (req,res)=>{
  const cfg=loadGithubFilesConfig(); res.json({...cfg,token:cfg.token?'••••••••':''});
});
app.post('/api/github/config', auth.requireAuth, auth.requireAdmin, (req,res)=>{
  const body=req.body||{}; const patch={};
  if(typeof body.repo==='string')   patch.repo=body.repo.trim();
  if(typeof body.branch==='string') patch.branch=body.branch.trim();
  if(typeof body.token==='string'&&!body.token.includes('•')) patch.token=body.token.trim();
  if(body.paths&&typeof body.paths==='object'){
    patch.paths={};
    for(const[k,v] of Object.entries(body.paths)) if(typeof v==='string') patch.paths[k]=v.trim();
  }
  saveGithubFilesConfig(patch); res.json({ok:true});
});
app.get('/api/github/browse', auth.requireAuth, auth.requireAdmin, async(req,res)=>{
  const cfg=loadGithubFilesConfig();
  if(!cfg.repo) return res.status(400).json({error:'GitHub repo not configured'});
  const dirPath=((req.query.path||'').replace(/^\/+/,''));
  const branch=req.query.branch||cfg.branch||'base';
  const token=cfg.token||undefined;
  try {
    const url=`https://api.github.com/repos/${cfg.repo}/contents/${dirPath}?ref=${encodeURIComponent(branch)}`;
    const data=await ghApiGet(url,token);
    if(Array.isArray(data)){
      const items=data.map(item=>({name:item.name,path:item.path,type:item.type,size:item.size,
        sha:item.sha,htmlUrl:item.html_url,downloadUrl:item.download_url}))
        .sort((a,b)=>a.type!==b.type?(a.type==='dir'?-1:1):a.name.localeCompare(b.name));
      const parent=dirPath.includes('/')?dirPath.slice(0,dirPath.lastIndexOf('/')):null;
      res.json({path:dirPath,branch,repo:cfg.repo,parent,items});
    } else { res.json({path:dirPath,branch,repo:cfg.repo,file:data}); }
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/github/content', auth.requireAuth, auth.requireAdmin, async(req,res)=>{
  const cfg=loadGithubFilesConfig();
  if(!cfg.repo) return res.status(400).json({error:'GitHub repo not configured'});
  const filePath=req.query.path||'';
  const branch=req.query.branch||cfg.branch||'base';
  const token=cfg.token||undefined;
  try {
    const url=`https://api.github.com/repos/${cfg.repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
    const data=await ghApiGet(url,token);
    if(data.encoding==='base64'){
      const content=Buffer.from(data.content.replace(/\n/g,''),'base64').toString('utf8');
      res.json({content,name:data.name,path:data.path,size:data.size,htmlUrl:data.html_url});
    } else { res.status(400).json({error:'Unexpected encoding: '+data.encoding}); }
  } catch(e){ res.status(500).json({error:e.message}); }
});

const DOCKER_SOCKET='/var/run/docker.sock';
function isDockerAvailable(){ try{ fs.accessSync(DOCKER_SOCKET); return true; }catch(_){ return false; } }
function dockerReq(method,apiPath,body){
  return new Promise((resolve,reject)=>{
    const opts={socketPath:DOCKER_SOCKET,method,path:apiPath,headers:body?{'Content-Type':'application/json'}:{}};
    const req=require('http').request(opts,res=>{
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>{
        const raw=Buffer.concat(chunks);
        let parsed; try{ parsed=JSON.parse(raw.toString()); }catch(_){ parsed=raw.toString(); }
        resolve({status:res.statusCode,body:parsed});
      });
    });
    req.on('error',reject);
    if(body) req.write(JSON.stringify(body));
    req.end();
  });
}
function parseDockerLogs(buf){
  const lines=[]; let offset=0;
  while(offset+8<=buf.length){
    const size=buf.readUInt32BE(offset+4); offset+=8;
    if(size===0) continue;
    if(offset+size>buf.length) break;
    const chunk=buf.slice(offset,offset+size).toString('utf8'); offset+=size;
    for(const l of chunk.split('\n')){ const t=l.trimEnd(); if(t) lines.push(t); }
  }
  if(!lines.length) return buf.toString('utf8').split('\n').map(l=>l.trimEnd()).filter(Boolean);
  return lines;
}

app.get('/api/docker/status', auth.requireAuth, auth.requireAdmin, async(req,res)=>{
  if(!isDockerAvailable()) return res.json({available:false,hint:'Add "- /var/run/docker.sock:/var/run/docker.sock" to the dashboard volumes in docker-compose.yml, then recreate the container.'});
  try {
    const [infoR,containersR]=await Promise.all([dockerReq('GET','/info'),dockerReq('GET','/containers/json?all=1')]);
    const containers=(Array.isArray(containersR.body)?containersR.body:[]).map(c=>({
      id:c.Id.slice(0,12), names:c.Names.map(n=>n.replace(/^\//,'')),
      image:c.Image, status:c.Status, state:c.State, created:c.Created,
      ports:c.Ports.map(p=>p.PublicPort?`${p.PublicPort}→${p.PrivatePort}`:null).filter(Boolean),
    }));
    res.json({available:true,serverVersion:infoR.body?.ServerVersion,containers});
  } catch(e){ res.status(500).json({available:false,error:e.message}); }
});
app.post('/api/docker/containers/:id/restart', auth.requireAuth, auth.requireAdmin, async(req,res)=>{
  if(!isDockerAvailable()) return res.status(503).json({error:'Docker not available'});
  try {
    const r=await dockerReq('POST',`/containers/${req.params.id}/restart?t=10`);
    if(r.status===204||r.status===200) res.json({ok:true});
    else res.status(r.status||500).json({error:r.body?.message||'Docker API error'});
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/docker/containers/:id/logs', auth.requireAuth, auth.requireAdmin, (req,res)=>{
  if(!isDockerAvailable()) return res.status(503).json({error:'Docker not available'});
  const tail=Math.min(200,Math.max(10,parseInt(req.query.tail)||50));
  const opts={socketPath:DOCKER_SOCKET,method:'GET',path:`/containers/${req.params.id}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=0`};
  const dreq=require('http').request(opts,dres=>{
    const chunks=[]; dres.on('data',c=>chunks.push(c));
    dres.on('end',()=>res.json({lines:parseDockerLogs(Buffer.concat(chunks))}));
  });
  dreq.on('error',e=>res.status(500).json({error:e.message}));
  dreq.end();
});

// ── Browse filesystem inside a container via Docker exec ────────────────────
app.get('/api/docker/containers/:id/fs/browse', auth.requireAuth, auth.requireAdmin, async (req,res)=>{
  if(!isDockerAvailable()) return res.status(503).json({error:'Docker not available'});
  const dirPath=(req.query.path||'/').toString();
  const id=req.params.id;
  try{
    // Create exec
    const execR=await dockerReq('POST',`/containers/${id}/exec`,{
      AttachStdout:true, AttachStderr:false,
      Cmd:['sh','-c',`ls -1ap "${dirPath}" 2>&1`],
    });
    if(execR.status!==201) return res.status(400).json({error:execR.body?.message||'Exec create failed'});
    const execId=execR.body.Id;
    // Start exec and collect output
    const output=await new Promise((resolve,reject)=>{
      const opts={socketPath:DOCKER_SOCKET,method:'POST',path:`/exec/${execId}/start`,
        headers:{'Content-Type':'application/json'}};
      const dr=require('http').request(opts,dres=>{
        const chunks=[]; dres.on('data',c=>chunks.push(c));
        dres.on('end',()=>resolve(parseDockerLogs(Buffer.concat(chunks)).join('\n')));
      });
      dr.on('error',reject);
      dr.write(JSON.stringify({Detach:false,Tty:false}));
      dr.end();
    });
    const lines=output.split('\n').map(l=>l.trim()).filter(l=>l&&l!=='.'&&l!=='..');
    const items=lines.map(name=>{
      const isDir=name.endsWith('/');
      const clean=isDir?name.slice(0,-1):name;
      const joined=dirPath.replace(/\/$/,'')+'/'+clean;
      return {name:clean,path:joined,type:isDir?'dir':'file'};
    }).sort((a,b)=>{
      if(a.type!==b.type) return a.type==='dir'?-1:1;
      return a.name.localeCompare(b.name);
    });
    const parent=dirPath==='/'?null:dirPath.replace(/\/$/,'').replace(/\/[^/]+$/,'')||'/';
    res.json({path:dirPath,parent,items,containerId:id});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

const RATE_CATALOG = [
  // Experience
  { group:'Experience',       key:'EXP_RATE',                   label:'EXP Rate (script)',      file:'main.lua',  step:1    },
  { group:'Experience',       key:'BOOK_EXP_RATE',              label:'FoV/GoV Book EXP',       file:'main.lua',  step:0.1  },
  { group:'Experience',       key:'ROE_EXP_RATE',               label:'RoE EXP',                file:'main.lua',  step:0.1  },
  { group:'Experience',       key:'CAPACITY_RATE',              label:'Capacity Points',         file:'main.lua',  step:0.1  },
  { group:'Experience',       key:'TABS_RATE',                  label:'FoV Tabs',               file:'main.lua',  step:0.1  },
  { group:'Experience',       key:'SPARKS_RATE',                label:'Sparks of Eminence',     file:'main.lua',  step:0.1  },
  // Economy
  { group:'Economy',          key:'GIL_RATE',                   label:'Quest Gil',              file:'main.lua',  step:0.1  },
  { group:'Economy',          key:'BAYLD_RATE',                 label:'Bayld',                  file:'main.lua',  step:0.1  },
  { group:'Economy',          key:'SHOP_PRICE',                 label:'NPC Shop Prices',        file:'main.lua',  step:0.1  },
  // Drops & Mob Gil
  { group:'Drops & Mob Gil',  key:'DROP_RATE_MULTIPLIER',       label:'Drop Rate',              file:'map.lua',   step:0.1  },
  { group:'Drops & Mob Gil',  key:'MOB_GIL_MULTIPLIER',         label:'Mob Gil',                file:'map.lua',   step:0.1  },
  { group:'Drops & Mob Gil',  key:'ALL_MOBS_GIL_BONUS',         label:'Flat Gil Bonus',         file:'map.lua',   step:1    },
  // Skills & Crafting
  { group:'Skills & Crafting',key:'SKILLUP_CHANCE_MULTIPLIER',  label:'Skill-up Chance',        file:'map.lua',   step:0.1  },
  { group:'Skills & Crafting',key:'SKILLUP_AMOUNT_MULTIPLIER',  label:'Skill-up Amount',        file:'map.lua',   step:0.1  },
  { group:'Skills & Crafting',key:'CRAFT_CHANCE_MULTIPLIER',    label:'Craft Skill-up Chance',  file:'map.lua',   step:0.1  },
  { group:'Skills & Crafting',key:'CRAFT_AMOUNT_MULTIPLIER',    label:'Craft Skill-up Amount',  file:'map.lua',   step:0.1  },
  { group:'Skills & Crafting',key:'CRAFT_HQ_CHANCE_MULTIPLIER', label:'Craft HQ Chance',        file:'map.lua',   step:0.1  },
  { group:'Skills & Crafting',key:'FAME_MULTIPLIER',            label:'Fame',                   file:'map.lua',   step:0.1  },
  { group:'Skills & Crafting',key:'FISHING_SKILL_MULTIPLIER',   label:'Fishing Skill-up',       file:'map.lua',   step:0.1  },
  // Gathering
  { group:'Gathering',        key:'HARVESTING_RATE',            label:'Harvesting (%)',         file:'main.lua',  step:1    },
  { group:'Gathering',        key:'EXCAVATION_RATE',            label:'Excavation (%)',         file:'main.lua',  step:1    },
  { group:'Gathering',        key:'LOGGING_RATE',               label:'Logging (%)',            file:'main.lua',  step:1    },
  { group:'Gathering',        key:'MINING_RATE',                label:'Mining (%)',             file:'main.lua',  step:1    },
  { group:'Gathering',        key:'DIGGING_RATE',               label:'Chocobo Digging (%)',    file:'main.lua',  step:1    },
  // Death Penalties
  { group:'Death Penalties',  key:'EXP_LOSS_RATE',              label:'EXP Loss Rate',          file:'map.lua',   step:0.1  },
  { group:'Death Penalties',  key:'EXP_RETAIN',                 label:'EXP Retained on Death (%)', file:'map.lua', step:1   },
  { group:'Death Penalties',  key:'EXP_LOSS_LEVEL',             label:'Min Level for EXP Loss', file:'map.lua',   step:1    },
  // Player
  { group:'Player',           key:'BASE_SPEED',                 label:'Base Movement Speed',    file:'map.lua',   step:1    },
  { group:'Player',           key:'SPEED_LIMIT',                label:'Speed Cap',              file:'map.lua',   step:1    },
  { group:'Player',           key:'MOUNT_SPEED',                label:'Mount Speed',            file:'map.lua',   step:1    },
  { group:'Player',           key:'PLAYER_TP_MULTIPLIER',       label:'Player TP',              file:'map.lua',   step:0.1  },
  { group:'Player',           key:'ABILITY_RECAST_MULTIPLIER',  label:'Ability Recast',         file:'map.lua',   step:0.1  },
  // Mobs
  { group:'Mobs',             key:'MOB_HP_MULTIPLIER',          label:'Mob HP',                 file:'map.lua',   step:0.1  },
  { group:'Mobs',             key:'MOB_MP_MULTIPLIER',          label:'Mob MP',                 file:'map.lua',   step:0.1  },
  { group:'Mobs',             key:'MOB_STAT_MULTIPLIER',        label:'Mob Stats',              file:'map.lua',   step:0.1  },
  { group:'Mobs',             key:'MOB_TP_MULTIPLIER',          label:'Mob TP',                 file:'map.lua',   step:0.1  },
  { group:'Mobs',             key:'MOB_RUN_SPEED_MULTIPLIER',   label:'Mob Run Speed',          file:'map.lua',   step:0.1  },
  // NM
  { group:'NM',               key:'NM_HP_MULTIPLIER',           label:'NM HP',                  file:'map.lua',   step:0.1  },
  { group:'NM',               key:'NM_MP_MULTIPLIER',           label:'NM MP',                  file:'map.lua',   step:0.1  },
  { group:'NM',               key:'NM_STAT_MULTIPLIER',         label:'NM Stats',               file:'map.lua',   step:0.1  },
  // Trust / Alter Ego
  { group:'Trust / Alter Ego',key:'ALTER_EGO_HP_MULTIPLIER',    label:'Alter Ego HP',           file:'map.lua',   step:0.1  },
  { group:'Trust / Alter Ego',key:'ALTER_EGO_MP_MULTIPLIER',    label:'Alter Ego MP',           file:'map.lua',   step:0.1  },
  { group:'Trust / Alter Ego',key:'ALTER_EGO_STAT_MULTIPLIER',  label:'Alter Ego Stats',        file:'map.lua',   step:0.1  },
  { group:'Trust / Alter Ego',key:'ALTER_EGO_SKILL_MULTIPLIER', label:'Alter Ego Skills',       file:'map.lua',   step:0.1  },
  { group:'Trust / Alter Ego',key:'PET_TP_MULTIPLIER',          label:'Pet TP',                 file:'map.lua',   step:0.1  },
  { group:'Trust / Alter Ego',key:'FELLOW_TP_MULTIPLIER',       label:'Fellow TP',              file:'map.lua',   step:0.1  },
  // Auction House
  { group:'Auction House',    key:'AH_BASE_FEE_SINGLE',         label:'Base Fee (Single)',      file:'map.lua',   step:1    },
  { group:'Auction House',    key:'AH_BASE_FEE_STACKS',         label:'Base Fee (Stacks)',      file:'map.lua',   step:1    },
  { group:'Auction House',    key:'AH_TAX_RATE_SINGLE',         label:'Tax Rate (Single)',      file:'map.lua',   step:0.1  },
  { group:'Auction House',    key:'AH_TAX_RATE_STACKS',         label:'Tax Rate (Stacks)',      file:'map.lua',   step:0.1  },
  { group:'Auction House',    key:'AH_MAX_FEE',                 label:'Max Fee',                file:'map.lua',   step:100  },
  { group:'Auction House',    key:'AH_LIST_LIMIT',              label:'Listing Limit',          file:'map.lua',   step:1    },
  // Zone
  { group:'Zone',             key:'ZONE_PLAYER_CAP',            label:'Player Cap per Zone',    file:'map.lua',   step:1    },
  { group:'Zone',             key:'ZONE_PLAYER_GM_RESERVED',    label:'GM Reserved Slots',      file:'map.lua',   step:1    },
  // Server Control (login.lua — booleans saved as true/false)
  { group:'Server Control',   key:'MAINT_MODE',                 label:'Maintenance Mode',       file:'login.lua', step:1    },
  { group:'Server Control',   key:'LOGIN_LIMIT',                label:'Login Limit (0 = off)',  file:'login.lua', step:1    },
  { group:'Server Control',   key:'VER_LOCK',                   label:'Version Lock',           file:'login.lua', step:1    },
  { group:'Server Control',   key:'ACCOUNT_CREATION',           label:'Account Creation',       file:'login.lua', type:'bool' },
  { group:'Server Control',   key:'CHARACTER_CREATION',         label:'Character Creation',     file:'login.lua', type:'bool' },
  { group:'Server Control',   key:'CHARACTER_DELETION',         label:'Character Deletion',     file:'login.lua', type:'bool' },
];

function readRate(content, key, type) {
  if (type === 'bool') {
    const m = content.match(new RegExp(`\\b${key}\\s*=\\s*(true|false)`));
    return m ? m[1] === 'true' : null;
  }
  const m = content.match(new RegExp(`\\b${key}\\s*=\\s*(-?[\\d.]+)`));
  return m ? parseFloat(m[1]) : null;
}

function writeRate(content, key, value, type) {
  if (type === 'bool') {
    return content.replace(new RegExp(`(\\b${key}\\s*=\\s*)(?:true|false)`), `$1${value}`);
  }
  return content.replace(new RegExp(`(\\b${key}\\s*=\\s*)-?[\\d.]+`), `$1${value}`);
}

app.get('/api/settings/rates', auth.requireAuth, auth.requireAdmin, async (_req, res) => {
  try {
    const cache = {};
    const result = RATE_CATALOG.map(entry => {
      if (!cache[entry.file]) {
        try { cache[entry.file] = fs.readFileSync(path.join(SETTINGS_DIR, entry.file), 'utf8'); }
        catch (_) { cache[entry.file] = ''; }
      }
      return { ...entry, value: readRate(cache[entry.file], entry.key, entry.type) };
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/rates', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body || {};
    const entry = RATE_CATALOG.find(e => e.key === key);
    if (!entry) return res.status(400).json({ error: 'unknown key' });
    const filePath = path.join(SETTINGS_DIR, entry.file);
    const content  = fs.readFileSync(filePath, 'utf8');
    const writeVal = entry.type === 'bool'
      ? (value === true || value === 'true' ? 'true' : 'false')
      : parseFloat(value);
    const updated  = writeRate(content, key, writeVal, entry.type);
    if (updated === content) return res.status(400).json({ error: 'key not found in file' });
    fs.writeFileSync(filePath, updated, 'utf8');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const SCAN_FILES = ['main.lua', 'map.lua', 'login.lua'];
const CURATED_KEYS = new Set(RATE_CATALOG.map(e => e.key));

app.get('/api/dashboard/settings', auth.requireAuth, (_req, res) => res.json(loadDashboardSettings()));

app.post('/api/dashboard/settings', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const current = loadDashboardSettings();
  const body = req.body || {};
  const clampInt = (v, min, max, fallback) =>
    typeof v === 'number' && Number.isInteger(v) ? Math.max(min, Math.min(max, v)) : fallback;
  const updated = {
    serverName:        typeof body.serverName        === 'string'  ? body.serverName.slice(0, 100)  : current.serverName,
    motd:              typeof body.motd              === 'string'  ? body.motd.slice(0, 500)        : current.motd,
    autoSwitchZone:    typeof body.autoSwitchZone    === 'boolean' ? body.autoSwitchZone             : current.autoSwitchZone,
    autologin:         typeof body.autologin         === 'boolean' ? body.autologin                  : current.autologin,
    allowPlayerLogin:  typeof body.allowPlayerLogin  === 'boolean' ? body.allowPlayerLogin            : current.allowPlayerLogin,
    tokenTtlHours:     clampInt(body.tokenTtlHours,     1,   720, current.tokenTtlHours     ?? 24),
    adminGmLevel:      clampInt(body.adminGmLevel,      1,    10, current.adminGmLevel      ?? 1),
    loginRateLimitMax: clampInt(body.loginRateLimitMax, 1,   100, current.loginRateLimitMax ?? 10),
  };
  saveDashboardSettings(updated);
  res.json({ ok: true, settings: updated });
});

function scanSettingsFile(file) {
  const entries = [];
  const tryPaths = [path.join(SETTINGS_DIR, file), path.join(SETTINGS_DIR, 'default', file)];
  let content = '';
  for (const p of tryPaths) {
    try { content = fs.readFileSync(p, 'utf8'); break; } catch (_) {}
  }
  if (!content) return { entries, missing: true };
  const re = /^\s*([A-Z][A-Z0-9_]+)\s*=\s*([^,\n]+)/gm;
  const seen = new Set();
  let m;
  while ((m = re.exec(content)) !== null) {
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = m[2].replace(/--[^\n]*$/, '').replace(/,\s*$/, '').trim();
    let value;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (raw !== '' && !isNaN(raw)) value = parseFloat(raw);
    else continue; // skip strings, tables, and anything non-scalar
    entries.push({ key, value, curated: CURATED_KEYS.has(key) });
  }
  return { entries, missing: false };
}

app.get('/api/settings/scan', auth.requireAuth, auth.requireAdmin, (_req, res) => {
  try {
    const result = {};
    for (const file of SCAN_FILES) result[file] = scanSettingsFile(file);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/scan', auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const { file, key, value } = req.body || {};
    if (!SCAN_FILES.includes(file)) return res.status(400).json({ error: 'invalid file' });
    if (!/^[A-Z][A-Z0-9_]+$/.test(key)) return res.status(400).json({ error: 'invalid key' });
    const filePath = path.join(SETTINGS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const isBool = value === 'true' || value === 'false' || value === true || value === false;
    const boolIsTrue = value === true || value === 'true';
    let writeVal = isBool ? (boolIsTrue ? 'true' : 'false') : parseFloat(value);
    let updated = writeRate(content, key, writeVal, isBool ? 'bool' : undefined);
    if (updated === content && isBool) {
      writeVal = boolIsTrue ? 1 : 0;
      updated = writeRate(content, key, writeVal);
    }
    if (updated === content) return res.status(400).json({ error: 'key not found in file' });
    fs.writeFileSync(filePath, updated, 'utf8');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Pop Timer Tracker ─────────────────────────────────────────────────────────
const TIMERS_FILE = path.join(__dirname, 'data', 'timers.json');
function readTimers() { try { return JSON.parse(fs.readFileSync(TIMERS_FILE, 'utf8')); } catch { return []; } }
function writeTimers(t) { fs.mkdirSync(path.dirname(TIMERS_FILE), { recursive: true }); fs.writeFileSync(TIMERS_FILE, JSON.stringify(t, null, 2)); }

app.get('/api/db/nms', auth.requireAuth, async (req, res) => {
  try {
    const q = `%${(req.query.q||'').trim().replace(/_/g,' ')}%`;
    const minRespawn = Math.max(0, parseInt(req.query.minRespawn)||3600);
    const [rows] = await pool.execute(`
      SELECT mg.groupid, mg.name, mg.respawntime, mg.zoneid, z.name AS zone_name,
             AVG(sp.pos_x) AS spawn_x, AVG(sp.pos_y) AS spawn_y, AVG(sp.pos_z) AS spawn_z
      FROM mob_groups mg
      JOIN zone_settings z ON mg.zoneid = z.zoneid
      LEFT JOIN mob_spawn_points sp ON sp.groupid = mg.groupid
      WHERE mg.respawntime >= ?
        AND mg.name IS NOT NULL AND mg.name != ''
        AND (REPLACE(mg.name,'_',' ') LIKE ? OR z.name LIKE ?)
      GROUP BY mg.groupid, mg.name, mg.zoneid, mg.respawntime
      ORDER BY mg.respawntime DESC, z.name, mg.name
      LIMIT 100`, [minRespawn, q, q]);
    res.json(rows.map(r => ({
      groupId: r.groupid,
      name: r.name.replace(/_/g,' '),
      nmName: r.name,
      zone: r.zone_name.replace(/_/g,' '),
      zoneId: r.zoneid,
      spawnX: r.spawn_x != null ? +parseFloat(r.spawn_x).toFixed(3) : null,
      spawnY: r.spawn_y != null ? +parseFloat(r.spawn_y).toFixed(3) : null,
      spawnZ: r.spawn_z != null ? +parseFloat(r.spawn_z).toFixed(3) : null,
      respawnSecs: r.respawntime,
      respawnMin: +(r.respawntime/3600).toFixed(2),
      respawnMax: +((r.respawntime + (r.respawntime >= 75600 ? 10800 : r.respawntime >= 3600 ? 3600 : 1800))/3600).toFixed(2),
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/players/online', auth.requireAuth, async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT c.charid, c.charname FROM chars c
       JOIN accounts_sessions ses ON c.charid = ses.charid
       ORDER BY c.charname`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/timers', auth.requireAuth, (_req, res) => res.json(readTimers()));

app.post('/api/timers', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const { id, name, zone, respawnMin, respawnMax, notes, groupId, nmName, zoneId, spawnX, spawnY, spawnZ, type, roeId, goal } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const timers = readTimers();
  const now = Date.now();
  if (id) {
    const idx = timers.findIndex(t => t.id === id);
    const base = idx >= 0 ? timers[idx] : { id, created: now, lastKill: null };
    const updated = { ...base, name, zone: zone||'', respawnMin: Number(respawnMin)||1, respawnMax: Number(respawnMax)||1, notes: notes||'', groupId: groupId||null, nmName: nmName||null, zoneId: zoneId||null, spawnX: spawnX??null, spawnY: spawnY??null, spawnZ: spawnZ??null, type: type||'nm', roeId: roeId||null, goal: goal??null, updated: now };
    if (idx >= 0) timers[idx] = updated; else timers.push(updated);
  } else {
    const crypto = require('crypto');
    timers.push({ id: crypto.randomUUID(), name, zone: zone||'', respawnMin: Number(respawnMin)||1, respawnMax: Number(respawnMax)||1, notes: notes||'', groupId: groupId||null, nmName: nmName||null, zoneId: zoneId||null, spawnX: spawnX??null, spawnY: spawnY??null, spawnZ: spawnZ??null, type: type||'nm', roeId: roeId||null, goal: goal??null, lastKill: null, created: now, updated: now });
  }
  writeTimers(timers);
  res.json({ ok: true, timers: readTimers() });
});

app.delete('/api/timers/:id', auth.requireAuth, auth.requireAdmin, (req, res) => {
  writeTimers(readTimers().filter(t => t.id !== req.params.id));
  res.json({ ok: true });
});

app.post('/api/timers/:id/kill', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const timers = readTimers();
  const t = timers.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  t.lastKill = req.body?.at ? Number(req.body.at) : Date.now();
  writeTimers(timers);
  res.json({ ok: true });
});

app.post('/api/timers/:id/reset', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const timers = readTimers();
  const t = timers.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  t.lastKill = null;
  writeTimers(timers);
  res.json({ ok: true });
});

// Batch check — one luaexec for all tracked NMs
// mob zone formula: (mobid >> 12) - 4096 = zoneid  (same offset as NPCs per CLAUDE.md)
app.post('/api/nm/checkall', auth.requireAuth, async (req, res) => {
  try {
    const items = req.body || []; // [{groupId, nmName}, ...]
    if (!items.length) return res.json({ queued: false });
    // Fetch zone-filtered mobids for each item — avoids GetMobByID warnings for out-of-zone mobs
    const mobIdsByItem = await Promise.all(items.map(async item => {
      const [rows] = await pool.execute(
        `SELECT DISTINCT sp.mobid FROM mob_spawn_points sp
         WHERE sp.groupid=? AND (sp.mobid >> 12) - 4096 IN
           (SELECT mg.zoneid FROM mob_groups mg WHERE mg.groupid=? AND mg.name=?)
         ORDER BY sp.mobid`, [parseInt(item.groupId), parseInt(item.groupId), item.nmName||'']);
      return rows.map(r => r.mobid);
    }));
    // Build a single Lua script that checks every NM and returns spawned|hpp|hp per entry
    const entries = items.map((item, i) => {
      const ids = mobIdsByItem[i].join(',');
      const safeName = (item.nmName||'').replace(/\\/g,'\\\\').replace(/"/g,'\\"');
      if (!ids) return `t[${i+1}]="0|0|0"`;
      return `do local f=false;local h=0;local hp=0;for _,id in ipairs({${ids}})do local m=GetMobByID(id);if m and m:getName()=="${safeName}"then h=m:getHPP();hp=m:getHP();f=true;break end end;t[${i+1}]=(f and"1"or"0").."|"..h.."|"..hp end`;
    }).join(';');
    const lua = `local t={};${entries};return table.concat(t,";")`;
    const [result] = await pool.execute(
      'INSERT INTO dashboard_queue (charid,action,params,requested_by) VALUES (0,"luaexec",?,"dashboard")', [lua]);
    res.json({ queued: true, id: result.insertId, count: items.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Live NM status check — queries all spawn slots for a group, matches by NM name
app.post('/api/nm/check', auth.requireAuth, async (req, res) => {
  try {
    const { groupId, nmName } = req.body || {};
    if (!groupId || !nmName) return res.status(400).json({ error: 'groupId and nmName required' });
    // Filter mobids to the NM's zone so GetMobByID is only called for mobs that exist here
    const [rows] = await pool.execute(
      `SELECT DISTINCT sp.mobid FROM mob_spawn_points sp
       WHERE sp.groupid=? AND (sp.mobid >> 12) - 4096 IN
         (SELECT mg.zoneid FROM mob_groups mg WHERE mg.groupid=? AND mg.name=?)
       ORDER BY sp.mobid LIMIT 30`, [groupId, groupId, nmName]);
    if (!rows.length) return res.json({ queued: false, reason: 'no spawn points found' });
    const ids = rows.map(r => r.mobid);
    const safeName = nmName.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
    const lua = `local found=false;local hpp=0;local hp=0;for _,id in ipairs({${ids.join(',')}})do local mob=GetMobByID(id);if mob then local n=mob:getName();if n=="${safeName}"then hpp=mob:getHPP();hp=mob:getHP();found=true;break end end end;if found then return("spawned|"..hpp.."|"..hp)else return"not_spawned"end`;
    const [result] = await pool.execute(
      'INSERT INTO dashboard_queue (charid,action,params,requested_by) VALUES (0,"luaexec",?,"dashboard")', [lua]);
    res.json({ queued: true, id: result.insertId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Spawn coordinates for an NM group — first valid (non-zero) point for the named mob
app.get('/api/nm/spawnpoint', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { groupId, nmName } = req.query;
    if (!groupId || !nmName) return res.status(400).json({ error: 'groupId and nmName required' });
    const safeName = (nmName||'').replace(/_/g,' ');
    const [rows] = await pool.execute(`
      SELECT sp.pos_x AS x, sp.pos_y AS y, sp.pos_z AS z, mg.zoneid
      FROM mob_spawn_points sp
      JOIN mob_groups mg ON mg.groupid = sp.groupid AND REPLACE(mg.name,'_',' ')=?
      WHERE sp.groupid=? AND (sp.pos_x!=0 OR sp.pos_z!=0)
      ORDER BY sp.mobid LIMIT 1`, [safeName, parseInt(groupId)]);
    if (!rows.length) return res.json({ found: false });
    const r = rows[0];
    res.json({ found: true, x: +parseFloat(r.x).toFixed(3), y: +parseFloat(r.y).toFixed(3), z: +parseFloat(r.z).toFixed(3), zoneId: r.zoneid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Poll result for NM checks — scoped to dashboard luaexec rows, no admin required
app.get('/api/nm/result/:id', auth.requireAuth, async (req, res) => {
  try {
    const [[row]] = await pool.execute(
      'SELECT status, result FROM dashboard_queue WHERE id=? AND action="luaexec" AND requested_by="dashboard"',
      [parseInt(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Settings: server variables ────────────────────────────────────────────────
app.get('/api/settings/variables', auth.requireAuth, auth.requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.execute('SELECT name AS varname, value FROM server_variables ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/settings/variables', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const { varname, value } = req.body || {};
    if (!varname) return res.status(400).json({ error: 'varname required' });
    await pool.execute(
      'INSERT INTO server_variables (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [varname, parseInt(value) || 0]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Account management ────────────────────────────────────────────────────────
app.post('/api/accounts/:id/status', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { status } = req.body || {};
    if (status !== 0 && status !== 1) return res.status(400).json({ error: 'status must be 0 or 1' });
    await pool.execute('UPDATE accounts SET status = ? WHERE id = ?', [status, id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts/:id/priv', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { priv } = req.body || {};
    const privNum = parseInt(priv);
    if (isNaN(privNum) || privNum < 0 || privNum > 5) return res.status(400).json({ error: 'priv must be 0–5' });
    await pool.execute('UPDATE accounts SET priv = ? WHERE id = ?', [privNum, id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Server Script Browser ─────────────────────────────────────────────────────
const SERVER_SCRIPTS_ROOT = '/ffxi-server-scripts';

function safeBrowserPath(rel) {
  const full = path.resolve(SERVER_SCRIPTS_ROOT, rel || '');
  if (!full.startsWith(SERVER_SCRIPTS_ROOT)) throw new Error('Invalid path');
  return full;
}

app.get('/api/scriptbrowser', auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const full = safeBrowserPath(req.query.path || '');
    const stat = fs.statSync(full);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });
    const entries = fs.readdirSync(full, { withFileTypes: true })
      .filter(e => e.isDirectory() || e.name.endsWith('.lua'))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
    res.json(entries);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Path not found' });
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/scriptbrowser/file', auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const full = safeBrowserPath(req.query.path || '');
    if (!full.endsWith('.lua')) return res.status(400).json({ error: 'Only .lua files allowed' });
    const stat = fs.statSync(full);
    if (stat.size > 512 * 1024) return res.status(400).json({ error: 'File too large (>512 KB)' });
    res.type('text/plain').send(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/scriptbrowser/file', auth.requireAuth, auth.requireAdmin, (req, res) => {
  try {
    const full = safeBrowserPath(req.query.path || '');
    if (!full.endsWith('.lua')) return res.status(400).json({ error: 'Only .lua files allowed' });
    if (!fs.existsSync(path.dirname(full))) return res.status(400).json({ error: 'Directory does not exist' });
    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    fs.writeFileSync(full, content, 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Script Manager ────────────────────────────────────────────────────────────
const SCRIPTS_FILE = path.join(__dirname, 'data', 'scripts.json');
function readScripts() {
  try { return JSON.parse(fs.readFileSync(SCRIPTS_FILE, 'utf8')); } catch { return []; }
}
function writeScripts(scripts) {
  fs.mkdirSync(path.dirname(SCRIPTS_FILE), { recursive: true });
  fs.writeFileSync(SCRIPTS_FILE, JSON.stringify(scripts, null, 2));
}

app.get('/api/scripts', auth.requireAuth, auth.requireAdmin, (_req, res) => {
  res.json(readScripts());
});

app.post('/api/scripts', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const { id, name, code, description } = req.body || {};
  if (!name || !code) return res.status(400).json({ error: 'name and code required' });
  const scripts = readScripts();
  const now = Date.now();
  if (id) {
    const idx = scripts.findIndex(s => s.id === id);
    if (idx >= 0) scripts[idx] = { ...scripts[idx], name, description, code, updated: now };
    else scripts.push({ id, name, description, code, created: now, updated: now });
  } else {
    const crypto = require('crypto');
    scripts.push({ id: crypto.randomUUID(), name, description, code, created: now, updated: now });
  }
  writeScripts(scripts);
  res.json({ ok: true, scripts });
});

app.delete('/api/scripts/:id', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const scripts = readScripts().filter(s => s.id !== req.params.id);
  writeScripts(scripts);
  res.json({ ok: true });
});

// ── Image upload routes ───────────────────────────────────────────────────────

// GET  /api/upload/check/:type?id=...&name=...  — check if a custom image exists
app.get('/api/upload/check/:type', auth.requireAuth, (req, res) => {
  const { type } = req.params;
  const dirMap = { item: 'items', npc: 'npcs', mob: 'mobs' };
  const dir = dirMap[type];
  if (!dir) return res.status(400).json({ error: 'invalid type' });
  let key;
  if (type === 'mob') {
    const rawName = req.query.name || '';
    key = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  } else {
    key = req.query.id || '';
  }
  if (!key) return res.status(400).json({ error: 'id or name required' });
  const baseDir = path.join(UPLOADS_DIR, dir);
  let foundUrl = null;
  ['png','jpg','gif','webp'].forEach(ext => {
    if (!foundUrl && fs.existsSync(path.join(baseDir, `${key}.${ext}`))) {
      foundUrl = `/uploads/${dir}/${key}.${ext}`;
    }
  });
  res.json({ exists: !!foundUrl, url: foundUrl });
});

// DELETE /api/upload/:type?id=...&name=...  — remove a custom image (admin only)
// For items/npcs: ?id=<number>   For mobs: ?name=<name>
app.delete('/api/upload/:type', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const { type } = req.params;
  const dirMap = { item: 'items', npc: 'npcs', mob: 'mobs' };
  const dir = dirMap[type];
  if (!dir) return res.status(400).json({ error: 'invalid type' });
  let key;
  if (type === 'mob') {
    const rawName = req.query.name || '';
    key = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  } else {
    key = req.query.id || '';
  }
  if (!key) return res.status(400).json({ error: 'id or name required' });
  const baseDir = path.join(UPLOADS_DIR, dir);
  let deleted = false;
  ['png','jpg','gif','webp'].forEach(ext => {
    const f = path.join(baseDir, key + '.' + ext);
    if (fs.existsSync(f)) { fs.unlinkSync(f); deleted = true; }
  });
  res.json({ ok: true, deleted });
});

// POST /api/upload/map/:zoneid   — upload/replace a zone map (admin only)
app.post('/api/upload/map/:zoneid', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  const zoneid = parseInt(req.params.zoneid);
  if (isNaN(zoneid)) return res.status(400).json({ error: 'invalid zone id' });
  // Look up zone name to generate proper filename
  let zoneName;
  try {
    const [[row]] = await pool.execute('SELECT name FROM zone_settings WHERE zoneid=?', [zoneid]);
    if (!row) return res.status(404).json({ error: 'zone not found' });
    zoneName = normZoneName(row.name);
  } catch (e) { return res.status(500).json({ error: e.message }); }
  const ext = (req.query.ext || 'png').replace(/[^a-z]/g, '') || 'png';
  req._uploadFilename = `${zoneName}.${ext}`;
  makeUploader(MAPS_DIR)(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    buildZoneMaps(); // rebuild mapping
    res.json({ ok: true, file: req.file.filename, url: `/maps/${req.file.filename}` });
  });
});

// POST /api/upload/item/:itemid  — upload/replace an item image (admin only)
app.post('/api/upload/item/:itemid', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const itemid = parseInt(req.params.itemid);
  if (isNaN(itemid)) return res.status(400).json({ error: 'invalid item id' });
  req._uploadFilename = `${itemid}.png`;
  makeUploader(path.join(UPLOADS_DIR, 'items'))(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    // Rename to correct extension from mime type
    const mimeExt = { 'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp' };
    const ext = mimeExt[req.file.mimetype] || 'png';
    const newName = `${itemid}.${ext}`;
    if (newName !== req.file.filename) {
      fs.renameSync(req.file.path, path.join(UPLOADS_DIR, 'items', newName));
    }
    res.json({ ok: true, url: `/uploads/items/${newName}` });
  });
});

// POST /api/upload/npc/:npcid   — upload/replace an NPC image (admin only)
app.post('/api/upload/npc/:npcid', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const npcid = parseInt(req.params.npcid);
  if (isNaN(npcid)) return res.status(400).json({ error: 'invalid npc id' });
  req._uploadFilename = `${npcid}.png`;
  makeUploader(path.join(UPLOADS_DIR, 'npcs'))(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    const mimeExt = { 'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp' };
    const ext = mimeExt[req.file.mimetype] || 'png';
    const newName = `${npcid}.${ext}`;
    if (newName !== req.file.filename) {
      fs.renameSync(req.file.path, path.join(UPLOADS_DIR, 'npcs', newName));
    }
    res.json({ ok: true, url: `/uploads/npcs/${newName}` });
  });
});

// POST /api/upload/mob?name=...  — upload/replace a mob image keyed by mob name (admin only)
app.post('/api/upload/mob', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const rawName = req.query.name || '';
  if (!rawName) return res.status(400).json({ error: 'name required' });
  const key = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  req._uploadFilename = `${key}.png`;
  makeUploader(path.join(UPLOADS_DIR, 'mobs'))(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    const mimeExt = { 'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp' };
    const ext = mimeExt[req.file.mimetype] || 'png';
    const newName = `${key}.${ext}`;
    if (newName !== req.file.filename) {
      fs.renameSync(req.file.path, path.join(UPLOADS_DIR, 'mobs', newName));
    }
    res.json({ ok: true, url: `/uploads/mobs/${newName}`, key });
  });
});

// ── Windower client → dashboard position ingestion ────────────────────────────
app.post('/api/windower/position', (req, res) => {
  if (!WINDOWER_API_KEY || req.headers['x-windower-key'] !== WINDOWER_API_KEY)
    return res.status(401).json({ error: 'unauthorized' });

  const { name, zone, x, y, z, map_index, hp, mp, tp } = req.body || {};
  if (!name || zone == null || x == null || z == null)
    return res.status(400).json({ error: 'name, zone, x, z required' });

  const entry = {
    name:      String(name),
    zone:      parseInt(zone),
    x:         parseFloat(x),
    y:         parseFloat(y ?? 0),
    z:         parseFloat(z),
    map_index: parseInt(map_index ?? 0),  // floor/layer for multi-floor zones
    hp:        parseInt(hp ?? 0),
    mp:        parseInt(mp ?? 0),
    tp:        parseInt(tp ?? 0),
    ts:        Date.now(),
  };
  windowerPositions.set(entry.name, entry);

  // Push immediately to clients watching this zone
  const zonePlayers = [...windowerPositions.values()].filter(p => p.zone === entry.zone);
  broadcastToZone(entry.zone, 'zone_players', { zoneId: entry.zone, players: zonePlayers });
  broadcast('windower_positions', Object.fromEntries(windowerPositions));

  res.json({ ok: true });
});

// ── Windower zone entity dump ──────────────────────────────────────────────────
// Receives all NPCs/mobs in a zone captured client-side on zone change.
app.post('/api/windower/zone_entities', (req, res) => {
  if (!WINDOWER_API_KEY || req.headers['x-windower-key'] !== WINDOWER_API_KEY)
    return res.status(401).json({ error: 'unauthorized' });

  const { zone, entities } = req.body || {};
  if (zone == null || !Array.isArray(entities))
    return res.status(400).json({ error: 'zone and entities[] required' });

  const zoneId = parseInt(zone);
  const record = {
    ts:       Date.now(),
    entities: entities.map(e => ({
      id:         parseInt(e.id   ?? 0),
      index:      parseInt(e.index ?? 0),
      name:       String(e.name   ?? ''),
      x:          parseFloat(e.x  ?? 0),
      y:          parseFloat(e.y  ?? 0),
      z:          parseFloat(e.z  ?? 0),
      spawn_type: String(e.spawn_type ?? 'npc'),
      model_id:   parseInt(e.model_id ?? 0),
    })),
  };

  windowerZoneEntities.set(zoneId, record);
  broadcastToZone(zoneId, 'zone_entities', { zoneId, ...record });

  res.json({ ok: true, count: record.entities.length });
});

// Return cached entity dump for a zone
app.get('/api/windower/zone_entities/:zoneId', auth.requireAuth, (req, res) => {
  const zoneId = parseInt(req.params.zoneId);
  const record = windowerZoneEntities.get(zoneId);
  if (!record) return res.status(404).json({ error: 'no entity data for this zone' });
  res.json({ zoneId, ...record });
});

// Claude API proxy — Windower addon posts here to avoid TLS issues under Wine
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
app.post('/api/claude', async (req, res) => {
  if (!WINDOWER_API_KEY || req.headers['x-windower-key'] !== WINDOWER_API_KEY)
    return res.status(403).json({ error: 'forbidden' });
  if (!ANTHROPIC_API_KEY)
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on server' });

  const { message, system, model, max_tokens } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const ALLOWED_MODELS = new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']);
  const safeModel = ALLOWED_MODELS.has(model) ? model : 'claude-sonnet-4-6';
  const safeMaxTokens = Math.min(Math.max(1, parseInt(max_tokens) || 1024), 2048);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: safeModel,
        max_tokens: safeMaxTokens,
        system: system || 'You are a helpful assistant embedded in Final Fantasy XI. Be concise.',
        messages: [{ role: 'user', content: message }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Claude API error' });
    res.json({ reply: data.content?.[0]?.text || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
// EXP needed per level (from exp_base; index = current level, value = XP to reach next level)
let EXP_PER_LEVEL = [];
async function loadExpTable() {
  try {
    const [rows] = await pool.execute('SELECT level, exp FROM exp_base ORDER BY level');
    EXP_PER_LEVEL = [];
    rows.forEach(r => { EXP_PER_LEVEL[r.level] = r.exp; });
    console.log(`[exp] loaded ${rows.length} level thresholds`);
  } catch (e) {
    console.error('[exp] DB unavailable, exp table not loaded:', e.message);
  }
}

buildZoneMaps().then(() => loadExpTable()).then(async () => {
  startPosWatcher();
  // Load in-memory catalogs before opening port
  await Promise.all([loadMobCatalog(), loadNpcCatalog(), loadZoneCache()]);
  // Refresh catalogs every 5 minutes (player counts every 30s)
  setInterval(loadZoneCache, 30_000);
  setInterval(() => { loadMobCatalog(); loadNpcCatalog(); }, 5 * 60_000);
  server.listen(PORT, () => console.log(`FFXI Dashboard running on port ${PORT}`));
});
