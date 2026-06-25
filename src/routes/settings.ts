import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';
import { SETTINGS_DIR, RATE_CATALOG, readRate, writeRate, SCAN_FILES, scanSettingsFile,
         loadDashboardSettings, saveDashboardSettings, DashboardSettings } from '../settings';
import { LSB_SCRIPTS_DIR, LSB_SETTINGS_DIR, LSB_LOG_DIR, MAPS_DIR, UPLOADS_DIR, DATA_DIR,
         PATH_CONFIG_FILE } from '../catalog';
import { loadDbConfig, saveDbConfig, DB_CONFIG_FILE, DbConfig } from '../db';
import mysql from 'mysql2/promise';

export function createSettingsRouter(pool: Pool): Router {
  const router = Router();

  router.get('/api/settings/rates', requireAuth, requirePermission('manage:settings'), async (_req, res) => {
    try {
      const cache: Record<string, string> = {};
      const result = RATE_CATALOG.map(entry => {
        if (!cache[entry.file]) {
          try { cache[entry.file] = fs.readFileSync(path.join(SETTINGS_DIR, entry.file), 'utf8'); }
          catch (_) { cache[entry.file] = ''; }
        }
        return { ...entry, value: readRate(cache[entry.file], entry.key, entry.type) };
      });
      res.json(result);
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/api/settings/rates', requireAuth, requirePermission('manage:settings'), async (req, res) => {
    try {
      const { key, value } = (req.body as { key?: string; value?: unknown }) || {};
      const entry = RATE_CATALOG.find(e => e.key === key);
      if (!entry) return void res.status(400).json({ error: 'unknown key' });
      const filePath = path.join(SETTINGS_DIR, entry.file);
      const content  = fs.readFileSync(filePath, 'utf8');
      const writeVal = entry.type === 'bool'
        ? (value === true || value === 'true' ? 'true' : 'false')
        : parseFloat(String(value));
      const updated  = writeRate(content, key!, writeVal, entry.type);
      if (updated === content) return void res.status(400).json({ error: 'key not found in file' });
      fs.writeFileSync(filePath, updated, 'utf8');
      audit(req.user!.login, 'settings.rate', key!, { value: writeVal, file: entry.file });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.get('/api/settings/scan', requireAuth, requirePermission('manage:settings'), (_req, res) => {
    try {
      const result: Record<string, unknown> = {};
      for (const file of SCAN_FILES) result[file] = scanSettingsFile(file);
      res.json(result);
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/api/settings/scan', requireAuth, requirePermission('manage:settings'), (req, res) => {
    try {
      const { file, key, value } = (req.body as { file?: string; key?: string; value?: unknown }) || {};
      if (!SCAN_FILES.includes(file!)) return void res.status(400).json({ error: 'invalid file' });
      if (!/^[A-Z][A-Z0-9_]+$/.test(key!)) return void res.status(400).json({ error: 'invalid key' });
      const filePath = path.join(SETTINGS_DIR, file!);
      const content = fs.readFileSync(filePath, 'utf8');
      const isBool = value === 'true' || value === 'false' || value === true || value === false;
      const boolIsTrue = value === true || value === 'true';
      let writeVal: string | number = isBool ? (boolIsTrue ? 'true' : 'false') : parseFloat(String(value));
      let updated = writeRate(content, key!, writeVal, isBool ? 'bool' : undefined);
      if (updated === content && isBool) {
        // file uses 0/1 integers instead of true/false — write numeric equivalent
        writeVal = boolIsTrue ? 1 : 0;
        updated = writeRate(content, key!, writeVal);
      }
      if (updated === content) return void res.status(400).json({ error: 'key not found in file' });
      fs.writeFileSync(filePath, updated, 'utf8');
      audit(req.user!.login, 'settings.scan', `${file}:${key}`, { value: writeVal });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.get('/api/dashboard/settings', requireAuth, (_req, res) => {
    res.json(loadDashboardSettings());
  });

  router.post('/api/dashboard/settings', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const current = loadDashboardSettings();
    const body = (req.body as Partial<DashboardSettings>) || {};
    const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
      typeof v === 'number' && Number.isInteger(v) ? Math.max(min, Math.min(max, v)) : fallback;
    const updated: DashboardSettings = {
      serverName:        typeof body.serverName        === 'string'  ? body.serverName.slice(0, 100)                             : current.serverName,
      motd:              typeof body.motd              === 'string'  ? body.motd.slice(0, 500)                                   : current.motd,
      autoSwitchZone:    typeof body.autoSwitchZone    === 'boolean' ? body.autoSwitchZone                                       : current.autoSwitchZone,
      autologin:         typeof body.autologin         === 'boolean' ? body.autologin                                            : current.autologin,
      allowPlayerLogin:  typeof body.allowPlayerLogin  === 'boolean' ? body.allowPlayerLogin                                     : current.allowPlayerLogin,
      tokenTtlHours:     clampInt(body.tokenTtlHours,     1,   720, current.tokenTtlHours),
      adminGmLevel:      clampInt(body.adminGmLevel,      1,    10, current.adminGmLevel),
      loginRateLimitMax: clampInt(body.loginRateLimitMax, 1,   100, current.loginRateLimitMax),
    };
    saveDashboardSettings(updated);
    audit(req.user!.login, 'settings.dashboard', undefined, body);
    res.json({ ok: true, settings: updated });
  });

  // ── Path configuration ────────────────────────────────────────────────────
  const PATH_KEYS = ['LSB_SCRIPTS_DIR', 'LSB_SETTINGS_DIR', 'LSB_LOG_DIR'] as const;

  router.get('/api/dashboard/paths', requireAuth, requirePermission('manage:settings'), (_req, res) => {
    let saved: Record<string, string> = {};
    try { saved = JSON.parse(fs.readFileSync(PATH_CONFIG_FILE, 'utf8')); } catch (_) {}
    res.json({
      effective: { LSB_SCRIPTS_DIR, LSB_SETTINGS_DIR, LSB_LOG_DIR, MAPS_DIR, UPLOADS_DIR, DATA_DIR },
      saved,
      defaults:  { LSB_SCRIPTS_DIR: '/ffxi-scripts', LSB_SETTINGS_DIR: '/ffxi-settings', LSB_LOG_DIR: '/ffxi-log' },
    });
  });

  router.post('/api/dashboard/paths', requireAuth, requirePermission('manage:settings'), (req, res) => {
    let current: Record<string, string> = {};
    try { current = JSON.parse(fs.readFileSync(PATH_CONFIG_FILE, 'utf8')); } catch (_) {}
    const body = (req.body as Record<string, string>) || {};
    for (const key of PATH_KEYS) {
      const val = body[key];
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed) current[key] = trimmed;
        else delete current[key]; // empty = revert to env/default
      }
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PATH_CONFIG_FILE, JSON.stringify(current, null, 2), 'utf8');
    audit(req.user!.login, 'settings.paths', undefined, body);
    res.json({ ok: true, saved: current, restartRequired: true });
  });

  // ── Database configuration ────────────────────────────────────────────────
  router.get('/api/dashboard/db', requireAuth, requirePermission('manage:settings'), (_req, res) => {
    const effective = loadDbConfig();
    let saved: Partial<DbConfig> = {};
    try { saved = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8')); } catch (_) {}
    res.json({
      effective: { ...effective, DB_PASS: effective.DB_PASS ? '••••••••' : '' },
      saved: { ...saved, DB_PASS: saved.DB_PASS ? '••••••••' : undefined },
      hasPassword: !!effective.DB_PASS,
    });
  });

  router.post('/api/dashboard/db', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const body = (req.body as Partial<DbConfig & { DB_PASS_CLEAR?: string }>) || {};
    const patch: Partial<DbConfig> = {};
    if (typeof body.DB_HOST === 'string') patch.DB_HOST = body.DB_HOST.trim();
    if (typeof body.DB_PORT === 'number' || typeof body.DB_PORT === 'string')
      patch.DB_PORT = Math.max(1, Math.min(65535, parseInt(String(body.DB_PORT)) || 3306));
    if (typeof body.DB_USER === 'string') patch.DB_USER = body.DB_USER.trim();
    if (typeof body.DB_NAME === 'string') patch.DB_NAME = body.DB_NAME.trim();
    if (typeof body.DB_PASS === 'string' && !body.DB_PASS.includes('•'))
      patch.DB_PASS = body.DB_PASS; // only update if not the masked placeholder
    saveDbConfig(patch);
    audit(req.user!.login, 'settings.db', undefined, { ...patch, DB_PASS: patch.DB_PASS ? '[set]' : undefined });
    res.json({ ok: true, restartRequired: true });
  });

  router.post('/api/dashboard/db/test', requireAuth, requirePermission('manage:settings'), async (req, res) => {
    const body = (req.body as Partial<DbConfig>) || {};
    const current = loadDbConfig();
    const cfg: DbConfig = {
      DB_HOST: (typeof body.DB_HOST === 'string' && body.DB_HOST.trim()) ? body.DB_HOST.trim() : current.DB_HOST,
      DB_PORT: body.DB_PORT ? Math.max(1, parseInt(String(body.DB_PORT)) || 3306) : current.DB_PORT,
      DB_USER: (typeof body.DB_USER === 'string' && body.DB_USER.trim()) ? body.DB_USER.trim() : current.DB_USER,
      DB_PASS: (typeof body.DB_PASS === 'string' && !body.DB_PASS.includes('•')) ? body.DB_PASS : current.DB_PASS,
      DB_NAME: (typeof body.DB_NAME === 'string' && body.DB_NAME.trim()) ? body.DB_NAME.trim() : current.DB_NAME,
    };
    let conn;
    try {
      conn = await mysql.createConnection({ host: cfg.DB_HOST, port: cfg.DB_PORT,
        user: cfg.DB_USER, password: cfg.DB_PASS, database: cfg.DB_NAME, connectTimeout: 5000 });
      const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT VERSION() AS v, DATABASE() AS db');
      res.json({ ok: true, version: rows[0]?.v, database: rows[0]?.db });
    } catch (err: any) {
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  });

  router.get('/api/settings/variables', requireAuth, requirePermission('manage:settings'), async (_req, res) => {
    try {
      const [rows] = await pool.execute<RowDataPacket[]>('SELECT name AS varname, value FROM server_variables ORDER BY name');
      res.json(rows);
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/api/settings/variables', requireAuth, requirePermission('manage:settings'), async (req, res) => {
    try {
      const { varname, value } = (req.body as { varname?: string; value?: unknown }) || {};
      if (!varname) return void res.status(400).json({ error: 'varname required' });
      const numVal = parseInt(String(value)) || 0;
      await pool.execute(
        'INSERT INTO server_variables (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
        [varname, numVal]);
      audit(req.user!.login, 'settings.variable', varname, { value: numVal });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  return router;
}
