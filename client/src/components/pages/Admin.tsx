import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useStore } from '../../store';
import { useWS } from '../../hooks/useWS';
import type { Player, QueueEntry } from '../../types';

const JOB = ['','WAR','MNK','WHM','BLM','RDM','THF','PLD','DRK','BST','BRD','RNG','SAM','NIN','DRG','SMN','BLU','COR','PUP','DNC','SCH','GEO','RUN'];
const ACTIONS = ['additem','delitem','setgil','addgil','setskill','luaexec'] as const;

export function Admin() {
  const navigate = useNavigate();
  const user = useStore((s) => s.user);
  const players = useStore((s) => s.players);
  const [queue, setQueue]       = useState<QueueEntry[]>([]);
  const [queueLoading, setQL]   = useState(false);
  const [chars, setChars]       = useState<Player[]>([]);
  const [action, setAction]     = useState<string>('additem');
  const [charid, setCharid]     = useState('');
  const [param1, setParam1]     = useState('');
  const [param2, setParam2]     = useState('');
  const [luaCode, setLuaCode]   = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg]           = useState<{ text: string; ok: boolean } | null>(null);
  const [queueSearch, setQueueSearch] = useState('');
  const [queuePage, setQueuePage]   = useState(0);
  const [queueHasMore, setQueueHasMore] = useState(false);

  useWS((type, data) => {
    if (type === 'queue_update') {
      const entry = data as QueueEntry;
      setQueue((prev) => prev.map((q) => q.id === entry.id ? entry : q));
    }
  });

  useEffect(() => {
    if (user?.tier !== 'admin') return;
    api.chars().then(setChars).catch(() => {});
    loadQueue();
  }, [user]);

  async function loadQueue(page = 0) {
    setQL(true);
    try {
      const r = await api.queue({ page });
      setQueue(prev => page === 0 ? r.rows : [...prev, ...r.rows]);
      setQueueHasMore(r.hasMore);
      setQueuePage(page);
    } catch (_) {}
    setQL(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setMsg(null);
    try {
      let params: unknown = {};
      if (action === 'luaexec')  params = luaCode;
      else if (action === 'additem' || action === 'delitem') params = { itemid: Number(param1), quantity: Number(param2) || 1 };
      else if (action === 'setgil' || action === 'addgil')   params = { amount: Number(param1) };
      else if (action === 'setskill') params = { skillid: Number(param1), value: Number(param2) };
      const res = await api.enqueue({ action, charid: charid ? Number(charid) : 0, params });
      setMsg({ text: `Queued #${res.id}`, ok: true });
      loadQueue();
    } catch (e) { setMsg({ text: (e as Error).message, ok: false }); }
    setSubmitting(false);
  }

  if (user?.tier !== 'admin') return <div style={{ padding: 24, color: 'var(--color-text3)' }}>Admin access required.</div>;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Action panel */}
      <div style={{ width: 340, borderRight: '1px solid var(--color-border)', background: 'var(--color-surface)', padding: '20px 20px', overflowY: 'auto', flexShrink: 0 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Queue Action</h2>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.5px' }}>Action</label>
            <select value={action} onChange={(e) => { setAction(e.target.value); setParam1(''); setParam2(''); }}
              style={{ width: '100%', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '8px 10px', borderRadius: 7, fontSize: 13 }}>
              {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          {action !== 'luaexec' && (
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.5px' }}>Character</label>
              <select value={charid} onChange={(e) => setCharid(e.target.value)}
                style={{ width: '100%', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '8px 10px', borderRadius: 7, fontSize: 13 }}>
                <option value="">Select character…</option>
                {chars.map((c) => <option key={c.charid} value={c.charid}>{c.charname} ({JOB[c.mjob]}{c.mlvl})</option>)}
              </select>
            </div>
          )}

          {action === 'luaexec' && (
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.5px' }}>Lua Code</label>
              <textarea value={luaCode} onChange={(e) => setLuaCode(e.target.value)} rows={5}
                style={{ width: '100%', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '8px 10px', borderRadius: 7, fontSize: 12, fontFamily: 'var(--font-mono)', resize: 'vertical' }}
                placeholder="GetPlayerByName('Name'):addItem(1000, 1)" />
            </div>
          )}

          {(action === 'additem' || action === 'delitem') && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.5px' }}>Item ID</label>
                <input className="input" type="number" value={param1} onChange={(e) => setParam1(e.target.value)} placeholder="1000" />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.5px' }}>Quantity</label>
                <input className="input" type="number" value={param2} onChange={(e) => setParam2(e.target.value)} placeholder="1" />
              </div>
            </div>
          )}

          {(action === 'setgil' || action === 'addgil') && (
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.5px' }}>Amount (gil)</label>
              <input className="input" type="number" value={param1} onChange={(e) => setParam1(e.target.value)} placeholder="1000000" />
            </div>
          )}

          {action === 'setskill' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.5px' }}>Skill ID</label>
                <input className="input" type="number" value={param1} onChange={(e) => setParam1(e.target.value)} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--color-text3)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.5px' }}>Level</label>
                <input className="input" type="number" value={param2} onChange={(e) => setParam2(e.target.value)} placeholder="110" />
              </div>
            </div>
          )}

          <button type="submit" disabled={submitting} className="btn btn-primary" style={{ justifyContent: 'center' }}>
            {submitting ? 'Submitting…' : 'Queue Action'}
          </button>
          {msg && <div style={{ fontSize: 12, color: msg.ok ? 'var(--color-teal)' : 'var(--color-red)' }}>{msg.text}</div>}
        </form>

        {/* Online players quick-select */}
        {players.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div className="section-title">Online Players</div>
            {players.map((p) => (
              <button key={p.charid} onClick={() => setCharid(String(p.charid))}
                style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, border: `1px solid ${charid === String(p.charid) ? 'var(--color-accent)' : 'transparent'}`, background: charid === String(p.charid) ? 'rgba(124,106,247,.1)' : 'transparent', cursor: 'pointer', marginBottom: 4, textAlign: 'left' }}>
                <span style={{ fontSize: 13, color: 'var(--color-text1)', fontWeight: 600 }}>{p.charname}</span>
                <span style={{ fontSize: 11, color: 'var(--color-accent)', marginLeft: 'auto' }}>{JOB[p.mjob]}{p.mlvl}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Queue log */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ fontSize: 14, fontWeight: 700 }}>Queue History</h2>
          <input className="input" value={queueSearch} onChange={e => setQueueSearch(e.target.value)}
            placeholder="Filter by char, action, status…" style={{ maxWidth: 240, fontSize: 12, padding: '5px 9px' }} />
          <button onClick={() => loadQueue(0)} className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}>Refresh</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>ID</th><th>Character</th><th>Action</th><th>Status</th><th>Result</th><th>By</th>
              </tr>
            </thead>
            <tbody>
              {queue.filter(q => !queueSearch || [String(q.charid), q.action, q.status, q.requested_by, q.result ?? ''].some(f => f.toLowerCase().includes(queueSearch.toLowerCase()))).map((q) => (
                <tr key={q.id}>
                  <td style={{ color: 'var(--color-text3)', fontFamily: 'var(--font-mono)' }}>{q.id}</td>
                  <td>{q.charid
                    ? <button onClick={() => navigate(`/chars/${q.charid}`)} className="btn btn-ghost btn-xs" style={{ fontFamily: 'var(--font-mono)', padding: '1px 5px', fontSize: 11 }}>{q.charid}</button>
                    : '—'}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-accent)' }}>{q.action}</td>
                  <td><StatusBadge status={q.status} /></td>
                  <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--color-text3)' }}>{q.result ?? '—'}</td>
                  <td style={{ fontSize: 11, color: 'var(--color-text3)' }}>{q.requested_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {queueLoading && <div style={{ padding: '16px', color: 'var(--color-text3)', textAlign: 'center' }}>Loading…</div>}
          {!queueLoading && queue.length === 0 && <div style={{ padding: '24px', color: 'var(--color-text3)', textAlign: 'center' }}>No queue entries</div>}
          {!queueLoading && queueHasMore && !queueSearch && (
            <div style={{ padding: '12px', textAlign: 'center' }}>
              <button onClick={() => loadQueue(queuePage + 1)} className="btn btn-ghost btn-sm">Load more</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { complete: 'pill-teal', failed: 'pill-red', pending: 'pill-muted', deferred: 'pill-gold' };
  return <span className={`pill ${map[status] ?? 'pill-muted'}`}>{status}</span>;
}
