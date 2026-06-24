import Redis from 'ioredis';

export const WIKI_TTL = 24 * 60 * 60;   // 24 h in seconds
export const ITEM_TYPES_TTL = 10 * 60;  // 10 min
export const STATS_TTL = 5;             // 5 s

let client: Redis | null = null;

export function initRedis(): void {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const r = new Redis(url, {
    lazyConnect:          true,
    maxRetriesPerRequest: 1,
    connectTimeout:       3000,
    enableOfflineQueue:   false,
  });
  r.on('ready',        () => console.log('[cache] Redis ready:', url));
  r.on('error',        (e: Error) => console.warn('[cache] Redis error:', e.message));
  r.on('reconnecting', () => console.warn('[cache] Redis reconnecting…'));
  client = r;
  r.connect().catch(() => { /* errors reported via 'error' event */ });
}

export function redisClient(): Redis | null { return client; }

export async function cacheGet(key: string): Promise<string | null> {
  if (!client) return null;
  try { return await client.get(key); }
  catch { return null; }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!client) return;
  try { await client.set(key, value, 'EX', ttlSeconds); }
  catch { /* non-fatal */ }
}

export async function cacheDel(key: string): Promise<void> {
  if (!client) return;
  try { await client.del(key); }
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
