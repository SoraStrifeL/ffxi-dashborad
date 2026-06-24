import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';
import { DATA_DIR } from '../catalog';

const LSB_CONFIG_FILE = path.join(DATA_DIR, 'lsb-config.json');

export interface LsbConfig {
  serverPath:     string;  // local git repo path inside container (optional)
  forkRepo:       string;  // your personal GitHub fork, e.g. "YourName/server"
  upstreamRepo:   string;  // original upstream repo, default "LandSandBoat/server"
  upstreamBranch: string;  // branch to track, default "base"
  githubToken:    string;  // optional PAT for higher rate limits
}

const LSB_DEFAULTS: LsbConfig = {
  serverPath:     '',
  forkRepo:       '',
  upstreamRepo:   'LandSandBoat/server',
  upstreamBranch: 'base',
  githubToken:    '',
};

export function loadLsbConfig(): LsbConfig {
  try {
    const saved = JSON.parse(fs.readFileSync(LSB_CONFIG_FILE, 'utf8'));
    return { ...LSB_DEFAULTS, ...saved };
  } catch (_) {
    return { ...LSB_DEFAULTS };
  }
}

function saveLsbConfig(patch: Partial<LsbConfig>): void {
  let current: Partial<LsbConfig> = {};
  try { current = JSON.parse(fs.readFileSync(LSB_CONFIG_FILE, 'utf8')); } catch (_) {}
  fs.mkdirSync(path.dirname(LSB_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(LSB_CONFIG_FILE, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8');
}

function readLocalGitInfo(repoPath: string): { sha: string; shortSha: string; branch: string } | null {
  try {
    const head = fs.readFileSync(path.join(repoPath, '.git', 'HEAD'), 'utf8').trim();
    let sha: string, branch: string;
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      branch = ref.replace(/^refs\/heads\//, '');
      const refFile = path.join(repoPath, '.git', ref);
      if (fs.existsSync(refFile)) {
        sha = fs.readFileSync(refFile, 'utf8').trim();
      } else {
        const packedPath = path.join(repoPath, '.git', 'packed-refs');
        const packed = fs.existsSync(packedPath) ? fs.readFileSync(packedPath, 'utf8') : '';
        const m = packed.match(new RegExp(`^([a-f0-9]{40})\\s+${ref.replace(/\//g, '\\/')}$`, 'm'));
        sha = m ? m[1] : '';
      }
    } else {
      sha = head;
      branch = '(detached HEAD)';
    }
    return { sha, shortSha: sha.slice(0, 7), branch };
  } catch (_) {
    return null;
  }
}

interface StatusCache { ts: number; data: object; }
const _cache = new Map<string, StatusCache>();
const CACHE_TTL = 5 * 60 * 1000;

async function ghFetch(url: string, token?: string): Promise<any> {
  const headers: Record<string, string> = {
    'User-Agent': 'FFXI-Dashboard/1.0',
    'Accept':     'application/vnd.github.v3+json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => resp.statusText);
    throw new Error(`GitHub ${resp.status}: ${msg.slice(0, 200)}`);
  }
  return resp.json();
}

async function ghBranchHead(repo: string, branch: string, token?: string) {
  const d = await ghFetch(`https://api.github.com/repos/${repo}/branches/${branch}`, token);
  return {
    sha:     d.commit.sha as string,
    shortSha: (d.commit.sha as string).slice(0, 7),
    date:    d.commit.commit.committer.date as string,
    message: (d.commit.commit.message as string).split('\n')[0],
    author:  d.commit.commit.author.name as string,
  };
}

async function ghCompare(repo: string, base: string, head: string, token?: string) {
  try {
    const cmp: any = await ghFetch(
      `https://api.github.com/repos/${repo}/compare/${base}...${head}`, token);
    return {
      status:   cmp.status   ?? 'unknown',
      behindBy: cmp.behind_by ?? 0,
      aheadBy:  cmp.ahead_by  ?? 0,
      commits:  ((cmp.commits as any[]) ?? []).slice(-20).reverse().map((c: any) => ({
        sha:     c.sha.slice(0, 7),
        message: c.commit.message.split('\n')[0],
        author:  c.commit.author.name,
        date:    c.commit.committer.date,
        url:     c.html_url,
      })),
    };
  } catch (_) {
    return null;
  }
}

export function createLsbUpdateRouter(): Router {
  const router = Router();

  router.get('/api/lsb/config', requireAuth, requirePermission('manage:settings'), (_req, res) => {
    const cfg = loadLsbConfig();
    res.json({ ...cfg, githubToken: cfg.githubToken ? '••••••••' : '' });
  });

  router.post('/api/lsb/config', requireAuth, requirePermission('manage:settings'), (req, res) => {
    const body = (req.body as Partial<LsbConfig>) || {};
    const patch: Partial<LsbConfig> = {};
    if (typeof body.serverPath     === 'string') patch.serverPath     = body.serverPath.trim();
    if (typeof body.forkRepo       === 'string') patch.forkRepo       = body.forkRepo.trim();
    if (typeof body.upstreamRepo   === 'string') patch.upstreamRepo   = body.upstreamRepo.trim();
    if (typeof body.upstreamBranch === 'string') patch.upstreamBranch = body.upstreamBranch.trim();
    if (typeof body.githubToken    === 'string' && !body.githubToken.includes('•'))
      patch.githubToken = body.githubToken.trim();
    saveLsbConfig(patch);
    _cache.clear();
    audit(req.user!.login, 'lsb.config', undefined, { ...patch, githubToken: patch.githubToken ? '[set]' : undefined });
    res.json({ ok: true });
  });

  router.get('/api/lsb/status', requireAuth, requirePermission('manage:settings'), async (req, res) => {
    const cfg = loadLsbConfig();
    const hasFork  = !!cfg.forkRepo;
    const hasLocal = !!cfg.serverPath;
    if (!hasFork && !hasLocal) return void res.json({ configured: false });

    const forceRefresh = req.query.refresh === '1';
    const cacheKey = `${cfg.serverPath}|${cfg.forkRepo}|${cfg.upstreamRepo}|${cfg.upstreamBranch}`;
    if (!forceRefresh) {
      const hit = _cache.get(cacheKey);
      if (hit && Date.now() - hit.ts < CACHE_TTL) return void res.json({ ...hit.data, cached: true });
    }

    const token = cfg.githubToken || undefined;

    // Always fetch upstream
    let upstream: any;
    try {
      upstream = await ghBranchHead(cfg.upstreamRepo, cfg.upstreamBranch, token);
      upstream.repo = cfg.upstreamRepo;
      upstream.branch = cfg.upstreamBranch;
    } catch (err: any) {
      return void res.json({ configured: true, error: err.message });
    }

    // Fetch fork info if configured
    let fork: any = null;
    let forkVsUpstream: any = null;
    let forkMissingCommits: object[] = [];
    if (hasFork) {
      try {
        fork = await ghBranchHead(cfg.forkRepo, cfg.upstreamBranch, token);
        fork.repo = cfg.forkRepo;
        fork.branch = cfg.upstreamBranch;
        // Compare upstream base vs fork — commits fork is missing
        const cmp = await ghCompare(cfg.upstreamRepo, fork.sha, upstream.sha, token);
        if (cmp) {
          forkVsUpstream = { status: cmp.status, behindBy: cmp.behindBy, aheadBy: cmp.aheadBy };
          forkMissingCommits = cmp.commits;
        }
      } catch (e: any) {
        fork = { error: e.message };
      }
    }

    // Read local git info if serverPath configured
    let local: any = null;
    let localVsRef: any = null;  // local vs fork (if fork set) or local vs upstream
    let localMissingCommits: object[] = [];
    if (hasLocal) {
      const gitInfo = readLocalGitInfo(cfg.serverPath);
      if (!gitInfo) {
        local = { error: `Cannot read .git/HEAD at: ${cfg.serverPath}` };
      } else {
        local = { ...gitInfo };
        // Try to get commit metadata from upstream repo (local commit likely exists there)
        const refRepo = cfg.forkRepo || cfg.upstreamRepo;
        const refHead = fork?.sha || upstream.sha;
        if (local.sha && local.sha.length === 40) {
          try {
            const lc: any = await ghFetch(`https://api.github.com/repos/${refRepo}/commits/${local.sha}`, token);
            local.date    = lc.commit?.committer?.date ?? null;
            local.message = (lc.commit?.message ?? '').split('\n')[0] || null;
          } catch (_) {}
          const cmp = await ghCompare(refRepo, local.sha, refHead, token);
          if (cmp) {
            localVsRef = { status: cmp.status, behindBy: cmp.behindBy, aheadBy: cmp.aheadBy, comparedTo: cfg.forkRepo || cfg.upstreamRepo };
            localMissingCommits = cmp.commits;
          }
        }
      }
    }

    const data = {
      configured: true,
      upstream,
      fork,
      local,
      forkVsUpstream,
      forkMissingCommits,
      localVsRef,
      localMissingCommits,
      upstreamRepo:  cfg.upstreamRepo,
      forkRepo:      cfg.forkRepo,
      checkedAt:     new Date().toISOString(),
    };
    _cache.set(cacheKey, { ts: Date.now(), data });
    res.json(data);
  });

  return router;
}
