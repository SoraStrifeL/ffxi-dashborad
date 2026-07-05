import { Router } from 'express';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { datEnabled, getStrings, stringResourceKeys, getTable, categoryKeys, getItemIcon, getStatusIcon, getDialog, dialogZones } from '../dat';

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

  // Zones that have a dialog table (id + name).
  router.get('/api/dat/dialog-zones', requireAuth, requirePermission('view:db'), (_req, res) => {
    if (!datEnabled()) { res.status(503).json({ error: 'DAT fetcher disabled' }); return; }
    res.json({ zones: dialogZones() });
  });

  // Per-zone dialog lines (paginated + searchable).
  router.get('/api/dat/dialog/:zoneId', requireAuth, requirePermission('view:db'), (req, res) => {
    if (!datEnabled()) { res.status(503).json({ error: 'DAT fetcher disabled' }); return; }
    const zoneId = parseInt(String(req.params.zoneId));
    if (!Number.isFinite(zoneId)) { res.status(400).json({ error: 'invalid zone' }); return; }
    const q = String(req.query.q || '').toLowerCase();
    const page = Math.max(0, parseInt(req.query.page as string) || 0);
    const PAGE = 100;
    let rows = getDialog(zoneId).map((text, id) => ({ id, text })).filter(r => r.text);
    if (q) rows = rows.filter(r => r.text.toLowerCase().includes(q));
    res.json({ zoneId, total: rows.length, page, rows: rows.slice(page * PAGE, page * PAGE + PAGE), hasMore: rows.length > (page + 1) * PAGE });
  });

  // Item icon PNG by item id. Public (non-sensitive game art) so <img> tags
  // work without an auth header; 404 when disabled or no icon.
  router.get('/api/dat/icon/:id', (req, res) => {
    if (!datEnabled()) { res.status(404).end(); return; }
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) { res.status(400).end(); return; }
    const png = getItemIcon(id);
    if (!png) { res.status(404).end(); return; }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(png);
  });

  // Status-effect icon PNG by status id. Public for the same reason as items.
  router.get('/api/dat/status-icon/:id', (req, res) => {
    if (!datEnabled()) { res.status(404).end(); return; }
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) { res.status(400).end(); return; }
    const png = getStatusIcon(id);
    if (!png) { res.status(404).end(); return; }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(png);
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
