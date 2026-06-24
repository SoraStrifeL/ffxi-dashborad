import { Router } from 'express';
import { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { userOwnsChar } from '../auth';
import { PLAYER_ALLOWED_ACTIONS } from '../catalog';
import { audit } from '../audit';

export function createQueueRouter(pool: Pool): Router {
  const router = Router();

  router.post('/api/queue', requireAuth, requirePermission('submit:queue'), async (req, res) => {
    try {
      const { charid, action, params } = (req.body as { charid?: number; action?: string; params?: unknown }) || {};
      if (!charid || !action) { res.status(400).json({ error: 'charid and action required' }); return; }
      if (req.user!.tier !== 'admin') {
        if (!(await userOwnsChar(pool, req.user!.accid, charid))) { res.status(403).json({ error: 'not your character' }); return; }
        if (!PLAYER_ALLOWED_ACTIONS.has(action)) { res.status(403).json({ error: 'action not allowed for players' }); return; }
      }
      const paramStr = typeof params === 'string' ? params : JSON.stringify(params || {});
      await pool.execute('INSERT INTO dashboard_queue (charid, action, params, requested_by) VALUES (?, ?, ?, ?)', [charid, action, paramStr, req.user!.login]);
      audit(req.user!.login, 'queue.action', `char:${charid}`, { action, params: paramStr });
      res.json({ queued: true });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/queue/recent/:charid', requireAuth, requirePermission('view:queue'), async (req, res) => {
    try {
      const charid = parseInt(req.params.charid as string);
      if (req.user!.tier !== 'admin' && !(await userOwnsChar(pool, req.user!.accid, charid)))
        { res.status(403).json({ error: 'not your character' }); return; }
      const [rows] = await pool.execute<RowDataPacket[]>(
        'SELECT id, action, params, status, result, created_at, processed_at FROM dashboard_queue WHERE charid = ? ORDER BY id DESC LIMIT 10', [charid]);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/queue/:id', requireAuth, requirePermission('view:queue'), async (req, res) => {
    try {
      const [[row]] = await pool.execute<RowDataPacket[]>(
        'SELECT id, action, status, result, created_at, processed_at FROM dashboard_queue WHERE id = ?',
        [parseInt(req.params.id as string)]);
      if (!row) { res.status(404).json({ error: 'not found' }); return; }
      res.json(row);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.post('/api/console', requireAuth, requirePermission('run:console'), async (req, res) => {
    try {
      const { cmd } = (req.body as { cmd?: string }) || {};
      if (!cmd || typeof cmd !== 'string') { res.status(400).json({ error: 'cmd required' }); return; }
      const [result] = await pool.execute<ResultSetHeader>(
        'INSERT INTO dashboard_queue (charid, action, params, requested_by) VALUES (0, "luaexec", ?, ?)',
        [cmd, req.user!.login]);
      audit(req.user!.login, 'console.exec', undefined, { cmd, queueId: result.insertId });
      res.json({ id: result.insertId });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  return router;
}
