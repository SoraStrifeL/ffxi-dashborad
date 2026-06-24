"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCharactersRouter = createCharactersRouter;
const express_1 = require("express");
const auth_1 = require("../auth");
const catalog_1 = require("../catalog");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
function createCharactersRouter(pool) {
    const router = (0, express_1.Router)();
    router.get('/api/me', auth_1.requireAuth, async (req, res) => {
        try {
            const isAdmin = req.user.tier === 'admin';
            const [chars] = await pool.execute(`SELECT c.charid, c.charname, c.pos_zone, c.gmlevel, c.nation,
               z.name AS zone_name,
               cs.mjob, cs.mlvl, cs.sjob, cs.slvl, cs.hp, cs.mp,
               CASE WHEN ses.charid IS NOT NULL THEN 1 ELSE 0 END AS online
        FROM chars c
        LEFT JOIN zone_settings    z   ON c.pos_zone = z.zoneid
        LEFT JOIN char_stats       cs  ON c.charid   = cs.charid
        LEFT JOIN accounts_sessions ses ON c.charid  = ses.charid
        ${isAdmin ? '' : 'WHERE c.accid = ?'} ORDER BY c.charname`, isAdmin ? [] : [req.user.accid]);
            res.json({ tier: req.user.tier, login: req.user.login, accid: req.user.accid, characters: chars });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/characters/:zone', auth_1.requireAuth, async (req, res) => {
        try {
            const [rows] = await pool.execute(`
        SELECT c.charid, c.charname, c.pos_x, c.pos_y, c.pos_z,
               c.nation, cs.mjob, cs.mlvl, cs.sjob, cs.slvl, cs.hp, cs.mp,
               CASE WHEN ses.charid IS NOT NULL THEN 1 ELSE 0 END AS online
        FROM chars c
        LEFT JOIN char_stats       cs  ON c.charid = cs.charid
        LEFT JOIN accounts_sessions ses ON c.charid = ses.charid
        WHERE c.pos_zone = ?
        ORDER BY c.charname
      `, [parseInt(req.params.zone)]);
            res.json(rows);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    router.get('/api/character/:charid', auth_1.requireAuth, async (req, res) => {
        try {
            const charid = parseInt(req.params.charid);
            if (req.user.tier !== 'admin' && !(await (0, auth_1.userOwnsChar)(pool, req.user.accid, charid))) {
                res.status(403).json({ error: 'not your character' });
                return;
            }
            const [[c]] = await pool.execute(`
        SELECT c.charid, c.charname, c.pos_zone, c.pos_x, c.pos_y, c.pos_z,
               c.gmlevel, c.nation, c.playtime, c.timecreated, c.last_logout, c.accid,
               c.home_zone, c.home_x, c.home_y, c.home_z,
               c.pos_prevzone, c.mentor, c.job_master, c.moghancement,
               z.name  AS zone_name,
               hz.name AS home_zone_name,
               pz.name AS prev_zone_name,
               cs.mjob, cs.mlvl, cs.sjob, cs.slvl, cs.hp, cs.mp,
               cl.race, cl.size AS char_size, cl.face,
               cj.genkai,
               cj.war, cj.mnk, cj.whm, cj.blm, cj.rdm, cj.thf,
               cj.pld, cj.drk, cj.bst, cj.brd, cj.rng, cj.sam,
               cj.nin, cj.drg, cj.smn, cj.blu, cj.cor, cj.pup,
               cj.dnc, cj.sch, cj.geo, cj.run,
               a.login AS account_login, a.status AS account_status, a.priv AS account_priv,
               CASE WHEN ses.charid IS NOT NULL THEN 1 ELSE 0 END AS online
        FROM chars c
        LEFT JOIN zone_settings     z   ON c.pos_zone    = z.zoneid
        LEFT JOIN zone_settings     hz  ON c.home_zone   = hz.zoneid
        LEFT JOIN zone_settings     pz  ON c.pos_prevzone= pz.zoneid
        LEFT JOIN char_stats        cs  ON c.charid      = cs.charid
        LEFT JOIN char_look         cl  ON c.charid    = cl.charid
        LEFT JOIN char_jobs         cj  ON c.charid    = cj.charid
        LEFT JOIN accounts          a   ON c.accid     = a.id
        LEFT JOIN accounts_sessions ses ON c.charid    = ses.charid
        WHERE c.charid = ? LIMIT 1`, [charid]);
            if (!c) {
                res.status(404).json({ error: 'character not found' });
                return;
            }
            const [[gilRow]] = await pool.execute('SELECT quantity AS gil FROM char_inventory WHERE charid = ? AND itemId = 65535 LIMIT 1', [charid]);
            c.gil = gilRow ? gilRow.gil : 0;
            const [[gearRow]] = await pool.execute(`
        SELECT
          COALESCE(SUM(CASE WHEN im.modId = 2 THEN im.value ELSE 0 END), 0) AS gear_hp,
          COALESCE(SUM(CASE WHEN im.modId = 5 THEN im.value ELSE 0 END), 0) AS gear_mp
        FROM char_equip ce
        JOIN char_inventory ci
          ON ce.charid = ci.charid AND ce.containerid = ci.location AND ce.slotid = ci.slot
        LEFT JOIN item_mods im ON ci.itemId = im.itemId AND im.modId IN (2, 5)
        WHERE ce.charid = ?
      `, [charid]);
            c.gear_hp = gearRow ? Number(gearRow.gear_hp) : 0;
            c.gear_mp = gearRow ? Number(gearRow.gear_mp) : 0;
            res.json(c);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/character/:charid/extended', auth_1.requireAuth, async (req, res) => {
        try {
            const charid = parseInt(req.params.charid);
            if (req.user.tier !== 'admin' && !(await (0, auth_1.userOwnsChar)(pool, req.user.accid, charid))) {
                res.status(403).json({ error: 'not your character' });
                return;
            }
            const [[exp], [history], [profile], [points], [skills], [flags], [job_points], [merits], [spells], [pet], [chocobo], [unlocks], [storage], [bag_counts], [vars],] = await Promise.all([
                pool.execute(`SELECT war,mnk,whm,blm,rdm,thf,pld,drk,bst,brd,rng,sam,nin,drg,smn,blu,cor,pup,dnc,sch,geo,run,merits,limits FROM char_exp WHERE charid=?`, [charid]),
                pool.execute(`SELECT enemies_defeated,times_knocked_out,battles_fought,spells_cast,abilities_used,ws_used,items_used,npc_interactions,chats_sent,distance_travelled,mh_entrances,joined_parties,joined_alliances,gm_calls FROM char_history WHERE charid=?`, [charid]),
                pool.execute(`SELECT rank_points,rank_sandoria,rank_bastok,rank_windurst,fame_sandoria,fame_bastok,fame_windurst,fame_norg,fame_jeuno,fame_adoulin,unity_leader FROM char_profile WHERE charid=?`, [charid]),
                pool.execute(`SELECT sandoria_cp,bastok_cp,windurst_cp,spark_of_eminence,shining_star,deeds,bayld,escha_silt,escha_beads,allied_notes,unity_accolades,current_accolades,current_hallmarks,total_hallmarks,gallantry,login_points,fellow_point,imperial_standing,ballista_point,infamy,prestige,domain_points,mog_segments,gallimaufry,kinetic_unit,cruor,traverser_stones,voidstones,resistance_credit,dominion_note,zeni_point,jetton,therion_ichor,leujaoam_assault_point,mamool_assault_point,lebros_assault_point,periqia_assault_point,ilrusi_assault_point,nyzul_isle_assault_point,temenos_units,apollyon_units,beastman_seal,kindred_seal,kindred_crest,high_kindred_crest,sacred_kindred_crest,ancient_beastcoin,valor_point,scyld,research_mark,guild_fishing,guild_woodworking,guild_smithing,guild_goldsmithing,guild_weaving,guild_leathercraft,guild_bonecraft,guild_alchemy,guild_cooking,fire_crystals,ice_crystals,wind_crystals,earth_crystals,lightning_crystals,water_crystals,light_crystals,dark_crystals,daily_tally,chocobuck_sandoria,chocobuck_bastok,chocobuck_windurst FROM char_points WHERE charid=?`, [charid]),
                pool.execute(`SELECT cs.skillid, cs.value, cs.rank,
          CASE cs.rank
            WHEN 0 THEN sc.r0 WHEN 1 THEN sc.r1 WHEN 2 THEN sc.r2 WHEN 3 THEN sc.r3
            WHEN 4 THEN sc.r4 WHEN 5 THEN sc.r5 WHEN 6 THEN sc.r6 WHEN 7 THEN sc.r7
            WHEN 8 THEN sc.r8 WHEN 9 THEN sc.r9 WHEN 10 THEN sc.r10 WHEN 11 THEN sc.r11
            WHEN 12 THEN sc.r12 WHEN 13 THEN sc.r13
          END AS cap
          FROM char_skills cs
          JOIN char_stats cst ON cst.charid = cs.charid
          JOIN skill_caps sc ON sc.level = cst.mlvl
          WHERE cs.charid=? ORDER BY cs.skillid`, [charid]),
                pool.execute(`SELECT gmModeEnabled, gmHiddenEnabled, muted FROM char_flags WHERE charid=?`, [charid]),
                pool.execute(`SELECT jobid, capacity_points, job_points, job_points_spent FROM char_job_points WHERE charid=? ORDER BY jobid`, [charid]),
                pool.execute(`SELECT meritid, upgrades FROM char_merit WHERE charid=? AND upgrades>0 ORDER BY meritid`, [charid]),
                pool.execute(`SELECT cs.spellid, sl.name, sl.\`group\` FROM char_spells cs LEFT JOIN spell_list sl ON cs.spellid=sl.spellid WHERE cs.charid=? ORDER BY sl.\`group\`, sl.name`, [charid]),
                pool.execute(`SELECT wyvernid, automatonid, adventuringfellowid AS fellowid, chocoboid, field_chocobo FROM char_pet WHERE charid=?`, [charid]),
                pool.execute(`SELECT first_name, last_name, stage, color, strength, endurance, discernment, receptivity, affection, energy FROM char_chocobos WHERE charid=?`, [charid]),
                pool.execute(`SELECT outpost_sandy, outpost_bastok, outpost_windy, mog_locker, runic_portal, maw FROM char_unlocks WHERE charid=?`, [charid]),
                pool.execute(`SELECT inventory, safe, locker, satchel, sack, \`case\`, wardrobe FROM char_storage WHERE charid=?`, [charid]),
                pool.execute(`SELECT location, COUNT(*) AS count FROM char_inventory WHERE charid=? AND NOT (location=0 AND itemId=65535) GROUP BY location ORDER BY location`, [charid]),
                pool.execute(`SELECT varname, value FROM char_vars WHERE charid=? ORDER BY varname LIMIT 200`, [charid]),
            ]);
            res.json({
                exp: exp[0] || null,
                history: history[0] || null,
                profile: profile[0] || null,
                points: points[0] || null,
                skills,
                flags: flags[0] || null,
                job_points: job_points.map(r => ({ ...r })),
                merits: merits.map(r => ({ ...r, name: catalog_1.MERIT_NAMES[r.meritid] || `Merit ${r.meritid}` })),
                spells: spells.map(r => ({ ...r, groupName: catalog_1.SPELL_GROUPS[r.group] || `Group ${r.group}` })),
                pet: pet[0] || null,
                chocobo: chocobo[0] || null,
                unlocks: unlocks[0] || null,
                storage: storage[0] || null,
                bag_counts,
                vars,
                expPerLevel: catalog_1.EXP_PER_LEVEL,
            });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/character/:charid/quests', auth_1.requireAuth, async (req, res) => {
        try {
            const charid = parseInt(req.params.charid);
            if (req.user.tier !== 'admin' && !(await (0, auth_1.userOwnsChar)(pool, req.user.accid, charid))) {
                res.status(403).json({ error: 'not your character' });
                return;
            }
            const [[row]] = await pool.execute('SELECT quests FROM chars WHERE charid = ?', [charid]);
            if (!row || !row.quests) {
                res.json([]);
                return;
            }
            const blob = Buffer.isBuffer(row.quests) ? row.quests : Buffer.from(row.quests);
            const result = [];
            for (let logId = 0; logId < 11; logId++) {
                const base = logId * 64;
                const catalog = catalog_1.QUEST_CATALOG[logId];
                for (const [qidStr, name] of Object.entries(catalog)) {
                    const questId = parseInt(qidStr);
                    const byteIdx = questId >> 3;
                    if (byteIdx >= 32)
                        continue;
                    const bit = 1 << (questId & 7);
                    const isComplete = (blob[base + 32 + byteIdx] & bit) !== 0;
                    const isActive = (blob[base + byteIdx] & bit) !== 0;
                    if (isComplete || isActive) {
                        result.push({ logId, logName: catalog_1.QUEST_LOG_NAMES[logId], questId, name, status: isComplete ? 'complete' : 'active', reward: catalog_1.QUEST_REWARDS[logId]?.[questId] || null });
                    }
                }
            }
            res.json(result);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/character/:charid/vars', auth_1.requireAuth, async (req, res) => {
        try {
            const charid = parseInt(req.params.charid);
            if (req.user.tier !== 'admin' && !(await (0, auth_1.userOwnsChar)(pool, req.user.accid, charid))) {
                res.status(403).json({ error: 'not your character' });
                return;
            }
            const [rows] = await pool.execute(`SELECT varname, value FROM char_vars WHERE charid=? ORDER BY varname`, [charid]);
            const vars = {};
            for (const r of rows)
                vars[r.varname] = r.value;
            res.json(vars);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.post('/api/character/:charid/setvar', auth_1.requireAuth, auth_1.requireAdmin, async (req, res) => {
        try {
            const charid = parseInt(req.params.charid);
            const { varname, value } = req.body || {};
            if (!varname) {
                res.status(400).json({ error: 'varname required' });
                return;
            }
            if (value === null || value === undefined || value === '') {
                await pool.execute('DELETE FROM char_vars WHERE charid=? AND varname=?', [charid, varname]);
            }
            else {
                await pool.execute('INSERT INTO char_vars (charid,varname,value) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value=?', [charid, varname, parseInt(String(value)), parseInt(String(value))]);
            }
            res.json({ ok: true });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/character/:charid/effects', auth_1.requireAuth, async (req, res) => {
        try {
            const charid = parseInt(req.params.charid);
            if (req.user.tier !== 'admin' && !(await (0, auth_1.userOwnsChar)(pool, req.user.accid, charid))) {
                res.status(403).json({ error: 'not your character' });
                return;
            }
            const [rows] = await pool.execute('SELECT effectid, power, tick, duration, timestamp FROM char_effects WHERE charid = ? ORDER BY effectid', [charid]);
            const now = Math.floor(Date.now() / 1000);
            const result = rows.map(r => ({
                id: r.effectid,
                name: catalog_1.EFFECT_NAMES[r.effectid] || `Effect ${r.effectid}`,
                power: r.power,
                tick: r.tick,
                remaining: r.duration > 0 ? Math.max(0, r.timestamp + r.duration - now) : -1,
                isDebuff: catalog_1.DEBUFF_IDS.has(r.effectid),
            }));
            res.json(result);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/character/:charid/equipment', auth_1.requireAuth, async (req, res) => {
        try {
            const charid = parseInt(req.params.charid);
            if (req.user.tier !== 'admin' && !(await (0, auth_1.userOwnsChar)(pool, req.user.accid, charid))) {
                res.status(403).json({ error: 'not your character' });
                return;
            }
            const [rows] = await pool.execute(`
        SELECT ce.equipslotid AS slot, ci.itemId,
               CONVERT(ib.name USING utf8) AS name
        FROM char_equip ce
        JOIN char_inventory ci
          ON ce.charid=ci.charid AND ce.containerid=ci.location AND ce.slotid=ci.slot
        LEFT JOIN item_basic ib ON ci.itemId=ib.itemid
        WHERE ce.charid=?
        ORDER BY ce.equipslotid
      `, [charid]);
            res.json(rows);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/character/:charid/blobs', auth_1.requireAuth, async (req, res) => {
        try {
            const charid = parseInt(req.params.charid);
            if (req.user.tier !== 'admin' && !(await (0, auth_1.userOwnsChar)(pool, req.user.accid, charid))) {
                res.status(403).json({ error: 'not your character' });
                return;
            }
            const [[row]] = await pool.execute('SELECT keyitems, titles, zones, eminence, missions, assault, campaign FROM chars WHERE charid=?', [charid]);
            if (!row) {
                res.status(404).json({ error: 'character not found' });
                return;
            }
            const [zoneRows] = await pool.execute('SELECT zoneid, name FROM zone_settings');
            const zoneNameMap = {};
            zoneRows.forEach(z => { zoneNameMap[z.zoneid] = z.name; });
            const keyitems = (0, catalog_1.decodeKeyItems)(row.keyitems, catalog_1.KEY_ITEM_NAMES);
            const titles = (0, catalog_1.decodeBitfield)(row.titles, catalog_1.TITLE_NAMES);
            const zones = (0, catalog_1.decodeBitfield)(row.zones, zoneNameMap);
            const eminence = (0, catalog_1.decodeEminence)(row.eminence, catalog_1.ROE_NAMES);
            const missions = (0, catalog_1.decodeMissions)(row.missions);
            const assault = (0, catalog_1.decodeAssault)(row.assault);
            const campaign = (0, catalog_1.decodeCampaign)(row.campaign);
            res.json({ keyitems, titles, zones, eminence, missions, assault, campaign });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/character/:charid/bags', auth_1.requireAuth, async (req, res) => {
        try {
            const charid = parseInt(req.params.charid);
            if (req.user.tier !== 'admin' && !(await (0, auth_1.userOwnsChar)(pool, req.user.accid, charid))) {
                res.status(403).json({ error: 'not your character' });
                return;
            }
            const [items] = await pool.execute(`
        SELECT ci.location, ci.slot, ci.itemId, ci.quantity,
               CONVERT(ib.name USING utf8) AS name
        FROM char_inventory ci
        LEFT JOIN item_basic ib ON ci.itemId = ib.itemid
        WHERE ci.charid = ? AND ci.location NOT IN (0,2,3,17) AND ci.itemId != 0
        ORDER BY ci.location, ci.slot
      `, [charid]);
            const [[storage]] = await pool.execute(`SELECT safe,locker,satchel,\`case\`,wardrobe,wardrobe2,wardrobe3,wardrobe4,
                wardrobe5,wardrobe6,wardrobe7,wardrobe8 FROM char_storage WHERE charid=?`, [charid]);
            res.json({ items, storage: storage || null });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/inventory/:charid', auth_1.requireAuth, async (req, res) => {
        try {
            const charid = parseInt(req.params.charid);
            if (req.user.tier !== 'admin' && !(await (0, auth_1.userOwnsChar)(pool, req.user.accid, charid))) {
                res.status(403).json({ error: 'not your character' });
                return;
            }
            const [rows] = await pool.execute(`SELECT ci.slot, ci.itemId, ci.quantity, ci.bazaar, CONVERT(ib.name USING utf8) AS name
        FROM char_inventory ci LEFT JOIN item_basic ib ON ci.itemId = ib.itemid
        WHERE ci.charid = ? AND ci.location = 0 AND ci.itemId != 65535 ORDER BY ci.slot`, [charid]);
            res.json(rows);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/players/online', auth_1.requireAuth, async (_req, res) => {
        try {
            const [rows] = await pool.execute(`SELECT c.charid, c.charname FROM chars c
         JOIN accounts_sessions ses ON c.charid = ses.charid
         ORDER BY c.charname`);
            res.json(rows);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    router.get('/api/questscript', auth_1.requireAuth, auth_1.requireAdmin, (req, res) => {
        try {
            const name = (req.query.name || '').trim();
            if (!name) {
                res.json({ found: false });
                return;
            }
            const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            const target = normalize(name);
            const questsRoot = path_1.default.join(catalog_1.SERVER_SCRIPTS_ROOT, 'quests');
            if (!fs_1.default.existsSync(questsRoot)) {
                res.json({ found: false, reason: 'scripts not mounted' });
                return;
            }
            let found = null;
            for (const dir of fs_1.default.readdirSync(questsRoot)) {
                const dirPath = path_1.default.join(questsRoot, dir);
                if (!fs_1.default.statSync(dirPath).isDirectory())
                    continue;
                for (const file of fs_1.default.readdirSync(dirPath).filter((f) => f.endsWith('.lua'))) {
                    const fn = normalize(file.replace(/\.lua$/, ''));
                    if (fn === target || fn.includes(target) || target.includes(fn)) {
                        found = path_1.default.join('quests', dir, file);
                        break;
                    }
                }
                if (found)
                    break;
            }
            if (!found) {
                res.json({ found: false });
                return;
            }
            const content = fs_1.default.readFileSync(path_1.default.join(catalog_1.SERVER_SCRIPTS_ROOT, found), 'utf8');
            const vars = new Set();
            const pat = /[gs]etCharVar\s*\([^,)]+,\s*"([^"]+)"/gi;
            let m;
            while ((m = pat.exec(content)) !== null)
                vars.add(m[1]);
            res.json({ found: true, path: found, content, vars: [...vars].sort() });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    return router;
}
