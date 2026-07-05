// ════════════════════════════════════════════════════════════════════
//  quest-names.ts — canonical quest titles from the retail client
//  ────────────────────────────────────────────────────────────────────
//  LSB's quests.lua only gives each quest a Lua constant (e.g.
//  A_FOREMANS_BEST_FRIEND); the dashboard's quest catalog formats that
//  into title case, which loses apostrophes and mis-cases some words
//  ("A Foremans Best Friend" instead of "A Foreman's Best Friend").
//
//  The client ships ~150 d_msg string tables (per-nation/expansion quest
//  name lists, resource ids 55465-55764) containing the real text. Since
//  LSB's own per-area quest numbering doesn't line up positionally with
//  the client's array indices (LSB omits unimplemented quests), we can't
//  join by index — instead every ASCII string in that id range is
//  loaded into a dictionary keyed by a normalized (lowercased,
//  punctuation-stripped) form, and the formatted Lua name is looked up
//  by the same normalization. Verified >=94% hit rate per quest-log area
//  against the live quests.lua catalog.
//
//  Needs the full retail client (FFXI_CLIENT_DIR), not just the trimmed
//  ffxi-dat/ copy — the quest-name tables aren't among the item/status/
//  ability DATs that copy-from-client.sh pulls in. Returns null (no
//  enrichment) when the client isn't mounted.
// ════════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import { parseDmsg } from './dmsg';

const SCAN_START = 55465;
const SCAN_END   = 55765; // exclusive; beyond this are non-English language duplicates

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

let dict: Map<string, string> | null | undefined; // undefined = not yet built

function buildDict(): Map<string, string> | null {
  const clientDir = process.env.FFXI_CLIENT_DIR;
  if (!clientDir) return null;
  let ftable: Buffer, vtable: Buffer;
  try {
    ftable = fs.readFileSync(path.join(clientDir, 'FTABLE.DAT'));
    vtable = fs.readFileSync(path.join(clientDir, 'VTABLE.DAT'));
  } catch { return null; }

  const out = new Map<string, string>();
  for (let id = SCAN_START; id < SCAN_END && id < vtable.length; id++) {
    if (!vtable[id]) continue;
    const v = ftable.readUInt16LE(id * 2);
    const p = path.join(clientDir, 'ROM', String(v >> 7), `${v & 0x7F}.DAT`);
    let list: string[];
    try { list = parseDmsg(fs.readFileSync(p)); } catch { continue; }
    for (const s of list) {
      if (!s || s === '.' || !/^[\x20-\x7E]+$/.test(s)) continue; // skip blanks + non-ASCII (other-language dupes / mojibake placeholders)
      const key = norm(s);
      if (key.length < 3 || out.has(key)) continue;
      out.set(key, s);
    }
  }
  return out;
}

/** Canonical client-sourced quest title for a formatted Lua-constant name, or null if not found. */
export function canonicalQuestName(formattedName: string): string | null {
  if (dict === undefined) dict = buildDict();
  if (!dict) return null;
  return dict.get(norm(formattedName)) ?? null;
}
