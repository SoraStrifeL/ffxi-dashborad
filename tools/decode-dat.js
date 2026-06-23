'use strict';

// FFXI zone DAT decoder — extracts MZB object-instance positions and bounds.
//
// Reference: galkareeve/ffxi mapViewer (C++), TDWAnalysis.cpp
//
// Usage:
//   node tools/decode-dat.js <zone.dat>
//   node tools/decode-dat.js <zone.dat> --all     # dump every instance
//
// Output: JSON with {file, count, bounds, preview}
// bounds: {minX,maxX,minY,maxY,minZ,maxZ} in FFXI world coords
//   X/Z = horizontal plane, Y = vertical (height)
//
// Chunk header layout (16 bytes, little-endian):
//   byte  0:    chunk type   (0x1C = MZB zone block, 0x2E = MMB model mesh,
//                             0x20 = IMG texture, 0x29 = bone, 0x2A = vertex, 0x2B = anim)
//   bytes 1-3:  3-char ASCII name ("MZB", "MMB", "IMG", ...)
//   bytes 4-7:  uint32 'next' — bits [0..18] = total chunk size in 16-byte units
//                               (advance offset by (next & 0x7FFFF) * 16 to reach next chunk)
//   bytes 8-15: reserved / additional header data
//
// MZB payload layout (starts at byte 16 of an MZB chunk):
//   bytes 0-2:  uint24 LE  total payload length
//   byte  3:    version     (>= 0x1B → payload is encrypted)
//   bytes 4-6:  uint24 LE  node (instance) count
//   byte  7:    key seed    (key_table[seed ^ 0xFF] = initial XOR key)
//   bytes 8-31: SMZBHeader + SMZBHeader2 structs
//   bytes 32+:  SMZBBlock100[node_count] — one per object instance:
//     +0  char[16]  id (each byte XOR'd with 0x55 during node-ID decryption step)
//     +16 float32   transX
//     +20 float32   transY
//     +24 float32   transZ
//     +28 float32   rotX
//     +32 float32   rotY
//     +36 float32   rotZ
//     +40 float32   scaleX
//     +44 float32   scaleY
//     +48 float32   scaleZ
//     +52 float32[8] bounding / extra floats (fa-fh)
//     +84 float32[4] extra floats (fi-fl)
//     = 100 bytes total

const fs   = require('fs');
const path = require('path');

// ── Decryption tables (TDWAnalysis.cpp) ──────────────────────────────────────

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

// ── Constants ─────────────────────────────────────────────────────────────────

const CHUNK_MZB        = 0x1C;
const CHUNK_HDR_SIZE   = 16;    // skBinaryChunkSize
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

// ── MZB instance parser ───────────────────────────────────────────────────────

function parseMzbInstances(buf) {
  const nodeCount = buf[4] | (buf[5] << 8) | (buf[6] << 16);
  const instances = [];
  let off = MZB_INSTANCES_AT;

  for (let i = 0; i < nodeCount && off + MZB_BLOCK_SIZE <= buf.length; i++, off += MZB_BLOCK_SIZE) {
    const id = buf.slice(off, off + 16).toString('latin1').replace(/\0/g, '').trim();
    const x  = buf.readFloatLE(off + 16);
    const y  = buf.readFloatLE(off + 20);
    const z  = buf.readFloatLE(off + 24);
    if (isFinite(x) && isFinite(y) && isFinite(z)) instances.push({ id, x, y, z });
  }

  return instances;
}

// ── DAT chunk walker ──────────────────────────────────────────────────────────

function decodeDat(filePath) {
  const dat  = fs.readFileSync(filePath);
  const instances = [];
  let offset = 0;

  while (offset + CHUNK_HDR_SIZE <= dat.length) {
    const type       = dat[offset];
    const next       = dat.readUInt32LE(offset + 4);
    const totalBytes = (next & 0x7FFFF) * 16; // total chunk size incl. header

    if (totalBytes === 0) break;
    if (offset + totalBytes > dat.length) break;

    if (type === CHUNK_MZB) {
      const payload = Buffer.from(dat.slice(offset + CHUNK_HDR_SIZE, offset + totalBytes));
      decryptMzb(payload);
      instances.push(...parseMzbInstances(payload));
    }

    offset += totalBytes;
  }

  return instances;
}

// ── Bounds helper ─────────────────────────────────────────────────────────────

function computeBounds(instances) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const { x, y, z } of instances) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  return minX === Infinity ? null : { minX, maxX, minY, maxY, minZ, maxZ };
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

  const instances = decodeDat(datFile);
  const bounds    = computeBounds(instances);

  console.log(JSON.stringify({
    file:    path.basename(datFile),
    count:   instances.length,
    bounds,
    preview: dumpAll ? instances : instances.slice(0, 20),
  }, null, 2));
}

module.exports = { decodeDat, computeBounds };
