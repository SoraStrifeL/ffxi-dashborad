// ════════════════════════════════════════════════════════════════════
//  npc-dialog.ts — per-NPC dialogue extraction from the LSB script tree
//  ────────────────────────────────────────────────────────────────────
//  Each NPC's own script references dialogue via named constants
//  (`ID.text.SOME_CONST`, where `local ID = zones[xi.zone.THIS_ZONE]`).
//  Each zone's IDs.lua defines those constants under a `text = {...}`
//  table, with the actual English text as an inline `-- comment` on
//  every entry. This module locates an NPC's script, extracts which
//  constants it references, and resolves each against its zone's
//  IDs.lua table.
//
//  Uses SERVER_SCRIPTS_ROOT (not LSB_SCRIPTS_DIR) — only that mount's
//  scripts tree contains the zones/ subtree these files live under.
// ════════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import { SERVER_SCRIPTS_ROOT } from './catalog';

export interface NpcDialogLine { const: string; id: number; text: string }
export interface NpcDialogResult { found: boolean; scriptPath?: string; lines: NpcDialogLine[] }

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Extracts the text = { ... } sub-table from an IDs.lua source string and
 *  parses its CONST_NAME = id, -- comment entries. Brace-depth scanned
 *  (not a naive non-nested regex) since IDs.lua has sibling mob = {...} /
 *  npc = {...} tables after the text table. */
export function parseIdsTextTable(source: string): Record<string, { id: number; text: string }> {
  const startMatch = /text\s*=\s*\{/.exec(source);
  if (!startMatch) return {};
  let depth = 1;
  let i = startMatch.index + startMatch[0].length;
  const bodyStart = i;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  const body = source.slice(bodyStart, i - 1);

  const out: Record<string, { id: number; text: string }> = {};
  const lineRe = /^\s*([A-Z0-9_]+)\s*=\s*(\d+)\s*,?\s*(?:--\s*(.*))?$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(body)) !== null) {
    out[m[1]] = { id: parseInt(m[2], 10), text: (m[3] || '').trim() };
  }
  return out;
}

/** Every distinct `.text.CONST_NAME` reference in a script's source,
 *  in first-seen order. */
export function extractTextRefs(scriptSource: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\.text\.([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scriptSource)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

const idsTableCache = new Map<string, Record<string, { id: number; text: string }>>();

function getIdsTextTable(zoneName: string): Record<string, { id: number; text: string }> {
  const cached = idsTableCache.get(zoneName);
  if (cached) return cached;
  let table: Record<string, { id: number; text: string }> = {};
  try {
    const idsPath = path.join(SERVER_SCRIPTS_ROOT, 'zones', zoneName, 'IDs.lua');
    table = parseIdsTextTable(fs.readFileSync(idsPath, 'utf8'));
  } catch { /* zone dir/IDs.lua missing — cache the empty result, same as a hit */ }
  idsTableCache.set(zoneName, table);
  return table;
}

/** Locates an NPC's script by (zone, name), extracts which dialogue
 *  constants it references, and resolves each against its zone's
 *  IDs.lua text table. Never throws — filesystem/parse failures resolve
 *  to `{ found: false, lines: [] }`, same convention as /api/questscript. */
export function resolveNpcDialog(zoneName: string, npcName: string): NpcDialogResult {
  try {
    const npcsDir = path.join(SERVER_SCRIPTS_ROOT, 'zones', zoneName, 'npcs');
    if (!fs.existsSync(npcsDir)) return { found: false, lines: [] };

    const exactPath = path.join(npcsDir, `${npcName}.lua`);
    let scriptFile: string | null = fs.existsSync(exactPath) ? `${npcName}.lua` : null;

    if (!scriptFile) {
      const target = normalize(npcName);
      for (const file of fs.readdirSync(npcsDir).filter((f) => f.endsWith('.lua'))) {
        if (normalize(file.replace(/\.lua$/, '')) === target) { scriptFile = file; break; }
      }
    }
    if (!scriptFile) return { found: false, lines: [] };

    const scriptPath = path.join('zones', zoneName, 'npcs', scriptFile);
    const scriptSource = fs.readFileSync(path.join(SERVER_SCRIPTS_ROOT, scriptPath), 'utf8');
    const refs = extractTextRefs(scriptSource);
    const table = getIdsTextTable(zoneName);

    const lines: NpcDialogLine[] = [];
    for (const ref of refs) {
      const entry = table[ref];
      if (entry) lines.push({ const: ref, id: entry.id, text: entry.text });
    }
    return { found: true, scriptPath, lines };
  } catch {
    return { found: false, lines: [] };
  }
}
