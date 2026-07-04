import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import WebSocket from 'ws';
import { rateLimit } from 'express-rate-limit';

import { installServerLog } from './serverlog';
installServerLog();   // mirror console output to the in-memory ring for the Console 'dashboard' tab
import { installCrashHandlers } from './crashlog';
installCrashHandlers();

import { pool } from './db';
import { initRedis } from './cache';
import { initAuthPool } from './auth';
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
import { createFilesRouter }     from './routes/files';
import { createLsbUpdateRouter } from './routes/lsb-update';
import { createDockerRouter }      from './routes/docker';
import { createGithubFilesRouter } from './routes/github-files';
import { createHealthRouter }    from './routes/health';
import { createDatRouter }       from './routes/dat';
import { initDat }               from './dat';
import { loadPlugins }           from './plugin';

initRedis();
initDat();
initAuthPool(pool);

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
  // originalUrl, not path: inside a middleware mounted at '/api/' Express strips
  // the mount prefix from req.path, so '/api/windower/…' would never match
  skip: (req) => req.originalUrl.startsWith('/api/windower/'),
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', apiLimiter);

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Wire up all routers ───────────────────────────────────────────────────────
app.use(createHealthRouter(pool));    // /api/health  (public)
app.use(createDatRouter());           // /api/dat/*   (optional DAT fetcher)
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
app.use(createWindowerRouter(pool));
app.use(createFilesRouter());
app.use(createLsbUpdateRouter());
app.use(createDockerRouter());
app.use(createGithubFilesRouter());
app.use(createAdminRouter());
loadPlugins({ pool, app });

// SPA fallback — serve index.html for all non-API routes so React Router works.
// Unknown /api/ routes get a JSON 404 (not Express's default HTML page).
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith('/api/')) { res.status(404).json({ error: 'not found' }); return; }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'), (err) => { if (err) next(err); });
});

// ── Global error handler ──────────────────────────────────────────────────────
// Express 5 passes async errors here automatically; no need for try/catch wrapping.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api error]', err.stack || err.message);
  // Don't leak internal error text (DB/driver messages, file paths) to clients.
  const status = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
  res.status(status).json({ error: status === 404 ? 'not found' : 'Internal server error' });
});

// ── WebSocket + poller ────────────────────────────────────────────────────────
initWebSocket(wss, pool);
setInterval(() => pollAndBroadcast(pool), 3000);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Without this, docker stop waits its full 10 s kill timeout on every deploy.
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM — closing server');
  wss.clients.forEach(c => c.terminate()); // WS sockets would hold server.close() open
  server.close(() => {
    pool.end().catch(() => {}).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref(); // don't hang on stray sockets
});

// ── Startup sequence ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');

// Listen immediately so the dashboard is reachable even when the DB (or its
// catalogs) isn't ready yet — bare-metal with no running LSB DB, or a DB
// container still starting. Catalogs load in the background and retry on
// failure instead of crashing the process.
startPosWatcher();
server.listen(PORT, () => console.log(`FFXI Dashboard running on port ${PORT}`));

async function loadCatalogs(): Promise<void> {
  await buildZoneMaps(pool);
  await loadExpTable(pool);
  await Promise.all([loadMobCatalog(pool), loadNpcCatalog(pool), loadZoneCache(pool)]);
}

(function loadCatalogsWithRetry() {
  loadCatalogs()
    .then(() => console.log('[startup] catalogs loaded'))
    .catch((e: Error) => {
      console.warn('[startup] catalog load failed (DB unreachable?); retrying in 15s:', e.message);
      setTimeout(loadCatalogsWithRetry, 15_000);
    });
})();

// Periodic refreshes — guarded so a transient DB outage can't crash the process.
setInterval(() => loadZoneCache(pool).catch(() => {}), 30_000);
setInterval(() => { loadMobCatalog(pool).catch(() => {}); loadNpcCatalog(pool).catch(() => {}); }, 5 * 60_000);
