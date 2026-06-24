"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSettingsRouter = createSettingsRouter;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const express_1 = require("express");
const auth_1 = require("../auth");
const rbac_1 = require("../rbac");
const audit_1 = require("../audit");
const settings_1 = require("../settings");
function createSettingsRouter(pool) {
    const router = (0, express_1.Router)();
    router.get('/api/settings/rates', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:settings'), async (_req, res) => {
        try {
            const cache = {};
            const result = settings_1.RATE_CATALOG.map(entry => {
                if (!cache[entry.file]) {
                    try {
                        cache[entry.file] = fs_1.default.readFileSync(path_1.default.join(settings_1.SETTINGS_DIR, entry.file), 'utf8');
                    }
                    catch (_) {
                        cache[entry.file] = '';
                    }
                }
                return { ...entry, value: (0, settings_1.readRate)(cache[entry.file], entry.key, entry.type) };
            });
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.post('/api/settings/rates', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:settings'), async (req, res) => {
        try {
            const { key, value } = req.body || {};
            const entry = settings_1.RATE_CATALOG.find(e => e.key === key);
            if (!entry)
                return void res.status(400).json({ error: 'unknown key' });
            const filePath = path_1.default.join(settings_1.SETTINGS_DIR, entry.file);
            const content = fs_1.default.readFileSync(filePath, 'utf8');
            const writeVal = entry.type === 'bool'
                ? (value === true || value === 'true' ? 'true' : 'false')
                : parseFloat(String(value));
            const updated = (0, settings_1.writeRate)(content, key, writeVal, entry.type);
            if (updated === content)
                return void res.status(400).json({ error: 'key not found in file' });
            fs_1.default.writeFileSync(filePath, updated, 'utf8');
            (0, audit_1.audit)(req.user.login, 'settings.rate', key, { value: writeVal, file: entry.file });
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.get('/api/settings/scan', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:settings'), (_req, res) => {
        try {
            const result = {};
            for (const file of settings_1.SCAN_FILES)
                result[file] = (0, settings_1.scanSettingsFile)(file);
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.post('/api/settings/scan', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:settings'), (req, res) => {
        try {
            const { file, key, value } = req.body || {};
            if (!settings_1.SCAN_FILES.includes(file))
                return void res.status(400).json({ error: 'invalid file' });
            if (!/^[A-Z][A-Z0-9_]+$/.test(key))
                return void res.status(400).json({ error: 'invalid key' });
            const filePath = path_1.default.join(settings_1.SETTINGS_DIR, file);
            const content = fs_1.default.readFileSync(filePath, 'utf8');
            const isBool = value === 'true' || value === 'false' || value === true || value === false;
            const writeVal = isBool ? (value === true || value === 'true' ? 'true' : 'false') : parseFloat(String(value));
            const updated = (0, settings_1.writeRate)(content, key, writeVal, isBool ? 'bool' : undefined);
            if (updated === content)
                return void res.status(400).json({ error: 'key not found in file' });
            fs_1.default.writeFileSync(filePath, updated, 'utf8');
            (0, audit_1.audit)(req.user.login, 'settings.scan', `${file}:${key}`, { value: writeVal });
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.get('/api/settings/variables', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:settings'), async (_req, res) => {
        try {
            const [rows] = await pool.execute('SELECT name AS varname, value FROM server_variables ORDER BY name');
            res.json(rows);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.post('/api/settings/variables', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:settings'), async (req, res) => {
        try {
            const { varname, value } = req.body || {};
            if (!varname)
                return void res.status(400).json({ error: 'varname required' });
            const numVal = parseInt(String(value)) || 0;
            await pool.execute('INSERT INTO server_variables (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [varname, numVal]);
            (0, audit_1.audit)(req.user.login, 'settings.variable', varname, { value: numVal });
            res.json({ ok: true });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    return router;
}
