import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { Pool, RowDataPacket } from 'mysql2/promise';
import { WindowerPosition, ZoneEntity } from './types';

// ── Paths ─────────────────────────────────────────────────────────────────────
export const MAPS_DIR    = path.join(__dirname, '..', 'public', 'maps');
export const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

// Configurable LSB directory roots — set these in .env for bare-metal or Windows installs.
// Docker: the compose file mounts these at the defaults below via volumes.
export const LSB_SCRIPTS_DIR  = process.env.LSB_SCRIPTS_DIR  || '/ffxi-scripts';
export const LSB_SETTINGS_DIR = process.env.LSB_SETTINGS_DIR || '/ffxi-settings';
export const LSB_LOG_DIR      = process.env.LSB_LOG_DIR      || '/ffxi-log';
['items', 'npcs', 'mobs'].forEach(d => fs.mkdirSync(path.join(UPLOADS_DIR, d), { recursive: true }));

// ── Calibration store ─────────────────────────────────────────────────────────
export const CAL_FILE = path.join(__dirname, '..', 'data', 'calibrations.json');
export let calStore: Record<string, unknown> = {};
try { calStore = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')); } catch (_) {}
export function saveCalStore(): void {
  try { fs.writeFileSync(CAL_FILE, JSON.stringify(calStore, null, 2)); }
  catch (e) { console.error('[cal] save error:', (e as Error).message); }
}

// ── Windower live position store ───────────────────────────────────────────────
export const WINDOWER_API_KEY = process.env.WINDOWER_API_KEY || '';
// charname → { name, zone, x, y, z, map_index, hp, mp, tp, ts }
export const windowerPositions = new Map<string, WindowerPosition>();
// Evict entries with no update in the last 30 s
setInterval(() => {
  const cutoff = Date.now() - 30_000;
  for (const [k, v] of windowerPositions) if (v.ts < cutoff) windowerPositions.delete(k);
}, 10_000);

// ── Windower zone entity store ─────────────────────────────────────────────────
// zoneId → { ts, entities: [{id, index, name, x, y, z, spawn_type, model_id}] }
export const windowerZoneEntities = new Map<number, { ts: number; entities: ZoneEntity[] }>();

// ── Image upload helper ────────────────────────────────────────────────────────
export const ALLOWED_IMG_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export function makeUploader(dest: string): ReturnType<ReturnType<typeof multer>['single']> {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dest),
      filename:    (req, _file, cb) => cb(null, (req as Express.Request & { _uploadFilename?: string })._uploadFilename ?? 'upload'),
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_IMG_MIME.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed'));
      }
    },
  }).single('image');
}

