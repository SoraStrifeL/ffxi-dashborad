import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../../api';
import { useStore } from '../../store';

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
type NpcDialog = { loading: boolean; found: boolean; lines: { const: string; id: number; text: string }[] };

const NON_PAGED: Category[] = ['zones','jobs','skills','trusts','mounts','gmcmds'];
const DB_PAGE = 50; // must match server.js DB_PAGE

type GmCmd = { name: string; syntax: string; desc: string; group: string };
const GM_COMMANDS: GmCmd[] = [
  // Movement & Teleport
  { name: 'goto',           syntax: '!goto <player>',                          desc: 'Goes to the target player.',                                           group: 'Movement' },
  { name: 'bring',          syntax: '!bring <player>',                         desc: 'Brings the target to the player.',                                     group: 'Movement' },
  { name: 'send',           syntax: '!send <player1> <player2 or zone>',       desc: 'Teleports a player to a zone or another player.',                      group: 'Movement' },
  { name: 'pos',            syntax: '!pos <x> <y> <z> [zone] [target]',       desc: 'Sets the player\'s position. Without args prints current position.',   group: 'Movement' },
  { name: 'zone',           syntax: '!zone <zone>',                            desc: 'Teleports a player to the given zone.',                                group: 'Movement' },
  { name: 'where',          syntax: '!where',                                  desc: 'Tells the player about their current position.',                        group: 'Movement' },
  { name: 'up',             syntax: '!up [amount] [target]',                   desc: 'Alters vertical coordinate upward.',                                   group: 'Movement' },
  { name: 'down',           syntax: '!down [amount] [target]',                 desc: 'Alters vertical coordinate downward.',                                  group: 'Movement' },
  { name: 'wallhack',       syntax: '!wallhack [target]',                      desc: 'Allows the player to walk through walls.',                             group: 'Movement' },
  { name: 'homepoint',      syntax: '!homepoint',                              desc: 'Sends the target to their homepoint.',                                  group: 'Movement' },
  { name: 'gmhome',         syntax: '!gmhome',                                 desc: 'Sends you to zone 210 (GM_HOME).',                                     group: 'Movement' },
  { name: 'return',         syntax: '!return [player]',                        desc: 'Warps GM or target player to their previous zone.',                    group: 'Movement' },
  { name: 'posfix',         syntax: '!posfix',                                 desc: 'Resets target\'s session and warps them to Jeuno.',                    group: 'Movement' },
  // Stats & Resources
  { name: 'hp',             syntax: '!hp <amount> [player]',                   desc: 'Sets the GM or target player\'s health.',                              group: 'Stats' },
  { name: 'mp',             syntax: '!mp <amount> [player]',                   desc: 'Sets the GM or target player\'s mana.',                                group: 'Stats' },
  { name: 'tp',             syntax: '!tp <amount> [player]',                   desc: 'Sets a player\'s TP. Also sets pet TP if applicable.',                 group: 'Stats' },
  { name: 'speed',          syntax: '!speed <amount>',                         desc: 'Sets the player\'s movement speed.',                                   group: 'Stats' },
  { name: 'givexp',         syntax: '!givexp <amount> [player]',               desc: 'Gives the GM or target player experience points.',                     group: 'Stats' },
  { name: 'takexp',         syntax: '!takexp <amount> [player]',               desc: 'Removes experience points from the target player.',                    group: 'Stats' },
  { name: 'setgil',         syntax: '!setgil <amount> [player]',               desc: 'Sets the player\'s gil.',                                              group: 'Stats' },
  { name: 'givegil',        syntax: '!givegil <amount> [player]',              desc: 'Gives the specified amount of gil to GM or target player.',            group: 'Stats' },
  { name: 'takegil',        syntax: '!takegil <amount> [player]',              desc: 'Removes the amount of gil from the given player.',                     group: 'Stats' },
  { name: 'setmerits',      syntax: '!setmerits <amount> [player]',            desc: 'Sets the target player\'s merit count.',                               group: 'Stats' },
  { name: 'setjobpoints',   syntax: '!setjobpoints <amount> [player]',         desc: 'Sets the target player\'s job points count.',                          group: 'Stats' },
  { name: 'cp',             syntax: '!cp <amount> [player]',                   desc: 'Adds the given amount of CP to the player.',                           group: 'Stats' },
  // Items & Inventory
  { name: 'additem',        syntax: '!additem <itemId> [qty] [aug v ...]',     desc: 'Adds an item to the GM\'s inventory.',                                 group: 'Items' },
  { name: 'delitem',        syntax: '!delitem <itemId> [player]',              desc: 'Deletes a single item held by a player, if they have it.',             group: 'Items' },
  { name: 'addkeyitem',     syntax: '!addkeyitem <ID> [player]',               desc: 'Adds a key item to the player.',                                       group: 'Items' },
  { name: 'delkeyitem',     syntax: '!delkeyitem <ID> [player]',               desc: 'Deletes the given key item from the player.',                          group: 'Items' },
  { name: 'addtempitem',    syntax: '!addtempitem <itemId> [qty]',             desc: 'Adds a temp item to the player\'s inventory.',                         group: 'Items' },
  { name: 'addcurrency',    syntax: '!addcurrency <type> <amount> [player]',   desc: 'Adds the specified currency to the player.',                           group: 'Items' },
  { name: 'delcurrency',    syntax: '!delcurrency <type> <amount> [player]',   desc: 'Removes the specified currency from the player.',                      group: 'Items' },
  { name: 'hasitem',        syntax: '!hasitem <itemId> [player]',              desc: 'Checks if a player has a specific item.',                              group: 'Items' },
  { name: 'haskeyitem',     syntax: '!haskeyitem <ID> [player]',               desc: 'Checks if player has specified key item.',                             group: 'Items' },
  { name: 'delallinventory',syntax: '!delallinventory [player]',               desc: 'Deletes all items in a player\'s inventory.',                          group: 'Items' },
  // Job & Skills
  { name: 'changejob',      syntax: '!changejob <job> [player]',              desc: 'Changes the player\'s current job.',                                   group: 'Job' },
  { name: 'changesjob',     syntax: '!changesjob <job> [player]',             desc: 'Changes the player\'s current subjob.',                                group: 'Job' },
  { name: 'setplayerlevel', syntax: '!setplayerlevel <level> [player]',       desc: 'Sets the target player\'s level.',                                     group: 'Job' },
  { name: 'masterjob',      syntax: '!masterjob [player]',                    desc: 'Masters the player\'s current job.',                                   group: 'Job' },
  { name: 'setskill',       syntax: '!setskill <skill> <level> [target]',     desc: 'Sets target\'s level of specified skill.',                             group: 'Job' },
  { name: 'capskill',       syntax: '!capskill <skill> [player]',             desc: 'Caps a specific skill.',                                               group: 'Job' },
  { name: 'capallskills',   syntax: '!capallskills [player]',                 desc: 'Caps all the player\'s skills.',                                       group: 'Job' },
  { name: 'addspell',       syntax: '!addspell <spellID> [player]',           desc: 'Adds the ability to use a spell to the player.',                       group: 'Job' },
  { name: 'delspell',       syntax: '!delspell <spellID> [player]',           desc: 'Removes a spell from the player\'s spell list.',                       group: 'Job' },
  { name: 'addallspells',   syntax: '!addallspells [player]',                 desc: 'Adds all valid spells (except trusts) to the given target.',           group: 'Job' },
  { name: 'addalltrusts',   syntax: '!addalltrusts [player]',                 desc: 'Adds all trust spells to the given target.',                           group: 'Job' },
  { name: 'addallweaponskills', syntax: '!addallweaponskills [player]',       desc: 'Adds all learned weapon skills to the given target.',                  group: 'Job' },
  { name: 'addallmounts',   syntax: '!addallmounts [player]',                 desc: 'Adds all mount key items to the player.',                              group: 'Job' },
  { name: 'addallwarps',    syntax: '!addallwarps [player]',                  desc: 'Adds all Survival Guides and Home Points to GM or target.',            group: 'Job' },
  { name: 'addallmaps',     syntax: '!addallmaps [player]',                   desc: 'Adds all maps to the given player.',                                   group: 'Job' },
  // Quests & Missions
  { name: 'addmission',     syntax: '!addmission <logID> <missionID> [player]',   desc: 'Adds a mission to the GM or target player\'s log.',                group: 'Quests' },
  { name: 'completemission',syntax: '!completemission <logID> <missionID> [player]', desc: 'Completes the given mission for the target player.',            group: 'Quests' },
  { name: 'addquest',       syntax: '!addquest <logID> <questID> [player]',        desc: 'Adds a quest to the given target\'s log.',                        group: 'Quests' },
  { name: 'completequest',  syntax: '!completequest <logID> <questID> [player]',   desc: 'Completes the given quest for the GM or target player.',          group: 'Quests' },
  { name: 'addtitle',       syntax: '!addtitle <titleID> [player]',           desc: 'Add and set player title.',                                            group: 'Quests' },
  { name: 'hastitle',       syntax: '!hastitle <titleID> [player]',           desc: 'Check if player already has a title.',                                 group: 'Quests' },
  { name: 'setrank',        syntax: '!setrank <rank> [player]',               desc: 'Sets the player\'s rank.',                                             group: 'Quests' },
  { name: 'setfamelevel',   syntax: '!setfamelevel <level> [zone] [player]',  desc: 'Sets fame level on a target player.',                                  group: 'Quests' },
  { name: 'completerecord', syntax: '!completerecord <recordID> [player]',    desc: 'Completes the given RoE record for the GM or target player.',          group: 'Quests' },
  // GM Tools
  { name: 'togglegm',       syntax: '!togglegm',                              desc: 'Toggles a GM\'s nameflags/icon.',                                      group: 'GM Tools' },
  { name: 'hide',           syntax: '!hide',                                  desc: 'Hides the GM from other players.',                                     group: 'GM Tools' },
  { name: 'godmode',        syntax: '!godmode [1]',                           desc: 'Toggles god mode. Pass 1 for "soft" god mode.',                        group: 'GM Tools' },
  { name: 'immortal',       syntax: '!immortal [player]',                     desc: 'Sets a target to be unkillable.',                                      group: 'GM Tools' },
  { name: 'promote',        syntax: '!promote <level> [player]',              desc: 'Promotes the player to a new GM level.',                               group: 'GM Tools' },
  { name: 'jail',           syntax: '!jail [player]',                         desc: 'Sends the target player to Mordion Gaol.',                             group: 'GM Tools' },
  { name: 'pardon',         syntax: '!pardon [player]',                       desc: 'Pardons a player from jail (Mordion Gaol).',                           group: 'GM Tools' },
  { name: 'logoff',         syntax: '!logoff [player]',                       desc: 'Logs the target player off by force.',                                 group: 'GM Tools' },
  { name: 'rename',         syntax: '!rename <name> [target]',                desc: 'Renames target NPC or MOB (not players, not saved to DB).',            group: 'GM Tools' },
  { name: 'exec',           syntax: '!exec <lua string>',                     desc: 'Executes a Lua string directly from chat.',                            group: 'GM Tools' },
  // Mobs & NPCs
  { name: 'spawnmob',       syntax: '!spawnmob <mobId>',                      desc: 'Spawns a mob.',                                                        group: 'Mobs' },
  { name: 'despawnmob',     syntax: '!despawnmob [mobId]',                    desc: 'Despawns the given mob (target or mobID).',                            group: 'Mobs' },
  { name: 'mobhere',        syntax: '!mobhere <mobId>',                       desc: 'Spawns a MOB and moves it to current position.',                       group: 'Mobs' },
  { name: 'npchere',        syntax: '!npchere <npcId>',                       desc: 'Spawns an NPC and moves it to current position.',                      group: 'Mobs' },
  { name: 'stun',           syntax: '!stun [target]',                         desc: 'Stuns a non-NPC target for an hour.',                                  group: 'Mobs' },
  // Appearance & Misc
  { name: 'costume',        syntax: '!costume <costumeId>',                   desc: 'Sets the player\'s current costume.',                                  group: 'Misc' },
  { name: 'mount',          syntax: '!mount <mountId>',                       desc: 'Mounts the player on the specified mount.',                            group: 'Misc' },
  { name: 'setweather',     syntax: '!setweather <weatherId>',                desc: 'Sets the current weather for the current zone.',                       group: 'Misc' },
  { name: 'time',           syntax: '!time',                                  desc: 'Prints current time info.',                                            group: 'Misc' },
  { name: 'addtime',        syntax: '!addtime <seconds>',                     desc: 'Resets and adds offset (in seconds) to earth clock.',                  group: 'Misc' },
  { name: 'setplayernation',syntax: '!setplayernation <nation> [player]',     desc: 'Sets the target player\'s nation.',                                    group: 'Misc' },
  { name: 'yell',           syntax: '!yell [player]',                         desc: 'Bans/unbans a player from using /yell.',                               group: 'Misc' },
  { name: 'uptime',         syntax: '!uptime',                                desc: 'Prints zone uptime.',                                                  group: 'Misc' },
];

