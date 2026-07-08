# NPC Dialogue Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show real, per-NPC in-game dialogue text in the Database tab's NPC detail panel, extracted from each NPC's own LSB Lua script and resolved against its zone's `IDs.lua` text table.

**Architecture:** A new, self-contained backend module (`src/npc-dialog.ts`) locates an NPC's script by (zone, name), extracts every `.text.CONST_NAME` reference it makes, and resolves each against a lazily-cached parse of that zone's `IDs.lua` `text` table (which carries the actual English text as an inline comment on every entry). A new route (`GET /api/db/npcs/dialog`) exposes this; the client auto-fetches it when an NPC's detail panel opens, the same trigger point already used for the existing Quest walkthrough auto-fetch.

**Tech Stack:** Node.js `fs`/`path` (backend, `src/npc-dialog.ts`, `src/routes/db.ts`), React 18 + TypeScript (client, `client/src/components/pages/Database.tsx`), Vitest (new unit tests for the two pure parsing pieces).

## Global Constraints

- All backend changes go in `src/routes/*.ts` / `src/*.ts` — never the deprecated root `server.js` (per repo CLAUDE.md).
- This feature reads from `SERVER_SCRIPTS_ROOT` (`src/catalog.ts:818`, env `LSB_SERVER_SCRIPTS_DIR`, default `/ffxi-server-scripts`) — **not** `LSB_SCRIPTS_DIR` (`/ffxi-scripts`). Verified directly against the running container: only `SERVER_SCRIPTS_ROOT`'s mount contains a `zones/` subtree (`zones/<Zone>/npcs/*.lua`, `zones/<Zone>/IDs.lua`); `LSB_SCRIPTS_DIR` does not. Using the wrong constant silently produces "no dialogue found" for every NPC in production while appearing to work in any test that reads the host filesystem directly — this is the single most important fact in this plan, get it right in Task 1.
- No new client-side test infrastructure — this codebase's `vitest.config.ts` only covers `tests/**/*.test.ts` against backend `src/`; client changes are verified live (Playwright), not unit-tested, matching every prior `Database.tsx` change in this repo's history.
- Test credentials for live verification: `Sora` / `YourPassword1` (throwaway, admin tier).
- Endpoint is `requireAuth` only, not admin-gated (per design spec decision 4) — it returns extracted text, not raw script source.
- Show **all** referenced dialogue lines, not just the first (per design spec decision 1). Show an explicit "No dialogue found for this NPC." note when nothing resolves (per design spec decision 2) — never a silently-omitted section.

---

### Task 1: Backend — `src/npc-dialog.ts` module + unit tests

**Files:**
- Create: `src/npc-dialog.ts`
- Test: `tests/unit/npc-dialog.test.ts`

**Interfaces:**
- Consumes: `SERVER_SCRIPTS_ROOT` (exported `string`, `src/catalog.ts:818`) — read-only, not modified.
- Produces (consumed by Task 2):
  - `export interface NpcDialogLine { const: string; id: number; text: string }`
  - `export interface NpcDialogResult { found: boolean; scriptPath?: string; lines: NpcDialogLine[] }`
  - `export function resolveNpcDialog(zoneName: string, npcName: string): NpcDialogResult`
  - Also exported for direct unit testing (pure, no filesystem access): `export function parseIdsTextTable(source: string): Record<string, { id: number; text: string }>` and `export function extractTextRefs(scriptSource: string): string[]`.

- [ ] **Step 1: Write the failing tests for the two pure parsing functions**

Create `tests/unit/npc-dialog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseIdsTextTable, extractTextRefs } from '../../src/npc-dialog';

describe('parseIdsTextTable', () => {
  it('parses const = id, -- comment entries inside the text table', () => {
    const source = `
zones[xi.zone.SOUTHERN_SAN_DORIA_S] =
{
    text =
    {
        ITEM_DELIVERY_DIALOG = 11237, -- If'n ye have goods tae deliver, then Nembet be yer man!
        HOMEPOINT_SET        = 11136, -- Home point set!
    },
    mob =
    {
    },
    npc =
    {
        CAMPAIGN_NPC_OFFSET = GetFirstID('Saphiriance_TK'), -- not in the text table, must not appear
    },
}
`;
    const table = parseIdsTextTable(source);
    expect(table.ITEM_DELIVERY_DIALOG).toEqual({ id: 11237, text: "If'n ye have goods tae deliver, then Nembet be yer man!" });
    expect(table.HOMEPOINT_SET).toEqual({ id: 11136, text: 'Home point set!' });
    expect(table.CAMPAIGN_NPC_OFFSET).toBeUndefined();
  });

  it('handles an entry with no trailing comment', () => {
    const source = `
