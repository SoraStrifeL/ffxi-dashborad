"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAdminRouter = createAdminRouter;
const express_1 = require("express");
const auth_1 = require("../auth");
const rbac_1 = require("../rbac");
const audit_1 = require("../audit");
function createAdminRouter() {
    const router = (0, express_1.Router)();
    router.get('/api/roles', auth_1.requireAuth, (0, rbac_1.requirePermission)('view:accounts'), (_req, res) => {
        res.json(rbac_1.ROLE_PERMISSIONS);
    });
    router.get('/api/audit', auth_1.requireAuth, (0, rbac_1.requirePermission)('view:accounts'), (req, res) => {
        const limit = Math.min(500, parseInt(req.query.limit || '200'));
        res.json((0, audit_1.readAuditLog)(limit));
    });
    return router;
}
