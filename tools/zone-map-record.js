'use strict';

// Parses ZoneMapRecord entries out of FFXiMain.dll — the same per-zone
// automap size/offset table retail's own client uses to frame its minimap.
// Constants/record layout ported 1:1 from the open-source jondwillis/kuluu-ffxi
// client (ffxi-dat/src/main_dll.rs + ffxi-viewer-core/src/minimap/retail.rs),
// which already reverse-engineered this table; not rediscovered here.

const fs = require('fs');

const SCAN_START = 0x30000;
const SCAN_WORDS = 0xC000;
const ZONE_MAP_HINT = 0x6400000100010100n;
const ZONE_MAP_STRIDE = 0x0E;
const ZONE_MAP_NEXT_DIVISOR = 0x13;
const ZONE_MAP_SIZE_NUMERATOR = 2560;
const MENUMAP_TEX = 512;

function findZoneMapBase(buf) {
  let pos = SCAN_START;
  for (let i = 0; i < SCAN_WORDS; i++) {
    if (pos + 8 > buf.length) return null;
    if (buf.readBigUInt64BE(pos) === ZONE_MAP_HINT) return pos;
    pos += 4;
  }
  return null;
}

function decodeRecord(buf, base) {
  if (base + ZONE_MAP_STRIDE > buf.length) return null;
  const zoneId    = buf.readUInt16LE(base);
  const subZoneId = buf.readUInt8(base + 2);
  const divisor   = buf.readUInt8(base + 5);
  const xOffset   = buf.readInt16LE(base + 10);
  const yOffset   = buf.readInt16LE(base + 12);
  return { zoneId, subZoneId, divisor, xOffset, yOffset, size: divisor ? ZONE_MAP_SIZE_NUMERATOR / divisor : null };
}

// Returns Map<zoneId, record> — one entry per zone, preferring sub_zone_id 0
// (the base floor) to match this repo's single-AABB-per-zone calibration
// model; keeps the first record seen for a zone with no sub_zone_id 0 row.
function loadZoneMapTable(dllPath) {
  const table = new Map();
  const buf = fs.readFileSync(dllPath);
  const base = findZoneMapBase(buf);
  if (base == null) return table;

  let cur = base;
  while (true) {
    const rec = decodeRecord(buf, cur);
    if (!rec) break;
    const existing = table.get(rec.zoneId);
    if (!existing || (existing.subZoneId !== 0 && rec.subZoneId === 0)) table.set(rec.zoneId, rec);

    const nextDivisorPos = cur + ZONE_MAP_NEXT_DIVISOR;
    if (nextDivisorPos >= buf.length || buf[nextDivisorPos] === 0) break;
    cur += ZONE_MAP_STRIDE;
  }
  return table;
}

// Converts a ZoneMapRecord into this repo's {minX, maxX, minZ, maxZ}
// convention. Ported from Kuluu's zone_map_to_aabb; retail's map "vertical"
// axis is north/south, matching this repo's world Z.
function recordToBox(rec) {
  if (!rec || !rec.divisor || !rec.size) return null;
  const size = rec.size;
  const minX = -size * (0.5 - rec.xOffset) / MENUMAP_TEX;
  const minZ = size * (0.5 + rec.yOffset) / MENUMAP_TEX;
  return { minX, maxX: minX + size, minZ, maxZ: minZ + size };
}

module.exports = { loadZoneMapTable, recordToBox };
