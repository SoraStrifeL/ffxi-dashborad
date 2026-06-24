"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createQueueRouter = createQueueRouter;
const express_1 = require("express");
const auth_1 = require("../auth");
const rbac_1 = require("../rbac");
const auth_2 = require("../auth");
const catalog_1 = require("../catalog");
const audit_1 = require("../audit");
function createQueueRouter(pool) {
    const router = (0, express_1.Router)();
    router.post('/api/queue', auth_1.requireAuth, (0, rbac_1.requirePermission)('submit:queue'), async (req, res) => {
        try {
            const { charid, action, params } = req.body || {};
            if (!charid || !action) {
                res.status(400).json({ error: 'charid and action required' });
                return;
            }
            if (req.user.tier !== 'admin') {
                if (!(await (0, auth_2.userOwnsChar)(pool, req.user.accid, charid))) {
                    res.status(403).json({ error: 'not your character' });
                    return;
                }
                if (!catalog_1.PLAYER_ALLOWED_ACTIONS.has(action)) {
                    res.status(403).json({ error: 'action not allowed for players' });
                    return;
                }
            }
            const paramStr = typeof params === 'string' ? params : JSON.stringify(params || {});
            await pool.execute('INSERT INTO dashboard_queue (charid, action, params, requested_by) VALUES (?, ?, ?, ?)', [charid, action, paramStr, req.user.login]);
            (0, audit_1.audit)(req.user.login, 'queue.action', `char:${charid}`, { action, params: paramStr });
            res.json({ queued: true });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/queue/recent/:charid', auth_1.requireAuth, (0, rbac_1.requirePermission)('view:queue'), async (req, res) => {
        try {
            const charid = parseInt(req.params.charid);
            if (req.user.tier !== 'admin' && !(await (0, auth_2.userOwnsChar)(pool, req.user.accid, charid))) {
                res.status(403).json({ error: 'not your character' });
                return;
            }
            const [rows] = await pool.execute('SELECT id, action, params, status, result, created_at, processed_at FROM dashboard_queue WHERE charid = ? ORDER BY id DESC LIMIT 10', [charid]);
            res.json(rows);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/queue/:id', auth_1.requireAuth, (0, rbac_1.requirePermission)('view:queue'), async (req, res) => {
        try {
            const [[row]] = await pool.execute('SELECT id, action, status, result, created_at, processed_at FROM dashboard_queue WHERE id = ?', [parseInt(req.params.id)]);
            if (!row) {
                res.status(404).json({ error: 'not found' });
                return;
            }
            res.json(row);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.post('/api/console', auth_1.requireAuth, (0, rbac_1.requirePermission)('run:console'), async (req, res) => {
        try {
            const { cmd } = req.body || {};
            if (!cmd || typeof cmd !== 'string') {
                res.status(400).json({ error: 'cmd required' });
                return;
            }
            const [result] = await pool.execute('INSERT INTO dashboard_queue (charid, action, params, requested_by) VALUES (0, "luaexec", ?, ?)', [cmd, req.user.login]);
            (0, audit_1.audit)(req.user.login, 'console.exec', undefined, { cmd, queueId: result.insertId });
            res.json({ id: result.insertId });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    return router;
}
