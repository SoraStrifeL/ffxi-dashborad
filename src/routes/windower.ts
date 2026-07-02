import { Router } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { requireAuth } from '../auth';
import { WINDOWER_API_KEY, windowerPositions, windowerZoneEntities, calStore, saveCalStore } from '../catalog';
import { broadcast, broadcastToZone } from '../ws';
import type { WindowerPosition, ZoneEntity } from '../types';

interface WindowerDbRow { charid: number; mjob: number; mlvl: number; sjob: number; slvl: number; gmlevel: number; nation: number; }
const windowerDbCache = new Map<string, WindowerDbRow>();

function normalizeWindower(p: WindowerPosition) {
  const db = windowerDbCache.get(p.name);
  return {
    charname:  p.name,
    pos_x:     p.x,
    pos_y:     p.z,   // Windower z = elevation (game Z) = DB pos_y
    pos_z:     p.y,   // Windower y = north/south (game Y) = DB pos_z
    pos_zone:  p.zone,
    map_index: p.map_index,
    hp:        p.hp,
    mp:        p.mp,
    online:    1,
    charid:    db?.charid   ?? null,
    mjob:      db?.mjob     ?? 0,
    mlvl:      db?.mlvl     ?? 0,
    sjob:      db?.sjob     ?? 0,
    slvl:      db?.slvl     ?? 0,
    gmlevel:   db?.gmlevel  ?? 0,
    nation:    db?.nation   ?? 0,
  };
}

// --- Auto-calibration from windower.ffxi.get_map_data() ---
// The addon sends the exact pixel (on the native 512x512 map sheet) that the game
// draws the player at, straight from the client's map DAT constants. Two samples far
// enough apart solve the affine world->sheet transform per zone; the calibration
// bounds are the world coords at the sheet edges. Convention matches the client
// renderer: maxX = left edge, maxZ = top edge. Zones already in calStore are skipped.
const SHEET = 512;
const CAL_MIN_DELTA = 25; // world units of separation required on each axis
interface CalSample { x: number; z: number; px: number; py: number }
const calSamples = new Map<number, CalSample[]>();

function recordCalSample(zone: number, s: CalSample): void {
  if (calStore[zone]) return;
  const arr = calSamples.get(zone) ?? [];
  const mate = arr.find(o => Math.abs(o.x - s.x) >= CAL_MIN_DELTA && Math.abs(o.z - s.z) >= CAL_MIN_DELTA);
  if (!mate) {
    arr.push(s);
    if (arr.length > 50) arr.shift();
    calSamples.set(zone, arr);
    return;
  }
  const sx = (s.px - mate.px) / (s.x - mate.x);
  const sy = (s.py - mate.py) / (s.z - mate.z);
  if (!isFinite(sx) || !isFinite(sy) || Math.abs(sx) < 0.02 || Math.abs(sy) < 0.02) return;
  const ox = s.px - s.x * sx;
  const oy = s.py - s.z * sy;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  calStore[zone] = {
    minX: r1((SHEET - ox) / sx), // world X at sheet right edge
    maxX: r1((0 - ox) / sx),     // left edge
    minZ: r1((SHEET - oy) / sy), // bottom edge
    maxZ: r1((0 - oy) / sy),     // top edge
  };
  saveCalStore();
  calSamples.delete(zone);
  console.log(`[autocal] zone ${zone} calibrated from Windower map data:`, JSON.stringify(calStore[zone]));
}

export function createWindowerRouter(pool: Pool): Router {
  const router = Router();

  router.post('/api/windower/position', async (req, res) => {
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

    // Optional get_map_data fields from the addon: map pixel on the native 512px sheet.
    // Windower y = north/south = DB pos_z, so entry.y is the world Z for calibration.
    // Only samples from sub-map 0 are used (dashboard calibration is per-zone, floor 0).
    const { map_id, map_x, map_y } = (req.body as { map_id?: unknown; map_x?: unknown; map_y?: unknown });
    if (map_x != null && map_y != null && parseInt(String(map_id ?? 0)) === 0) {
      const px = parseFloat(String(map_x)), py = parseFloat(String(map_y));
      if (isFinite(px) && isFinite(py) && px >= 0 && px <= SHEET && py >= 0 && py <= SHEET)
        recordCalSample(entry.zone, { x: entry.x, z: entry.y, px, py });
      else if (isFinite(px) && isFinite(py))
        console.log(`[autocal] zone ${entry.zone}: map pixel out of 0..${SHEET} range (${px}, ${py}) — sheet size assumption may be wrong`);
    }

    // Refresh DB data for the posting player (job, level, charid for Map overlay)
    try {
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT c.charid, c.nation, c.gmlevel, cs.mjob, cs.mlvl, cs.sjob, cs.slvl
         FROM chars c LEFT JOIN char_stats cs ON c.charid = cs.charid
         WHERE c.charname = ? LIMIT 1`,
        [entry.name]
      );
      if (rows.length > 0) windowerDbCache.set(entry.name, rows[0] as WindowerDbRow);
    } catch (_) {}

    // Each player in the zone is normalized using their own cached DB row
    const zonePlayers = [...windowerPositions.values()]
      .filter(p => p.zone === entry.zone)
      .map(normalizeWindower);
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

  router.get('/api/windower/zone_entities/:zoneId', requireAuth, (req, res) => {
    const zoneId = parseInt(req.params.zoneId as string);
    const record = windowerZoneEntities.get(zoneId);
    if (!record) return void res.status(404).json({ error: 'no entity data for this zone' });
    res.json({ zoneId, ...record });
  });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
  router.post('/api/claude', async (req, res) => {
    if (!WINDOWER_API_KEY || req.headers['x-windower-key'] !== WINDOWER_API_KEY)
      return void res.status(403).json({ error: 'forbidden' });
    if (!ANTHROPIC_API_KEY)
      return void res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on server' });

    const { message, system, model, max_tokens } = (req.body as any) || {};
    if (!message) return void res.status(400).json({ error: 'message required' });

    const ALLOWED_MODELS = new Set(['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-8']);
    const safeModel = ALLOWED_MODELS.has(model) ? model : 'claude-sonnet-5';
    const safeMaxTokens = Math.min(Math.max(1, parseInt(max_tokens) || 1024), 2048);

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model:      safeModel,
          max_tokens: safeMaxTokens,
          system:     system     || 'You are a helpful assistant embedded in Final Fantasy XI. Be concise.',
          messages:   [{ role: 'user', content: message }],
        }),
      });
      const data = await r.json() as any;
      if (!r.ok) return void res.status(r.status).json({ error: data.error?.message || 'Claude API error' });
      res.json({ reply: data.content?.[0]?.text || '' });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
