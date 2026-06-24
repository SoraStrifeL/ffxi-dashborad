"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SERVER_SCRIPTS_ROOT = exports.DB_PAGE = exports.PLAYER_ALLOWED_ACTIONS = exports.EXP_PER_LEVEL = exports.QUEST_REWARDS = exports.QUEST_SETTINGS = exports.JOB_NAMES_BY_CONST = exports.FAME_AREA_BY_NAME = exports.FAME_AREA_NAMES = exports.QUEST_CONST_TO_ID = exports.QUEST_CATALOG = exports.QUEST_LOG_DIRS = exports.QUEST_LOG_ENUM = exports.QUEST_LOG_NAMES = exports.DEBUFF_IDS = exports.MISSION_NAMES = exports.MISSION_LOG_LABELS = exports.ROE_RECORDS = exports.ROE_NAMES = exports.TITLE_NAMES = exports.KEY_ITEM_NAMES = exports.SPELL_GROUPS = exports.MERIT_NAMES = exports.EFFECT_NAMES = exports.NPC_REGION_SQL = exports.ZONE_CACHE = exports.NPC_CATALOG = exports.MOB_CATALOG = exports.ZONE_MAPS = exports.ALLOWED_IMG_MIME = exports.windowerZoneEntities = exports.windowerPositions = exports.WINDOWER_API_KEY = exports.calStore = exports.CAL_FILE = exports.UPLOADS_DIR = exports.MAPS_DIR = void 0;
exports.saveCalStore = saveCalStore;
exports.makeUploader = makeUploader;
exports.normZoneName = normZoneName;
exports.buildZoneMaps = buildZoneMaps;
exports.queryStats = queryStats;
exports.queryPlayers = queryPlayers;
exports.loadMobCatalog = loadMobCatalog;
exports.loadNpcCatalog = loadNpcCatalog;
exports.loadZoneCache = loadZoneCache;
exports._mobRegionMatch = _mobRegionMatch;
exports.prettyEffectName = prettyEffectName;
exports.buildEffectNames = buildEffectNames;
exports.buildMeritNames = buildMeritNames;
exports.buildLuaEnum = buildLuaEnum;
exports.buildRoeRecords = buildRoeRecords;
exports.buildMissionNames = buildMissionNames;
exports.fmtMission = fmtMission;
exports.decodeMissions = decodeMissions;
exports.decodeAssault = decodeAssault;
exports.decodeCampaign = decodeCampaign;
exports.decodeBitfield = decodeBitfield;
exports.decodeKeyItems = decodeKeyItems;
exports.decodeEminence = decodeEminence;
exports._fmtConst = _fmtConst;
exports.buildQuestCatalog = buildQuestCatalog;
exports._parseRequirements = _parseRequirements;
exports._loadQuestSettings = _loadQuestSettings;
exports.buildQuestRewards = buildQuestRewards;
exports.loadExpTable = loadExpTable;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const multer_1 = __importDefault(require("multer"));
// ── Paths ─────────────────────────────────────────────────────────────────────
exports.MAPS_DIR = path_1.default.join(__dirname, '..', 'public', 'maps');
exports.UPLOADS_DIR = path_1.default.join(__dirname, '..', 'public', 'uploads');
['items', 'npcs', 'mobs'].forEach(d => fs_1.default.mkdirSync(path_1.default.join(exports.UPLOADS_DIR, d), { recursive: true }));
// ── Calibration store ─────────────────────────────────────────────────────────
exports.CAL_FILE = path_1.default.join(__dirname, '..', 'calibrations.json');
exports.calStore = {};
try {
    exports.calStore = JSON.parse(fs_1.default.readFileSync(exports.CAL_FILE, 'utf8'));
}
catch (_) { }
function saveCalStore() {
    try {
        fs_1.default.writeFileSync(exports.CAL_FILE, JSON.stringify(exports.calStore, null, 2));
    }
    catch (e) {
        console.error('[cal] save error:', e.message);
    }
}
// ── Windower live position store ───────────────────────────────────────────────
exports.WINDOWER_API_KEY = process.env.WINDOWER_API_KEY || '';
// charname → { name, zone, x, y, z, map_index, hp, mp, tp, ts }
exports.windowerPositions = new Map();
// Evict entries with no update in the last 30 s
setInterval(() => {
    const cutoff = Date.now() - 30000;
    for (const [k, v] of exports.windowerPositions)
        if (v.ts < cutoff)
            exports.windowerPositions.delete(k);
}, 10000);
// ── Windower zone entity store ─────────────────────────────────────────────────
// zoneId → { ts, entities: [{id, index, name, x, y, z, spawn_type, model_id}] }
exports.windowerZoneEntities = new Map();
// ── Image upload helper ────────────────────────────────────────────────────────
exports.ALLOWED_IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
function makeUploader(dest) {
    return (0, multer_1.default)({
        storage: multer_1.default.diskStorage({
            destination: (_req, _file, cb) => cb(null, dest),
            filename: (req, _file, cb) => cb(null, req._uploadFilename ?? 'upload'),
        }),
        limits: { fileSize: 8 * 1024 * 1024 },
        fileFilter: (_req, file, cb) => {
            if (exports.ALLOWED_IMG_MIME.has(file.mimetype)) {
                cb(null, true);
            }
            else {
                cb(new Error('Only image files are allowed'));
            }
        },
    }).single('image');
}
// ── Zone → map filename(s) ─────────────────────────────────────────────────────
function normZoneName(s) {
    return s.toLowerCase()
        .replace(/['\[\]()]/g, '')
        .replace(/[-\s]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}
exports.ZONE_MAPS = {};
async function buildZoneMaps(pool) {
    let files = [];
    try {
        files = fs_1.default.readdirSync(exports.MAPS_DIR).filter(f => f.endsWith('.png'));
    }
    catch (_) { }
    const groups = {};
    files.forEach(f => {
        const base = f.slice(0, -4).replace(/_\d+$/, '');
        (groups[base] = groups[base] || []).push(f);
    });
    Object.values(groups).forEach(g => g.sort((a, b) => {
        const n = (s) => parseInt(s.match(/_(\d+)\.png$/)?.[1] ?? '0');
        return n(a) - n(b);
    }));
    const nameToId = {};
    try {
        const [rows] = await pool.execute('SELECT zoneid, name FROM zone_settings');
        rows.forEach(r => { nameToId[normZoneName(r.name)] = r.zoneid; });
    }
    catch (_) {
        return;
    }
    const result = {};
    Object.entries(groups).forEach(([base, fileList]) => {
        const zoneId = nameToId[base];
        if (zoneId != null)
            result[zoneId] = fileList;
        else
            console.log(`[maps] no zone match for: ${base}`);
    });
    exports.ZONE_MAPS = result;
    console.log(`[maps] ${Object.keys(result).length} zones mapped from ${files.length} file(s)`);
}
// ── Shared queries ─────────────────────────────────────────────────────────────
async function queryStats(pool) {
    const [[r1]] = await pool.execute('SELECT COUNT(*) AS total_players  FROM chars');
    const [[r2]] = await pool.execute('SELECT COUNT(*) AS total_accounts FROM accounts');
    const [[r3]] = await pool.execute('SELECT COUNT(*) AS online_players FROM accounts_sessions');
    const [[r4]] = await pool.execute('SELECT COUNT(*) AS total_zones    FROM zone_settings');
    return {
        total_players: r1.total_players,
        total_accounts: r2.total_accounts,
        online_players: r3.online_players,
        total_zones: r4.total_zones,
    };
}
async function queryPlayers(pool) {
    const [rows] = await pool.execute(`
    SELECT c.charid, c.charname, c.pos_x, c.pos_y, c.pos_z, c.pos_zone,
           c.gmlevel, c.nation, c.playtime, c.timecreated, c.last_logout,
           z.name AS zone_name,
           cs.mjob, cs.mlvl, cs.sjob, cs.slvl, cs.hp, cs.mp,
           CASE WHEN ses.charid IS NOT NULL THEN 1 ELSE 0 END AS online
    FROM chars c
    LEFT JOIN zone_settings   z   ON c.pos_zone = z.zoneid
    LEFT JOIN char_stats      cs  ON c.charid   = cs.charid
    LEFT JOIN accounts_sessions ses ON c.charid = ses.charid
    ORDER BY c.charname
  `);
    return rows;
}
// ── In-memory catalogs ─────────────────────────────────────────────────────────
exports.MOB_CATALOG = [];
exports.NPC_CATALOG = [];
exports.ZONE_CACHE = null;
async function loadMobCatalog(pool) {
    try {
        const [rows] = await pool.execute(`
      SELECT m.mobname AS name, z.name AS zone, ((m.mobid>>12)&0xFFF) AS zoneid,
             MIN(m.minLevel) AS min_lvl, MAX(m.maxLevel) AS max_lvl, COUNT(*) AS spawns,
             MIN(mss.family) AS family, MIN(mss.ecosystem) AS ecosystem,
             MIN(mp.aggro) AS aggro, MIN(mp.links) AS links
      FROM mob_spawn_points m
      JOIN zone_settings z ON ((m.mobid>>12)&0xFFF)=z.zoneid
      LEFT JOIN mob_groups mg ON m.groupid=mg.groupid AND ((m.mobid>>12)&0xFFF)=mg.zoneid
      LEFT JOIN mob_pools mp ON mg.poolid=mp.poolid
      LEFT JOIN mob_species_system mss ON mp.speciesid=mss.speciesID
      WHERE m.mobname IS NOT NULL
      GROUP BY m.mobname, ((m.mobid>>12)&0xFFF)
      ORDER BY m.mobname`);
        exports.MOB_CATALOG = rows;
        console.log(`[catalog] ${exports.MOB_CATALOG.length} mob entries loaded`);
    }
    catch (e) {
        console.error('[catalog] mob load error:', e.message);
    }
}
async function loadNpcCatalog(pool) {
    try {
        const [rows] = await pool.execute(`
      SELECT n.npcid, CONVERT(n.name USING utf8) AS name, z.name AS zone, z.zoneid,
             ROUND(n.pos_x,2) AS x, ROUND(n.pos_y,2) AS y, ROUND(n.pos_z,2) AS z
      FROM npc_list n
      JOIN zone_settings z ON ((n.npcid>>12)&0xFFF)=z.zoneid
      WHERE n.name IS NOT NULL AND n.name NOT LIKE 'NPC[%'
      ORDER BY n.name`);
        exports.NPC_CATALOG = rows;
        console.log(`[catalog] ${exports.NPC_CATALOG.length} NPC entries loaded`);
    }
    catch (e) {
        console.error('[catalog] NPC load error:', e.message);
    }
}
async function loadZoneCache(pool) {
    try {
        const [rows] = await pool.execute(`
      SELECT z.zoneid, z.name, z.zonetype, z.misc, z.zoneip, z.zoneport,
             COALESCE(pc.player_count,0) AS player_count,
             COALESCE(nc.npc_count,0) AS npc_count,
             COALESCE(mc.mob_count,0) AS mob_count
      FROM zone_settings z
      LEFT JOIN (
        SELECT c.pos_zone, COUNT(DISTINCT c.charid) AS player_count
        FROM chars c
        JOIN accounts_sessions ses ON c.charid=ses.charid
        GROUP BY c.pos_zone
      ) pc ON pc.pos_zone=z.zoneid
      LEFT JOIN (SELECT ((npcid>>12)&0xFFF) AS zoneid, COUNT(DISTINCT npcid) AS npc_count
                 FROM npc_list WHERE name IS NOT NULL AND name NOT LIKE 'NPC[%'
                 GROUP BY ((npcid>>12)&0xFFF)) nc ON nc.zoneid=z.zoneid
      LEFT JOIN (SELECT ((mobid>>12)&0xFFF) AS zoneid, COUNT(DISTINCT mobid) AS mob_count
                 FROM mob_spawn_points GROUP BY ((mobid>>12)&0xFFF)) mc ON mc.zoneid=z.zoneid
      GROUP BY z.zoneid, z.name, z.zonetype, z.misc, z.zoneip, z.zoneport
      ORDER BY z.name`);
        exports.ZONE_CACHE = rows;
    }
    catch (e) {
        console.error('[catalog] zone cache error:', e.message);
    }
}
// ── NPC/mob region filter helpers ──────────────────────────────────────────────
exports.NPC_REGION_SQL = {
    'san_doria': `(z.name LIKE '%San_dOria%' OR z.name LIKE '%Oraguille%')`,
    'bastok': `z.name LIKE '%Bastok%'`,
    'windurst': `(z.name LIKE '%Windurst%' OR z.name='Heavens_Tower')`,
    'jeuno': `z.name LIKE '%Jeuno%'`,
    'aht_urhgan': `(z.name LIKE 'Aht_Urhgan%' OR z.name LIKE '%Al_Zahbi%' OR z.name LIKE '%Arrapago%' OR z.name LIKE 'Alzadaal%' OR z.name LIKE '%Bhaflau%' OR z.name LIKE 'Caedarva%' OR z.name LIKE 'Aydeewa%')`,
    'adoulin': `(z.name LIKE '%Adoulin%' OR z.name LIKE 'Ceizak%' OR z.name LIKE 'Foret%' OR z.name='Leafallia' OR z.name LIKE '%Kamihr%' OR z.name LIKE 'Cirdas%')`,
};
function _mobRegionMatch(z, region) {
    if (!region)
        return true;
    const NR = exports.NPC_REGION_SQL[region];
    if (!NR)
        return true;
    if (region === 'san_doria')
        return /san_doria|oraguille/i.test(z);
    if (region === 'bastok')
        return /bastok/i.test(z);
    if (region === 'windurst')
        return /windurst|heavens_tower/i.test(z);
    if (region === 'jeuno')
        return /jeuno/i.test(z);
    if (region === 'aht_urhgan')
        return /aht_urhgan|al_zahbi|arrapago|alzadaal|bhaflau|caedarva|aydeewa/i.test(z);
    if (region === 'adoulin')
        return /adoulin|ceizak|foret|leafallia|kamihr|cirdas/i.test(z);
    return true;
}
// Wiki responses are cached in Redis (src/cache.ts). No in-memory wiki cache.
// ── Status Effects ─────────────────────────────────────────────────────────────
function prettyEffectName(key) {
    return key.split('_').map(w => {
        if (/^(I{1,3}|IV|VI{0,3}|IX|XI{0,3}|XII)$/.test(w))
            return w;
        if (w.length <= 2 && /^[A-Z]+$/.test(w))
            return w;
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
}
function buildEffectNames() {
    const names = {};
    try {
        const text = fs_1.default.readFileSync('/ffxi-scripts/effect.lua', 'utf8');
        const re = /^\s+(\w+)\s*=\s*(\d+)/gm;
        let m;
        while ((m = re.exec(text)) !== null) {
            const id = parseInt(m[2]);
            if (!isNaN(id))
                names[id] = prettyEffectName(m[1]);
        }
    }
    catch (err) {
        console.warn('Effect names parse error:', err.message);
    }
    return names;
}
exports.EFFECT_NAMES = buildEffectNames();
// ── Merit names ────────────────────────────────────────────────────────────────
function buildMeritNames() {
    const names = {};
    try {
        const text = fs_1.default.readFileSync('/ffxi-scripts/merit.lua', 'utf8');
        const cats = {};
        const catMatch = text.match(/local meritCategory\s*=\s*\{([\s\S]*?)\}/);
        if (catMatch) {
            const re = /(\w+)\s*=\s*(0x[0-9A-Fa-f]+)/g;
            let m;
            while ((m = re.exec(catMatch[1])) !== null)
                cats[m[1]] = parseInt(m[2], 16);
        }
        const re = /(\w+)\s*=\s*meritCategory\.(\w+)\s*\+\s*(0x[0-9A-Fa-f]+)/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            const cat = cats[m[2]];
            if (cat !== undefined) {
                const id = cat + parseInt(m[3], 16);
                names[id] = m[1].split('_').map(w => /^(HP|MP|TP|H2H|WS|STR|DEX|VIT|AGI|INT|MND|CHR)$/.test(w) ? w :
                    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            }
        }
    }
    catch (err) {
        console.warn('Merit names parse error:', err.message);
    }
    return names;
}
exports.MERIT_NAMES = buildMeritNames();
exports.SPELL_GROUPS = {
    1: 'Song', 2: 'Black Magic', 3: 'Blue Magic', 4: 'Ninjutsu',
    5: 'Summon Magic', 6: 'White Magic', 7: 'Geomancy', 8: 'Trust',
};
// ── Generic Lua enum parser ────────────────────────────────────────────────────
function buildLuaEnum(filepath) {
    const names = {};
    try {
        const text = fs_1.default.readFileSync(filepath, 'utf8');
        const re = /^\s{4}(\w+)\s*=\s*(\d+)/gm;
        let m;
        while ((m = re.exec(text)) !== null)
            names[parseInt(m[2])] = m[1];
    }
    catch (e) {
        console.warn(`[enum] ${filepath}:`, e.message);
    }
    return names;
}
exports.KEY_ITEM_NAMES = buildLuaEnum('/ffxi-scripts/key_item.lua');
exports.TITLE_NAMES = buildLuaEnum('/ffxi-scripts/title.lua');
console.log(`[enum] ${Object.keys(exports.KEY_ITEM_NAMES).length} key items, ${Object.keys(exports.TITLE_NAMES).length} titles`);
// ── RoE Records ────────────────────────────────────────────────────────────────
function buildRoeRecords() {
    const names = {};
    const records = {};
    try {
        const text = fs_1.default.readFileSync('/ffxi-scripts/roe_records.lua', 'utf8');
        const blockRe = /\[(\d+)\]\s*=\s*\{([^[]*?)(?=\[\d+\]\s*=\s*\{|\s*\}$)/gs;
        let m;
        while ((m = blockRe.exec(text)) !== null) {
            const id = parseInt(m[1]);
            const body = m[2];
            const nameMatch = /--\s*(.+)/.exec(body);
            const name = nameMatch ? nameMatch[1].trim() : null;
            if (!name)
                continue;
            names[id] = name;
            const flagsMatch = /flags\s*=\s*set\s*\{([^}]*)\}/i.exec(body);
            const flags = flagsMatch ? (flagsMatch[1].match(/'(\w+)'/g)?.map(s => s.replace(/'/g, '')) || []) : [];
            const goalMatch = /goal\s*=\s*(\d+)/.exec(body);
            const goal = goalMatch ? parseInt(goalMatch[1]) : null;
            records[id] = { id, name, flags, goal };
        }
    }
    catch (e) {
        console.warn('[enum] roe_records.lua:', e.message);
    }
    return { names, records };
}
const { names: ROE_NAMES_MAP, records: ROE_RECORDS_MAP } = buildRoeRecords();
exports.ROE_NAMES = ROE_NAMES_MAP;
exports.ROE_RECORDS = ROE_RECORDS_MAP;
console.log(`[enum] ${Object.keys(exports.ROE_NAMES).length} RoE records`);
// ── Mission names ──────────────────────────────────────────────────────────────
exports.MISSION_LOG_LABELS = [
    "San d'Oria", 'Bastok', 'Windurst', 'Rise of the Zilart', 'ToAU',
    'Wings of the Goddess', 'Chains of Promathia', 'Assault', 'Campaign',
    'A Crystalline Prophecy', "A Moogle Kupo d'Etat",
    'A Shantotto Ascension', 'Seekers of Adoulin',
    "Return to Vana'diel", 'The Voracious Resurgence',
];
const _MISSION_KEY_TO_LOG = {
    SANDORIA: 0, BASTOK: 1, WINDURST: 2, ZILART: 3, TOAU: 4, WOTG: 5, COP: 6,
    ASSAULT: 7, CAMPAIGN: 8, ACP: 9, AMK: 10, ASA: 11, SOA: 12, ROV: 13, TVR: 14,
};
function buildMissionNames() {
    const result = {};
    try {
        const text = fs_1.default.readFileSync('/ffxi-scripts/missions.lua', 'utf8');
        const sectionRe = /\[xi\.mission\.area\[xi\.mission\.log_id\.(\w+)\]\]\s*=\s*\{([^}]+)\}/gs;
        let sec;
        while ((sec = sectionRe.exec(text)) !== null) {
            const logId = _MISSION_KEY_TO_LOG[sec[1]];
            if (logId === undefined)
                continue;
            const nameMap = {};
            const re = /^\s{8}(\w+)\s*=\s*(\d+)/gm;
            let m;
            while ((m = re.exec(sec[2])) !== null)
                nameMap[parseInt(m[2])] = m[1];
            result[logId] = nameMap;
        }
    }
    catch (e) {
        console.warn('[enum] missions.lua:', e.message);
    }
    return result;
}
exports.MISSION_NAMES = buildMissionNames();
console.log(`[enum] ${Object.values(exports.MISSION_NAMES).reduce((s, v) => s + Object.keys(v).length, 0)} mission entries across ${Object.keys(exports.MISSION_NAMES).length} logs`);
// ── Mission blob decoders ──────────────────────────────────────────────────────
function fmtMission(n) {
    return n ? n.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : null;
}
function decodeMissions(buf) {
    if (!buf || buf.length < 15 * 70)
        return [];
    const out = [];
    for (let log = 0; log < 15; log++) {
        const off = log * 70;
        const current = buf.readUInt16LE(off);
        const names = exports.MISSION_NAMES[log] || {};
        const completed = [];
        for (let j = 0; j < 64; j++) {
            if (buf[off + 6 + j] !== 0)
                completed.push({ id: j, name: fmtMission(names[j]) });
        }
        if (current === 0 && completed.length === 0)
            continue;
        const curId = current === 0xFFFF ? null : current;
        const curName = curId !== null ? fmtMission(names[curId]) : null;
        out.push({ log, label: exports.MISSION_LOG_LABELS[log], current: curId, currentName: curName, completed });
    }
    return out;
}
function decodeAssault(buf) {
    if (!buf || buf.length < 130)
        return null;
    const names = exports.MISSION_NAMES[7] || {};
    const current = buf.readUInt16LE(0) || null;
    const completed = [];
    for (let j = 0; j < 128; j++)
        if (buf[2 + j] !== 0)
            completed.push({ id: j, name: fmtMission(names[j]) });
    return { current, currentName: current !== null ? fmtMission(names[current]) : null, completed };
}
function decodeCampaign(buf) {
    if (!buf || buf.length < 514)
        return null;
    const current = buf.readUInt16LE(0) || null;
    let count = 0;
    for (let j = 0; j < 512; j++)
        if (buf[2 + j] !== 0)
            count++;
    return { current, completedCount: count };
}
function decodeBitfield(buf, nameMap) {
    if (!buf)
        return [];
    const out = [];
    for (let n = 1; n < buf.length * 8; n++) {
        if (buf[n >> 3] & (1 << (n % 8)))
            out.push({ id: n, name: nameMap[n] || null });
    }
    return out;
}
function decodeKeyItems(buf, nameMap) {
    if (!buf)
        return [];
    const out = [];
    for (let table = 0; table < 8; table++) {
        const base = table * 128;
        for (let i = 0; i < 512; i++) {
            if (buf[base + (i >> 3)] & (1 << (i % 8))) {
                const id = table * 512 + i;
                if (id > 0)
                    out.push({ id, name: nameMap[id] || null });
            }
        }
    }
    return out;
}
function decodeEminence(buf, nameMap) {
    if (!buf || buf.length < 700)
        return { completed: [], active: [] };
    const COMPLETE_OFFSET = 188;
    const completed = [];
    for (let n = 0; n < 4096; n++) {
        if (buf[COMPLETE_OFFSET + (n >> 3)] & (1 << (n % 8))) {
            completed.push({ id: n, name: nameMap[n] || null });
        }
    }
    const active = [];
    for (let slot = 0; slot < 31; slot++) {
        const id = buf.readUInt16LE(slot * 2);
        if (id > 0) {
            const progressOffset = 64 + slot * 4;
            const progress = buf.readUInt32LE(progressOffset);
            active.push({ id, name: nameMap[id] || null, progress });
        }
    }
    return { completed, active };
}
exports.DEBUFF_IDS = new Set([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 28, 29, 30, 31,
    128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149,
    156, 159, 167, 168, 174, 175, 189, 260, 261, 262, 263, 264, 299,
]);
// ── Quest system ───────────────────────────────────────────────────────────────
exports.QUEST_LOG_NAMES = ["San d'Oria", 'Bastok', 'Windurst', 'Jeuno', 'Other Areas', 'Outlands', 'Aht Urhgan', 'Crystal War', 'Abyssea', 'Adoulin', 'Coalition'];
exports.QUEST_LOG_ENUM = { SANDORIA: 0, BASTOK: 1, WINDURST: 2, JEUNO: 3, OTHER_AREAS: 4, OUTLANDS: 5, AHT_URHGAN: 6, CRYSTAL_WAR: 7, ABYSSEA: 8, ADOULIN: 9, COALITION: 10 };
exports.QUEST_LOG_DIRS = ['sandoria', 'bastok', 'windurst', 'jeuno', 'otherAreas', 'outlands', 'ahtUrhgan', 'crystalWar', 'abyssea', 'adoulin', 'coalition'];
function _fmtConst(s) {
    return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
function buildQuestCatalog() {
    const catalog = Array.from({ length: 11 }, () => ({}));
    const constToId = {};
    try {
        const text = fs_1.default.readFileSync('/ffxi-scripts/quests.lua', 'utf8');
        const sectionRe = /\[xi\.quest\.area\[xi\.questLog\.([A-Z_]+)\]\]\s*=\s*\{([^}]+)\}/gs;
        let m;
        while ((m = sectionRe.exec(text)) !== null) {
            const logIdx = exports.QUEST_LOG_ENUM[m[1]];
            if (logIdx === undefined)
                continue;
            const entryRe = /(\w+)\s*=\s*(\d+)/g;
            let e;
            while ((e = entryRe.exec(m[2])) !== null) {
                const qid = parseInt(e[2]);
                catalog[logIdx][qid] = e[1].replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
                constToId[`${logIdx}:${e[1]}`] = qid;
            }
        }
    }
    catch (err) {
        console.warn('Quest catalog parse error:', err.message);
    }
    catalog._constToId = constToId;
    return catalog;
}
exports.QUEST_CATALOG = buildQuestCatalog();
exports.QUEST_CONST_TO_ID = exports.QUEST_CATALOG._constToId;
// ── Fame / job lookup tables ───────────────────────────────────────────────────
exports.FAME_AREA_NAMES = {
    0: "San d'Oria", 1: 'Bastok', 2: 'Windurst', 3: 'Jeuno', 4: 'Selbina/Rabao',
    5: 'Norg', 6: 'Abyssea-Konschtat', 7: 'Abyssea-Tahrongi', 8: 'Abyssea-La Theine',
    9: 'Abyssea-Misareaux', 10: 'Abyssea-Vunkerl', 11: 'Abyssea-Attohwa',
    12: 'Abyssea-Altepa', 13: 'Abyssea-Grauberg', 14: 'Abyssea-Uleguerand', 15: 'Adoulin',
};
const _FAME_CONST_ORDER = {
    SANDORIA: 0, BASTOK: 1, WINDURST: 2, JEUNO: 3, SELBINA_RABAO: 4, NORG: 5,
    ABYSSEA_KONSCHTAT: 6, ABYSSEA_TAHRONGI: 7, ABYSSEA_LATHEINE: 8, ABYSSEA_MISAREAUX: 9,
    ABYSSEA_VUNKERL: 10, ABYSSEA_ATTOHWA: 11, ABYSSEA_ALTEPA: 12, ABYSSEA_GRAUBERG: 13,
    ABYSSEA_ULEGUERAND: 14, ADOULIN: 15,
};
exports.FAME_AREA_BY_NAME = Object.fromEntries(Object.entries(exports.FAME_AREA_NAMES).map(([k, v]) => {
    const constName = Object.keys(_FAME_CONST_ORDER)[parseInt(k)];
    return [constName, v];
}));
exports.JOB_NAMES_BY_CONST = {
    WAR: 'WAR', MNK: 'MNK', WHM: 'WHM', BLM: 'BLM', RDM: 'RDM', THF: 'THF', PLD: 'PLD', DRK: 'DRK',
    BST: 'BST', BRD: 'BRD', RNG: 'RNG', SAM: 'SAM', NIN: 'NIN', DRG: 'DRG', SMN: 'SMN', BLU: 'BLU',
    COR: 'COR', PUP: 'PUP', DNC: 'DNC', SCH: 'SCH', GEO: 'GEO', RUN: 'RUN',
};
// ── Quest requirement parser ───────────────────────────────────────────────────
function _parseRequirements(text) {
    const reqs = [];
    const availIdx = text.indexOf('QUEST_AVAILABLE');
    const checkBlock = availIdx >= 0 ? text.slice(Math.max(0, availIdx - 300), availIdx + 1200) : text;
    const fameRe = /getFameLevel\s*\(\s*xi\.fameArea\.(\w+)\s*\)\s*>=\s*(\d+)/g;
    let fm;
    while ((fm = fameRe.exec(checkBlock)) !== null) {
        const area = exports.FAME_AREA_BY_NAME[fm[1]] || fm[1].replace(/_/g, ' ');
        reqs.push({ type: 'fame', area, level: parseInt(fm[2]) });
    }
    const lvlRe = /getMainLvl\s*\(\s*\)\s*>=\s*(\d+)/g;
    let lm;
    while ((lm = lvlRe.exec(checkBlock)) !== null) {
        reqs.push({ type: 'level', min: parseInt(lm[1]) });
    }
    const rankRe = /getRank\s*\([^)]*\)\s*>=\s*(\d+)/g;
    let rm;
    while ((rm = rankRe.exec(checkBlock)) !== null) {
        reqs.push({ type: 'rank', min: parseInt(rm[1]) });
    }
    const jobRe = /getMainJob\s*\(\s*\)\s*==\s*xi\.job\.(\w+)/g;
    const jobsSeen = new Set();
    let jm;
    while ((jm = jobRe.exec(checkBlock)) !== null) {
        const j = exports.JOB_NAMES_BY_CONST[jm[1]];
        if (j && !jobsSeen.has(j)) {
            jobsSeen.add(j);
            reqs.push({ type: 'job', job: j });
        }
    }
    const kiAvailRe = /QUEST_AVAILABLE[^}]*?player:hasKeyItem\s*\(\s*xi\.(?:ki|keyItem)\.(\w+)\s*\)/gs;
    let km;
    const kiSeen = new Set();
    while ((km = kiAvailRe.exec(text)) !== null) {
        const ki = _fmtConst(km[1]);
        if (!kiSeen.has(ki)) {
            kiSeen.add(ki);
            reqs.push({ type: 'keyItem', name: ki });
        }
    }
    const preRe = /hasCompletedQuest\s*\(\s*xi\.questLog\.(\w+)\s*,\s*xi\.quest\.id\.\w+\.(\w+)\s*\)/g;
    let pm;
    while ((pm = preRe.exec(checkBlock)) !== null) {
        reqs.push({ type: 'quest', log: pm[1], name: _fmtConst(pm[2]) });
    }
    const misRe = /hasCompletedMission\s*\(\s*xi\.mission\.log_id\.(\w+)\s*,\s*(\d+)\s*\)/g;
    let mm;
    while ((mm = misRe.exec(checkBlock)) !== null) {
        reqs.push({ type: 'mission', log: mm[1], id: parseInt(mm[2]) });
    }
    const cvarRe = /getCharVar\s*\(\s*'([^']+)'\s*\)\s*(>=|==|<=|>|<|~=)\s*(\d+)/g;
    const cvarSeen = new Set();
    let cv;
    while ((cv = cvarRe.exec(checkBlock)) !== null) {
        const key = `${cv[1]}${cv[2]}${cv[3]}`;
        if (!cvarSeen.has(key)) {
            cvarSeen.add(key);
            reqs.push({ type: 'charvar', name: cv[1], op: cv[2], value: parseInt(cv[3]) });
        }
    }
    const settingRe = /xi\.settings\.main\.(\w+)\s*(==|~=|>=|>)\s*(\w+)/g;
    const settingSeen = new Set();
    let sv;
    while ((sv = settingRe.exec(checkBlock)) !== null) {
        const skey = sv[1];
        if (!settingSeen.has(skey)) {
            settingSeen.add(skey);
            const val = isNaN(Number(sv[3])) ? sv[3] : parseInt(sv[3]);
            reqs.push({ type: 'setting', name: sv[1], op: sv[2], value: val });
        }
    }
    return reqs;
}
// ── Quest settings ─────────────────────────────────────────────────────────────
function _loadQuestSettings() {
    const keys = [
        'ENABLE_TRUST_QUESTS', 'ENABLE_TOAU', 'ENABLE_WOTG', 'ENABLE_COP', 'ENABLE_ABYSSEA',
        'ENABLE_SOA', 'ENABLE_ROV', 'ENABLE_TVR', 'ENABLE_MONSTROSITY', 'ENABLE_CHOCOBO_RAISING',
        'AF1_QUEST_LEVEL', 'AF2_QUEST_LEVEL', 'AF3_QUEST_LEVEL', 'ADVANCED_JOB_LEVEL', 'MAX_LEVEL',
        'OLDSCHOOL_G1', 'OLDSCHOOL_G2', 'ENABLE_MAGIAN_TRIALS',
    ];
    const result = {};
    const paths = ['/ffxi-settings/main.lua', '/ffxi-settings/default/main.lua'];
    for (const p of paths) {
        let txt = '';
        try {
            txt = fs_1.default.readFileSync(p, 'utf8');
        }
        catch (e) {
            void e;
            continue;
        }
        for (const k of keys) {
            if (result[k] !== undefined)
                continue;
            const m = txt.match(new RegExp(`\\b${k}\\s*=\\s*([^,\\n]+)`));
            if (m) {
                const raw = m[1].trim().replace(/--.*$/, '').trim();
                if (raw === 'true')
                    result[k] = true;
                else if (raw === 'false')
                    result[k] = false;
                else if (!isNaN(Number(raw)))
                    result[k] = Number(raw);
                else
                    result[k] = raw;
            }
        }
    }
    return result;
}
exports.QUEST_SETTINGS = _loadQuestSettings();
// ── Quest rewards ──────────────────────────────────────────────────────────────
function buildQuestRewards() {
    const rewards = {};
    exports.QUEST_LOG_DIRS.forEach((dir, logId) => {
        rewards[logId] = {};
        const dirPath = `/ffxi-scripts/quests/${dir}`;
        let files;
        try {
            files = fs_1.default.readdirSync(dirPath).filter(f => f.endsWith('.lua'));
        }
        catch (e) {
            void e;
            return;
        }
        files.forEach(file => {
            let text;
            try {
                text = fs_1.default.readFileSync(`${dirPath}/${file}`, 'utf8');
            }
            catch (e) {
                void e;
                return;
            }
            let questId = null;
            const m1 = text.match(/--\s*Log ID:\s*\d+,\s*Quest ID:\s*(\d+)/);
            if (m1) {
                questId = parseInt(m1[1]);
            }
            else {
                const m2 = text.match(/--\s*!addquest\s+\d+\s+(\d+)/);
                if (m2)
                    questId = parseInt(m2[1]);
                else {
                    const m3 = text.match(/Quest:new\s*\(\s*xi\.questLog\.(\w+)\s*,\s*xi\.quest\.id\.\w+\.(\w+)\s*\)/);
                    if (m3) {
                        const lid = exports.QUEST_LOG_ENUM[m3[1]];
                        if (lid === logId)
                            questId = exports.QUEST_CONST_TO_ID[`${logId}:${m3[2]}`] ?? null;
                    }
                }
            }
            if (questId === null)
                return;
            const npcs = [];
            const npcRe = /^--\s+(.+?)\s*:?\s*!pos\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)(?:\s+(\d+))?/gm;
            let nm;
            while ((nm = npcRe.exec(text)) !== null) {
                const name = nm[1].trim().replace(/\s+/g, ' ');
                const x = parseFloat(nm[2]), y = parseFloat(nm[3]), z = parseFloat(nm[4]);
                const zoneId = nm[5] ? parseInt(nm[5]) : null;
                npcs.push({ name, x, y, z, zoneId });
            }
            const entry = npcs.length ? { npcs } : {};
            const rewardMatch = text.match(/quest\.reward\s*=\s*\{([^}]+)\}/s);
            if (rewardMatch) {
                const rt = rewardMatch[1];
                const g = rt.match(/\bgil\s*=\s*(\d+)/);
                if (g)
                    entry.gil = parseInt(g[1]);
                const xp = rt.match(/\bexp\s*=\s*(\d+)/);
                if (xp)
                    entry.exp = parseInt(xp[1]);
                const f = rt.match(/\bfame\s*=\s*(\d+)/);
                if (f)
                    entry.fame = parseInt(f[1]);
                const fa = rt.match(/\bfameArea\s*=\s*xi\.fameArea\.(\w+)/);
                if (fa)
                    entry.fameArea = exports.FAME_AREA_BY_NAME[fa[1]] || fa[1].replace(/_/g, ' ');
                const i = rt.match(/\bitem\s*=\s*xi\.item\.(\w+)/);
                if (i)
                    entry.item = _fmtConst(i[1]);
                const t = rt.match(/\btitle\s*=\s*xi\.title\.(\w+)/);
                if (t)
                    entry.title = _fmtConst(t[1]);
                const k = rt.match(/\bkeyItem\s*=\s*xi\.ki\.(\w+)/);
                if (k)
                    entry.keyItem = _fmtConst(k[1]);
                const b = rt.match(/\bbayld\s*=\s*(\d+)/);
                if (b)
                    entry.bayld = parseInt(b[1]);
            }
            const tradeItems = [];
            const tradeSeen = new Set();
            const tradeRe = /tradeHas(?:Exactly)?\s*\(\s*trade\s*,\s*(?:\{\s*\{?\s*)?xi\.item\.(\w+)(?:\s*,\s*(\d+))?/g;
            let tr;
            while ((tr = tradeRe.exec(text)) !== null) {
                const name = _fmtConst(tr[1]);
                const qty = tr[2] ? parseInt(tr[2]) : 1;
                const key = `${name}×${qty}`;
                if (!tradeSeen.has(key)) {
                    tradeSeen.add(key);
                    tradeItems.push({ name, qty });
                }
            }
            if (tradeItems.length)
                entry.tradeItems = tradeItems;
            const reqs = _parseRequirements(text);
            if (reqs.length)
                entry.reqs = reqs;
            if (Object.keys(entry).length)
                rewards[logId][questId] = entry;
        });
    });
    const total = Object.values(rewards).reduce((s, m) => s + Object.keys(m).length, 0);
    console.log(`[quests] ${total} quest entries loaded`);
    return rewards;
}
exports.QUEST_REWARDS = buildQuestRewards();
// ── EXP table ──────────────────────────────────────────────────────────────────
exports.EXP_PER_LEVEL = [];
async function loadExpTable(pool) {
    const [rows] = await pool.execute('SELECT level, exp FROM exp_base ORDER BY level');
    exports.EXP_PER_LEVEL = [];
    rows.forEach(r => { exports.EXP_PER_LEVEL[r.level] = r.exp; });
    console.log(`[exp] loaded ${rows.length} level thresholds`);
}
// ── Player allowed actions ─────────────────────────────────────────────────────
exports.PLAYER_ALLOWED_ACTIONS = new Set([]);
// ── DB page size ───────────────────────────────────────────────────────────────
exports.DB_PAGE = 50;
// ── Scripts root ───────────────────────────────────────────────────────────────
exports.SERVER_SCRIPTS_ROOT = '/ffxi-server-scripts';
