"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createScriptsRouter = createScriptsRouter;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const express_1 = require("express");
const auth_1 = require("../auth");
const rbac_1 = require("../rbac");
const audit_1 = require("../audit");
const catalog_1 = require("../catalog");
const SCRIPTS_FILE = path_1.default.join(__dirname, '..', '..', 'data', 'scripts.json');
function readScripts() { try {
    return JSON.parse(fs_1.default.readFileSync(SCRIPTS_FILE, 'utf8'));
}
catch {
    return [];
} }
function writeScripts(scripts) {
    fs_1.default.mkdirSync(path_1.default.dirname(SCRIPTS_FILE), { recursive: true });
    fs_1.default.writeFileSync(SCRIPTS_FILE, JSON.stringify(scripts, null, 2));
}
function safeBrowserPath(rel) {
    const full = path_1.default.resolve(catalog_1.SERVER_SCRIPTS_ROOT, rel || '');
    if (!full.startsWith(catalog_1.SERVER_SCRIPTS_ROOT))
        throw new Error('Invalid path');
    return full;
}
function createScriptsRouter() {
    const router = (0, express_1.Router)();
    router.get('/api/scriptbrowser', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:scripts'), (req, res) => {
        try {
            const full = safeBrowserPath(req.query.path || '');
            const stat = fs_1.default.statSync(full);
            if (!stat.isDirectory())
                return void res.status(400).json({ error: 'Not a directory' });
            const entries = fs_1.default.readdirSync(full, { withFileTypes: true })
                .filter(e => e.isDirectory() || e.name.endsWith('.lua'))
                .sort((a, b) => {
                if (a.isDirectory() !== b.isDirectory())
                    return a.isDirectory() ? -1 : 1;
                return a.name.localeCompare(b.name);
            })
                .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
            res.json(entries);
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return void res.status(404).json({ error: 'Path not found' });
            res.status(400).json({ error: e.message });
        }
    });
    router.get('/api/scriptbrowser/file', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:scripts'), (req, res) => {
        try {
            const full = safeBrowserPath(req.query.path || '');
            if (!full.endsWith('.lua'))
                return void res.status(400).json({ error: 'Only .lua files allowed' });
            const stat = fs_1.default.statSync(full);
            if (stat.size > 512 * 1024)
                return void res.status(400).json({ error: 'File too large (>512 KB)' });
            res.type('text/plain').send(fs_1.default.readFileSync(full, 'utf8'));
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return void res.status(404).json({ error: 'File not found' });
            res.status(400).json({ error: e.message });
        }
    });
    router.post('/api/scriptbrowser/file', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:scripts'), (req, res) => {
        try {
            const relPath = req.query.path || '';
            const full = safeBrowserPath(relPath);
            if (!full.endsWith('.lua'))
                return void res.status(400).json({ error: 'Only .lua files allowed' });
            if (!fs_1.default.existsSync(path_1.default.dirname(full)))
                return void res.status(400).json({ error: 'Directory does not exist' });
            const { content } = req.body || {};
            if (typeof content !== 'string')
                return void res.status(400).json({ error: 'content required' });
            fs_1.default.writeFileSync(full, content, 'utf8');
            (0, audit_1.audit)(req.user.login, 'script.file.write', relPath);
            res.json({ ok: true });
        }
        catch (e) {
            res.status(400).json({ error: e.message });
        }
    });
    router.get('/api/scripts', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:scripts'), (_req, res) => {
        res.json(readScripts());
    });
    router.post('/api/scripts', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:scripts'), (req, res) => {
        const { id, name, code, description } = req.body || {};
        if (!name || !code)
            return void res.status(400).json({ error: 'name and code required' });
        const scripts = readScripts();
        const now = Date.now();
        if (id) {
            const idx = scripts.findIndex(s => s.id === id);
            if (idx >= 0)
                scripts[idx] = { ...scripts[idx], name, description, code, updated: now };
            else
                scripts.push({ id, name, description, code, created: now, updated: now });
        }
        else {
            scripts.push({ id: crypto_1.default.randomUUID(), name, description, code, created: now, updated: now });
        }
        writeScripts(scripts);
        (0, audit_1.audit)(req.user.login, 'script.save', name);
        res.json({ ok: true, scripts });
    });
    router.delete('/api/scripts/:id', auth_1.requireAuth, (0, rbac_1.requirePermission)('manage:scripts'), (req, res) => {
        const scriptId = req.params.id;
        const before = readScripts();
        const scripts = before.filter(s => s.id !== scriptId);
        writeScripts(scripts);
        const deleted = before.find(s => s.id === scriptId);
        (0, audit_1.audit)(req.user.login, 'script.delete', deleted?.name ?? scriptId);
        res.json({ ok: true });
    });
    return router;
}
