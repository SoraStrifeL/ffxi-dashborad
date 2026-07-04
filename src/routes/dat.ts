import { Router } from 'express';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { datEnabled, getStrings, stringResourceKeys, getTable, categoryKeys } from '../dat';

export function createDatRouter(): Router {
  const router = Router();

  // Feature status + available string resources / categories.
  router.get('/api/dat/status', requireAuth, (_req, res) => {
    res.json({ enabled: datEnabled(), resources: stringResourceKeys(), categories: categoryKeys() });
  });

  // Joined id/name/description table for a display category (paginated + search).
  router.get('/api/dat/table/:cat', requireAuth, requirePermission('view:db'), (req, res) => {
    if (!datEnabled()) { res.status(503).json({ error: 'DAT fetcher disabled (no DAT_DIR)' }); return; }
    const cat = String(req.params.cat);
    if (!categoryKeys().includes(cat)) { res.status(404).json({ error: 'unknown category' }); return; }
    const q = String(req.query.q || '').toLowerCase();
    const page = Math.max(0, parseInt(req.query.page as string) || 0);
    const PAGE = 100;
    let rows = getTable(cat);
    if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q));
    res.json({ cat, total: rows.length, page, rows: rows.slice(page * PAGE, page * PAGE + PAGE), hasMore: rows.length > (page + 1) * PAGE });
  });

  // Paginated / searchable string list for a resource key.
  router.get('/api/dat/strings/:key', requireAuth, requirePermission('view:db'), (req, res) => {
    if (!datEnabled()) { res.status(503).json({ error: 'DAT fetcher disabled (no DAT_DIR)' }); return; }
    const key = String(req.params.key);
    if (!stringResourceKeys().includes(key)) { res.status(404).json({ error: 'unknown resource' }); return; }
    const all = getStrings(key);
    const q = String(req.query.q || '').toLowerCase();
    const page = Math.max(0, parseInt(req.query.page as string) || 0);
    const PAGE = 100;
    // keep the id (index); drop empty slots
    let rows = all.map((name, id) => ({ id, name })).filter(r => r.name);
    if (q) rows = rows.filter(r => r.name.toLowerCase().includes(q));
    const slice = rows.slice(page * PAGE, page * PAGE + PAGE);
    res.json({ key, total: rows.length, page, rows: slice, hasMore: rows.length > (page + 1) * PAGE });
  });

  // Single entry by id.
  router.get('/api/dat/strings/:key/:id', requireAuth, requirePermission('view:db'), (req, res) => {
    if (!datEnabled()) { res.status(503).json({ error: 'DAT fetcher disabled' }); return; }
    const key = String(req.params.key);
    if (!stringResourceKeys().includes(key)) { res.status(404).json({ error: 'unknown resource' }); return; }
    const id = parseInt(String(req.params.id));
    const list = getStrings(key);
    const name = Number.isFinite(id) ? list[id] : undefined;
    if (!name) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ key, id, name });
  });

  return router;
}
