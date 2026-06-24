"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.POS_FILE = exports.logTails = exports.LOG_FILES = exports.clients = void 0;
exports.broadcast = broadcast;
exports.broadcastToZone = broadcastToZone;
exports.broadcastToAdmins = broadcastToAdmins;
exports.broadcastToUser = broadcastToUser;
exports.pollAndBroadcast = pollAndBroadcast;
exports.ensureLogTail = ensureLogTail;
exports.subscribeLog = subscribeLog;
exports.unsubscribeLog = unsubscribeLog;
exports.startPosWatcher = startPosWatcher;
exports.initWebSocket = initWebSocket;
const fs_1 = __importDefault(require("fs"));
const child_process_1 = require("child_process");
const ws_1 = __importDefault(require("ws"));
const catalog_1 = require("./catalog");
const auth_1 = require("./auth");
const rbac_1 = require("./rbac");
const audit_1 = require("./audit");
// ── WebSocket state ────────────────────────────────────────────────────────────
exports.clients = new Map();
// Track heartbeat liveness per socket (WeakMap so GC can clean up dead sockets)
const wsAlive = new WeakMap();
// ── Broadcast helpers ──────────────────────────────────────────────────────────
function broadcast(type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    exports.clients.forEach((_, ws) => {
        if (ws.readyState === ws_1.default.OPEN)
            ws.send(msg);
    });
}
function broadcastToZone(zoneId, type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    exports.clients.forEach((state, ws) => {
        if (ws.readyState === ws_1.default.OPEN && state.watchZone == Number(zoneId))
            ws.send(msg);
    });
}
function broadcastToAdmins(type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    exports.clients.forEach((state, ws) => {
        if (ws.readyState === ws_1.default.OPEN && state.user.tier === 'admin')
            ws.send(msg);
    });
}
function broadcastToUser(login, type, data) {
    const msg = JSON.stringify({ type, data, ts: Date.now() });
    exports.clients.forEach((state, ws) => {
        if (ws.readyState === ws_1.default.OPEN && state.user.login === login)
            ws.send(msg);
    });
}
// ── Heartbeat (30s ping, terminate if no pong after 30s) ──────────────────────
function startHeartbeat(wss) {
    setInterval(() => {
        wss.clients.forEach(ws => {
            if (wsAlive.get(ws) === false) {
                ws.terminate();
                return;
            }
            wsAlive.set(ws, false);
            ws.ping();
        });
    }, 30000);
}
// ── Player login/logout detection ──────────────────────────────────────────────
let lastOnlineIds = null;
// ── Queue update polling ───────────────────────────────────────────────────────
const sentQueueIds = new Set();
let lastQueueIdClean = Date.now();
async function pollQueueUpdates(pool) {
    if (exports.clients.size === 0)
        return;
    try {
        const [rows] = await pool.execute(`SELECT id, charid, action, status, result, requested_by
       FROM dashboard_queue
       WHERE processed_at >= NOW() - INTERVAL 20 SECOND
         AND status IN ('complete', 'failed', 'deferred')
       ORDER BY id ASC LIMIT 30`);
        for (const row of rows) {
            const id = row.id;
            if (sentQueueIds.has(id))
                continue;
            sentQueueIds.add(id);
            const login = row.requested_by;
            const msg = JSON.stringify({ type: 'queue_update', data: row, ts: Date.now() });
            exports.clients.forEach((state, ws) => {
                if (ws.readyState !== ws_1.default.OPEN)
                    return;
                if (state.user.tier === 'admin' || state.user.login === login)
                    ws.send(msg);
            });
        }
        // Prune stale IDs every 2 minutes
        if (Date.now() - lastQueueIdClean > 120000) {
            sentQueueIds.clear();
            lastQueueIdClean = Date.now();
        }
    }
    catch (_) { }
}
// ── Live poll ──────────────────────────────────────────────────────────────────
let lastState = {};
async function pollAndBroadcast(pool) {
    if (exports.clients.size === 0)
        return;
    try {
        const [stats, players] = await Promise.all([(0, catalog_1.queryStats)(pool), (0, catalog_1.queryPlayers)(pool)]);
        if (JSON.stringify(stats) !== JSON.stringify(lastState.stats)) {
            broadcast('stats', stats);
            lastState.stats = stats;
        }
        const playersKey = JSON.stringify(players.map(p => ({ id: p.charid, x: p.pos_x, z: p.pos_z, zone: p.pos_zone, hp: p.hp, mp: p.mp })));
        if (playersKey !== lastState.playersKey) {
            broadcast('players', players);
            lastState.playersKey = playersKey;
            // Login/logout events (skip first poll so we don't flood on startup)
            const currentIds = new Set(players.map(p => p.charid));
            if (lastOnlineIds !== null) {
                players
                    .filter(p => !lastOnlineIds.has(p.charid))
                    .forEach(p => broadcastToAdmins('player_event', {
                    event: 'login', charid: p.charid, charname: p.charname, zone: p.pos_zone,
                }));
                [...lastOnlineIds]
                    .filter(id => !currentIds.has(id))
                    .forEach(id => broadcastToAdmins('player_event', { event: 'logout', charid: id }));
            }
            lastOnlineIds = currentIds;
            const byZone = {};
            players.forEach(p => { (byZone[p.pos_zone] = byZone[p.pos_zone] || []).push(p); });
            Object.entries(byZone).forEach(([zoneId, zonePlayers]) => {
                broadcastToZone(zoneId, 'zone_players', { zoneId, players: zonePlayers });
            });
        }
        await pollQueueUpdates(pool);
    }
    catch (e) {
        console.error('[poll]', e.message);
    }
}
// ── Server log streaming ───────────────────────────────────────────────────────
const LOG_DIR = '/ffxi-log';
exports.LOG_FILES = {
    map: 'map-server.log',
    world: 'world-server.log',
    connect: 'connect-server.log',
    search: 'search-server.log',
};
exports.logTails = new Map();
function ensureLogTail(fileKey) {
    if (exports.logTails.has(fileKey))
        return;
    const proc = (0, child_process_1.spawn)('tail', ['-n', '100', '-f', `${LOG_DIR}/${exports.LOG_FILES[fileKey]}`]);
    const entry = { proc, subs: new Set() };
    exports.logTails.set(fileKey, entry);
    proc.stdout?.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        const msg = JSON.stringify({ type: 'log', data: { file: fileKey, lines }, ts: Date.now() });
        entry.subs.forEach(ws => { if (ws.readyState === ws_1.default.OPEN)
            ws.send(msg); });
    });
    proc.stdout?.on('error', (e) => console.error(`[log:${fileKey}] stdout error:`, e.message));
    proc.on('error', (e) => console.error(`[log:${fileKey}]`, e.message));
}
function subscribeLog(ws, fileKey) {
    if (!exports.LOG_FILES[fileKey])
        return;
    const state = exports.clients.get(ws);
    if (!state)
        return;
    if (state.logSub === fileKey)
        return;
    if (state.logSub)
        unsubscribeLog(ws);
    state.logSub = fileKey;
    ensureLogTail(fileKey);
    exports.logTails.get(fileKey).subs.add(ws);
}
function unsubscribeLog(ws) {
    const state = exports.clients.get(ws);
    if (!state?.logSub)
        return;
    const entry = exports.logTails.get(state.logSub);
    if (entry) {
        entry.subs.delete(ws);
        if (entry.subs.size === 0) {
            entry.proc.kill();
            exports.logTails.delete(state.logSub);
        }
    }
    state.logSub = null;
}
// ── Live position feed ─────────────────────────────────────────────────────────
exports.POS_FILE = '/ffxi-log/dashboard_positions.json';
function startPosWatcher() {
    if (!fs_1.default.existsSync(exports.POS_FILE)) {
        setTimeout(startPosWatcher, 10000);
        return;
    }
    console.log('[pos] watching', exports.POS_FILE);
    let lastMtime = 0;
    setInterval(() => {
        try {
            const { mtimeMs } = fs_1.default.statSync(exports.POS_FILE);
            if (mtimeMs <= lastMtime)
                return;
            lastMtime = mtimeMs;
            const raw = fs_1.default.readFileSync(exports.POS_FILE, 'utf8');
            const positions = JSON.parse(raw);
            if (exports.clients.size > 0)
                broadcast('positions', positions);
        }
        catch (_) { }
    }, 1000);
}
// ── WebSocket connection handler ───────────────────────────────────────────────
function initWebSocket(wss, pool) {
    startHeartbeat(wss);
    // Wire audit broadcast so every audit() call also pushes to admin WS clients
    (0, audit_1.setBroadcastAuditEvent)(entry => broadcastToAdmins('audit_event', entry));
    wss.on('connection', (ws) => {
        wsAlive.set(ws, true);
        ws.on('pong', () => wsAlive.set(ws, true));
        console.log('[ws] client connected (%d total)', wss.clients.size);
        const authTimeout = setTimeout(() => {
            if (!exports.clients.has(ws))
                ws.close(1008, 'auth timeout');
        }, 5000);
        async function acceptAuth(token) {
            let user;
            try {
                user = (0, auth_1.verifyToken)(token);
            }
            catch (_) {
                ws.close(1008, 'invalid token');
                return;
            }
            clearTimeout(authTimeout);
            exports.clients.set(ws, { watchZone: null, logSub: null, user });
            try {
                const [stats, players] = await Promise.all([(0, catalog_1.queryStats)(pool), (0, catalog_1.queryPlayers)(pool)]);
                if (ws.readyState === ws_1.default.OPEN) {
                    ws.send(JSON.stringify({ type: 'stats', data: stats, ts: Date.now() }));
                    ws.send(JSON.stringify({ type: 'players', data: players, ts: Date.now() }));
                }
            }
            catch (e) {
                console.error('[ws init]', e.message);
            }
        }
        ws.on('message', (msg) => {
            try {
                const { type, data } = JSON.parse(msg.toString());
                if (!exports.clients.has(ws)) {
                    if (type === 'auth' && data?.token)
                        acceptAuth(data.token);
                    return;
                }
                const state = exports.clients.get(ws);
                if (type === 'watch_zone')
                    state.watchZone = data.zoneId;
                if (type === 'pong')
                    wsAlive.set(ws, true);
                if (type === 'log_sub' && (0, rbac_1.hasPermission)(state.user.tier, 'run:console'))
                    subscribeLog(ws, data.file);
                if (type === 'log_unsub')
                    unsubscribeLog(ws);
            }
            catch (_) { }
        });
        ws.on('close', () => {
            clearTimeout(authTimeout);
            unsubscribeLog(ws);
            exports.clients.delete(ws);
            console.log('[ws] client disconnected');
        });
    });
}
