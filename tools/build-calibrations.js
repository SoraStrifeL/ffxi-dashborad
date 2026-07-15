'use strict';

// Generate data/calibrations.json map calibrations from FFXI client zone DATs.
//
// For every zone listed in public/maps.json, locates the zone geometry DAT in
// a retail FFXI client install, decodes its MZB object placements + MMB model
// bounding boxes (tools/decode-dat.js), and writes the world-coordinate extent
// as the zone's map calibration {minX, maxX, minZ, maxZ}.
//
// Zone id → DAT resource id:
//   zone <  256 → id = zone + 100
//   zone >= 256 → id = zone + 83635
// Resource id → ROM path via FTABLE/VTABLE (per-volume tables; later ROM
// volumes override earlier ones, matching the client's patch semantics).
//
// Usage:
//   node tools/build-calibrations.js <ffxi-client-dir> [--dry-run] [--force]
//     [--api http://localhost:3001 --login <user> --pass <password>]
//
// Generated entries are tagged {src:"dat"} so live Windower autocal samples
// (src-less, exact) may upgrade them later. Existing entries WITHOUT the
// src:"dat" tag (hand-made or Windower-autocal — more exact than geometry)
// are preserved unless --force is given.
//
// With --api credentials, NPC/mob positions are fetched per zone and used as
// a cross-check: when the geometry box is vastly larger than the robust
// entity extent (city districts like the Jeuno zones share one whole-city
// model across their DATs), the padded entity box is used instead.
//
// If FFXiMain.dll is present alongside FTABLE.DAT (the retail exe ships next
// to it), its embedded per-zone ZoneMapRecord table (tools/zone-map-record.js
// — retail's own automap framing data, size+offset per zone/floor) is used
// as a fallback when DAT geometry can't be decoded at all, and logged as a
// cross-check note when geometry disagrees with it by >1.5x area — spot
// checks showed the DLL box is directionally correct but sometimes ~2x off
// for small zones, so it does not override working geometry-derived boxes.

const fs   = require('fs');
const path = require('path');
const { decodeDat, computeBounds } = require('./decode-dat.js');
const { loadZoneMapTable, recordToBox } = require('./zone-map-record.js');

const args    = process.argv.slice(2);
const baseDir = args.find(a => !a.startsWith('--'));
const dryRun  = args.includes('--dry-run');
const force   = args.includes('--force');
const argOf   = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const apiUrl  = argOf('--api');
const apiUser = argOf('--login');
const apiPass = argOf('--pass');

if (!baseDir || !fs.existsSync(path.join(baseDir, 'FTABLE.DAT'))) {
  console.error('Usage: node tools/build-calibrations.js <ffxi-client-dir> [--dry-run] [--force]');
  console.error('       <ffxi-client-dir> must contain FTABLE.DAT/VTABLE.DAT and ROM*/');
  process.exit(1);
}

// ── resource id → file path across all ROM volumes ──────────────────────────

const vols = [{
  ft: path.join(baseDir, 'FTABLE.DAT'),
  vt: path.join(baseDir, 'VTABLE.DAT'),
  dir: path.join(baseDir, 'ROM'),
}];
for (let n = 2; n <= 9; n++) {
  const ft = path.join(baseDir, `ROM${n}`, `FTABLE${n}.DAT`);
  const vt = path.join(baseDir, `ROM${n}`, `VTABLE${n}.DAT`);
  if (fs.existsSync(ft) && fs.existsSync(vt)) vols.push({ ft, vt, dir: path.join(baseDir, `ROM${n}`) });
}
for (const v of vols) { v.ftab = fs.readFileSync(v.ft); v.vtab = fs.readFileSync(v.vt); }

function resolveDat(id) {
  let hit = null;
  for (const v of vols) {
    if (id >= v.vtab.length || v.vtab[id] === 0) continue;
    const e = v.ftab.readUInt16LE(id * 2);
    hit = path.join(v.dir, String(e >> 7), (e & 0x7F) + '.DAT');
  }
  return hit;
}

