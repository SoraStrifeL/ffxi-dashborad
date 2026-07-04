'use strict';

// FFXI zone DAT decoder — extracts zone geometry bounds from MZB placements
// combined with MMB model bounding boxes.
//
// Reference: galkareeve/ffxi mapViewer (C++), FFXILandscapeMesh.cpp
//
// Usage:
//   node tools/decode-dat.js <zone.dat>
//   node tools/decode-dat.js <zone.dat> --all     # dump every instance
//
// Output: JSON with {file, count, bounds, preview}
// bounds: {minX,maxX,minY,maxY,minZ,maxZ} in FFXI world coords
//   X/Z = horizontal plane, Y = vertical (height)
//
// Chunk header layout (16 bytes, little-endian) — verified against retail DATs:
//   bytes 0-3:  char[4] resource name (e.g. "t_sa", "door" — NOT a type byte)
//   bytes 4-7:  uint32 packed:
//                 bits [0..6]   chunk type (0x1C = MZB zone block, 0x2E = MMB model mesh)
//                 bits [7..25]  total chunk size in 16-byte units, incl. this header
//   bytes 8-15: reserved (zero)
//
// MZB payload layout (starts at byte 16 of an MZB chunk):
//   bytes 0-2:  uint24 LE  total payload length
//   byte  3:    version     (>= 0x1B → payload is encrypted)
//   bytes 4-6:  uint24 LE  node (instance) count
//   byte  7:    key seed    (key_table[seed ^ 0xFF] = initial XOR key)
//   bytes 8-31: SMZBHeader remainder
//   bytes 32+:  SMZBBlock100[node_count] — one per object instance:
//     +0  char[16]  id (each byte XOR'd with 0x55 during node-ID decryption step)
//     +16 float32   transX     +28 float32 rotX      +40 float32 scaleX
//     +20 float32   transY     +32 float32 rotY      +44 float32 scaleY
//     +24 float32   transZ     +36 float32 rotZ      +48 float32 scaleZ
//     +52 float32[4] fa-fd (LOD distances: 0, 10, 100, 1000)
//     +68 int32[8]  fe-fl
//     = 100 bytes total
//
// MMB payload layout (starts at byte 16 of an MMB chunk):
//   bytes 0-15: SMMBHEAD — bytes 0-2 uint24 length, byte 3 version (>= 5 →
//               encrypted), byte 5 key seed (key_table[seed ^ 0xF0]),
//               bytes 6-7 == FF FF → additional block-swap scrambling
//   bytes 16+:  SMMBHeader:
//     +0  char[16] imgID (matched against SMZBBlock100.id)
//     +16 int32    pieces
//     +20 float32[6] x1,x2,y1,y2,z1,z2 — model-local AABB (min,max per axis)
//     +44 uint32   offsetBlockHeader

const fs   = require('fs');
const path = require('path');

// ── Decryption tables (FFXILandscapeMesh.cpp) ────────────────────────────────

const KEY_TABLE = Buffer.from([
  0xE2,0xE5,0x06,0xA9,0xED,0x26,0xF4,0x42,0x15,0xF4,0x81,0x7F,0xDE,0x9A,0xDE,0xD0,
  0x1A,0x98,0x20,0x91,0x39,0x49,0x48,0xA4,0x0A,0x9F,0x40,0x69,0xEC,0xBD,0x81,0x81,
  0x8D,0xAD,0x10,0xB8,0xC1,0x88,0x15,0x05,0x11,0xB1,0xAA,0xF0,0x0F,0x1E,0x34,0xE6,
  0x81,0xAA,0xCD,0xAC,0x02,0x84,0x33,0x0A,0x19,0x38,0x9E,0xE6,0x73,0x4A,0x11,0x5D,
  0xBF,0x85,0x77,0x08,0xCD,0xD9,0x96,0x0D,0x79,0x78,0xCC,0x35,0x06,0x8E,0xF9,0xFE,
  0x66,0xB9,0x21,0x03,0x20,0x29,0x1E,0x27,0xCA,0x86,0x82,0xE6,0x45,0x07,0xDD,0xA9,
  0xB6,0xD5,0xA2,0x03,0xEC,0xAD,0x62,0x45,0x2D,0xCE,0x79,0xBD,0x8F,0x2D,0x10,0x18,
  0xE6,0x0A,0x6F,0xAA,0x6F,0x46,0x84,0x32,0x9F,0x29,0x2C,0xC2,0xF0,0xEB,0x18,0x6F,
  0xF2,0x3A,0xDC,0xEA,0x7B,0x0C,0x81,0x2D,0xCC,0xEB,0xA1,0x51,0x77,0x2C,0xFB,0x49,
  0xE8,0x90,0xF7,0x90,0xCE,0x5C,0x01,0xF3,0x5C,0xF4,0x41,0xAB,0x04,0xE7,0x16,0xCC,
  0x3A,0x05,0x54,0x55,0xDC,0xED,0xA4,0xD6,0xBF,0x3F,0x9E,0x08,0x93,0xB5,0x63,0x38,
  0x90,0xF7,0x5A,0xF0,0xA2,0x5F,0x56,0xC8,0x08,0x70,0xCB,0x24,0x16,0xDD,0xD2,0x74,
  0x95,0x3A,0x1A,0x2A,0x74,0xC4,0x9D,0xEB,0xAF,0x69,0xAA,0x51,0x39,0x65,0x94,0xA2,
  0x4B,0x1F,0x1A,0x60,0x52,0x39,0xE8,0x23,0xEE,0x58,0x39,0x06,0x3D,0x22,0x6A,0x2D,
  0xD2,0x91,0x25,0xA5,0x2E,0x71,0x62,0xA5,0x0B,0xC1,0xE5,0x6E,0x43,0x49,0x7C,0x58,
  0x46,0x19,0x9F,0x45,0x49,0xC6,0x40,0x09,0xA2,0x99,0x5B,0x7B,0x98,0x7F,0xA0,0xD0,
]);

