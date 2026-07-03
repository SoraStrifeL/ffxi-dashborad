import { Router } from 'express';
import { requireAuth, requireAdmin } from '../auth';
import { requirePermission, ROLE_PERMISSIONS } from '../rbac';
import { readAuditLog } from '../audit';
import { readCrashLog, clearCrashLog } from '../crashlog';

export function createAdminRouter(): Router {
  const router = Router();

  router.get('/api/roles', requireAuth, requirePermission('view:accounts'), (_req, res) => {
    res.json(ROLE_PERMISSIONS);
  });

  router.get('/api/audit', requireAuth, requirePermission('view:accounts'), (req, res) => {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit as string) || 200));
    res.json(readAuditLog(limit));
  });

  router.get('/api/crash-log', requireAuth, requireAdmin, (_req, res) => {
    res.json(readCrashLog());
  });

  router.delete('/api/crash-log', requireAuth, requireAdmin, (_req, res) => {
    clearCrashLog();
    res.json({ ok: true });
  });

  return router;
}
