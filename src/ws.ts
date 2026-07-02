import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { WsClientState } from './types';
import { queryStats, queryPlayers, LSB_LOG_DIR } from './catalog';
import { verifyToken } from './auth';
import { hasPermission } from './rbac';
import { setBroadcastAuditEvent } from './audit';

type PosEntry = { i: number; n: string; x: number; y: number; z: number; z_id: number };

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
// Keyed by id:status (a deferred row that later completes must broadcast again);
// entries are pruned by age, not cleared wholesale, so rows still inside the 20 s
// query window can't be re-sent as duplicates.
const sentQueueKeys = new Map<string, number>();

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
      const key = `${row.id}:${row.status}`;
      if (sentQueueKeys.has(key)) continue;
      sentQueueKeys.set(key, Date.now());
      const login = row.requested_by as string;
      const msg = JSON.stringify({ type: 'queue_update', data: row, ts: Date.now() });
      clients.forEach((state, ws) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (state.user.tier === 'admin' || state.user.login === login)
          ws.send(msg);
      });
    }
    // Prune keys older than 60 s — their rows have left the 20 s query window
    const cutoff = Date.now() - 60_000;
    sentQueueKeys.forEach((t, k) => { if (t < cutoff) sentQueueKeys.delete(k); });
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
const LOG_DIR = LSB_LOG_DIR;
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
import path from 'path';
export const POS_FILE = path.join(LSB_LOG_DIR, 'dashboard_positions.json');

export function startPosWatcher(): void {
  if (!fs.existsSync(POS_FILE)) { setTimeout(startPosWatcher, 10_000); return; }
  console.log('[pos] watching', POS_FILE);
  let lastMtime = 0;
  setInterval(() => {
    try {
      const { mtimeMs } = fs.statSync(POS_FILE);
      if (mtimeMs <= lastMtime) return;
      lastMtime = mtimeMs;
      if (clients.size === 0) return;
      const raw = fs.readFileSync(POS_FILE, 'utf8');
      const pos = JSON.parse(raw) as { players?: PosEntry[]; npcs?: PosEntry[]; mobs?: PosEntry[] };
      const players = pos.players ?? [];
      const npcs    = pos.npcs    ?? [];
      const mobs    = pos.mobs    ?? [];

      // Zone-watching clients receive one positions message with fully filtered data.
      const watched = new Set<number>();
      clients.forEach(s => { if (s.watchZone != null) watched.add(s.watchZone); });
      watched.forEach(zid => {
        broadcastToZone(zid, 'positions', {
          players: players.filter(e => e.z_id === zid),
          npcs:    npcs.filter(e => e.z_id === zid),
          mobs:    mobs.filter(e => e.z_id === zid),
        });
      });
      // Non-zone-watching clients get player positions only (chars-panel zone tracking).
      // Always send even when players is empty so the chars panel clears on logout.
      const posMsg = JSON.stringify({ type: 'positions', data: { players, npcs: [], mobs: [] }, ts: Date.now() });
      clients.forEach((state, ws) => {
        if (ws.readyState === WebSocket.OPEN && state.watchZone == null) ws.send(posMsg);
      });
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
        if (type === 'watch_zone') {
          const z = Number(data?.zoneId);
          state.watchZone = Number.isFinite(z) ? z : null;
        }
        if (type === 'unwatch_zone') state.watchZone = null;
        if (type === 'pong') wsAlive.set(ws, true);
        if (type === 'log_sub' && hasPermission(state.user.tier, 'run:console', state.user.accid))
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
