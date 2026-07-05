// ════════════════════════════════════════════════════════════════════
//  icon.ts — extract an item's embedded icon into a transparent PNG
//  ────────────────────────────────────────────────────────────────────
//  Item records carry a headerless 8-bit BMP DIB (BITMAPINFOHEADER +
//  256-entry BGRA palette + bottom-up indexed pixels) in the icon region
//  after 0x280. We reconstruct it into a 32-bit RGBA PNG, using the
//  palette's alpha byte (0–128, scaled to 0–255) for transparency.
// ════════════════════════════════════════════════════════════════════
import zlib from 'zlib';

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xFFFFFFFF;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, colour type 6 (RGBA)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Locate a headerless DIB (biSize = 40) in [from, to) and convert it to a
 * RGBA PNG. Handles the two encodings FFXI uses: 8-bit indexed with a
 * 256-entry BGRA palette (item icons) and raw 32-bit BGRA (status icons).
 */
export function extractDib(rec: Buffer, from: number, to: number): Buffer | null {
  let o = -1, bpp = 0;
  for (let p = from; p < to && p + 16 <= rec.length; p++) {
    if (rec.readUInt32LE(p) === 40) {
      const w = rec.readInt32LE(p + 4), h = rec.readInt32LE(p + 8), b = rec.readUInt16LE(p + 14);
      if (w > 0 && w <= 256 && Math.abs(h) <= 256 && (b === 8 || b === 32)) { o = p; bpp = b; break; }
    }
  }
  if (o < 0) return null;
  const w = rec.readInt32LE(o + 4);
  const h = Math.abs(rec.readInt32LE(o + 8));
  const palOff = o + 40;
  const pixOff = bpp === 8 ? palOff + 256 * 4 : palOff;
  const rowSize = Math.floor((w * bpp + 31) / 32) * 4; // BMP rows padded to 4 bytes
  if (pixOff + rowSize * h > rec.length) return null;

  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const row = pixOff + (h - 1 - y) * rowSize; // bottom-up
      const p = bpp === 8 ? palOff + rec[row + x] * 4 : row + x * 4;
      const B = rec[p], G = rec[p + 1], R = rec[p + 2], A = rec[p + 3];
      const d = (y * w + x) * 4;
      rgba[d] = R; rgba[d + 1] = G; rgba[d + 2] = B;
      rgba[d + 3] = A >= 128 ? 255 : A * 2; // FFXI alpha is 0–128
    }
  }
  return encodePng(w, h, rgba);
}

/** Extract the 8-bit icon from a decoded item record → RGBA PNG, or null. */
export function extractItemIcon(rec: Buffer): Buffer | null {
  return extractDib(rec, 0x284, 0x2A8);
}
