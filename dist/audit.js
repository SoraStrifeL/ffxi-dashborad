"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.broadcastAuditEvent = void 0;
exports.setBroadcastAuditEvent = setBroadcastAuditEvent;
exports.audit = audit;
exports.readAuditLog = readAuditLog;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const AUDIT_FILE = path_1.default.join(__dirname, '..', 'data', 'audit.log');
const MAX_TAIL = 10000;
// Set by ws.ts after WebSocket init to push audit events to admin clients in real time
exports.broadcastAuditEvent = null;
function setBroadcastAuditEvent(fn) {
    exports.broadcastAuditEvent = fn;
}
function audit(user, action, target, meta) {
    const entry = {
        ts: new Date().toISOString(),
        user,
        action,
        ...(target !== undefined ? { target } : {}),
        ...(meta !== undefined ? { meta } : {}),
    };
    try {
        fs_1.default.mkdirSync(path_1.default.dirname(AUDIT_FILE), { recursive: true });
        fs_1.default.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
    }
    catch { /* non-fatal */ }
    (0, exports.broadcastAuditEvent)?.(entry);
}
function readAuditLog(limit = 200) {
    try {
        const content = fs_1.default.readFileSync(AUDIT_FILE, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        const tail = lines.slice(-Math.min(limit, MAX_TAIL));
        return tail.map(l => JSON.parse(l)).reverse();
    }
    catch {
        return [];
    }
}
