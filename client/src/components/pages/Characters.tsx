import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { api } from '../../api';
import type { Player, CharBasic, CharExtended, Skill } from '../../types';

const JOB  = ['','WAR','MNK','WHM','BLM','RDM','THF','PLD','DRK','BST','BRD','RNG','SAM','NIN','DRG','SMN','BLU','COR','PUP','DNC','SCH','GEO','RUN'];
const RACE = ['','Hume (M)','Hume (F)','Elvaan (M)','Elvaan (F)','Tarutaru (M)','Tarutaru (F)','Mithra','Galka'];
const SLOT: Record<number, string> = {0:'Main',1:'Sub',2:'Range',3:'Ammo',4:'Head',5:'Body',6:'Hands',7:'Legs',8:'Feet',9:'Neck',10:'Waist',11:'L.Ear',12:'R.Ear',13:'L.Ring',14:'R.Ring',15:'Back'};
// LSB CONTAINER_ID values (char_inventory.location)
const BAGS: Record<number, string> = {0:'Inventory',1:'Mog Safe',2:'Storage',3:'Temp Items',4:'Mog Locker',5:'Satchel',6:'Sack',7:'Case',8:'Wardrobe',9:'Mog Safe 2',10:'Wardrobe 2',11:'Wardrobe 3',12:'Wardrobe 4',13:'Wardrobe 5',14:'Wardrobe 6',15:'Wardrobe 7',16:'Wardrobe 8',17:'Recycle Bin'};
// location → char_storage capacity column
const LOC_STORAGE_KEY: Record<number, string> = {0:'inventory',1:'safe',4:'locker',5:'satchel',6:'sack',7:'case',8:'wardrobe',10:'wardrobe2',11:'wardrobe3',12:'wardrobe4'};

