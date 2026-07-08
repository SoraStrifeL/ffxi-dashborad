# Merge Game Data into Database — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `client/src/components/pages/GameData.tsx` (client-DAT-sourced
browser) into `client/src/components/pages/Database.tsx` (DB/Lua-sourced
browser) so the dashboard has a single `/db` tab. Overlapping categories
(Items, Abilities, Quests, Key Items) keep the DB row list and gain a
DAT→BG-Wiki auto-fallback description chain with source labeling; DAT-only
categories (Spells, Statuses, Titles, Monster Skills, Emotes, Augments,
Dialog) port into Database's sidebar+table+detail-panel shell as a "Client
Reference" group.

**Architecture:** Backend gains one new enrichment route
(`GET /api/dat/enrich/:cat/:key`) backed by three lookup helpers in
`src/dat/index.ts` (id-matched for items, name-matched for abilities/key
items — verified those don't share an id space with the DB), plus two new
per-category Wiki routes (abilities, key items) modeled on the existing
`zones/wiki` pattern. Frontend work is entirely inside `Database.tsx`,
extending its existing `Category` union / `getColumns()` / `DetailView()`
switch pattern rather than introducing new components — matches how the
file already handles 12 categories today.

**Tech Stack:** TypeScript, Express, React 18, vitest, existing BG-Wiki
scrape-and-cache pattern (`src/cache.ts` `cacheGetJSON`/`cacheSetJSON`).

## Global Constraints

- All backend changes go in `src/routes/*.ts` / `src/*.ts` / `src/dat/*.ts` — never touch root `server.js` (deprecated legacy, per CLAUDE.md).
- Deploy only via `docker compose build && docker compose up -d --force-recreate` (per CLAUDE.md) — never any other deploy path.
- `DAT_DIR`/`FFXI_CLIENT_DIR` are optional; every new code path must degrade gracefully to empty/`null` when the DAT isn't mounted, exactly like the existing `enabled === false` checks in `src/dat/index.ts`.
- Never commit `ffxi-dat/`, `FINAL FANTASY XI/`, or `data/*.json` (gitignored, copyrighted client data).
- Only commit when explicitly asked; this plan's final task assumes the user has asked for commits along the way (adjust per actual session instructions).
- `DB_PAGE = 50` (server `src/catalog.ts` / client `Database.tsx`) must stay in sync — untouched by this plan, but don't confuse it with the DAT table endpoint's separate `PAGE = 100` (`src/routes/dat.ts`).

---

## Task 1: DAT enrichment lookup helpers

**Files:**
- Modify: `src/dat/index.ts`

**Interfaces:**
- Produces: `normalizeDatName(s: string): string`, `buildIdIndex(rows: DatRow[]): Map<number, DatRow>`, `buildNameIndex(rows: DatRow[]): Map<string, DatRow>`, `getItemDatById(id: number): DatRow | null`, `getAbilityDatByName(name: string): DatRow | null`, `getKeyItemDatByName(name: string): DatRow | null` — all exported from `src/dat/index.ts`, all consumed by Task 3 (route) and Task 2 (tests).
- Consumes: existing `DatRow` interface, `getTable()`, `DAT_ITEM_CATEGORIES`, `enabled` (all already in this file).

Verified facts (spot-checked live against the running dashboard before this plan): DB `item_basic.itemid` and the DAT item id are the *same number* (`bronze_subligar` = 12832 on both sides) — id lookup works for Items. DB `abilityId` and DAT ability id are *not* the same space (DB 35 "Provoke" vs. DAT 547 "Provoke") — needs name matching. DB key-item id and DAT key-item id are *not* the same space either (DB 395 "Map of the Zeruhn Mines" vs. DAT 2835) — needs name matching. The DAT `key_items` table (resource 55695) has no paired description resource configured in `DAT_STRING_RESOURCES`, so `getKeyItemDatByName` will realistically always return rows with `description: undefined` today — that's expected, not a bug; Task 8's fallback chain handles it by falling through to Wiki.

- [ ] **Step 1: Add the pure matching helpers and the three lookups**

Open `src/dat/index.ts`. Find the `getTable()` function (currently the last function in the file, ending the file). Add the following **after** `getTable()`, i.e. at the end of the file:

```ts
// ── Cross-source enrichment lookups ─────────────────────────────────────
// The live DB and the client DAT don't share an id space for everything.
// Items do (DB item_basic.itemid == DAT item id, verified) so enrichment
// there is a direct id lookup. Abilities and key items don't (e.g. DB
// ability 35 "Provoke" == DAT ability id 547) so those two are matched by
// normalized name instead. The two builder helpers are pure and unit-
// tested directly with fixture rows — no DAT_DIR needed for that test.
export function normalizeDatName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function buildIdIndex(rows: DatRow[]): Map<number, DatRow> {
  const idx = new Map<number, DatRow>();
  for (const row of rows) idx.set(row.id, row);
  return idx;
}

export function buildNameIndex(rows: DatRow[]): Map<string, DatRow> {
  const idx = new Map<string, DatRow>();
  for (const row of rows) idx.set(normalizeDatName(row.name), row);
  return idx;
}

let itemDatIndex: Map<number, DatRow> | null = null;
/** DAT item row by id (DB item_basic.itemid and the DAT item id are the same number). */
export function getItemDatById(id: number): DatRow | null {
  if (!enabled) return null;
  if (!itemDatIndex) {
    const rows: DatRow[] = [];
    for (const cat of Object.keys(DAT_ITEM_CATEGORIES)) rows.push(...getTable(cat));
    itemDatIndex = buildIdIndex(rows);
  }
  return itemDatIndex.get(id) ?? null;
}

let abilityDatIndex: Map<string, DatRow> | null = null;
/** DAT ability row by name — server and client ability ids don't match (see file header). */
export function getAbilityDatByName(name: string): DatRow | null {
  if (!enabled) return null;
  if (!abilityDatIndex) abilityDatIndex = buildNameIndex(getTable('abilities'));
  return abilityDatIndex.get(normalizeDatName(name)) ?? null;
}

let keyItemDatIndex: Map<string, DatRow> | null = null;
/**
 * DAT key-item row by name. Note: the key_items DAT resource (55695) has no
 * paired description resource configured above, so every row here has
 * description === undefined today — matches always fall through to the
 * Wiki fallback in the client. Kept in case a description resource id is
 * identified later; the lookup itself is correct and tested now.
 */
export function getKeyItemDatByName(name: string): DatRow | null {
  if (!enabled) return null;
  if (!keyItemDatIndex) keyItemDatIndex = buildNameIndex(getTable('key_items'));
  return keyItemDatIndex.get(normalizeDatName(name)) ?? null;
}
```

- [ ] **Step 2: Stop exposing items/abilities/key_items/quests/zones as standalone browsable categories**

Still in `src/dat/index.ts`, find:

```ts
export function categoryKeys(): string[] {
  return ['quests', ...Object.keys(DAT_CATEGORIES), ...Object.keys(PAIRED_CATEGORIES), ...Object.keys(DAT_ITEM_CATEGORIES)];
}
```

Replace with:

```ts
// Categories exposed as their own browsable table in the Database tab's
// "Client Reference" sidebar group. Abilities, Key Items, Items, and
// Quests are deliberately excluded — the DB versions are primary now, and
// DAT data for those is enrichment-only, reached via /api/dat/enrich (see
// bottom of this file) or (for quests) the reward.walkthrough already
// inline on /api/db/quests, never a standalone chip. DAT "zones" is
// excluded too — it has no description text to add over the DB Zones
// category, so there's nothing to gain from listing it separately.
export function categoryKeys(): string[] {
  const CLIENT_REFERENCE = ['spells', 'statuses', 'titles', 'monster_skills'];
  return [...CLIENT_REFERENCE, ...Object.keys(PAIRED_CATEGORIES)];
}
```

- [ ] **Step 3: Delete the now-unused flat DAT quest list**

Still in `src/dat/index.ts`, find and delete this whole block:

```ts
// Quest/mission title tables — the client ships one per nation/expansion/
// log-category rather than a single master table (same 55465-55765 range
// dat/quest-names.ts scans for its name-lookup dictionary). Concatenated
// here, in client order, for a flat "Quests" Game Data category. No
// description table exists client-side; quest text/rewards live in the
// Lua-backed Database tab instead.
const QUEST_NAME_RESOURCES = [
  55706, 55707, 55708, 55709, 55710, 55711, 55712, 55713, 55715, 55716, 55717,
  55718, 55719, 55720, 55721, 55722, 55723, 55724, 55735, 55736, 55737, 55738,
  55739, 55740, 55741, 55742,
];
```

Then find and delete:

```ts
let questRows: DatRow[] | null = null;
function getQuests(): DatRow[] {
  if (!enabled) return [];
  if (questRows) return questRows;
  const rows: DatRow[] = [];
  for (const fileId of QUEST_NAME_RESOURCES) {
    const buf = readResourceCached(fileId);
    if (!buf) continue;
    for (const name of parseDmsg(buf)) {
      if (!name || name === '.') continue;
      rows.push({ id: rows.length, name });
    }
  }
  questRows = rows;
  return rows;
}
```

Then in `getTable()`, find:

```ts
export function getTable(cat: string): DatRow[] {
  if (!enabled) return [];
  if (cat === 'quests') return getQuests();
  if (DAT_ITEM_CATEGORIES[cat]) return getItems(cat);
```

Replace with:

```ts
export function getTable(cat: string): DatRow[] {
  if (!enabled) return [];
  if (DAT_ITEM_CATEGORIES[cat]) return getItems(cat);
```

- [ ] **Step 4: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors. (`parseDmsg` stays used elsewhere in the file — e.g. `getStrings()` — so no unused-import error from deleting `getQuests()`.)

- [ ] **Step 5: Commit**

```bash
git add src/dat/index.ts
git commit -m "$(cat <<'EOF'
dat: add item/ability/key-item enrichment lookups, drop flat quest list

Items match the DB by id directly (verified: item_basic.itemid == DAT
item id). Abilities and key items don't share an id space with the DB,
so they're matched by normalized name instead. getQuests() and its flat
concatenated quest-title list are deleted — that list only ever existed
to feed GameData's standalone Quests category, which is being retired
in favor of Database's DB-primary Quests (see docs/superpowers/specs/
2026-07-07-gamedata-database-merge-design.md).
EOF
)"
```

---

## Task 2: Unit tests for the enrichment matching helpers

**Files:**
- Create: `tests/unit/dat-enrichment.test.ts`

**Interfaces:**
- Consumes: `normalizeDatName`, `buildIdIndex`, `buildNameIndex`, `DatRow` from `src/dat/index.ts` (Task 1).

These test the **pure** helpers with fixture data — no `DAT_DIR` needed, so they pass identically whether or not the real client DAT is mounted (it isn't in CI).

- [ ] **Step 1: Write the tests**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeDatName, buildIdIndex, buildNameIndex, type DatRow } from '../../src/dat';

describe('normalizeDatName', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(normalizeDatName('Provoke')).toBe('provoke');
    expect(normalizeDatName("Foreman's Best Friend")).toBe('foremansbestfriend');
  });

  it('treats case and punctuation differences as equal', () => {
    expect(normalizeDatName('Bronze Subligar +1')).toBe(normalizeDatName('bronze_subligar_+1'));
  });

  it('collapses whitespace and underscores the same way', () => {
    expect(normalizeDatName('Zeruhn Report')).toBe(normalizeDatName('zeruhn_report'));
  });
});

