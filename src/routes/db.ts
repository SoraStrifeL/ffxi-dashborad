import { Router } from 'express';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { requireAuth } from '../auth';
import {
  MOB_CATALOG, NPC_CATALOG, DB_PAGE,
  QUEST_CATALOG, QUEST_REWARDS, QUEST_LOG_NAMES,
  QUEST_SETTINGS,
  ROE_RECORDS,
  _mobRegionMatch,
  KEY_ITEM_NAMES,
} from '../catalog';
import { cacheGetJSON, cacheSetJSON, WIKI_TTL, ITEM_TYPES_TTL } from '../cache';

export function createDbRouter(pool: Pool): Router {
  const router = Router();

  const ITEM_NUMERIC_COLS: Record<string, string> = {
    level: 'ie.level', ilevel: 'ie.ilevel', dmg: 'iw.dmg', sell: 'ib.BaseSell',
  };

  router.get('/api/db/items', requireAuth, async (req, res) => {
    try {
      const qRaw    = ((req.query.q as string) || '').trim();
      const sort    = (req.query.sort as string) || '';
      const numCol  = ITEM_NUMERIC_COLS[sort];
      const qNumVal = numCol && /^\d+$/.test(qRaw) ? parseInt(qRaw) : null;
      const typeBit = req.query.type ? parseInt(req.query.type as string) : null;
      const rareOnly = req.query.rare === '1';
      const flagMask = req.query.flagmask ? parseInt(req.query.flagmask as string) : null;
      const flagVal  = req.query.flagval  !== undefined ? parseInt((req.query.flagval as string) || '0') : null;
      const skill = req.query.skill !== undefined && req.query.skill !== '' ? parseInt(req.query.skill as string) : null;
      const slotBit = req.query.slot ? parseInt(req.query.slot as string) : null;
      const page = Math.max(0, parseInt((req.query.page as string) || '0'));
      const sortMap: Record<string, string> = { level: 'ie.level DESC, ib.itemid', ilevel: 'ie.ilevel DESC, ib.itemid', sell: 'ib.BaseSell DESC, ib.itemid', dmg: 'iw.dmg DESC, ib.itemid', name: 'ib.name ASC' };
      const orderBy = sortMap[sort] || 'ib.itemid';
      const params: (string | number | null)[] = [];
      const extra: string[] = [];
      if (qNumVal !== null) {
        extra.push(`AND ${numCol} >= ?`);
        params.push(qNumVal);
      } else {
        extra.push('AND CONVERT(ib.name USING utf8) LIKE ?');
        params.push(`%${qRaw}%`);
      }
      if (typeBit !== null) { extra.push('AND ib.type=?'); params.push(typeBit); }
      if (rareOnly) extra.push('AND (ib.flags & 0x8000) != 0');
      if (flagMask !== null && !isNaN(flagMask)) {
        extra.push(`AND (ib.flags & ?) = ?`);
        params.push(flagMask, isNaN(flagVal as number) ? flagMask : flagVal);
      }
      if (skill !== null && !isNaN(skill)) { extra.push('AND iw.skill=?'); params.push(skill); }
      if (slotBit !== null) { extra.push('AND (ie.slot & ?) != 0'); params.push(slotBit); }
      params.push(DB_PAGE, page * DB_PAGE);
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT ib.itemid, CONVERT(ib.name USING utf8) AS name, ib.type, ib.flags, ib.stackSize, ib.BaseSell,
                ie.level, ie.ilevel, ie.slot, ie.jobs, iw.skill, iw.dmg, iw.dmgType, iw.delay
         FROM item_basic ib
         LEFT JOIN item_equipment ie ON ie.itemId=ib.itemid
         LEFT JOIN item_weapon iw ON iw.itemId=ib.itemid
         WHERE ib.name IS NOT NULL ${extra.join(' ')}
         ORDER BY ${orderBy} LIMIT ? OFFSET ?`, params);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/db/items/wiki', requireAuth, async (req, res) => {
    const rawName = ((req.query.name as string) || '').trim();
    if (!rawName) { res.json(null); return; }
    const cacheKey = 'wiki:item:' + rawName.toLowerCase();
    const cached = await cacheGetJSON(cacheKey);
    if (cached) { res.json(cached); return; }
    try {
      const slug = rawName.split('_')
        .map((w: string) => w.split('-').map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join('-'))
        .join('_');
      const url = `https://www.bg-wiki.com/ffxi/${encodeURIComponent(slug)}`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'FFXI-Dashboard/1.0' }, signal: AbortSignal.timeout(7000) });
      if (!resp.ok) { await cacheSetJSON(cacheKey, null, WIKI_TTL); res.json(null); return; }
      const html = await resp.text();
      const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#160;|&nbsp;/g, ' ').replace(/&apos;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
      const infoRows: Record<string, string> = {};
      const addRow = (rawKey: string, rawVal: string) => {
        const key = strip(rawKey).replace(/:$/, '').trim();
        const val = strip(rawVal).trim();
        if (key && val && !infoRows[key]) infoRows[key] = val;
      };
      const thRe = /<th[^>]*>([^<]*)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
      let m: RegExpExecArray | null;
      while ((m = thRe.exec(html)) !== null) addRow(m[1], m[2]);
      const tdRe = /<td[^>]*item-info-header[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*item-info-body[^>]*>([\s\S]*?)<\/td>/g;
      while ((m = tdRe.exec(html)) !== null) addRow(m[1], m[2]);
      const ahRaw = infoRows['AH Listing'] || infoRows['AH  Listing'] || '';
      const ahM = ahRaw.match(/[➞→]\s*(.+)/);
      const cats = (html.match(/wgCategories.*?\[([^\]]+)\]/) || [])[1];
      const catList = cats ? (cats.match(/"([^"]+)"/g) || []).map((s: string) => s.replace(/"/g, '')) : [];
      const result = {
        description:  infoRows['Description'] || null,
        flags:        infoRows['Flags'] || null,
        ahCategory:   ahM ? ahM[1].trim() : (ahRaw || null),
        itemType:     infoRows['Type'] || null,
        races:        infoRows['Races'] || null,
        validTargets: infoRows['Valid Targets'] || null,
        categories:   catList,
        wikiUrl:      url,
        cachedAt:     Date.now(),
      };
      await cacheSetJSON(cacheKey, result, WIKI_TTL);
      res.json(result);
    } catch (e) { void e; res.json(null); }
  });

  router.get('/api/db/item-types', requireAuth, async (_req, res) => {
    try {
      const cached = await cacheGetJSON<RowDataPacket[]>('db:item-types');
      if (cached) { res.json(cached); return; }
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT type, COUNT(*) AS cnt FROM item_basic WHERE name IS NOT NULL AND name != '' GROUP BY type ORDER BY type`);
      await cacheSetJSON('db:item-types', rows, ITEM_TYPES_TTL);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/db/items/:itemid', requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.itemid as string);
      const [[basic]] = await pool.execute<RowDataPacket[]>(
        `SELECT ib.itemid, CONVERT(ib.name USING utf8) AS name, ib.type, ib.stackSize, ib.BaseSell, ib.flags,
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
      if (!basic) { res.json(null); return; }
      const [mods]    = await pool.execute<RowDataPacket[]>(`SELECT modId, value FROM item_mods WHERE itemId=? ORDER BY modId`, [id]);
      const [drops]   = await pool.execute<RowDataPacket[]>(
        `SELECT m.mobname AS name, z.name AS zone, dl.itemRate, dl.groupRate
         FROM mob_droplist dl
         JOIN mob_groups mg ON mg.dropid = dl.dropId
         JOIN mob_spawn_points m ON m.groupid = mg.groupid
         JOIN zone_settings z ON ((m.mobid>>12)&0xFFF) = z.zoneid
         WHERE dl.itemId=?
         GROUP BY m.mobname, ((m.mobid>>12)&0xFFF)
         ORDER BY dl.itemRate DESC LIMIT 20`, [id]);
      const [recipes] = await pool.execute<RowDataPacket[]>(
        `SELECT sr.ID, sr.Wood, sr.Smith, sr.Gold, sr.Cloth, sr.Leather, sr.Bone, sr.Alchemy, sr.Cook,
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
      const [shops]   = await pool.execute<RowDataPacket[]>(
        `SELECT gs.guildid, gs.min_price, gs.max_price, gs.max_quantity
         FROM guild_shops gs WHERE gs.itemid=? LIMIT 5`, [id]);
      res.json({ ...basic, mods, drops, recipes, shops });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/db/npcs', requireAuth, (req, res) => {
    const q      = ((req.query.q as string) || '').trim().toLowerCase();
    const zone   = ((req.query.zone as string) || '').trim().toLowerCase();
    const region = (req.query.region as string) || null;
    const sort   = (req.query.sort as string) || '';
    const page   = Math.max(0, parseInt((req.query.page as string) || '0'));
    let rows = NPC_CATALOG;
    if (q)      rows = rows.filter(r => (r.name as string).toLowerCase().includes(q));
    if (zone)   rows = rows.filter(r => r.zone && (r.zone as string).toLowerCase().includes(zone));
    if (region) rows = rows.filter(r => _mobRegionMatch((r.zone as string) || '', region));
    if (sort === 'zone') rows = [...rows].sort((a, b) => ((a.zone as string) || '').localeCompare((b.zone as string) || '') || (a.name as string).localeCompare(b.name as string));
    else if (sort === 'name') rows = [...rows].sort((a, b) => (a.name as string).localeCompare(b.name as string));
    res.json(rows.slice(page * DB_PAGE, page * DB_PAGE + DB_PAGE).map(r => ({ ...r, _total: undefined })));
  });

  router.get('/api/db/mobs', requireAuth, (req, res) => {
    const q         = ((req.query.q as string) || '').trim().toLowerCase();
    const zone      = ((req.query.zone as string) || '').trim().toLowerCase();
    const region    = (req.query.region as string) || null;
    const ecosystem = (req.query.ecosystem as string) || null;
    const sort      = (req.query.sort as string) || '';
    const page      = Math.max(0, parseInt((req.query.page as string) || '0'));
    let rows = MOB_CATALOG;
    if (q)         rows = rows.filter(r => (r.name as string).toLowerCase().includes(q));
    if (zone)      rows = rows.filter(r => r.zone && (r.zone as string).toLowerCase().includes(zone));
    if (region)    rows = rows.filter(r => _mobRegionMatch((r.zone as string) || '', region));
    if (ecosystem) rows = rows.filter(r => r.ecosystem === ecosystem);
    if (sort === 'zone')    rows = [...rows].sort((a, b) => ((a.zone as string) || '').localeCompare((b.zone as string) || '') || (a.name as string).localeCompare(b.name as string));
    else if (sort === 'level')  rows = [...rows].sort((a, b) => ((b.max_lvl as number) || 0) - ((a.max_lvl as number) || 0) || (a.name as string).localeCompare(b.name as string));
    else if (sort === 'spawns') rows = [...rows].sort((a, b) => ((b.spawns as number) || 0) - ((a.spawns as number) || 0) || (a.name as string).localeCompare(b.name as string));
    else if (sort === 'family') rows = [...rows].sort((a, b) => ((a.family as string) || '').localeCompare((b.family as string) || '') || (a.name as string).localeCompare(b.name as string));
    res.json(rows.slice(page * DB_PAGE, page * DB_PAGE + DB_PAGE));
  });

  router.get('/api/db/mobs/detail', requireAuth, async (req, res) => {
    try {
      const name   = ((req.query.name as string) || '').trim();
      const zoneid = parseInt(req.query.zone as string) || 0;
      if (!name) { res.json({}); return; }
      const [[info]] = await pool.execute<RowDataPacket[]>(
        `SELECT MIN(mss.family) AS family, MIN(mss.ecosystem) AS ecosystem,
                MIN(mss.detects) AS detects, MIN(mss.charmable) AS charmable,
                MIN(mss.Element) AS element,
                MIN(mp.aggro) AS aggro, MIN(mp.links) AS links, MIN(mp.mJob) AS mjob,
                MIN(mp.resist_id) AS resist_id, MIN(mg.dropid) AS dropid
         FROM mob_spawn_points m
         LEFT JOIN mob_groups mg ON m.groupid=mg.groupid AND ((m.mobid>>12)&0xFFF)=mg.zoneid
         LEFT JOIN mob_pools mp ON mg.poolid=mp.poolid
         LEFT JOIN mob_species_system mss ON mp.speciesid=mss.speciesID
         WHERE m.mobname=? AND ((m.mobid>>12)&0xFFF)=?`, [name, zoneid]);
      const result: Record<string, unknown> = { ...info };
      if (info && info.dropid) {
        const [drops] = await pool.execute<RowDataPacket[]>(
          `SELECT CONVERT(ib.name USING utf8) AS item, ib.itemid,
                  md.itemRate, md.groupRate, md.groupId, md.dropType
           FROM mob_droplist md
           JOIN item_basic ib ON md.itemId=ib.itemid
           WHERE md.dropId=? ORDER BY md.groupId, md.itemRate DESC`, [info.dropid]);
        result.drops = drops;
      }
      if (info && info.resist_id) {
        const [[res_row]] = await pool.execute<RowDataPacket[]>(
          `SELECT fire_sdt, ice_sdt, wind_sdt, earth_sdt, lightning_sdt,
                  water_sdt, light_sdt, dark_sdt, slash_sdt, pierce_sdt, h2h_sdt, impact_sdt
           FROM mob_resistances WHERE resist_id=?`, [info.resist_id]);
        result.resistances = res_row;
      }
      res.json(result);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/db/npcs/wiki', requireAuth, async (req, res) => {
    try {
      const rawName = ((req.query.name as string) || '').trim();
      if (!rawName) { res.json({}); return; }
      const cacheKey = 'wiki:npc:' + rawName.toLowerCase();
      const cached = await cacheGetJSON(cacheKey);
      if (cached) { res.json(cached); return; }
      const wikiName = rawName.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join('_');
      const wikiUrl = `https://www.bg-wiki.com/ffxi/${encodeURIComponent(wikiName)}`;
      const resp = await fetch(wikiUrl, { headers: { 'User-Agent': 'FFXIDashboard/1.0' }, signal: AbortSignal.timeout(8000) });
      if (!resp.ok) { res.json({ wikiUrl, notFound: true }); return; }
      const html = await resp.text();
      const descM = html.match(/<div[^>]*class="mw-parser-output"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/);
      const stripTags = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const description = descM ? stripTags(descM[1]) : null;
      const invM = html.match(/Involved In[\s\S]*?<ul>([\s\S]*?)<\/ul>/i);
      const quests: string[] = [];
      if (invM) {
        const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
        let m: RegExpExecArray | null;
        while ((m = liRe.exec(invM[1])) !== null) quests.push(stripTags(m[1]));
      }
      const out = { description, quests, wikiUrl, cachedAt: Date.now() };
      await cacheSetJSON(cacheKey, out, WIKI_TTL);
      res.json(out);
    } catch (e) { res.json({ error: (e as Error).message }); }
  });

  router.get('/api/db/quest-logs', requireAuth, (_req, res) => {
    const counts = [];
    for (let i = 0; i < 11; i++) {
      const total    = Object.keys(QUEST_CATALOG[i] || {}).length;
      const scripted = Object.keys(QUEST_REWARDS[i] || {}).length;
      counts.push({ logId: i, name: QUEST_LOG_NAMES[i], total, scripted });
    }
    res.json(counts);
  });

  router.get('/api/db/quests/wiki', requireAuth, async (req, res) => {
    const questName = ((req.query.name as string) || '').trim();
    if (!questName) { res.json(null); return; }
    const cacheKey = 'wiki:quest:' + questName.toLowerCase();
    const cached = await cacheGetJSON(cacheKey);
    if (cached) { res.json(cached); return; }
    try {
      const slug = questName.replace(/ /g, '_').replace(/'/g, '%27');
      const url = `https://www.bg-wiki.com/ffxi/${slug}`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'FFXI-Dashboard/1.0' }, signal: AbortSignal.timeout(6000) });
      if (!resp.ok) { res.json(null); return; }
      const html = await resp.text();
      const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#160;|&nbsp;/g, ' ').replace(/&apos;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
      const infoRows: Record<string, string> = {};
      const QUEST_KEYS = new Set(['Description', 'Starting NPC', 'Start NPC', 'Required Fame', 'Level Restriction', 'Level Restriction:', 'Repeatable', 'Rewards', 'Reward', 'Previous Quest', 'Next Quest', 'Pack', 'Title', 'Notes']);
      const tdRe = /<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
      let m: RegExpExecArray | null;
      while ((m = tdRe.exec(html)) !== null) {
        const key = strip(m[1]).replace(/:$/, '').trim();
        const val = strip(m[2]).trim();
        if (QUEST_KEYS.has(key) && val && !infoRows[key]) infoRows[key] = val;
      }
      const catM = html.match(/wgCategories.*?\[([^\]]+)\]/);
      const cats = catM ? (catM[1].match(/"([^"]+)"/g) || []).map((s: string) => s.replace(/"/g, '')) : [];
      const repeatableRaw = infoRows['Repeatable'] || null;
      const repeatable = cats.includes('Repeatable Quests') || /yes/i.test(repeatableRaw || '');
      const areaFilter = ["San d'Oria", "Bastok", "Windurst", "Jeuno", "Outlands", "Aht Urhgan", "Crystal", "Abyssea", "Adoulin", "Coalition", "Southern", "Northern", "Eastern", "Western", "Port", "Lower", "Upper", "Other"];
      const typeQuests = cats.filter((c: string) => c.endsWith('Quests') && c !== 'Quests' && !c.includes('Repeatable') && !areaFilter.some(a => c.includes(a)));
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
      await cacheSetJSON(cacheKey, result, WIKI_TTL);
      res.json(result);
    } catch (e) { void e; res.json(null); }
  });

  router.get('/api/db/quests', requireAuth, async (req, res) => {
    try {
      const q   = ((req.query.q as string) || '').trim().toLowerCase();
      const log = req.query.log !== undefined ? parseInt(req.query.log as string) : null;
      const result = [];
      for (let logId = 0; logId < 11; logId++) {
        if (log !== null && logId !== log) continue;
        for (const [qidStr, name] of Object.entries(QUEST_CATALOG[logId])) {
          if (q && !(name as string).toLowerCase().includes(q)) continue;
          const questId = parseInt(qidStr);
          result.push({ logId, logName: QUEST_LOG_NAMES[logId], questId, name, reward: QUEST_REWARDS[logId]?.[questId] || null });
        }
      }
      res.json(result);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/db/keyitems', requireAuth, (req, res) => {
    const q = ((req.query.q as string) || '').toLowerCase().trim();
    const page = Math.max(0, parseInt(req.query.page as string) || 0);
    const entries = Object.entries(KEY_ITEM_NAMES)
      .filter(([, name]) => !q || name.toLowerCase().includes(q))
      .sort(([a], [b]) => Number(a) - Number(b))
      .slice(page * DB_PAGE, (page + 1) * DB_PAGE)
      .map(([id, name]) => ({ id: Number(id), name }));
    res.json(entries);
  });

  router.get('/api/db/skills', requireAuth, async (req, res) => {
    try {
      const q = ((req.query.q as string) || '').toLowerCase().trim();
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT sr.skillid, sr.name,
           sr.war, sr.mnk, sr.whm, sr.blm, sr.rdm, sr.thf, sr.pld, sr.drk,
           sr.bst, sr.brd, sr.rng, sr.sam, sr.nin, sr.drg, sr.smn, sr.blu,
           sr.cor, sr.pup, sr.dnc, sr.sch, sr.geo, sr.run,
           sc.r0, sc.r1, sc.r2, sc.r3, sc.r4, sc.r5, sc.r6,
           sc.r7, sc.r8, sc.r9, sc.r10, sc.r11, sc.r12, sc.r13
         FROM skill_ranks sr
         JOIN skill_caps sc ON sc.level = 99
         WHERE sr.name IS NOT NULL AND sr.name != ''
         ORDER BY sr.skillid`
      );
      const ranks = q ? rows.filter(r => (r.name as string).toLowerCase().includes(q)) : rows;
      res.json(ranks);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  const JOBS_LIST = ['war','mnk','whm','blm','rdm','thf','pld','drk','bst','brd','rng','sam','nin','drg','smn','blu','cor','pup','dnc','sch','geo','run'] as const;

  router.get('/api/db/jobs', requireAuth, async (_req, res) => {
    try {
      const sel = JOBS_LIST.map(j => `cj.${j}`).join(', ');
      const [rows] = await pool.execute<RowDataPacket[]>(`SELECT ${sel} FROM chars c JOIN char_jobs cj ON cj.charid = c.charid`);
      const stats = JOBS_LIST.map(job => {
        const leveled = rows.filter(r => (r[job] as number) > 1);
        return { job, max: leveled.length ? Math.max(...leveled.map(r => r[job] as number)) : 0, count: leveled.length };
      });
      res.json(stats);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/db/trusts', requireAuth, async (req, res) => {
    try {
      const q = ((req.query.q as string) || '').toLowerCase().trim();
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT itemid, name FROM item_basic WHERE name LIKE 'cipher_of_%_alter_ego%' ORDER BY name`
      );
      const trusts = (rows as Array<{itemid: number; name: string}>)
        .map(r => {
          const isII = r.name.endsWith('_alter_ego_ii');
          let label = r.name
            .replace(/^cipher_of_/, '')
            .replace(/_alter_ego_ii$/, '')
            .replace(/_alter_ego.*$/, '')
            .replace(/\._/g, '. ')
            .replace(/_/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, c => c.toUpperCase())
            + (isII ? ' II' : '');
          return { itemid: r.itemid, name: r.name, label };
        })
        .filter(r => !q || r.label.toLowerCase().includes(q));
      res.json(trusts);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/db/abilities', requireAuth, async (req, res) => {
    try {
      const q = `%${((req.query.q as string) || '').trim()}%`;
      const job = req.query.job !== undefined ? parseInt(req.query.job as string) : null;
      const page = Math.max(0, parseInt((req.query.page as string) || '0'));
      const params: (string | number)[] = [q];
      let where = 'WHERE a.name IS NOT NULL AND a.name != \'\' AND a.name LIKE ?';
      if (job !== null && !isNaN(job)) { where += ' AND a.job = ?'; params.push(job); }
      params.push(DB_PAGE, page * DB_PAGE);
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT a.abilityId, a.name, a.job, a.level, a.recastTime, a.castTime, a.actionType, a.range, a.isAOE
         FROM abilities a ${where} ORDER BY a.job, a.level, a.abilityId LIMIT ? OFFSET ?`,
        params
      );
      res.json(rows);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/db/mounts', requireAuth, async (req, res) => {
    try {
      const q = ((req.query.q as string) || '').toLowerCase().trim();
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT itemid, name FROM item_basic WHERE name LIKE '♪%' ORDER BY itemid`
      );
      const mounts = (rows as Array<{itemid: number; name: string}>)
        .map(r => ({
          itemid: r.itemid,
          name: r.name,
          label: r.name.replace(/^♪/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        }))
        .filter(r => !q || r.label.toLowerCase().includes(q));
      res.json(mounts);
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });

  router.get('/api/quest-settings', requireAuth, (_req, res) => {
    res.json(QUEST_SETTINGS);
  });

  router.get('/api/roe/records', requireAuth, (req, res) => {
    const q    = ((req.query.q as string) || '').toLowerCase();
    const type = (req.query.type as string) || 'all';
    let list = Object.values(ROE_RECORDS);
    if (type !== 'all') list = list.filter(r => r.flags.includes(type));
    if (q) list = list.filter(r => r.name.toLowerCase().includes(q));
    res.json(list.slice(0, 100));
  });

  return router;
}
