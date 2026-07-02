import React, { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { api } from '../../api';
import type { Player, CharBasic, CharExtended, Skill } from '../../types';

const JOB  = ['','WAR','MNK','WHM','BLM','RDM','THF','PLD','DRK','BST','BRD','RNG','SAM','NIN','DRG','SMN','BLU','COR','PUP','DNC','SCH','GEO','RUN'];
const RACE = ['','Hume (M)','Hume (F)','Elvaan (M)','Elvaan (F)','Tarutaru (M)','Tarutaru (F)','Mithra','Galka'];
const SLOT: Record<number, string> = {0:'Main',1:'Sub',2:'Range',3:'Ammo',4:'Head',5:'Body',6:'Hands',7:'Legs',8:'Feet',9:'Neck',10:'Waist',11:'L.Ear',12:'R.Ear',13:'L.Ring',14:'R.Ring',15:'Back'};
const BAGS: Record<number, string> = {0:'Inventory',1:'Safe',2:'Storage',3:'Locker',4:'Satchel',5:'Sack',6:'Case',7:'Wardrobe',8:'Wardrobe 2',9:'Wardrobe 3',10:'Wardrobe 4'};
const BAG_MAX: Record<number, number> = {0:80,1:60,2:80,3:80,4:80,5:80,6:80,7:80};

function fmtRelTime(ts: number) {
  const secs = Math.floor((Date.now() / 1000) - ts);
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
    Promise.all([
      api.char(nid),
      api.charExtended(nid),
    ]).then(([c, e]) => { setChar(c); setExt(e); }).catch(() => navigate('/chars')).finally(() => setLoading(false));
    // Load equipment for gear tab separately (non-blocking)
    api.charEquipment(Number(id)).then(setEquip).catch(() => {});
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
        {tab === 'overview' && <CharOverview char={char} ext={ext} />}
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

function CharOverview({ char, ext }: { char: CharBasic; ext: CharExtended | null }) {
  const navigate = useNavigate();
  const p = ext?.profile ?? {};
  const bagCounts = ext?.bag_counts ?? [];
  const storage   = ext?.storage ?? {};
  const hist = ext?.history ?? {};

  const totalHp = char.hp + (char.gear_hp ?? 0);
  const totalMp = char.mp + (char.gear_mp ?? 0);

  const playSecs = char.playtime ?? 0;
  const playHrs  = Math.floor(playSecs / 3600);
  const playMins = Math.floor((playSecs % 3600) / 60);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
      <Panel title="Stats">
        <Row k="HP"    v={String(totalHp)} />
        <Row k="MP"    v={String(totalMp)} />
        <Row k="Nation" v={['None','San d\'Oria','Bastok','Windurst'][char.nation] ?? '?'} />
        <Row k="Rank points" v={String(p.rank_points ?? '—')} />
        <Row k="Fame (Sandy)" v={String(p.fame_sandoria ?? '—')} />
        {char.zone_name && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 12 }}>
            <span style={{ color: 'var(--color-text3)', width: 90, flexShrink: 0 }}>Zone</span>
            <button onClick={() => navigate('/map', { state: { zoneId: char.pos_zone } })}
              className="btn btn-ghost btn-xs" style={{ padding: '1px 6px', fontSize: 11, color: 'var(--color-accent)' }}>
              {char.zone_name} ↗
            </button>
          </div>
        )}
      </Panel>
      <Panel title="Inventory">
        {bagCounts.map((b) => {
          const max = (storage as Record<string, number>)[Object.keys(storage)[b.location]] ?? BAG_MAX[b.location] ?? 80;
          return (
            <div key={b.location} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 12 }}>
              <span style={{ color: 'var(--color-text3)', width: 90, flexShrink: 0 }}>{BAGS[b.location] ?? `Bag ${b.location}`}</span>
              <div style={{ flex: 1, height: 5, background: 'var(--color-surface2)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${max ? b.count / max * 100 : 0}%`, height: '100%', background: 'var(--color-accent)', borderRadius: 2 }} />
              </div>
              <span style={{ color: 'var(--color-text2)', fontSize: 11, flexShrink: 0 }}>{b.count}/{max}</span>
            </div>
          );
        })}
        {bagCounts.length === 0 && <span style={{ color: 'var(--color-text3)', fontSize: 12 }}>No inventory data</span>}
      </Panel>
      <Panel title="Profile">
        <Row k="Play time" v={`${playHrs}h ${playMins}m`} />
        <Row k="Kills"     v={Number(hist.enemies_defeated ?? 0).toLocaleString()} />
        <Row k="Deaths"    v={Number(hist.times_knocked_out ?? 0).toLocaleString()} />
        <Row k="WS used"   v={Number(hist.ws_used ?? 0).toLocaleString()} />
        <Row k="Spells"    v={Number(hist.spells_cast ?? 0).toLocaleString()} />
      </Panel>
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
    safe: 1, locker: 3, satchel: 4, case: 6, wardrobe: 7,
    wardrobe2: 8, wardrobe3: 9, wardrobe4: 10,
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
        const e = await api.queueEntry(id);
        if (e.status === 'complete' || e.status === 'failed' || tries > 30) {
          clearInterval(poll); setBusy(false); setOut(e.result ?? e.status);
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