const KEY_TABLE2 = Buffer.from([
  0xB8,0xC5,0xF7,0x84,0xE4,0x5A,0x23,0x7B,0xC8,0x90,0x1D,0xF6,0x5D,0x09,0x51,0xC1,
  0x07,0x24,0xEF,0x5B,0x1D,0x73,0x90,0x08,0xA5,0x70,0x1C,0x22,0x5F,0x6B,0xEB,0xB0,
  0x06,0xC7,0x2A,0x3A,0xD2,0x66,0x81,0xDB,0x41,0x62,0xF2,0x97,0x17,0xFE,0x05,0xEF,
  0xA3,0xDC,0x22,0xB3,0x45,0x70,0x3E,0x18,0x2D,0xB4,0xBA,0x0A,0x65,0x1D,0x87,0xC3,
  0x12,0xCE,0x8F,0x9D,0xF7,0x0D,0x50,0x24,0x3A,0xF3,0xCA,0x70,0x6B,0x67,0x9C,0xB2,
  0xC2,0x4D,0x6A,0x0C,0xA8,0xFA,0x81,0xA6,0x79,0xEB,0xBE,0xFE,0x89,0xB7,0xAC,0x7F,
  0x65,0x43,0xEC,0x56,0x5B,0x35,0xDA,0x81,0x3C,0xAB,0x6D,0x28,0x60,0x2C,0x5F,0x31,
  0xEB,0xDF,0x8E,0x0F,0x4F,0xFA,0xA3,0xDA,0x12,0x7E,0xF1,0xA5,0xD2,0x22,0xA0,0x0C,
  0x86,0x8C,0x0A,0x0C,0x06,0xC7,0x65,0x18,0xCE,0xF2,0xA3,0x68,0xFE,0x35,0x96,0x95,
  0xA6,0xFA,0x58,0x63,0x41,0x59,0xEA,0xDD,0x7F,0xD3,0x1B,0xA8,0x48,0x44,0xAB,0x91,
  0xFD,0x13,0xB1,0x68,0x01,0xAC,0x3A,0x11,0x78,0x30,0x33,0xD8,0x4E,0x6A,0x89,0x05,
  0x7B,0x06,0x8E,0xB0,0x86,0xFD,0x9F,0xD7,0x48,0x54,0x04,0xAE,0xF3,0x06,0x17,0x36,
  0x53,0x3F,0xA8,0x11,0x53,0xCA,0xA1,0x95,0xC2,0xCD,0xE6,0x1F,0x57,0xB4,0x7F,0xAA,
  0xF3,0x6B,0xF9,0xA0,0x27,0xD0,0x09,0xEF,0xF6,0x68,0x73,0x60,0xDC,0x50,0x2A,0x25,
  0x0F,0x77,0xB9,0xB0,0x04,0x0B,0xE1,0xCC,0x35,0x31,0x84,0xE6,0x22,0xF9,0xC2,0xAB,
  0x95,0x91,0x61,0xD9,0x2B,0xB9,0x72,0x4E,0x10,0x76,0x31,0x66,0x0A,0x0B,0x2E,0x83,
]);

// ── Constants ─────────────────────────────────────────────────────────────────

const CHUNK_MZB        = 0x1C;
const CHUNK_MMB        = 0x2E;
const CHUNK_HDR_SIZE   = 16;
const MZB_INSTANCES_AT = 32;    // SMZBBlock100 array offset within MZB payload
const MZB_BLOCK_SIZE   = 100;   // sizeof(SMZBBlock100)

