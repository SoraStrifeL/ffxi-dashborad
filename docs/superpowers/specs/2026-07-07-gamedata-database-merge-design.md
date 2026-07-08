# Merge Game Data into Database — Design

## Problem

The dashboard has two separate browse-everything tabs: **Database**
(`client/src/components/pages/Database.tsx`, DB/Lua-sourced: items, npcs,
mobs, zones, jobs, skills, abilities, quests, key items, trusts, mounts, GM
commands) and **Game Data** (`client/src/components/pages/GameData.tsx`,
client-DAT-sourced: items×6 subcategories, abilities, spells, zones,
statuses, titles, key items, monster skills, emotes, augments, quests,
dialog). They overlap on five categories (items, abilities, quests, key
items, zones) sourced two different ways, and live as two confusingly
similar sidebar entries.

Goal: one tab, one nav entry, and for overlapping categories, one row that
shows both the live-server stats and the client's icon/flavor text instead
of two places to look.

## Verified facts driving the design

Spot-checked live via curl against the running dashboard before designing
the enrichment mechanism:

- **Items share an id space.** DB `item_basic.itemid` 12832
  (`bronze_subligar`) = DAT items_armor id 12832 (`Bronze Subligar`).
  Enrichment can be a direct id lookup — no matching needed.
- **Abilities do not share an id space.** DB `abilityId` 35 ("Provoke") vs.
  DAT ability id 547 ("Provoke"). Needs name-matching.
- **Key items do not share an id space.** DB key item id 1 ("Zeruhn
  Report") happens to match DAT id 1, but DB id 395 ("Map of the Zeruhn
  Mines") is DAT id 2835. Needs name-matching.
- **Quests never needed matching in the first place** for the Database
  tab — `/api/db/quests` rows already carry `logId`/`questId` directly.
  The `QUEST_NAME_INDEX`/`/api/db/quests/walkthrough` machinery added in
  the prior session existed solely to match GameData's flat, id-less DAT
  quest-title list back to an LSB quest — once that list is deleted, the
  matching layer is dead weight.
- **No DB-backed spells endpoint exists at all** — Spells has always
  been DAT-only, so it stays DAT-only (no enrichment target to merge
  into).

## Decisions (confirmed with user)

1. Both halves of the ask apply: consolidate navigation **and** merge
   per-row data for overlapping categories.
2. The combined tab uses **Database.tsx's** layout (sidebar + sortable
   table + right detail panel with Wiki/Script/Upload buttons) as the
   base, not GameData's chip+inline-expand layout.
3. For overlapping categories, the **live DB is the primary row source**;
   DAT data is an enrichment layer looked up per row, never the other way
   around. Rows that exist in the DAT but not on this server never appear.

## Routing & navigation

- `/db` becomes the single merged route; `/gamedata` and its sidebar nav
  entry are deleted outright (internal admin tool, no bookmarked public
  URL to preserve — no redirect needed).
- The category sidebar grows from 12 to ~19 entries and is split into two
  labeled groups:

  ```
  SERVER DATA
   Items · NPCs · Mobs · Zones · Jobs · Skills
   Abilities · Quests · Key Items · Trusts
   Mounts · GM Commands
  CLIENT REFERENCE
   Spells · Statuses · Titles · Monster Skills
   Emotes · Augments · Dialog
  ```

  "Server Data" = rows come from the live DB/Lua catalogs (ground truth
  for this server). "Client Reference" = DAT-only categories with no
  server-side equivalent, ported from GameData.tsx into Database's
  table+detail-panel shell instead of chip+inline-expand.

## Enriching overlapping categories

Row lists for Items, Abilities, Quests, and Key Items are unchanged (same
DB endpoints as today) — the DB never stores flavor-text descriptions for
these, only mechanical stats/ids, so description text always has to come
from somewhere else. The detail panel auto-chains through the available
sources and labels which one it used:

1. **DAT first** (instant, local, no network) — fetched as part of
   `openDetail()` in parallel with the existing detail call.
2. **BG-Wiki second**, automatically, only when DAT had no match —
   reusing the existing scrape-and-cache pattern already used for
   items/npcs/mobs/quests/zones. The manual "Wiki" button is **removed**
   for these four categories, since the fallback is now automatic; it's
   unaffected for npcs/mobs/zones, which have no DAT layer to chain from
   and keep today's manual click.
3. **Neither** — show an explicit note: *"No description available — not
   on this server's DAT or BG-Wiki."* (replaces today's silent omission).

Whichever source supplied the text gets a small caption underneath it:
*"From client DAT"* or *"From BG-Wiki"* — same visual treatment as the
"From the quest script" label already shipped for GameData's quest
walkthroughs. For the two name-matched categories (Abilities, Key Items),
the DAT match is a different id on each side by construction (see
"Verified facts" above) — the caption appends that caveat inline, e.g.
*"From client DAT (id 547, matched by name — server id is 35)"*, so the
id mismatch is visible right where the text is instead of a separate
warning block. Items, which match by id exactly, never show this caveat.

- **Items**: new `getItemDatById(id)` in `src/dat/index.ts`, backed by a
  `Map<id, DatRow>` built once across `DAT_ITEM_CATEGORIES`. Detail panel
  shows the DAT icon (`/api/dat/icon/:id`, already exists) beside the
  name regardless of which description source is used. A custom uploaded
  image (existing feature) takes priority over the DAT icon when both
  exist. Description falls back to the existing `/api/db/items/wiki`.
