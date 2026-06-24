import { Router } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';

export function createAccountsRouter(pool: Pool): Router {
  const router = Router();

  router.get('/api/accounts', requireAuth, requirePermission('view:accounts'), async (_req, res) => {
    try {
      const [rows] = await pool.execute<RowDataPacket[]>(`
        SELECT a.id, a.login, a.status, a.priv, a.timecreate, a.timelastmodify
        FROM accounts a
        ORDER BY a.timelastmodify DESC
      `);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/api/accounts/:id/status', requireAuth, requirePermission('manage:accounts'), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const { status } = (req.body as { status?: number }) || {};
      if (status !== 0 && status !== 1) { res.status(400).json({ error: 'status must be 0 or 1' }); return; }
      await pool.execute('UPDATE accounts SET status = ? WHERE id = ?', [status, id]);
      audit(req.user!.login, 'account.status', `account:${id}`, { status });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/api/accounts/:id/priv', requireAuth, requirePermission('manage:accounts'), async (req, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const { priv } = (req.body as { priv?: unknown }) || {};
      const privNum = parseInt(String(priv));
      if (isNaN(privNum) || privNum < 0 || privNum > 5) { res.status(400).json({ error: 'priv must be 0–5' }); return; }
      await pool.execute('UPDATE accounts SET priv = ? WHERE id = ?', [privNum, id]);
      audit(req.user!.login, 'account.priv', `account:${id}`, { priv: privNum });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  return router;
}
