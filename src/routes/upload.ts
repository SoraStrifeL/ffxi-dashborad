import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { Router } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';
import { MAPS_DIR, UPLOADS_DIR, normZoneName, buildZoneMaps } from '../catalog';

const ALLOWED_IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
};

function makeUploader(dest: string): ReturnType<ReturnType<typeof multer>['single']> {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dest),
      filename:    (req: any, _file, cb) => cb(null, req._uploadFilename ?? 'upload'),
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_IMG_MIME.has(file.mimetype)) cb(null, true);
      else cb(new Error('Only image files are allowed'));
    },
  }).single('image');
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
    const ext = ((req.query.ext as string) || 'png').replace(/[^a-z]/g, '') || 'png';
    req._uploadFilename = `${zoneName}.${ext}`;
    makeUploader(MAPS_DIR)(req, res, (err: any) => {
      if (err) return void res.status(400).json({ error: err.message });
      audit(req.user!.login, 'upload.map', `zone:${zoneid}`, { file: req.file.filename });
      buildZoneMaps(pool);
      res.json({ ok: true, file: req.file.filename, url: `/maps/${req.file.filename}` });
    });
  });

  router.post('/api/upload/item/:itemid', requireAuth, requirePermission('upload:images'), (req: any, res) => {
    const itemid = parseInt(req.params.itemid as string);
    if (isNaN(itemid)) return void res.status(400).json({ error: 'invalid item id' });
    req._uploadFilename = `${itemid}.png`;
    makeUploader(path.join(UPLOADS_DIR, 'items'))(req, res, (err: any) => {
      if (err) return void res.status(400).json({ error: err.message });
      const ext = MIME_EXT[req.file.mimetype] || 'png';
      const newName = `${itemid}.${ext}`;
      if (newName !== req.file.filename) {
        fs.renameSync(req.file.path, path.join(UPLOADS_DIR, 'items', newName));
      }
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
      const ext = MIME_EXT[req.file.mimetype] || 'png';
      const newName = `${npcid}.${ext}`;
      if (newName !== req.file.filename) {
        fs.renameSync(req.file.path, path.join(UPLOADS_DIR, 'npcs', newName));
      }
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
      const ext = MIME_EXT[req.file.mimetype] || 'png';
      const newName = `${key}.${ext}`;
      if (newName !== req.file.filename) {
        fs.renameSync(req.file.path, path.join(UPLOADS_DIR, 'mobs', newName));
      }
      audit(req.user!.login, 'upload.mob', `mob:${key}`);
      res.json({ ok: true, url: `/uploads/mobs/${newName}`, key });
    });
  });

  return router;
}
