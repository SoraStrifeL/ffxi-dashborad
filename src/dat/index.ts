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
import { parseItemDat, decodeItemRecord } from './item';
import { extractItemIcon } from './icon';

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

// Cache item-DAT buffers (12–20 MB each) so icon lookups don't re-read from disk.
const resourceBufCache = new Map<number, Buffer | null>();
function readResourceCached(fileId: number): Buffer | null {
  if (resourceBufCache.has(fileId)) return resourceBufCache.get(fileId)!;
  const b = readResource(fileId);
  resourceBufCache.set(fileId, b);
  return b;
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

// Item categories → the FTABLE resource ids of their item DAT(s). Some merge
// two DATs (e.g. armor + the overflow armor2 range).
export const DAT_ITEM_CATEGORIES: Record<string, number[]> = {
  items_weapons:  [75],
  items_armor:    [76, 55668],
  items_usable:   [74],
  items_general:  [73, 55671, 32922],
  items_currency: [91],
};

export function categoryKeys(): string[] {
  return [...Object.keys(DAT_CATEGORIES), ...Object.keys(DAT_ITEM_CATEGORIES)];
}

export interface DatRow { id: number; name: string; description?: string }

const itemCache = new Map<string, DatRow[]>();
// item id → { fileId, rec } so an icon can be re-decoded on demand.
const itemIconIndex = new Map<number, { fileId: number; rec: number }>();
const iconPngCache = new Map<number, Buffer | null>();

function getItems(cat: string): DatRow[] {
  if (!enabled) return [];
  const cached = itemCache.get(cat);
  if (cached) return cached;
  const ids = DAT_ITEM_CATEGORIES[cat];
  const rows: DatRow[] = [];
  for (const fileId of ids) {
    const buf = readResourceCached(fileId);
    if (!buf) continue;
    for (const it of parseItemDat(buf)) {
      rows.push({ id: it.id, name: it.name, description: it.description });
      itemIconIndex.set(it.id, { fileId, rec: it.rec });
    }
  }
  rows.sort((a, b) => a.id - b.id);
  itemCache.set(cat, rows);
  return rows;
}

/** PNG icon bytes for an item id (any item category), lazily decoded + cached. */
export function getItemIcon(id: number): Buffer | null {
  if (!enabled) return null;
  if (iconPngCache.has(id)) return iconPngCache.get(id)!;
  // ensure the icon index is populated (parse each item category once)
  if (itemIconIndex.size === 0) for (const c of Object.keys(DAT_ITEM_CATEGORIES)) getItems(c);
  const loc = itemIconIndex.get(id);
  let png: Buffer | null = null;
  if (loc) {
    const buf = readResourceCached(loc.fileId);
    if (buf) png = extractItemIcon(decodeItemRecord(buf, loc.rec));
  }
  iconPngCache.set(id, png);
  return png;
}

/** Joined id/name/description rows for a display category (string or item). */
export function getTable(cat: string): DatRow[] {
  if (!enabled) return [];
  if (DAT_ITEM_CATEGORIES[cat]) return getItems(cat);
  const c = DAT_CATEGORIES[cat];
  if (!c) return [];
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