text =
{
    CONQUEST_BASE = 0,
    ASSIST_CHANNEL = 6539, -- You will be able to use the Assist Channel...
},
`;
    const table = parseIdsTextTable(source);
    expect(table.CONQUEST_BASE).toEqual({ id: 0, text: '' });
    expect(table.ASSIST_CHANNEL?.id).toBe(6539);
  });

  it('returns an empty object when there is no text table at all', () => {
    expect(parseIdsTextTable('zones[xi.zone.X] = { mob = {}, npc = {} }')).toEqual({});
  });
});

describe('extractTextRefs', () => {
  it('extracts every .text.CONST_NAME reference, deduped, in first-seen order', () => {
    const source = `
local ID = zones[xi.zone.SOUTHERN_SAN_DORIA_S]
entity.onTrigger = function(player, npc)
    if player:getQuestStatus(...) then
        player:showText(npc, ID.text.ITEM_DELIVERY_DIALOG)
    else
        player:showText(npc, ID.text.HOMEPOINT_SET)
        player:showText(npc, ID.text.ITEM_DELIVERY_DIALOG)
    end
end
`;
    expect(extractTextRefs(source)).toEqual(['ITEM_DELIVERY_DIALOG', 'HOMEPOINT_SET']);
  });

  it('returns an empty array when the script references no .text.* constants', () => {
    expect(extractTextRefs('entity.onTrigger = function(player, npc) player:tradeComplete(npc) end')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/npc-dialog.test.ts`
