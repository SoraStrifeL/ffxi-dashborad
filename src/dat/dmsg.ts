// ════════════════════════════════════════════════════════════════════
//  dmsg.ts — parser for FFXI "d_msg" string DATs
//  ────────────────────────────────────────────────────────────────────
//  Two layouts, both with a 64-byte header and one string per entry at
//  entry-relative offset 0x28 (null-terminated Latin-1):
//    • tableSize>0 : variable-length entries via an (offset,length) table,
//      whole payload XOR 0xFF when the encrypt flag (u16 @ 0x0A) is set.
//      (zone names, status names)
//    • tableSize==0: fixed-size records (size @ 0x20), stored back-to-back.
//      (ability/spell/title/key-item names + descriptions)
//  Verified against ROM/165/84 (zones), ROM/181/72 (abilities), etc.
// ════════════════════════════════════════════════════════════════════

const STRING_OFFSET = 0x28;

export function isDmsg(buf: Buffer): boolean {
  return buf.length >= 0x40 && buf.toString('latin1', 0, 5) === 'd_msg';
}

function readCString(raw: Buffer, start: number): string {
  let end = start;
  while (end < raw.length && raw[end] !== 0) end++;
  return raw.toString('latin1', start, end);
}

// Entries begin with a sub-header — u32 sub-entry count, then count × (u32
// offset, u32 type) — type 0 = string at entry offset 0x1C + offset, type 1 =
// uint32 param. The name is the first non-empty string sub-entry (key items
// lead with two params and two empty strings before the singular name). The
// legacy fixed +0x28 read only worked for single-string entries (0x1C + 0x0C);
// multi-string tables like status names ("KO" + "KO'd") parsed empty. Falls
// back to +0x28 when the sub-header doesn't look valid.
function entryString(raw: Buffer): string {
  if (raw.length > 12) {
    const n = raw.readUInt32LE(0);
    if (n >= 1 && n <= 16 && 4 + n * 8 <= raw.length) {
      for (let k = 0; k < n; k++) {
        if (raw.readUInt32LE(8 + k * 8) !== 0) continue; // not a string
        const off = 0x1C + raw.readUInt32LE(4 + k * 8);
        if (off <= 4 + n * 8 || off >= raw.length) return raw.length > STRING_OFFSET ? readCString(raw, STRING_OFFSET) : '';
        const s = readCString(raw, off);
        if (s) return s;
      }
      return '';
    }
  }
  return raw.length > STRING_OFFSET ? readCString(raw, STRING_OFFSET) : '';
}

/** Parse a d_msg DAT into an array of strings, indexed by entry id. */
export function parseDmsg(buf: Buffer): string[] {
  if (!isDmsg(buf)) return [];
  const encrypted  = buf.readUInt16LE(0x0A) !== 0;
  const headerSize = buf.readUInt32LE(0x18);
  const tableSize  = buf.readUInt32LE(0x1C);
  const recordSize = buf.readUInt32LE(0x20);
  const count      = buf.readUInt32LE(0x28);
  const dec = encrypted ? (b: number) => b ^ 0xFF : (b: number) => b;
  const out: string[] = new Array(count);

  if (tableSize > 0) {
    // variable-length entries via offset/length table
    const tableStart = headerSize;
    const dataStart  = headerSize + tableSize;
    for (let i = 0; i < count; i++) {
      const p = tableStart + i * 8;
      const off = (dec(buf[p]) | (dec(buf[p+1]) << 8) | (dec(buf[p+2]) << 16) | (dec(buf[p+3]) << 24)) >>> 0;
      const len = (dec(buf[p+4]) | (dec(buf[p+5]) << 8) | (dec(buf[p+6]) << 16) | (dec(buf[p+7]) << 24)) >>> 0;
      const base = dataStart + off;
      if (base + len > buf.length || len > 0x10000) { out[i] = ''; continue; }
      const raw = Buffer.alloc(len);
      for (let k = 0; k < len; k++) raw[k] = dec(buf[base + k]);
      out[i] = entryString(raw);
    }
  } else if (recordSize > 0) {
    // fixed-size records back-to-back from headerSize
    for (let i = 0; i < count; i++) {
      const base = headerSize + i * recordSize;
      if (base + recordSize > buf.length) { out[i] = ''; continue; }
      const raw = Buffer.alloc(recordSize);
      for (let k = 0; k < recordSize; k++) raw[k] = dec(buf[base + k]);
      out[i] = entryString(raw);
    }
  }
  return out;
}
