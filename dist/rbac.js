"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLE_PERMISSIONS = void 0;
exports.hasPermission = hasPermission;
exports.requirePermission = requirePermission;
exports.ROLE_PERMISSIONS = {
    admin: [
        'view:characters', 'edit:characters',
        'view:accounts', 'manage:accounts',
        'run:console', 'manage:settings', 'manage:scripts',
        'view:db', 'manage:timers', 'upload:images',
        'submit:queue', 'view:queue',
    ],
    player: [
        'view:characters',
        'view:db',
    ],
};
function hasPermission(tier, perm) {
    return (exports.ROLE_PERMISSIONS[tier] ?? []).includes(perm);
}
function requirePermission(perm) {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ error: 'unauthorized' });
            return;
        }
        if (!hasPermission(req.user.tier, perm)) {
            res.status(403).json({ error: `permission denied: ${perm}` });
            return;
        }
        next();
    };
}
