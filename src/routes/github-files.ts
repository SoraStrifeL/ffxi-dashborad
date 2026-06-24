import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';
import { DATA_DIR } from '../catalog';

const GH_CONFIG_FILE = path.join(DATA_DIR, 'github-config.json');

export interface GithubFilesConfig {
  repo:   string;   // e.g. "YourName/server"
  branch: string;   // e.g. "base" or "main"
  token:  string;   // optional GitHub PAT
  paths:  Record<string, string>; // dir key → repo-relative path
}

const GH_DEFAULTS: GithubFilesConfig = {
  repo:   '',
  branch: 'base',
  token:  '',
  paths:  {
    LSB_SCRIPTS_DIR:  'scripts',
    LSB_SETTINGS_DIR: 'scripts',
  },
};

export function loadGithubFilesConfig(): GithubFilesConfig {
  try {
    const saved = JSON.parse(fs.readFileSync(GH_CONFIG_FILE, 'utf8'));
    return { ...GH_DEFAULTS, ...saved, paths: { ...GH_DEFAULTS.paths, ...(saved.paths ?? {}) } };
  } catch (_) {
    return { ...GH_DEFAULTS, paths: { ...GH_DEFAULTS.paths } };
  }
}

function saveGithubFilesConfig(patch: Partial<GithubFilesConfig>): void {
  let cur: Partial<GithubFilesConfig> = {};
  try { cur = JSON.parse(fs.readFileSync(GH_CONFIG_FILE, 'utf8')); } catch (_) {}
  const merged: GithubFilesConfig = {
    ...GH_DEFAULTS,
    ...cur,
    ...patch,
    paths: { ...GH_DEFAULTS.paths, ...(cur.paths ?? {}), ...(patch.paths ?? {}) },
  };
  fs.mkdirSync(path.dirname(GH_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(GH_CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
}

async function ghApiGet(url: string, token?: string): Promise<any> {
  const headers: Record<string, string> = {
    'User-Agent': 'FFXI-Dashboard/1.0',
    'Accept':     'application/vnd.github.v3+json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => resp.statusText);
    throw new Error(`GitHub ${resp.status}: ${msg.slice(0, 200)}`);
  }
  return resp.json();
}

export function createGithubFilesRouter(): Router {
  const router = Router();

  router.get('/api/github/config', requireAuth, requirePermission('manage:settings'), (_req, res) => {
    const cfg = loadGithubFilesConfig();
    res.json({ ...cfg, token: cfg.token ? '••••••••' : '' });
  });

  router.post('/api/github/config', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const body = (req.body as Partial<GithubFilesConfig & { token_clear?: string }>) || {};
    const patch: Partial<GithubFilesConfig> = {};
    if (typeof body.repo   === 'string') patch.repo   = body.repo.trim();
    if (typeof body.branch === 'string') patch.branch = body.branch.trim();
    if (typeof body.token  === 'string' && !body.token.includes('•')) patch.token = body.token.trim();
    if (body.paths && typeof body.paths === 'object') {
      patch.paths = {};
      for (const [k, v] of Object.entries(body.paths)) {
        if (typeof v === 'string') patch.paths[k] = v.trim();
      }
    }
    saveGithubFilesConfig(patch);
    audit(req.user!.login, 'github.config', undefined, { ...patch, token: patch.token ? '[set]' : undefined });
    res.json({ ok: true });
  });

  // List a directory or return file metadata
  router.get('/api/github/browse', requireAuth, requirePermission('manage:settings'), async (req, res) => {
    const cfg = loadGithubFilesConfig();
    if (!cfg.repo) return void res.status(400).json({ error: 'GitHub repo not configured' });
    const dirPath = ((req.query.path as string) || '').replace(/^\/+/, '');
    const branch  = (req.query.branch as string) || cfg.branch || 'base';
    const token   = cfg.token || undefined;
    try {
      const url  = `https://api.github.com/repos/${cfg.repo}/contents/${dirPath}?ref=${encodeURIComponent(branch)}`;
      const data = await ghApiGet(url, token);
      if (Array.isArray(data)) {
        const items = data.map((item: any) => ({
          name:        item.name  as string,
          path:        item.path  as string,
          type:        item.type  as string,
          size:        item.size  as number,
          sha:         item.sha   as string,
          htmlUrl:     item.html_url     as string,
          downloadUrl: item.download_url as string | null,
        })).sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        const parent = dirPath.includes('/') ? dirPath.slice(0, dirPath.lastIndexOf('/')) : null;
        res.json({ path: dirPath, branch, repo: cfg.repo, parent, items });
      } else {
        // Single file metadata
        res.json({ path: dirPath, branch, repo: cfg.repo, file: data });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Return decoded text content of a single file
  router.get('/api/github/content', requireAuth, requirePermission('manage:settings'), async (req, res) => {
    const cfg = loadGithubFilesConfig();
    if (!cfg.repo) return void res.status(400).json({ error: 'GitHub repo not configured' });
    const filePath = (req.query.path as string) || '';
    const branch   = (req.query.branch as string) || cfg.branch || 'base';
    const token    = cfg.token || undefined;
    try {
      const url  = `https://api.github.com/repos/${cfg.repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
      const data: any = await ghApiGet(url, token);
      if (data.encoding === 'base64') {
        const content = Buffer.from((data.content as string).replace(/\n/g, ''), 'base64').toString('utf8');
        res.json({ content, name: data.name, path: data.path, size: data.size, htmlUrl: data.html_url });
      } else {
        res.status(400).json({ error: `Unexpected encoding: ${data.encoding}` });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
