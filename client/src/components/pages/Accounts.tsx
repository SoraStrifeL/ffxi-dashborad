import React, { useState, useEffect } from 'react';
import { api } from '../../api';

interface Account {
  id: number; login: string; status: number; priv: number;
  timecreate: string; timelastmodify: string;
}
const PRIV_LABELS = ['Player', 'GM1', 'GM2', 'GM3', 'GM4', 'Admin'];

export function Accounts() {
  const [accounts, setAccounts]  = useState<Account[]>([]);
  const [loading,  setLoading]   = useState(false);
  const [search,   setSearch]    = useState('');
  const [privEdit, setPrivEdit]  = useState<Record<number, string>>({});
  const [busy,     setBusy]      = useState<Record<number, boolean>>({});
  const [msgs,     setMsgs]      = useState<Record<number, string>>({});

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { setAccounts((await api.accounts()) as Account[]); } catch (_) {}
    setLoading(false);
  }

  async function toggleStatus(a: Account) {
    const next = a.status === 1 ? 0 : 1;
    if (next === 0 && !confirm(`Ban account "${a.login}"?`)) return;
    setBusy(p => ({ ...p, [a.id]: true }));
    try {
      await api.setAccountStatus(a.id, next as 0 | 1);
      setAccounts(prev => prev.map(x => x.id === a.id ? { ...x, status: next } : x));
      flash(a.id, next === 1 ? 'Unbanned' : 'Banned');
    } catch (e) { flash(a.id, (e as Error).message); }
    setBusy(p => ({ ...p, [a.id]: false }));
  }

  async function setPriv(a: Account) {
    const pv = parseInt(privEdit[a.id] ?? String(a.priv));
    if (isNaN(pv)) return;
    setBusy(p => ({ ...p, [a.id]: true }));
    try {
      await api.setAccountPriv(a.id, pv);
      setAccounts(prev => prev.map(x => x.id === a.id ? { ...x, priv: pv } : x));
      flash(a.id, 'Updated');
    } catch (e) { flash(a.id, (e as Error).message); }
    setBusy(p => ({ ...p, [a.id]: false }));
  }

  function flash(id: number, text: string) {
    setMsgs(p => ({ ...p, [id]: text }));
    setTimeout(() => setMsgs(p => { const n = { ...p }; delete n[id]; return n; }), 3000);
  }

  const visible = search ? accounts.filter(a => a.login.toLowerCase().includes(search.toLowerCase())) : accounts;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700 }}>Accounts</h2>
        <span className="pill pill-muted" style={{ fontSize: 11 }}>{accounts.length}</span>
        <input className="input" placeholder="Search login…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 220, marginLeft: 'auto' }} />
        <button onClick={load} className="btn btn-ghost btn-sm">{loading ? '…' : 'Refresh'}</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>ID</th><th>Login</th><th>Status</th><th>Privilege</th><th>Created</th><th>Last Active</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(a => (
              <tr key={a.id}>
                <td style={{ color: 'var(--color-text3)', fontFamily: 'var(--font-mono)' }}>{a.id}</td>
                <td style={{ fontWeight: 600, color: 'var(--color-text1)' }}>{a.login}</td>
                <td>
                  <span className={`pill ${a.status === 1 ? 'pill-teal' : 'pill-red'}`}>
                    {a.status === 1 ? 'Active' : 'Banned'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                    <select value={privEdit[a.id] ?? a.priv}
                      onChange={e => setPrivEdit(p => ({ ...p, [a.id]: e.target.value }))}
                      style={{ background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '3px 6px', borderRadius: 5, fontSize: 12 }}>
                      {PRIV_LABELS.map((l, i) => <option key={i} value={i}>{i} — {l}</option>)}
                    </select>
                    <button onClick={() => setPriv(a)} disabled={busy[a.id]} className="btn btn-ghost btn-xs">Set</button>
                  </div>
                </td>
                <td style={{ fontSize: 11, color: 'var(--color-text3)' }}>{a.timecreate ? new Date(a.timecreate).toLocaleDateString() : '—'}</td>
                <td style={{ fontSize: 11, color: 'var(--color-text3)' }}>{a.timelastmodify ? new Date(a.timelastmodify).toLocaleDateString() : '—'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button onClick={() => toggleStatus(a)} disabled={busy[a.id]} className="btn btn-ghost btn-xs"
                      style={{ color: a.status === 1 ? 'var(--color-red)' : 'var(--color-teal)' }}>
                      {a.status === 1 ? 'Ban' : 'Unban'}
                    </button>
                    {msgs[a.id] && <span style={{ fontSize: 11, color: 'var(--color-accent)' }}>{msgs[a.id]}</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && visible.length === 0 && <div style={{ padding: 24, color: 'var(--color-text3)', textAlign: 'center', fontSize: 13 }}>No accounts found.</div>}
      </div>
    </div>
  );
}