export function Database() {
  const navigate = useNavigate();
  const location = useLocation();
  const navState = location.state as { cat?: Category; search?: string } | null;
  const [cat, setCat]     = useState<Category>(navState?.cat ?? 'items');
  const [rows, setRows]   = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage]   = useState(0);
  const [search, setSearch] = useState(navState?.search ?? '');
  const [sortKey, setSortKey] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [zoneFilter, setZoneFilter] = useState('');
  const [regionFilter, setRegionFilter] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [mobsRegionFilter, setMobsRegionFilter] = useState<string | null>(null);
  const [mobsEcosystemFilter, setMobsEcosystemFilter] = useState<string | null>(null);
  const [aggroFilter, setAggroFilter] = useState(false);
  const [jobFilter, setJobFilter] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState<number | null>(null);
  const [slotFilter, setSlotFilter] = useState<number | null>(null);
  const [skillFilter, setSkillFilter] = useState<number | null>(null);
  const [jobFilterItems, setJobFilterItems] = useState<number | null>(null);
  const [rareExFilter, setRareExFilter] = useState(false);
  const [questLogFilter, setQuestLogFilter] = useState<number | null>(null);
  const [zones, setZones] = useState<{ zoneid: number; name: string }[]>([]);
  const [itemTypes, setItemTypes] = useState<{ type: number; cnt: number }[]>([]);
  const [npcRoles, setNpcRoles] = useState<{ role: string; cnt: number }[]>([]);
  const [mobEcosystems, setMobEcosystems] = useState<{ ecosystem: string; cnt: number }[]>([]);
  const [questLogs, setQuestLogs] = useState<{ logId: number; name: string; total: number }[]>([]);
  const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null);
  const [detailData, setDetailData] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [wikiData, setWikiData] = useState<{ description?: string; wikiUrl?: string; notFound?: boolean } | null>(null);
  const [wikiLoading, setWikiLoading] = useState(false);
  const [scriptData, setScriptData] = useState<{ found: boolean; path?: string; content?: string; vars?: string[] } | null>(null);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [npcDialog, setNpcDialog] = useState<NpcDialog | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const user = useStore((s) => s.user);
  const [itemImageUrl, setItemImageUrl] = useState<string | null>(null);
  const [datEnabled, setDatEnabled] = useState(false);
  const [dzones, setDzones] = useState<{ id: number; name: string }[]>([]);
  const [dialogZone, setDialogZone] = useState<number | null>(null);
  const isDialog = cat === 'dialog';
  // Shared by Items/Abilities/Key Items/Quests: DAT-then-Wiki auto fallback
  // for description text the DB never stores. `source` records which step
  // actually supplied the text so the detail panel can label it. (Enrichment
  // is the module-level type added in Task 6 Step 1 — DetailView and
  // EnrichedDescription below are module-level functions and need the same
  // shape, so it can't be declared component-local.)
  const [enrichment, setEnrichment] = useState<Enrichment>({ loading: false, source: null, text: null });
  // Guards against out-of-order responses: a slow request from a previous
  // category/filter must not overwrite the rows of the current one
  const loadSeq = useRef(0);

  useEffect(() => { api.zones().then(z => setZones(z)).catch(() => {}); }, []);
  useEffect(() => { api.dbItemTypes().then(setItemTypes).catch(() => {}); }, []);
  useEffect(() => { api.dbNpcRoles().then(setNpcRoles).catch(() => {}); }, []);
  useEffect(() => { api.dbMobEcosystems().then(setMobEcosystems).catch(() => {}); }, []);
  useEffect(() => { api.dbQuestLogs().then(setQuestLogs).catch(() => {}); }, []);
  useEffect(() => { api.datStatus().then(s => setDatEnabled(s.enabled)).catch(() => setDatEnabled(false)); }, []);
  useEffect(() => {
    if (!isDialog || dzones.length) return;
    api.datDialogZones().then(r => { setDzones(r.zones); if (r.zones.length && dialogZone == null) setDialogZone(r.zones[0].id); }).catch(() => {});
  }, [isDialog, dzones.length, dialogZone]);

  const load = useCallback(async (reset = true) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const p = reset ? 0 : page + 1;
    if (reset) setRows([]);
    const params: Record<string, string | number> = { page: p, q: search, zone: zoneFilter };
    if (sortKey && !NON_PAGED.includes(cat)) { params.sort = sortKey; params.dir = sortDir; }
    if (cat === 'abilities' && jobFilter !== null) params.job = jobFilter;
    if (cat === 'items' && typeFilter !== null) params.type = typeFilter;
    if (cat === 'items' && (typeFilter === 6 || typeFilter === 7) && slotFilter !== null) params.slot = slotFilter;
    if (cat === 'items' && (typeFilter === 6 || typeFilter === 7) && skillFilter !== null) params.skill = skillFilter;
    if (cat === 'items' && (typeFilter === 6 || typeFilter === 7) && jobFilterItems !== null) params.job = jobFilterItems;
    if (cat === 'items' && rareExFilter) params.rareex = 1;
    if (cat === 'npcs' && regionFilter) params.region = regionFilter;
    if (cat === 'npcs' && roleFilter) params.role = roleFilter;
    if (cat === 'mobs' && mobsRegionFilter) params.region = mobsRegionFilter;
    if (cat === 'mobs' && mobsEcosystemFilter) params.ecosystem = mobsEcosystemFilter;
    if (cat === 'mobs' && aggroFilter) params.aggro = 1;
    if (cat === 'quests' && questLogFilter !== null) params.log = questLogFilter;
    try {
      // All server DB endpoints return plain arrays (not { rows, hasMore }).
      // hasMore is inferred: if the page is full (== DB_PAGE), there may be more.
      let newRows: unknown[] | null = null;
      let datHasMore: boolean | null = null; // DAT_TABLE_CATS report hasMore directly, unlike DB_PAGE inference below
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
      else if (cat === 'npcs')      newRows = (await api.dbNpcs(params)) as unknown as unknown[];
      else if (cat === 'mobs')      newRows = (await api.dbMobs(params)) as unknown as unknown[];
      else if (cat === 'abilities') newRows = (await api.dbAbilities(params)) as unknown as unknown[];
      else if (cat === 'quests')    newRows = (await api.dbQuests(params)) as unknown as unknown[];
      else if (cat === 'keyitems')  newRows = (await api.dbKeyItems(params)) as unknown as unknown[];
      else if (cat === 'jobs')      newRows = await api.dbJobs();
      else if (cat === 'skills')    newRows = await api.dbSkills();
      else if (cat === 'zones')     newRows = (await api.zones()) as unknown as unknown[];
      else if (cat === 'trusts')    newRows = await api.dbTrusts();
      else if (cat === 'mounts')    newRows = await api.dbMounts();
      else if (cat === 'gmcmds') {
        const q = search.trim().toLowerCase();
        newRows = q ? GM_COMMANDS.filter(c => c.name.includes(q) || c.desc.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)) : GM_COMMANDS;
      }

      if (newRows !== null && seq === loadSeq.current) {
        setRows((prev) => reset ? newRows! : [...prev, ...newRows!]);
        setHasMore(datHasMore !== null ? datHasMore : NON_PAGED.includes(cat) ? false : newRows.length === DB_PAGE);
        setPage(p);
      }
    } catch (_) {}
    if (seq === loadSeq.current) setLoading(false);
  }, [cat, page, search, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, jobFilter, typeFilter, slotFilter, skillFilter, jobFilterItems, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]);

  useEffect(() => { load(true); }, [cat, zoneFilter, regionFilter, roleFilter, mobsRegionFilter, mobsEcosystemFilter, aggroFilter, jobFilter, typeFilter, slotFilter, skillFilter, jobFilterItems, rareExFilter, questLogFilter, sortKey, sortDir, dialogZone]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSearch = (e: React.FormEvent) => { e.preventDefault(); load(true); };

  const cols = getColumns(cat);
  const paged = !NON_PAGED.includes(cat);

  function onSort(key: string) {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortKey(''); setSortDir('asc'); } // third click clears the sort
    } else { setSortKey(key); setSortDir('asc'); }
  }

  // Non-paged categories hold the full result set, so sort them client-side;
  // paged categories are sorted server-side via the sort/dir params.
  const displayRows = React.useMemo(() => {
    if (!sortKey || paged) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((ra, rb) => {
      const av = (ra as Record<string, unknown>)[sortKey], bv = (rb as Record<string, unknown>)[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, sortKey, sortDir, paged]);
  const hasZoneFilter     = cat === 'npcs' || cat === 'mobs';
  const hasJobFilter      = cat === 'abilities';
  const hasTypeFilter     = cat === 'items';
  const hasQuestLogFilter = cat === 'quests';
  const isClickable       = cat === 'items' || cat === 'mobs' || cat === 'npcs' || cat === 'quests' || cat === 'zones' || cat === 'trusts' || cat === 'mounts' || cat === 'abilities' || cat === 'keyitems' || cat === 'gmcmds' || DAT_TABLE_CATS.has(cat);
  // npcs/mobs/zones have no DAT layer to chain from, so they keep today's
  // manual Wiki button. Items/Abilities/Quests/Key Items get the automatic
  // DAT->Wiki chain instead (Tasks 8-10) and no longer show this button.
  const hasWiki            = cat === 'mobs' || cat === 'npcs' || cat === 'zones';
  const hasUpload         = user?.tier === 'admin' && (cat === 'items' || cat === 'mobs' || cat === 'npcs');
  const hasScript         = user?.tier === 'admin' && cat === 'quests';
  const hasMapLink        = (cat === 'zones' || cat === 'npcs' || cat === 'mobs') && detailRow?.zoneid != null;

  async function openDetail(row: Record<string, unknown>) {
    setDetailRow(row); setDetailData(null); setDetailLoading(true); setWikiData(null); setScriptData(null); setItemImageUrl(null);
    setEnrichment({ loading: false, source: null, text: null });
    setNpcDialog(null);
    try {
      if (cat === 'items') {
        const [detail, img] = await Promise.all([
          api.dbItemDetail(Number(row.itemid)),
          api.uploadCheck('item', Number(row.itemid)).catch(() => ({ exists: false, url: null })),
        ]);
        setDetailData(detail);
        setItemImageUrl(img.exists ? img.url : null);
        fetchItemEnrichment(Number(row.itemid), String(row.name ?? ''));
      } else if (cat === 'mobs') {
        const detail = await api.dbMobDetail(String(row.name ?? ''), Number(row.zoneid ?? 0));
        setDetailData({ zone: row.zone, min_lvl: row.min_lvl, max_lvl: row.max_lvl, spawns: row.spawns, ...detail });
      }
      else if (cat === 'abilities') {
        setDetailData(row);
        fetchNameMatchedEnrichment('abilities', String(row.name ?? ''), api.dbAbilityWiki);
      }
      else if (cat === 'keyitems') {
        setDetailData(row);
        fetchNameMatchedEnrichment('key_items', String(row.name ?? ''), api.dbKeyItemWiki);
      }
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
    } catch (_) {}
    setDetailLoading(false);
  }

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

  async function fetchWiki() {
    if (!detailRow) return;
    setWikiLoading(true); setWikiData(null);
    try {
      let result: { description?: string; wikiUrl?: string; notFound?: boolean } | null = null;
      if (cat === 'npcs') result = await api.dbNpcWiki(String(detailRow.name ?? ''));
      else if (cat === 'mobs') result = await api.dbNpcWiki(String(detailRow.name ?? ''));
      else if (cat === 'zones') result = await api.dbZoneWiki(String(detailRow.name ?? ''));
      setWikiData(result);
    } catch (_) { setWikiData({ notFound: true }); }
    setWikiLoading(false);
  }

  async function fetchScript() {
    if (!detailRow) return;
    setScriptLoading(true); setScriptData(null);
    try {
      const result = await api.questScript(String(detailRow.name ?? ''));
      setScriptData(result);
    } catch (_) { setScriptData({ found: false }); }
    setScriptLoading(false);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !detailRow) return;
    try {
      if (cat === 'items') await api.uploadItemImage(Number(detailRow.itemid), file);
      else if (cat === 'npcs') await api.uploadNpcImage(Number(detailRow.npcid), file);
      else if (cat === 'mobs') await api.uploadMobImage(String(detailRow.name ?? ''), file);
    } catch (err) { alert((err as Error).message); }
    e.target.value = '';
  }

  function selectCat(key: Category) {
    setCat(key); setSearch(''); setSortKey(''); setSortDir('asc'); setZoneFilter(''); setRegionFilter(null); setRoleFilter(null); setMobsRegionFilter(null); setMobsEcosystemFilter(null); setAggroFilter(false); setJobFilter(null); setTypeFilter(null); setSlotFilter(null); setSkillFilter(null); setJobFilterItems(null); setRareExFilter(false); setQuestLogFilter(null); setDetailRow(null); setDetailData(null);
  }

  function selectTypeFilter(v: number | null) {
    setTypeFilter(v); setSlotFilter(null); setSkillFilter(null); setJobFilterItems(null);
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Category sidebar */}
      <div style={{ width: 170, background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)', padding: '12px 8px', flexShrink: 0, overflowY: 'auto' }}>
        {renderCatGroup('Server Data', SERVER_CATS, cat, selectCat)}
        {datEnabled && renderCatGroup('Client Reference', CLIENT_REF_CATS, cat, selectCat)}
      </div>

      {/* Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        <div style={{ padding: '12px 16px', display: 'flex', gap: 10, alignItems: 'center' }}>
          <form onSubmit={onSearch} style={{ flex: 1, maxWidth: 300, display: 'flex', gap: 6 }}>
            <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${CATS.find((c) => c.key === cat)?.label ?? ''}…`} />
            <button type="submit" className="btn btn-ghost btn-sm">Search</button>
          </form>
          {hasZoneFilter && (
            <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)}
              style={{ background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '7px 9px', borderRadius: 7, fontSize: 12 }}>
              <option value="">All zones</option>
              {zones.map((z) => <option key={z.zoneid} value={z.name}>{z.name}</option>)}
            </select>
          )}
          {isDialog && (
            <select value={dialogZone ?? ''} onChange={(e) => setDialogZone(Number(e.target.value))}
              style={{ background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '7px 9px', borderRadius: 7, fontSize: 12 }}>
              {dzones.map((z) => <option key={z.id} value={z.id}>{z.name.replace(/_/g, ' ')}</option>)}
            </select>
          )}
          {cat === 'items' && chipBtn('Rare/Ex', 1, rareExFilter ? 1 : null, (v) => setRareExFilter(v === 1))}
          {cat === 'mobs' && chipBtn('Aggro only', 1, aggroFilter ? 1 : null, (v) => setAggroFilter(v === 1))}
          <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>{rows.length} rows</span>
        </div>
        {hasJobFilter && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, jobFilter, setJobFilter)}
            {JOB_ABBR.map((abbr, i) => chipBtn(abbr, i, jobFilter, setJobFilter))}
          </div>
        )}
        {hasTypeFilter && itemTypes.length > 0 && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, typeFilter, selectTypeFilter)}
            {itemTypes.map(t => chipBtn(ITEM_TYPE[t.type] ?? `Type ${t.type}`, t.type, typeFilter, selectTypeFilter))}
          </div>
        )}
        {hasTypeFilter && (typeFilter === 6 || typeFilter === 7) && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, slotFilter, setSlotFilter)}
            {SLOT_NAMES.map((name, i) => chipBtn(name, 1 << i, slotFilter, setSlotFilter))}
          </div>
        )}
        {hasTypeFilter && (typeFilter === 6 || typeFilter === 7) && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, skillFilter, setSkillFilter)}
            {Object.entries(WEAPON_SKILL_NAMES).map(([id, name]) => chipBtn(name, Number(id), skillFilter, setSkillFilter))}
          </div>
        )}
        {hasTypeFilter && (typeFilter === 6 || typeFilter === 7) && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, jobFilterItems, setJobFilterItems)}
            {JOB_ABBR.slice(1).map((abbr, i) => chipBtn(abbr, i + 1, jobFilterItems, setJobFilterItems))}
          </div>
        )}
        {hasQuestLogFilter && questLogs.length > 0 && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtn('All', null, questLogFilter, setQuestLogFilter)}
            {questLogs.filter(l => l.total > 0).map(l => chipBtn(l.name, l.logId, questLogFilter, setQuestLogFilter))}
          </div>
        )}
        {cat === 'npcs' && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All regions', null, regionFilter, setRegionFilter)}
            {REGIONS.map(r => chipBtnStr(r.label, r.key, regionFilter, setRegionFilter))}
          </div>
        )}
        {cat === 'npcs' && npcRoles.some(r => r.cnt > 0) && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All roles', null, roleFilter, setRoleFilter)}
            {npcRoles.filter(r => r.cnt > 0).map(r => chipBtnStr(NPC_ROLE_LABELS[r.role] ?? r.role, r.role, roleFilter, setRoleFilter))}
          </div>
        )}
        {cat === 'mobs' && (
          <div style={{ padding: '6px 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All regions', null, mobsRegionFilter, setMobsRegionFilter)}
            {REGIONS.map(r => chipBtnStr(r.label, r.key, mobsRegionFilter, setMobsRegionFilter))}
          </div>
        )}
        {cat === 'mobs' && mobEcosystems.length > 0 && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {chipBtnStr('All', null, mobsEcosystemFilter, setMobsEcosystemFilter)}
            {mobEcosystems.map(e => chipBtnStr(e.ecosystem, e.ecosystem, mobsEcosystemFilter, setMobsEcosystemFilter))}
          </div>
        )}
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>{cols.map((c) => (
                <th key={c.key} onClick={() => onSort(c.key)} title="Click to sort"
                  style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', color: sortKey === c.key ? 'var(--color-accent)' : undefined }}>
                  {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {displayRows.map((row, i) => (
                <tr key={i} onClick={isClickable ? () => openDetail(row as Record<string, unknown>) : undefined}
                  style={isClickable ? { cursor: 'pointer' } : undefined}>
                  {cols.map((c) => (
                    <td key={c.key} style={{ color: c.color ?? 'var(--color-text2)' }}>
                      {c.render ? c.render((row as Record<string, unknown>)[c.key], row as Record<string, unknown>) : String((row as Record<string, unknown>)[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div style={{ padding: '16px', color: 'var(--color-text3)', textAlign: 'center' }}>Loading…</div>}
          {!loading && rows.length === 0 && <div style={{ padding: '24px', color: 'var(--color-text3)', textAlign: 'center' }}>No results</div>}
          {paged && hasMore && !loading && (
            <div style={{ padding: '12px 16px', textAlign: 'center' }}>
              <button onClick={() => load(false)} className="btn btn-ghost btn-sm">Load more</button>
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {detailRow && (
        <div style={{ width: 320, borderLeft: '1px solid var(--color-border)', background: 'var(--color-surface)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 13, fontWeight: 700, flex: 1, color: 'var(--color-text1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fmtName(String(detailRow.name ?? detailRow.itemid ?? ''))}
            </span>
            {hasMapLink && (
              <button onClick={() => navigate('/map', { state: { zoneId: Number(cat === 'zones' ? detailRow!.zoneid : detailRow!.zoneid) } })}
                className="btn btn-ghost btn-xs" style={{ fontSize: 10, padding: '3px 7px' }}>Map ↗</button>
            )}
            {hasWiki && (
              <button onClick={fetchWiki} disabled={wikiLoading} className="btn btn-ghost btn-xs" style={{ fontSize: 10, padding: '3px 7px' }}>
                {wikiLoading ? '…' : 'Wiki'}
              </button>
            )}
            {hasUpload && (
              <>
                <input ref={uploadRef} type="file" accept="image/*" onChange={handleUpload} style={{ display: 'none' }} />
                <button onClick={() => uploadRef.current?.click()} className="btn btn-ghost btn-xs" style={{ fontSize: 10, padding: '3px 7px' }}>Upload</button>
              </>
            )}
            {hasScript && (
              <button onClick={fetchScript} disabled={scriptLoading} className="btn btn-ghost btn-xs" style={{ fontSize: 10, padding: '3px 7px' }}>
                {scriptLoading ? '…' : 'Script'}
              </button>
            )}
            <button onClick={() => { setDetailRow(null); setDetailData(null); setWikiData(null); setScriptData(null); setEnrichment({ loading: false, source: null, text: null }); setNpcDialog(null); }} className="btn btn-ghost btn-xs">✕</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', fontSize: 12 }}>
            {detailLoading && <div style={{ color: 'var(--color-text3)' }}>Loading…</div>}
            {detailData && <DetailView data={detailData} cat={cat} itemImageUrl={itemImageUrl} enrichment={enrichment} npcDialog={npcDialog} />}
            {wikiData && (
              <div style={{ marginTop: detailData ? 12 : 0, padding: '10px 12px', background: 'var(--color-surface2)', borderRadius: 8, border: '1px solid var(--color-border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)' }}>BG Wiki</span>
                  {wikiData.wikiUrl && <a href={wikiData.wikiUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: 'var(--color-accent)', textDecoration: 'none' }}>Open ↗</a>}
                </div>
                {wikiData.notFound ? (
                  <div style={{ color: 'var(--color-text3)', fontSize: 11 }}>Not found on BG Wiki.</div>
                ) : wikiData.description ? (
                  <div style={{ color: 'var(--color-text2)', fontSize: 12, lineHeight: 1.5 }}>{wikiData.description}</div>
                ) : (
                  <div style={{ color: 'var(--color-text3)', fontSize: 11 }}>No description available.</div>
                )}
              </div>
            )}
            {scriptData && (
              <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--color-surface2)', borderRadius: 8, border: '1px solid var(--color-border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)' }}>Quest Script</span>
                  {scriptData.path && <span style={{ fontSize: 10, color: 'var(--color-text3)' }}>{scriptData.path}</span>}
                </div>
                {!scriptData.found ? (
                  <div style={{ color: 'var(--color-text3)', fontSize: 11 }}>Script not found (scripts dir may not be mounted).</div>
                ) : (
                  <>
                    {scriptData.vars && scriptData.vars.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 10, color: 'var(--color-text3)', marginBottom: 4 }}>Char Vars used:</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                          {scriptData.vars.map(v => <span key={v} style={{ fontSize: 10, padding: '1px 6px', background: 'rgba(124,106,247,.15)', color: 'var(--color-accent)', borderRadius: 4 }}>{v}</span>)}
                        </div>
                      </div>
                    )}
                    <pre style={{ fontSize: 10, color: 'var(--color-text2)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 300, margin: 0 }}>{scriptData.content}</pre>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type ColDef = { key: string; label: string; color?: string; render?: (v: unknown, row: Record<string, unknown>) => React.ReactNode };

// Index 0 = monster/pet abilities; 1–22 = player jobs
const JOB_ABBR = ['MON','WAR','MNK','WHM','BLM','RDM','THF','PLD','DRK','BST','BRD','RNG','SAM','NIN','DRG','SMN','BLU','COR','PUP','DNC','SCH','GEO','RUN'];

// item_basic.type values — verified against /home/sora/ffxi/sql/item_basic.sql
// (@GENERAL_TYPE=1 .. @CURRENCY_TYPE=8) and live GET /api/db/items?type=N
// for N=1..8. The old map here did not match this schema at all.
const ITEM_TYPE: Record<number, string> = {
  1: 'General', 2: 'Linkshell', 3: 'Furnishing', 4: 'Puppet',
  5: 'Usable', 6: 'Equipment', 7: 'Weapon', 8: 'Currency',
};

// item_equipment.slot bit indices, used both for the Items detail panel's
// "Slot" row and the Equipment second-level filter chips (Task 3).
const SLOT_NAMES = ['Main','Sub','Range','Ammo','Head','Body','Hands','Legs','Feet','Neck','Waist','L.Ear','R.Ear','L.Ring','R.Ring','Back'];

// item_weapon.skill values — verified live against GET /api/db/items?type=7&skill=N
// for N=1..15, matches /home/sora/ffxi/sql/item_basic.sql's AH weapon category list.
const WEAPON_SKILL_NAMES: Record<number, string> = {
  1: 'H2H', 2: 'Dagger', 3: 'Sword', 4: 'Greatsword', 5: 'Axe', 6: 'Greataxe',
  7: 'Scythe', 8: 'Polearm', 9: 'Katana', 10: 'Greatkatana', 11: 'Club',
  12: 'Staff', 13: 'Bow', 14: 'Instrument', 15: 'Ammunition',
};

// Matches src/catalog.ts's NPC_REGION_SQL keys exactly — six geographic
// regions the backend filters NPCs and Mobs by (?region=). Not
// NPC-specific despite the original name — both categories reuse this.
const REGIONS: { key: string; label: string }[] = [
  { key: 'san_doria', label: "San d'Oria" },
  { key: 'bastok', label: 'Bastok' },
  { key: 'windurst', label: 'Windurst' },
  { key: 'jeuno', label: 'Jeuno' },
  { key: 'aht_urhgan', label: 'Aht Urhgan' },
  { key: 'adoulin', label: 'Adoulin' },
];

// Matches the role keys src/npc-roles.ts's classifyNpcScript can return.
const NPC_ROLE_LABELS: Record<string, string> = {
  shop: 'Shop', quest: 'Quest', mission: 'Mission', homepoint: 'Homepoint',
};

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
  const active = value === current;
  return (
    <button key={String(value)} onClick={() => set(active ? null : value)}
      style={{ padding: '3px 9px', borderRadius: 20, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer',
        background: active ? 'var(--color-accent)' : 'var(--color-surface2)',
        color: active ? '#fff' : 'var(--color-text3)' }}>
      {label}
    </button>
  );
}

function chipBtnStr(label: string, value: string | null, current: string | null, set: (v: string | null) => void) {
  const active = value === current;
  return (
    <button key={String(value)} onClick={() => set(active ? null : value)}
      style={{ padding: '3px 9px', borderRadius: 20, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer',
        background: active ? 'var(--color-accent)' : 'var(--color-surface2)',
        color: active ? '#fff' : 'var(--color-text3)' }}>
      {label}
    </button>
  );
}

function DRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(42,42,61,.3)', fontSize: 12 }}>
      <span style={{ flex: '0 0 110px', color: 'var(--color-text3)', fontSize: 11 }}>{k}</span>
      <span style={{ color: 'var(--color-text1)' }}>{v}</span>
    </div>
  );
}

// Shared by Items/Abilities/Key Items detail views: renders whichever
// source (DAT, Wiki, or neither) resolved the description, with a small
// caption naming the source. `idMismatchCaveat`, when non-null, is
// appended to the DAT caption — used by Abilities/Key Items, which match
// by name across two different id spaces (see enrichment fetch functions).
function EnrichedDescription({ enrichment, idMismatchCaveat, noneMessage }: { enrichment: Enrichment; idMismatchCaveat: string | null; noneMessage?: string }) {
  if (enrichment.loading) {
    return <div style={{ fontSize: 12, color: 'var(--color-text3)', marginBottom: 8 }}>Loading…</div>;
  }
  if (enrichment.source === 'none' || enrichment.source === null) {
    return <div style={{ fontSize: 12, color: 'var(--color-text3)', marginBottom: 8 }}>{noneMessage ?? "No description available — not on this server's DAT or BG-Wiki."}</div>;
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

function DetailView({ data, cat, itemImageUrl, enrichment, npcDialog }: { data: Record<string, unknown>; cat: Category; itemImageUrl?: string | null; enrichment: Enrichment; npcDialog: NpcDialog | null }) {
  if (cat === 'items') {
    const slots = Number(data.slot ?? 0);
    const equippedSlots = SLOT_NAMES.filter((_, i) => (slots >> i) & 1);
    const jobsMask = Number(data.jobs ?? 0);
    const jobList = JOB_ABBR.slice(1).filter((_, i) => (jobsMask >> (i + 1)) & 1);
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
        {data.level   != null && <DRow k="Level" v={String(data.level)} />}
        {data.ilevel  != null && <DRow k="iLevel" v={String(data.ilevel)} />}
        {data.type    != null && <DRow k="Type" v={ITEM_TYPE[Number(data.type)] ?? String(data.type)} />}
        {data.stackSize != null && <DRow k="Stack" v={String(data.stackSize)} />}
        {data.BaseSell != null && <DRow k="Base sell" v={`${Number(data.BaseSell).toLocaleString()} gil`} />}
        {equippedSlots.length > 0 && <DRow k="Slot" v={equippedSlots.join(', ')} />}
        {jobList.length > 0 && <DRow k="Jobs" v={jobList.join(' ')} />}
        {data.dmg  != null && <DRow k="Damage" v={`${data.dmg} (delay ${data.delay})`} />}
        {data.skill != null && <DRow k="Skill" v={String(data.skill)} />}
        {data.shieldSize != null && <DRow k="Shield size" v={String(data.shieldSize)} />}
        {data.maxCharges != null && <DRow k="Charges" v={`${data.maxCharges} (${data.useDelay}s / ${data.reuseDelay}s)`} />}
        {data.furnStorage != null && <DRow k="Storage" v={String(data.furnStorage)} />}
        {(() => {
          const mods = data.mods as { modId: number; value: number }[] | undefined;
          const MOD_NAME: Record<number, string> = {0:'STR',1:'DEX',2:'VIT',3:'AGI',4:'INT',5:'MND',6:'CHR',8:'HP',9:'MP',10:'ATT',11:'DEF',12:'ACC',13:'EVA',14:'RACC',15:'RATT',17:'MP↺',40:'Haste',53:'PDT',54:'MDT',104:'Store TP'};
          if (!mods?.length) return null;
          return (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', marginBottom: 4 }}>Stats</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {mods.map((m, i) => <span key={i} style={{ background: 'var(--color-surface2)', borderRadius: 4, padding: '2px 6px', fontSize: 11, color: m.value >= 0 ? 'var(--color-teal)' : 'var(--color-red)' }}>{MOD_NAME[m.modId] ?? `Mod${m.modId}`} {m.value > 0 ? '+' : ''}{m.value}</span>)}
              </div>
            </div>
          );
        })()}
        {(() => {
          const drops = data.drops as { name: string; zone: string; itemRate: number }[] | undefined;
          if (!drops?.length) return null;
          return (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', marginBottom: 4 }}>Dropped by</div>
              {drops.slice(0, 8).map((d, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid rgba(42,42,61,.2)', fontSize: 12 }}>
                  <span style={{ flex: 1, color: 'var(--color-text1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtName(d.name)}</span>
                  <span style={{ color: 'var(--color-text3)', fontSize: 11, flexShrink: 0 }}>{fmtName(d.zone)}</span>
                  <span style={{ color: 'var(--color-teal)', fontSize: 11, flexShrink: 0 }}>{(d.itemRate / 10).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          );
        })()}
        {(() => {
          const recipes = data.recipes as { crystalName: string; Wood: number; Smith: number; Gold: number; Cloth: number; Leather: number; Bone: number; Alchemy: number; Cook: number; ResultQty: number; ing1?: string; ing2?: string; ing3?: string; ing4?: string }[] | undefined;
          if (!recipes?.length) return null;
          const CRAFT_NAMES = ['Wood','Smith','Gold','Cloth','Leather','Bone','Alchemy','Cook'] as const;
          return (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', marginBottom: 4 }}>Recipes</div>
              {recipes.map((r, i) => {
                const skills = CRAFT_NAMES.filter(c => (r as Record<string, unknown>)[c] as number > 0).map(c => `${c} ${(r as Record<string, unknown>)[c]}`);
                const ings = [r.ing1, r.ing2, r.ing3, r.ing4].filter(Boolean);
                return (
                  <div key={i} style={{ padding: '5px 0', borderBottom: '1px solid rgba(42,42,61,.2)', fontSize: 12 }}>
                    <div style={{ color: 'var(--color-text3)', fontSize: 11 }}>{r.crystalName ? fmtName(r.crystalName) + ' · ' : ''}{skills.join(', ')}</div>
                    <div style={{ color: 'var(--color-text1)', marginTop: 2 }}>{ings.map(fmtName).join(' + ')}{r.ResultQty > 1 ? ` ×${r.ResultQty}` : ''}</div>
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>
    );
  }
  if (cat === 'mobs') {
    const ELEM = ['Fire','Ice','Wind','Earth','Thunder','Water','Light','Dark'];
    const elem = Number(data.element ?? -1);
    const SDT: Record<string, string> = { fire_sdt:'Fire',ice_sdt:'Ice',wind_sdt:'Wind',earth_sdt:'Earth',lightning_sdt:'Thunder',water_sdt:'Water',light_sdt:'Light',dark_sdt:'Dark',slash_sdt:'Slash',pierce_sdt:'Pierce',h2h_sdt:'H2H',impact_sdt:'Impact' };
    const res = data.resistances as Record<string, number> | undefined;
    const drops = data.drops as { item: string; itemid: number; itemRate: number; groupRate: number }[] | undefined;
    const lvl = data.min_lvl != null && data.max_lvl != null
      ? (data.min_lvl === data.max_lvl ? String(data.min_lvl) : `${data.min_lvl}–${data.max_lvl}`)
      : null;
    return (
      <div>
        {data.zone       != null && <DRow k="Zone" v={fmtName(String(data.zone))} />}
        {lvl             != null && <DRow k="Level" v={lvl} />}
        {data.spawns     != null && <DRow k="Spawns" v={String(data.spawns)} />}
        {data.family     != null && <DRow k="Family" v={fmtName(String(data.family))} />}
        {data.ecosystem  != null && <DRow k="Ecosystem" v={String(data.ecosystem)} />}
        {elem >= 0 && elem < ELEM.length && <DRow k="Element" v={ELEM[elem]} />}
        {data.mjob       != null && <DRow k="Job" v={JOB_ABBR[Number(data.mjob)] ?? String(data.mjob)} />}
        {data.aggro      != null && <DRow k="Aggro" v={data.aggro ? 'Yes' : 'No'} />}
        {data.links      != null && <DRow k="Links" v={data.links ? 'Yes' : 'No'} />}
        {data.charmable  != null && <DRow k="Charmable" v={data.charmable ? 'Yes' : 'No'} />}
        {res && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', marginBottom: 4 }}>Resistances (%)</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {Object.entries(SDT).map(([k, lbl]) => res[k] != null ? (
                <span key={k} style={{ background: 'var(--color-surface2)', borderRadius: 4, padding: '2px 6px', fontSize: 11,
                  color: Number(res[k]) < 100 ? 'var(--color-teal)' : Number(res[k]) > 100 ? 'var(--color-red)' : 'var(--color-text3)' }}>
                  {lbl} {res[k]}
                </span>
              ) : null)}
            </div>
          </div>
        )}
        {drops && drops.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', marginBottom: 4 }}>Drops</div>
            {drops.map((d, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid rgba(42,42,61,.2)', fontSize: 12 }}>
                <span style={{ flex: 1, color: 'var(--color-text1)' }}>{fmtName(d.item)}</span>
                <span style={{ color: 'var(--color-text3)', fontSize: 11 }}>{(d.itemRate / 10).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (cat === 'zones') {
    return (
      <div>
        {data.zoneid   != null && <DRow k="Zone ID" v={String(data.zoneid)} />}
        {data.region   != null && <DRow k="Region" v={String(data.region)} />}
        {data.npc_count != null && <DRow k="NPCs" v={String(data.npc_count)} />}
        {data.mob_count != null && <DRow k="Mobs" v={String(data.mob_count)} />}
      </div>
    );
  }
  if (cat === 'npcs') {
    const roles = Array.isArray(data.role) ? (data.role as string[]) : [];
    return (
      <div>
        {data.npcid != null && <DRow k="NPC ID" v={String(data.npcid)} />}
        {data.zone  != null && <DRow k="Zone" v={fmtName(String(data.zone))} />}
        {data.x     != null && <DRow k="X" v={Number(data.x).toFixed(2)} />}
        {data.z     != null && <DRow k="Z" v={Number(data.z).toFixed(2)} />}
        {roles.length > 0 && <DRow k="Roles" v={roles.map(r => NPC_ROLE_LABELS[r] ?? r).join(', ')} />}
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
  if (cat === 'trusts') {
    return (
      <div>
        {data.itemid != null && <DRow k="Item ID" v={String(data.itemid)} />}
        {data.name   != null && <DRow k="Internal name" v={String(data.name)} />}
      </div>
    );
  }
  if (cat === 'mounts') {
    return (
      <div>
        {data.itemid != null && <DRow k="Item ID" v={String(data.itemid)} />}
        {data.name   != null && <DRow k="Internal name" v={String(data.name)} />}
      </div>
    );
  }
  if (cat === 'quests') {
    return (
      <div>
        <EnrichedDescription enrichment={enrichment} idMismatchCaveat={null} noneMessage="No walkthrough available — not in the quest script or BG-Wiki." />
        {data.questId  != null && <DRow k="Quest ID" v={String(data.questId)} />}
        {data.logName  != null && <DRow k="Area" v={String(data.logName)} />}
        {data.logId    != null && <DRow k="Log ID" v={String(data.logId)} />}
      </div>
    );
  }
  if (cat === 'abilities') {
    const ACTION_TYPE_MAP: Record<number, string> = { 3: 'Ranged', 6: 'Job Ability', 13: 'Pet Command' };
    const fmtTicks = (t: number) => t >= 3600 ? `${t/3600}h` : t >= 60 ? `${Math.floor(t/60)}m${t%60 ? ` ${t%60}s` : ''}` : `${t}s`;
    const abilityCaveat = enrichment.source === 'dat' && enrichment.datId != null ? `id ${enrichment.datId}, matched by name — server id is ${data.abilityId}` : null;
    return (
      <div>
        <EnrichedDescription enrichment={enrichment} idMismatchCaveat={abilityCaveat} />
        {data.job       != null && <DRow k="Job" v={JOB_ABBR[Number(data.job)] ?? String(data.job)} />}
        {data.level     != null && <DRow k="Level" v={String(data.level)} />}
        {data.actionType != null && <DRow k="Type" v={ACTION_TYPE_MAP[Number(data.actionType)] ?? String(data.actionType)} />}
        {data.recastTime != null && Number(data.recastTime) > 0 && <DRow k="Recast" v={fmtTicks(Number(data.recastTime))} />}
        {data.castTime  != null && Number(data.castTime) > 0 && <DRow k="Cast" v={fmtTicks(Number(data.castTime))} />}
        {data.range     != null && Number(data.range) > 0 && <DRow k="Range" v={`${data.range} yalms`} />}
        {data.isAOE     != null && Number(data.isAOE) > 0 && <DRow k="AoE" v="Yes" />}
      </div>
    );
  }
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
const ACTION_TYPE: Record<number, string> = { 3: 'Ranged', 6: 'JA', 13: 'Pet' };

function getColumns(cat: Category): ColDef[] {
  switch (cat) {
    case 'items':    return [{ key: 'itemid', label: 'ID', color: 'var(--color-text3)' }, { key: 'name', label: 'Name', color: 'var(--color-text1)', render: fmtName }, { key: 'type', label: 'Type' }, { key: 'stackSize', label: 'Stack' }, { key: 'level', label: 'Lv' }, { key: 'BaseSell', label: 'Sell', render: (v) => v != null && Number(v) > 0 ? Number(v).toLocaleString() : '—' }];
    case 'npcs':     return [{ key: 'npcid', label: 'ID', color: 'var(--color-text3)' }, { key: 'name', label: 'Name', color: 'var(--color-text1)', render: fmtName }, { key: 'zone', label: 'Zone', render: fmtName }, { key: 'x', label: 'X', render: (v) => v != null ? Number(v).toFixed(1) : '—' }, { key: 'z', label: 'Z', render: (v) => v != null ? Number(v).toFixed(1) : '—' }];
    case 'mobs':     return [{ key: 'name', label: 'Name', color: 'var(--color-text1)', render: fmtName }, { key: 'zone', label: 'Zone', render: fmtName }, { key: 'min_lvl', label: 'Min Lv' }, { key: 'max_lvl', label: 'Max Lv' }, { key: 'family', label: 'Family', render: fmtName }, { key: 'aggro', label: 'Aggro', render: (v) => v ? <span style={{ color: 'var(--color-red)' }}>✓</span> : <span style={{ color: 'var(--color-text3)' }}>—</span> }];
    case 'zones':    return [{ key: 'zoneid', label: 'ID', color: 'var(--color-text3)' }, { key: 'name', label: 'Name', color: 'var(--color-text1)', render: fmtName }, { key: 'npc_count', label: 'NPCs' }, { key: 'mob_count', label: 'Mobs' }];
    case 'jobs':     return [{ key: 'job', label: 'Job', color: 'var(--color-text1)' }, { key: 'max', label: 'Max Level' }, { key: 'count', label: 'Characters' }];
    case 'skills':   return [{ key: 'name', label: 'Skill', color: 'var(--color-text1)', render: fmtName }, { key: 'r1', label: 'A-Rank Cap' }];
    case 'abilities':return [{ key: 'name', label: 'Name', color: 'var(--color-text1)', render: fmtName }, { key: 'job', label: 'Job', render: (v) => JOB_ABBR[Number(v)] ?? '—' }, { key: 'actionType', label: 'Type', render: (v) => ACTION_TYPE[Number(v)] ?? String(v) }, { key: 'level', label: 'Level' }];
    case 'quests':   return [{ key: 'questId', label: 'ID', color: 'var(--color-text3)' }, { key: 'name', label: 'Name', color: 'var(--color-text1)' }, { key: 'logName', label: 'Area' }, { key: 'logId', label: 'Log' }];
    case 'keyitems': return [{ key: 'id', label: 'ID', color: 'var(--color-text3)' }, { key: 'name', label: 'Name', color: 'var(--color-text1)', render: fmtName }];
    case 'trusts':   return [{ key: 'name', label: 'Trust', color: 'var(--color-text1)', render: fmtTrust }, { key: 'itemid', label: 'Item ID', color: 'var(--color-text3)' }];
    case 'mounts':   return [{ key: 'name', label: 'Mount', color: 'var(--color-text1)', render: fmtMount }, { key: 'itemid', label: 'Item ID', color: 'var(--color-text3)' }];
    case 'gmcmds':   return [{ key: 'name', label: 'Command', color: 'var(--color-accent)' }, { key: 'group', label: 'Category', color: 'var(--color-text3)' }, { key: 'desc', label: 'Description', color: 'var(--color-text2)' }];
    case 'spells': case 'statuses': case 'titles': case 'monster_skills': case 'emotes': case 'augments':
      return [{ key: 'id', label: 'ID', color: 'var(--color-text3)' }, { key: 'name', label: 'Name', color: 'var(--color-text1)' }, { key: 'description', label: 'Description', color: 'var(--color-text2)' }];
    case 'dialog':
      return [{ key: 'id', label: 'ID', color: 'var(--color-text3)' }, { key: 'name', label: 'Text', color: 'var(--color-text2)' }];
    default: return [];
  }
}

// DB names are stored as underscore_separated — convert to "Title Case With Spaces"
function fmtName(v: unknown): string {
  const s = String(v ?? '');
  return s
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    // Fix Roman numeral suffixes that title-case gets wrong (Ii→II, Iii→III, Iv→IV, etc.)
    .replace(/\b(Ii{1,2}|Iv|Vi{0,3}|Ix|Xi{0,3})\b/g, m => m.toUpperCase());
}

// Trust cipher names: "cipher_of_foo_alter_ego" → "Foo"
function fmtTrust(v: unknown): string {
  const s = String(v ?? '').replace(/^cipher_of_/, '').replace(/_alter_ego$/, '');
  return fmtName(s);
}

// Mount names have a ♪ prefix in the DB
function fmtMount(v: unknown): string {
  return fmtName(String(v ?? '').replace(/^♪/, ''));
}
