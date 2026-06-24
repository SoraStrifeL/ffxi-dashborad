"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMapRouter = createMapRouter;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const express_1 = require("express");
const auth_1 = require("../auth");
const catalog_1 = require("../catalog");
function createMapRouter(pool) {
    const router = (0, express_1.Router)();
    router.get('/api/stats', auth_1.requireAuth, async (_req, res) => {
        try {
            res.json(await (0, catalog_1.queryStats)(pool));
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.get('/api/players', auth_1.requireAuth, async (_req, res) => {
        try {
            res.json(await (0, catalog_1.queryPlayers)(pool));
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // Returns { zoneId: floorCount } for all zones with at least one map file on disk
    router.get('/api/maps', (_req, res) => {
        const result = {};
        Object.entries(catalog_1.ZONE_MAPS).forEach(([zoneId, files]) => {
            const available = files.filter(f => fs_1.default.existsSync(path_1.default.join(catalog_1.MAPS_DIR, f)));
            if (available.length)
                result[Number(zoneId)] = available.length;
        });
        res.json(result);
    });
    router.get('/api/map/:zoneId', (req, res) => {
        const zoneId = parseInt(req.params.zoneId);
        const files = catalog_1.ZONE_MAPS[zoneId];
        if (!files) {
            res.status(404).json({ error: 'No map for this zone' });
            return;
        }
        const floor = Math.max(0, Math.min(parseInt(req.query.floor || '0'), files.length - 1));
        const filepath = path_1.default.join(catalog_1.MAPS_DIR, files[floor]);
        if (!fs_1.default.existsSync(filepath)) {
            res.status(404).json({ error: 'Map file not found on disk' });
            return;
        }
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(filepath);
    });
    router.get('/api/npcs/:zone', auth_1.requireAuth, async (req, res) => {
        try {
            const [rows] = await pool.execute(`
        SELECT npcid, CONVERT(name USING utf8) AS name, pos_x, pos_y, pos_z
        FROM npc_list
        WHERE (npcid >> 12) - 4096 = ?
          AND pos_x != 0 AND pos_z != 0
          AND pos_x BETWEEN -512 AND 512
          AND pos_z BETWEEN -512 AND 512
        ORDER BY name
      `, [parseInt(req.params.zone)]);
            res.json(rows);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.get('/api/mobs/:zone', auth_1.requireAuth, async (req, res) => {
        try {
            const [rows] = await pool.execute(`
        SELECT ms.mobid,
               ms.mobname AS name,
               ms.pos_x, ms.pos_y, ms.pos_z,
               mp.mJob, mp.aggro, mp.links,
               mss.family, mss.ecosystem
        FROM mob_spawn_points ms
        LEFT JOIN mob_groups mg ON ms.groupid = mg.groupid AND ((ms.mobid>>12)&0xFFF)=mg.zoneid
        LEFT JOIN mob_pools  mp ON mg.poolid  = mp.poolid
        LEFT JOIN mob_species_system mss ON mp.speciesid = mss.speciesID
        WHERE (ms.mobid >> 12) - 4096 = ?
          AND ms.pos_x != 0 AND ms.pos_z != 0
          AND ms.pos_x BETWEEN -512 AND 512
          AND ms.pos_z BETWEEN -512 AND 512
        ORDER BY ms.mobname
      `, [parseInt(req.params.zone)]);
            res.json(rows);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.get('/api/bounds', auth_1.requireAuth, async (_req, res) => {
        try {
            const [rows] = await pool.execute(`
        SELECT zone,
               MIN(pos_x) AS min_x, MAX(pos_x) AS max_x,
               MIN(pos_z) AS min_z, MAX(pos_z) AS max_z
        FROM (
          SELECT (npcid >> 12) - 4096 AS zone, pos_x, pos_z
          FROM npc_list
          WHERE pos_x BETWEEN -2000 AND 2000 AND pos_z BETWEEN -2000 AND 2000
          UNION ALL
          SELECT (mobid >> 12) - 4096 AS zone, pos_x, pos_z
          FROM mob_spawn_points
          WHERE pos_x != 0 AND pos_z != 0
            AND pos_x BETWEEN -2000 AND 2000 AND pos_z BETWEEN -2000 AND 2000
        ) t
        GROUP BY zone
        HAVING COUNT(*) >= 2
      `);
            const out = {};
            rows.forEach(r => {
                const padX = Math.max((Number(r.max_x) - Number(r.min_x)) * 0.12, 5);
                const padZ = Math.max((Number(r.max_z) - Number(r.min_z)) * 0.12, 5);
                out[r.zone] = {
                    minX: +(Number(r.min_x) - padX).toFixed(1),
                    maxX: +(Number(r.max_x) + padX).toFixed(1),
                    minZ: +(Number(r.min_z) - padZ).toFixed(1),
                    maxZ: +(Number(r.max_z) + padZ).toFixed(1),
                };
            });
            res.json(out);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.get('/api/calibrations', auth_1.requireAuth, (_req, res) => res.json(catalog_1.calStore));
    router.post('/api/calibrations/:zoneId', auth_1.requireAdmin, (req, res) => {
        const zoneId = parseInt(req.params.zoneId);
        if (!Number.isFinite(zoneId)) {
            res.status(400).json({ error: 'Invalid zone' });
            return;
        }
        const { minX, maxX, minZ, maxZ } = req.body || {};
        if ([minX, maxX, minZ, maxZ].some(v => typeof v !== 'number' || !isFinite(v)) || minX >= maxX || minZ >= maxZ) {
            res.status(400).json({ error: 'Invalid bounds' });
            return;
        }
        catalog_1.calStore[zoneId] = { minX, maxX, minZ, maxZ };
        (0, catalog_1.saveCalStore)();
        res.json({ ok: true });
    });
    router.delete('/api/calibrations/:zoneId', auth_1.requireAdmin, (req, res) => {
        const zoneId = parseInt(req.params.zoneId);
        delete catalog_1.calStore[zoneId];
        (0, catalog_1.saveCalStore)();
        res.json({ ok: true });
    });
    return router;
}