- **Abilities** / **Key Items**: no shared id space, so DAT enrichment is
  name-matched via two new normalized-name indexes built once at startup
  — `ABILITY_NAME_INDEX` and `KEY_ITEM_DAT_INDEX` (same normalization
  helper pattern as the quest-name matching this replaces). Neither
  category has a Wiki lookup today; two new routes are added following
  the existing scrape pattern — `/api/db/abilities/wiki?name=` and
  `/api/db/keyitems/wiki?name=` — solely to complete the fallback chain.
- **Quests**: DAT step is `reward.walkthrough`, already returned inline
  by `/api/db/quests` (added last session) — no fetch needed for it.
  Falls back to the existing `/api/db/quests/wiki` automatically when
  `reward.walkthrough` is empty. The manual "Wiki" button is removed for
  quests; the "Script" button (full Lua source dump) is unrelated to the
  description chain and stays manual.

One backend route covers items/abilities/key-items DAT enrichment:
`GET /api/dat/enrich/:cat/:key` (e.g. `/api/dat/enrich/items/12832`,
`/api/dat/enrich/abilities/Provoke`) → `{ name, description, hasIcon } |
null`, instead of three near-identical routes. Wiki fallback continues to
use the existing per-category `/api/db/<cat>/wiki` convention (two new
routes for abilities/key-items as noted above, matching the shape of the
four that already exist).

## Client Reference categories (DAT-only, ported unchanged)

Spells, Statuses, Titles, Monster Skills, Emotes, Augments port over from
GameData.tsx largely as-is: a shared `getColumns()` case (ID, Name,
Description) and a shared `DetailView` case (description text + id, plus
the status icon via `/api/dat/status-icon/:id` the same way Items shows
its icon). Rows come from the existing `/api/dat/table/:cat` endpoint —
no backend changes needed for these six.

**Dialog** is the one structural outlier: per-zone dialog line dumps, not
a name/description table. It keeps its special toolbar mode — selecting
Dialog swaps the search box for a zone `<select>` (reusing
`api.datDialogZones()` / `api.datDialog()` unchanged), table shows ID +
Text only, no detail panel (clicking a row does nothing, same as today).

## Cleanup

**Deleted outright:**
- `client/src/components/pages/GameData.tsx`, its route, and its sidebar
  nav entry
- `getQuests()` / `QUEST_NAME_RESOURCES` in `src/dat/index.ts`
- `/api/db/quests/walkthrough` route, `QUEST_NAME_INDEX` +
  `_normQuestName` in `src/catalog.ts`, `api.dbQuestWalkthrough` client-side

**Kept, repurposed from "browsable top-level category" to "enrichment
data source only"**: `DAT_CATEGORIES.abilities`, `DAT_STRING_RESOURCES.
key_items`, `DAT_ITEM_CATEGORIES` (the six items_* subcategories) — still
parsed at startup, no longer exposed as their own chip/sidebar entry,
reachable only via `/api/dat/enrich/:cat/:key`.

`categoryKeys()` / `/api/dat/status`'s `categories` list gets audited
during implementation now that its only consumer (GameData's `available()`
chip filter) is gone — kept only if something else still needs it.

## Error handling

- `/api/dat/enrich/:cat/:key` returns `null` on no match. `/api/db/<cat>/
  wiki` returns `notFound`/`null` on no match (existing convention,
  unchanged). Neither is a thrown error — both are expected, silent
  outcomes that the client's fallback chain checks in sequence.
- The client only shows the *"No description available — not on this
  server's DAT or BG-Wiki"* note once both steps of the chain have
  resolved (DAT checked synchronously, then Wiki fetched and resolved) —
  never while the Wiki fetch is still in flight, to avoid a flash of
  "not available" before the real answer arrives. A brief loading state
  covers that gap, matching the existing "Loading…" pattern GameData used
  for its quest-walkthrough fetch.
- If the client DAT isn't mounted (bare-metal without `DAT_DIR`, per
  CLAUDE.md's graceful-degradation pattern), the entire "Client Reference"
  sidebar group disappears, the DAT step of every fallback chain no-ops
  straight to Wiki, and enrichment icons simply don't render — mirrors
  GameData's existing `enabled === false` gate. Nothing breaks; the
  Database tab just looks like it does pre-merge, minus DAT-sourced icons.

## Testing

- Extend the existing vitest suite (87 passing tests today) with unit
  tests for the new matching helpers — `getItemDatById` (exact id lookup)
  and the ability/key-item normalized-name indexes, specifically covering
  case differences, `+1` suffix variants, and punctuation, since those are
  the riskiest new logic and the id-space verification above was a
  spot-check, not exhaustive.
- Manual/Playwright verification after implementation: Items detail shows
  DAT icon + flavor text with a "From client DAT" caption; an Ability or
  Key Item with a DAT name-match shows the caption with its id-mismatch
  caveat (e.g. Provoke: server id 35 vs. DAT id 547); an item/ability/
  key-item with no DAT match but a real Wiki page shows text labeled
  "From BG-Wiki" instead; one with neither shows the explicit
  no-description note; Quests detail shows the walkthrough list inline
  (or falls back to Wiki the same way); Client Reference categories
  (especially Dialog's zone selector) work inside the new shell; and the
  DAT-disabled case still renders cleanly with no Client Reference group,
  no broken enrichment calls, and every fallback chain landing on Wiki.
