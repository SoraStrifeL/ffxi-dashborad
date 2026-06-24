import { Router } from 'express';
import { requireAuth } from '../auth';
import { requirePermission, ROLE_PERMISSIONS } from '../rbac';
import { readAuditLog } from '../audit';

export function createAdminRouter(): Router {
  const router = Router();

  router.get('/api/roles', requireAuth, requirePermission('view:accounts'), (_req, res) => {
    res.json(ROLE_PERMISSIONS);
  });

  router.get('/api/audit', requireAuth, requirePermission('view:accounts'), (req, res) => {
    const limit = Math.min(500, parseInt((req.query.limit as string) || '200'));
    res.json(readAuditLog(limit));
  });

  return router;
}
