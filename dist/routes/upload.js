"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUploadRouter = createUploadRouter;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const multer_1 = __importDefault(require("multer"));
const express_1 = require("express");
const auth_1 = require("../auth");
const rbac_1 = require("../rbac");
const audit_1 = require("../audit");
const catalog_1 = require("../catalog");
const ALLOWED_IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
};
function makeUploader(dest) {
    return (0, multer_1.default)({
        storage: multer_1.default.diskStorage({
            destination: (_req, _file, cb) => cb(null, dest),
            filename: (req, _file, cb) => cb(null, req._uploadFilename ?? 'upload'),
        }),
        limits: { fileSize: 8 * 1024 * 1024 },
        fileFilter: (_req, file, cb) => {
            if (ALLOWED_IMG_MIME.has(file.mimetype))
                cb(null, true);
            else
                cb(new Error('Only image files are allowed'));
        },
    }).single('image');
}
function createUploadRouter(pool) {
    const router = (0, express_1.Router)();
    router.get('/api/upload/check/:type', auth_1.requireAuth, (req, res) => {
        const type = req.params.type;
        const dirMap = { item: 'items', npc: 'npcs', mob: 'mobs' };
        const dir = dirMap[type];
        if (!dir)
            return void res.status(400).json({ error: 'invalid type' });
        let key;
        if (type === 'mob') {
            const rawName = req.query.name || '';
            key = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        }
        else {
            key = req.query.id || '';
        }
        if (!key)
            return void res.status(400).json({ error: 'id or name required' });
        const baseDir = path_1.default.join(catalog_1.UPLOADS_DIR, dir);
        let foundUrl = null;
        for (const ext of ['png', 'jpg', 'gif', 'webp']) {
            if (!foundUrl && fs_1.default.existsSync(path_1.default.join(baseDir, `${key}.${ext}`))) {
                foundUrl = `/uploads/${dir}/${key}.${ext}`;
            }
        }
        res.json({ exists: !!foundUrl, url: foundUrl });
    });
    router.delete('/api/upload/:type', auth_1.requireAuth, (0, rbac_1.requirePermission)('upload:images'), (req, res) => {
        const type = req.params.type;
        const dirMap = { item: 'items', npc: 'npcs', mob: 'mobs' };
        const dir = dirMap[type];
        if (!dir)
            return void res.status(400).json({ error: 'invalid type' });
        let key;
        if (type === 'mob') {
            const rawName = req.query.name || '';
            key = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        }
        else {
            key = req.query.id || '';
        }
        if (!key)
            return void res.status(400).json({ error: 'id or name required' });
        const baseDir = path_1.default.join(catalog_1.UPLOADS_DIR, dir);
        let deleted = false;
        for (const ext of ['png', 'jpg', 'gif', 'webp']) {
            const f = path_1.default.join(baseDir, `${key}.${ext}`);
            if (fs_1.default.existsSync(f)) {
                fs_1.default.unlinkSync(f);
                deleted = true;
            }
        }
        if (deleted)
            (0, audit_1.audit)(req.user.login, 'upload.delete', `${type}:${key}`);
        res.json({ ok: true, deleted });
    });
    router.post('/api/upload/map/:zoneid', auth_1.requireAuth, (0, rbac_1.requirePermission)('upload:images'), async (req, res) => {
        const zoneid = parseInt(req.params.zoneid);
        if (isNaN(zoneid))
            return void res.status(400).json({ error: 'invalid zone id' });
        let zoneName;
        try {
            const [[row]] = await pool.execute('SELECT name FROM zone_settings WHERE zoneid=?', [zoneid]);
            if (!row)
                return void res.status(404).json({ error: 'zone not found' });
            zoneName = (0, catalog_1.normZoneName)(row.name);
        }
        catch (e) {
            return void res.status(500).json({ error: e.message });
        }
        const ext = (req.query.ext || 'png').replace(/[^a-z]/g, '') || 'png';
        req._uploadFilename = `${zoneName}.${ext}`;
        makeUploader(catalog_1.MAPS_DIR)(req, res, (err) => {
            if (err)
                return void res.status(400).json({ error: err.message });
            (0, audit_1.audit)(req.user.login, 'upload.map', `zone:${zoneid}`, { file: req.file.filename });
            (0, catalog_1.buildZoneMaps)(pool);
            res.json({ ok: true, file: req.file.filename, url: `/maps/${req.file.filename}` });
        });
    });
    router.post('/api/upload/item/:itemid', auth_1.requireAuth, (0, rbac_1.requirePermission)('upload:images'), (req, res) => {
        const itemid = parseInt(req.params.itemid);
        if (isNaN(itemid))
            return void res.status(400).json({ error: 'invalid item id' });
        req._uploadFilename = `${itemid}.png`;
        makeUploader(path_1.default.join(catalog_1.UPLOADS_DIR, 'items'))(req, res, (err) => {
            if (err)
                return void res.status(400).json({ error: err.message });
            const ext = MIME_EXT[req.file.mimetype] || 'png';
            const newName = `${itemid}.${ext}`;
            if (newName !== req.file.filename) {
                fs_1.default.renameSync(req.file.path, path_1.default.join(catalog_1.UPLOADS_DIR, 'items', newName));
            }
            (0, audit_1.audit)(req.user.login, 'upload.item', `item:${itemid}`);
            res.json({ ok: true, url: `/uploads/items/${newName}` });
        });
    });
    router.post('/api/upload/npc/:npcid', auth_1.requireAuth, (0, rbac_1.requirePermission)('upload:images'), (req, res) => {
        const npcid = parseInt(req.params.npcid);
        if (isNaN(npcid))
            return void res.status(400).json({ error: 'invalid npc id' });
        req._uploadFilename = `${npcid}.png`;
        makeUploader(path_1.default.join(catalog_1.UPLOADS_DIR, 'npcs'))(req, res, (err) => {
            if (err)
                return void res.status(400).json({ error: err.message });
            const ext = MIME_EXT[req.file.mimetype] || 'png';
            const newName = `${npcid}.${ext}`;
            if (newName !== req.file.filename) {
                fs_1.default.renameSync(req.file.path, path_1.default.join(catalog_1.UPLOADS_DIR, 'npcs', newName));
            }
            (0, audit_1.audit)(req.user.login, 'upload.npc', `npc:${npcid}`);
            res.json({ ok: true, url: `/uploads/npcs/${newName}` });
        });
    });
    router.post('/api/upload/mob', auth_1.requireAuth, (0, rbac_1.requirePermission)('upload:images'), (req, res) => {
        const rawName = req.query.name || '';
        if (!rawName)
            return void res.status(400).json({ error: 'name required' });
        const key = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        req._uploadFilename = `${key}.png`;
        makeUploader(path_1.default.join(catalog_1.UPLOADS_DIR, 'mobs'))(req, res, (err) => {
            if (err)
                return void res.status(400).json({ error: err.message });
            const ext = MIME_EXT[req.file.mimetype] || 'png';
            const newName = `${key}.${ext}`;
            if (newName !== req.file.filename) {
                fs_1.default.renameSync(req.file.path, path_1.default.join(catalog_1.UPLOADS_DIR, 'mobs', newName));
            }
            (0, audit_1.audit)(req.user.login, 'upload.mob', `mob:${key}`);
            res.json({ ok: true, url: `/uploads/mobs/${newName}`, key });
        });
    });
    return router;
}
