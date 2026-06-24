"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATS_TTL = exports.ITEM_TYPES_TTL = exports.WIKI_TTL = void 0;
exports.initRedis = initRedis;
exports.redisClient = redisClient;
exports.cacheGet = cacheGet;
exports.cacheSet = cacheSet;
exports.cacheDel = cacheDel;
exports.cacheGetJSON = cacheGetJSON;
exports.cacheSetJSON = cacheSetJSON;
const ioredis_1 = __importDefault(require("ioredis"));
exports.WIKI_TTL = 24 * 60 * 60; // 24 h in seconds
exports.ITEM_TYPES_TTL = 10 * 60; // 10 min
exports.STATS_TTL = 5; // 5 s
let client = null;
function initRedis() {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    const r = new ioredis_1.default(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 3000,
        enableOfflineQueue: false,
    });
    r.on('ready', () => console.log('[cache] Redis ready:', url));
    r.on('error', (e) => console.warn('[cache] Redis error:', e.message));
    r.on('reconnecting', () => console.warn('[cache] Redis reconnecting…'));
    client = r;
    r.connect().catch(() => { });
}
function redisClient() { return client; }
async function cacheGet(key) {
    if (!client)
        return null;
    try {
        return await client.get(key);
    }
    catch {
        return null;
    }
}
async function cacheSet(key, value, ttlSeconds) {
    if (!client)
        return;
    try {
        await client.set(key, value, 'EX', ttlSeconds);
    }
    catch { /* non-fatal */ }
}
async function cacheDel(key) {
    if (!client)
        return;
    try {
        await client.del(key);
    }
    catch { /* non-fatal */ }
}
async function cacheGetJSON(key) {
    const raw = await cacheGet(key);
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
async function cacheSetJSON(key, value, ttlSeconds) {
    await cacheSet(key, JSON.stringify(value), ttlSeconds);
}