describe('buildIdIndex', () => {
  it('indexes rows by their numeric id', () => {
    const rows: DatRow[] = [
      { id: 12832, name: 'Bronze Subligar', description: 'DEF:3' },
      { id: 12823, name: 'Brz. Subligar +1', description: 'DEF:4' },
    ];
    const idx = buildIdIndex(rows);
    expect(idx.get(12832)?.name).toBe('Bronze Subligar');
    expect(idx.get(12823)?.description).toBe('DEF:4');
    expect(idx.get(1)).toBeUndefined();
  });

  it('last row wins on a duplicate id', () => {
    const rows: DatRow[] = [
      { id: 1, name: 'First' },
      { id: 1, name: 'Second' },
    ];
    expect(buildIdIndex(rows).get(1)?.name).toBe('Second');
  });
});

describe('buildNameIndex', () => {
  const rows: DatRow[] = [
    { id: 547, name: 'Provoke', description: 'Goads an enemy into attacking you.' },
    { id: 716, name: 'Animated Flourish', description: 'Provokes target.' },
  ];

  it('looks up by exact normalized name', () => {
    const idx = buildNameIndex(rows);
    expect(idx.get(normalizeDatName('Provoke'))?.id).toBe(547);
  });

  it('matches case-insensitively, matching DB names like "provoke"', () => {
    const idx = buildNameIndex(rows);
    expect(idx.get(normalizeDatName('provoke'))?.id).toBe(547);
  });

  it('does not match a substring of a different entry', () => {
    const idx = buildNameIndex(rows);
    expect(idx.get(normalizeDatName('Animated'))).toBeUndefined();
  });

  it('matches "+1" gear variants once punctuation is stripped', () => {
    const gearRows: DatRow[] = [
      { id: 12832, name: 'Bronze Subligar', description: 'DEF:3' },
      { id: 12823, name: 'Brz. Subligar +1', description: 'bronze subligar +1' },
    ];
    const idx = buildNameIndex(gearRows);
    expect(idx.get(normalizeDatName('bronze_subligar_+1'))).toBeUndefined(); // DB uses a different short name than the DAT "Brz." abbreviation — documents the limit of name-matching
    expect(idx.get(normalizeDatName('Bronze Subligar'))?.id).toBe(12832);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/unit/dat-enrichment.test.ts`
Expected: all tests PASS (these test pure functions added in Task 1, which has already landed).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/dat-enrichment.test.ts
git commit -m "test: cover DAT enrichment matching helpers with fixture data"
```

---

## Task 3: Enrichment route + two new Wiki routes + delete walkthrough machinery

**Files:**
- Modify: `src/routes/dat.ts`
- Modify: `src/routes/db.ts`
- Modify: `src/catalog.ts`

**Interfaces:**
- Consumes: `getItemDatById`, `getAbilityDatByName`, `getKeyItemDatByName`, `datEnabled` (Task 1, `src/dat/index.ts`); existing `cacheGetJSON`/`cacheSetJSON`/`WIKI_TTL` from `src/cache.ts`.
- Produces: `GET /api/dat/enrich/:cat/:key` → `{ name: string; description: string; datId: number } | null`; `GET /api/db/abilities/wiki?name=` and `GET /api/db/keyitems/wiki?name=` → `{ description: string | null; wikiUrl: string; notFound: boolean; cachedAt?: number } | null` — both consumed by Task 5 (`client/src/api.ts`).

- [ ] **Step 1: Add the enrichment route**

Open `src/routes/dat.ts`. Change the import line:

```ts
import { datEnabled, getStrings, stringResourceKeys, getTable, categoryKeys, getItemIcon, getStatusIcon, getDialog, dialogZones } from '../dat';
```

to:

```ts
import { datEnabled, getStrings, stringResourceKeys, getTable, categoryKeys, getItemIcon, getStatusIcon, getDialog, dialogZones, getItemDatById, getAbilityDatByName, getKeyItemDatByName } from '../dat';
```

Then add this route right after the `/api/dat/status` route (before `/api/dat/table/:cat`):

```ts
  // Cross-source enrichment: DAT icon/flavor text for a DB row. `key` is an
  // id for items (DB item_basic.itemid == DAT item id) or a name for
  // abilities/key items (those don't share an id space with the DB — see
  // src/dat/index.ts). Returns null on no match; never a loud 404, since
  // "no DAT match" is an expected, common outcome the client falls back
  // from (see docs/superpowers/specs/2026-07-07-gamedata-database-merge-design.md).
  router.get('/api/dat/enrich/:cat/:key', requireAuth, requirePermission('view:db'), (req, res) => {
    if (!datEnabled()) { res.json(null); return; }
    const cat = String(req.params.cat);
    const key = String(req.params.key);
    let row: { id: number; name: string; description?: string } | null = null;
    if (cat === 'items') {
      const id = parseInt(key);
      row = Number.isFinite(id) ? getItemDatById(id) : null;
    } else if (cat === 'abilities') {
      row = getAbilityDatByName(key);
    } else if (cat === 'key_items') {
      row = getKeyItemDatByName(key);
    } else {
      res.status(404).json({ error: 'unknown enrichment category' });
      return;
    }
    if (!row || !row.description) { res.json(null); return; }
    res.json({ name: row.name, description: row.description, datId: row.id });
  });
```

- [ ] **Step 2: Add a shared Wiki-paragraph helper and two new Wiki routes in `db.ts`**

Open `src/routes/db.ts`. Find the `/api/db/npcs/wiki` route (it ends right before `/api/db/quest-logs`). Add this helper function and the two new routes immediately **before** the `/api/db/quest-logs` route:

```ts
  // Shared by the abilities/key-items Wiki routes below: title-cases the
  // name into a BG-Wiki slug and pulls the first substantial <p> as the
  // description — same pattern already used by /api/db/zones/wiki
  // (src/routes/zones.ts), just factored out since two new routes need it.
  async function fetchSimpleWikiDescription(rawName: string, cachePrefix: string) {
    const cacheKey = cachePrefix + rawName.toLowerCase();
    const cached = await cacheGetJSON(cacheKey);
    if (cached) return cached;
    try {
      const wikiName = rawName.split(/[\s_]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('_');
      const url = `https://www.bg-wiki.com/ffxi/${encodeURIComponent(wikiName)}`;
      const resp = await fetch(url, { headers: { 'User-Agent': 'FFXI-Dashboard/1.0' }, signal: AbortSignal.timeout(7000) });
      if (!resp.ok) {
        const out = { description: null, wikiUrl: url, notFound: true };
        await cacheSetJSON(cacheKey, out, WIKI_TTL);
        return out;
      }
      const html = await resp.text();
      const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&apos;|&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
      let description: string | null = null;
      for (const [, p] of html.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
        const t = strip(p);
        if (t.length > 20) { description = t; break; }
      }
      const out = { description, wikiUrl: url, notFound: !description, cachedAt: Date.now() };
      await cacheSetJSON(cacheKey, out, WIKI_TTL);
      return out;
    } catch (e) { void e; return null; }
  }

  router.get('/api/db/abilities/wiki', requireAuth, async (req, res) => {
    const rawName = ((req.query.name as string) || '').trim();
    if (!rawName) { res.json(null); return; }
    res.json(await fetchSimpleWikiDescription(rawName, 'wiki:ability:'));
  });

  router.get('/api/db/keyitems/wiki', requireAuth, async (req, res) => {
    const rawName = ((req.query.name as string) || '').trim();
    if (!rawName) { res.json(null); return; }
    res.json(await fetchSimpleWikiDescription(rawName, 'wiki:keyitem:'));
  });

```

- [ ] **Step 3: Delete the quest-walkthrough route**

Still in `src/routes/db.ts`, find and delete this whole block:

```ts
  // Local walkthrough steps parsed from the LSB quest scripts (see
  // _extractWalkthrough in catalog.ts) — checked before falling back to the
  // BG-Wiki fetch, since it's instant and needs no network round-trip.
  router.get('/api/db/quests/walkthrough', requireAuth, (req, res) => {
    const questName = ((req.query.name as string) || '').trim();
    const norm = questName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const loc = norm ? QUEST_NAME_INDEX[norm] : undefined;
    const reward = loc ? QUEST_REWARDS[loc.logId]?.[loc.questId] : null;
    const steps = (reward?.walkthrough as string[] | undefined) || [];
    res.json({ steps, logId: loc?.logId ?? null, questId: loc?.questId ?? null, reward: reward || null });
  });

```

(Note: `/api/db/quests` itself is unaffected and unchanged — it already returns `reward.walkthrough` inline, which Task 10 renders directly. Only this separate name-matching route goes away.)

- [ ] **Step 4: Update the import at the top of `db.ts`**

Find:

```ts
import {
  MOB_CATALOG, NPC_CATALOG, DB_PAGE,
  QUEST_CATALOG, QUEST_REWARDS, QUEST_LOG_NAMES, QUEST_NAME_INDEX,
  QUEST_SETTINGS,
  ROE_RECORDS,
  _mobRegionMatch,
  KEY_ITEM_NAMES,
} from '../catalog';
```

Replace with:

```ts
import {
  MOB_CATALOG, NPC_CATALOG, DB_PAGE,
  QUEST_CATALOG, QUEST_REWARDS, QUEST_LOG_NAMES,
  QUEST_SETTINGS,
  ROE_RECORDS,
  _mobRegionMatch,
  KEY_ITEM_NAMES,
} from '../catalog';
```

- [ ] **Step 5: Delete `QUEST_NAME_INDEX` / `_normQuestName` from `catalog.ts`**

Open `src/catalog.ts`. Find and delete:

```ts

// name → {logId, questId}, keyed by the same normalization quest-names.ts
// uses for its client-title dictionary, so a DAT-sourced quest title (Game
// Data tab) can be matched back to its LSB script for walkthrough/reward text.
const _normQuestName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export const QUEST_NAME_INDEX: Record<string, { logId: number; questId: number }> = (() => {
  const idx: Record<string, { logId: number; questId: number }> = {};
  for (let logId = 0; logId < QUEST_CATALOG.length; logId++) {
    for (const [qidStr, name] of Object.entries(QUEST_CATALOG[logId])) {
      idx[_normQuestName(name as string)] = { logId, questId: parseInt(qidStr) };
    }
  }
  return idx;
})();
```

(Leave `QUEST_CATALOG`, `QUEST_CONST_TO_ID`, `_extractWalkthrough`, and `QUEST_REWARDS` exactly as they are — `reward.walkthrough` is still generated and is exactly what Task 10 renders.)

- [ ] **Step 6: Compile check**

Run: `npx tsc --noEmit`
Expected: no errors — confirms nothing else imported `QUEST_NAME_INDEX`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/dat.ts src/routes/db.ts src/catalog.ts
git commit -m "$(cat <<'EOF'
routes: add DAT enrichment + abilities/key-items wiki, drop quest-walkthrough route

GET /api/dat/enrich/:cat/:key gives Items/Abilities/Key Items detail
panels a DAT icon/flavor-text lookup (id-matched for items, name-matched
for the other two). Two new Wiki routes complete the fallback chain for
abilities and key items, which never had one. The old
/api/db/quests/walkthrough route and its QUEST_NAME_INDEX matching layer
are removed — they existed only to match GameData's flat, id-less DAT
quest list back to an LSB quest; Database's own quest rows already carry
logId/questId directly and never needed matching.
EOF
)"
```

---

## Task 4: Backend checkpoint

**Files:** none (verification only)

- [ ] **Step 1: Full backend build**

Run: `npm run build`
Expected: exits 0, `dist/` regenerated with no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass (87 pre-existing + the new ones from Task 2).

- [ ] **Step 3: Live smoke-test the two new routes**

This requires the dashboard running (`docker compose up -d` or `npm run dev`) with a valid login. Using the throwaway test account already used elsewhere this session:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/login -H 'Content-Type: application/json' -d '{"login":"Sora","password":"YourPassword1"}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
curl -s "http://localhost:3001/api/dat/enrich/items/12832" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3001/api/dat/enrich/abilities/provoke" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3001/api/dat/table/abilities" -H "Authorization: Bearer $TOKEN"
```

Expected: first call returns `{"name":"Bronze Subligar","description":"DEF:3","datId":12832}`; second returns `{"name":"Provoke","description":"Goads an enemy into attacking you.","datId":547}`; third returns `{"error":"unknown category"}` with a 404 status (confirms `abilities` is no longer browsable via `/api/dat/table`, per Task 1 Step 2).

---

## Task 5: Client API helpers

**Files:**
- Modify: `client/src/api.ts`

**Interfaces:**
- Produces: `api.datEnrich(cat, key)`, `api.dbAbilityWiki(name)`, `api.dbKeyItemWiki(name)`, corrected `api.dbItemWiki(name)` — all consumed by Database.tsx in Tasks 8–10.

- [ ] **Step 1: Add `datEnrich` next to the other `dat*` helpers**

Find:

```ts
  datDialogZones: () => req<{ zones: { id: number; name: string }[] }>('/api/dat/dialog-zones'),
  datDialog: (zone: number, q = '', page = 0) =>
    req<{ zoneId: number; total: number; page: number; rows: { id: number; text: string }[]; hasMore: boolean }>(
      `/api/dat/dialog/${zone}?q=${encodeURIComponent(q)}&page=${page}`),
```

Add immediately after it:

```ts
  datEnrich: (cat: string, key: string | number) =>
    req<{ name: string; description: string; datId: number } | null>(
      `/api/dat/enrich/${cat}/${encodeURIComponent(String(key))}`),
```

- [ ] **Step 2: Fix `dbItemWiki` (pre-existing bug) and add the two new Wiki helpers**

Find:

```ts
  dbItemWiki:  (id: number) => req<{ description?: string; wikiUrl?: string; notFound?: boolean }>(`/api/db/items/wiki?id=${id}`),
  dbNpcWiki:   (name: string) => req<{ description?: string; quests?: string[]; wikiUrl?: string; notFound?: boolean }>(`/api/db/npcs/wiki?name=${encodeURIComponent(name)}`),
  dbQuestWiki: (name: string) => req<{ description?: string; startNpc?: string; repeatable?: boolean; wikiUrl?: string; notFound?: boolean }>(`/api/db/quests/wiki?name=${encodeURIComponent(name)}`),
  dbQuestWalkthrough: (name: string) => req<{ steps: string[]; logId: number | null; questId: number | null }>(`/api/db/quests/walkthrough?name=${encodeURIComponent(name)}`),
  dbZoneWiki:  (name: string) => req<{ description?: string; wikiUrl?: string; notFound?: boolean }>(`/api/db/zones/wiki?name=${encodeURIComponent(name)}`),
```

Replace with:

```ts
  // NOTE: /api/db/items/wiki (src/routes/db.ts) reads req.query.name, but
  // this helper used to send ?id= — meaning the Items "Wiki" fetch has
  // always silently returned null. Fixed here to send the item's internal
  // `name` field (e.g. "bronze_subligar"), same convention as every other
  // dbXWiki helper below.
  dbItemWiki:  (name: string) => req<{ description?: string | null; flags?: string | null; ahCategory?: string | null; itemType?: string | null; wikiUrl?: string; cachedAt?: number } | null>(`/api/db/items/wiki?name=${encodeURIComponent(name)}`),
  dbNpcWiki:   (name: string) => req<{ description?: string; quests?: string[]; wikiUrl?: string; notFound?: boolean }>(`/api/db/npcs/wiki?name=${encodeURIComponent(name)}`),
  dbQuestWiki: (name: string) => req<{ description?: string; startNpc?: string; repeatable?: boolean; wikiUrl?: string; notFound?: boolean }>(`/api/db/quests/wiki?name=${encodeURIComponent(name)}`),
  dbAbilityWiki: (name: string) => req<{ description?: string | null; wikiUrl?: string; notFound?: boolean } | null>(`/api/db/abilities/wiki?name=${encodeURIComponent(name)}`),
  dbKeyItemWiki: (name: string) => req<{ description?: string | null; wikiUrl?: string; notFound?: boolean } | null>(`/api/db/keyitems/wiki?name=${encodeURIComponent(name)}`),
  dbQuestWalkthrough: (name: string) => req<{ steps: string[]; logId: number | null; questId: number | null }>(`/api/db/quests/walkthrough?name=${encodeURIComponent(name)}`),
  dbZoneWiki:  (name: string) => req<{ description?: string; wikiUrl?: string; notFound?: boolean }>(`/api/db/zones/wiki?name=${encodeURIComponent(name)}`),
```

**Correction (found during task review):** `dbQuestWalkthrough` must be **kept** here, not deleted — its backend route was already removed in Task 3, so this helper now points at a 404, but `client/src/components/pages/GameData.tsx` still calls it and is still live/routed until Task 11 deletes that file. Deleting it in this task broke the client typecheck for every task in between. It moves to Task 11's cleanup list instead, deleted in the same step that deletes its only remaining caller.

- [ ] **Step 3: Compile check**

Run: `cd client && npx tsc -b --noEmit`
Expected: no errors yet from this file alone — `Database.tsx`'s one call site (`api.dbItemWiki(Number(detailRow.itemid))`) will start erroring here since the signature changed from `number` to `string`; that's expected and gets fixed in Task 8. If you want a clean intermediate compile, you may do Task 5 and Task 8 in the same sitting before running the full `npm run build:all` in Task 12 — do not run the client build in isolation as a gate for this task.

- [ ] **Step 4: Commit**

```bash
git add client/src/api.ts
git commit -m "$(cat <<'EOF'
api: add DAT enrichment + abilities/key-items wiki helpers, fix items wiki bug

api.dbItemWiki sent ?id= but the backend route only ever read ?name=, so
the Items detail panel's Wiki button has always returned null silently.
Fixed to send the item's internal name like every other dbXWiki helper.
Client-side callers are updated in the Database.tsx enrichment tasks
that follow.
EOF
)"
```

---

## Task 6: Client Reference categories (Spells, Statuses, Titles, Monster Skills, Emotes, Augments)

**Files:**
- Modify: `client/src/components/pages/Database.tsx`

**Interfaces:**
- Consumes: `api.datStatus()`, `api.datTable(cat, q, page)` (both pre-existing, previously only used by `GameData.tsx`).
- Produces: extended `Category` union and two-group sidebar rendering that Tasks 7–10 build on.

- [ ] **Step 1: Extend the `Category` type and split `CATS` into two groups**

Find:

```tsx
type Category = 'items'|'npcs'|'mobs'|'zones'|'jobs'|'skills'|'abilities'|'quests'|'keyitems'|'trusts'|'mounts'|'gmcmds';

const CATS: { key: Category; label: string }[] = [
  { key: 'items', label: 'Items' }, { key: 'npcs', label: 'NPCs' },
  { key: 'mobs', label: 'Mobs' }, { key: 'zones', label: 'Zones' },
  { key: 'jobs', label: 'Jobs' }, { key: 'skills', label: 'Skills' },
  { key: 'abilities', label: 'Abilities' }, { key: 'quests', label: 'Quests' },
  { key: 'keyitems', label: 'Key Items' }, { key: 'trusts', label: 'Trusts' },
  { key: 'mounts', label: 'Mounts' }, { key: 'gmcmds', label: 'GM Commands' },
];
```

Replace with:

```tsx
type Category = 'items'|'npcs'|'mobs'|'zones'|'jobs'|'skills'|'abilities'|'quests'|'keyitems'|'trusts'|'mounts'|'gmcmds'
  |'spells'|'statuses'|'titles'|'monster_skills'|'emotes'|'augments'|'dialog';

type CatDef = { key: Category; label: string };

// "Server Data" = rows come from the live DB/Lua catalogs (ground truth for
// this server). "Client Reference" = DAT-only categories with no
// server-side equivalent, ported from the old Game Data tab.
const SERVER_CATS: CatDef[] = [
  { key: 'items', label: 'Items' }, { key: 'npcs', label: 'NPCs' },
  { key: 'mobs', label: 'Mobs' }, { key: 'zones', label: 'Zones' },
  { key: 'jobs', label: 'Jobs' }, { key: 'skills', label: 'Skills' },
  { key: 'abilities', label: 'Abilities' }, { key: 'quests', label: 'Quests' },
  { key: 'keyitems', label: 'Key Items' }, { key: 'trusts', label: 'Trusts' },
  { key: 'mounts', label: 'Mounts' }, { key: 'gmcmds', label: 'GM Commands' },
];
const CLIENT_REF_CATS: CatDef[] = [
  { key: 'spells', label: 'Spells' }, { key: 'statuses', label: 'Statuses' },
  { key: 'titles', label: 'Titles' }, { key: 'monster_skills', label: 'Monster Skills' },
  { key: 'emotes', label: 'Emotes' }, { key: 'augments', label: 'Augments' },
  { key: 'dialog', label: 'Dialog' },
];
const CATS: CatDef[] = [...SERVER_CATS, ...CLIENT_REF_CATS];

// The six DAT-only, name+description table categories (Dialog is handled
// separately — it's per-zone line dumps, not a name/description table).
const DAT_TABLE_CATS = new Set<Category>(['spells', 'statuses', 'titles', 'monster_skills', 'emotes', 'augments']);

// Module-level (not component-local) because DetailView/EnrichedDescription
// below are also module-level functions and need this shape — see Task 8.
type Enrichment = { loading: boolean; source: 'dat' | 'wiki' | 'script' | 'none' | null; text: string | null; datId?: number; wikiUrl?: string };
```

- [ ] **Step 2: Fetch DAT-enabled status and branch `load()` for DAT-table categories**

Find the component's state declarations, right after:

```tsx
  const uploadRef = useRef<HTMLInputElement>(null);
  const user = useStore((s) => s.user);
  const [itemImageUrl, setItemImageUrl] = useState<string | null>(null);
```

Add:

```tsx
  const [datEnabled, setDatEnabled] = useState(false);
```

Find:

```tsx
  useEffect(() => { api.zones().then(z => setZones(z)).catch(() => {}); }, []);
  useEffect(() => { api.dbItemTypes().then(setItemTypes).catch(() => {}); }, []);
  useEffect(() => { api.dbQuestLogs().then(setQuestLogs).catch(() => {}); }, []);
```

Add immediately after:

```tsx
  useEffect(() => { api.datStatus().then(s => setDatEnabled(s.enabled)).catch(() => setDatEnabled(false)); }, []);
```

Now find the `load()` callback's try block:

```tsx
    try {
      // All server DB endpoints return plain arrays (not { rows, hasMore }).
      // hasMore is inferred: if the page is full (== DB_PAGE), there may be more.
      let newRows: unknown[] | null = null;
      if (cat === 'items')          newRows = (await api.dbItems(params)) as unknown as unknown[];
```

Add a new branch immediately **before** the `if (cat === 'items')` line, inside the same `try` block:

```tsx
    try {
      // All server DB endpoints return plain arrays (not { rows, hasMore }).
      // hasMore is inferred: if the page is full (== DB_PAGE), there may be more.
      let newRows: unknown[] | null = null;
      let datHasMore: boolean | null = null; // DAT_TABLE_CATS report hasMore directly, unlike DB_PAGE inference below
      if (DAT_TABLE_CATS.has(cat)) {
        const r = await api.datTable(cat, search, p);
        newRows = r.rows;
        datHasMore = r.hasMore;
      }
      else if (cat === 'items')          newRows = (await api.dbItems(params)) as unknown as unknown[];
```

Find where `hasMore` is set:

```tsx
      if (newRows !== null && seq === loadSeq.current) {
        setRows((prev) => reset ? newRows! : [...prev, ...newRows!]);
        setHasMore(NON_PAGED.includes(cat) ? false : newRows.length === DB_PAGE);
        setPage(p);
      }
```

Replace with:

```tsx
      if (newRows !== null && seq === loadSeq.current) {
        setRows((prev) => reset ? newRows! : [...prev, ...newRows!]);
        setHasMore(datHasMore !== null ? datHasMore : NON_PAGED.includes(cat) ? false : newRows.length === DB_PAGE);
        setPage(p);
      }
```

- [ ] **Step 3: `getColumns()` and `DetailView()` cases for the six DAT-table categories**

Find `getColumns()`'s `switch`:

```tsx
    case 'gmcmds':   return [{ key: 'name', label: 'Command', color: 'var(--color-accent)' }, { key: 'group', label: 'Category', color: 'var(--color-text3)' }, { key: 'desc', label: 'Description', color: 'var(--color-text2)' }];
    default: return [];
  }
}
```

Replace with:

```tsx
    case 'gmcmds':   return [{ key: 'name', label: 'Command', color: 'var(--color-accent)' }, { key: 'group', label: 'Category', color: 'var(--color-text3)' }, { key: 'desc', label: 'Description', color: 'var(--color-text2)' }];
    case 'spells': case 'statuses': case 'titles': case 'monster_skills': case 'emotes': case 'augments':
      return [{ key: 'id', label: 'ID', color: 'var(--color-text3)' }, { key: 'name', label: 'Name', color: 'var(--color-text1)' }, { key: 'description', label: 'Description', color: 'var(--color-text2)' }];
    default: return [];
  }
}
```

Find `DetailView()`'s final `if (cat === 'gmcmds')` block (it's the last case before `return null;`):

```tsx
  if (cat === 'gmcmds') {
    return (
      <div>
        {data.group != null && <DRow k="Category" v={String(data.group)} />}
        {data.syntax != null && (
          <div style={{ margin: '8px 0' }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', marginBottom: 4 }}>Syntax</div>
            <code style={{ display: 'block', background: 'var(--color-surface2)', borderRadius: 6, padding: '6px 10px', fontSize: 12, color: 'var(--color-accent)', wordBreak: 'break-all' }}>{String(data.syntax)}</code>
          </div>
        )}
        {data.desc != null && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', marginBottom: 4 }}>Description</div>
            <div style={{ color: 'var(--color-text2)', fontSize: 12, lineHeight: 1.5 }}>{String(data.desc)}</div>
          </div>
        )}
      </div>
    );
  }
  return null;
}
```

Add a new case immediately after it, before `return null;`:

```tsx
  if (cat === 'spells' || cat === 'statuses' || cat === 'titles' || cat === 'monster_skills' || cat === 'emotes' || cat === 'augments') {
    return (
      <div>
        {cat === 'statuses' && (
          <div style={{ marginBottom: 10, textAlign: 'center' }}>
            <img src={`/api/dat/status-icon/${data.id}`} alt="" style={{ maxWidth: 48, maxHeight: 48, imageRendering: 'pixelated' }}
              onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
          </div>
        )}
        <div style={{ color: 'var(--color-text2)', fontSize: 12, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{String(data.description ?? '—')}</div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text3)', fontFamily: 'var(--font-mono)' }}>id {String(data.id)}</div>
      </div>
    );
  }
  return null;
}
```

- [ ] **Step 4: Wire `isClickable`, `hasWiki`, availability, and the sidebar rendering itself**

Find:

```tsx
  const isClickable       = cat === 'items' || cat === 'mobs' || cat === 'npcs' || cat === 'quests' || cat === 'zones' || cat === 'trusts' || cat === 'mounts' || cat === 'abilities' || cat === 'keyitems' || cat === 'gmcmds';
  const hasWiki            = cat === 'items' || cat === 'mobs' || cat === 'npcs' || cat === 'quests' || cat === 'zones';
