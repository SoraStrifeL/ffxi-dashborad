import { Router } from 'express';
import { Pool } from 'mysql2/promise';
import { requireAuth } from '../auth';
import { ZONE_CACHE, loadZoneCache } from '../catalog';
import { cacheGetJSON, cacheSetJSON, WIKI_TTL } from '../cache';

export function createZonesRouter(pool: Pool): Router {
  const router = Router();

  router.get('/api/zones', requireAuth, async (_req, res) => {
    if (ZONE_CACHE) { res.json(ZONE_CACHE); loadZoneCache(pool); return; }
    await loadZoneCache(pool);
    res.json(ZONE_CACHE || []);
  });

  router.get('/api/db/zones/wiki', requireAuth, async (req, res) => {
    try {
      const rawName = ((req.query.name as string) || '').trim();
      if (!rawName) { res.json({}); return; }
      const cacheKey = 'wiki:zone:' + rawName.toLowerCase();
      const cached = await cacheGetJSON(cacheKey);
      if (cached) { res.json(cached); return; }
      const wikiName = rawName.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join('_');
      const wikiUrl = `https://www.bg-wiki.com/ffxi/${encodeURIComponent(wikiName)}`;
      const resp = await fetch(wikiUrl, { headers: { 'User-Agent': 'FFXIDashboard/1.0' }, signal: AbortSignal.timeout(8000) });
      if (!resp.ok) { res.json({ wikiUrl, notFound: true }); return; }
      const html = await resp.text();
      const stripTags = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
      let description: string | null = null;
      const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)];
      for (const [, p] of paras) {
        const t = stripTags(p);
        if (t.length > 40 && !/^\s*$/.test(t)) { description = t; break; }
      }
      const infoRows: Record<string, string> = {};
      const rowRe = /<tr[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/g;
      let m: RegExpExecArray | null;
      while ((m = rowRe.exec(html)) !== null) {
        const k = stripTags(m[1]).replace(/:$/, '').trim();
        const v = stripTags(m[2]).trim();
        if (k && v) infoRows[k] = v;
      }
      const connM = html.match(/(?:Connected\s*(?:Zones?)?|Connections?)[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
      const connected: string[] = [];
      if (connM) {
        const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
        while ((m = liRe.exec(connM[1])) !== null) {
          const t = stripTags(m[1]);
          if (t) connected.push(t);
        }
      }
      const out = {
        description,
        region:     infoRows['Region'] || infoRows['Conquest Region'] || null,
        levelRange: infoRows['Level Range'] || infoRows['Recommended Level'] || infoRows['Level'] || null,
        weather:    infoRows['Weather'] || null,
        connected:  connected.slice(0, 12),
        wikiUrl,
        cachedAt:   Date.now(),
      };
      await cacheSetJSON(cacheKey, out, WIKI_TTL);
      res.json(out);
    } catch (e) { res.json({ error: (e as Error).message }); }
  });

  return router;
}
