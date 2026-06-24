import fs from 'fs';
import http from 'http';
import { Router } from 'express';
import { requireAuth } from '../auth';
import { requirePermission } from '../rbac';
import { audit } from '../audit';

const DOCKER_SOCKET = '/var/run/docker.sock';

export function isDockerAvailable(): boolean {
  try { fs.accessSync(DOCKER_SOCKET); return true; } catch (_) { return false; }
}

function dockerReq(method: string, apiPath: string, body?: object): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      socketPath: DOCKER_SOCKET,
      method,
      path: apiPath,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(opts, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed: any;
        try { parsed = JSON.parse(raw.toString()); } catch (_) { parsed = raw.toString(); }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Docker multiplexed log frames: each frame has an 8-byte header [type(1), 0,0,0, size(4 BE)]
function parseDockerLogs(buf: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (size === 0) continue;
    if (offset + size > buf.length) break;
    const chunk = buf.slice(offset, offset + size).toString('utf8');
    offset += size;
    for (const line of chunk.split('\n')) {
      const t = line.trimEnd();
      if (t) lines.push(t);
    }
  }
  // Fallback: if no frames were parsed (plain text response), split raw
  if (!lines.length) {
    return buf.toString('utf8').split('\n').map(l => l.trimEnd()).filter(Boolean);
  }
  return lines;
}

export function createDockerRouter(): Router {
  const router = Router();

  router.get('/api/docker/status', requireAuth, requirePermission('manage:settings'), async (_req, res) => {
    if (!isDockerAvailable()) {
      return void res.json({
        available: false,
        hint: 'Add "- /var/run/docker.sock:/var/run/docker.sock" to the dashboard volumes in docker-compose.yml, then recreate the container.',
      });
    }
    try {
      const [infoR, containersR] = await Promise.all([
        dockerReq('GET', '/info'),
        dockerReq('GET', '/containers/json?all=1'),
      ]);
      const containers = (Array.isArray(containersR.body) ? containersR.body : []).map((c: any) => ({
        id:      (c.Id as string).slice(0, 12),
        names:   (c.Names as string[]).map(n => n.replace(/^\//, '')),
        image:   c.Image as string,
        status:  c.Status as string,
        state:   c.State as string,
        created: c.Created as number,
        ports:   (c.Ports as any[]).map(p => p.PublicPort ? `${p.PublicPort}→${p.PrivatePort}` : null).filter(Boolean),
      }));
      res.json({ available: true, serverVersion: infoR.body?.ServerVersion, containers });
    } catch (e: any) {
      res.status(500).json({ available: false, error: e.message });
    }
  });

  router.post('/api/docker/containers/:id/restart', requireAuth, requirePermission('manage:settings'), async (req, res) => {
    if (!isDockerAvailable()) return void res.status(503).json({ error: 'Docker not available' });
    try {
      const r = await dockerReq('POST', `/containers/${req.params.id}/restart?t=10`);
      if (r.status === 204 || r.status === 200) {
        audit(req.user!.login, 'docker.restart', String(req.params.id));
        res.json({ ok: true });
      } else {
        res.status(r.status || 500).json({ error: (r.body as any)?.message || 'Docker API error' });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/docker/containers/:id/logs', requireAuth, requirePermission('manage:settings'), async (req, res) => {
    if (!isDockerAvailable()) return void res.status(503).json({ error: 'Docker not available' });
    const tail = Math.min(200, Math.max(10, parseInt(req.query.tail as string) || 50));
    return new Promise<void>(resolve => {
      const opts: http.RequestOptions = {
        socketPath: DOCKER_SOCKET,
        method:     'GET',
        path:       `/containers/${req.params.id}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=0`,
      };
      const dreq = http.request(opts, dres => {
        const chunks: Buffer[] = [];
        dres.on('data', c => chunks.push(c));
        dres.on('end', () => {
          res.json({ lines: parseDockerLogs(Buffer.concat(chunks)) });
          resolve();
        });
      });
      dreq.on('error', e => { res.status(500).json({ error: (e as Error).message }); resolve(); });
      dreq.end();
    });
  });

  // ── Browse filesystem inside a container via exec ──────────────────────────
  router.get('/api/docker/containers/:id/fs/browse', requireAuth, requirePermission('manage:settings'), async (req, res) => {
    if (!isDockerAvailable()) return void res.status(503).json({ error: 'Docker not available' });
    const dirPath = (req.query.path as string) || '/';
    const id = req.params.id as string;
    try {
      // Create exec instance
      const execR = await dockerReq('POST', `/containers/${id}/exec`, {
        AttachStdout: true,
        AttachStderr: false,
        Cmd: ['sh', '-c', `ls -1ap "${dirPath}" 2>&1`],
      });
      if (execR.status !== 201) return void res.status(400).json({ error: execR.body?.message || 'Exec create failed' });
      const execId = execR.body.Id as string;

      // Start exec and collect output
      const output = await new Promise<string>((resolve, reject) => {
        const opts: http.RequestOptions = {
          socketPath: DOCKER_SOCKET,
          method:     'POST',
          path:       `/exec/${execId}/start`,
          headers:    { 'Content-Type': 'application/json' },
        };
        const req2 = http.request(opts, dres => {
          const chunks: Buffer[] = [];
          dres.on('data', c => chunks.push(c));
          dres.on('end', () => resolve(parseDockerLogs(Buffer.concat(chunks)).join('\n')));
        });
        req2.on('error', reject);
        req2.write(JSON.stringify({ Detach: false, Tty: false }));
        req2.end();
      });

      const lines = output.split('\n').map(l => l.trim()).filter(l => l && l !== '.' && l !== '..');
      const items = lines.map(name => {
        const isDir = name.endsWith('/');
        const clean = isDir ? name.slice(0, -1) : name;
        const joined = dirPath.replace(/\/$/, '') + '/' + clean;
        return { name: clean, path: joined, type: isDir ? 'dir' : 'file' };
      }).sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const parent = dirPath === '/' ? null : dirPath.replace(/\/$/, '').replace(/\/[^/]+$/, '') || '/';
      res.json({ path: dirPath, parent, items, containerId: id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