```

Replace with:

```tsx
  const isClickable       = cat === 'items' || cat === 'mobs' || cat === 'npcs' || cat === 'quests' || cat === 'zones' || cat === 'trusts' || cat === 'mounts' || cat === 'abilities' || cat === 'keyitems' || cat === 'gmcmds' || DAT_TABLE_CATS.has(cat);
  // npcs/mobs/zones have no DAT layer to chain from, so they keep today's
  // manual Wiki button. Items/Abilities/Quests/Key Items get the automatic
  // DAT->Wiki chain instead (Tasks 8-10) and no longer show this button.
  const hasWiki            = cat === 'mobs' || cat === 'npcs' || cat === 'zones';
```

Find the category sidebar's render block:

```tsx
      {/* Category sidebar */}
      <div style={{ width: 160, background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)', padding: '12px 8px', flexShrink: 0, overflowY: 'auto' }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--color-text3)', padding: '4px 8px 10px' }}>Database</div>
        {CATS.map(({ key, label }) => (
          <button key={key} onClick={() => { setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setJobFilter(null); setTypeFilter(null); setQuestLogFilter(null); setDetailRow(null); setDetailData(null); }}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '8px 10px', borderRadius: 7, border: 'none', fontSize: 13,
              fontWeight: cat === key ? 600 : 400,
              background: cat === key ? 'var(--color-surface2)' : 'transparent',
              color: cat === key ? 'var(--color-text1)' : 'var(--color-text3)',
              cursor: 'pointer', marginBottom: 2,
            }}>
            {label}
          </button>
        ))}
      </div>
