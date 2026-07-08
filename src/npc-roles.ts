// ════════════════════════════════════════════════════════════════════
//  npc-roles.ts — best-effort NPC role classification from the LSB
//  script tree
//  ────────────────────────────────────────────────────────────────────
//  LSB has no DB column for what an NPC "does" — that's entirely
//  encoded in each NPC's Lua script. This module scans every NPC
//  script once and tags it with whichever of a small set of reliable
//  xi.* API namespaces it calls: xi.shop.* (vendor), xi.quest.*,
//  xi.mission.*, xi.homepoint.*. An NPC can match more than one.
//  There is no reliable signature for "guard" — guard NPCs are not
//  individually scripted — so that role is intentionally not detected.
//
//  Uses SERVER_SCRIPTS_ROOT (not LSB_SCRIPTS_DIR) — same reasoning as
//  npc-dialog.ts: only that mount's scripts tree has a zones/ subtree.
// ════════════════════════════════════════════════════════════════════
import fs from 'fs';
import path from 'path';
import { SERVER_SCRIPTS_ROOT } from './catalog';

export const NPC_ROLE_PATTERNS: Record<string, RegExp> = {
  shop: /xi\.shop\./,
  quest: /xi\.quest\./,
  mission: /xi\.mission\./,
  homepoint: /xi\.homepoint\./,
};

/** Which of the known roles a script's source matches, in NPC_ROLE_PATTERNS'
 *  fixed key order (shop, quest, mission, homepoint). Pure — no filesystem
 *  access, safe to unit test directly. */
export function classifyNpcScript(source: string): string[] {
  return Object.keys(NPC_ROLE_PATTERNS).filter((role) => NPC_ROLE_PATTERNS[role].test(source));
}

/** Walks every zones/<Zone>/npcs/*.lua file once and classifies each.
 *  Keyed `${zoneDirName}::${npcFileBaseName}` (exact match only — this is
 *  a bulk pass over the whole tree, not the single-NPC fuzzy lookup
 *  resolveNpcDialog does in npc-dialog.ts). Missing SERVER_SCRIPTS_ROOT/
 *  zones, a zone with no npcs/ subdir, or an individual unreadable file
 *  all degrade to skipping that entry — never throws. Entries with zero
 *  matched roles are omitted from the map. */
export function scanNpcRoles(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const zonesDir = path.join(SERVER_SCRIPTS_ROOT, 'zones');
  let zoneDirs: string[] = [];
  try {
    zoneDirs = fs.readdirSync(zonesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return map; // scripts tree not mounted — empty map, matches this repo's mount-degradation convention
  }

  for (const zoneName of zoneDirs) {
    const npcsDir = path.join(zonesDir, zoneName, 'npcs');
    let files: string[] = [];
    try {
      files = fs.readdirSync(npcsDir).filter((f) => f.endsWith('.lua'));
    } catch {
      continue; // this zone has no npcs/ subdirectory
    }
    for (const file of files) {
      try {
        const source = fs.readFileSync(path.join(npcsDir, file), 'utf8');
        const roles = classifyNpcScript(source);
        if (roles.length) map.set(`${zoneName}::${file.replace(/\.lua$/, '')}`, roles);
      } catch {
        // one unreadable/malformed script shouldn't abort the whole scan
      }
    }
  }
  return map;
}
