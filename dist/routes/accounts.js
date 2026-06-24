"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAccountsRouter = createAccountsRouter;
const express_1 = require("express");
const auth_1 = require("../auth");
const rbac_1 = require("../rbac");
const audit_1 = require("../audit");
function createAccountsRouter(pool) {
    const router = (0, express_1.Router)();
    router.get('/api/accounts', auth_1.requireAuth, (0, rbac_1.requirePermission)('view:accounts'), async (_req, res) => {
        try {
            const [rows] = await pool.execute(`
        SELECT a.id, a.login, a.status, a.priv, a.timecreate, a.timelastmodify
        FROM accounts a
        ORDER BY a.timelastmodify DESC
      `);
            res.json(rows);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.post('/api/accounts/:id/status', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:accounts'), async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const { status } = req.body || {};
            if (status !== 0 && status !== 1) {
                res.status(400).json({ error: 'status must be 0 or 1' });
                return;
            }
            await pool.execute('UPDATE accounts SET status = ? WHERE id = ?', [status, id]);
            (0, audit_1.audit)(req.user.login, 'account.status', `account:${id}`, { status });
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.post('/api/accounts/:id/priv', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:accounts'), async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            const { priv } = req.body || {};
            const privNum = parseInt(String(priv));
            if (isNaN(privNum) || privNum < 0 || privNum > 5) {
                res.status(400).json({ error: 'priv must be 0–5' });
                return;
            }
            await pool.execute('UPDATE accounts SET priv = ? WHERE id = ?', [privNum, id]);
            (0, audit_1.audit)(req.user.login, 'account.priv', `account:${id}`, { priv: privNum });
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    return router;
}