// ── MZB decryption (decode_mzb equivalent) ───────────────────────────────────

function decryptMzb(buf) {
  if (buf[3] < 0x1B) return; // version < 0x1B → not encrypted

  const decodeLen = buf[0] | (buf[1] << 8) | (buf[2] << 16);
  if (decodeLen > buf.length) return;

  // Block XOR pass
  let key        = KEY_TABLE[buf[7] ^ 0xFF];
  let keyCounter = 0;
  let pos        = 8;
  while (pos < decodeLen) {
    const xorLen = ((key >>> 4) & 7) + 16;
    if ((key & 1) && pos + xorLen < decodeLen) {
      for (let i = 0; i < xorLen; i++) buf[pos + i] ^= 0xFF;
    }
    key = (key + (++keyCounter)) >>> 0;
    pos += xorLen;
  }

  // Node-ID XOR pass (each id byte ^ 0x55)
  const nodeCount = buf[4] | (buf[5] << 8) | (buf[6] << 16);
  let off = MZB_INSTANCES_AT;
  for (let i = 0; i < nodeCount && off + MZB_BLOCK_SIZE <= buf.length; i++, off += MZB_BLOCK_SIZE) {
    for (let j = 0; j < 16; j++) buf[off + j] ^= 0x55;
  }
}

// ── MMB decryption (decode_mmb + decode_mmb2 equivalents) ────────────────────

function decryptMmb(buf) {
  if (buf[3] >= 5) {
    const decodeLen = buf[0] | (buf[1] << 8) | (buf[2] << 16);
    let key        = KEY_TABLE[buf[5] ^ 0xF0];
    let keyCounter = 0;
    for (let pos = 8; pos < decodeLen && pos < buf.length; pos++) {
      const x = ((key & 0xFF) << 8) | (key & 0xFF);
      key = (key + (++keyCounter)) >>> 0;
      buf[pos] ^= (x >>> (key & 7)) & 0xFF;
      key = (key + (++keyCounter)) >>> 0;
    }
  }
  // Second stage: swap 8-byte pairs between the two halves of the payload
  if (buf[6] === 0xFF && buf[7] === 0xFF) {
    const decodeLen   = buf[0] | (buf[1] << 8) | (buf[2] << 16);
    let key1          = (buf[5] ^ 0xF0) & 0xFF;
    let key2          = KEY_TABLE2[key1];
    const decodeCount = ((decodeLen - 8) & ~0xF) / 2;
    let o1 = 8, o2 = 8 + decodeCount;
    for (let pos = 0; pos < decodeCount && o2 + 8 <= buf.length; pos += 8) {
      if (key2 & 1) {
        for (let i = 0; i < 8; i++) {
          const t = buf[o1 + i]; buf[o1 + i] = buf[o2 + i]; buf[o2 + i] = t;
        }
      }
      key1 = (key1 + 9)    & 0xFF;
      key2 = (key2 + key1) & 0xFF;
      o1 += 8; o2 += 8;
    }
  }
}

// ── MZB instance parser ───────────────────────────────────────────────────────

function parseMzbInstances(buf) {
  const nodeCount = buf[4] | (buf[5] << 8) | (buf[6] << 16);
  const instances = [];
  let off = MZB_INSTANCES_AT;

  for (let i = 0; i < nodeCount && off + MZB_BLOCK_SIZE <= buf.length; i++, off += MZB_BLOCK_SIZE) {
    const id = buf.slice(off, off + 16).toString('latin1').replace(/\0/g, '').trim();
    const inst = {
      id,
      x:  buf.readFloatLE(off + 16),
      y:  buf.readFloatLE(off + 20),
      z:  buf.readFloatLE(off + 24),
      rx: buf.readFloatLE(off + 28),
      ry: buf.readFloatLE(off + 32),
      rz: buf.readFloatLE(off + 36),
      sx: buf.readFloatLE(off + 40),
      sy: buf.readFloatLE(off + 44),
      sz: buf.readFloatLE(off + 48),
    };
    if (isFinite(inst.x) && isFinite(inst.y) && isFinite(inst.z)) instances.push(inst);
  }

  return instances;
}

// ── MMB header parser (model-local AABB) ─────────────────────────────────────

