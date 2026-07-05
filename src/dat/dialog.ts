// ════════════════════════════════════════════════════════════════════
//  dialog.ts — parser for FFXI per-zone dialog DATs (NPC speech)
//  ────────────────────────────────────────────────────────────────────
//  Format: a u32 header at 0x00, then an offset table from 0x04 (each
//  entry XOR 0x80808080 = absolute string offset), then the string data
//  XOR 0x80 per byte. Each string has a 4-byte header then Latin-1 text;
//  0x07 is a line break. Verified against ROM/25/39.DAT (San d'Oria).
// ════════════════════════════════════════════════════════════════════

export function parseDialog(buf: Buffer): string[] {
  if (buf.length < 12) return [];
  const off = (i: number) => (buf.readUInt32LE(i) ^ 0x80808080) >>> 0;
  const dataStart = off(4);
  if (dataStart <= 4 || dataStart > buf.length) return [];
  const count = Math.floor((dataStart - 4) / 4);
  const out: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const s = off(4 + i * 4);
    if (s < 4 || s >= buf.length) { out[i] = ''; continue; }
    let txt = '';
    // Strings are NUL-terminated; read to the terminator rather than the next
    // table offset — in some tables (monster skills, ROM/27/80) the following
    // offset points 4 bytes before its own string, INSIDE this one, and using
    // it as the end truncated the tail. Cap length as a corruption guard.
    const cap = Math.min(buf.length, s + 4 + 0x2000);
    for (let k = s + 4; k < cap; k++) {        // skip the 4-byte per-string header
      const c = buf[k] ^ 0x80;
      if (c === 0) break;
      if (c >= 0x20 && c < 0x7F) txt += String.fromCharCode(c);
      else if (c === 0x07) txt += '\n';        // FFXI line break; other codes dropped
    }
    out[i] = txt.trim();
  }
  return out;
}

/** FTABLE resource id for a zone's primary dialog table. */
export function dialogFileId(zoneId: number): number | null {
  if (zoneId >= 0 && zoneId <= 255) return 6420 + zoneId;
  if (zoneId >= 256 && zoneId <= 511) return 85590 + (zoneId - 256);
  return null;
}
