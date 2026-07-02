import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../api';

interface Script { id: string; name: string; description?: string; code: string; created: number; updated: number; }
interface BrowserEntry { name: string; type: 'dir' | 'file'; }

export function Scripts() {
  const [scripts,  setScripts]  = useState<Script[]>([]);
  const [sel,      setSel]      = useState<Script | null>(null);
  const [name,     setName]     = useState('');
  const [desc,     setDesc]     = useState('');
  const [code,     setCode]     = useState('');
  const [output,   setOutput]   = useState('');
  const [running,  setRunning]  = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [msg,      setMsg]      = useState<{ text: string; ok: boolean } | null>(null);
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserPath, setBrowserPath] = useState('');
  const [browserEntries, setBrowserEntries] = useState<BrowserEntry[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { loadScripts(); }, []);
  useEffect(() => { if (showBrowser) browse(''); }, [showBrowser]);

  async function loadScripts() {
    try { setScripts((await api.scripts()) as Script[]); } catch (_) {}
  }

  function selectScript(s: Script) {
    setSel(s); setName(s.name); setDesc(s.description ?? ''); setCode(s.code); setOutput('');
  }
  function newScript() {
    setSel(null); setName(''); setDesc(''); setCode(''); setOutput('');
  }

  async function save() {
    if (!name.trim() || !code.trim()) return;
    setSaving(true);
    try {
      const res = await api.saveScript({ ...(sel ? { id: sel.id } : {}), name: name.trim(), description: desc, code }) as { ok: boolean; scripts: Script[] };
      setScripts(res.scripts);
      if (!sel) {
        const created = res.scripts.find(s => s.name === name.trim() && s.code === code);
        if (created) setSel(created);
      }
      setMsg({ text: 'Saved', ok: true });
    } catch (e) { setMsg({ text: (e as Error).message, ok: false }); }
    setSaving(false);
    setTimeout(() => setMsg(null), 3000);
  }

  async function del() {
    if (!sel || !confirm(`Delete "${sel.name}"?`)) return;
    await api.deleteScript(sel.id);
    newScript(); loadScripts();
  }

  async function run() {
    if (!code.trim()) return;
    setRunning(true); setOutput('Running…');
    try {
      const { id } = await api.consoleExec(code);
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        const entry = await api.queueEntry(id);
        if (entry.status === 'complete') {
          clearInterval(poll); setRunning(false);
          setOutput(entry.result ?? '(no output)');
        } else if (entry.status === 'failed' || tries > 30) {
          clearInterval(poll); setRunning(false);
          setOutput(entry.result ?? entry.status);
        }
      }, 500);
    } catch (e) { setRunning(false); setOutput((e as Error).message); }
  }

  async function browse(p: string) {
    setBrowsing(true);
    try {
      const entries = await api.scriptBrowse(p);
      setBrowserEntries(entries as BrowserEntry[]); setBrowserPath(p);
    } catch (e) { setBrowserEntries([]); }
    setBrowsing(false);
  }

  async function openFile(p: string) {
    try {
      const content = await api.scriptFileText(p);
      setCode(content);
      const fname = p.split('/').pop()?.replace('.lua', '') ?? 'imported';
      if (!name) setName(fname);
      setShowBrowser(false);
      textareaRef.current?.focus();
    } catch (e) { alert((e as Error).message); }
  }

  const breadcrumbs = browserPath ? browserPath.split('/') : [];

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Script list sidebar */}
      <div style={{ width: 220, background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '11px 12px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>Scripts</span>
          <button onClick={newScript} className="btn btn-ghost btn-xs">+ New</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
          {scripts.length === 0 && <div style={{ padding: '12px 4px', color: 'var(--color-text3)', fontSize: 12 }}>No saved scripts</div>}
          {scripts.map(s => (
            <button key={s.id} onClick={() => selectScript(s)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 7, border: 'none',
                background: sel?.id === s.id ? 'var(--color-surface2)' : 'transparent',
                color: sel?.id === s.id ? 'var(--color-text1)' : 'var(--color-text3)',
                fontSize: 13, fontWeight: sel?.id === s.id ? 600 : 400, cursor: 'pointer', marginBottom: 2 }}>
              {s.name}
            </button>
          ))}
        </div>
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--color-border)' }}>
          <button onClick={() => setShowBrowser(!showBrowser)} className="btn btn-ghost btn-sm" style={{ width: '100%' }}>
            {showBrowser ? 'Close Browser' : 'Browse Server Files'}
          </button>
        </div>
      </div>

      {/* Editor / Browser */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {showBrowser ? (
          <>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
              <button onClick={() => browse('')} className="btn btn-ghost btn-xs">root</button>
              {breadcrumbs.map((crumb, i) => (
                <React.Fragment key={i}>
                  <span style={{ color: 'var(--color-text3)', fontSize: 12 }}>/</span>
                  <button onClick={() => browse(breadcrumbs.slice(0, i + 1).join('/'))} className="btn btn-ghost btn-xs">{crumb}</button>
                </React.Fragment>
              ))}
              {browsing && <span style={{ fontSize: 11, color: 'var(--color-text3)', marginLeft: 8 }}>Loading…</span>}
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {browserEntries.map(e => (
                <div key={e.name}
                  onClick={() => e.type === 'dir' ? browse(browserPath ? `${browserPath}/${e.name}` : e.name) : openFile(browserPath ? `${browserPath}/${e.name}` : e.name)}
                  style={{ padding: '9px 20px', borderBottom: '1px solid var(--color-border)', cursor: 'pointer', fontSize: 13, display: 'flex', gap: 10, alignItems: 'center' }}
                  onMouseEnter={ev => (ev.currentTarget.style.background = 'var(--color-surface2)')}
                  onMouseLeave={ev => (ev.currentTarget.style.background = '')}>
                  <span style={{ fontSize: 15 }}>{e.type === 'dir' ? '📁' : '📄'}</span>
                  <span style={{ color: e.type === 'dir' ? 'var(--color-accent)' : 'var(--color-text1)' }}>{e.name}</span>
                </div>
              ))}
              {browserEntries.length === 0 && !browsing && <div style={{ padding: '20px', color: 'var(--color-text3)', fontSize: 12 }}>Empty or not mounted.</div>}
            </div>
          </>
        ) : (
          <>
            {/* Editor toolbar */}
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
              <input className="input" placeholder="Script name…" value={name} onChange={e => setName(e.target.value)} style={{ maxWidth: 200 }} />
              <input className="input" placeholder="Description (optional)" value={desc} onChange={e => setDesc(e.target.value)} style={{ flex: 1 }} />
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                <button onClick={run} disabled={running || !code.trim()} className="btn btn-primary btn-sm">{running ? 'Running…' : '▶ Run'}</button>
                <button onClick={save} disabled={saving} className="btn btn-ghost btn-sm">{saving ? 'Saving…' : 'Save'}</button>
                {sel && <button onClick={del} className="btn btn-ghost btn-sm" style={{ color: 'var(--color-red)' }}>Delete</button>}
              </div>
              {msg && <span style={{ fontSize: 12, color: msg.ok ? 'var(--color-teal)' : 'var(--color-red)' }}>{msg.text}</span>}
            </div>

            {/* Code editor */}
            <textarea ref={textareaRef} value={code} onChange={e => setCode(e.target.value)}
              placeholder={'-- Lua code\nGetPlayerByName("Name"):addKeyItem(1)'}
              style={{ flex: 1, background: '#06060f', color: 'var(--color-text1)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6, padding: '12px 16px', border: 'none', outline: 'none', resize: 'none', borderBottom: '1px solid var(--color-border)' }} />

            {/* Output */}
            <div style={{ flexShrink: 0, minHeight: 72, maxHeight: 160, overflowY: 'auto', background: '#06060f', padding: '8px 16px', fontFamily: 'var(--font-mono)', fontSize: 12, color: output.startsWith('Error') || output.includes('failed') ? 'var(--color-red)' : 'var(--color-teal)' }}>
              {output || <span style={{ color: 'var(--color-text3)' }}>Output appears here after Run.</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
