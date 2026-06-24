import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Router } from 'express';
import { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';

export const TIMERS_FILE = path.join(__dirname, '..', '..', 'data', 'timers.json');

interface Timer {
  id: string;
  name: string;
  zone: string;
  respawnMin: number;
  respawnMax: number;
  notes: string;
  groupId: number | null;
  nmName: string | null;
  zoneId: number | null;
  spawnX: number | null;
  spawnY: number | null;
  spawnZ: number | null;
  type: string;
  roeId: number | null;
  goal: number | null;
  lastKill: number | null;
  created: number;
  updated: number;
}

export function readTimers(): Timer[] {
  try { return JSON.parse(fs.readFileSync(TIMERS_FILE, 'utf8')) as Timer[]; } catch { return []; }
}
export function writeTimers(t: Timer[]): void {
  fs.mkdirSync(path.dirname(TIMERS_FILE), { recursive: true });
  fs.writeFileSync(TIMERS_FILE, JSON.stringify(t, null, 2));
}

export function createTimersRouter(pool: Pool): Router {
  const router = Router();

  router.get('/api/db/nms', requireAuth, async (req, res) => {
    try {
      const q = `%${((req.query.q as string) || '').trim().replace(/_/g, ' ')}%`;
      const minRespawn = Math.max(0, parseInt((req.query.minRespawn as string) || '3600'));
      const [rows] = await pool.execute<RowDataPacket[]>(`
        SELECT mg.groupid, mg.name, mg.respawntime, mg.zoneid, z.name AS zone_name,
               AVG(sp.pos_x) AS spawn_x, AVG(sp.pos_y) AS spawn_y, AVG(sp.pos_z) AS spawn_z
        FROM mob_groups mg
        JOIN zone_settings z ON mg.zoneid = z.zoneid
        LEFT JOIN mob_spawn_points sp ON sp.groupid = mg.groupid
        WHERE mg.respawntime >= ?
          AND mg.name IS NOT NULL AND mg.name != ''
          AND (REPLACE(mg.name,'_',' ') LIKE ? OR z.name LIKE ?)
        GROUP BY mg.groupid, mg.name, mg.zoneid, mg.respawntime
        ORDER BY mg.respawntime DESC, z.name, mg.name
        LIMIT 100`, [minRespawn, q, q]);
      res.json(rows.map(r => ({
        groupId:    r.groupid,
        name:       (r.name as string).replace(/_/g, ' '),
        nmName:     r.name,
        zone:       (r.zone_name as string).replace(/_/g, ' '),
        zoneId:     r.zoneid,
        spawnX:     r.spawn_x  != null ? +parseFloat(String(r.spawn_x)).toFixed(3)  : null,
        spawnY:     r.spawn_y  != null ? +parseFloat(String(r.spawn_y)).toFixed(3)  : null,
        spawnZ:     r.spawn_z  != null ? +parseFloat(String(r.spawn_z)).toFixed(3)  : null,
        respawnSecs: r.respawntime,
        respawnMin:  +(Number(r.respawntime) / 3600).toFixed(2),
        respawnMax:  +((Number(r.respawntime) + (Number(r.respawntime) >= 75600 ? 10800 : Number(r.respawntime) >= 3600 ? 3600 : 1800)) / 3600).toFixed(2),
      })));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/timers', requireAuth, (_req, res) => res.json(readTimers()));

  router.post('/api/timers', requireAuth, requirePermission('manage:timers'), (req, res) => {
    const { id, name, zone, respawnMin, respawnMax, notes, groupId, nmName, zoneId, spawnX, spawnY, spawnZ, type, roeId, goal } = (req.body as Partial<Timer & { id?: string }>) || {};
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    const timers = readTimers();
    const now = Date.now();
    if (id) {
      const idx = timers.findIndex(t => t.id === id);
      const base: Timer = idx >= 0 ? timers[idx] : { id, created: now, lastKill: null, name: '', zone: '', respawnMin: 1, respawnMax: 1, notes: '', groupId: null, nmName: null, zoneId: null, spawnX: null, spawnY: null, spawnZ: null, type: 'nm', roeId: null, goal: null, updated: now };
      const updated: Timer = { ...base, name: name!, zone: zone || '', respawnMin: Number(respawnMin) || 1, respawnMax: Number(respawnMax) || 1, notes: notes || '', groupId: groupId ?? null, nmName: nmName ?? null, zoneId: zoneId ?? null, spawnX: spawnX ?? null, spawnY: spawnY ?? null, spawnZ: spawnZ ?? null, type: type || 'nm', roeId: roeId ?? null, goal: goal ?? null, updated: now };
      if (idx >= 0) timers[idx] = updated; else timers.push(updated);
    } else {
      timers.push({ id: randomUUID(), name: name!, zone: zone || '', respawnMin: Number(respawnMin) || 1, respawnMax: Number(respawnMax) || 1, notes: notes || '', groupId: groupId ?? null, nmName: nmName ?? null, zoneId: zoneId ?? null, spawnX: spawnX ?? null, spawnY: spawnY ?? null, spawnZ: spawnZ ?? null, type: type || 'nm', roeId: roeId ?? null, goal: goal ?? null, lastKill: null, created: now, updated: now });
    }
    writeTimers(timers);
    audit(req.user!.login, 'timer.save', name!);
    res.json({ ok: true, timers: readTimers() });
  });

  router.delete('/api/timers/:id', requireAuth, requirePermission('manage:timers'), (req, res) => {
    const timerId = req.params.id as string;
    const all = readTimers();
    const t = all.find(t => t.id === timerId);
    writeTimers(all.filter(t => t.id !== timerId));
    if (t) audit(req.user!.login, 'timer.delete', t.name);
    res.json({ ok: true });
  });

  router.post('/api/timers/:id/kill', requireAuth, requirePermission('manage:timers'), (req, res) => {
    const timers = readTimers();
    const t = timers.find(t => t.id === (req.params.id as string));
    if (!t) { res.status(404).json({ error: 'not found' }); return; }
    t.lastKill = (req.body as { at?: number })?.at ? Number((req.body as { at?: number }).at) : Date.now();
    writeTimers(timers);
    audit(req.user!.login, 'timer.kill', t.name, { at: t.lastKill });
    res.json({ ok: true });
  });

  router.post('/api/timers/:id/reset', requireAuth, requirePermission('manage:timers'), (req, res) => {
    const timers = readTimers();
    const t = timers.find(t => t.id === (req.params.id as string));
    if (!t) { res.status(404).json({ error: 'not found' }); return; }
    t.lastKill = null;
    writeTimers(timers);
    audit(req.user!.login, 'timer.reset', t.name);
    res.json({ ok: true });
  });

  router.post('/api/nm/checkall', requireAuth, async (req, res) => {
    try {
      const items = (req.body as Array<{ groupId: number; nmName: string }>) || [];
      if (!items.length) { res.json({ queued: false }); return; }
      const mobIdsByItem = await Promise.all(items.map(async item => {
        const [rows] = await pool.execute<RowDataPacket[]>(
          `SELECT DISTINCT sp.mobid FROM mob_spawn_points sp
           WHERE sp.groupid=? AND (sp.mobid >> 12) - 4096 IN
             (SELECT mg.zoneid FROM mob_groups mg WHERE mg.groupid=? AND mg.name=?)
           ORDER BY sp.mobid`, [parseInt(String(item.groupId)), parseInt(String(item.groupId)), item.nmName || '']);
        return rows.map(r => r.mobid as number);
      }));
      const entries = items.map((item, i) => {
        const ids = mobIdsByItem[i].join(',');
        const safeName = (item.nmName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        if (!ids) return `t[${i + 1}]="0|0|0"`;
        return `do local f=false;local h=0;local hp=0;for _,id in ipairs({${ids}})do local m=GetMobByID(id);if m and m:getName()=="${safeName}"then h=m:getHPP();hp=m:getHP();f=true;break end end;t[${i + 1}]=(f and"1"or"0").."|"..h.."|"..hp end`;
      }).join(';');
      const lua = `local t={};${entries};return table.concat(t,";")`;
      const [result] = await pool.execute<ResultSetHeader>(
        'INSERT INTO dashboard_queue (charid,action,params,requested_by) VALUES (0,"luaexec",?,"dashboard")', [lua]);
      res.json({ queued: true, id: result.insertId, count: items.length });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/api/nm/check', requireAuth, async (req, res) => {
    try {
      const { groupId, nmName } = (req.body as { groupId?: string | number; nmName?: string }) || {};
      if (!groupId || !nmName) { res.status(400).json({ error: 'groupId and nmName required' }); return; }
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT DISTINCT sp.mobid FROM mob_spawn_points sp
         WHERE sp.groupid=? AND (sp.mobid >> 12) - 4096 IN
           (SELECT mg.zoneid FROM mob_groups mg WHERE mg.groupid=? AND mg.name=?)
         ORDER BY sp.mobid LIMIT 30`, [groupId, groupId, nmName]);
      if (!rows.length) { res.json({ queued: false, reason: 'no spawn points found' }); return; }
      const ids = rows.map(r => r.mobid as number);
      const safeName = nmName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const lua = `local found=false;local hpp=0;local hp=0;for _,id in ipairs({${ids.join(',')}})do local mob=GetMobByID(id);if mob then local n=mob:getName();if n=="${safeName}"then hpp=mob:getHPP();hp=mob:getHP();found=true;break end end end;if found then return("spawned|"..hpp.."|"..hp)else return"not_spawned"end`;
      const [result] = await pool.execute<ResultSetHeader>(
        'INSERT INTO dashboard_queue (charid,action,params,requested_by) VALUES (0,"luaexec",?,"dashboard")', [lua]);
      res.json({ queued: true, id: result.insertId });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/nm/spawnpoint', requireAuth, requirePermission('manage:timers'), async (req, res) => {
    try {
      const { groupId, nmName } = req.query as { groupId?: string; nmName?: string };
      if (!groupId || !nmName) { res.status(400).json({ error: 'groupId and nmName required' }); return; }
      const safeName = (nmName || '').replace(/_/g, ' ');
      const [rows] = await pool.execute<RowDataPacket[]>(`
        SELECT sp.pos_x AS x, sp.pos_y AS y, sp.pos_z AS z, mg.zoneid
        FROM mob_spawn_points sp
        JOIN mob_groups mg ON mg.groupid = sp.groupid AND REPLACE(mg.name,'_',' ')=?
        WHERE sp.groupid=? AND (sp.pos_x!=0 OR sp.pos_z!=0)
        ORDER BY sp.mobid LIMIT 1`, [safeName, parseInt(groupId)]);
      if (!rows.length) { res.json({ found: false }); return; }
      const r = rows[0];
      res.json({ found: true, x: +parseFloat(String(r.x)).toFixed(3), y: +parseFloat(String(r.y)).toFixed(3), z: +parseFloat(String(r.z)).toFixed(3), zoneId: r.zoneid });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/nm/result/:id', requireAuth, async (req, res) => {
    try {
      const [[row]] = await pool.execute<RowDataPacket[]>(
        'SELECT status, result FROM dashboard_queue WHERE id=? AND action="luaexec" AND requested_by="dashboard"',
        [parseInt(req.params.id as string)]);
      if (!row) { res.status(404).json({ error: 'not found' }); return; }
      res.json(row);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  return router;
}
