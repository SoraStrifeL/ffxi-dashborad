import React, { useState, useEffect } from 'react';
import { api } from '../../api';

type Row = { id: number; name: string; description?: string };

const CATS: { key: string; label: string }[] = [
  { key: 'items_weapons',  label: 'Weapons' },
  { key: 'items_armor',    label: 'Armor' },
  { key: 'items_usable',   label: 'Usable' },
  { key: 'items_general',  label: 'General' },
  { key: 'items_currency', label: 'Currency' },
  { key: 'abilities',      label: 'Abilities' },
  { key: 'spells',         label: 'Spells' },
  { key: 'zones',          label: 'Zones' },
  { key: 'statuses',       label: 'Statuses' },
  { key: 'titles',         label: 'Titles' },
  { key: 'key_items',      label: 'Key Items' },
  { key: 'monster_skills', label: 'Monster Skills' },
  { key: 'dialog',         label: 'Dialog' },
];

export function GameData() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [cats, setCats] = useState<string[]>([]);
  const [cat, setCat] = useState('items_weapons');
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [dzones, setDzones] = useState<{ id: number; name: string }[]>([]);
  const [zone, setZone] = useState<number | null>(null);

  const isDialog = cat === 'dialog';

  useEffect(() => {
    api.datStatus().then(s => { setEnabled(s.enabled); setCats(s.categories || []); }).catch(() => setEnabled(false));
  }, []);

  // load the dialog zone list once, when first entering dialog mode
  useEffect(() => {
    if (!enabled || !isDialog || dzones.length) return;
    api.datDialogZones().then(r => { setDzones(r.zones); if (r.zones.length && zone == null) setZone(r.zones[0].id); }).catch(() => {});
  }, [enabled, isDialog, dzones.length, zone]);

  // reset paging on category / search / zone change
  useEffect(() => { setPage(0); }, [cat, search, zone]);

  useEffect(() => {
    if (!enabled) return;
    if (isDialog && zone == null) { setRows([]); setTotal(0); setHasMore(false); return; }
    let cancelled = false;
    setLoading(true);
    const req = isDialog
      ? api.datDialog(zone as number, search, page).then(r => ({ rows: r.rows.map(x => ({ id: x.id, name: x.text })), total: r.total, hasMore: r.hasMore }))
      : api.datTable(cat, search, page);
    req
      .then(r => { if (cancelled) return; setRows(prev => page === 0 ? r.rows : [...prev, ...r.rows]); setTotal(r.total); setHasMore(r.hasMore); setLoading(false); })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enabled, cat, search, page, isDialog, zone]);

  if (enabled === false) {
    return (
      <div style={{ padding: 24, color: 'var(--color-text3)' }}>
        <h1 style={{ fontSize: 16, color: 'var(--color-text1)' }}>Game Data (DAT)</h1>
        <p>The FFXI DAT fetcher is disabled — no <code>DAT_DIR</code> with client DAT files is mounted.
        See <code>ffxi-dat/README.md</code> to enable it.</p>
      </div>
    );
  }

  const withDesc = cat === 'abilities' || cat === 'spells' || cat.startsWith('items_');
  const withIcon = cat.startsWith('items_');
  // 'dialog' is a special per-zone mode, not a status table category, so it is
  // always available when the fetcher is enabled.
  const available = (key: string) => key === 'dialog' || cats.length === 0 || cats.includes(key);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '12px 16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text1)', margin: 0 }}>Game Data <span style={{ color: 'var(--color-text3)', fontWeight: 400, fontSize: 12 }}>from client DATs</span></h1>
          <input className="input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" style={{ maxWidth: 260 }} />
          {isDialog && (
            <select className="input" value={zone ?? ''} onChange={e => setZone(Number(e.target.value))} style={{ maxWidth: 240 }}>
              {dzones.map(z => <option key={z.id} value={z.id}>{z.name.replace(/_/g, ' ')}</option>)}
            </select>
          )}
          <span style={{ fontSize: 11, color: 'var(--color-text3)', marginLeft: 'auto' }}>{total.toLocaleString()} {isDialog ? 'lines' : 'entries'}</span>
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 10, flexWrap: 'wrap' }}>
          {CATS.filter(c => available(c.key)).map(c => (
            <button key={c.key} onClick={() => setCat(c.key)}
              style={{
                padding: '5px 12px', borderRadius: 20, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                background: cat === c.key ? 'var(--color-accent)' : 'var(--color-surface2)',
                color: cat === c.key ? '#fff' : 'var(--color-text3)',
              }}>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && page === 0 && <div style={{ padding: 24, color: 'var(--color-text3)', textAlign: 'center' }}>Loading…</div>}
        {!loading && rows.length === 0 && <div style={{ padding: 24, color: 'var(--color-text3)', textAlign: 'center' }}>No entries.</div>}
        {rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>ID</th>
                <th style={{ width: withDesc ? 260 : undefined }}>{isDialog ? 'Text' : 'Name'}</th>
                {withDesc && <th>Description</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <React.Fragment key={r.id}>
                  <tr onClick={() => withDesc && r.description && setExpanded(expanded === r.id ? null : r.id)}
                    style={{ cursor: withDesc && r.description ? 'pointer' : 'default' }}>
                    <td style={{ color: 'var(--color-text3)', fontSize: 11 }}>{r.id}</td>
                    <td style={{ color: isDialog ? 'var(--color-text2)' : 'var(--color-text1)', fontWeight: isDialog ? 400 : 500, whiteSpace: isDialog ? 'pre-wrap' : undefined, fontSize: isDialog ? 12 : undefined, lineHeight: isDialog ? 1.5 : undefined }}>
                      {isDialog ? r.name : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          {withIcon && (
                            <img src={`/api/dat/icon/${r.id}`} alt="" width={32} height={32} loading="lazy"
                              style={{ flexShrink: 0, imageRendering: 'pixelated' }}
                              onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                          )}
                          {r.name}
                        </div>
                      )}
                    </td>
                    {withDesc && (
                      <td style={{ color: 'var(--color-text3)', fontSize: 11, maxWidth: 480, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {(r.description || '—').replace(/\n/g, ' ')}
                      </td>
                    )}
                  </tr>
                  {withDesc && expanded === r.id && (r.description || withIcon) && (
                    <tr>
                      <td />
                      <td colSpan={2} style={{ padding: '12px 14px 14px', background: 'var(--color-surface2)' }}>
                        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                          {withIcon && (
                            <img src={`/api/dat/icon/${r.id}`} alt="" width={64} height={64}
                              style={{ flexShrink: 0, imageRendering: 'pixelated', background: 'rgba(0,0,0,.2)', borderRadius: 6 }}
                              onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                          )}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12, color: 'var(--color-text2)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{r.description || '—'}</div>
                            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text3)', fontFamily: 'var(--font-mono)' }}>id {r.id} · 0x{r.id.toString(16).toUpperCase()}</div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
        {hasMore && !loading && (
          <div style={{ textAlign: 'center', padding: 12 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setPage(p => p + 1)}>Load more</button>
          </div>
        )}
        {loading && page > 0 && <div style={{ padding: 12, color: 'var(--color-text3)', textAlign: 'center' }}>Loading…</div>}
      </div>
    </div>
  );
}
