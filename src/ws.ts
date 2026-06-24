import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { WsClientState } from './types';
import { queryStats, queryPlayers } from './catalog';
import { verifyToken } from './auth';
import { hasPermission } from './rbac';
import { setBroadcastAuditEvent } from './audit';

// ── WebSocket state ────────────────────────────────────────────────────────────
export const clients = new Map<WebSocket, WsClientState>();

// Track heartbeat liveness per socket (WeakMap so GC can clean up dead sockets)
const wsAlive = new WeakMap<WebSocket, boolean>();

// ── Broadcast helpers ──────────────────────────────────────────────────────────
export function broadcast(type: string, data: unknown): void {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  clients.forEach((_, ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

export function broadcastToZone(zoneId: number | string, type: string, data: unknown): void {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  clients.forEach((state, ws) => {
    if (ws.readyState === WebSocket.OPEN && state.watchZone == Number(zoneId)) ws.send(msg);
  });
}

export function broadcastToAdmins(type: string, data: unknown): void {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  clients.forEach((state, ws) => {
    if (ws.readyState === WebSocket.OPEN && state.user.tier === 'admin') ws.send(msg);
  });
}

export function broadcastToUser(login: string, type: string, data: unknown): void {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  clients.forEach((state, ws) => {
    if (ws.readyState === WebSocket.OPEN && state.user.login === login) ws.send(msg);
  });
}


// ── Heartbeat (30s ping, terminate if no pong after 30s) ──────────────────────
function startHeartbeat(wss: WebSocket.Server): void {
  setInterval(() => {
    wss.clients.forEach(ws => {
      if (wsAlive.get(ws) === false) { ws.terminate(); return; }
      wsAlive.set(ws, false);
      ws.ping();
    });
  }, 30_000);
}

// ── Player login/logout detection ──────────────────────────────────────────────
let lastOnlineIds: Set<number> | null = null;

// ── Queue update polling ───────────────────────────────────────────────────────
const sentQueueIds = new Set<number>();
let lastQueueIdClean = Date.now();

async function pollQueueUpdates(pool: Pool): Promise<void> {
  if (clients.size === 0) return;
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, charid, action, status, result, requested_by
       FROM dashboard_queue
       WHERE processed_at >= NOW() - INTERVAL 20 SECOND
         AND status IN ('complete', 'failed', 'deferred')
       ORDER BY id ASC LIMIT 30`
    );
    for (const row of rows) {
      const id = row.id as number;
      if (sentQueueIds.has(id)) continue;
      sentQueueIds.add(id);
      const login = row.requested_by as string;
      const msg = JSON.stringify({ type: 'queue_update', data: row, ts: Date.now() });
      clients.forEach((state, ws) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (state.user.tier === 'admin' || state.user.login === login)
          ws.send(msg);
      });
    }
    // Prune stale IDs every 2 minutes
    if (Date.now() - lastQueueIdClean > 120_000) {
      sentQueueIds.clear();
      lastQueueIdClean = Date.now();
    }
  } catch (_) {}
}

// ── Live poll ──────────────────────────────────────────────────────────────────
let lastState: { stats?: unknown; playersKey?: string } = {};

export async function pollAndBroadcast(pool: Pool): Promise<void> {
  if (clients.size === 0) return;
  try {
    const [stats, players] = await Promise.all([queryStats(pool), queryPlayers(pool)]);

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

      // Login/logout events (skip first poll so we don't flood on startup)
      const currentIds = new Set(players.map(p => p.charid as number));
      if (lastOnlineIds !== null) {
        players
          .filter(p => !lastOnlineIds!.has(p.charid as number))
          .forEach(p => broadcastToAdmins('player_event', {
            event: 'login', charid: p.charid, charname: p.charname, zone: p.pos_zone,
          }));
        [...lastOnlineIds]
          .filter(id => !currentIds.has(id))
          .forEach(id => broadcastToAdmins('player_event', { event: 'logout', charid: id }));
      }
      lastOnlineIds = currentIds;

      const byZone: Record<string, typeof players> = {};
      players.forEach(p => { (byZone[p.pos_zone] = byZone[p.pos_zone] || []).push(p); });
      Object.entries(byZone).forEach(([zoneId, zonePlayers]) => {
        broadcastToZone(zoneId, 'zone_players', { zoneId, players: zonePlayers });
      });
    }

    await pollQueueUpdates(pool);
  } catch (e) {
    console.error('[poll]', (e as Error).message);
  }
}

// ── Server log streaming ───────────────────────────────────────────────────────
const LOG_DIR = '/ffxi-log';
export const LOG_FILES: Record<string, string> = {
  map:     'map-server.log',
  world:   'world-server.log',
  connect: 'connect-server.log',
  search:  'search-server.log',
};
export const logTails = new Map<string, { proc: ChildProcess; subs: Set<WebSocket> }>();

export function ensureLogTail(fileKey: string): void {
  if (logTails.has(fileKey)) return;
  const proc = spawn('tail', ['-n', '100', '-f', `${LOG_DIR}/${LOG_FILES[fileKey]}`]);
  const entry = { proc, subs: new Set<WebSocket>() };
  logTails.set(fileKey, entry);
  proc.stdout?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    const msg = JSON.stringify({ type: 'log', data: { file: fileKey, lines }, ts: Date.now() });
    entry.subs.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
  });
  proc.stdout?.on('error', (e: Error) => console.error(`[log:${fileKey}] stdout error:`, e.message));
  proc.on('error', (e: Error) => console.error(`[log:${fileKey}]`, e.message));
}

export function subscribeLog(ws: WebSocket, fileKey: string): void {
  if (!LOG_FILES[fileKey]) return;
  const state = clients.get(ws);
  if (!state) return;
  if (state.logSub === fileKey) return;
  if (state.logSub) unsubscribeLog(ws);
  state.logSub = fileKey;
  ensureLogTail(fileKey);
  logTails.get(fileKey)!.subs.add(ws);
}

export function unsubscribeLog(ws: WebSocket): void {
  const state = clients.get(ws);
  if (!state?.logSub) return;
  const entry = logTails.get(state.logSub);
  if (entry) {
    entry.subs.delete(ws);
    if (entry.subs.size === 0) { entry.proc.kill(); logTails.delete(state.logSub); }
  }
  state.logSub = null;
}

// ── Live position feed ─────────────────────────────────────────────────────────
export const POS_FILE = '/ffxi-log/dashboard_positions.json';

export function startPosWatcher(): void {
  if (!fs.existsSync(POS_FILE)) { setTimeout(startPosWatcher, 10_000); return; }
  console.log('[pos] watching', POS_FILE);
  let lastMtime = 0;
  setInterval(() => {
    try {
      const { mtimeMs } = fs.statSync(POS_FILE);
      if (mtimeMs <= lastMtime) return;
      lastMtime = mtimeMs;
      const raw = fs.readFileSync(POS_FILE, 'utf8');
      const positions = JSON.parse(raw) as unknown;
      if (clients.size > 0) broadcast('positions', positions);
    } catch (_) {}
  }, 1000);
}

// ── WebSocket connection handler ───────────────────────────────────────────────
export function initWebSocket(wss: WebSocket.Server, pool: Pool): void {
  startHeartbeat(wss);

  // Wire audit broadcast so every audit() call also pushes to admin WS clients
  setBroadcastAuditEvent(entry => broadcastToAdmins('audit_event', entry));

  wss.on('connection', (ws: WebSocket) => {
    wsAlive.set(ws, true);
    ws.on('pong', () => wsAlive.set(ws, true));
    console.log('[ws] client connected (%d total)', wss.clients.size);

    const authTimeout = setTimeout(() => {
      if (!clients.has(ws)) ws.close(1008, 'auth timeout');
    }, 5000);

    async function acceptAuth(token: string): Promise<void> {
      let user;
      try { user = verifyToken(token); }
      catch (_) { ws.close(1008, 'invalid token'); return; }

      clearTimeout(authTimeout);
      clients.set(ws, { watchZone: null, logSub: null, user });

      try {
        const [stats, players] = await Promise.all([queryStats(pool), queryPlayers(pool)]);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'stats',   data: stats,   ts: Date.now() }));
          ws.send(JSON.stringify({ type: 'players', data: players, ts: Date.now() }));
        }
      } catch (e) { console.error('[ws init]', (e as Error).message); }
    }

    ws.on('message', (msg: Buffer) => {
      try {
        const { type, data } = JSON.parse(msg.toString()) as { type: string; data: Record<string, unknown> };
        if (!clients.has(ws)) {
          if (type === 'auth' && data?.token) acceptAuth(data.token as string);
          return;
        }
        const state = clients.get(ws)!;
        if (type === 'watch_zone') state.watchZone = data.zoneId as number;
        if (type === 'pong') wsAlive.set(ws, true);
        if (type === 'log_sub' && hasPermission(state.user.tier, 'run:console'))
          subscribeLog(ws, data.file as string);
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
}
