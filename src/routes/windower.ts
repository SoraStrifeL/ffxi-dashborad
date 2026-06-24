import { Router } from 'express';
import { WINDOWER_API_KEY, windowerPositions, windowerZoneEntities } from '../catalog';
import { broadcast, broadcastToZone } from '../ws';
import type { WindowerPosition, ZoneEntity } from '../types';

export function createWindowerRouter(): Router {
  const router = Router();

  router.post('/api/windower/position', (req, res) => {
    if (!WINDOWER_API_KEY || req.headers['x-windower-key'] !== WINDOWER_API_KEY)
      return void res.status(401).json({ error: 'unauthorized' });

    const { name, zone, x, y, z, map_index, hp, mp, tp } = (req.body as Partial<WindowerPosition> & { map_index?: number }) || {};
    if (!name || zone == null || x == null || z == null)
      return void res.status(400).json({ error: 'name, zone, x, z required' });

    const entry: WindowerPosition = {
      name:      String(name),
      zone:      parseInt(String(zone)),
      x:         parseFloat(String(x)),
      y:         parseFloat(String(y ?? 0)),
      z:         parseFloat(String(z)),
      map_index: parseInt(String(map_index ?? 0)),
      hp:        parseInt(String(hp ?? 0)),
      mp:        parseInt(String(mp ?? 0)),
      tp:        parseInt(String(tp ?? 0)),
      ts:        Date.now(),
    };
    windowerPositions.set(entry.name, entry);

    const zonePlayers = [...windowerPositions.values()].filter(p => p.zone === entry.zone);
    broadcastToZone(entry.zone, 'zone_players', { zoneId: entry.zone, players: zonePlayers });
    broadcast('windower_positions', Object.fromEntries(windowerPositions));

    res.json({ ok: true });
  });

  router.post('/api/windower/zone_entities', (req, res) => {
    if (!WINDOWER_API_KEY || req.headers['x-windower-key'] !== WINDOWER_API_KEY)
      return void res.status(401).json({ error: 'unauthorized' });

    const { zone, entities } = (req.body as { zone?: unknown; entities?: unknown[] }) || {};
    if (zone == null || !Array.isArray(entities))
      return void res.status(400).json({ error: 'zone and entities[] required' });

    const zoneId = parseInt(String(zone));
    const record = {
      ts: Date.now(),
      entities: entities.map((e: any) => ({
        id:         parseInt(e.id   ?? 0),
        index:      parseInt(e.index ?? 0),
        name:       String(e.name   ?? ''),
        x:          parseFloat(e.x  ?? 0),
        y:          parseFloat(e.y  ?? 0),
        z:          parseFloat(e.z  ?? 0),
        spawn_type: String(e.spawn_type ?? 'npc'),
        model_id:   parseInt(e.model_id ?? 0),
      } as ZoneEntity)),
    };

    windowerZoneEntities.set(zoneId, record);
    broadcastToZone(zoneId, 'zone_entities', { zoneId, ...record });

    res.json({ ok: true, count: record.entities.length });
  });

  router.get('/api/windower/zone_entities/:zoneId', (req, res) => {
    const zoneId = parseInt(req.params.zoneId);
    const record = windowerZoneEntities.get(zoneId);
    if (!record) return void res.status(404).json({ error: 'no entity data for this zone' });
    res.json({ zoneId, ...record });
  });

  return router;
}
