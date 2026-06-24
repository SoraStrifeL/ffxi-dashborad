"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createZonesRouter = createZonesRouter;
const express_1 = require("express");
const auth_1 = require("../auth");
const catalog_1 = require("../catalog");
const cache_1 = require("../cache");
function createZonesRouter(pool) {
    const router = (0, express_1.Router)();
    router.get('/api/zones', auth_1.requireAuth, async (_req, res) => {
        if (catalog_1.ZONE_CACHE) {
            res.json(catalog_1.ZONE_CACHE);
            (0, catalog_1.loadZoneCache)(pool);
            return;
        }
        await (0, catalog_1.loadZoneCache)(pool);
        res.json(catalog_1.ZONE_CACHE || []);
    });
    router.get('/api/db/zones/wiki', auth_1.requireAuth, async (req, res) => {
        try {
            const rawName = (req.query.name || '').trim();
            if (!rawName) {
                res.json({});
                return;
            }
            const cacheKey = 'wiki:zone:' + rawName.toLowerCase();
            const cached = await (0, cache_1.cacheGetJSON)(cacheKey);
            if (cached) {
                res.json(cached);
                return;
            }
            const wikiName = rawName.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('_');
            const wikiUrl = `https://www.bg-wiki.com/ffxi/${encodeURIComponent(wikiName)}`;
            const resp = await fetch(wikiUrl, { headers: { 'User-Agent': 'FFXIDashboard/1.0' }, signal: AbortSignal.timeout(8000) });
            if (!resp.ok) {
                res.json({ wikiUrl, notFound: true });
                return;
            }
            const html = await resp.text();
            const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
            let description = null;
            const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)];
            for (const [, p] of paras) {
                const t = stripTags(p);
                if (t.length > 40 && !/^\s*$/.test(t)) {
                    description = t;
                    break;
                }
            }
            const infoRows = {};
            const rowRe = /<tr[^>]*>[\s\S]*?<th[^>]*>([\s\S]*?)<\/th>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/g;
            let m;
            while ((m = rowRe.exec(html)) !== null) {
                const k = stripTags(m[1]).replace(/:$/, '').trim();
                const v = stripTags(m[2]).trim();
                if (k && v)
                    infoRows[k] = v;
            }
            const connM = html.match(/(?:Connected\s*(?:Zones?)?|Connections?)[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
            const connected = [];
            if (connM) {
                const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
                while ((m = liRe.exec(connM[1])) !== null) {
                    const t = stripTags(m[1]);
                    if (t)
                        connected.push(t);
                }
            }
            const out = {
                description,
                region: infoRows['Region'] || infoRows['Conquest Region'] || null,
                levelRange: infoRows['Level Range'] || infoRows['Recommended Level'] || infoRows['Level'] || null,
                weather: infoRows['Weather'] || null,
                connected: connected.slice(0, 12),
                wikiUrl,
                cachedAt: Date.now(),
            };
            await (0, cache_1.cacheSetJSON)(cacheKey, out, cache_1.WIKI_TTL);
            res.json(out);
        }
        catch (e) {
            res.json({ error: e.message });
        }
    });
    return router;
}
