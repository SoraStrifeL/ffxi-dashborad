import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import WebSocket from 'ws';
import { rateLimit } from 'express-rate-limit';

import { pool } from './db';
import { initRedis } from './cache';
import { buildZoneMaps, loadMobCatalog, loadNpcCatalog, loadZoneCache, loadExpTable } from './catalog';
import { initWebSocket, startPosWatcher, pollAndBroadcast } from './ws';

import { createAuthRouter }      from './routes/auth';
import { createMapRouter }       from './routes/map';
import { createZonesRouter }     from './routes/zones';
import { createCharactersRouter } from './routes/characters';
import { createDbRouter }        from './routes/db';
import { createQueueRouter }     from './routes/queue';
import { createTimersRouter }    from './routes/timers';
import { createSettingsRouter }  from './routes/settings';
import { createAccountsRouter }  from './routes/accounts';
import { createScriptsRouter }   from './routes/scripts';
import { createUploadRouter }    from './routes/upload';
import { createWindowerRouter }  from './routes/windower';
import { createAdminRouter }     from './routes/admin';
import { createHealthRouter }    from './routes/health';
import { loadPlugins }           from './plugin';

initRedis();

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.use('/uploads', express.static(path.join(__dirname, '..', 'public', 'uploads')));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Windower addon sends position every 2s — exempt it from the general limit
const apiLimiter = rateLimit({
  windowMs:         5 * 60 * 1000,   // 5 min window
  max:              600,              // 2 req/s sustained
  standardHeaders:  'draft-7',
  legacyHeaders:    false,
  skip: (req) => req.path.startsWith('/api/windower/'),
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', apiLimiter);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Wire up all routers ───────────────────────────────────────────────────────
app.use(createHealthRouter(pool));    // /api/health  (public)
app.use(createAuthRouter(pool));
app.use(createMapRouter(pool));
app.use(createZonesRouter(pool));
app.use(createCharactersRouter(pool));
app.use(createDbRouter(pool));
app.use(createQueueRouter(pool));
app.use(createTimersRouter(pool));
app.use(createSettingsRouter(pool));
app.use(createAccountsRouter(pool));
app.use(createScriptsRouter());
app.use(createUploadRouter(pool));
app.use(createWindowerRouter());
app.use(createAdminRouter());
loadPlugins({ pool, app });

// ── Global error handler ──────────────────────────────────────────────────────
// Express 5 passes async errors here automatically; no need for try/catch wrapping.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api error]', err.message);
  const status = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// ── WebSocket + poller ────────────────────────────────────────────────────────
initWebSocket(wss, pool);
setInterval(() => pollAndBroadcast(pool), 3000);

// ── Startup sequence ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');

buildZoneMaps(pool)
  .then(() => loadExpTable(pool))
  .then(async () => {
    startPosWatcher();
    await Promise.all([loadMobCatalog(pool), loadNpcCatalog(pool), loadZoneCache(pool)]);
    setInterval(() => loadZoneCache(pool), 30_000);
    setInterval(() => { loadMobCatalog(pool); loadNpcCatalog(pool); }, 5 * 60_000);
    server.listen(PORT, () => console.log(`FFXI Dashboard running on port ${PORT}`));
  })
  .catch(e => { console.error('Startup failed:', e); process.exit(1); });