const datIdForZone = z => z < 256 ? z + 100 : z + 83635;

// ── FFXiMain.dll ZoneMapRecord table (optional; fallback + cross-check) ─────

let dllZoneMap = new Map();
const dllPath = path.join(baseDir, 'FFXiMain.dll');
if (fs.existsSync(dllPath)) {
  try {
    dllZoneMap = loadZoneMapTable(dllPath);
    console.log(`loaded ${dllZoneMap.size} ZoneMapRecord entries from ${dllPath}`);
  } catch (e) {
    console.error(`could not parse ${dllPath}: ${e.message}`);
  }
} else {
  console.log(`no FFXiMain.dll found at ${dllPath} — DLL fallback/cross-check disabled`);
}

// ── entity extents (optional cross-check via dashboard API) ─────────────────

async function apiLogin() {
  const res = await fetch(`${apiUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: apiUser, password: apiPass }),
  });
  const j = await res.json();
  if (!j.token) throw new Error('API login failed');
  return j.token;
}

// Robust bounding box of npc+mob positions: median-centred MAD trim throws
// out event-NPC clones parked at other cities' coordinates.
function robustBox(pts) {
  if (pts.length < 8) return null;
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const cx = med(pts.map(p => p.x)), cz = med(pts.map(p => p.z));
  const dists = pts.map(p => Math.max(Math.abs(p.x - cx), Math.abs(p.z - cz)));
  const mad = med(dists);
  const lim = Math.max(6 * mad, 80);
  const kept = pts.filter((p, i) => dists[i] <= lim);
  if (kept.length < 6) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of kept) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ, n: kept.length, kept };
}

async function fetchEntityBox(zone, token) {
  const pts = [];
  let mobCount = 0;
  for (const kind of ['npcs', 'mobs']) {
    try {
      const res = await fetch(`${apiUrl}/api/${kind}/${zone}`, { headers: { Authorization: `Bearer ${token}` } });
      const list = await res.json();
      if (Array.isArray(list)) {
        for (const p of list) {
          const x = Number(p.pos_x), z = Number(p.pos_z);
          if (Number.isFinite(x) && Number.isFinite(z) && (x !== 0 || z !== 0) && Math.abs(x) < 2000 && Math.abs(z) < 2000) {
            pts.push({ x, z });
            if (kind === 'mobs') mobCount++;
          }
        }
      }
    } catch (_) { /* endpoint variations / empty zones are fine */ }
  }
  const box = robustBox(pts);
  return box ? { ...box, mobCount } : null;
}

// ── generate ─────────────────────────────────────────────────────────────────

const root    = path.join(__dirname, '..');
const maps    = JSON.parse(fs.readFileSync(path.join(root, 'public', 'maps.json'), 'utf8'));
const calFile = path.join(root, 'data', 'calibrations.json');
const cals    = fs.existsSync(calFile) ? JSON.parse(fs.readFileSync(calFile, 'utf8')) : {};

const r1 = v => Math.round(v * 10) / 10;
const area = b => Math.max(1e-6, (b.maxX - b.minX) * (b.maxZ - b.minZ));

(async () => {
  const token = apiUrl ? await apiLogin() : null;
  let written = 0, kept = 0, failed = 0, entityFallback = 0, dllFallback = 0;

  for (const zoneStr of Object.keys(maps).sort((a, b) => +a - +b)) {
    const zone = +zoneStr;
    const name = maps[zoneStr].name;
    const existing = cals[zoneStr];
    if (existing && existing.src !== 'dat' && !force) { kept++; continue; }

    const dllBox = recordToBox(dllZoneMap.get(zone));

    const datPath = resolveDat(datIdForZone(zone));
    let bounds = null;
    if (datPath && fs.existsSync(datPath)) {
      try { bounds = computeBounds(decodeDat(datPath)); } catch (e) { bounds = null; }
    }
    const geometryOk = bounds && bounds.maxX - bounds.minX >= 10 && bounds.maxZ - bounds.minZ >= 10;

    let box, baseline, note;
    if (geometryOk) {
      box = baseline = bounds;
      note = `geometry, ${bounds.matched}/${bounds.total} instances`;
    } else if (dllBox) {
      box = baseline = dllBox;
      note = 'FFXiMain.dll ZoneMapRecord fallback (no usable geometry)';
      dllFallback++;
    } else {
      console.error(`  ${zone} ${name}: no usable geometry in ${datPath || `id ${datIdForZone(zone)}`} and no ZoneMapRecord`);
      failed++;
      continue;
    }

    if (token) {
      const ent = await fetchEntityBox(zone, token);
      // Geometry >> entity extent means the DAT holds more than this zone's
      // own map area (shared city model) — trust the entities instead.
      // Mob-rich (outdoor/dungeon) zones legitimately have unwalkable
      // geometry beyond spawn coverage, so they need a wider margin before
      // geometry is declared oversized; mob-less city districts are lined
      // wall-to-wall with NPCs, so 2x linear is already suspicious there.
      const ratio = ent && ent.mobCount >= 30 ? 9 : 4;
      // Coverage: trimmed entities sitting outside geometry mean the DAT's
      // extent doesn't describe this zone's map (e.g. Altar Room) — geometry
      // that misses real entities is worse than the entity box.
      const covered = ent
        ? ent.kept.filter(p => p.x >= baseline.minX - 10 && p.x <= baseline.maxX + 10 &&
                               p.z >= baseline.minZ - 10 && p.z <= baseline.maxZ + 10).length / ent.kept.length
        : 1;
      if (ent && (area(baseline) > ratio * area(ent) || covered < 0.9)) {
        const padX = (ent.maxX - ent.minX) * 0.10, padZ = (ent.maxZ - ent.minZ) * 0.10;
        box = { minX: ent.minX - padX, maxX: ent.maxX + padX, minZ: ent.minZ - padZ, maxZ: ent.maxZ + padZ };
        note = `entity fallback (${ent.n} pts; ` +
          (covered < 0.9 ? `geometry covers only ${(covered * 100).toFixed(0)}% of entities` :
            `geometry ${Math.sqrt(area(baseline) / area(ent)).toFixed(1)}x oversized`) + ')';
        entityFallback++;
      }
    }

    // Cross-check only — does not override a working geometry-derived box.
    // Spot checks (2026-07-15) showed the DLL box is directionally correct
    // (right units/sign/center) but sometimes ~2x off for small zones, so it
    // is logged for visibility rather than auto-applied when geometry works.
    if (geometryOk && dllBox) {
      const ratioDll = area(bounds) > area(dllBox) ? area(bounds) / area(dllBox) : area(dllBox) / area(bounds);
      if (ratioDll > 1.5) {
        console.log(`    [dll-xcheck] ${zone} ${name}: geometry/DLL area ratio ${ratioDll.toFixed(1)}x` +
          ` — DLL X[${r1(dllBox.minX)}, ${r1(dllBox.maxX)}] Z[${r1(dllBox.minZ)}, ${r1(dllBox.maxZ)}]`);
      }
    }

    cals[zoneStr] = { minX: r1(box.minX), maxX: r1(box.maxX), minZ: r1(box.minZ), maxZ: r1(box.maxZ), src: 'dat' };
    written++;
    console.log(`  ${zone} ${name}: X[${cals[zoneStr].minX}, ${cals[zoneStr].maxX}] Z[${cals[zoneStr].minZ}, ${cals[zoneStr].maxZ}] (${note})`);
  }

  console.log(`\ngenerated: ${written} (${entityFallback} entity-fallback, ${dllFallback} dll-fallback)  kept existing: ${kept}  failed: ${failed}  total in file: ${Object.keys(cals).length}`);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(calFile), { recursive: true });
    fs.writeFileSync(calFile, JSON.stringify(cals, null, 2) + '\n');
    console.log(`wrote ${calFile}`);
  } else {
    console.log('(dry run — nothing written)');
  }
})().catch(e => { console.error(e); process.exit(1); });
