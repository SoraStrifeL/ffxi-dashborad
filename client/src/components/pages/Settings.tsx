import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../api';
import { useStore } from '../../store';
import type { LoginMessage } from '../../types';

type RateEntry = { group: string; key: string; label: string; file: string; step?: number; type?: string; value: number | boolean | null };
type ScanEntry = { key: string; value: unknown; curated: boolean };
type Var = { varname: string; value: number };

const TABS = ['Rates', 'Dashboard', 'Server Vars', 'Settings Scan', 'DB Config', 'Paths', 'Crash Log', 'Quest Settings', 'FS Browser', 'Login Messages'] as const;
type Tab = typeof TABS[number];

// ── Rates panel ───────────────────────────────────────────────────────────────
function RatesPanel() {
  const [entries, setEntries]  = useState<RateEntry[]>([]);
  const [values,  setValues]   = useState<Record<string, number | boolean>>({});
  const [saving,  setSaving]   = useState<Record<string, boolean>>({});
  const [saved,   setSaved]    = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.settings().then(r => {
      const arr = r as RateEntry[];
      setEntries(arr);
      const v: Record<string, number | boolean> = {};
      arr.forEach(e => { if (e.value != null) v[e.key] = e.value as number | boolean; });
      setValues(v);
    }).catch(() => {});
  }, []);

  async function save(key: string) {
    setSaving(p => ({ ...p, [key]: true }));
    try {
      await api.saveRate(key, values[key]);
      setSaved(p => ({ ...p, [key]: true }));
      setTimeout(() => setSaved(p => { const n = { ...p }; delete n[key]; return n; }), 2000);
    } catch (_) {}
    setSaving(p => ({ ...p, [key]: false }));
  }

  const groups: Record<string, RateEntry[]> = {};
  entries.forEach(e => { (groups[e.group] ??= []).push(e); });

  if (entries.length === 0) return (
    <div style={{ color: 'var(--color-text3)', fontSize: 13, padding: '20px 0' }}>Settings files not mounted or unreachable.</div>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
      {Object.entries(groups).map(([group, rows]) => (
        <div key={group} className="card">
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)' }}>{group}</div>
          <div style={{ padding: '6px 14px' }}>
            {rows.map(e => (
              <div key={e.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid rgba(42,42,61,.3)' }}>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--color-text2)' }}>{e.label}</span>
                {e.type === 'bool' ? (
                  <input type="checkbox" checked={!!(values[e.key] ?? e.value)}
                    onChange={ev => setValues(p => ({ ...p, [e.key]: ev.target.checked }))} />
                ) : (
                  <input type="number" step={e.step ?? 1} value={String(values[e.key] ?? e.value ?? '')}
                    onChange={ev => setValues(p => ({ ...p, [e.key]: parseFloat(ev.target.value) }))}
                    style={{ width: 72, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 5, padding: '3px 6px', fontSize: 12, textAlign: 'right' }} />
                )}
                <button onClick={() => save(e.key)} disabled={saving[e.key]} className="btn btn-ghost btn-xs"
                  style={{ minWidth: 40, color: saved[e.key] ? 'var(--color-teal)' : undefined }}>
                  {saved[e.key] ? '✓' : 'Save'}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Dashboard settings panel ──────────────────────────────────────────────────
function DashboardPanel() {
  const [cfg, setCfg]       = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [error,  setError]  = useState('');

  useEffect(() => { api.dashboardSettings().then(setCfg).catch(() => {}); }, []);

  async function save() {
    setSaving(true); setError(''); setSaved(false);
    try {
      await api.saveDashboardSettings(cfg);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) { setError((e as Error).message); }
    setSaving(false);
  }

  const boolKeys = ['autologin', 'autoSwitchZone', 'allowPlayerLogin'];
  const numKeys  = [['tokenTtlHours', 'Token TTL (hours)', 1, 720], ['adminGmLevel', 'Admin GM Level', 1, 10], ['loginRateLimitMax', 'Login Rate Limit', 1, 100]];
  const strKeys  = [['serverName', 'Server Name'], ['motd', 'MOTD']];

  return (
    <div className="card" style={{ maxWidth: 540 }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', flex: 1 }}>Dashboard Settings</span>
        <button onClick={save} disabled={saving} className="btn btn-primary btn-sm">{saving ? '…' : 'Save'}</button>
        {saved  && <span style={{ fontSize: 12, color: 'var(--color-teal)' }}>Saved!</span>}
        {error  && <span style={{ fontSize: 12, color: 'var(--color-red)' }}>{error}</span>}
      </div>
      <div style={{ padding: '8px 16px' }}>
        {strKeys.map(([k, lbl]) => (
          <div key={k} style={{ padding: '8px 0', borderBottom: '1px solid rgba(42,42,61,.3)', display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--color-text2)' }}>{lbl}</span>
            <input className="input" style={{ width: 220, fontSize: 12 }} value={String(cfg[k] ?? '')} onChange={e => setCfg(p => ({ ...p, [k]: e.target.value }))} />
          </div>
        ))}
        {boolKeys.map(k => (
          <label key={k} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid rgba(42,42,61,.3)', cursor: 'pointer' }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--color-text2)' }}>{k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}</span>
            <input type="checkbox" checked={!!cfg[k]} onChange={e => setCfg(p => ({ ...p, [k]: e.target.checked }))} />
          </label>
        ))}
        {numKeys.map(([k, lbl, min, max]) => (
          <div key={k} style={{ padding: '8px 0', borderBottom: '1px solid rgba(42,42,61,.3)', display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--color-text2)' }}>{lbl}</span>
            <input type="number" min={min as number} max={max as number} value={String(cfg[k] ?? '')}
              onChange={e => setCfg(p => ({ ...p, [k]: parseInt(e.target.value) }))}
              style={{ width: 80, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 5, padding: '3px 8px', fontSize: 12 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Server variables panel ────────────────────────────────────────────────────
function ServerVarsPanel() {
  const [vars,    setVars]    = useState<Var[]>([]);
  const [newKey,  setNewKey]  = useState('');
  const [newVal,  setNewVal]  = useState('0');
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [busy,    setBusy]    = useState<Record<string, boolean>>({});
  const [search,  setSearch]  = useState('');

  useEffect(() => { load(); }, []);
  async function load() { try { setVars(await api.serverVars()); } catch (_) {} }

  async function saveVar(varname: string, value: number) {
    setBusy(p => ({ ...p, [varname]: true }));
    try { await api.saveServerVar(varname, value); load(); } catch (_) {}
    setBusy(p => ({ ...p, [varname]: false }));
    setEditing(p => { const n = { ...p }; delete n[varname]; return n; });
  }
  async function addVar() {
    if (!newKey.trim()) return;
    try {
      await api.saveServerVar(newKey.trim(), parseInt(newVal) || 0);
      setNewKey(''); setNewVal('0'); load();
    } catch (_) {}
  }

  const visible = search ? vars.filter(v => v.varname.toLowerCase().includes(search.toLowerCase())) : vars;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="input" placeholder="Filter variables…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
        <span style={{ fontSize: 12, color: 'var(--color-text3)' }}>{visible.length} / {vars.length}</span>
      </div>
      <div className="card">
        <div style={{ padding: '8px 14px 8px', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="input" placeholder="VARIABLE_NAME" value={newKey} onChange={e => setNewKey(e.target.value)} style={{ flex: 1, maxWidth: 260, fontFamily: 'var(--font-mono)', fontSize: 12 }} />
          <input type="number" value={newVal} onChange={e => setNewVal(e.target.value)}
            style={{ width: 80, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 5, padding: '7px 8px', fontSize: 12 }} />
          <button onClick={addVar} className="btn btn-primary btn-sm">Add / Update</button>
        </div>
        {visible.slice(0, 200).map(v => (
          <div key={v.varname} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderBottom: '1px solid rgba(42,42,61,.3)' }}>
            <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text2)' }}>{v.varname}</span>
            <input type="number" value={editing[v.varname] ?? v.value}
              onChange={e => setEditing(p => ({ ...p, [v.varname]: e.target.value }))}
              style={{ width: 80, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 5, padding: '3px 6px', fontSize: 12, textAlign: 'right' }} />
            <button onClick={() => saveVar(v.varname, parseInt(editing[v.varname] ?? String(v.value)) || 0)}
              disabled={busy[v.varname]} className="btn btn-ghost btn-xs">Save</button>
          </div>
        ))}
        {visible.length === 0 && <div style={{ padding: '16px 14px', color: 'var(--color-text3)', fontSize: 12 }}>No variables found.</div>}
      </div>
    </div>
  );
}

// ── Settings scan panel ───────────────────────────────────────────────────────
function ScanPanel() {
  const [scan,      setScan]      = useState<Record<string, { entries: ScanEntry[]; missing: boolean }>>({});
  const [saving,    setSaving]    = useState<Record<string, boolean>>({});
  const [saved,     setSaved]     = useState<Record<string, boolean>>({});
  const [localVals, setLocalVals] = useState<Record<string, unknown>>({});
  const [search,    setSearch]    = useState('');
  const [hideCurated, setHideCurated] = useState(true);

  useEffect(() => { api.settingsScan().then(r => { setScan(r); const lv: Record<string, unknown> = {}; Object.entries(r).forEach(([f, { entries }]) => entries.forEach(e => { lv[`${f}:${e.key}`] = e.value; })); setLocalVals(lv); }).catch(() => {}); }, []);

  async function saveKey(file: string, key: string) {
    const k = `${file}:${key}`;
    setSaving(p => ({ ...p, [k]: true }));
    try {
      await api.saveScanKey(file, key, localVals[k]);
      setSaved(p => ({ ...p, [k]: true }));
      setTimeout(() => setSaved(p => { const n = { ...p }; delete n[k]; return n; }), 2000);
    } catch (_) {}
    setSaving(p => ({ ...p, [k]: false }));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input" placeholder="Filter keys…" value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--color-text2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={hideCurated} onChange={e => setHideCurated(e.target.checked)} />
          Hide curated keys
        </label>
      </div>
      {Object.entries(scan).map(([file, { entries, missing }]) => {
        const visible = entries.filter(e => (!hideCurated || !e.curated) && (!search || e.key.toLowerCase().includes(search.toLowerCase())));
        if (missing) return <div key={file} className="card" style={{ padding: '12px 14px', color: 'var(--color-text3)', fontSize: 12 }}>{file}: not mounted</div>;
        if (visible.length === 0) return null;
        return (
          <div key={file} className="card">
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)' }}>{file}</div>
            {visible.map(e => {
              const k = `${file}:${e.key}`;
              const v = localVals[k] ?? e.value;
              return (
                <div key={e.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderBottom: '1px solid rgba(42,42,61,.2)' }}>
                  <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text2)' }}>{e.key}</span>
                  {typeof e.value === 'boolean' ? (
                    <input type="checkbox" checked={!!(v)} onChange={ev => setLocalVals(p => ({ ...p, [k]: ev.target.checked }))} />
                  ) : (
                    <input type="number" value={String(v ?? '')}
                      onChange={ev => setLocalVals(p => ({ ...p, [k]: parseFloat(ev.target.value) }))}
                      style={{ width: 80, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 5, padding: '3px 6px', fontSize: 11, textAlign: 'right' }} />
                  )}
                  <button onClick={() => saveKey(file, e.key)} disabled={saving[k]} className="btn btn-ghost btn-xs"
                    style={{ color: saved[k] ? 'var(--color-teal)' : undefined }}>{saved[k] ? '✓' : 'Save'}</button>
                </div>
              );
            })}
          </div>
        );
      })}
      {Object.values(scan).every(f => f.missing) && <div style={{ color: 'var(--color-text3)', fontSize: 13 }}>Settings files not mounted.</div>}
    </div>
  );
}

// ── DB connection config ──────────────────────────────────────────────────────
function DbConfigPanel() {
  const [cfg,      setCfg]      = useState<Record<string, unknown>>({});
  const [form,     setForm]     = useState<Record<string, string>>({});
  const [saving,   setSaving]   = useState(false);
  const [testing,  setTesting]  = useState(false);
  const [testMsg,  setTestMsg]  = useState('');
  const [saveMsg,  setSaveMsg]  = useState('');

  useEffect(() => {
    api.dashboardDb().then(r => {
      // `saved` holds only overrides (often {}); `effective` is the merged
      // env+file+default config the server actually uses — show that
      const eff = { ...((r as any).effective ?? {}), ...((r as any).saved ?? {}) };
      setCfg(r as Record<string, unknown>);
      setForm({ DB_HOST: String(eff.DB_HOST ?? ''), DB_PORT: String(eff.DB_PORT ?? '3306'), DB_USER: String(eff.DB_USER ?? ''), DB_NAME: String(eff.DB_NAME ?? ''), DB_PASS: '' });
    }).catch(() => {});
  }, []);

  const fields: [string, string, string][] = [
    ['DB_HOST', 'Host',     'text'],
    ['DB_PORT', 'Port',     'number'],
    ['DB_USER', 'User',     'text'],
    ['DB_NAME', 'Database', 'text'],
    ['DB_PASS', 'Password', 'password'],
  ];

  async function save() {
    setSaving(true); setSaveMsg('');
    try { const r = await api.saveDashboardDb(form); setSaveMsg(r.restartRequired ? 'Saved — restart required' : 'Saved'); }
    catch (e) { setSaveMsg((e as Error).message); }
    setSaving(false); setTimeout(() => setSaveMsg(''), 4000);
  }
  async function test() {
    setTesting(true); setTestMsg('Testing…');
    try {
      const r = await api.testDashboardDb(form);
      setTestMsg(r.ok ? `OK — ${r.version} / ${r.database}` : r.error ?? 'failed');
    } catch (e) { setTestMsg((e as Error).message); }
    setTesting(false);
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', flex: 1 }}>Database Connection</span>
        <button onClick={test} disabled={testing} className="btn btn-ghost btn-sm">Test</button>
        <button onClick={save} disabled={saving} className="btn btn-primary btn-sm">Save</button>
      </div>
      {testMsg && <div style={{ padding: '8px 16px', fontSize: 12, color: testMsg.startsWith('OK') ? 'var(--color-teal)' : 'var(--color-red)', borderBottom: '1px solid var(--color-border)' }}>{testMsg}</div>}
      {saveMsg && <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--color-accent)', borderBottom: '1px solid var(--color-border)' }}>{saveMsg}</div>}
      <div style={{ padding: '6px 16px' }}>
        {fields.map(([k, lbl, type]) => (
          <div key={k} style={{ padding: '8px 0', borderBottom: '1px solid rgba(42,42,61,.3)', display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--color-text2)' }}>{lbl}</span>
            <input type={type} value={form[k] ?? ''} onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))}
              placeholder={type === 'password' ? '(unchanged)' : k === 'DB_PORT' ? '3306' : ''}
              style={{ width: k === 'DB_PORT' ? 80 : 200, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 5, padding: '5px 8px', fontSize: 12 }} />
          </div>
        ))}
        {(cfg as any).effective && (
          <div style={{ padding: '10px 0 4px', fontSize: 11, color: 'var(--color-text3)' }}>
            Active: {(cfg as any).effective.DB_HOST}:{(cfg as any).effective.DB_PORT} / {(cfg as any).effective.DB_NAME}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Paths config ──────────────────────────────────────────────────────────────
function PathsPanel() {
  const [data,   setData]   = useState<{ effective: Record<string,string>; saved: Record<string,string>; defaults: Record<string,string> } | null>(null);
  const [form,   setForm]   = useState<Record<string,string>>({});
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState('');

  useEffect(() => {
    api.dashboardPaths().then(r => {
      setData(r); setForm({ LSB_SCRIPTS_DIR: r.saved.LSB_SCRIPTS_DIR ?? '', LSB_SETTINGS_DIR: r.saved.LSB_SETTINGS_DIR ?? '', LSB_LOG_DIR: r.saved.LSB_LOG_DIR ?? '' });
    }).catch(() => {});
  }, []);

  async function save() {
    setSaving(true); setMsg('');
    try { const r = await api.saveDashboardPaths(form); setMsg(r.restartRequired ? 'Saved — restart required' : 'Saved'); }
    catch (e) { setMsg((e as Error).message); }
    setSaving(false); setTimeout(() => setMsg(''), 4000);
  }

  const PATHS: [string, string][] = [['LSB_SCRIPTS_DIR', 'Scripts dir'], ['LSB_SETTINGS_DIR', 'Settings dir'], ['LSB_LOG_DIR', 'Log dir']];

  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', flex: 1 }}>Mount Paths</span>
        <button onClick={save} disabled={saving} className="btn btn-primary btn-sm">Save</button>
        {msg && <span style={{ fontSize: 12, color: 'var(--color-accent)' }}>{msg}</span>}
      </div>
      <div style={{ padding: '6px 16px' }}>
        {PATHS.map(([k, lbl]) => (
          <div key={k} style={{ padding: '9px 0', borderBottom: '1px solid rgba(42,42,61,.3)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 3 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text2)', width: 110, flexShrink: 0 }}>{lbl}</span>
              <input className="input" value={form[k] ?? ''} onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))}
                placeholder={data?.defaults[k] ?? ''} style={{ flex: 1, fontSize: 12, fontFamily: 'var(--font-mono)' }} />
            </div>
            {data?.effective[k] && <div style={{ fontSize: 10, color: 'var(--color-text3)', paddingLeft: 120 }}>Active: {data.effective[k]}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Crash log ─────────────────────────────────────────────────────────────────
function CrashLogPanel() {
  const [logs,    setLogs]    = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { load(); }, []);
  async function load() {
    setLoading(true);
    try { setLogs(await api.crashLog()); } catch (_) {}
    setLoading(false);
  }
  async function clear() {
    if (!confirm('Clear crash log?')) return;
    try { await api.clearCrashLog(); setLogs([]); } catch (_) {}
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Crash Log</span>
        <span className="pill pill-muted" style={{ fontSize: 11 }}>{logs.length}</span>
        <button onClick={load} className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}>{loading ? '…' : 'Refresh'}</button>
        {logs.length > 0 && <button onClick={clear} className="btn btn-ghost btn-sm" style={{ color: 'var(--color-red)' }}>Clear</button>}
      </div>
      {logs.length === 0 && !loading && <div style={{ color: 'var(--color-text3)', fontSize: 13 }}>No crash entries.</div>}
      {(logs as any[]).map((entry: any, i: number) => (
        <div key={i} className="card" style={{ marginBottom: 10, padding: '12px 16px', borderLeft: '3px solid var(--color-red)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--color-red)', fontWeight: 700 }}>{entry.type ?? 'ERROR'}</span>
            <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>{entry.ts ? new Date(entry.ts).toLocaleString() : ''}</span>
          </div>
          <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text2)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
            {typeof entry.message === 'string' ? entry.message : JSON.stringify(entry, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

// ── Login messages panel ──────────────────────────────────────────────────────
function LoginMessagesPanel() {
  const [messages, setMessages] = useState<LoginMessage[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error,    setError]    = useState('');
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadTargetId = useRef<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { setMessages(await api.loginMessagesAdmin()); } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }

  function patchLocal(id: string, patch: Partial<LoginMessage>) {
    setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)));
  }

  async function addMessage() {
    try {
      const res = await api.createLoginMessage({ title: '', body: '', active: true });
      setMessages(prev => [...prev, res.message]);
    } catch (e) { setError((e as Error).message); }
  }

  async function saveMessage(m: LoginMessage) {
    setSavingId(m.id); setError('');
    try {
      const res = await api.updateLoginMessage(m.id, { title: m.title, body: m.body, active: m.active });
      patchLocal(m.id, res.message);
    } catch (e) { setError((e as Error).message); }
    setSavingId(null);
  }

  async function deleteMessage(id: string) {
    if (!confirm('Delete this login message?')) return;
    try {
      await api.deleteLoginMessage(id);
      setMessages(prev => prev.filter(m => m.id !== id));
    } catch (e) { setError((e as Error).message); }
  }

  async function move(id: string, direction: 'up' | 'down') {
    try {
      const res = await api.moveLoginMessage(id, direction);
      setMessages(res.messages);
    } catch (e) { setError((e as Error).message); }
  }

  function triggerUpload(id: string) {
    uploadTargetId.current = id;
    uploadRef.current?.click();
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const id = uploadTargetId.current;
    if (!file || !id) return;
    try {
      const res = await api.uploadLoginMessageImage(id, file);
      patchLocal(id, { imageUrl: res.url });
    } catch (err) { alert((err as Error).message); }
    e.target.value = '';
  }

  return (
    <div>
      <input ref={uploadRef} type="file" accept="image/*" onChange={handleUpload} style={{ display: 'none' }} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Login Messages</span>
        <span className="pill pill-muted" style={{ fontSize: 11 }}>{messages.length}</span>
        <button onClick={load} className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}>{loading ? '…' : 'Refresh'}</button>
        <button onClick={addMessage} className="btn btn-primary btn-sm">+ Add message</button>
      </div>
      {error && <div style={{ color: 'var(--color-red)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {messages.length === 0 && !loading && <div style={{ color: 'var(--color-text3)', fontSize: 13 }}>No login messages configured.</div>}
      {messages.map((m, i) => (
        <div key={m.id} className="card" style={{ marginBottom: 10, padding: '12px 16px' }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ width: 72, flexShrink: 0 }}>
              {m.imageUrl
                ? <img src={m.imageUrl} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--color-border)' }} />
                : <div style={{ width: 72, height: 72, borderRadius: 6, background: 'var(--color-surface2)', border: '1px dashed var(--color-border)' }} />}
              <button onClick={() => triggerUpload(m.id)} className="btn btn-ghost btn-xs" style={{ fontSize: 10, padding: '3px 7px', marginTop: 6, width: '100%' }}>Upload</button>
            </div>
            <div style={{ flex: 1 }}>
              <input className="input" style={{ width: '100%', marginBottom: 8, fontSize: 13 }} placeholder="Title" value={m.title}
                onChange={e => patchLocal(m.id, { title: e.target.value })} />
              <textarea className="input" style={{ width: '100%', marginBottom: 8, fontSize: 13, minHeight: 60, resize: 'vertical' }} placeholder="Body" value={m.body}
                onChange={e => patchLocal(m.id, { body: e.target.value })} />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--color-text2)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={m.active} onChange={e => patchLocal(m.id, { active: e.target.checked })} />
                  Active
                </label>
                <button onClick={() => saveMessage(m)} disabled={savingId === m.id} className="btn btn-primary btn-sm">
                  {savingId === m.id ? '…' : 'Save'}
                </button>
                <button onClick={() => move(m.id, 'up')} disabled={i === 0} className="btn btn-ghost btn-sm">↑</button>
                <button onClick={() => move(m.id, 'down')} disabled={i === messages.length - 1} className="btn btn-ghost btn-sm">↓</button>
                <button onClick={() => deleteMessage(m.id)} className="btn btn-ghost btn-sm" style={{ color: 'var(--color-red)', marginLeft: 'auto' }}>Delete</button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main Settings page ────────────────────────────────────────────────────────

// ── Quest settings panel ──────────────────────────────────────────────────────
const QUEST_LABELS: Record<string, string> = {
  ENABLE_TRUST_QUESTS: 'Trust Quests', ENABLE_TOAU: 'Treasures of Aht Urhgan', ENABLE_WOTG: 'Wings of the Goddess',
  ENABLE_COP: 'Chains of Promathia', ENABLE_ABYSSEA: 'Abyssea', ENABLE_SOA: 'Seekers of Adoulin',
  ENABLE_ROV: "Return to Vana'diel", ENABLE_TVR: 'Voracious Resurgence', ENABLE_MONSTROSITY: 'Monstrosity',
  ENABLE_CHOCOBO_RAISING: 'Chocobo Raising', AF1_QUEST_LEVEL: 'AF1 Quest Level', AF2_QUEST_LEVEL: 'AF2 Quest Level',
  AF3_QUEST_LEVEL: 'AF3 Quest Level', ADVANCED_JOB_LEVEL: 'Advanced Job Level', MAX_LEVEL: 'Max Level',
  OLDSCHOOL_G1: 'Old-School Genkai 1', OLDSCHOOL_G2: 'Old-School Genkai 2', ENABLE_MAGIAN_TRIALS: 'Magian Trials',
};
const BOOL_KEYS = new Set(['ENABLE_TRUST_QUESTS','ENABLE_TOAU','ENABLE_WOTG','ENABLE_COP','ENABLE_ABYSSEA','ENABLE_SOA','ENABLE_ROV','ENABLE_TVR','ENABLE_MONSTROSITY','ENABLE_CHOCOBO_RAISING','OLDSCHOOL_G1','OLDSCHOOL_G2','ENABLE_MAGIAN_TRIALS']);

function QuestSettingsPanel() {
  const [data, setData] = useState<Record<string, unknown>>({});
  useEffect(() => { api.questSettings().then(setData).catch(() => {}); }, []);
  if (!Object.keys(data).length) return <div style={{ color: 'var(--color-text3)', fontSize: 13, padding: '20px 0' }}>Settings files not mounted or unreachable.</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
      {Object.entries(data).map(([key, val]) => (
        <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--color-text2)' }}>{QUEST_LABELS[key] ?? key}</span>
          {BOOL_KEYS.has(key) ? (
            <span className={`pill ${val ? 'pill-teal' : 'pill-muted'}`} style={{ fontSize: 10 }}>{val ? 'Enabled' : 'Disabled'}</span>
          ) : (
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-accent)' }}>{String(val)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function FsBrowserPanel() {
  const [path, setPath] = useState('/');
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function browse(p: string) {
    setLoading(true); setError('');
    try {
      const r = await api.fsBrowse(p);
      setPath(r.path); setDirs(r.dirs); setParent(r.parent);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }

  useEffect(() => { browse('/'); }, []);

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-text1)', flex: 1, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '6px 10px' }}>{path}</span>
        {parent && <button onClick={() => browse(parent)} className="btn btn-ghost btn-sm">↑ Up</button>}
        <button onClick={() => browse('/')} className="btn btn-ghost btn-sm">Root</button>
      </div>
      {error && <div style={{ color: 'var(--color-red)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
      {loading && <div style={{ color: 'var(--color-text3)', fontSize: 13 }}>Loading…</div>}
      {!loading && dirs.length === 0 && !error && <div style={{ color: 'var(--color-text3)', fontSize: 13 }}>No subdirectories.</div>}
      <div className="card">
        {dirs.map(d => (
          <div key={d.path} onClick={() => browse(d.path)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: '1px solid rgba(42,42,61,.3)', cursor: 'pointer', fontSize: 13 }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--color-surface2)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}>
            <span>📁</span>
            <span style={{ color: 'var(--color-accent)' }}>{d.name}</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-text3)', fontFamily: 'var(--font-mono)' }}>{d.path}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Settings() {
  const [tab, setTab] = useState<Tab>('Rates');
  const canManage = useStore((s) => s.permissions.includes('manage:settings'));
  if (!canManage) return <div style={{ padding: 24, color: 'var(--color-text3)' }}>Settings requires the manage:settings permission.</div>;
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '12px 24px 0', flexShrink: 0 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Settings</h1>
        <div style={{ display: 'flex', gap: 0 }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: 'none', border: 'none',
              borderBottom: `2px solid ${tab === t ? 'var(--color-accent)' : 'transparent'}`,
              color: tab === t ? 'var(--color-accent)' : 'var(--color-text3)',
              padding: '8px 16px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
            }}>{t}</button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {tab === 'Rates'        && <RatesPanel />}
        {tab === 'Dashboard'    && <DashboardPanel />}
        {tab === 'Server Vars'  && <ServerVarsPanel />}
        {tab === 'Settings Scan'&& <ScanPanel />}
        {tab === 'DB Config'    && <DbConfigPanel />}
        {tab === 'Paths'        && <PathsPanel />}
        {tab === 'Crash Log'    && <CrashLogPanel />}
        {tab === 'Quest Settings' && <QuestSettingsPanel />}
        {tab === 'FS Browser'    && <FsBrowserPanel />}
        {tab === 'Login Messages'  && <LoginMessagesPanel />}
      </div>
    </div>
  );
}