// ── Zone → map filename(s) ─────────────────────────────────────────────────────
export function normZoneName(s: string): string {
  return s.toLowerCase()
    .replace(/['\[\]()]/g, '')
    .replace(/[-\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export let ZONE_MAPS: Record<number, string[]> = {};
export async function buildZoneMaps(pool: Pool): Promise<void> {
  let files: string[] = [];
  try { files = fs.readdirSync(MAPS_DIR).filter(f => f.endsWith('.png')); } catch (_) {}

  const groups: Record<string, string[]> = {};
  files.forEach(f => {
    const base = f.slice(0, -4).replace(/_\d+$/, '');
    (groups[base] = groups[base] || []).push(f);
  });
  Object.values(groups).forEach(g => g.sort((a, b) => {
    const n = (s: string) => parseInt(s.match(/_(\d+)\.png$/)?.[1] ?? '0');
    return n(a) - n(b);
  }));

  const nameToId: Record<string, number> = {};
  try {
    const [rows] = await pool.execute<RowDataPacket[]>('SELECT zoneid, name FROM zone_settings');
    rows.forEach(r => { nameToId[normZoneName(r.name as string)] = r.zoneid as number; });
  } catch (_) { return; }

  const result: Record<number, string[]> = {};
  Object.entries(groups).forEach(([base, fileList]) => {
    const zoneId = nameToId[base];
    if (zoneId != null) result[zoneId] = fileList;
    else console.log(`[maps] no zone match for: ${base}`);
  });

  ZONE_MAPS = result;
  console.log(`[maps] ${Object.keys(result).length} zones mapped from ${files.length} file(s)`);
}

// ── Shared queries ─────────────────────────────────────────────────────────────
export async function queryStats(pool: Pool): Promise<Record<string, number>> {
  const [[r1]] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS total_players  FROM chars');
  const [[r2]] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS total_accounts FROM accounts');
  const [[r3]] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS online_players FROM accounts_sessions');
  const [[r4]] = await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS total_zones    FROM zone_settings');
  return {
    total_players:  r1.total_players  as number,
    total_accounts: r2.total_accounts as number,
    online_players: r3.online_players as number,
    total_zones:    r4.total_zones    as number,
  };
}

export async function queryPlayers(pool: Pool): Promise<RowDataPacket[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(`
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
export let MOB_CATALOG: RowDataPacket[] = [];
export let NPC_CATALOG: RowDataPacket[] = [];
export let ZONE_CACHE:  RowDataPacket[] | null = null;

export async function loadMobCatalog(pool: Pool): Promise<void> {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(`
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
    MOB_CATALOG = rows;
    console.log(`[catalog] ${MOB_CATALOG.length} mob entries loaded`);
  } catch (e) { console.error('[catalog] mob load error:', (e as Error).message); }
}

export async function loadNpcCatalog(pool: Pool): Promise<void> {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(`
      SELECT n.npcid, CONVERT(n.name USING utf8) AS name, z.name AS zone, z.zoneid,
             ROUND(n.pos_x,2) AS x, ROUND(n.pos_y,2) AS y, ROUND(n.pos_z,2) AS z
      FROM npc_list n
      JOIN zone_settings z ON ((n.npcid>>12)&0xFFF)=z.zoneid
      WHERE n.name IS NOT NULL AND n.name NOT LIKE 'NPC[%'
      ORDER BY n.name`);
    NPC_CATALOG = rows;
    console.log(`[catalog] ${NPC_CATALOG.length} NPC entries loaded`);
  } catch (e) { console.error('[catalog] NPC load error:', (e as Error).message); }
}

export async function loadZoneCache(pool: Pool): Promise<void> {
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(`
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
    ZONE_CACHE = rows;
  } catch (e) { console.error('[catalog] zone cache error:', (e as Error).message); }
}

// ── NPC/mob region filter helpers ──────────────────────────────────────────────
export const NPC_REGION_SQL: Record<string, string> = {
  'san_doria':  `(z.name LIKE '%San_dOria%' OR z.name LIKE '%Oraguille%')`,
  'bastok':     `z.name LIKE '%Bastok%'`,
  'windurst':   `(z.name LIKE '%Windurst%' OR z.name='Heavens_Tower')`,
  'jeuno':      `z.name LIKE '%Jeuno%'`,
  'aht_urhgan': `(z.name LIKE 'Aht_Urhgan%' OR z.name LIKE '%Al_Zahbi%' OR z.name LIKE '%Arrapago%' OR z.name LIKE 'Alzadaal%' OR z.name LIKE '%Bhaflau%' OR z.name LIKE 'Caedarva%' OR z.name LIKE 'Aydeewa%')`,
  'adoulin':    `(z.name LIKE '%Adoulin%' OR z.name LIKE 'Ceizak%' OR z.name LIKE 'Foret%' OR z.name='Leafallia' OR z.name LIKE '%Kamihr%' OR z.name LIKE 'Cirdas%')`,
};

export function _mobRegionMatch(z: string, region: string | null): boolean {
  if (!region) return true;
  const NR = NPC_REGION_SQL[region];
  if (!NR) return true;
  if (region === 'san_doria')  return /san_doria|oraguille/i.test(z);
  if (region === 'bastok')     return /bastok/i.test(z);
  if (region === 'windurst')   return /windurst|heavens_tower/i.test(z);
  if (region === 'jeuno')      return /jeuno/i.test(z);
  if (region === 'aht_urhgan') return /aht_urhgan|al_zahbi|arrapago|alzadaal|bhaflau|caedarva|aydeewa/i.test(z);
  if (region === 'adoulin')    return /adoulin|ceizak|foret|leafallia|kamihr|cirdas/i.test(z);
  return true;
}

// Wiki responses are cached in Redis (src/cache.ts). No in-memory wiki cache.

// ── Status Effects ─────────────────────────────────────────────────────────────
export function prettyEffectName(key: string): string {
  return key.split('_').map(w => {
    if (/^(I{1,3}|IV|VI{0,3}|IX|XI{0,3}|XII)$/.test(w)) return w;
    if (w.length <= 2 && /^[A-Z]+$/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

export function buildEffectNames(): Record<number, string> {
  const names: Record<number, string> = {};
  try {
    const text = fs.readFileSync(`${LSB_SCRIPTS_DIR}/effect.lua`, 'utf8');
    const re = /^\s+(\w+)\s*=\s*(\d+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const id = parseInt(m[2]);
      if (!isNaN(id)) names[id] = prettyEffectName(m[1]);
    }
  } catch (err) { console.warn('Effect names parse error:', (err as Error).message); }
  return names;
}
export const EFFECT_NAMES = buildEffectNames();

// ── Merit names ────────────────────────────────────────────────────────────────
export function buildMeritNames(): Record<number, string> {
  const names: Record<number, string> = {};
  try {
    const text = fs.readFileSync(`${LSB_SCRIPTS_DIR}/merit.lua`, 'utf8');
    const cats: Record<string, number> = {};
    const catMatch = text.match(/local meritCategory\s*=\s*\{([\s\S]*?)\}/);
    if (catMatch) {
      const re = /(\w+)\s*=\s*(0x[0-9A-Fa-f]+)/g; let m: RegExpExecArray | null;
      while ((m = re.exec(catMatch[1])) !== null) cats[m[1]] = parseInt(m[2], 16);
    }
    const re = /(\w+)\s*=\s*meritCategory\.(\w+)\s*\+\s*(0x[0-9A-Fa-f]+)/g; let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const cat = cats[m[2]];
      if (cat !== undefined) {
        const id = cat + parseInt(m[3], 16);
        names[id] = m[1].split('_').map(w =>
          /^(HP|MP|TP|H2H|WS|STR|DEX|VIT|AGI|INT|MND|CHR)$/.test(w) ? w :
          w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        ).join(' ');
      }
    }
  } catch (err) { console.warn('Merit names parse error:', (err as Error).message); }
  return names;
}
export const MERIT_NAMES = buildMeritNames();

export const SPELL_GROUPS: Record<number, string> = {
  1: 'Song', 2: 'Black Magic', 3: 'Blue Magic', 4: 'Ninjutsu',
  5: 'Summon Magic', 6: 'White Magic', 7: 'Geomancy', 8: 'Trust',
};

// ── Generic Lua enum parser ────────────────────────────────────────────────────
export function buildLuaEnum(filepath: string): Record<number, string> {
  const names: Record<number, string> = {};
  try {
    const text = fs.readFileSync(filepath, 'utf8');
    const re = /^\s{4}(\w+)\s*=\s*(\d+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) names[parseInt(m[2])] = m[1];
  } catch (e) { console.warn(`[enum] ${filepath}:`, (e as Error).message); }
  return names;
}

export const KEY_ITEM_NAMES = buildLuaEnum(`${LSB_SCRIPTS_DIR}/key_item.lua`);
export const TITLE_NAMES    = buildLuaEnum(`${LSB_SCRIPTS_DIR}/title.lua`);
console.log(`[enum] ${Object.keys(KEY_ITEM_NAMES).length} key items, ${Object.keys(TITLE_NAMES).length} titles`);

// ── RoE Records ────────────────────────────────────────────────────────────────
export function buildRoeRecords(): { names: Record<number, string>; records: Record<number, { id: number; name: string; flags: string[]; goal: number | null }> } {
  const names: Record<number, string> = {};
  const records: Record<number, { id: number; name: string; flags: string[]; goal: number | null }> = {};
  try {
    const text = fs.readFileSync(`${LSB_SCRIPTS_DIR}/roe_records.lua`, 'utf8');
    const blockRe = /\[(\d+)\]\s*=\s*\{([^[]*?)(?=\[\d+\]\s*=\s*\{|\s*\}$)/gs;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(text)) !== null) {
      const id = parseInt(m[1]);
      const body = m[2];
      const nameMatch = /--\s*(.+)/.exec(body);
      const name = nameMatch ? nameMatch[1].trim() : null;
      if (!name) continue;
      names[id] = name;
      const flagsMatch = /flags\s*=\s*set\s*\{([^}]*)\}/i.exec(body);
      const flags = flagsMatch ? (flagsMatch[1].match(/'(\w+)'/g)?.map(s => s.replace(/'/g, '')) || []) : [];
      const goalMatch = /goal\s*=\s*(\d+)/.exec(body);
      const goal = goalMatch ? parseInt(goalMatch[1]) : null;
      records[id] = { id, name, flags, goal };
    }
  } catch (e) { console.warn('[enum] roe_records.lua:', (e as Error).message); }
  return { names, records };
}
const { names: ROE_NAMES_MAP, records: ROE_RECORDS_MAP } = buildRoeRecords();
export const ROE_NAMES   = ROE_NAMES_MAP;
export const ROE_RECORDS = ROE_RECORDS_MAP;
console.log(`[enum] ${Object.keys(ROE_NAMES).length} RoE records`);

// ── Mission names ──────────────────────────────────────────────────────────────
export const MISSION_LOG_LABELS = [
  "San d'Oria", 'Bastok', 'Windurst', 'Rise of the Zilart', 'ToAU',
  'Wings of the Goddess', 'Chains of Promathia', 'Assault', 'Campaign',
  'A Crystalline Prophecy', "A Moogle Kupo d'Etat",
  'A Shantotto Ascension', 'Seekers of Adoulin',
  "Return to Vana'diel", 'The Voracious Resurgence',
];
const _MISSION_KEY_TO_LOG: Record<string, number> = {
  SANDORIA: 0, BASTOK: 1, WINDURST: 2, ZILART: 3, TOAU: 4, WOTG: 5, COP: 6,
  ASSAULT: 7, CAMPAIGN: 8, ACP: 9, AMK: 10, ASA: 11, SOA: 12, ROV: 13, TVR: 14,
};

export function buildMissionNames(): Record<number, Record<number, string>> {
  const result: Record<number, Record<number, string>> = {};
  try {
    const text = fs.readFileSync(`${LSB_SCRIPTS_DIR}/missions.lua`, 'utf8');
    const sectionRe = /\[xi\.mission\.area\[xi\.mission\.log_id\.(\w+)\]\]\s*=\s*\{([^}]+)\}/gs;
    let sec: RegExpExecArray | null;
    while ((sec = sectionRe.exec(text)) !== null) {
      const logId = _MISSION_KEY_TO_LOG[sec[1]];
      if (logId === undefined) continue;
      const nameMap: Record<number, string> = {};
      const re = /^\s{8}(\w+)\s*=\s*(\d+)/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sec[2])) !== null) nameMap[parseInt(m[2])] = m[1];
      result[logId] = nameMap;
    }
  } catch (e) { console.warn('[enum] missions.lua:', (e as Error).message); }
  return result;
}
export const MISSION_NAMES = buildMissionNames();
console.log(`[enum] ${Object.values(MISSION_NAMES).reduce((s, v) => s + Object.keys(v).length, 0)} mission entries across ${Object.keys(MISSION_NAMES).length} logs`);

// ── Mission blob decoders ──────────────────────────────────────────────────────
export function fmtMission(n: string | undefined): string | null {
  return n ? n.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : null;
}

export function decodeMissions(buf: Buffer | null | undefined): unknown[] {
  if (!buf || buf.length < 15 * 70) return [];
  const out = [];
  for (let log = 0; log < 15; log++) {
    const off = log * 70;
    const current = buf.readUInt16LE(off);
    const names = MISSION_NAMES[log] || {};
    const completed: { id: number; name: string | null }[] = [];
    for (let j = 0; j < 64; j++) {
      if (buf[off + 6 + j] !== 0) completed.push({ id: j, name: fmtMission(names[j]) });
    }
    if (current === 0 && completed.length === 0) continue;
    const curId   = current === 0xFFFF ? null : current;
    const curName = curId !== null ? fmtMission(names[curId]) : null;
    out.push({ log, label: MISSION_LOG_LABELS[log], current: curId, currentName: curName, completed });
  }
  return out;
}

export function decodeAssault(buf: Buffer | null | undefined): unknown {
  if (!buf || buf.length < 130) return null;
  const names = MISSION_NAMES[7] || {};
  const current = buf.readUInt16LE(0) || null;
  const completed: { id: number; name: string | null }[] = [];
  for (let j = 0; j < 128; j++) if (buf[2 + j] !== 0) completed.push({ id: j, name: fmtMission(names[j]) });
  return { current, currentName: current !== null ? fmtMission(names[current]) : null, completed };
}

export function decodeCampaign(buf: Buffer | null | undefined): unknown {
  if (!buf || buf.length < 514) return null;
  const current = buf.readUInt16LE(0) || null;
  let count = 0;
  for (let j = 0; j < 512; j++) if (buf[2 + j] !== 0) count++;
  return { current, completedCount: count };
}

export function decodeBitfield(buf: Buffer | null | undefined, nameMap: Record<number, string>): { id: number; name: string | null }[] {
  if (!buf) return [];
  const out: { id: number; name: string | null }[] = [];
  for (let n = 1; n < buf.length * 8; n++) {
    if (buf[n >> 3] & (1 << (n % 8))) out.push({ id: n, name: nameMap[n] || null });
  }
  return out;
}

export function decodeKeyItems(buf: Buffer | null | undefined, nameMap: Record<number, string>): { id: number; name: string | null }[] {
  if (!buf) return [];
  const out: { id: number; name: string | null }[] = [];
  for (let table = 0; table < 8; table++) {
    const base = table * 128;
    for (let i = 0; i < 512; i++) {
      if (buf[base + (i >> 3)] & (1 << (i % 8))) {
        const id = table * 512 + i;
        if (id > 0) out.push({ id, name: nameMap[id] || null });
      }
    }
  }
  return out;
}

export function decodeEminence(buf: Buffer | null | undefined, nameMap: Record<number, string>): { completed: { id: number; name: string | null }[]; active: { id: number; name: string | null; progress: number }[] } {
  if (!buf || buf.length < 700) return { completed: [], active: [] };
  const COMPLETE_OFFSET = 188;
  const completed: { id: number; name: string | null }[] = [];
  for (let n = 0; n < 4096; n++) {
    if (buf[COMPLETE_OFFSET + (n >> 3)] & (1 << (n % 8))) {
      completed.push({ id: n, name: nameMap[n] || null });
    }
  }
  const active: { id: number; name: string | null; progress: number }[] = [];
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

export const DEBUFF_IDS = new Set([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 28, 29, 30, 31,
  128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149,
  156, 159, 167, 168, 174, 175, 189, 260, 261, 262, 263, 264, 299,
]);

// ── Quest system ───────────────────────────────────────────────────────────────
export const QUEST_LOG_NAMES = ["San d'Oria", 'Bastok', 'Windurst', 'Jeuno', 'Other Areas', 'Outlands', 'Aht Urhgan', 'Crystal War', 'Abyssea', 'Adoulin', 'Coalition'];
export const QUEST_LOG_ENUM: Record<string, number>  = { SANDORIA: 0, BASTOK: 1, WINDURST: 2, JEUNO: 3, OTHER_AREAS: 4, OUTLANDS: 5, AHT_URHGAN: 6, CRYSTAL_WAR: 7, ABYSSEA: 8, ADOULIN: 9, COALITION: 10 };
export const QUEST_LOG_DIRS = ['sandoria', 'bastok', 'windurst', 'jeuno', 'otherAreas', 'outlands', 'ahtUrhgan', 'crystalWar', 'abyssea', 'adoulin', 'coalition'];

export type QuestCatalogWithMeta = Array<Record<number, string>> & { _constToId: Record<string, number> };

export function _fmtConst(s: string): string {
  return s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

export function buildQuestCatalog(): QuestCatalogWithMeta {
  const catalog = Array.from({ length: 11 }, () => ({} as Record<number, string>)) as QuestCatalogWithMeta;
  const constToId: Record<string, number> = {};
  try {
    const text = fs.readFileSync(`${LSB_SCRIPTS_DIR}/quests.lua`, 'utf8');
    const sectionRe = /\[xi\.quest\.area\[xi\.questLog\.([A-Z_]+)\]\]\s*=\s*\{([^}]+)\}/gs;
    let m: RegExpExecArray | null;
    while ((m = sectionRe.exec(text)) !== null) {
      const logIdx = QUEST_LOG_ENUM[m[1]];
      if (logIdx === undefined) continue;
      const entryRe = /(\w+)\s*=\s*(\d+)/g;
      let e: RegExpExecArray | null;
      while ((e = entryRe.exec(m[2])) !== null) {
        const qid = parseInt(e[2]);
        catalog[logIdx][qid] = e[1].replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
        constToId[`${logIdx}:${e[1]}`] = qid;
      }
    }
  } catch (err) { console.warn('Quest catalog parse error:', (err as Error).message); }
  catalog._constToId = constToId;
  return catalog;
}
export const QUEST_CATALOG = buildQuestCatalog();
export const QUEST_CONST_TO_ID = QUEST_CATALOG._constToId;

// ── Fame / job lookup tables ───────────────────────────────────────────────────
export const FAME_AREA_NAMES: Record<number, string> = {
  0: "San d'Oria", 1: 'Bastok', 2: 'Windurst', 3: 'Jeuno', 4: 'Selbina/Rabao',
  5: 'Norg', 6: 'Abyssea-Konschtat', 7: 'Abyssea-Tahrongi', 8: 'Abyssea-La Theine',
  9: 'Abyssea-Misareaux', 10: 'Abyssea-Vunkerl', 11: 'Abyssea-Attohwa',
  12: 'Abyssea-Altepa', 13: 'Abyssea-Grauberg', 14: 'Abyssea-Uleguerand', 15: 'Adoulin',
};
const _FAME_CONST_ORDER: Record<string, number> = {
  SANDORIA: 0, BASTOK: 1, WINDURST: 2, JEUNO: 3, SELBINA_RABAO: 4, NORG: 5,
  ABYSSEA_KONSCHTAT: 6, ABYSSEA_TAHRONGI: 7, ABYSSEA_LATHEINE: 8, ABYSSEA_MISAREAUX: 9,
  ABYSSEA_VUNKERL: 10, ABYSSEA_ATTOHWA: 11, ABYSSEA_ALTEPA: 12, ABYSSEA_GRAUBERG: 13,
  ABYSSEA_ULEGUERAND: 14, ADOULIN: 15,
};
export const FAME_AREA_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(FAME_AREA_NAMES).map(([k, v]) => {
    const constName = Object.keys(_FAME_CONST_ORDER)[parseInt(k)];
    return [constName, v];
  })
);

export const JOB_NAMES_BY_CONST: Record<string, string> = {
  WAR: 'WAR', MNK: 'MNK', WHM: 'WHM', BLM: 'BLM', RDM: 'RDM', THF: 'THF', PLD: 'PLD', DRK: 'DRK',
  BST: 'BST', BRD: 'BRD', RNG: 'RNG', SAM: 'SAM', NIN: 'NIN', DRG: 'DRG', SMN: 'SMN', BLU: 'BLU',
  COR: 'COR', PUP: 'PUP', DNC: 'DNC', SCH: 'SCH', GEO: 'GEO', RUN: 'RUN',
};

// ── Quest requirement parser ───────────────────────────────────────────────────
export function _parseRequirements(text: string): unknown[] {
  const reqs: unknown[] = [];
  const availIdx = text.indexOf('QUEST_AVAILABLE');
  const checkBlock = availIdx >= 0 ? text.slice(Math.max(0, availIdx - 300), availIdx + 1200) : text;

  const fameRe = /getFameLevel\s*\(\s*xi\.fameArea\.(\w+)\s*\)\s*>=\s*(\d+)/g;
  let fm: RegExpExecArray | null;
  while ((fm = fameRe.exec(checkBlock)) !== null) {
    const area = FAME_AREA_BY_NAME[fm[1]] || fm[1].replace(/_/g, ' ');
    reqs.push({ type: 'fame', area, level: parseInt(fm[2]) });
  }
  const lvlRe = /getMainLvl\s*\(\s*\)\s*>=\s*(\d+)/g;
  let lm: RegExpExecArray | null;
  while ((lm = lvlRe.exec(checkBlock)) !== null) {
    reqs.push({ type: 'level', min: parseInt(lm[1]) });
  }
  const rankRe = /getRank\s*\([^)]*\)\s*>=\s*(\d+)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rankRe.exec(checkBlock)) !== null) {
    reqs.push({ type: 'rank', min: parseInt(rm[1]) });
  }
  const jobRe = /getMainJob\s*\(\s*\)\s*==\s*xi\.job\.(\w+)/g;
  const jobsSeen = new Set<string>();
  let jm: RegExpExecArray | null;
  while ((jm = jobRe.exec(checkBlock)) !== null) {
    const j = JOB_NAMES_BY_CONST[jm[1]];
    if (j && !jobsSeen.has(j)) { jobsSeen.add(j); reqs.push({ type: 'job', job: j }); }
  }
  const kiAvailRe = /QUEST_AVAILABLE[^}]*?player:hasKeyItem\s*\(\s*xi\.(?:ki|keyItem)\.(\w+)\s*\)/gs;
  let km: RegExpExecArray | null;
  const kiSeen = new Set<string>();
  while ((km = kiAvailRe.exec(text)) !== null) {
    const ki = _fmtConst(km[1]);
    if (!kiSeen.has(ki)) { kiSeen.add(ki); reqs.push({ type: 'keyItem', name: ki }); }
  }
  const preRe = /hasCompletedQuest\s*\(\s*xi\.questLog\.(\w+)\s*,\s*xi\.quest\.id\.\w+\.(\w+)\s*\)/g;
  let pm: RegExpExecArray | null;
  while ((pm = preRe.exec(checkBlock)) !== null) {
    reqs.push({ type: 'quest', log: pm[1], name: _fmtConst(pm[2]) });
  }
  const misRe = /hasCompletedMission\s*\(\s*xi\.mission\.log_id\.(\w+)\s*,\s*(\d+)\s*\)/g;
  let mm: RegExpExecArray | null;
  while ((mm = misRe.exec(checkBlock)) !== null) {
    reqs.push({ type: 'mission', log: mm[1], id: parseInt(mm[2]) });
  }
  const cvarRe = /getCharVar\s*\(\s*'([^']+)'\s*\)\s*(>=|==|<=|>|<|~=)\s*(\d+)/g;
  const cvarSeen = new Set<string>();
  let cv: RegExpExecArray | null;
  while ((cv = cvarRe.exec(checkBlock)) !== null) {
    const key = `${cv[1]}${cv[2]}${cv[3]}`;
    if (!cvarSeen.has(key)) { cvarSeen.add(key); reqs.push({ type: 'charvar', name: cv[1], op: cv[2], value: parseInt(cv[3]) }); }
  }
  const settingRe = /xi\.settings\.main\.(\w+)\s*(==|~=|>=|>)\s*(\w+)/g;
  const settingSeen = new Set<string>();
  let sv: RegExpExecArray | null;
  while ((sv = settingRe.exec(checkBlock)) !== null) {
    const skey = sv[1];
    if (!settingSeen.has(skey)) {
      settingSeen.add(skey);
      const val: string | number = isNaN(Number(sv[3])) ? sv[3] : parseInt(sv[3]);
      reqs.push({ type: 'setting', name: sv[1], op: sv[2], value: val });
    }
  }
  return reqs;
}

// ── Quest settings ─────────────────────────────────────────────────────────────
export function _loadQuestSettings(): Record<string, unknown> {
  const keys = [
    'ENABLE_TRUST_QUESTS', 'ENABLE_TOAU', 'ENABLE_WOTG', 'ENABLE_COP', 'ENABLE_ABYSSEA',
    'ENABLE_SOA', 'ENABLE_ROV', 'ENABLE_TVR', 'ENABLE_MONSTROSITY', 'ENABLE_CHOCOBO_RAISING',
    'AF1_QUEST_LEVEL', 'AF2_QUEST_LEVEL', 'AF3_QUEST_LEVEL', 'ADVANCED_JOB_LEVEL', 'MAX_LEVEL',
    'OLDSCHOOL_G1', 'OLDSCHOOL_G2', 'ENABLE_MAGIAN_TRIALS',
  ];
  const result: Record<string, unknown> = {};
  const paths = [
    path.join(LSB_SETTINGS_DIR, 'main.lua'),
    path.join(LSB_SETTINGS_DIR, 'default', 'main.lua'),
  ];
  for (const p of paths) {
    let txt = '';
    try { txt = fs.readFileSync(p, 'utf8'); } catch (e) { void e; continue; }
    for (const k of keys) {
      if (result[k] !== undefined) continue;
      const m = txt.match(new RegExp(`\\b${k}\\s*=\\s*([^,\\n]+)`));
      if (m) {
        const raw = m[1].trim().replace(/--.*$/, '').trim();
        if (raw === 'true') result[k] = true;
        else if (raw === 'false') result[k] = false;
        else if (!isNaN(Number(raw))) result[k] = Number(raw);
        else result[k] = raw;
      }
    }
  }
  return result;
}
export const QUEST_SETTINGS = _loadQuestSettings();

// ── Quest rewards ──────────────────────────────────────────────────────────────
export function buildQuestRewards(): Record<number, Record<number, Record<string, unknown>>> {
  const rewards: Record<number, Record<number, Record<string, unknown>>> = {};
  QUEST_LOG_DIRS.forEach((dir, logId) => {
    rewards[logId] = {};
    const dirPath = path.join(LSB_SCRIPTS_DIR, 'quests', dir);
    let files: string[];
    try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.lua')); }
    catch (e) { void e; return; }
    files.forEach(file => {
      let text: string;
      try { text = fs.readFileSync(`${dirPath}/${file}`, 'utf8'); }
      catch (e) { void e; return; }

      let questId: number | null = null;
      const m1 = text.match(/--\s*Log ID:\s*\d+,\s*Quest ID:\s*(\d+)/);
      if (m1) { questId = parseInt(m1[1]); }
      else {
        const m2 = text.match(/--\s*!addquest\s+\d+\s+(\d+)/);
        if (m2) questId = parseInt(m2[1]);
        else {
          const m3 = text.match(/Quest:new\s*\(\s*xi\.questLog\.(\w+)\s*,\s*xi\.quest\.id\.\w+\.(\w+)\s*\)/);
          if (m3) {
            const lid = QUEST_LOG_ENUM[m3[1]];
            if (lid === logId) questId = QUEST_CONST_TO_ID[`${logId}:${m3[2]}`] ?? null;
          }
        }
      }
      if (questId === null) return;

      const npcs: { name: string; x: number; y: number; z: number; zoneId: number | null }[] = [];
      const npcRe = /^--\s+(.+?)\s*:?\s*!pos\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)(?:\s+(\d+))?/gm;
      let nm: RegExpExecArray | null;
      while ((nm = npcRe.exec(text)) !== null) {
        const name = nm[1].trim().replace(/\s+/g, ' ');
        const x = parseFloat(nm[2]), y = parseFloat(nm[3]), z = parseFloat(nm[4]);
        const zoneId = nm[5] ? parseInt(nm[5]) : null;
        npcs.push({ name, x, y, z, zoneId });
      }

      const entry: Record<string, unknown> = npcs.length ? { npcs } : {};

      const rewardMatch = text.match(/quest\.reward\s*=\s*\{([^}]+)\}/s);
      if (rewardMatch) {
        const rt = rewardMatch[1];
        const g  = rt.match(/\bgil\s*=\s*(\d+)/);               if (g)  entry.gil      = parseInt(g[1]);
        const xp = rt.match(/\bexp\s*=\s*(\d+)/);               if (xp) entry.exp      = parseInt(xp[1]);
        const f  = rt.match(/\bfame\s*=\s*(\d+)/);              if (f)  entry.fame     = parseInt(f[1]);
        const fa = rt.match(/\bfameArea\s*=\s*xi\.fameArea\.(\w+)/); if (fa) entry.fameArea = FAME_AREA_BY_NAME[fa[1]] || fa[1].replace(/_/g, ' ');
        const i  = rt.match(/\bitem\s*=\s*xi\.item\.(\w+)/);    if (i)  entry.item     = _fmtConst(i[1]);
        const t  = rt.match(/\btitle\s*=\s*xi\.title\.(\w+)/);  if (t)  entry.title    = _fmtConst(t[1]);
        const k  = rt.match(/\bkeyItem\s*=\s*xi\.ki\.(\w+)/);   if (k)  entry.keyItem  = _fmtConst(k[1]);
        const b  = rt.match(/\bbayld\s*=\s*(\d+)/);             if (b)  entry.bayld    = parseInt(b[1]);
      }

      const tradeItems: { name: string; qty: number }[] = [];
      const tradeSeen = new Set<string>();
      const tradeRe = /tradeHas(?:Exactly)?\s*\(\s*trade\s*,\s*(?:\{\s*\{?\s*)?xi\.item\.(\w+)(?:\s*,\s*(\d+))?/g;
      let tr: RegExpExecArray | null;
      while ((tr = tradeRe.exec(text)) !== null) {
        const name = _fmtConst(tr[1]);
        const qty = tr[2] ? parseInt(tr[2]) : 1;
        const key = `${name}×${qty}`;
        if (!tradeSeen.has(key)) { tradeSeen.add(key); tradeItems.push({ name, qty }); }
      }
      if (tradeItems.length) entry.tradeItems = tradeItems;

      const reqs = _parseRequirements(text);
      if (reqs.length) entry.reqs = reqs;

      if (Object.keys(entry).length) rewards[logId][questId] = entry;
    });
  });
  const total = Object.values(rewards).reduce((s, m) => s + Object.keys(m).length, 0);
  console.log(`[quests] ${total} quest entries loaded`);
  return rewards;
}
export const QUEST_REWARDS = buildQuestRewards();

// ── EXP table ──────────────────────────────────────────────────────────────────
export let EXP_PER_LEVEL: number[] = [];
export async function loadExpTable(pool: Pool): Promise<void> {
  const [rows] = await pool.execute<RowDataPacket[]>('SELECT level, exp FROM exp_base ORDER BY level');
  EXP_PER_LEVEL = [];
  rows.forEach(r => { EXP_PER_LEVEL[r.level as number] = r.exp as number; });
  console.log(`[exp] loaded ${rows.length} level thresholds`);
}

// ── Player allowed actions ─────────────────────────────────────────────────────
export const PLAYER_ALLOWED_ACTIONS = new Set<string>([]);

// ── DB page size ───────────────────────────────────────────────────────────────
export const DB_PAGE = 50;

// ── Scripts root ───────────────────────────────────────────────────────────────
export const SERVER_SCRIPTS_ROOT = process.env.LSB_SERVER_SCRIPTS_DIR || '/ffxi-server-scripts';