```

Replace with:

```tsx
      {/* Category sidebar */}
      <div style={{ width: 170, background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)', padding: '12px 8px', flexShrink: 0, overflowY: 'auto' }}>
        {renderCatGroup('Server Data', SERVER_CATS, cat, selectCat)}
        {datEnabled && renderCatGroup('Client Reference', CLIENT_REF_CATS, cat, selectCat)}
      </div>
```

Just above the component's `return (` statement, add the `selectCat` helper (so it's available to the JSX above):

```tsx
  function selectCat(key: Category) {
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setJobFilter(null); setTypeFilter(null); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
  }

```

Add this just before `return (`.

- [ ] **Step 5: Add the `renderCatGroup` helper function**

Find the `chipBtn` helper function (a module-level function below the component):

```tsx
function chipBtn(label: string, value: number | null, current: number | null, set: (v: number | null) => void) {
```

Add a new function immediately **before** it:

```tsx
function renderCatGroup(title: string, cats: CatDef[], current: Category, onSelect: (key: Category) => void) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px', color: 'var(--color-text3)', padding: '4px 8px 8px' }}>{title}</div>
      {cats.map(({ key, label }) => (
        <button key={key} onClick={() => onSelect(key)}
          style={{
            display: 'block', width: '100%', textAlign: 'left',
            padding: '8px 10px', borderRadius: 7, border: 'none', fontSize: 13,
            fontWeight: current === key ? 600 : 400,
            background: current === key ? 'var(--color-surface2)' : 'transparent',
            color: current === key ? 'var(--color-text1)' : 'var(--color-text3)',
            cursor: 'pointer', marginBottom: 2,
          }}>
          {label}
        </button>
      ))}
    </div>
  );
}

function chipBtn(label: string, value: number | null, current: number | null, set: (v: number | null) => void) {
```

- [ ] **Step 6: Build and manual check**

Run: `npm run build:all`
Expected: exits 0 (TypeScript may still complain about `openDetail`/`fetchWiki` not handling the new categories — that's fine, those `if`-chains just won't match the new categories yet and nothing calls them for these six since `isClickable` now includes them for **row highlighting only**; clicking one currently no-ops because `openDetail`'s `if` chain has no branch for them. That's intentional — Step 7 fixes it.)

- [ ] **Step 7: Make the six new categories clickable (list-only rows with no detail fetch needed — the row data already has name+description)**

Find `openDetail()`:

```tsx
      else if (cat === 'npcs' || cat === 'zones' || cat === 'quests' || cat === 'trusts' || cat === 'mounts' || cat === 'abilities' || cat === 'keyitems' || cat === 'gmcmds') setDetailData(row);
```

Replace with:

```tsx
      else if (cat === 'npcs' || cat === 'zones' || cat === 'quests' || cat === 'trusts' || cat === 'mounts' || cat === 'abilities' || cat === 'keyitems' || cat === 'gmcmds' || DAT_TABLE_CATS.has(cat)) setDetailData(row);
```

- [ ] **Step 8: Verify live**

Start the app (`npm run dev` or the running Docker container) and log in. Run:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/login -H 'Content-Type: application/json' -d '{"login":"Sora","password":"YourPassword1"}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
curl -s "http://localhost:3001/api/dat/table/emotes?page=0" -H "Authorization: Bearer $TOKEN" | head -c 300
```

Expected: a JSON object with `rows` containing emote name/description pairs (same data GameData.tsx showed before).

Then in a browser: navigate to `/db`, confirm a "Client Reference" section appears below "Server Data" in the sidebar (only when the DAT is mounted — this dashboard has `ffxi-dat/` present locally), click "Emotes", confirm rows load and clicking one shows its description in the right-hand detail panel.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/pages/Database.tsx
git commit -m "$(cat <<'EOF'
database: port Spells/Statuses/Titles/Monster Skills/Emotes/Augments in

Adds a "Client Reference" sidebar group (shown only when the DAT is
mounted) for the six DAT-only name+description categories, reusing
Database's existing table+detail-panel shell instead of GameData's
chip+inline-expand layout. Dialog (the structural outlier — per-zone
line dumps, not a name/description table) is handled in the next task.
EOF
)"
```

---

## Task 7: Dialog special mode

**Files:**
- Modify: `client/src/components/pages/Database.tsx`

**Interfaces:**
- Consumes: `api.datDialogZones()`, `api.datDialog(zone, q, page)` (both pre-existing).

- [ ] **Step 1: Add dialog zone state and the `isDialog` flag**

Find the state block from Task 6 Step 2 (`const [datEnabled, ...`). Add right after it:

```tsx
  const [dzones, setDzones] = useState<{ id: number; name: string }[]>([]);
  const [dialogZone, setDialogZone] = useState<number | null>(null);
  const isDialog = cat === 'dialog';
```

- [ ] **Step 2: Load the dialog zone list once, when entering dialog mode**

Find the `useEffect` that fetches `api.datStatus()` (added in Task 6 Step 2). Add right after it:

```tsx
  useEffect(() => {
    if (!isDialog || dzones.length) return;
    api.datDialogZones().then(r => { setDzones(r.zones); if (r.zones.length && dialogZone == null) setDialogZone(r.zones[0].id); }).catch(() => {});
  }, [isDialog, dzones.length, dialogZone]);
```

- [ ] **Step 3: Branch `load()` for dialog**

Find the branch added in Task 6 Step 2:

```tsx
      if (DAT_TABLE_CATS.has(cat)) {
        const r = await api.datTable(cat, search, p);
        newRows = r.rows;
        datHasMore = r.hasMore;
      }
      else if (cat === 'items')          newRows = (await api.dbItems(params)) as unknown as unknown[];
```

Replace with:

```tsx
      if (isDialog) {
        if (dialogZone == null) { newRows = []; datHasMore = false; }
        else {
          const r = await api.datDialog(dialogZone, search, p);
          newRows = r.rows.map(x => ({ id: x.id, name: x.text }));
          datHasMore = r.hasMore;
        }
      }
      else if (DAT_TABLE_CATS.has(cat)) {
        const r = await api.datTable(cat, search, p);
        newRows = r.rows;
        datHasMore = r.hasMore;
      }
      else if (cat === 'items')          newRows = (await api.dbItems(params)) as unknown as unknown[];
```

Find the `useEffect` that calls `load(true)`:

```tsx
  useEffect(() => { load(true); }, [cat, zoneFilter, jobFilter, typeFilter, questLogFilter, sortKey, sortDir]); // eslint-disable-line react-hooks/exhaustive-deps
```

Replace with:

```tsx
  useEffect(() => { load(true); }, [cat, zoneFilter, jobFilter, typeFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps
```

And the `load` callback's dependency array — find:

```tsx
  }, [cat, page, search, zoneFilter, jobFilter, typeFilter, questLogFilter, sortKey, sortDir]);
```

Replace with:

```tsx
  }, [cat, page, search, zoneFilter, jobFilter, typeFilter, questLogFilter, sortKey, sortDir, dialogZone]);
```

- [ ] **Step 4: Toolbar — swap the zone filter dropdown for the dialog zone picker, and disable clicking rows**

Find:

```tsx
          {hasZoneFilter && (
            <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)}
              style={{ background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '7px 9px', borderRadius: 7, fontSize: 12 }}>
              <option value="">All zones</option>
              {zones.map((z) => <option key={z.zoneid} value={z.name}>{z.name}</option>)}
            </select>
          )}
