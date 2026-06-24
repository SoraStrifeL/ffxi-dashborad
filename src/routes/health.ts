import { Router } from 'express';
import { Pool } from 'mysql2/promise';
import { requireAuth } from '../auth';
import { requirePermission, ROLE_PERMISSIONS } from '../rbac';
import { redisClient } from '../cache';
import { listPlugins } from '../plugin';
import { version } from '../../package.json';

const startTime = Date.now();

export function createHealthRouter(pool: Pool): Router {
  const router = Router();

  // ── Health check (public) ──────────────────────────────────────────────────
  router.get('/api/health', async (_req, res) => {
    const mem = process.memoryUsage();
    let dbOk = false;
    let redisOk = false;
    try {
      await pool.execute('SELECT 1');
      dbOk = true;
    } catch {}
    try {
      const r = redisClient();
      if (r) { await r.ping(); redisOk = true; }
    } catch {}

    const status = dbOk ? 200 : 503;
    res.status(status).json({
      status:    dbOk ? 'ok' : 'degraded',
      version,
      uptime:    Math.floor((Date.now() - startTime) / 1000),
      db:        dbOk    ? 'ok' : 'unreachable',
      redis:     redisOk ? 'ok' : 'unavailable',
      plugins:   listPlugins(),
      memory: {
        heapUsedMb:  +(mem.heapUsed  / 1024 / 1024).toFixed(1),
        heapTotalMb: +(mem.heapTotal / 1024 / 1024).toFixed(1),
        rssMb:       +(mem.rss       / 1024 / 1024).toFixed(1),
      },
    });
  });

  // ── Current user's permissions ─────────────────────────────────────────────
  router.get('/api/me/permissions', requireAuth, (req, res) => {
    const tier = req.user!.tier;
    res.json({
      login:       req.user!.login,
      tier,
      permissions: ROLE_PERMISSIONS[tier] ?? [],
    });
  });

  // ── OpenAPI 3.0 spec ───────────────────────────────────────────────────────
  router.get('/api/openapi.json', requireAuth, requirePermission('view:accounts'), (_req, res) => {
    res.json(buildOpenApiSpec());
  });

  return router;
}

