import React, { useState, useEffect } from 'react';
import { api } from '../../api';

type RoeRecord = { id: number; name: string; flags: string[]; description?: string };

const TYPE_OPTS = ['all', 'daily', 'weekly', 'timed'] as const;
type RoeType = typeof TYPE_OPTS[number];

const FLAG_COLORS: Record<string, string> = {
  daily:   'var(--color-teal)',
  weekly:  'var(--color-accent)',
  timed:   'var(--color-gold)',
  repeatable: 'var(--color-text3)',
};

export function RoE() {
  const [records, setRecords] = useState<RoeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [type, setType] = useState<RoeType>('all');
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.roeRecords(search, type).then(r => { if (!cancelled) { setRecords(r); setLoading(false); } }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [search, type]);

  const onSearch = (e: React.FormEvent) => { e.preventDefault(); };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '12px 16px', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: 16, fontWeight: 700, color: 'var(--color-text1)', margin: 0 }}>Records of Eminence</h1>
          <form onSubmit={onSearch} style={{ display: 'flex', gap: 6, flex: 1, maxWidth: 300 }}>
            <input
              className="input"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search records…"
            />
          </form>
          <div style={{ display: 'flex', gap: 4 }}>
            {TYPE_OPTS.map(t => (
              <button key={t} onClick={() => setType(t)}
                style={{
                  padding: '5px 12px', borderRadius: 20, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  background: type === t ? 'var(--color-accent)' : 'var(--color-surface2)',
                  color: type === t ? '#fff' : 'var(--color-text3)',
                  textTransform: 'capitalize',
                }}>
                {t}
              </button>
            ))}
          </div>
          <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>{records.length} records</span>
        </div>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && <div style={{ padding: 24, color: 'var(--color-text3)', textAlign: 'center' }}>Loading…</div>}
        {!loading && records.length === 0 && <div style={{ padding: 24, color: 'var(--color-text3)', textAlign: 'center' }}>No records found.</div>}
        {!loading && records.length > 0 && (
          <table>
            <thead>
              <tr>
                <th style={{ width: 60 }}>ID</th>
                <th>Name</th>
                <th style={{ width: 180 }}>Flags</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {records.map(r => (
                <React.Fragment key={r.id}>
                  <tr onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    style={{ cursor: r.description ? 'pointer' : 'default' }}
                    onMouseEnter={e => { if (r.description) (e.currentTarget as HTMLElement).style.background = 'var(--color-surface2)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = ''; }}>
                    <td style={{ color: 'var(--color-text3)', fontSize: 11 }}>{r.id}</td>
                    <td style={{ color: 'var(--color-text1)', fontWeight: 500 }}>
                      {r.description && <span style={{ color: 'var(--color-text3)', fontSize: 10, marginRight: 5 }}>{expanded === r.id ? '▾' : '▸'}</span>}
                      {r.name}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {r.flags.map(f => (
                          <span key={f} style={{
                            padding: '2px 7px', borderRadius: 10, fontSize: 10, fontWeight: 600,
                            background: 'rgba(0,0,0,.2)',
                            color: FLAG_COLORS[f] ?? 'var(--color-text3)',
                            border: `1px solid ${FLAG_COLORS[f] ?? 'var(--color-border)'}`,
                            textTransform: 'capitalize',
                          }}>{f}</span>
                        ))}
                      </div>
                    </td>
                    <td style={{ color: 'var(--color-text3)', fontSize: 11, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description ?? '—'}</td>
                  </tr>
                  {expanded === r.id && r.description && (
                    <tr>
                      <td />
                      <td colSpan={3} style={{ padding: '8px 14px 12px', background: 'var(--color-surface2)', fontSize: 12, color: 'var(--color-text2)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                        {r.description}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