```

Add immediately after:

```tsx
          {isDialog && (
            <select value={dialogZone ?? ''} onChange={(e) => setDialogZone(Number(e.target.value))}
              style={{ background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '7px 9px', borderRadius: 7, fontSize: 12 }}>
              {dzones.map((z) => <option key={z.id} value={z.id}>{z.name.replace(/_/g, ' ')}</option>)}
            </select>
          )}
```

Find `getColumns()`'s new DAT-table case from Task 6 Step 3:

```tsx
    case 'spells': case 'statuses': case 'titles': case 'monster_skills': case 'emotes': case 'augments':
      return [{ key: 'id', label: 'ID', color: 'var(--color-text3)' }, { key: 'name', label: 'Name', color: 'var(--color-text1)' }, { key: 'description', label: 'Description', color: 'var(--color-text2)' }];
    default: return [];
```

Replace with:

```tsx
    case 'spells': case 'statuses': case 'titles': case 'monster_skills': case 'emotes': case 'augments':
      return [{ key: 'id', label: 'ID', color: 'var(--color-text3)' }, { key: 'name', label: 'Name', color: 'var(--color-text1)' }, { key: 'description', label: 'Description', color: 'var(--color-text2)' }];
    case 'dialog':
      return [{ key: 'id', label: 'ID', color: 'var(--color-text3)' }, { key: 'name', label: 'Text', color: 'var(--color-text2)' }];
    default: return [];
