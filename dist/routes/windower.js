"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWindowerRouter = createWindowerRouter;
const express_1 = require("express");
const catalog_1 = require("../catalog");
const ws_1 = require("../ws");
function createWindowerRouter() {
    const router = (0, express_1.Router)();
    router.post('/api/windower/position', (req, res) => {
        if (!catalog_1.WINDOWER_API_KEY || req.headers['x-windower-key'] !== catalog_1.WINDOWER_API_KEY)
            return void res.status(401).json({ error: 'unauthorized' });
        const { name, zone, x, y, z, map_index, hp, mp, tp } = req.body || {};
        if (!name || zone == null || x == null || z == null)
            return void res.status(400).json({ error: 'name, zone, x, z required' });
        const entry = {
            name: String(name),
            zone: parseInt(String(zone)),
            x: parseFloat(String(x)),
            y: parseFloat(String(y ?? 0)),
            z: parseFloat(String(z)),
            map_index: parseInt(String(map_index ?? 0)),
            hp: parseInt(String(hp ?? 0)),
            mp: parseInt(String(mp ?? 0)),
            tp: parseInt(String(tp ?? 0)),
            ts: Date.now(),
        };
        catalog_1.windowerPositions.set(entry.name, entry);
        const zonePlayers = [...catalog_1.windowerPositions.values()].filter(p => p.zone === entry.zone);
        (0, ws_1.broadcastToZone)(entry.zone, 'zone_players', { zoneId: entry.zone, players: zonePlayers });
        (0, ws_1.broadcast)('windower_positions', Object.fromEntries(catalog_1.windowerPositions));
        res.json({ ok: true });
    });
    router.post('/api/windower/zone_entities', (req, res) => {
        if (!catalog_1.WINDOWER_API_KEY || req.headers['x-windower-key'] !== catalog_1.WINDOWER_API_KEY)
            return void res.status(401).json({ error: 'unauthorized' });
        const { zone, entities } = req.body || {};
        if (zone == null || !Array.isArray(entities))
            return void res.status(400).json({ error: 'zone and entities[] required' });
        const zoneId = parseInt(String(zone));
        const record = {
            ts: Date.now(),
            entities: entities.map((e) => ({
                id: parseInt(e.id ?? 0),
                index: parseInt(e.index ?? 0),
                name: String(e.name ?? ''),
                x: parseFloat(e.x ?? 0),
                y: parseFloat(e.y ?? 0),
                z: parseFloat(e.z ?? 0),
                spawn_type: String(e.spawn_type ?? 'npc'),
                model_id: parseInt(e.model_id ?? 0),
            })),
        };
        catalog_1.windowerZoneEntities.set(zoneId, record);
        (0, ws_1.broadcastToZone)(zoneId, 'zone_entities', { zoneId, ...record });
        res.json({ ok: true, count: record.entities.length });
    });
    router.get('/api/windower/zone_entities/:zoneId', (req, res) => {
        const zoneId = parseInt(req.params.zoneId);
        const record = catalog_1.windowerZoneEntities.get(zoneId);
        if (!record)
            return void res.status(404).json({ error: 'no entity data for this zone' });
        res.json({ zoneId, ...record });
    });
    return router;
}
