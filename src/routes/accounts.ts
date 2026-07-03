import { Router } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';
import { requireAuth } from '../auth';
import { requirePermission, getAccountOverrides, setAccountOverrides, ALL_PERMISSIONS, type Permission } from '../rbac';
import { audit } from '../audit';
import { validateBody, validateParams } from '../validate';

const idParam       = z.object({ id: z.coerce.number().int().positive() });
const statusSchema  = z.object({ status: z.union([z.literal(0), z.literal(1)]) }).strict();
const privSchema    = z.object({ priv: z.coerce.number().int().min(0).max(5) }).strict();
const permsSchema   = z.object({ permissions: z.array(z.string()).max(64) }).strict();

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

  router.post('/api/accounts/:id/status', requireAuth, requirePermission('manage:accounts'), validateParams(idParam), validateBody(statusSchema), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { status } = req.body as { status: 0 | 1 };
      await pool.execute('UPDATE accounts SET status = ? WHERE id = ?', [status, id]);
      audit(req.user!.login, 'account.status', `account:${id}`, { status });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.post('/api/accounts/:id/priv', requireAuth, requirePermission('manage:accounts'), validateParams(idParam), validateBody(privSchema), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const privNum = Number(req.body.priv);
      await pool.execute('UPDATE accounts SET priv = ? WHERE id = ?', [privNum, id]);
      audit(req.user!.login, 'account.priv', `account:${id}`, { priv: privNum });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  router.get('/api/accounts/:id/permissions', requireAuth, requirePermission('manage:accounts'), validateParams(idParam), (req, res) => {
    const accid = Number(req.params.id);
    res.json({ accid, overrides: getAccountOverrides(accid) });
  });

  router.post('/api/accounts/:id/permissions', requireAuth, requirePermission('manage:accounts'), validateParams(idParam), validateBody(permsSchema), (req, res) => {
    const accid = Number(req.params.id);
    const { permissions } = req.body as { permissions: string[] };
    const valid = permissions.filter(p => ALL_PERMISSIONS.includes(p as Permission)) as Permission[];
    setAccountOverrides(accid, valid);
    audit(req.user!.login, 'account.permissions', `account:${accid}`, { permissions: valid });
    res.json({ ok: true, overrides: valid });
  });

  return router;
}
