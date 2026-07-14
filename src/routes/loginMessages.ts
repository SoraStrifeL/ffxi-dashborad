import { Router } from 'express';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';
import {
  readLoginMessages, createLoginMessage, updateLoginMessage,
  deleteLoginMessage, moveLoginMessage, toPublic,
} from '../loginMessages';

export function createLoginMessagesRouter(): Router {
  const router = Router();

  router.get('/api/login-messages', (_req, res) => {
    res.json(readLoginMessages().filter(m => m.active).map(toPublic));
  });

  router.get('/api/dashboard/login-messages', requireAuth, requirePermission('manage:settings'), (_req, res) => {
    res.json(readLoginMessages());
  });

  router.post('/api/dashboard/login-messages', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const { title, body, active } = (req.body as { title?: string; body?: string; active?: boolean }) || {};
    if (typeof title !== 'string' || typeof body !== 'string') {
      res.status(400).json({ error: 'title and body are required strings' });
      return;
    }
    const msg = createLoginMessage(title, body, active !== false);
    audit(req.user!.login, 'settings.loginMessage.create', msg.id, { title: msg.title });
    res.json({ ok: true, message: msg });
  });

  router.put('/api/dashboard/login-messages/:id', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const id = req.params.id as string;
    const { title, body, active } = (req.body as { title?: string; body?: string; active?: boolean }) || {};
    const updated = updateLoginMessage(id, { title, body, active });
    if (!updated) { res.status(404).json({ error: 'not found' }); return; }
    audit(req.user!.login, 'settings.loginMessage.update', updated.id, { title: updated.title });
    res.json({ ok: true, message: updated });
  });

  router.delete('/api/dashboard/login-messages/:id', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const id = req.params.id as string;
    const removed = deleteLoginMessage(id);
    if (!removed) { res.status(404).json({ error: 'not found' }); return; }
    audit(req.user!.login, 'settings.loginMessage.delete', removed.id, { title: removed.title });
    res.json({ ok: true });
  });

  router.post('/api/dashboard/login-messages/:id/move', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const id = req.params.id as string;
    const { direction } = (req.body as { direction?: string }) || {};
    if (direction !== 'up' && direction !== 'down') {
      res.status(400).json({ error: 'direction must be "up" or "down"' });
      return;
    }
    const messages = moveLoginMessage(id, direction);
    if (!messages) { res.status(404).json({ error: 'not found' }); return; }
    audit(req.user!.login, 'settings.loginMessage.move', id, { direction });
    res.json({ ok: true, messages });
  });

  return router;
}
