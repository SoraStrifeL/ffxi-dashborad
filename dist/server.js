"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const http_1 = __importDefault(require("http"));
const ws_1 = __importDefault(require("ws"));
const express_rate_limit_1 = require("express-rate-limit");
const db_1 = require("./db");
const cache_1 = require("./cache");
const catalog_1 = require("./catalog");
const ws_2 = require("./ws");
const auth_1 = require("./routes/auth");
const map_1 = require("./routes/map");
const zones_1 = require("./routes/zones");
const characters_1 = require("./routes/characters");
const db_2 = require("./routes/db");
const queue_1 = require("./routes/queue");
const timers_1 = require("./routes/timers");
const settings_1 = require("./routes/settings");
const accounts_1 = require("./routes/accounts");
const scripts_1 = require("./routes/scripts");
const upload_1 = require("./routes/upload");
const windower_1 = require("./routes/windower");
const admin_1 = require("./routes/admin");
const health_1 = require("./routes/health");
(0, cache_1.initRedis)();
const app = (0, express_1.default)();
app.set('trust proxy', 1);
app.use((0, cors_1.default)({ origin: process.env.CORS_ORIGIN || false }));
app.use(express_1.default.json({ limit: '512kb' }));
app.use(express_1.default.static(path_1.default.join(__dirname, '..', 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html'))
            res.setHeader('Cache-Control', 'no-cache');
    },
}));
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '..', 'public', 'uploads')));
// ── Rate limiting ─────────────────────────────────────────────────────────────
// Windower addon sends position every 2s — exempt it from the general limit
const apiLimiter = (0, express_rate_limit_1.rateLimit)({
    windowMs: 5 * 60 * 1000, // 5 min window
    max: 600, // 2 req/s sustained
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.path.startsWith('/api/windower/'),
    message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', apiLimiter);
const server = http_1.default.createServer(app);
const wss = new ws_1.default.Server({ server });
// ── Wire up all routers ───────────────────────────────────────────────────────
app.use((0, health_1.createHealthRouter)(db_1.pool)); // /api/health  (public)
app.use((0, auth_1.createAuthRouter)(db_1.pool));
app.use((0, map_1.createMapRouter)(db_1.pool));
app.use((0, zones_1.createZonesRouter)(db_1.pool));
app.use((0, characters_1.createCharactersRouter)(db_1.pool));
app.use((0, db_2.createDbRouter)(db_1.pool));
app.use((0, queue_1.createQueueRouter)(db_1.pool));
app.use((0, timers_1.createTimersRouter)(db_1.pool));
app.use((0, settings_1.createSettingsRouter)(db_1.pool));
app.use((0, accounts_1.createAccountsRouter)(db_1.pool));
app.use((0, scripts_1.createScriptsRouter)());
app.use((0, upload_1.createUploadRouter)(db_1.pool));
app.use((0, windower_1.createWindowerRouter)());
app.use((0, admin_1.createAdminRouter)());
// ── Global error handler ──────────────────────────────────────────────────────
// Express 5 passes async errors here automatically; no need for try/catch wrapping.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err, _req, res, _next) => {
    console.error('[api error]', err.message);
    const status = err.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: err.message || 'Internal server error' });
});
// ── WebSocket + poller ────────────────────────────────────────────────────────
(0, ws_2.initWebSocket)(wss, db_1.pool);
setInterval(() => (0, ws_2.pollAndBroadcast)(db_1.pool), 3000);
// ── Startup sequence ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');
(0, catalog_1.buildZoneMaps)(db_1.pool)
    .then(() => (0, catalog_1.loadExpTable)(db_1.pool))
    .then(async () => {
    (0, ws_2.startPosWatcher)();
    await Promise.all([(0, catalog_1.loadMobCatalog)(db_1.pool), (0, catalog_1.loadNpcCatalog)(db_1.pool), (0, catalog_1.loadZoneCache)(db_1.pool)]);
    setInterval(() => (0, catalog_1.loadZoneCache)(db_1.pool), 30000);
    setInterval(() => { (0, catalog_1.loadMobCatalog)(db_1.pool); (0, catalog_1.loadNpcCatalog)(db_1.pool); }, 5 * 60000);
    server.listen(PORT, () => console.log(`FFXI Dashboard running on port ${PORT}`));
})
    .catch(e => { console.error('Startup failed:', e); process.exit(1); });
