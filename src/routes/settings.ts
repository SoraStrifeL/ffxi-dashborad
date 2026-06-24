import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';
import { SETTINGS_DIR, RATE_CATALOG, readRate, writeRate, SCAN_FILES, scanSettingsFile } from '../settings';

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
      const writeVal = isBool ? (value === true || value === 'true' ? 'true' : 'false') : parseFloat(String(value));
      const updated = writeRate(content, key!, writeVal, isBool ? 'bool' : undefined);
      if (updated === content) return void res.status(400).json({ error: 'key not found in file' });
      fs.writeFileSync(filePath, updated, 'utf8');
      audit(req.user!.login, 'settings.scan', `${file}:${key}`, { value: writeVal });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
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
