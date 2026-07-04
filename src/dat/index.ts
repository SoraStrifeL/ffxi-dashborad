// ════════════════════════════════════════════════════════════════════
//  dat/index.ts — optional FFXI DAT fetcher
//  ────────────────────────────────────────────────────────────────────
//  Reads the client resource DATs when a DAT_DIR (containing FTABLE.DAT /
//  VTABLE.DAT + the ROM tree) is available; otherwise the feature is
//  disabled and every accessor returns empty. FTABLE maps a resource id →
//  ROM/<dir>/<file>.DAT (dir = value>>7, file = value & 0x7F); VTABLE
//  gives the ROM volume (1 = "ROM").
// ════════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import { parseDmsg } from './dmsg';

const DAT_DIR = process.env.DAT_DIR || path.join(__dirname, '..', '..', 'ffxi-dat');

let ftable: Buffer | null = null;
let vtable: Buffer | null = null;
let enabled = false;

// Resource id → label. Ids are the EN-client FTABLE indices (resolved from
// xi-tinkerer's mapping; cross-checked: 55465 → ROM/165/84.DAT).
export const DAT_STRING_RESOURCES: Record<string, number> = {
  zones:               55465, // area names (long)
  zones_short:         55466,
  ability_names:       55701,
  ability_descriptions:55733,
  spell_names:         55702,
  spell_descriptions:  55734,
  status_names:        55725,
  titles:              55704,
  key_items:           55695,
  monster_skills:      7035,
};

export function initDat(): void {
  try {
    ftable = fs.readFileSync(path.join(DAT_DIR, 'FTABLE.DAT'));
    vtable = fs.readFileSync(path.join(DAT_DIR, 'VTABLE.DAT'));
    enabled = true;
    console.log(`[dat] enabled — DAT_DIR=${DAT_DIR} (${vtable.length} resource ids)`);
  } catch {
    enabled = false;
    console.log(`[dat] disabled — no FTABLE/VTABLE under ${DAT_DIR}`);
  }
}

export function datEnabled(): boolean { return enabled; }

/** Resolve an FTABLE resource id to its absolute ROM/<dir>/<file>.DAT path. */
export function resolvePath(fileId: number): string | null {
  if (!ftable || !vtable || fileId < 0 || fileId >= vtable.length) return null;
  const vol = vtable[fileId];
  if (!vol) return null;
  const v = ftable.readUInt16LE(fileId * 2);
  const romDir = vol === 1 ? 'ROM' : `ROM${vol}`;
  return path.join(DAT_DIR, romDir, String(v >> 7), `${v & 0x7F}.DAT`);
}

export function readResource(fileId: number): Buffer | null {
  const p = resolvePath(fileId);
  if (!p) return null;
  try { return fs.readFileSync(p); } catch { return null; }
}

// Parsed string lists are cached in-process (the DATs never change at runtime).
const stringCache = new Map<string, string[]>();

/** Get a parsed string list by resource key (e.g. 'zones', 'ability_names'). */
export function getStrings(key: string): string[] {
  if (!enabled) return [];
  const cached = stringCache.get(key);
  if (cached) return cached;
  const id = DAT_STRING_RESOURCES[key];
  if (id === undefined) return [];
  const buf = readResource(id);
  const list = buf ? parseDmsg(buf) : [];
  stringCache.set(key, list);
  return list;
}

export function stringResourceKeys(): string[] {
  return Object.keys(DAT_STRING_RESOURCES);
}

// Display categories: pair a name list with its description list where one
// exists, so the UI can show "all info" per entry in one row.
export const DAT_CATEGORIES: Record<string, { names: string; desc?: string }> = {
  abilities:      { names: 'ability_names', desc: 'ability_descriptions' },
  spells:         { names: 'spell_names',   desc: 'spell_descriptions' },
  zones:          { names: 'zones' },
  statuses:       { names: 'status_names' },
  titles:         { names: 'titles' },
  key_items:      { names: 'key_items' },
  monster_skills: { names: 'monster_skills' },
};

export function categoryKeys(): string[] { return Object.keys(DAT_CATEGORIES); }

export interface DatRow { id: number; name: string; description?: string }

/** Joined id/name/description rows for a display category. */
export function getTable(cat: string): DatRow[] {
  const c = DAT_CATEGORIES[cat];
  if (!c || !enabled) return [];
  const names = getStrings(c.names);
  const descs = c.desc ? getStrings(c.desc) : [];
  const rows: DatRow[] = [];
  for (let id = 0; id < names.length; id++) {
    const name = names[id];
    if (!name || name === '.') continue;   // skip empty/placeholder slots
    rows.push(c.desc ? { id, name, description: (descs[id] || '').trim() } : { id, name });
  }
  return rows;
}
