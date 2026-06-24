"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDbRouter = createDbRouter;
const express_1 = require("express");
const auth_1 = require("../auth");
const catalog_1 = require("../catalog");
const cache_1 = require("../cache");
function createDbRouter(pool) {
    const router = (0, express_1.Router)();
    router.get('/api/db/items', auth_1.requireAuth, async (req, res) => {
        try {
            const q = `%${(req.query.q || '').trim()}%`;
            const typeBit = req.query.type ? parseInt(req.query.type) : null;
            const rareOnly = req.query.rare === '1';
            const flagMask = req.query.flagmask ? parseInt(req.query.flagmask) : null;
            const flagVal = req.query.flagval !== undefined ? parseInt(req.query.flagval || '0') : null;
            const skill = req.query.skill !== undefined && req.query.skill !== '' ? parseInt(req.query.skill) : null;
            const slotBit = req.query.slot ? parseInt(req.query.slot) : null;
            const page = Math.max(0, parseInt(req.query.page || '0'));
            const sortMap = { level: 'ie.level DESC, ib.itemid', ilevel: 'ie.ilevel DESC, ib.itemid', sell: 'ib.BaseSell DESC, ib.itemid', dmg: 'iw.dmg DESC, ib.itemid', name: 'ib.name ASC' };
            const orderBy = sortMap[req.query.sort] || 'ib.itemid';
            const params = [q];
            const extra = [];
            if (typeBit !== null) {
                extra.push('AND ib.type=?');
                params.push(typeBit);
            }
            if (rareOnly)
                extra.push('AND (ib.flags & 0x8000) != 0');
            if (flagMask !== null && !isNaN(flagMask)) {
                extra.push(`AND (ib.flags & ?) = ?`);
                params.push(flagMask, isNaN(flagVal) ? flagMask : flagVal);
            }
            if (skill !== null && !isNaN(skill)) {
                extra.push('AND iw.skill=?');
                params.push(skill);
            }
            if (slotBit !== null) {
                extra.push('AND (ie.slot & ?) != 0');
                params.push(slotBit);
            }
            params.push(catalog_1.DB_PAGE, page * catalog_1.DB_PAGE);
            const [rows] = await pool.execute(`SELECT ib.itemid, CONVERT(ib.name USING utf8) AS name, ib.type, ib.flags, ib.stackSize, ib.BaseSell,
                ie.level, ie.ilevel, ie.slot, ie.jobs, iw.skill, iw.dmg, iw.dmgType, iw.delay
         FROM item_basic ib
         LEFT JOIN item_equipment ie ON ie.itemId=ib.itemid
         LEFT JOIN item_weapon iw ON iw.itemId=ib.itemid
         WHERE CONVERT(ib.name USING utf8) LIKE ? AND ib.name IS NOT NULL ${extra.join(' ')}
         ORDER BY ${orderBy} LIMIT ? OFFSET ?`, params);
            res.json(rows);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/db/items/wiki', auth_1.requireAuth, async (req, res) => {
        const rawName = (req.query.name || '').trim();
        if (!rawName) {
            res.json(null);
            return;
        }
        const cacheKey = 'wiki:item:' + rawName.toLowerCase();
        const cached = await (0, cache_1.cacheGetJSON)(cacheKey);
        if (cached) {
            res.json(cached);
            return;
        }
        try {
            const slug = rawName.split('_')
                .map((w) => w.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('-'))
                .join('_');
            const url = `https://www.bg-wiki.com/ffxi/${encodeURIComponent(slug)}`;
            const resp = await fetch(url, { headers: { 'User-Agent': 'FFXI-Dashboard/1.0' }, signal: AbortSignal.timeout(7000) });
            if (!resp.ok) {
                await (0, cache_1.cacheSetJSON)(cacheKey, null, cache_1.WIKI_TTL);
                res.json(null);
                return;
            }
            const html = await resp.text();
            const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#160;|&nbsp;/g, ' ').replace(/&apos;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
            const infoRows = {};
            const addRow = (rawKey, rawVal) => {
                const key = strip(rawKey).replace(/:$/, '').trim();
                const val = strip(rawVal).trim();
                if (key && val && !infoRows[key])
                    infoRows[key] = val;
            };
            const thRe = /<th[^>]*>([^<]*)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
            let m;
            while ((m = thRe.exec(html)) !== null)
                addRow(m[1], m[2]);
            const tdRe = /<td[^>]*item-info-header[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*item-info-body[^>]*>([\s\S]*?)<\/td>/g;
            while ((m = tdRe.exec(html)) !== null)
                addRow(m[1], m[2]);
            const ahRaw = infoRows['AH Listing'] || infoRows['AH  Listing'] || '';
            const ahM = ahRaw.match(/[➞→]\s*(.+)/);
            const cats = (html.match(/wgCategories.*?\[([^\]]+)\]/) || [])[1];
            const catList = cats ? (cats.match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, '')) : [];
            const result = {
                description: infoRows['Description'] || null,
                flags: infoRows['Flags'] || null,
                ahCategory: ahM ? ahM[1].trim() : (ahRaw || null),
                itemType: infoRows['Type'] || null,
                races: infoRows['Races'] || null,
                validTargets: infoRows['Valid Targets'] || null,
                categories: catList,
                wikiUrl: url,
                cachedAt: Date.now(),
            };
            await (0, cache_1.cacheSetJSON)(cacheKey, result, cache_1.WIKI_TTL);
            res.json(result);
        }
        catch (e) {
            void e;
            res.json(null);
        }
    });
    router.get('/api/db/item-types', auth_1.requireAuth, async (_req, res) => {
        try {
            const cached = await (0, cache_1.cacheGetJSON)('db:item-types');
            if (cached) {
                res.json(cached);
                return;
            }
            const [rows] = await pool.execute(`SELECT type, COUNT(*) AS cnt FROM item_basic WHERE name IS NOT NULL AND name != '' GROUP BY type ORDER BY type`);
            await (0, cache_1.cacheSetJSON)('db:item-types', rows, cache_1.ITEM_TYPES_TTL);
            res.json(rows);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/db/items/:itemid', auth_1.requireAuth, async (req, res) => {
        try {
            const id = parseInt(req.params.itemid);
            const [[basic]] = await pool.execute(`SELECT ib.itemid, CONVERT(ib.name USING utf8) AS name, ib.type, ib.stackSize, ib.BaseSell, ib.flags,
                ie.level, ie.ilevel, ie.slot, ie.rslot, ie.jobs, ie.shieldSize,
                iw.dmg, iw.delay, iw.skill, iw.dmgType,
                iu.maxCharges, iu.useDelay, iu.reuseDelay,
                iff.element AS furnElement, iff.storage AS furnStorage
         FROM item_basic ib
         LEFT JOIN item_equipment ie ON ie.itemId=ib.itemid
         LEFT JOIN item_weapon iw ON iw.itemId=ib.itemid
         LEFT JOIN item_usable iu ON iu.itemid=ib.itemid
         LEFT JOIN item_furnishing iff ON iff.itemid=ib.itemid
         WHERE ib.itemid=?`, [id]);
            if (!basic) {
                res.json(null);
                return;
            }
            const [mods] = await pool.execute(`SELECT modId, value FROM item_mods WHERE itemId=? ORDER BY modId`, [id]);
            const [drops] = await pool.execute(`SELECT m.mobname AS name, z.name AS zone, dl.itemRate, dl.groupRate
         FROM mob_droplist dl
         JOIN mob_groups mg ON mg.dropid = dl.dropId
         JOIN mob_spawn_points m ON m.groupid = mg.groupid
         JOIN zone_settings z ON ((m.mobid>>12)&0xFFF) = z.zoneid
         WHERE dl.itemId=?
         GROUP BY m.mobname, ((m.mobid>>12)&0xFFF)
         ORDER BY dl.itemRate DESC LIMIT 20`, [id]);
            const [recipes] = await pool.execute(`SELECT sr.ID, sr.Wood, sr.Smith, sr.Gold, sr.Cloth, sr.Leather, sr.Bone, sr.Alchemy, sr.Cook,
                CONVERT(cr.name USING utf8) AS crystalName, sr.ResultQty,
                sr.Ingredient1, sr.Ingredient2, sr.Ingredient3, sr.Ingredient4,
                sr.Ingredient5, sr.Ingredient6, sr.Ingredient7, sr.Ingredient8,
                CONVERT(i1.name USING utf8) AS ing1, CONVERT(i2.name USING utf8) AS ing2,
                CONVERT(i3.name USING utf8) AS ing3, CONVERT(i4.name USING utf8) AS ing4
         FROM synth_recipes sr
         LEFT JOIN item_basic cr ON cr.itemid=sr.Crystal
         LEFT JOIN item_basic i1 ON i1.itemid=sr.Ingredient1
         LEFT JOIN item_basic i2 ON i2.itemid=sr.Ingredient2
         LEFT JOIN item_basic i3 ON i3.itemid=sr.Ingredient3
         LEFT JOIN item_basic i4 ON i4.itemid=sr.Ingredient4
         WHERE sr.Result=? OR sr.ResultHQ1=? OR sr.ResultHQ2=? OR sr.ResultHQ3=?
         LIMIT 5`, [id, id, id, id]);
            const [shops] = await pool.execute(`SELECT gs.guildid, gs.min_price, gs.max_price, gs.max_quantity
         FROM guild_shops gs WHERE gs.itemid=? LIMIT 5`, [id]);
            res.json({ ...basic, mods, drops, recipes, shops });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/db/npcs', auth_1.requireAuth, (req, res) => {
        const q = (req.query.q || '').trim().toLowerCase();
        const zone = (req.query.zone || '').trim().toLowerCase();
        const region = req.query.region || null;
        const sort = req.query.sort || '';
        const page = Math.max(0, parseInt(req.query.page || '0'));
        let rows = catalog_1.NPC_CATALOG;
        if (q)
            rows = rows.filter(r => r.name.toLowerCase().includes(q));
        if (zone)
            rows = rows.filter(r => r.zone && r.zone.toLowerCase().includes(zone));
        if (region)
            rows = rows.filter(r => (0, catalog_1._mobRegionMatch)(r.zone || '', region));
        if (sort === 'zone')
            rows = [...rows].sort((a, b) => (a.zone || '').localeCompare(b.zone || '') || a.name.localeCompare(b.name));
        else if (sort === 'name')
            rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
        res.json(rows.slice(page * catalog_1.DB_PAGE, page * catalog_1.DB_PAGE + catalog_1.DB_PAGE).map(r => ({ ...r, _total: undefined })));
    });
    router.get('/api/db/mobs', auth_1.requireAuth, (req, res) => {
        const q = (req.query.q || '').trim().toLowerCase();
        const zone = (req.query.zone || '').trim().toLowerCase();
        const region = req.query.region || null;
        const ecosystem = req.query.ecosystem || null;
        const sort = req.query.sort || '';
        const page = Math.max(0, parseInt(req.query.page || '0'));
        let rows = catalog_1.MOB_CATALOG;
        if (q)
            rows = rows.filter(r => r.name.toLowerCase().includes(q));
        if (zone)
            rows = rows.filter(r => r.zone && r.zone.toLowerCase().includes(zone));
        if (region)
            rows = rows.filter(r => (0, catalog_1._mobRegionMatch)(r.zone || '', region));
        if (ecosystem)
            rows = rows.filter(r => r.ecosystem === ecosystem);
        if (sort === 'zone')
            rows = [...rows].sort((a, b) => (a.zone || '').localeCompare(b.zone || '') || a.name.localeCompare(b.name));
        else if (sort === 'level')
            rows = [...rows].sort((a, b) => (b.max_lvl || 0) - (a.max_lvl || 0) || a.name.localeCompare(b.name));
        else if (sort === 'spawns')
            rows = [...rows].sort((a, b) => (b.spawns || 0) - (a.spawns || 0) || a.name.localeCompare(b.name));
        else if (sort === 'family')
            rows = [...rows].sort((a, b) => (a.family || '').localeCompare(b.family || '') || a.name.localeCompare(b.name));
        res.json(rows.slice(page * catalog_1.DB_PAGE, page * catalog_1.DB_PAGE + catalog_1.DB_PAGE));
    });
    router.get('/api/db/mobs/detail', auth_1.requireAuth, async (req, res) => {
        try {
            const name = (req.query.name || '').trim();
            const zoneid = parseInt(req.query.zone) || 0;
            if (!name) {
                res.json({});
                return;
            }
            const [[info]] = await pool.execute(`SELECT MIN(mss.family) AS family, MIN(mss.ecosystem) AS ecosystem,
                MIN(mss.detects) AS detects, MIN(mss.charmable) AS charmable,
                MIN(mss.Element) AS element,
                MIN(mp.aggro) AS aggro, MIN(mp.links) AS links, MIN(mp.mJob) AS mjob,
                MIN(mp.resist_id) AS resist_id, MIN(mg.dropid) AS dropid
         FROM mob_spawn_points m
         LEFT JOIN mob_groups mg ON m.groupid=mg.groupid AND ((m.mobid>>12)&0xFFF)=mg.zoneid
         LEFT JOIN mob_pools mp ON mg.poolid=mp.poolid
         LEFT JOIN mob_species_system mss ON mp.speciesid=mss.speciesID
         WHERE m.mobname=? AND ((m.mobid>>12)&0xFFF)=?`, [name, zoneid]);
            const result = { ...info };
            if (info && info.dropid) {
                const [drops] = await pool.execute(`SELECT CONVERT(ib.name USING utf8) AS item, ib.itemid,
                  md.itemRate, md.groupRate, md.groupId, md.dropType
           FROM mob_droplist md
           JOIN item_basic ib ON md.itemId=ib.itemid
           WHERE md.dropId=? ORDER BY md.groupId, md.itemRate DESC`, [info.dropid]);
                result.drops = drops;
            }
            if (info && info.resist_id) {
                const [[res_row]] = await pool.execute(`SELECT fire_sdt, ice_sdt, wind_sdt, earth_sdt, lightning_sdt,
                  water_sdt, light_sdt, dark_sdt, slash_sdt, pierce_sdt, h2h_sdt, impact_sdt
           FROM mob_resistances WHERE resist_id=?`, [info.resist_id]);
                result.resistances = res_row;
            }
            res.json(result);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/db/npcs/wiki', auth_1.requireAuth, async (req, res) => {
        try {
            const rawName = (req.query.name || '').trim();
            if (!rawName) {
                res.json({});
                return;
            }
            const cacheKey = 'wiki:npc:' + rawName.toLowerCase();
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
            const descM = html.match(/<div[^>]*class="mw-parser-output"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/);
            const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            const description = descM ? stripTags(descM[1]) : null;
            const invM = html.match(/Involved In[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
            const quests = [];
            if (invM) {
                const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
                let m;
                while ((m = liRe.exec(invM[1])) !== null)
                    quests.push(stripTags(m[1]));
            }
            const out = { description, quests, wikiUrl, cachedAt: Date.now() };
            await (0, cache_1.cacheSetJSON)(cacheKey, out, cache_1.WIKI_TTL);
            res.json(out);
        }
        catch (e) {
            res.json({ error: e.message });
        }
    });
    router.get('/api/db/quest-logs', auth_1.requireAuth, (_req, res) => {
        const counts = [];
        for (let i = 0; i < 11; i++) {
            const total = Object.keys(catalog_1.QUEST_CATALOG[i] || {}).length;
            const scripted = Object.keys(catalog_1.QUEST_REWARDS[i] || {}).length;
            counts.push({ logId: i, name: catalog_1.QUEST_LOG_NAMES[i], total, scripted });
        }
        res.json(counts);
    });
    router.get('/api/db/quests/wiki', auth_1.requireAuth, async (req, res) => {
        const questName = (req.query.name || '').trim();
        if (!questName) {
            res.json(null);
            return;
        }
        const cacheKey = 'wiki:quest:' + questName.toLowerCase();
        const cached = await (0, cache_1.cacheGetJSON)(cacheKey);
        if (cached) {
            res.json(cached);
            return;
        }
        try {
            const slug = questName.replace(/ /g, '_').replace(/'/g, '%27');
            const url = `https://www.bg-wiki.com/ffxi/${slug}`;
            const resp = await fetch(url, { headers: { 'User-Agent': 'FFXI-Dashboard/1.0' }, signal: AbortSignal.timeout(6000) });
            if (!resp.ok) {
                res.json(null);
                return;
            }
            const html = await resp.text();
            const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#160;|&nbsp;/g, ' ').replace(/&apos;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
            const infoRows = {};
            const QUEST_KEYS = new Set(['Description', 'Starting NPC', 'Start NPC', 'Required Fame', 'Level Restriction', 'Level Restriction:', 'Repeatable', 'Rewards', 'Reward', 'Previous Quest', 'Next Quest', 'Pack', 'Title', 'Notes']);
            const tdRe = /<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
            let m;
            while ((m = tdRe.exec(html)) !== null) {
                const key = strip(m[1]).replace(/:$/, '').trim();
                const val = strip(m[2]).trim();
                if (QUEST_KEYS.has(key) && val && !infoRows[key])
                    infoRows[key] = val;
            }
            const catM = html.match(/wgCategories.*?\[([^\]]+)\]/);
            const cats = catM ? (catM[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, '')) : [];
            const repeatableRaw = infoRows['Repeatable'] || null;
            const repeatable = cats.includes('Repeatable Quests') || /yes/i.test(repeatableRaw || '');
            const areaFilter = ["San d'Oria", "Bastok", "Windurst", "Jeuno", "Outlands", "Aht Urhgan", "Crystal", "Abyssea", "Adoulin", "Coalition", "Southern", "Northern", "Eastern", "Western", "Port", "Lower", "Upper", "Other"];
            const typeQuests = cats.filter((c) => c.endsWith('Quests') && c !== 'Quests' && !c.includes('Repeatable') && !areaFilter.some(a => c.includes(a)));
            const questType = typeQuests[0] || null;
            const startNpc = infoRows['Starting NPC'] || infoRows['Start NPC'] || null;
            const lvRaw = infoRows['Level Restriction'] || infoRows['Level Restriction:'] || '';
            const lvM = lvRaw.match(/(\d+)/);
            const levelReq = lvM ? parseInt(lvM[1]) : null;
            const wikiReward = infoRows['Reward'] || infoRows['Rewards'] || null;
            const prevQuest = infoRows['Previous Quest'] || null;
            const nextQuest = infoRows['Next Quest'] || null;
            const description = infoRows['Description'] || null;
            const result = { description, repeatable, repeatableRaw, questType, startNpc, levelReq, wikiReward, prevQuest, nextQuest, wikiUrl: url, cachedAt: Date.now() };
            await (0, cache_1.cacheSetJSON)(cacheKey, result, cache_1.WIKI_TTL);
            res.json(result);
        }
        catch (e) {
            void e;
            res.json(null);
        }
    });
    router.get('/api/db/quests', auth_1.requireAuth, async (req, res) => {
        try {
            const q = (req.query.q || '').trim().toLowerCase();
            const log = req.query.log !== undefined ? parseInt(req.query.log) : null;
            const result = [];
            for (let logId = 0; logId < 11; logId++) {
                if (log !== null && logId !== log)
                    continue;
                for (const [qidStr, name] of Object.entries(catalog_1.QUEST_CATALOG[logId])) {
                    if (q && !name.toLowerCase().includes(q))
                        continue;
                    const questId = parseInt(qidStr);
                    result.push({ logId, logName: catalog_1.QUEST_LOG_NAMES[logId], questId, name, reward: catalog_1.QUEST_REWARDS[logId]?.[questId] || null });
                }
            }
            res.json(result);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/quest-settings', auth_1.requireAuth, (_req, res) => {
        res.json(catalog_1.QUEST_SETTINGS);
    });
    router.get('/api/roe/records', auth_1.requireAuth, (req, res) => {
        const q = (req.query.q || '').toLowerCase();
        const type = req.query.type || 'all';
        let list = Object.values(catalog_1.ROE_RECORDS);
        if (type !== 'all')
            list = list.filter(r => r.flags.includes(type));
        if (q)
            list = list.filter(r => r.name.toLowerCase().includes(q));
        res.json(list.slice(0, 100));
    });
    return router;
}
