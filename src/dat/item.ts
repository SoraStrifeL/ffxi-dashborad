// ════════════════════════════════════════════════════════════════════
//  item.ts — parser for FFXI item DATs (weapons, armor, usable, …)
//  ────────────────────────────────────────────────────────────────────
//  Each record is 0xC00 bytes, the whole record rotate-right-by-5 encoded
//  (POLUtils FFXIEncryption.Rotate(bytes, 5)). Layout after decode:
//    0x00  uint32 item id
//    ~0x74 string section: display name, lowercase log name(s), then the
//          description line(s); icon graphic begins at 0x280.
//  The name is the first printable run; description is everything after
//  the lowercase log-name variants. Verified against Cesti, Hexed Domaru,
//  Laudan Cuirass, Ice Crystal, etc.
// ════════════════════════════════════════════════════════════════════

const REC = 0xC00;
const rotr5 = (b: number) => ((b >>> 5) | (b << 3)) & 0xFF;

export interface DatItem { id: number; name: string; description: string }

export function parseItemDat(buf: Buffer): DatItem[] {
  const out: DatItem[] = [];
  const count = Math.floor(buf.length / REC);
  const d = Buffer.alloc(REC);
  for (let rec = 0; rec < count; rec++) {
    const base = rec * REC;
    for (let k = 0; k < REC; k++) d[k] = rotr5(buf[base + k]);
    const id = d.readUInt32LE(0);
    if (!id) continue;

    // printable runs in the string section (0x30 → icon at 0x280)
    const runs: string[] = [];
    let cur = '';
    for (let i = 0x30; i < 0x280; i++) {
      const c = d[i];
      if (c >= 32 && c < 127) cur += String.fromCharCode(c);
      else { if (cur.length >= 2 && /[A-Za-z]/.test(cur)) runs.push(cur); cur = ''; }
    }
    const name = runs[0] || '';
    if (!name || name === '.') continue;

    // Skip the lowercase log-name variants (singular/plural) that follow the
    // display name. Descriptions start with a capital, digit or stat code
    // (":"), so stop at the first such run and join it + any lowercase
    // continuation lines. This is robust to abbreviated display names.
    let i = 1;
    while (i < runs.length && !/[A-Z0-9]/.test(runs[i]) && !runs[i].includes(':')) i++;
    const description = runs.slice(i).join(' ').replace(/\s+/g, ' ').trim();
    out.push({ id, name, description });
  }
  return out;
}