function parseMmbHeader(buf) {
  if (buf.length < 64) return null;
  const id = buf.slice(16, 32).toString('latin1').replace(/\0/g, '').trim();
  const bbox = {
    minX: buf.readFloatLE(36), maxX: buf.readFloatLE(40),
    minY: buf.readFloatLE(44), maxY: buf.readFloatLE(48),
    minZ: buf.readFloatLE(52), maxZ: buf.readFloatLE(56),
  };
  const vals = Object.values(bbox);
  if (!id || vals.some(v => !isFinite(v) || Math.abs(v) > 1e5)) return null;
  if (bbox.minX > bbox.maxX || bbox.minY > bbox.maxY || bbox.minZ > bbox.maxZ) return null;
  return { id, bbox };
}

// ── DAT chunk walker ──────────────────────────────────────────────────────────

function decodeDat(filePath) {
  const dat = fs.readFileSync(filePath);
  const instances = [];
  const models    = new Map(); // imgID -> local AABB
  let offset = 0;

  while (offset + CHUNK_HDR_SIZE <= dat.length) {
    const packed     = dat.readUInt32LE(offset + 4);
    const type       = packed & 0x7F;
    const totalBytes = ((packed >>> 7) & 0x7FFFF) * 16; // total chunk size incl. header

    if (totalBytes < CHUNK_HDR_SIZE) break;
    if (offset + totalBytes > dat.length) break;

    if (type === CHUNK_MZB) {
      const payload = Buffer.from(dat.slice(offset + CHUNK_HDR_SIZE, offset + totalBytes));
      decryptMzb(payload);
      instances.push(...parseMzbInstances(payload));
    } else if (type === CHUNK_MMB) {
      const payload = Buffer.from(dat.slice(offset + CHUNK_HDR_SIZE, offset + totalBytes));
      decryptMmb(payload);
      const m = parseMmbHeader(payload);
      if (m && !models.has(m.id)) models.set(m.id, m.bbox);
    }

    offset += totalBytes;
  }

  return { instances, models };
}

// ── Bounds ────────────────────────────────────────────────────────────────────

// World-space AABB of one instance: model-local AABB corners scaled, rotated
// (x→y→z order, per mapViewer getMZB100Matrix), then translated.
function instanceWorldCorners(inst, bbox) {
  const cx = Math.cos(inst.rx), sx = Math.sin(inst.rx);
  const cy = Math.cos(inst.ry), sy = Math.sin(inst.ry);
  const cz = Math.cos(inst.rz), sz = Math.sin(inst.rz);
  // column-major rotation matrix from getMZB100Matrix
  const m = [
    cy * cz,                cy * sz,               -sy,      // col1 (applied to x)
    cz * sx * sy - cx * sz, cx * cz + sx * sy * sz, cy * sx, // col2 (applied to y)
    cx * cz * sy + sx * sz, -cz * sx + cx * sy * sz, cx * cy, // col3 (applied to z)
  ];
  const out = [];
  for (const px of [bbox.minX, bbox.maxX]) {
    for (const py of [bbox.minY, bbox.maxY]) {
      for (const pz of [bbox.minZ, bbox.maxZ]) {
        const x = px * inst.sx, y = py * inst.sy, z = pz * inst.sz;
        out.push({
          x: m[0] * x + m[3] * y + m[6] * z + inst.x,
          y: m[1] * x + m[4] * y + m[7] * z + inst.y,
          z: m[2] * x + m[5] * y + m[8] * z + inst.z,
        });
      }
    }
  }
  return out;
}

// FFXI world coords stay within roughly ±1500; anything past this is a
// corrupt/degenerate instance (e.g. skybox or bugged placement) — ignore it.
const WORLD_LIMIT = 2500;

function computeBounds({ instances, models }) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  let matched = 0;

  const add = (x, y, z) => {
    if (Math.abs(x) > WORLD_LIMIT || Math.abs(y) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  };

  for (const inst of instances) {
    const bbox = models.get(inst.id);
    if (bbox) {
      matched++;
      for (const c of instanceWorldCorners(inst, bbox)) add(c.x, c.y, c.z);
    } else {
      add(inst.x, inst.y, inst.z); // no mesh: at least count the anchor point
    }
  }

  if (minX === Infinity) return null;
  return { minX, maxX, minY, maxY, minZ, maxZ, matched, total: instances.length };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args    = process.argv.slice(2);
  const datFile = args.find(a => !a.startsWith('--'));
  const dumpAll = args.includes('--all');

  if (!datFile) {
    console.error('Usage: node tools/decode-dat.js <zone.dat> [--all]');
    process.exit(1);
  }

  const decoded = decodeDat(datFile);
  const bounds  = computeBounds(decoded);

  console.log(JSON.stringify({
    file:    path.basename(datFile),
    count:   decoded.instances.length,
    models:  decoded.models.size,
    bounds,
    preview: dumpAll ? decoded.instances : decoded.instances.slice(0, 5),
  }, null, 2));
}

module.exports = { decodeDat, computeBounds };