Expected: FAIL — `Cannot find module '../../src/npc-dialog'` (the file doesn't exist yet).

- [ ] **Step 3: Write `src/npc-dialog.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/npc-dialog.test.ts`
Expected: PASS, 5/5 tests.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

Run: `npm test`
Expected: PASS, all test files including the new one (was 96/96 before this task — expect 101/101 after, 5 new tests).

- [ ] **Step 6: Live sanity check against the real mounted scripts tree**

This step exists because Task 1's design already caught one wrong-constant bug during planning — confirm the real function against real data before building the route on top of it:

```bash
cd /home/sora/Downloads/ffxi-dashboard
npx tsx -e "
import { resolveNpcDialog } from './src/npc-dialog';
console.log(JSON.stringify(resolveNpcDialog('Southern_San_dOria_[S]', 'Nembet'), null, 2));
"
```

(If `tsx` isn't available, use `npx ts-node` instead — same syntax.)

Expected output includes `"found": true`, a `"scriptPath"` ending in `Nembet.lua`, and a `lines` array containing an entry with `"const": "ITEM_DELIVERY_DIALOG"`, `"id": 11237`, and text starting with `"If'n ye have goods tae deliver"`.

- [ ] **Step 7: Commit**

```bash
git add src/npc-dialog.ts tests/unit/npc-dialog.test.ts
git commit -m "$(cat <<'EOF'
feat: add NPC dialogue extraction module

Resolves an NPC's script (by zone + name) to the dialogue text it
references, by extracting every .text.CONST_NAME the script uses and
looking each up in that zone's IDs.lua text table, which carries the
actual English text as an inline comment on every entry.

Uses SERVER_SCRIPTS_ROOT, not LSB_SCRIPTS_DIR — verified directly
against the running container that only SERVER_SCRIPTS_ROOT's mount
has a zones/ subtree at all.
EOF
)"
```

---

### Task 2: Backend — `GET /api/db/npcs/dialog` route

**Files:**
- Modify: `src/routes/db.ts` (add the new route; add one import)

**Interfaces:**
- Consumes: `resolveNpcDialog` from `./npc-dialog` (Task 1).
- Produces: `GET /api/db/npcs/dialog?name=<name>&zone=<zoneName>` → JSON `NpcDialogResult` (`{ found: boolean; scriptPath?: string; lines: {const,id,text}[] }`). Consumed by Task 3's client helper.

- [ ] **Step 1: Add the import**

In `src/routes/db.ts`, find the existing import block (near the top):

```ts
import { cacheGetJSON, cacheSetJSON, WIKI_TTL, ITEM_TYPES_TTL } from '../cache';
```

Add directly after it:

```ts
import { cacheGetJSON, cacheSetJSON, WIKI_TTL, ITEM_TYPES_TTL } from '../cache';
import { resolveNpcDialog } from '../npc-dialog';
```

- [ ] **Step 2: Add the route**

Find the existing `/api/db/npcs/wiki` route (ends around what is currently line 295 with `});`):

```ts
  router.get('/api/db/npcs/wiki', requireAuth, async (req, res) => {
    ...
  });
```

Add a new route directly after its closing `});`:

```ts
  router.get('/api/db/npcs/dialog', requireAuth, (req, res) => {
    try {
      const name = ((req.query.name as string) || '').trim();
      const zone = ((req.query.zone as string) || '').trim();
      if (!name || !zone) { res.json({ found: false, lines: [] }); return; }
      res.json(resolveNpcDialog(zone, name));
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
  });
```

- [ ] **Step 3: Rebuild**

```bash
cd /home/sora/Downloads/ffxi-dashboard
npm run build:all
```

Expected: exit 0, no TypeScript errors.

- [ ] **Step 4: Deploy and verify live via curl**

```bash
npm run docker:build && docker compose up -d --force-recreate
docker compose logs --tail=20 dashboard
```

Expected: `FFXI Dashboard running on port 3000`, no errors. Then:

```bash
TOK=$(curl -s -X POST http://localhost:3001/api/login -H 'Content-Type: application/json' -d '{"login":"Sora","password":"YourPassword1"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -s "http://localhost:3001/api/db/npcs/dialog?name=Nembet&zone=Southern_San_dOria_%5BS%5D" -H "Authorization: Bearer $TOK" | python3 -m json.tool
```

Expected: `"found": true`, a `lines` array with an `ITEM_DELIVERY_DIALOG` entry whose `text` starts with `"If'n ye have goods tae deliver"`.

Then confirm the graceful-empty case:

```bash
curl -s "http://localhost:3001/api/db/npcs/dialog?name=NoSuchNpcXYZ&zone=Southern_San_dOria_%5BS%5D" -H "Authorization: Bearer $TOK" | python3 -m json.tool
```

Expected: `{"found": false, "lines": []}`, HTTP 200, no error/500.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS, 101/101 (no change from Task 1 — this task is backend-route-only, no new tests, covered by the live curl checks above per this repo's established convention for `src/routes/*.ts` route additions).

- [ ] **Step 6: Commit**

```bash
git add src/routes/db.ts
git commit -m "$(cat <<'EOF'
routes: add GET /api/db/npcs/dialog

Exposes npc-dialog.ts's resolveNpcDialog over HTTP. requireAuth only,
not admin-gated — returns extracted dialogue text, not raw script
source, same tier as the existing quest walkthrough (which all users
already see via GET /api/db/quests).
EOF
)"
```

---

### Task 3: Client — auto-fetch + Dialogue section in the NPC detail panel

**Files:**
- Modify: `client/src/api.ts` (add one helper)
- Modify: `client/src/components/pages/Database.tsx`
  - Module-level type declarations (~line 36, next to `Enrichment`)
  - State declarations (~line 155-158, next to `wikiData`/`scriptData`)
  - `openDetail` (~line 288-330)
  - Close-button reset (~line 540)
  - `<DetailView>` invocation (~line 544)
  - `DetailView` function signature (~line 683) and its `cat === 'npcs'` case (~line 824-833)

**Interfaces:**
- Consumes: `api.npcDialog` (new), Task 2's `GET /api/db/npcs/dialog`.
- Produces: nothing consumed by a later task — this is the last task in the plan.

- [ ] **Step 1: Add the API helper**

In `client/src/api.ts`, find:

```ts
  dbAbilityWiki: (name: string) => req<{ description?: string | null; wikiUrl?: string; notFound?: boolean } | null>(`/api/db/abilities/wiki?name=${encodeURIComponent(name)}`),
```

Add directly after it:

```ts
  dbAbilityWiki: (name: string) => req<{ description?: string | null; wikiUrl?: string; notFound?: boolean } | null>(`/api/db/abilities/wiki?name=${encodeURIComponent(name)}`),
  npcDialog: (name: string, zone: string) => req<{ found: boolean; scriptPath?: string; lines: { const: string; id: number; text: string }[] }>(`/api/db/npcs/dialog?name=${encodeURIComponent(name)}&zone=${encodeURIComponent(zone)}`),
```

- [ ] **Step 2: Add the `NpcDialog` type**

In `client/src/components/pages/Database.tsx`, find:

```ts
type Enrichment = { loading: boolean; source: 'dat' | 'wiki' | 'script' | 'none' | null; text: string | null; datId?: number; wikiUrl?: string };
```

Add directly after it:

```ts
type Enrichment = { loading: boolean; source: 'dat' | 'wiki' | 'script' | 'none' | null; text: string | null; datId?: number; wikiUrl?: string };
type NpcDialog = { loading: boolean; found: boolean; lines: { const: string; id: number; text: string }[] };
```

- [ ] **Step 3: Add state**

Find:

```ts
  const [scriptData, setScriptData] = useState<{ found: boolean; path?: string; content?: string; vars?: string[] } | null>(null);
  const [scriptLoading, setScriptLoading] = useState(false);
```

Add directly after it:

```ts
  const [scriptData, setScriptData] = useState<{ found: boolean; path?: string; content?: string; vars?: string[] } | null>(null);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [npcDialog, setNpcDialog] = useState<NpcDialog | null>(null);
```

- [ ] **Step 4: Fetch it in `openDetail`, splitting NPCs into their own branch**

Find (the catch-all that currently handles `npcs` alongside several other categories):

```ts
      else if (cat === 'npcs' || cat === 'zones' || cat === 'trusts' || cat === 'mounts' || cat === 'gmcmds' || DAT_TABLE_CATS.has(cat)) setDetailData(row);
```

Replace with:

```ts
      else if (cat === 'npcs') {
        setDetailData(row);
        setNpcDialog({ loading: true, found: false, lines: [] });
        try {
          const dialog = await api.npcDialog(String(row.name ?? ''), String(row.zone ?? ''));
          setNpcDialog({ loading: false, found: dialog.found, lines: dialog.lines });
        } catch (_) {
          setNpcDialog({ loading: false, found: false, lines: [] });
        }
      }
      else if (cat === 'zones' || cat === 'trusts' || cat === 'mounts' || cat === 'gmcmds' || DAT_TABLE_CATS.has(cat)) setDetailData(row);
```

Also find, at the top of `openDetail` (the existing reset line):

```ts
    setDetailRow(row); setDetailData(null); setDetailLoading(true); setWikiData(null); setScriptData(null); setItemImageUrl(null);
    setEnrichment({ loading: false, source: null, text: null });
```

Replace with:

```ts
    setDetailRow(row); setDetailData(null); setDetailLoading(true); setWikiData(null); setScriptData(null); setItemImageUrl(null);
    setEnrichment({ loading: false, source: null, text: null });
    setNpcDialog(null);
```

- [ ] **Step 5: Reset it on the detail panel's close button**

Find:

```ts
            <button onClick={() => { setDetailRow(null); setDetailData(null); setWikiData(null); setScriptData(null); setEnrichment({ loading: false, source: null, text: null }); }} className="btn btn-ghost btn-xs">✕</button>
```

Replace with:

```ts
            <button onClick={() => { setDetailRow(null); setDetailData(null); setWikiData(null); setScriptData(null); setEnrichment({ loading: false, source: null, text: null }); setNpcDialog(null); }} className="btn btn-ghost btn-xs">✕</button>
```

- [ ] **Step 6: Pass `npcDialog` into `DetailView`**

Find:

```ts
            {detailData && <DetailView data={detailData} cat={cat} itemImageUrl={itemImageUrl} enrichment={enrichment} />}
```

Replace with:

```ts
            {detailData && <DetailView data={detailData} cat={cat} itemImageUrl={itemImageUrl} enrichment={enrichment} npcDialog={npcDialog} />}
```

- [ ] **Step 7: Accept the new prop in `DetailView`'s signature**

Find:

```ts
function DetailView({ data, cat, itemImageUrl, enrichment }: { data: Record<string, unknown>; cat: Category; itemImageUrl?: string | null; enrichment: Enrichment }) {
```

Replace with:

```ts
function DetailView({ data, cat, itemImageUrl, enrichment, npcDialog }: { data: Record<string, unknown>; cat: Category; itemImageUrl?: string | null; enrichment: Enrichment; npcDialog: NpcDialog | null }) {
```

- [ ] **Step 8: Render the Dialogue section in the NPCs case**

Find:

```ts
  if (cat === 'npcs') {
    return (
      <div>
        {data.npcid != null && <DRow k="NPC ID" v={String(data.npcid)} />}
        {data.zone  != null && <DRow k="Zone" v={fmtName(String(data.zone))} />}
        {data.x     != null && <DRow k="X" v={Number(data.x).toFixed(2)} />}
        {data.z     != null && <DRow k="Z" v={Number(data.z).toFixed(2)} />}
      </div>
    );
  }
```

Replace with:

```ts
  if (cat === 'npcs') {
    return (
      <div>
        {data.npcid != null && <DRow k="NPC ID" v={String(data.npcid)} />}
        {data.zone  != null && <DRow k="Zone" v={fmtName(String(data.zone))} />}
        {data.x     != null && <DRow k="X" v={Number(data.x).toFixed(2)} />}
        {data.z     != null && <DRow k="Z" v={Number(data.z).toFixed(2)} />}
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', marginBottom: 4 }}>Dialogue</div>
          {!npcDialog || npcDialog.loading ? (
            <div style={{ fontSize: 12, color: 'var(--color-text3)' }}>Loading…</div>
          ) : !npcDialog.found || npcDialog.lines.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-text3)' }}>No dialogue found for this NPC.</div>
          ) : (
            npcDialog.lines.map((l, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: 'var(--color-text2)', fontStyle: 'italic' }}>&ldquo;{l.text}&rdquo;</div>
                <div style={{ fontSize: 10, color: 'var(--color-text3)', marginTop: 2 }}>{l.const}</div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }
```

- [ ] **Step 9: Rebuild**

```bash
cd /home/sora/Downloads/ffxi-dashboard
npm run build:all
```

Expected: exit 0, no TypeScript errors.

- [ ] **Step 10: Deploy and verify live**

```bash
npm run docker:build && docker compose up -d --force-recreate
```

Using Playwright (chromium at `/home/sora/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`, `playwright-core` in the scratchpad's `node_modules`), log in as `Sora`/`YourPassword1`, open Database → NPCs, search `nembet` (raw internal snake_case-ish name — NPC search matches the DB `name` field directly, here `"Nembet"` works as typed since that's the literal DB value), click the "Search" button, click the resulting row. Confirm:
- A "Dialogue" section appears below Zone/X/Z.
- It shows a line whose text starts with `"If'n ye have goods tae deliver"` and whose small label reads `ITEM_DELIVERY_DIALOG`.

Then search a zone with mostly non-scripted/generic NPCs (e.g. filter zone `Southern_San_dOria` and open one of the numeric-named rows like `01`), and confirm the "No dialogue found for this NPC." note renders instead of an error or an empty gap.

- [ ] **Step 11: Commit**

```bash
git add public/index.html client/src/api.ts client/src/components/pages/Database.tsx
git commit -m "$(cat <<'EOF'
database: show per-NPC dialogue in the NPC detail panel

Auto-fetches on detail-panel open (same trigger point as the existing
quest-walkthrough auto-fetch), showing every dialogue line the NPC's
script references, each labeled with its constant name since a script
commonly has several conditional/alternate lines rather than one fixed
greeting. Explicit "No dialogue found" note when nothing resolves,
never a silent gap.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Design spec's "Backend changes" (`src/npc-dialog.ts` module + route) → Tasks 1-2. "Client changes" (auto-fetch, Dialogue section, api.ts helper) → Task 3. Decisions 1 (all lines) and 2 (explicit empty-state note) → Task 3 Step 8's render logic. Decision 3 (auto-fetch, not manual button) → Task 3 Step 4. Decision 4 (requireAuth only) → Task 2 Step 2. The `SERVER_SCRIPTS_ROOT` correction (Global Constraints) → Task 1 Step 3's implementation and Step 6's live sanity check specifically targeting it.
- **Placeholder scan:** No TBD/TODO; every step has literal, complete code.
- **Type consistency:** `NpcDialogLine`/`NpcDialogResult` (Task 1) match the shape `resolveNpcDialog` returns, which Task 2's route serializes as-is, which Task 3's `api.npcDialog` helper types identically (`{ found, scriptPath?, lines: {const,id,text}[] }`), which Task 3's `NpcDialog` client-state type narrows to what the UI needs (`{loading, found, lines}` — `scriptPath` isn't needed client-side, correctly dropped rather than carried through unused). `resolveNpcDialog(zoneName, npcName)` parameter order matches every call site (Task 2's route, Task 1's live sanity check).