```

`isClickable` from Task 6 Step 4 must **not** include `'dialog'` — double-check it reads `DAT_TABLE_CATS.has(cat)` (a `Set` that does not contain `'dialog'`, since `DAT_TABLE_CATS` was defined without it in Task 6 Step 1) and not a check that would also match dialog. No further change needed there; this step is a verification, not an edit.

- [ ] **Step 5: Verify live**

In the browser: click "Dialog" in the Client Reference group, confirm a zone dropdown appears in place of the zone filter, switching zones reloads rows, and clicking a row does nothing (no detail panel opens, matching the old GameData.tsx behavior).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/pages/Database.tsx
git commit -m "database: port Dialog's per-zone special mode from Game Data"
```

---

## Task 8: Items — DAT icon + DAT→Wiki auto-fallback description

**Files:**
- Modify: `client/src/components/pages/Database.tsx`

**Interfaces:**
- Consumes: `api.datEnrich('items', id)`, `api.dbItemWiki(name)` (both from Task 5); the module-level `Enrichment` type added in Task 6 Step 1.
- Produces: `enrichment` component state, typed `Enrichment`, reused identically by Tasks 9–10 for Abilities/Key Items/Quests.

- [ ] **Step 1: Add shared enrichment state**

Find the state declared in Task 6/7 (`const isDialog = ...`). Add right after it:

```tsx
  // Shared by Items/Abilities/Key Items/Quests: DAT-then-Wiki auto fallback
  // for description text the DB never stores. `source` records which step
  // actually supplied the text so the detail panel can label it. (Enrichment
  // is the module-level type added in Task 6 Step 1 — DetailView and
  // EnrichedDescription below are module-level functions and need the same
  // shape, so it can't be declared component-local.)
  const [enrichment, setEnrichment] = useState<Enrichment>({ loading: false, source: null, text: null });
```

- [ ] **Step 2: Reset enrichment state whenever the detail panel changes row/closes**

Find `openDetail()`'s opening line:

```tsx
  async function openDetail(row: Record<string, unknown>) {
    setDetailRow(row); setDetailData(null); setDetailLoading(true); setWikiData(null); setScriptData(null); setItemImageUrl(null);
```

Replace with:

```tsx
  async function openDetail(row: Record<string, unknown>) {
    setDetailRow(row); setDetailData(null); setDetailLoading(true); setWikiData(null); setScriptData(null); setItemImageUrl(null);
    setEnrichment({ loading: false, source: null, text: null });
```

Find the panel's close button:

```tsx
            <button onClick={() => { setDetailRow(null); setDetailData(null); setWikiData(null); setScriptData(null); }} className="btn btn-ghost btn-xs">✕</button>
```

Replace with:

```tsx
            <button onClick={() => { setDetailRow(null); setDetailData(null); setWikiData(null); setScriptData(null); setEnrichment({ loading: false, source: null, text: null }); }} className="btn btn-ghost btn-xs">✕</button>
```

- [ ] **Step 3: Fetch the Items DAT→Wiki chain inside `openDetail`**

Find the `items` branch in `openDetail()`:

```tsx
      if (cat === 'items') {
        const [detail, img] = await Promise.all([
          api.dbItemDetail(Number(row.itemid)),
          api.uploadCheck('item', Number(row.itemid)).catch(() => ({ exists: false, url: null })),
        ]);
        setDetailData(detail);
        setItemImageUrl(img.exists ? img.url : null);
      } else if (cat === 'mobs') {
```

Replace with:

```tsx
      if (cat === 'items') {
        const [detail, img] = await Promise.all([
          api.dbItemDetail(Number(row.itemid)),
          api.uploadCheck('item', Number(row.itemid)).catch(() => ({ exists: false, url: null })),
        ]);
        setDetailData(detail);
        setItemImageUrl(img.exists ? img.url : null);
        fetchItemEnrichment(Number(row.itemid), String(row.name ?? ''));
      } else if (cat === 'mobs') {
```

- [ ] **Step 4: Add the `fetchItemEnrichment` function**

Add this new function right after `openDetail()` (before `fetchWiki()`):

```tsx
  async function fetchItemEnrichment(itemId: number, dbName: string) {
    setEnrichment({ loading: true, source: null, text: null });
    try {
      const dat = await api.datEnrich('items', itemId);
      if (dat?.description) {
        setEnrichment({ loading: false, source: 'dat', text: dat.description, datId: dat.datId });
        return;
      }
      const wiki = await api.dbItemWiki(dbName);
      if (wiki?.description) {
        setEnrichment({ loading: false, source: 'wiki', text: wiki.description, wikiUrl: wiki.wikiUrl });
        return;
      }
      setEnrichment({ loading: false, source: 'none', text: null });
    } catch (_) {
      setEnrichment({ loading: false, source: 'none', text: null });
    }
  }

```

- [ ] **Step 5: Show the DAT icon and the enrichment block in the Items `DetailView`**

Find the `items` `DetailView` case's opening:

```tsx
  if (cat === 'items') {
    const slots = Number(data.slot ?? 0);
    const SLOT_NAMES = ['Main','Sub','Range','Ammo','Head','Body','Hands','Legs','Feet','Neck','Waist','L.Ear','R.Ear','L.Ring','R.Ring','Back'];
    const equippedSlots = SLOT_NAMES.filter((_, i) => (slots >> i) & 1);
    const jobsMask = Number(data.jobs ?? 0);
    const jobList = JOB_ABBR.slice(1).filter((_, i) => (jobsMask >> (i + 1)) & 1);
    return (
      <div>
        {itemImageUrl && (
          <div style={{ marginBottom: 10, textAlign: 'center' }}>
            <img src={itemImageUrl} alt={String(data.name ?? '')} style={{ maxWidth: 64, maxHeight: 64, borderRadius: 6, border: '1px solid var(--color-border)' }} />
          </div>
        )}
```

`DetailView` needs the `enrichment` state, which currently isn't a prop. Find its signature:

```tsx
function DetailView({ data, cat, itemImageUrl }: { data: Record<string, unknown>; cat: Category; itemImageUrl?: string | null }) {
```

Replace with:

```tsx
function DetailView({ data, cat, itemImageUrl, enrichment }: { data: Record<string, unknown>; cat: Category; itemImageUrl?: string | null; enrichment: Enrichment }) {
```

Now update its only call site. Find:

```tsx
            {detailData && <DetailView data={detailData} cat={cat} itemImageUrl={itemImageUrl} />}
```

Replace with:

```tsx
            {detailData && <DetailView data={detailData} cat={cat} itemImageUrl={itemImageUrl} enrichment={enrichment} />}
```

Back in the `items` case, replace:

```tsx
    return (
      <div>
        {itemImageUrl && (
          <div style={{ marginBottom: 10, textAlign: 'center' }}>
            <img src={itemImageUrl} alt={String(data.name ?? '')} style={{ maxWidth: 64, maxHeight: 64, borderRadius: 6, border: '1px solid var(--color-border)' }} />
          </div>
        )}
```

with:

```tsx
    return (
      <div>
        {itemImageUrl ? (
          <div style={{ marginBottom: 10, textAlign: 'center' }}>
            <img src={itemImageUrl} alt={String(data.name ?? '')} style={{ maxWidth: 64, maxHeight: 64, borderRadius: 6, border: '1px solid var(--color-border)' }} />
          </div>
        ) : (
          <div style={{ marginBottom: 10, textAlign: 'center' }}>
            <img src={`/api/dat/icon/${data.itemid}`} alt="" style={{ maxWidth: 64, maxHeight: 64, borderRadius: 6, border: '1px solid var(--color-border)', imageRendering: 'pixelated' }}
              onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
          </div>
        )}
        <EnrichedDescription enrichment={enrichment} idMismatchCaveat={null} />
```

(A custom-uploaded image still takes priority; the DAT icon is the fallback, shown via an `<img>` that quietly hides itself via `onError` if there's no DAT match — same pattern already used for icons elsewhere in this file.)

- [ ] **Step 6: Add the shared `EnrichedDescription` render helper**

Add this new function right after `DRow` (before `DetailView`):

```tsx
// Shared by Items/Abilities/Key Items detail views: renders whichever
// source (DAT, Wiki, or neither) resolved the description, with a small
// caption naming the source. `idMismatchCaveat`, when non-null, is
// appended to the DAT caption — used by Abilities/Key Items, which match
// by name across two different id spaces (see enrichment fetch functions).
function EnrichedDescription({ enrichment, idMismatchCaveat }: { enrichment: Enrichment; idMismatchCaveat: string | null }) {
  if (enrichment.loading) {
    return <div style={{ fontSize: 12, color: 'var(--color-text3)', marginBottom: 8 }}>Loading…</div>;
  }
  if (enrichment.source === 'none' || enrichment.source === null) {
    return <div style={{ fontSize: 12, color: 'var(--color-text3)', marginBottom: 8 }}>No description available — not on this server's DAT or BG-Wiki.</div>;
  }
  const caption = enrichment.source === 'dat'
    ? (idMismatchCaveat ? `From client DAT (${idMismatchCaveat})` : 'From client DAT')
    : enrichment.source === 'wiki' ? 'From BG-Wiki' : 'From the quest script';
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--color-text2)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{enrichment.text}</div>
      <div style={{ marginTop: 4, fontSize: 10, color: 'var(--color-text3)' }}>{caption}</div>
      {enrichment.wikiUrl && (
        <a href={enrichment.wikiUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--color-accent)' }}>View on BG-Wiki ↗</a>
      )}
    </div>
  );
}

```

- [ ] **Step 7: Build and verify live**

Run: `npm run build:all`
Expected: exits 0.

Then, with the app running and logged in, open Database → Items, click "Bronze Subligar" (or search for it). Confirm the detail panel shows a pixelated DAT icon and "DEF:3" with a "From client DAT" caption. Then click an item you're confident has no DAT flavor text but does have a BG-Wiki page (any obscure quest-reward item works) and confirm it shows "From BG-Wiki" instead, with a working "View on BG-Wiki ↗" link. Confirm the manual "Wiki" button is gone from the Items detail panel header (still present for NPCs/Mobs/Zones).

- [ ] **Step 8: Commit**

```bash
git add client/src/components/pages/Database.tsx
git commit -m "$(cat <<'EOF'
database: auto DAT->Wiki description chain for Items

Items detail now shows the DAT icon and flavor text automatically (no
manual click), falling back to BG-Wiki only when the DAT has no
description for that item id, and showing an explicit note when neither
source has anything. Whichever source resolved replaces the removed
manual Wiki button with an inline "From client DAT"/"From BG-Wiki"
caption instead.
EOF
)"
```

---

## Task 9: Abilities & Key Items — DAT→Wiki auto-fallback with id-mismatch caveat

**Files:**
- Modify: `client/src/components/pages/Database.tsx`

**Interfaces:**
- Consumes: `api.datEnrich('abilities'|'key_items', name)`, `api.dbAbilityWiki(name)`, `api.dbKeyItemWiki(name)` (Task 5); `EnrichedDescription`, `Enrichment` type (Task 8).

- [ ] **Step 1: Fetch enrichment for Abilities and Key Items in `openDetail`**

Find (this `else if` chain was extended in Task 6 Step 7):

```tsx
      else if (cat === 'npcs' || cat === 'zones' || cat === 'quests' || cat === 'trusts' || cat === 'mounts' || cat === 'abilities' || cat === 'keyitems' || cat === 'gmcmds' || DAT_TABLE_CATS.has(cat)) setDetailData(row);
```

Replace with:

```tsx
      else if (cat === 'abilities') {
        setDetailData(row);
        fetchNameMatchedEnrichment('abilities', String(row.name ?? ''), api.dbAbilityWiki);
      }
      else if (cat === 'keyitems') {
        setDetailData(row);
        fetchNameMatchedEnrichment('key_items', String(row.name ?? ''), api.dbKeyItemWiki);
      }
      else if (cat === 'npcs' || cat === 'zones' || cat === 'quests' || cat === 'trusts' || cat === 'mounts' || cat === 'gmcmds' || DAT_TABLE_CATS.has(cat)) setDetailData(row);
```

- [ ] **Step 2: Add the shared name-matched enrichment fetcher**

Add this function right after `fetchItemEnrichment` (Task 8 Step 4):

```tsx
  async function fetchNameMatchedEnrichment(datCat: 'abilities' | 'key_items', dbName: string, wikiFetch: (name: string) => Promise<{ description?: string | null; wikiUrl?: string } | null>) {
    setEnrichment({ loading: true, source: null, text: null });
    try {
      const dat = await api.datEnrich(datCat, dbName);
      if (dat?.description) {
        setEnrichment({ loading: false, source: 'dat', text: dat.description, datId: dat.datId });
        return;
      }
      const wiki = await wikiFetch(dbName);
      if (wiki?.description) {
        setEnrichment({ loading: false, source: 'wiki', text: wiki.description, wikiUrl: wiki.wikiUrl });
        return;
      }
      setEnrichment({ loading: false, source: 'none', text: null });
    } catch (_) {
      setEnrichment({ loading: false, source: 'none', text: null });
    }
  }

```

- [ ] **Step 3: Render `EnrichedDescription` in the Abilities and Key Items `DetailView` cases, with the id-mismatch caveat**

Find:

```tsx
  if (cat === 'abilities') {
    const ACTION_TYPE_MAP: Record<number, string> = { 3: 'Ranged', 6: 'Job Ability', 13: 'Pet Command' };
    const fmtTicks = (t: number) => t >= 3600 ? `${t/3600}h` : t >= 60 ? `${Math.floor(t/60)}m${t%60 ? ` ${t%60}s` : ''}` : `${t}s`;
    return (
      <div>
        {data.job       != null && <DRow k="Job" v={JOB_ABBR[Number(data.job)] ?? String(data.job)} />}
```

Replace with:

```tsx
  if (cat === 'abilities') {
    const ACTION_TYPE_MAP: Record<number, string> = { 3: 'Ranged', 6: 'Job Ability', 13: 'Pet Command' };
    const fmtTicks = (t: number) => t >= 3600 ? `${t/3600}h` : t >= 60 ? `${Math.floor(t/60)}m${t%60 ? ` ${t%60}s` : ''}` : `${t}s`;
    const abilityCaveat = enrichment.source === 'dat' && enrichment.datId != null ? `id ${enrichment.datId}, matched by name — server id is ${data.abilityId}` : null;
    return (
      <div>
        <EnrichedDescription enrichment={enrichment} idMismatchCaveat={abilityCaveat} />
        {data.job       != null && <DRow k="Job" v={JOB_ABBR[Number(data.job)] ?? String(data.job)} />}
```

Find:

```tsx
  if (cat === 'keyitems') {
    return (
      <div>
        {data.id   != null && <DRow k="Key Item ID" v={String(data.id)} />}
        {data.name != null && <DRow k="Name" v={fmtName(String(data.name))} />}
      </div>
    );
  }
```

Replace with:

```tsx
  if (cat === 'keyitems') {
    const keyItemCaveat = enrichment.source === 'dat' && enrichment.datId != null ? `id ${enrichment.datId}, matched by name — server id is ${data.id}` : null;
    return (
      <div>
        <EnrichedDescription enrichment={enrichment} idMismatchCaveat={keyItemCaveat} />
        {data.id   != null && <DRow k="Key Item ID" v={String(data.id)} />}
        {data.name != null && <DRow k="Name" v={fmtName(String(data.name))} />}
      </div>
    );
  }
```

- [ ] **Step 4: Build and verify live**

Run: `npm run build:all`
Expected: exits 0.

With the app running: Database → Abilities → click "Provoke". Confirm the detail panel shows "Goads an enemy into attacking you." with caption "From client DAT (id 547, matched by name — server id is 35)". Then Database → Key Items → click "Zeruhn Report" — since the key_items DAT table has no description resource (see Task 1's note), this should fall straight through to "From BG-Wiki" if BG-Wiki has a page, or the explicit "not available" note otherwise; confirm it does **not** show a DAT caption with fabricated text.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/pages/Database.tsx
git commit -m "$(cat <<'EOF'
database: auto DAT->Wiki chain for Abilities and Key Items

Same auto-fallback pattern as Items, but matched by normalized name
instead of id (server and client use different id spaces for these
two categories — verified: DB ability 35 "Provoke" is DAT id 547). The
DAT caption surfaces that id mismatch inline so a name-matched entry is
never mistaken for a guaranteed exact correspondence. Neither category
had a Wiki lookup before this session; both do now.
EOF
)"
```

---

## Task 10: Quests — inline walkthrough + Wiki fallback

**Files:**
- Modify: `client/src/components/pages/Database.tsx`

**Interfaces:**
- Consumes: `reward.walkthrough` (already present on every `/api/db/quests` row via `QUEST_REWARDS`, added in a prior session — no new fetch), `api.dbQuestWiki(name)` (pre-existing).

- [ ] **Step 1: Fetch the Wiki fallback only when `reward.walkthrough` is empty**

Find the `quests` branch inside `openDetail()`'s `else if` chain (after Task 9's edits, this reads `cat === 'npcs' || cat === 'zones' || cat === 'quests' || ...`). Split `quests` out:

```tsx
      else if (cat === 'npcs' || cat === 'zones' || cat === 'quests' || cat === 'trusts' || cat === 'mounts' || cat === 'gmcmds' || DAT_TABLE_CATS.has(cat)) setDetailData(row);
```

Replace with:

```tsx
      else if (cat === 'quests') {
        setDetailData(row);
        const steps = ((row.reward as Record<string, unknown> | null)?.walkthrough as string[] | undefined) || [];
        if (steps.length) {
          setEnrichment({ loading: false, source: 'script', text: steps.map((s, i) => `${i + 1}. ${s}`).join('\n') });
        } else {
          setEnrichment({ loading: true, source: null, text: null });
          try {
            const wiki = await api.dbQuestWiki(String(row.name ?? ''));
            setEnrichment(wiki?.description
              ? { loading: false, source: 'wiki', text: wiki.description, wikiUrl: wiki.wikiUrl }
              : { loading: false, source: 'none', text: null });
          } catch (_) {
            setEnrichment({ loading: false, source: 'none', text: null });
          }
        }
      }
      else if (cat === 'npcs' || cat === 'zones' || cat === 'trusts' || cat === 'mounts' || cat === 'gmcmds' || DAT_TABLE_CATS.has(cat)) setDetailData(row);
```

- [ ] **Step 2: Render `EnrichedDescription` in the Quests `DetailView` case**

Find:

```tsx
  if (cat === 'quests') {
    return (
      <div>
        {data.questId  != null && <DRow k="Quest ID" v={String(data.questId)} />}
        {data.logName  != null && <DRow k="Area" v={String(data.logName)} />}
        {data.logId    != null && <DRow k="Log ID" v={String(data.logId)} />}
      </div>
    );
  }
```

Replace with:

```tsx
  if (cat === 'quests') {
    return (
      <div>
        <EnrichedDescription enrichment={enrichment} idMismatchCaveat={null} />
        {data.questId  != null && <DRow k="Quest ID" v={String(data.questId)} />}
        {data.logName  != null && <DRow k="Area" v={String(data.logName)} />}
        {data.logId    != null && <DRow k="Log ID" v={String(data.logId)} />}
      </div>
    );
  }
```

`EnrichedDescription`'s `enrichment.text` for the `'script'` source is pre-formatted as a numbered `\n`-joined string in Step 1, so its existing `whiteSpace: 'pre-wrap'` rendering already lays it out as one step per line — no separate list-rendering branch needed.

- [ ] **Step 3: Remove the now-redundant Wiki button for quests only**

`hasWiki` was set in Task 6 Step 4 to `cat === 'mobs' || cat === 'npcs' || cat === 'zones'` — quests was already excluded there in that same edit, so no further change is needed here. (This step is a verification, not an edit — confirm `hasWiki` in the current file does **not** include `'quests'`.)

- [ ] **Step 4: Build and verify live**

Run: `npm run build:all`
Expected: exits 0.

With the app running: Database → Quests → click "A Sentry's Peril". Confirm the detail panel shows the 4-step walkthrough (same text verified live in a prior session) with caption "From the quest script", no manual Wiki button, and the "Script" button still present and working (full Lua source, untouched). Then click a quest known to have no script walkthrough comments (e.g. "Promotion: Corporal", confirmed empty earlier this session) and confirm it automatically shows BG-Wiki text instead, labeled "From BG-Wiki".

- [ ] **Step 5: Commit**

```bash
git add client/src/components/pages/Database.tsx
git commit -m "$(cat <<'EOF'
database: render quest walkthrough inline, auto-fallback to wiki

reward.walkthrough was already returned inline by /api/db/quests from a
prior session's work — this just renders it in the detail panel instead
of requiring a manual Wiki click, and only fetches Wiki when the script
has no walkthrough comments. Manual Wiki button removed for quests
(Script button, which dumps the full Lua source, is untouched).
EOF
)"
```

---

## Task 11: Delete GameData.tsx and its route/nav entry

**Files:**
- Delete: `client/src/components/pages/GameData.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/components/layout/Sidebar.tsx`
- Modify: `client/src/api.ts`

**Interfaces:** none (pure removal).

- [ ] **Step 1: Delete the file**

```bash
git rm client/src/components/pages/GameData.tsx
```

- [ ] **Step 2: Remove the route and import from `App.tsx`**

Find:

```tsx
import { GameData } from './components/pages/GameData';
```

Delete that line.

Find:

```tsx
          <Route path="gamedata" element={<GameData />} />