function fmtRelTime(ts: number | string) {
  // unix seconds from the API; tolerate a datetime string from older payloads
  const t = typeof ts === 'number' ? ts : Date.parse(ts) / 1000;
  if (!Number.isFinite(t)) return null;
  const secs = Math.floor((Date.now() / 1000) - t);
  if (secs < 120)  return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ── Character list ────────────────────────────────────────────────────────────
export function Characters() {
  const players = useStore((s) => s.players);
  const [chars, setChars] = useState<Player[]>([]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const navigate = useNavigate();

  useEffect(() => { api.chars().then(setChars).catch(() => {}); }, []);

  const onlineIds = useMemo(() => new Set(players.filter((p) => p.online).map((p) => p.charid)), [players]);

  const visible = useMemo(() => {
    let list = chars;
    if (filter === 'online') list = list.filter((c) => onlineIds.has(c.charid));
    if (filter === 'gm')     list = list.filter((c) => c.gmlevel > 0);
    if (search) list = list.filter((c) => c.charname.toLowerCase().includes(search.toLowerCase()));
    return list;
  }, [chars, filter, search, onlineIds]);

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Characters</h1>
        <span className="pill pill-muted">{chars.length} total</span>
        <div style={{ flex: 1, minWidth: 180, maxWidth: 280 }}>
          <input className="input" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['all','online','gm'] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`btn btn-ghost btn-sm ${filter === f ? 'btn-primary' : ''}`}
              style={filter === f ? { background: 'var(--color-accent)', color: '#fff', borderColor: 'var(--color-accent)' } : {}}>
              {f === 'all' ? 'All' : f === 'online' ? 'Online' : 'GM'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
        {visible.map((c) => {
          const isOnline = onlineIds.has(c.charid);
          const playSecs = c.playtime ?? 0;
          const playHrs  = Math.floor(playSecs / 3600);
          const playMins = Math.floor((playSecs % 3600) / 60);
          const lastSeen = c.last_logout ? fmtRelTime(c.last_logout) : null;
          return (
            <div
              key={c.charid}
              onClick={() => navigate(`/chars/${c.charid}`)}
              style={{
                background: 'var(--color-surface)',
                border: `1px solid var(--color-border)`,
                borderLeft: `3px solid ${isOnline ? 'var(--color-teal)' : 'var(--color-border)'}`,
                borderRadius: 10,
                padding: '14px 16px',
                cursor: 'pointer',
                transition: 'background .12s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface2)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface)'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--color-text1)', flex: 1 }}>{c.charname}</span>
                {c.gmlevel > 0 && <span className="pill pill-gold" style={{ fontSize: 10 }}>GM{c.gmlevel}</span>}
                {isOnline && <span className="pill pill-teal" style={{ fontSize: 10 }}>Online</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text3)' }}>
                {c.race != null ? (RACE[c.race] ?? 'Unknown') : '?'} · {JOB[c.mjob] ?? '?'}{c.mlvl}
                {c.sjob ? `/${JOB[c.sjob]}${c.slvl}` : ''}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 5, fontSize: 10, color: 'var(--color-text3)' }}>
                {playSecs > 0 && <span>{playHrs}h {playMins}m played</span>}
                {!isOnline && lastSeen && <span>· {lastSeen}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Character detail ──────────────────────────────────────────────────────────
export function CharacterDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const user = useStore((s) => s.user);
  const [char, setChar] = useState<CharBasic | null>(null);
  const [ext, setExt]   = useState<CharExtended | null>(null);
  const [equip, setEquip] = useState<{ slot: number; itemId: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('overview');

  useEffect(() => {
    if (!id) return;
    const nid = Number(id);
    setLoading(true);
    // Single aggregate request: basic + extended + equipment (was 3 requests).
    api.charFull(nid)
      .then(({ basic, extended, equipment }) => { setChar(basic); setExt(extended); setEquip(equipment); })
      .catch(() => navigate('/chars'))
      .finally(() => setLoading(false));
  }, [id, navigate]);

  if (loading) return <div style={{ padding: 24, color: 'var(--color-text3)' }}>Loading…</div>;
  if (!char) return null;

  const job = `${JOB[char.mjob] ?? '?'}${char.mlvl}${char.sjob ? `/${JOB[char.sjob]}${char.slvl}` : ''}`;
  const isAdmin = user?.tier === 'admin';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Sticky header */}
      <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '14px 24px 0', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button onClick={() => navigate('/chars')} className="btn btn-ghost btn-sm">← Back</button>
          <span style={{ fontSize: 18, fontWeight: 700 }}>{char.charname}</span>
          <span className="pill pill-accent">{job}</span>
          {char.gmlevel > 0 && <span className="pill pill-gold">GM{char.gmlevel}</span>}
          <span className="pill pill-muted">{RACE[char.race] ?? 'Unknown'}</span>
          <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--color-gold)', fontWeight: 700 }}>
            {char.gil?.toLocaleString() ?? 0} gil
          </span>
        </div>
        <div style={{ display: 'flex', gap: 0, borderTop: '1px solid var(--color-border)', marginLeft: -24, paddingLeft: 24 }}>
          {(['overview','gear','inventory','bags','progress','effects','blobs','quests','points','vars',...(isAdmin ? ['admin'] : [])]).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none',
              borderBottom: `2px solid ${tab === t ? 'var(--color-accent)' : 'transparent'}`,
              color: tab === t ? 'var(--color-accent)' : 'var(--color-text3)',
              padding: '10px 16px', fontSize: 13, fontWeight: 500,
              cursor: 'pointer', transition: 'all .12s', textTransform: 'capitalize',
            }}>
              {t === 'admin' ? '⚙ Admin' : t}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {tab === 'overview' && <CharOverview char={char} ext={ext} setTab={setTab} />}
        {tab === 'gear'     && <CharGear char={char} equip={equip} />}
        {tab === 'progress' && <CharProgress ext={ext} />}
        {tab === 'inventory'&& <CharInventory charId={Number(id)} />}
        {tab === 'bags'     && <CharBags charId={Number(id)} />}
        {tab === 'effects'  && <CharEffects charId={Number(id)} />}
        {tab === 'blobs'    && <CharBlobs charId={Number(id)} />}
        {tab === 'quests'   && <CharQuests charId={Number(id)} />}
        {tab === 'points'   && <CharPoints ext={ext} />}
        {tab === 'vars'  && <CharVars charId={Number(id)} isAdmin={isAdmin} />}
        {tab === 'admin' && isAdmin && <CharAdmin char={char} />}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)' }}>
        {title}
      </div>
      <div style={{ padding: '14px 16px' }}>{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid rgba(42,42,61,.4)', fontSize: 13 }}>
      <span style={{ color: 'var(--color-text3)' }}>{k}</span>
      <span style={{ color: 'var(--color-text1)', fontWeight: 600 }}>{v}</span>
    </div>
  );
}

const NATIONS = ["San d'Oria", 'Bastok', 'Windurst', 'Other'];

// Moghancement id → name (from scripts/enum/key_item.lua MOGHANCEMENT_*).
const MOGHANCEMENT: Record<number, string> = {
  512: 'Fire', 513: 'Ice', 514: 'Wind', 515: 'Earth', 516: 'Lightning', 517: 'Water', 518: 'Light', 519: 'Dark',
  520: 'Experience', 521: 'Gardening', 522: 'Desynthesis', 523: 'Fishing',
  524: 'Woodworking', 525: 'Smithing', 526: 'Goldsmithing', 527: 'Clothcraft', 528: 'Leathercraft',
  529: 'Bonecraft', 530: 'Alchemy', 531: 'Cooking',
  532: 'Conquest', 533: 'Region', 534: 'Fishing Items', 535: "San d'Oria Conquest", 536: 'Bastok Conquest',
  537: 'Windurst Conquest', 538: 'Money', 539: 'Campaign', 540: 'Money II', 541: 'Skill Gains',
  542: 'Bounty', 543: 'Mandragora Mania',
};

function fmtAgo(unixSecs?: number): string {
  if (!unixSecs) return '—';
  const diff = Date.now() / 1000 - unixSecs;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
const num = (v?: number) => Number(v ?? 0).toLocaleString();
// DB zone names use underscores (e.g. Southern_San_dOria) — show them spaced.
const prettyZone = (z?: string) => (z || '').replace(/_/g, ' ');
const titleCase = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const yn = (v: unknown) => (v ? '✓' : '—');
const coords = (x?: number, y?: number, z?: number) =>
  `${(x ?? 0).toFixed(0)}, ${(y ?? 0).toFixed(0)}, ${(z ?? 0).toFixed(0)}`;

function Vital({ label, value, color }: { label: string; value: React.ReactNode; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
    </div>
  );
}

function CharOverview({ char, ext, setTab }: { char: CharBasic; ext: CharExtended | null; setTab: (t: string) => void }) {
  const navigate = useNavigate();
  const p       = (ext?.profile ?? {}) as Record<string, number>;
  const pts     = (ext?.points  ?? {}) as Record<string, number>;
  const hist    = (ext?.history ?? {}) as Record<string, number>;
  const flags   = ext?.flags ?? {};
  const unlocks = (ext?.unlocks ?? {}) as Record<string, number>;
  const pet     = (ext?.pet ?? {}) as Record<string, number>;
  const chocobo = (ext?.chocobo ?? {}) as Record<string, unknown>;
  const jobPoints = ext?.job_points ?? [];
  const merits    = ext?.merits ?? [];
  const spells    = ext?.spells ?? [];
  const skills    = ext?.skills ?? [];
  const bagCounts = ext?.bag_counts ?? [];
  const storage   = (ext?.storage ?? {}) as Record<string, number>;

  const playSecs = char.playtime ?? 0;
  const playHrs  = Math.floor(playSecs / 3600);
  const playMins = Math.floor((playSecs % 3600) / 60);
  const online   = !!char.online;

  // All 22 job levels (JOB[1..22] map to the lowercased field names on char).
  const jobs = JOB.slice(1).map((abbr, i) => ({
    id: i + 1, abbr, lvl: (char as unknown as Record<string, number>)[abbr.toLowerCase()] ?? 0,
  }));

  const ranks = [
    { n: "San d'Oria", rank: p.rank_sandoria, fame: p.fame_sandoria },
    { n: 'Bastok',     rank: p.rank_bastok,   fame: p.fame_bastok },
    { n: 'Windurst',   rank: p.rank_windurst, fame: p.fame_windurst },
  ];
  const otherFame = [
    { n: 'Jeuno',   fame: p.fame_jeuno },
    { n: 'Norg',    fame: p.fame_norg },
    { n: 'Adoulin', fame: p.fame_adoulin },
  ].filter(f => f.fame != null);

  // Every non-zero currency from char_points, biggest first.
  const currencies = Object.entries(pts)
    .filter(([, v]) => Number(v) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  // Full lifetime history, every column.
  const HISTORY: [string, string][] = [
    ['enemies_defeated', 'Kills'], ['times_knocked_out', 'Deaths'], ['battles_fought', 'Battles'],
    ['ws_used', 'Weapon skills'], ['abilities_used', 'Abilities'], ['spells_cast', 'Spells cast'],
    ['items_used', 'Items used'], ['npc_interactions', 'NPC talks'], ['chats_sent', 'Chats sent'],
    ['distance_travelled', 'Distance'], ['mh_entrances', 'MH entrances'], ['joined_parties', 'Parties'],
    ['joined_alliances', 'Alliances'], ['gm_calls', 'GM calls'],
  ];

  // Jobs that have earned job points.
  const jpJobs = jobPoints.filter(j => (j.job_points ?? 0) + (j.job_points_spent ?? 0) > 0);

  // Spell counts grouped by school.
  const spellGroups = spells.reduce<Record<string, number>>((acc, s) => {
    const g = s.groupName || 'Other'; acc[g] = (acc[g] ?? 0) + 1; return acc;
  }, {});

  const knownSkills  = skills.filter(s => s.value > 0).length;

  const companions = [
    pet.wyvernid    ? 'Wyvern'      : null,
    pet.automatonid ? 'Automaton'   : null,
    (pet as Record<string, number>).fellowid ? 'Adv. Fellow' : null,
    pet.chocoboid   ? 'Chocobo'     : null,
  ].filter(Boolean) as string[];
  const hasChocobo = !!(chocobo.first_name || chocobo.stage);

  const UNLOCKS: [string, string][] = [
    ['outpost_sandy', 'Outpost San d\'Oria'], ['outpost_bastok', 'Outpost Bastok'],
    ['outpost_windy', 'Outpost Windurst'], ['mog_locker', 'Mog Locker'],
    ['runic_portal', 'Runic Portal'], ['maw', 'The Maw'],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Summary banner */}
      <div className="card" style={{ padding: '16px 20px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: online ? 'var(--color-teal)' : 'var(--color-text3)', boxShadow: online ? '0 0 8px var(--color-teal)' : 'none', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: online ? 'var(--color-teal)' : 'var(--color-text2)' }}>{online ? 'Online' : 'Offline'}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text3)' }}>{online ? `in ${prettyZone(char.zone_name) || '—'}` : `last seen ${fmtAgo(char.last_logout)}`}</div>
          </div>
        </div>
        <Vital label="HP"       value={char.hp + (char.gear_hp ?? 0)} color="var(--color-teal)" />
        <Vital label="MP"       value={char.mp + (char.gear_mp ?? 0)} color="#6aa0f0" />
        <Vital label="Playtime" value={`${playHrs}h ${playMins}m`}    color="var(--color-text1)" />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {char.job_master ? <span className="pill pill-gold">Job Master</span> : null}
          {char.mentor     ? <span className="pill pill-accent">Mentor</span>   : null}
          {flags.muted     ? <span className="pill pill-muted">Muted</span>     : null}
          <span className="pill pill-muted">Created {new Date((char.timecreated || 0) * 1000).toLocaleDateString()}</span>
        </div>
      </div>

      {/* Panels */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16, alignItems: 'start' }}>
        <Panel title="Jobs">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(48px, 1fr))', gap: 6 }}>
            {jobs.map((j) => {
              const isMain = j.id === char.mjob, isSub = j.id === char.sjob, on = j.lvl > 0;
              return (
                <div key={j.id} title={isMain ? 'Main job' : isSub ? 'Sub job' : ''} style={{
                  textAlign: 'center', padding: '5px 2px', borderRadius: 6,
                  background: isMain ? 'var(--color-accent)' : on ? 'var(--color-surface2)' : 'transparent',
                  border: `1px solid ${isSub ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  opacity: on ? 1 : 0.4,
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: isMain ? '#fff' : on ? 'var(--color-text1)' : 'var(--color-text3)' }}>{j.abbr}</div>
                  <div style={{ fontSize: 12, color: isMain ? '#fff' : on ? 'var(--color-text2)' : 'var(--color-text3)' }}>{j.lvl || '–'}</div>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Stats">
          <Row k="HP" v={`${char.hp} (+${char.gear_hp ?? 0})`} />
          <Row k="MP" v={`${char.mp} (+${char.gear_mp ?? 0})`} />
          <Row k="Nation" v={NATIONS[char.nation] ?? '?'} />
          <Row k="Level cap" v={`${char.genkai ?? 0}`} />
          <Row k="Rank points" v={String(p.rank_points ?? '—')} />
          {p.unity_leader ? <Row k="Unity" v={String(p.unity_leader)} /> : null}
        </Panel>

        <Panel title="Account">
          <Row k="Login" v={char.account_login ?? '—'} />
          <Row k="Character ID" v={String(char.charid)} />
          <Row k="Account ID" v={String(char.accid)} />
          <Row k="Privilege" v={String(char.account_priv ?? 0)} />
          <Row k="Status" v={char.account_status === 1 ? 'Active' : `Inactive (${char.account_status})`} />
          {char.gmlevel > 0 ? <Row k="GM level" v={String(char.gmlevel)} /> : null}
        </Panel>

        <Panel title="Identity">
          <Row k="Race" v={RACE[char.race] ?? '?'} />
          <Row k="Face" v={String(char.face ?? 0)} />
          <Row k="Size" v={['Small', 'Medium', 'Large'][char.char_size] ?? String(char.char_size)} />
          <Row k="Moghancement" v={char.moghancement ? (MOGHANCEMENT[char.moghancement] ?? `#${char.moghancement}`) : '—'} />
        </Panel>

        <Panel title="Location">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '5px 0', borderBottom: '1px solid rgba(42,42,61,.4)' }}>
            <span style={{ color: 'var(--color-text3)' }}>Zone</span>
            <button onClick={() => navigate('/map', { state: { zoneId: char.pos_zone } })}
              className="btn btn-ghost btn-xs" style={{ padding: '1px 6px', fontSize: 11, color: 'var(--color-accent)', marginLeft: 'auto' }}>
              {prettyZone(char.zone_name) || `Zone ${char.pos_zone}`} ↗
            </button>
          </div>
          <Row k="Position" v={coords(char.pos_x, char.pos_y, char.pos_z)} />
          <Row k="Home point" v={prettyZone(char.home_zone_name) || `Zone ${char.home_zone}`} />
          <Row k="Home pos" v={coords(char.home_x, char.home_y, char.home_z)} />
          {char.prev_zone_name ? <Row k="Previous" v={prettyZone(char.prev_zone_name)} /> : null}
        </Panel>

        <Panel title="Reputation">
          {ranks.map((r) => <Row key={r.n} k={r.n} v={`Rank ${r.rank ?? '—'} · Fame ${r.fame ?? '—'}`} />)}
          {otherFame.map((f) => <Row key={f.n} k={`${f.n} fame`} v={String(f.fame)} />)}
        </Panel>

        <Panel title="Activity">
          {HISTORY.map(([key, label]) => <Row key={key} k={label} v={num(hist[key])} />)}
        </Panel>

        <Panel title="Progression">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid rgba(42,42,61,.4)', fontSize: 13 }}>
            <span style={{ color: 'var(--color-text3)' }}>Skills leveled</span>
            <button onClick={() => setTab('progress')} className="btn btn-ghost btn-xs" style={{ padding: '1px 6px', fontSize: 11, color: 'var(--color-accent)' }}>
              {knownSkills} ↗
            </button>
          </div>
          <Row k="Merits" v={String(merits.length)} />
          <Row k="Spells learned" v={String(spells.length)} />
          <Row k="Job-point jobs" v={String(jpJobs.length)} />
        </Panel>

        {jpJobs.length > 0 && (
          <Panel title="Job Points">
            {jpJobs.map((j) => (
              <Row key={j.jobid} k={JOB[j.jobid] ?? `Job ${j.jobid}`} v={`${num(j.job_points)} JP · ${num(j.job_points_spent)} spent`} />
            ))}
          </Panel>
        )}

        {merits.length > 0 && (
          <Panel title={`Merits (${merits.length})`}>
            {merits.map((m) => <Row key={m.meritid} k={m.name} v={`×${m.upgrades}`} />)}
          </Panel>
        )}

        {spells.length > 0 && (
          <Panel title={`Spells (${spells.length})`}>
            {Object.entries(spellGroups).sort((a, b) => b[1] - a[1]).map(([g, n]) => <Row key={g} k={g} v={String(n)} />)}
          </Panel>
        )}

        <Panel title="Unlocks">
          {UNLOCKS.map(([key, label]) => <Row key={key} k={label} v={yn(unlocks[key])} />)}
        </Panel>

        {(companions.length > 0 || hasChocobo) && (
          <Panel title="Companions">
            {companions.map((c) => <Row key={c} k={c} v="✓" />)}
            {hasChocobo && chocobo.stage != null ? <Row k="Chocobo stage" v={String(chocobo.stage)} /> : null}
            {hasChocobo && chocobo.color != null ? <Row k="Chocobo color" v={String(chocobo.color)} /> : null}
          </Panel>
        )}

        {currencies.length > 0 && (
          <Panel title={`Currencies (${currencies.length})`}>
            {currencies.map(([k, v]) => <Row key={k} k={titleCase(k)} v={num(Number(v))} />)}
          </Panel>
        )}

        <Panel title="Inventory">
          {bagCounts.map((b) => {
            const max = storage[LOC_STORAGE_KEY[b.location]] ?? 80;
            const full = max ? b.count / max : 0;
            return (
              <div key={b.location} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 }}>
                <span style={{ color: 'var(--color-text3)', width: 74, flexShrink: 0 }}>{BAGS[b.location] ?? `Bag ${b.location}`}</span>
                <div style={{ flex: 1, height: 5, background: 'var(--color-surface2)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${full * 100}%`, height: '100%', background: full > 0.9 ? 'var(--color-red)' : 'var(--color-accent)', borderRadius: 2 }} />
                </div>
                <span style={{ color: 'var(--color-text2)', fontSize: 11, flexShrink: 0 }}>{b.count}/{max}</span>
              </div>
            );
          })}
          {bagCounts.length === 0 && <span style={{ color: 'var(--color-text3)', fontSize: 12 }}>No inventory data</span>}
        </Panel>
      </div>
    </div>
  );
}

function CharGear({ char, equip }: { char: CharBasic; equip: { slot: number; itemId: number; name: string }[] }) {
  const navigate = useNavigate();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
      <Panel title="Equipped">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
          {(Object.entries(SLOT) as [string, string][]).map(([slotKey, label]) => {
            const item = equip.find((i) => i.slot === Number(slotKey));
            return (
              <div key={slotKey} style={{ display: 'flex', gap: 8, padding: '5px 2px', borderBottom: '1px solid var(--color-border)', fontSize: 12, alignItems: 'center' }}>
                <span style={{ color: 'var(--color-text3)', fontSize: 10, width: 56, flexShrink: 0, textAlign: 'right', paddingRight: 6 }}>{label}</span>
                {item
                  ? <button onClick={() => navigate('/database', { state: { cat: 'items', search: item.name } })}
                      className="btn btn-ghost btn-xs" style={{ padding: '1px 4px', fontSize: 11, color: 'var(--color-text1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
                      {item.name}
                    </button>
                  : <span style={{ color: 'var(--color-text3)' }}>—</span>
                }
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--color-text3)' }}>
          Gear HP bonus: <strong style={{ color: 'var(--color-teal)' }}>+{char.gear_hp ?? 0}</strong> · MP bonus: <strong style={{ color: '#6aa0f0' }}>+{char.gear_mp ?? 0}</strong>
        </div>
      </Panel>
    </div>
  );
}

function CharProgress({ ext }: { ext: CharExtended | null }) {
  const skills: Skill[] = ext?.skills ?? [];
  const SKILL_GROUPS: Record<string, number[]> = {
    'Combat':   [1,2,3,4,5,6,7,8,9,10,11,12],
    'Magic':    [23,24,25,26,27,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46],
    'Crafting': [48,49,50,51,52,53,54,55,56,57,58],
  };
  const SKILL_NAMES: Record<number, string> = {
    1:'Hand-to-Hand',2:'Dagger',3:'Sword',4:'Great Sword',5:'Axe',6:'Great Axe',
    7:'Scythe',8:'Polearm',9:'Katana',10:'Great Katana',11:'Club',12:'Staff',
    23:'Automaton Melee',24:'Automaton Ranged',25:'Automaton Magic',
    26:'Archery',27:'Marksmanship',28:'Throwing',29:'Guard',30:'Evasion',31:'Shield',32:'Parrying',
    33:'Divine Magic',34:'Healing Magic',35:'Enhancing Magic',36:'Enfeebling Magic',37:'Elemental Magic',
    38:'Dark Magic',39:'Summoning Magic',40:'Ninjutsu',41:'Singing',42:'String Instrument',43:'Wind Instrument',
    44:'Blue Magic',45:'Geomancy',46:'Handbell',47:'Fishing',
    48:'Woodworking',49:'Smithing',50:'Goldsmithing',51:'Clothcraft',52:'Leathercraft',
    53:'Bonecraft',54:'Alchemy',55:'Cooking',56:'Synergy',57:'Chocobo Digging',58:'Fishing',
  };

  if (!ext) return <div style={{ color: 'var(--color-text3)', fontSize: 13 }}>Loading progress…</div>;

  return (
    <div>
      {Object.entries(SKILL_GROUPS).map(([group, ids]) => {
        const groupSkills = ids.map((id) => ({ id, skill: skills.find((s) => s.skillid === id) })).filter((x) => x.skill);
        if (!groupSkills.length) return null;
        return (
          <div key={group} style={{ marginBottom: 20 }}>
            <div className="section-title">{group}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
              {groupSkills.map(({ id, skill: s }) => (
                <div key={id} style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                    <span style={{ color: 'var(--color-text2)' }}>{SKILL_NAMES[id] ?? `Skill ${id}`}</span>
                    <span style={{ color: 'var(--color-text1)', fontWeight: 700 }}>{s!.value}</span>
                  </div>
                  <div style={{ height: 4, background: 'var(--color-surface2)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${s!.cap ? s!.value / s!.cap * 100 : 0}%`, height: '100%', background: 'var(--color-accent)', borderRadius: 2 }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Full inventory ────────────────────────────────────────────────────────────
function CharInventory({ charId }: { charId: number }) {
  const [items, setItems] = useState<any[]>([]);
  const [bag, setBag] = useState(0);
  const [search, setSearch] = useState('');
  useEffect(() => { api.charInventory(charId).then(r => setItems(r as any[])).catch(() => {}); }, [charId]);

  const byBag = items.reduce<Record<number, any[]>>((acc, i) => {
    if (i.location != null) { (acc[i.location] ??= []).push(i); }
    return acc;
  }, {});
  const bags = Object.keys(byBag).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  const rawBag = byBag[bag] ?? byBag[bags[0]] ?? [];
  const activeBag = search ? rawBag.filter((it: any) => (it.name ?? '').toLowerCase().includes(search.toLowerCase())) : rawBag;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {bags.map(b => (
            <button key={b} onClick={() => setBag(b)} className="btn btn-ghost btn-sm"
              style={bag === b ? { background: 'var(--color-accent)', color: '#fff', borderColor: 'var(--color-accent)' } : {}}>
              {BAGS[b] ?? `Bag ${b}`} <span style={{ marginLeft: 4, fontSize: 10, opacity: .7 }}>({byBag[b]?.length ?? 0})</span>
            </button>
          ))}
        </div>
        <input className="input" placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ marginLeft: 'auto', maxWidth: 200, fontSize: 12, padding: '5px 9px' }} />
      </div>
      <div className="card">
        {activeBag.length === 0 && <div style={{ padding: '16px', color: 'var(--color-text3)', fontSize: 12 }}>{search ? 'No matches.' : 'Empty.'}</div>}
        {activeBag.map((it: any) => (
          <div key={it.slot} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 14px', borderBottom: '1px solid rgba(42,42,61,.3)', fontSize: 13 }}>
            <span style={{ width: 28, textAlign: 'right', color: 'var(--color-text3)', fontSize: 11, flexShrink: 0 }}>#{it.slot}</span>
            <span style={{ flex: 1, color: 'var(--color-text1)' }}>{it.name ?? `Item ${it.itemId}`}</span>
            {it.itemId && <span style={{ fontSize: 10, color: 'var(--color-text3)', flexShrink: 0 }}>ID:{it.itemId}</span>}
            <span style={{ fontSize: 11, color: 'var(--color-text3)', flexShrink: 0 }}>×{it.quantity}</span>
            {it.bazaar > 0 && <span className="pill pill-gold" style={{ fontSize: 10, flexShrink: 0 }}>{it.bazaar.toLocaleString()} gil</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Character bags (safe, locker, satchel, wardrobes) ────────────────────────
function CharBags({ charId }: { charId: number }) {
  const [data, setData] = useState<{ items: { location: number; slot: number; itemId: number; quantity: number; name?: string }[]; storage: Record<string, number> | null } | null>(null);
  const [bag, setBag] = useState(1);
  useEffect(() => { api.charBags(charId).then(setData).catch(() => {}); }, [charId]);

  if (!data) return <div style={{ color: 'var(--color-text3)', fontSize: 13, padding: '20px 0' }}>Loading…</div>;

  const byBag = data.items.reduce<Record<number, typeof data.items>>((acc, i) => {
    if (i.location != null) { (acc[i.location] ??= []).push(i); }
    return acc;
  }, {});
  const bagIds = Object.keys(byBag).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);

  const STORAGE_KEYS: Record<string, number> = {
    safe: 1, locker: 4, satchel: 5, sack: 6, case: 7, wardrobe: 8,
    wardrobe2: 10, wardrobe3: 11, wardrobe4: 12,
  };
  const capacities = data.storage ?? {};

  if (!bagIds.length) return <div style={{ color: 'var(--color-text3)', fontSize: 13, padding: '20px 0' }}>No items in extended storage.</div>;

  const activeBag = byBag[bag] ?? byBag[bagIds[0]] ?? [];
  const activeLoc = bagIds.includes(bag) ? bag : bagIds[0];

  return (
    <div>
      {data.storage && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {Object.entries(STORAGE_KEYS).map(([key, loc]) => {
            const cap = capacities[key];
            if (cap == null) return null;
            const used = (byBag[loc] ?? []).length;
            return (
              <div key={key} style={{ fontSize: 11, padding: '3px 10px', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', borderRadius: 12, color: 'var(--color-text3)' }}>
                {BAGS[loc] ?? key} <span style={{ color: used > 0 ? 'var(--color-text1)' : 'var(--color-text3)' }}>{used}/{cap}</span>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, flexWrap: 'wrap' }}>
        {bagIds.map(b => (
          <button key={b} onClick={() => setBag(b)} className="btn btn-ghost btn-sm"
            style={activeLoc === b ? { background: 'var(--color-accent)', color: '#fff', borderColor: 'var(--color-accent)' } : {}}>
            {BAGS[b] ?? `Bag ${b}`} <span style={{ marginLeft: 4, fontSize: 10, opacity: .7 }}>({byBag[b].length})</span>
          </button>
        ))}
      </div>
      <div className="card">
        {activeBag.length === 0 && <div style={{ padding: '16px', color: 'var(--color-text3)', fontSize: 12 }}>Empty.</div>}
        {activeBag.map((it) => (
          <div key={it.slot} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 14px', borderBottom: '1px solid rgba(42,42,61,.3)', fontSize: 13 }}>
            <span style={{ width: 28, textAlign: 'right', color: 'var(--color-text3)', fontSize: 11, flexShrink: 0 }}>#{it.slot}</span>
            <span style={{ flex: 1, color: 'var(--color-text1)' }}>{it.name ?? `Item ${it.itemId}`}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text3)', flexShrink: 0 }}>×{it.quantity}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Character variables ───────────────────────────────────────────────────────
function CharVars({ charId, isAdmin }: { charId: number; isAdmin: boolean }) {
  const [vars,    setVars]    = useState<Record<string, unknown>>({});
  const [search,  setSearch]  = useState('');
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [busy,    setBusy]    = useState<Record<string, boolean>>({});
  const [newKey,  setNewKey]  = useState('');
  const [newVal,  setNewVal]  = useState('0');

  useEffect(() => { api.charVarsById(charId).then(setVars).catch(() => {}); }, [charId]);

  async function save(varname: string, value: string) {
    setBusy(p => ({ ...p, [varname]: true }));
    try {
      await api.setCharVar(charId, varname, value === '' ? null : Number(value));
      setVars(p => ({ ...p, [varname]: value === '' ? undefined : Number(value) }));
      setEditing(p => { const n = { ...p }; delete n[varname]; return n; });
    } catch (_) {}
    setBusy(p => ({ ...p, [varname]: false }));
  }
  async function addVar() {
    if (!newKey.trim()) return;
    await save(newKey.trim(), newVal);
    setNewKey(''); setNewVal('0');
  }

  const entries = Object.entries(vars).filter(([k]) => !search || k.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="input" placeholder="Filter variables…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
        <span style={{ fontSize: 12, color: 'var(--color-text3)' }}>{entries.length} vars</span>
      </div>
      {isAdmin && (
        <div className="card" style={{ padding: '10px 14px', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="input" placeholder="VARIABLE_NAME" value={newKey} onChange={e => setNewKey(e.target.value)} style={{ flex: 1, maxWidth: 240, fontFamily: 'var(--font-mono)', fontSize: 12 }} />
          <input type="number" value={newVal} onChange={e => setNewVal(e.target.value)}
            style={{ width: 80, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 5, padding: '7px 8px', fontSize: 12 }} />
          <button onClick={addVar} disabled={!newKey.trim()} className="btn btn-primary btn-sm">Set</button>
        </div>
      )}
      <div className="card">
        {entries.length === 0 && <div style={{ padding: '16px 14px', color: 'var(--color-text3)', fontSize: 12 }}>No variables.</div>}
        {entries.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderBottom: '1px solid rgba(42,42,61,.3)' }}>
            <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text2)' }}>{k}</span>
            {isAdmin ? (
              <>
                <input type="number" value={editing[k] ?? String(v ?? 0)}
                  onChange={e => setEditing(p => ({ ...p, [k]: e.target.value }))}
                  style={{ width: 80, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 5, padding: '3px 6px', fontSize: 12, textAlign: 'right' }} />
                <button onClick={() => save(k, editing[k] ?? String(v ?? 0))} disabled={busy[k]} className="btn btn-ghost btn-xs">Save</button>
                <button onClick={() => save(k, '')} disabled={busy[k]} className="btn btn-ghost btn-xs" style={{ color: 'var(--color-red)' }}>✕</button>
              </>
            ) : (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text1)' }}>{String(v)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Effects / buffs ───────────────────────────────────────────────────────────
function CharEffects({ charId }: { charId: number }) {
  const [effects, setEffects] = useState<unknown[]>([]);
  useEffect(() => { api.charEffects(charId).then(setEffects).catch(() => {}); }, [charId]);
  if (!effects.length) return <div style={{ color: 'var(--color-text3)', fontSize: 13, padding: '16px 0' }}>No active effects.</div>;
  const buffs   = effects.filter((e: any) => !e.isDebuff);
  const debuffs = effects.filter((e: any) =>  e.isDebuff);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      {[['Buffs', buffs, 'var(--color-teal)'], ['Debuffs', debuffs, 'var(--color-red)']].map(([title, list, col]) => (
        <Panel key={title as string} title={title as string}>
          {(list as any[]).length === 0 ? <span style={{ color: 'var(--color-text3)', fontSize: 12 }}>None</span> : (list as any[]).map((e: any) => (
            <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid rgba(42,42,61,.3)', fontSize: 12 }}>
              <span style={{ color: col as string, fontWeight: 600 }}>{e.name}</span>
              <span style={{ color: 'var(--color-text3)', fontSize: 11 }}>
                {e.power > 0 && `P:${e.power} `}
                {e.remaining >= 0 ? `${e.remaining}s` : '∞'}
              </span>
            </div>
          ))}
        </Panel>
      ))}
    </div>
  );
}

// ── Blobs: key items / titles / zones ─────────────────────────────────────────
function CharBlobs({ charId }: { charId: number }) {
  const [blobs, setBlobs] = useState<Record<string, unknown> | null>(null);
  const [section, setSection] = useState('keyitems');
  useEffect(() => { api.charBlobs(charId).then(setBlobs).catch(() => {}); }, [charId]);
  if (!blobs) return <div style={{ color: 'var(--color-text3)', fontSize: 13, padding: '16px 0' }}>Loading…</div>;

  const kiList  = (blobs.keyitems  as any[] | undefined) ?? [];
  const titles  = (blobs.titles    as any[] | undefined) ?? [];
  const zones   = (blobs.zones     as any[] | undefined) ?? [];

  const SECTIONS: [string, string, unknown[]][] = [
    ['keyitems', `Key Items (${kiList.length})`, kiList],
    ['titles',   `Titles (${titles.length})`, titles],
    ['zones',    `Zones Visited (${zones.length})`, zones],
  ];

  const activeList = SECTIONS.find(([k]) => k === section)?.[2] ?? [];

  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {SECTIONS.map(([k, label]) => (
          <button key={k} onClick={() => setSection(k)} className={`btn btn-ghost btn-sm`}
            style={section === k ? { background: 'var(--color-accent)', color: '#fff', borderColor: 'var(--color-accent)' } : {}}>
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(activeList as any[]).map((item: any, i: number) => (
          <span key={i} className="pill pill-muted" style={{ fontSize: 11 }}>{typeof item === 'object' ? (item.name ?? item.id) : item}</span>
        ))}
        {activeList.length === 0 && <span style={{ color: 'var(--color-text3)', fontSize: 13 }}>None</span>}
      </div>
    </div>
  );
}

// ── Quests ────────────────────────────────────────────────────────────────────
function CharQuests({ charId }: { charId: number }) {
  const [quests,  setQuests]  = useState<unknown[]>([]);
  const [filter,  setFilter]  = useState<'all'|'active'|'complete'>('all');
  const [search,  setSearch]  = useState('');
  useEffect(() => { api.charQuestsById(charId).then(setQuests).catch(() => {}); }, [charId]);

  const visible = (quests as any[]).filter(q =>
    (filter === 'all' || q.status === filter) &&
    (!search || q.name.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input className="input" placeholder="Search quests…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 220 }} />
        {(['all','active','complete'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} className="btn btn-ghost btn-sm"
            style={filter === f ? { background: 'var(--color-accent)', color: '#fff', borderColor: 'var(--color-accent)' } : {}}>
            {f}
          </button>
        ))}
        <span style={{ fontSize: 12, color: 'var(--color-text3)' }}>{visible.length} quests</span>
      </div>
      <div className="card">
        {visible.length === 0 && <div style={{ padding: '16px', color: 'var(--color-text3)', fontSize: 12 }}>No quests found.</div>}
        {visible.map((q: any, i: number) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 14px', borderBottom: '1px solid rgba(42,42,61,.3)', fontSize: 13 }}>
            <span className={`pill ${q.status === 'complete' ? 'pill-teal' : 'pill-gold'}`} style={{ fontSize: 10, flexShrink: 0 }}>{q.status}</span>
            <span style={{ flex: 1, color: 'var(--color-text1)' }}>{q.name}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>{q.logName}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Currency / points ─────────────────────────────────────────────────────────
function CharPoints({ ext }: { ext: CharExtended | null }) {
  const pts = ext?.points as Record<string, number> | null | undefined;
  if (!pts) return <div style={{ color: 'var(--color-text3)', fontSize: 13, padding: '16px 0' }}>No data loaded.</div>;

  const GROUPS: [string, [string, string][]][] = [
    ['Conquest', [['sandoria_cp','Sandy CP'],['bastok_cp','Bastok CP'],['windurst_cp','Windurst CP']]],
    ['Sparks / Bayld', [['spark_of_eminence','Sparks'],['bayld','Bayld'],['allied_notes','Allied Notes']]],
    ['Escha / Domain', [['escha_silt','Escha Silt'],['escha_beads','Escha Beads'],['domain_points','Domain Points']]],
    ['Unity', [['unity_accolades','Unity Accolades'],['current_accolades','Current Accolades'],['current_hallmarks','Hallmarks']]],
    ['Cruor / Traverser', [['cruor','Cruor'],['traverser_stones','Traverser Stones'],['voidstones','Voidstones']]],
    ['Assault', [['leujaoam_assault_point','Leujaoam'],['mamool_assault_point','Mamool'],['lebros_assault_point','Lebros'],['periqia_assault_point','Periqia'],['ilrusi_assault_point','Ilrusi'],['nyzul_isle_assault_point','Nyzul Isle']]],
    ['Misc', [['zeni_point','Zeni'],['jetton','Jettons'],['imperial_standing','Imp. Standing'],['login_points','Login Points'],['fellow_point','Fellow Points']]],
    ['Crystals', [['fire_crystals','Fire'],['ice_crystals','Ice'],['wind_crystals','Wind'],['earth_crystals','Earth'],['lightning_crystals','Thunder'],['water_crystals','Water'],['light_crystals','Light'],['dark_crystals','Dark']]],
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
      {GROUPS.map(([group, keys]) => {
        const rows = keys.filter(([k]) => pts[k] != null && pts[k] !== 0);
        if (!rows.length) return null;
        return (
          <Panel key={group} title={group}>
            {rows.map(([k, label]) => <Row key={k} k={label} v={Number(pts[k] ?? 0).toLocaleString()} />)}
          </Panel>
        );
      })}
    </div>
  );
}

// ── Admin: GM quick actions ───────────────────────────────────────────────────
function CharAdmin({ char }: { char: CharBasic }) {
  const [lua,  setLua]  = useState('');
  const [out,  setOut]  = useState('');
  const [busy, setBusy] = useState(false);
  const [warpZone, setWarpZone] = useState('');
  const [gilAmt, setGilAmt] = useState('');
  const [zones, setZones] = useState<{ zoneid: number; name: string }[]>([]);
  const [recentQueue, setRecentQueue] = useState<{ id: number; action: string; params: string; status: string; result: string | null; created_at: string }[]>([]);

  useEffect(() => {
    api.charRecentQueue(char.charid).then(setRecentQueue).catch(() => {});
    api.zones().then(z => setZones(z)).catch(() => {});
  }, [char.charid]);

  async function runLua(code: string) {
    setBusy(true); setOut('Running…');
    try {
      const { id } = await api.consoleExec(code);
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        try {
          const e = await api.queueEntry(id);
          if (e.status === 'complete' || e.status === 'failed' || tries > 30) {
            clearInterval(poll); setBusy(false); setOut(e.result ?? e.status);
          }
        } catch (err) {
          clearInterval(poll); setBusy(false); setOut((err as Error).message);
        }
      }, 500);
    } catch (e) { setBusy(false); setOut((e as Error).message); }
  }

  const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const N = `GetPlayerByName("${q(char.charname)}")`;

  const QUICK: [string, string, string][] = [
    ['Full Heal', 'var(--color-teal)', `${N}:addHP(999999);${N}:addMP(999999)`],
    ['Raise',     'var(--color-accent)', `${N}:setHP(${N}:getMaxHP())`],
    ['Cap Skills','var(--color-text2)', `local p=${N};if p then for i=1,57 do pcall(function()p:setSkillLevel(i,340)end)end end`],
    ['GM Icon On', 'var(--color-gold)', `${N}:setGMLevel(1)`],
    ['GM Icon Off','var(--color-text3)', `${N}:setGMLevel(0)`],
  ];

  const STATUS_COLOR: Record<string, string> = { complete: 'var(--color-teal)', failed: 'var(--color-red)', deferred: 'var(--color-gold)', pending: 'var(--color-text3)' };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
      <Panel title="Quick Actions">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {QUICK.map(([label, col, code]) => (
            <button key={label} onClick={() => runLua(code)} disabled={busy} className="btn btn-ghost btn-sm" style={{ color: col }}>{label}</button>
          ))}
        </div>
        <div style={{ marginBottom: 6, display: 'flex', gap: 8 }}>
          <select value={warpZone} onChange={e => setWarpZone(e.target.value)}
            style={{ flex: 1, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: warpZone ? 'var(--color-text1)' : 'var(--color-text3)', padding: '6px 8px', borderRadius: 7, fontSize: 12 }}>
            <option value="">Select zone to warp…</option>
            {zones.map(z => <option key={z.zoneid} value={String(z.zoneid)}>{z.name}</option>)}
          </select>
          <button onClick={() => runLua(`${N}:setPos(0,0,0,0,${warpZone})`)} disabled={busy || !warpZone} className="btn btn-ghost btn-sm">Warp</button>
        </div>
        <div style={{ marginBottom: 10, display: 'flex', gap: 8 }}>
          <input className="input" type="number" placeholder="Gil amount…" value={gilAmt} onChange={e => setGilAmt(e.target.value)} style={{ flex: 1 }} />
          <button onClick={() => { runLua(`${N}:addGil(${Number(gilAmt)})`); setGilAmt(''); }} disabled={busy || !gilAmt} className="btn btn-ghost btn-sm">Add Gil</button>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--color-text3)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.5px' }}>Custom Lua</div>
          <textarea value={lua} onChange={e => setLua(e.target.value)} rows={3}
            style={{ width: '100%', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', fontFamily: 'var(--font-mono)', fontSize: 12, padding: '7px 10px', borderRadius: 7, resize: 'vertical' }}
            placeholder={`${N}:addItem(1000, 1)`} />
          <button onClick={() => runLua(lua)} disabled={busy || !lua.trim()} className="btn btn-primary btn-sm" style={{ marginTop: 6 }}>▶ Run</button>
        </div>
      </Panel>
      <Panel title="Output">
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: out.includes('Error') ? 'var(--color-red)' : 'var(--color-teal)', minHeight: 40, whiteSpace: 'pre-wrap' }}>
          {out || <span style={{ color: 'var(--color-text3)' }}>Run an action to see output.</span>}
        </div>
      </Panel>
      {recentQueue.length > 0 && (
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)' }}>Recent Queue Actions</div>
          <div style={{ padding: '8px 16px' }}>
            {recentQueue.map(q => (
              <div key={q.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid rgba(42,42,61,.3)', fontSize: 12 }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text3)', fontSize: 10, flexShrink: 0 }}>#{q.id}</span>
                <span style={{ fontWeight: 600, color: 'var(--color-text1)', flexShrink: 0 }}>{q.action}</span>
                <span style={{ color: 'var(--color-text3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.params}</span>
                <span style={{ fontSize: 10, color: STATUS_COLOR[q.status] ?? 'var(--color-text3)', flexShrink: 0 }}>{q.status}</span>
                {q.result && <span style={{ fontSize: 10, color: 'var(--color-text3)', flexShrink: 0, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.result}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
