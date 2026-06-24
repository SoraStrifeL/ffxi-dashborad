import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Router } from 'express';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';
import { SERVER_SCRIPTS_ROOT } from '../catalog';

const SCRIPTS_FILE = path.join(__dirname, '..', '..', 'data', 'scripts.json');
function readScripts(): unknown[] { try { return JSON.parse(fs.readFileSync(SCRIPTS_FILE, 'utf8')); } catch { return []; } }
function writeScripts(scripts: unknown[]): void {
  fs.mkdirSync(path.dirname(SCRIPTS_FILE), { recursive: true });
  fs.writeFileSync(SCRIPTS_FILE, JSON.stringify(scripts, null, 2));
}

function safeBrowserPath(rel: string): string {
  const full = path.resolve(SERVER_SCRIPTS_ROOT, rel || '');
  if (!full.startsWith(SERVER_SCRIPTS_ROOT)) throw new Error('Invalid path');
  return full;
}

export function createScriptsRouter(): Router {
  const router = Router();

  router.get('/api/scriptbrowser', requireAuth, requirePermission('manage:scripts'), (req, res) => {
    try {
      const full = safeBrowserPath((req.query.path as string) || '');
      const stat = fs.statSync(full);
      if (!stat.isDirectory()) return void res.status(400).json({ error: 'Not a directory' });
      const entries = fs.readdirSync(full, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.name.endsWith('.lua'))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      res.json(entries);
    } catch (e: any) {
      if (e.code === 'ENOENT') return void res.status(404).json({ error: 'Path not found' });
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/api/scriptbrowser/file', requireAuth, requirePermission('manage:scripts'), (req, res) => {
    try {
      const full = safeBrowserPath((req.query.path as string) || '');
      if (!full.endsWith('.lua')) return void res.status(400).json({ error: 'Only .lua files allowed' });
      const stat = fs.statSync(full);
      if (stat.size > 512 * 1024) return void res.status(400).json({ error: 'File too large (>512 KB)' });
      res.type('text/plain').send(fs.readFileSync(full, 'utf8'));
    } catch (e: any) {
      if (e.code === 'ENOENT') return void res.status(404).json({ error: 'File not found' });
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/api/scriptbrowser/file', requireAuth, requirePermission('manage:scripts'), (req, res) => {
    try {
      const relPath = (req.query.path as string) || '';
      const full = safeBrowserPath(relPath);
      if (!full.endsWith('.lua')) return void res.status(400).json({ error: 'Only .lua files allowed' });
      if (!fs.existsSync(path.dirname(full))) return void res.status(400).json({ error: 'Directory does not exist' });
      const { content } = (req.body as { content?: string }) || {};
      if (typeof content !== 'string') return void res.status(400).json({ error: 'content required' });
      fs.writeFileSync(full, content, 'utf8');
      audit(req.user!.login, 'script.file.write', relPath);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });

  router.get('/api/scripts', requireAuth, requirePermission('manage:scripts'), (_req, res) => {
    res.json(readScripts());
  });

  router.post('/api/scripts', requireAuth, requirePermission('manage:scripts'), (req, res) => {
    const { id, name, code, description } = (req.body as any) || {};
    if (!name || !code) return void res.status(400).json({ error: 'name and code required' });
    const scripts = readScripts() as any[];
    const now = Date.now();
    if (id) {
      const idx = scripts.findIndex(s => s.id === id);
      if (idx >= 0) scripts[idx] = { ...scripts[idx], name, description, code, updated: now };
      else scripts.push({ id, name, description, code, created: now, updated: now });
    } else {
      scripts.push({ id: crypto.randomUUID(), name, description, code, created: now, updated: now });
    }
    writeScripts(scripts);
    audit(req.user!.login, 'script.save', name);
    res.json({ ok: true, scripts });
  });

  router.delete('/api/scripts/:id', requireAuth, requirePermission('manage:scripts'), (req, res) => {
    const scriptId = req.params.id as string;
    const before = readScripts() as any[];
    const scripts = before.filter(s => s.id !== scriptId);
    writeScripts(scripts);
    const deleted = before.find(s => s.id === scriptId);
    audit(req.user!.login, 'script.delete', deleted?.name ?? scriptId);
    res.json({ ok: true });
  });

  return router;
}
