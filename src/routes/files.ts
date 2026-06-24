import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { Router } from 'express';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';
import { MAPS_DIR, UPLOADS_DIR, LSB_SCRIPTS_DIR, LSB_SETTINGS_DIR, LSB_LOG_DIR } from '../catalog';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ALLOWED_UPLOAD_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

interface DirConfig {
  root: string;
  label: string;
  canWrite: boolean;
  staticBase?: string; // if set, images can be previewed via this URL prefix
}

export const FILE_DIRS: Record<string, DirConfig> = {
  maps:            { root: MAPS_DIR,                         label: 'Map Images',      canWrite: true,  staticBase: '/maps' },
  'uploads/items': { root: path.join(UPLOADS_DIR, 'items'),  label: 'Uploads / Items', canWrite: true,  staticBase: '/uploads/items' },
  'uploads/npcs':  { root: path.join(UPLOADS_DIR, 'npcs'),   label: 'Uploads / NPCs',  canWrite: true,  staticBase: '/uploads/npcs' },
  'uploads/mobs':  { root: path.join(UPLOADS_DIR, 'mobs'),   label: 'Uploads / Mobs',  canWrite: true,  staticBase: '/uploads/mobs' },
  scripts:         { root: LSB_SCRIPTS_DIR,                  label: 'Server Scripts',  canWrite: false },
  settings:        { root: LSB_SETTINGS_DIR,                 label: 'Server Settings', canWrite: false },
  log:             { root: LSB_LOG_DIR,                      label: 'Server Logs',     canWrite: false },
};

function safePath(root: string, sub: string): string | null {
  const resolved = path.resolve(path.join(root, sub || ''));
  return resolved.startsWith(path.resolve(root)) ? resolved : null;
}

export function createFilesRouter(): Router {
  const router = Router();

  // ── Directory browser (for path picker) ────────────────────────────────────
  router.get('/api/fs/browse', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const dirPath = path.resolve((req.query.path as string) || '/');
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory())
        .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const parent = dirPath === '/' ? null : path.dirname(dirPath);
      res.json({ path: dirPath, parent, dirs });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── List directory ──────────────────────────────────────────────────────────
  router.get('/api/files/list', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const dirKey = req.query.dir as string;
    const sub    = (req.query.sub as string) || '';
    const cfg    = FILE_DIRS[dirKey];
    if (!cfg) return void res.status(400).json({ error: 'invalid dir' });
    const target = safePath(cfg.root, sub);
    if (!target) return void res.status(400).json({ error: 'invalid path' });
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const files = entries.map(e => {
        let size: number | null = null;
        let mtime = 0;
        try { const st = fs.statSync(path.join(target, e.name)); size = st.size; mtime = st.mtimeMs; } catch (_) {}
        return {
          name:    e.name,
          isDir:   e.isDirectory(),
          size:    e.isDirectory() ? null : size,
          mtime,
          isImage: IMAGE_EXTS.has(path.extname(e.name).toLowerCase()),
        };
      }).sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json({ files, canWrite: cfg.canWrite, staticBase: cfg.staticBase ?? null });
    } catch (err: any) {
      if (err.code === 'ENOENT') return void res.json({ files: [], missing: true, canWrite: cfg.canWrite, staticBase: null });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Download a file ─────────────────────────────────────────────────────────
  // _token query param is accepted for window.open() downloads (can't set headers)
  const injectQueryToken = (req: any, _res: any, next: any) => {
    if (!req.headers.authorization && req.query._token)
      req.headers.authorization = `Bearer ${req.query._token}`;
    next();
  };
  router.get('/api/files/download', injectQueryToken, requireAuth, requirePermission('manage:settings'), (req, res) => {
    const dirKey = req.query.dir as string;
    const sub    = (req.query.sub as string) || '';
    const name   = req.query.name as string;
    const cfg    = FILE_DIRS[dirKey];
    if (!cfg || !name) return void res.status(400).json({ error: 'invalid request' });
    const filePath = safePath(cfg.root, path.join(sub, name));
    if (!filePath) return void res.status(400).json({ error: 'invalid path' });
    try {
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory())
        return void res.status(404).json({ error: 'file not found' });
      res.download(filePath);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Upload a file ───────────────────────────────────────────────────────────
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req: any, _f, cb) => cb(null, req._uploadDest ?? '/tmp'),
      filename:    (_req, file, cb)    => cb(null, file.originalname),
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_UPLOAD_MIME.has(file.mimetype)) cb(null, true);
      else cb(new Error('Only image files are allowed'));
    },
  }).single('file');

  router.post('/api/files/upload', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const dirKey = req.query.dir as string;
    const sub    = (req.query.sub as string) || '';
    const cfg    = FILE_DIRS[dirKey];
    if (!cfg?.canWrite) return void res.status(403).json({ error: 'read-only directory' });
    const dest = safePath(cfg.root, sub);
    if (!dest) return void res.status(400).json({ error: 'invalid path' });
    fs.mkdirSync(dest, { recursive: true });
    (req as any)._uploadDest = dest;
    upload(req, res, (err) => {
      if (err) return void res.status(400).json({ error: err.message });
      if (!req.file) return void res.status(400).json({ error: 'no file provided' });
      audit(req.user!.login, 'files.upload', `${dirKey}/${sub ? sub + '/' : ''}${req.file.originalname}`);
      res.json({ ok: true, name: req.file.originalname });
    });
  });

  // ── Delete a file ───────────────────────────────────────────────────────────
  router.delete('/api/files', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const dirKey = req.query.dir as string;
    const sub    = (req.query.sub as string) || '';
    const name   = req.query.name as string;
    const cfg    = FILE_DIRS[dirKey];
    if (!cfg?.canWrite) return void res.status(403).json({ error: 'read-only directory' });
    if (!name) return void res.status(400).json({ error: 'name required' });
    const filePath = safePath(cfg.root, path.join(sub, name));
    if (!filePath) return void res.status(400).json({ error: 'invalid path' });
    try {
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory())
        return void res.status(404).json({ error: 'file not found' });
      fs.unlinkSync(filePath);
      audit(req.user!.login, 'files.delete', `${dirKey}/${sub ? sub + '/' : ''}${name}`);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
