// ════════════════════════════════════════════════════════════════════
//  status.ts — parser for the status-effect icon DAT (ROM/119/57)
//  ────────────────────────────────────────────────────────────────────
//  640 entries of 0x1800 bytes, entry index = status/buff id (0 = KO,
//  2 = sleep, 4 = paralysis, …). Each entry holds:
//    0x2C   help text, bit-rotate encoded (rotation varies per entry)
//    0x280  graphic name ("sts_iconstNN_32"), stored raw
//    ~0x295 headerless DIB — 32×32, 32-bit BGRA (a few 8-bit indexed)
//  The graphic section is NOT rotate-encoded, unlike item records.
// ════════════════════════════════════════════════════════════════════
import { extractDib } from './icon';

export const STATUS_ENTRY = 0x1800;

const entrySlice = (buf: Buffer, id: number): Buffer | null => {
  const base = id * STATUS_ENTRY;
  return id >= 0 && base + STATUS_ENTRY <= buf.length ? buf.subarray(base, base + STATUS_ENTRY) : null;
};

export function statusCount(buf: Buffer): number {
  return Math.floor(buf.length / STATUS_ENTRY);
}

/** Status icon as RGBA PNG, or null for empty slots. */
export function extractStatusIcon(buf: Buffer, id: number): Buffer | null {
  const e = entrySlice(buf, id);
  return e ? extractDib(e, 0x290, 0x2A0) : null;
}

/**
 * Help text of a status entry. The rotation amount differs per entry, so try
 * all 7 and keep the one that yields a clean printable NUL-terminated run.
 */
export function statusDescription(buf: Buffer, id: number): string {
  const e = entrySlice(buf, id);
  if (!e) return '';
  let best = '', bestScore = 0;
  for (let rot = 1; rot < 8; rot++) {
    let s = '', printable = 0, total = 0;
    for (let i = 0x2C; i < 0x280; i++) {
      const c = ((e[i] >>> rot) | (e[i] << (8 - rot))) & 0xFF;
      if (c === 0) break;
      total++;
      if (c >= 32 && c < 127) { s += String.fromCharCode(c); printable++; }
      else if (c === 0x0A) s += ' ';
    }
    if (total > 0 && printable / total >= 0.9 && printable > bestScore) { bestScore = printable; best = s; }
  }
  return best.replace(/\s+/g, ' ').trim();
}