```

Delete that line.

- [ ] **Step 3: Remove the nav entry from `Sidebar.tsx`**

Find:

```tsx
  { to: '/gamedata', icon: '🎮', label: 'Game Data',  perm: 'view:db' },
```

Delete that line.

- [ ] **Step 4: Remove the now-dead `dbQuestWalkthrough` helper and check for other orphaned `api.ts` helpers**

`datStatus`, `datTable`, `datDialogZones`, `datDialog` are all still used by `Database.tsx` (Tasks 6–7) — keep them. `dbQuestWalkthrough`, however, has had no working backend route since Task 3 (which deleted `/api/db/quests/walkthrough`) and, as of Step 1 above, no caller either — `GameData.tsx` was its last one. Open `client/src/api.ts` and find:

```ts
  dbQuestWalkthrough: (name: string) => req<{ steps: string[]; logId: number | null; questId: number | null }>(`/api/db/quests/walkthrough?name=${encodeURIComponent(name)}`),
```

Delete that line. Then run a grep to confirm nothing else references it or any other GameData-only helper:

```bash
grep -rn "dbQuestWalkthrough" client/src/ src/
```

Expected: no output. If anything shows up, stop and investigate before proceeding — it means a reference was missed.

- [ ] **Step 5: Full client build**

Run: `npm run build:all`
Expected: exits 0, no unresolved imports.

- [ ] **Step 6: Verify live**

In the browser: confirm the left nav no longer shows a "Game Data" entry, and navigating directly to `/gamedata` falls through to the app's catch-all route (`<Navigate to="/" replace />` in `App.tsx`) rather than erroring.

- [ ] **Step 7: Commit**

```bash
git add -A client/src/App.tsx client/src/components/layout/Sidebar.tsx client/src/components/pages/GameData.tsx
git commit -m "$(cat <<'EOF'
client: delete Game Data tab, now merged into Database

/gamedata and its nav entry are gone; unknown routes already fall
through to the dashboard home via the existing catch-all route.
EOF
)"
```

---

## Task 12: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full build + test**

```bash
npm run build:all
npm test
```

Expected: both exit 0; test count is 87 + whatever Task 2 added, all passing.

- [ ] **Step 2: Deploy**

```bash
docker compose build && docker compose up -d --force-recreate
```

Expected: container recreated successfully (per CLAUDE.md, this is the only sanctioned deploy path).

- [ ] **Step 3: Backend smoke test**

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/login -H 'Content-Type: application/json' -d '{"login":"Sora","password":"YourPassword1"}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).token))")
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3001/api/dat/table/items" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3001/api/dat/enrich/key_items/Zeruhn%20Report" -H "Authorization: Bearer $TOKEN"
```

Expected: first call returns `404` (items is no longer a browsable DAT table). Second call returns `null` (the key_items DAT table has no description resource, per Task 1's note) — both confirm the "not browsable, enrichment-only" repurposing landed correctly.

- [ ] **Step 4: Full Playwright walkthrough**

Reuse the Playwright pattern already established this session (`/tmp/claude-*/scratchpad/verify_*.js` — chromium via `playwright-core`, login via the test account, navigate, screenshot). Cover every scenario from the spec's Testing section in one script:

1. Log in, navigate to `/db`.
2. Confirm the sidebar shows "Server Data" and "Client Reference" section headers.
3. Click Items, search "Bronze Subligar", open detail: assert page text contains `"DEF:3"` and `"From client DAT"`.
4. Click Abilities, search "Provoke", open detail: assert page text contains `"Goads an enemy"` and `"matched by name"`.
5. Click Quests, search "A Sentry's Peril", open detail: assert page text contains `"From the quest script"` and `"Talk to Glenne"`.
6. Click Quests, search "Promotion: Corporal", open detail: assert page text contains `"From BG-Wiki"` or the explicit "not available" note (whichever BG-Wiki returns live).
7. Click Emotes (Client Reference group), confirm rows load and a detail panel opens on click.
8. Click Dialog, confirm the zone `<select>` renders in place of the search-adjacent zone filter, and switching zones reloads rows.
9. Confirm no `/gamedata` link exists anywhere in the rendered sidebar HTML.

Expected: all assertions pass; screenshot each step to a scratchpad PNG per the existing convention in this session.

- [ ] **Step 5: Report and hand back**

Summarize the verification results to the user (pass/fail per scenario, any surprises), matching the tone/format already used for prior verification passes this session (e.g. the `verify_gamedata_quest_walkthrough.js` report).