function buildOpenApiSpec(): object {
  return {
    openapi: '3.0.3',
    info: {
      title:       'FFXI Dashboard API',
      description: 'LandSandBoat server management dashboard REST API',
      version,
    },
    servers: [{ url: '/api', description: 'Dashboard API' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        Error:      { type: 'object', properties: { error: { type: 'string' } } },
        Ok:         { type: 'object', properties: { ok:    { type: 'boolean' } } },
        AuditEntry: {
          type: 'object',
          properties: {
            ts:     { type: 'string', format: 'date-time' },
            user:   { type: 'string' },
            action: { type: 'string' },
            target: { type: 'string' },
            meta:   { type: 'object' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/health': {
        get: {
          tags: ['system'], summary: 'Health check', security: [],
          responses: {
            '200': { description: 'Server healthy' },
            '503': { description: 'DB unreachable' },
          },
        },
      },
      '/login': {
        post: {
          tags: ['auth'], summary: 'Authenticate and get JWT', security: [],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['login', 'password'],
            properties: { login: { type: 'string' }, password: { type: 'string' } },
          }}}},
          responses: {
            '200': { description: 'JWT token', content: { 'application/json': { schema: {
              type: 'object', properties: { token: { type: 'string' }, tier: { type: 'string' }, login: { type: 'string' } },
            }}}},
            '401': { description: 'Invalid credentials' },
            '429': { description: 'Rate limited' },
          },
        },
      },
      '/me': {
        get: { tags: ['auth'], summary: 'Current user info', responses: { '200': { description: 'User and owned characters' } } },
      },
      '/me/permissions': {
        get: { tags: ['auth'], summary: 'Current user permissions', responses: { '200': { description: 'Tier and permission list' } } },
      },
      '/characters/{zone}': {
        get: {
          tags: ['characters'], summary: 'List characters in zone',
          parameters: [{ name: 'zone', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Character list' } },
        },
      },
      '/character/{charid}': {
        get: {
          tags: ['characters'], summary: 'Character detail',
          parameters: [{ name: 'charid', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Full character detail' }, '403': { description: 'Not your character' } },
        },
      },
      '/queue': {
        post: {
          tags: ['queue'], summary: 'Submit action to edit queue',
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['charid', 'action'],
            properties: {
              charid: { type: 'integer' }, action: { type: 'string' },
              params: { type: 'object' },
            },
          }}}},
          responses: { '200': { description: 'Queued' }, '403': { description: 'Permission denied' } },
        },
      },
      '/queue/recent/{charid}': {
        get: {
          tags: ['queue'], summary: 'Recent queue entries for character',
          parameters: [{ name: 'charid', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Queue entries' } },
        },
      },
      '/console': {
        post: {
          tags: ['admin'], summary: 'Execute Lua in map server VM',
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['cmd'], properties: { cmd: { type: 'string' } },
          }}}},
          responses: { '200': { description: 'Queue ID for polling' } },
        },
      },
      '/stats':   { get: { tags: ['map'], summary: 'Server stats (online count, uptime)',    responses: { '200': { description: 'Stats' } } } },
      '/players': { get: { tags: ['map'], summary: 'Currently online characters',            responses: { '200': { description: 'Players' } } } },
      '/maps':    { get: { tags: ['map'], summary: 'Available zone maps index',              responses: { '200': { description: 'Maps' } } } },
      '/zones':   { get: { tags: ['zones'], summary: 'All zones with names',                responses: { '200': { description: 'Zones' } } } },
      '/accounts': {
        get: { tags: ['admin'], summary: 'List all accounts', responses: { '200': { description: 'Accounts' } } },
      },
      '/accounts/{id}/status': {
        post: {
          tags: ['admin'], summary: 'Enable or disable an account',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['status'], properties: { status: { type: 'integer', enum: [0, 1] } },
          }}}},
          responses: { '200': { description: 'Updated' } },
        },
      },
      '/accounts/{id}/priv': {
        post: {
          tags: ['admin'], summary: 'Set account privilege level (0–5)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Updated' } },
        },
      },
      '/settings/rates': {
        get:  { tags: ['settings'], summary: 'Read all configured rates',       responses: { '200': { description: 'Rate entries with current values' } } },
        post: { tags: ['settings'], summary: 'Write a single rate value',       responses: { '200': { description: 'Updated' } } },
      },
      '/settings/variables': {
        get:  { tags: ['settings'], summary: 'Read server_variables table',     responses: { '200': { description: 'Variables' } } },
        post: { tags: ['settings'], summary: 'Upsert a server variable',        responses: { '200': { description: 'Updated' } } },
      },
      '/timers':            { get: { tags: ['timers'], summary: 'List pop timers',          responses: { '200': { description: 'Timers' } } } },
      '/db/items':          { get: { tags: ['db'], summary: 'Search items (paginated)',      responses: { '200': { description: 'Items' } } } },
      '/db/items/{itemid}': {
        get: {
          tags: ['db'], summary: 'Item detail with mods, drops, recipes',
          parameters: [{ name: 'itemid', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'Item detail' } },
        },
      },
      '/db/npcs':           { get: { tags: ['db'], summary: 'Search NPCs (in-memory)',       responses: { '200': { description: 'NPCs' } } } },
      '/db/mobs':           { get: { tags: ['db'], summary: 'Search mobs (in-memory)',       responses: { '200': { description: 'Mobs' } } } },
      '/db/quests':         { get: { tags: ['db'], summary: 'Search quests',                responses: { '200': { description: 'Quests' } } } },
      '/db/nms':            { get: { tags: ['timers'], summary: 'Search NMs by respawn time', responses: { '200': { description: 'NMs' } } } },
      '/roles':             { get: { tags: ['admin'], summary: 'Role→permission mapping',    responses: { '200': { description: 'Roles' } } } },
      '/audit': {
        get: {
          tags: ['admin'], summary: 'Audit log (newest first)',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 500 } }],
          responses: { '200': { description: 'Audit entries', content: { 'application/json': { schema: {
            type: 'array', items: { '$ref': '#/components/schemas/AuditEntry' },
          }}}}},
        },
      },
      '/windower/position': {
        post: {
          tags: ['windower'], summary: 'Ingest live position from Windower addon',
          security: [{ windowerKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['name', 'zone', 'x', 'y', 'z'],
            properties: {
              name: { type: 'string' }, zone: { type: 'integer' },
              x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
              hp: { type: 'integer' }, mp: { type: 'integer' }, tp: { type: 'integer' },
            },
          }}}},
          responses: { '200': { description: 'Accepted' } },
        },
      },
    },
    tags: [
      { name: 'system',   description: 'Health and status' },
      { name: 'auth',     description: 'Authentication and current user' },
      { name: 'characters', description: 'Character data and management' },
      { name: 'queue',    description: 'Edit queue (async character actions)' },
      { name: 'map',      description: 'Map, stats, and live player positions' },
      { name: 'zones',    description: 'Zone data' },
      { name: 'db',       description: 'Game database (items, NPCs, mobs, quests)' },
      { name: 'timers',   description: 'Pop timer tracker and NM status' },
      { name: 'settings', description: 'Server settings and variables' },
      { name: 'admin',    description: 'Admin-only: accounts, audit, roles, console' },
      { name: 'windower', description: 'Windower addon position ingestion' },
    ],
  };
}
