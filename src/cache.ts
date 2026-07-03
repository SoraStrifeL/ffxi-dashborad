import Redis from 'ioredis';

export const WIKI_TTL = 24 * 60 * 60;   // 24 h in seconds
export const ITEM_TYPES_TTL = 10 * 60;  // 10 min
export const STATS_TTL = 5;             // 5 s

let client: Redis | null = null;
let redisUp = false;

// ── In-memory fallback ────────────────────────────────────────────────
// Bare-metal / non-Docker deployments often have no Redis. Rather than
// degrade (no wiki cache, and — since this session — broken refresh
// tokens), fall back to a per-process Map with TTLs. Single-instance
// deployments behave identically; only horizontal scaling needs Redis.
const mem = new Map<string, { v: string; exp: number }>();

function memGet(key: string): string | null {
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.delete(key); return null; }
  return e.v;
}
function memSet(key: string, value: string, ttlSeconds: number): void {
  mem.set(key, { v: value, exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
}

// Sweep expired in-memory entries so the Map can't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of mem) if (e.exp && e.exp < now) mem.delete(k);
}, 60_000).unref?.();

function useRedis(): boolean { return !!client && redisUp; }

export function initRedis(): void {
  // No REDIS_URL and no explicit opt-in → skip Redis entirely, use memory.
  // (Docker sets REDIS_URL; bare-metal usually doesn't.)
  if (!process.env.REDIS_URL && process.env.USE_REDIS !== '1') {
    console.log('[cache] REDIS_URL unset — using in-memory cache (single-instance).');
    return;
  }
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const r = new Redis(url, {
    lazyConnect:          true,
    maxRetriesPerRequest: 1,
    connectTimeout:       3000,
    enableOfflineQueue:   false,
  });
  let warned = false;
  r.on('ready',   () => { redisUp = true;  warned = false; console.log('[cache] Redis ready:', url); });
  r.on('end',     () => { redisUp = false; });
  r.on('error',   (e: Error) => {
    redisUp = false;
    if (!warned) { warned = true; console.warn('[cache] Redis unavailable, using in-memory cache:', e.message); }
  });
  client = r;
  r.connect().catch(() => { /* errors reported via 'error' event; memory fallback active */ });
}

export function redisClient(): Redis | null { return useRedis() ? client : null; }

export async function cacheGet(key: string): Promise<string | null> {
  if (!useRedis()) return memGet(key);
  try { return await client!.get(key); }
  catch { return memGet(key); }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!useRedis()) { memSet(key, value, ttlSeconds); return; }
  try { await client!.set(key, value, 'EX', ttlSeconds); }
  catch { memSet(key, value, ttlSeconds); }
}

export async function cacheDel(key: string): Promise<void> {
  mem.delete(key);
  if (!useRedis()) return;
  try { await client!.del(key); }
  catch { /* non-fatal */ }
}

export async function cacheGetJSON<T>(key: string): Promise<T | null> {
  const raw = await cacheGet(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as T; }
  catch { return null; }
}

export async function cacheSetJSON(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await cacheSet(key, JSON.stringify(value), ttlSeconds);
}
