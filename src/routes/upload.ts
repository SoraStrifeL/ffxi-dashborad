import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { Router } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';
import { MAPS_DIR, UPLOADS_DIR, normZoneName, buildZoneMaps } from '../catalog';
import { readLoginMessages, setLoginMessageImage } from '../loginMessages';

const ALLOWED_IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// buildZoneMaps() and the whole map pipeline are PNG-only — see CLAUDE.md "Map images"
const PNG_ONLY = new Set(['image/png']);
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
};

function makeUploader(dest: string, allowedMime: Set<string> = ALLOWED_IMG_MIME, mimeError = 'Only image files are allowed'): ReturnType<ReturnType<typeof multer>['single']> {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dest),
      filename:    (req: any, _file, cb) => cb(null, req._uploadFilename ?? 'upload'),
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (allowedMime.has(file.mimetype)) cb(null, true);
      else cb(new Error(mimeError));
    },
  }).single('image');
}

// Re-uploading the same key in a new format must not leave the old-extension
// file behind — /api/upload/check returns the first extension it finds, so a
// stale variant would permanently shadow the new image.
function removeStaleVariants(dir: string, key: string, keepExt: string): void {
  for (const ext of Object.values(MIME_EXT)) {
    if (ext === keepExt) continue;
    const f = path.join(dir, `${key}.${ext}`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  }
}

export function createUploadRouter(pool: Pool): Router {
  const router = Router();

  router.get('/api/upload/check/:type', requireAuth, (req, res) => {
    const type = req.params.type as string;
    const dirMap: Record<string, string> = { item: 'items', npc: 'npcs', mob: 'mobs' };
    const dir = dirMap[type];
    if (!dir) return void res.status(400).json({ error: 'invalid type' });
    let key: string;
    if (type === 'mob') {
      const rawName = (req.query.name as string) || '';
      key = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    } else {
      key = (req.query.id as string) || '';
    }
    if (!key) return void res.status(400).json({ error: 'id or name required' });
    const baseDir = path.join(UPLOADS_DIR, dir);
    let foundUrl: string | null = null;
    for (const ext of ['png', 'jpg', 'gif', 'webp']) {
      if (!foundUrl && fs.existsSync(path.join(baseDir, `${key}.${ext}`))) {
        foundUrl = `/uploads/${dir}/${key}.${ext}`;
      }
    }
    res.json({ exists: !!foundUrl, url: foundUrl });
  });

  router.delete('/api/upload/:type', requireAuth, requirePermission('upload:images'), (req, res) => {
    const type = req.params.type as string;
    const dirMap: Record<string, string> = { item: 'items', npc: 'npcs', mob: 'mobs' };
    const dir = dirMap[type];
    if (!dir) return void res.status(400).json({ error: 'invalid type' });
    let key: string;
    if (type === 'mob') {
      const rawName = (req.query.name as string) || '';
      key = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    } else {
      key = (req.query.id as string) || '';
    }
    if (!key) return void res.status(400).json({ error: 'id or name required' });
    const baseDir = path.join(UPLOADS_DIR, dir);
    let deleted = false;
    for (const ext of ['png', 'jpg', 'gif', 'webp']) {
      const f = path.join(baseDir, `${key}.${ext}`);
      if (fs.existsSync(f)) { fs.unlinkSync(f); deleted = true; }
    }
    if (deleted) audit(req.user!.login, 'upload.delete', `${type}:${key}`);
    res.json({ ok: true, deleted });
  });

  router.post('/api/upload/map/:zoneid', requireAuth, requirePermission('upload:images'), async (req: any, res) => {
    const zoneid = parseInt(req.params.zoneid as string);
    if (isNaN(zoneid)) return void res.status(400).json({ error: 'invalid zone id' });
    let zoneName: string;
    try {
      const [[row]] = await pool.execute<RowDataPacket[]>('SELECT name FROM zone_settings WHERE zoneid=?', [zoneid]);
      if (!row) return void res.status(404).json({ error: 'zone not found' });
      zoneName = normZoneName(row.name as string);
    } catch (e) { return void res.status(500).json({ error: (e as Error).message }); }
    req._uploadFilename = `${zoneName}.png`;
    makeUploader(MAPS_DIR, PNG_ONLY, 'Map images must be PNG')(req, res, async (err: any) => {
      if (err) return void res.status(400).json({ error: err.message });
      if (!req.file) return void res.status(400).json({ error: 'image file required' });
      audit(req.user!.login, 'upload.map', `zone:${zoneid}`, { file: req.file.filename });
      // await so /api/maps already reflects the new file when the client refetches
      await buildZoneMaps(pool);
      res.json({ ok: true, file: req.file.filename, url: `/maps/${req.file.filename}` });
    });
  });

  router.post('/api/upload/item/:itemid', requireAuth, requirePermission('upload:images'), (req: any, res) => {
    const itemid = parseInt(req.params.itemid as string);
    if (isNaN(itemid)) return void res.status(400).json({ error: 'invalid item id' });
    req._uploadFilename = `${itemid}.png`;
    makeUploader(path.join(UPLOADS_DIR, 'items'))(req, res, (err: any) => {
      if (err) return void res.status(400).json({ error: err.message });
      if (!req.file) return void res.status(400).json({ error: 'image file required' });
      const ext = MIME_EXT[req.file.mimetype] || 'png';
      const newName = `${itemid}.${ext}`;
      if (newName !== req.file.filename) {
        fs.renameSync(req.file.path, path.join(UPLOADS_DIR, 'items', newName));
      }
      removeStaleVariants(path.join(UPLOADS_DIR, 'items'), String(itemid), ext);
      audit(req.user!.login, 'upload.item', `item:${itemid}`);
      res.json({ ok: true, url: `/uploads/items/${newName}` });
    });
  });

  router.post('/api/upload/npc/:npcid', requireAuth, requirePermission('upload:images'), (req: any, res) => {
    const npcid = parseInt(req.params.npcid as string);
    if (isNaN(npcid)) return void res.status(400).json({ error: 'invalid npc id' });
    req._uploadFilename = `${npcid}.png`;
    makeUploader(path.join(UPLOADS_DIR, 'npcs'))(req, res, (err: any) => {
      if (err) return void res.status(400).json({ error: err.message });
      if (!req.file) return void res.status(400).json({ error: 'image file required' });
      const ext = MIME_EXT[req.file.mimetype] || 'png';
      const newName = `${npcid}.${ext}`;
      if (newName !== req.file.filename) {
        fs.renameSync(req.file.path, path.join(UPLOADS_DIR, 'npcs', newName));
      }
      removeStaleVariants(path.join(UPLOADS_DIR, 'npcs'), String(npcid), ext);
      audit(req.user!.login, 'upload.npc', `npc:${npcid}`);
      res.json({ ok: true, url: `/uploads/npcs/${newName}` });
    });
  });

  router.post('/api/upload/mob', requireAuth, requirePermission('upload:images'), (req: any, res) => {
    const rawName = (req.query.name as string) || '';
    if (!rawName) return void res.status(400).json({ error: 'name required' });
    const key = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    req._uploadFilename = `${key}.png`;
    makeUploader(path.join(UPLOADS_DIR, 'mobs'))(req, res, (err: any) => {
      if (err) return void res.status(400).json({ error: err.message });
      if (!req.file) return void res.status(400).json({ error: 'image file required' });
      const ext = MIME_EXT[req.file.mimetype] || 'png';
      const newName = `${key}.${ext}`;
      if (newName !== req.file.filename) {
        fs.renameSync(req.file.path, path.join(UPLOADS_DIR, 'mobs', newName));
      }
      removeStaleVariants(path.join(UPLOADS_DIR, 'mobs'), key, ext);
      audit(req.user!.login, 'upload.mob', `mob:${key}`);
      res.json({ ok: true, url: `/uploads/mobs/${newName}`, key });
    });
  });

  router.post('/api/upload/login-message/:id', requireAuth, requirePermission('upload:images'), (req: any, res) => {
    const id = req.params.id as string;
    if (!readLoginMessages().some(m => m.id === id)) return void res.status(404).json({ error: 'message not found' });
    req._uploadFilename = `${id}.png`;
    makeUploader(path.join(UPLOADS_DIR, 'login-messages'))(req, res, (err: any) => {
      if (err) return void res.status(400).json({ error: err.message });
      if (!req.file) return void res.status(400).json({ error: 'image file required' });
      const ext = MIME_EXT[req.file.mimetype] || 'png';
      const newName = `${id}.${ext}`;
      if (newName !== req.file.filename) {
        fs.renameSync(req.file.path, path.join(UPLOADS_DIR, 'login-messages', newName));
      }
      removeStaleVariants(path.join(UPLOADS_DIR, 'login-messages'), id, ext);
      const url = `/uploads/login-messages/${newName}`;
      setLoginMessageImage(id, url);
      audit(req.user!.login, 'upload.loginMessage', `loginMessage:${id}`);
      res.json({ ok: true, url });
    });
  });

  return router;
}
