import React, { useState, useEffect } from 'react';
import { api } from '../../api';

interface Entry { name: string; type: 'file'|'dir'; path: string; size?: number }
interface GhCfg { repo?: string; branch?: string; token?: string }

export function GitHub() {
  const [branch, setBranch]     = useState('base');
  const [path, setPath]         = useState('');
  const [entries, setEntries]   = useState<Entry[]>([]);
  const [fileContent, setContent] = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [breadcrumb, setBreadcrumb] = useState<string[]>([]);
  const [showCfg,   setShowCfg]   = useState(false);
  const [cfg,       setCfg]       = useState<GhCfg>({});
  const [form,      setForm]      = useState<GhCfg>({});
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgMsg,    setCfgMsg]    = useState('');

  useEffect(() => {
    api.ghConfig().then(r => {
      const c = r as GhCfg; setCfg(c);
      setForm({ repo: c.repo ?? '', branch: c.branch ?? 'base', token: '' });
      if (c.branch) setBranch(c.branch);
    }).catch(() => {});
  }, []);

  async function saveCfg() {
    setSavingCfg(true); setCfgMsg('');
    try { await api.saveGhConfig(form); setCfg(form); if (form.branch) setBranch(form.branch); setCfgMsg('Saved'); setTimeout(() => setCfgMsg(''), 3000); }
    catch (e) { setCfgMsg((e as Error).message); }
    setSavingCfg(false);
  }

  async function browse(p: string) {
    setLoading(true); setError(''); setContent(null);
    try {
      const r = await api.ghBrowse(p, branch) as { items?: Entry[] } | Entry[];
      setEntries(Array.isArray(r) ? r : r.items ?? []);
      setPath(p);
      setBreadcrumb(p ? p.split('/') : []);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }

  async function openFile(p: string) {
    setLoading(true); setError('');
    try { const r = await api.ghFile(p, branch); setContent(r.content); } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 16, fontWeight: 700 }}>GitHub Browser</h1>
        {cfg.repo && <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>{cfg.repo}</span>}
        <input className="input" value={branch} onChange={e => setBranch(e.target.value)} placeholder="branch" style={{ maxWidth: 120, fontSize: 12, padding: '5px 10px' }} />
        <button onClick={() => browse('')} className="btn btn-primary btn-sm">Browse root</button>
        <button onClick={() => setShowCfg(!showCfg)} className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}>⚙ Config</button>
        {error && <span style={{ fontSize: 12, color: 'var(--color-red)', width: '100%' }}>{error}</span>}
      </div>

      {/* Config panel */}
      {showCfg && (
        <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '12px 16px', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', maxWidth: 700 }}>
            {([['repo','Repository','text'],['branch','Default branch','text'],['token','GitHub token','password']] as [keyof GhCfg, string, string][]).map(([k, lbl, type]) => (
              <div key={k} style={{ flex: k === 'repo' ? 1 : '0 0 150px' }}>
                <label style={{ display: 'block', fontSize: 10, color: 'var(--color-text3)', marginBottom: 3 }}>{lbl}</label>
                <input type={type} value={form[k] ?? ''} onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))}
                  placeholder={type === 'password' ? '(stored)' : k === 'repo' ? 'LandSandBoat/server' : 'base'}
                  className="input" style={{ fontSize: 12, width: '100%' }} />
              </div>
            ))}
            <button onClick={saveCfg} disabled={savingCfg} className="btn btn-primary btn-sm" style={{ flexShrink: 0 }}>Save</button>
            {cfgMsg && <span style={{ fontSize: 12, color: 'var(--color-teal)' }}>{cfgMsg}</span>}
          </div>
        </div>
      )}

      {/* Breadcrumb */}
      {breadcrumb.length > 0 && (
        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--color-text3)', flexShrink: 0 }}>
          <button onClick={() => browse('')} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 12 }}>root</button>
          {breadcrumb.map((seg, i) => (
            <React.Fragment key={i}>
              <span>/</span>
              <button onClick={() => browse(breadcrumb.slice(0, i + 1).join('/'))} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', fontSize: 12 }}>{seg}</button>
            </React.Fragment>
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
        {/* File list */}
        <div style={{ width: fileContent ? 280 : '100%', overflowY: 'auto', borderRight: fileContent ? '1px solid var(--color-border)' : 'none' }}>
          {loading && <div style={{ padding: 16, color: 'var(--color-text3)' }}>Loading…</div>}
          {entries.map(e => (
            <div key={e.path} onClick={() => e.type === 'dir' ? browse(e.path) : openFile(e.path)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--color-border)', cursor: 'pointer', fontSize: 13 }}
              onMouseEnter={el => { (el.currentTarget as HTMLElement).style.background = 'var(--color-surface2)'; }}
              onMouseLeave={el => { (el.currentTarget as HTMLElement).style.background = 'transparent'; }}>
              <span style={{ fontSize: 15 }}>{e.type === 'dir' ? '📁' : '📄'}</span>
              <span style={{ flex: 1, color: e.type === 'dir' ? 'var(--color-accent)' : 'var(--color-text1)' }}>{e.name}</span>
              {e.size !== undefined && <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>{(e.size / 1024).toFixed(1)} KB</span>}
            </div>
          ))}
          {!loading && entries.length === 0 && (
            <div style={{ padding: '24px', color: 'var(--color-text3)', textAlign: 'center' }}>
              {cfg.repo ? 'Click "Browse root" to start.' : 'Configure a repo in ⚙ Config first.'}
            </div>
          )}
        </div>

        {/* File content */}
        {fileContent !== null && (
          <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6, padding: '12px 16px', background: '#06060f', color: 'var(--color-text2)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            <button onClick={() => setContent(null)} style={{ position: 'sticky', top: 0, marginBottom: 8, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', borderRadius: 5, color: 'var(--color-text2)', padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>
              ✕ Close
            </button>
            {fileContent}
          </div>
        )}
      </div>
    </div>
  );
}
