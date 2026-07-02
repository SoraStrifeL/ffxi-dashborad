import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../api';

interface ContainerInfo { id: string; names: string[]; image: string; status: string; state: string; created: number; ports: string[] }
interface DockerStatus { available: boolean; hint?: string; error?: string; serverVersion?: string; containers?: ContainerInfo[] }

function fmtBytes(b: number) {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

export function Docker() {
  const [info,       setInfo]       = useState<DockerStatus | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');
  const [actionMsgs, setActionMsgs] = useState<Record<string, string>>({});
  const [logContainer, setLogContainer] = useState<ContainerInfo | null>(null);
  const [logLines,   setLogLines]   = useState<string[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logTail,    setLogTail]    = useState(100);
  const [logFilter,  setLogFilter]  = useState('');
  const [fsContainer, setFsContainer] = useState<ContainerInfo | null>(null);
  const [fsEntries,  setFsEntries]  = useState<{ name: string; type: string; size?: number }[]>([]);
  const [fsPath,     setFsPath]     = useState('/');
  const [fsLoading,  setFsLoading]  = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function load() {
    setLoading(true); setError('');
    try { setInfo(await api.docker() as DockerStatus); } catch (e) { setError((e as Error).message); }
    setLoading(false);
  }
  async function doRestart(containerId: string) {
    setActionMsgs(prev => ({ ...prev, [containerId]: '…' }));
    try {
      await api.dockerAction(containerId, 'restart');
      setActionMsgs(prev => ({ ...prev, [containerId]: 'Restarted' }));
      setTimeout(() => setActionMsgs(prev => { const n = { ...prev }; delete n[containerId]; return n; }), 3000);
      load();
    } catch (e) { setActionMsgs(prev => ({ ...prev, [containerId]: (e as Error).message })); }
  }
  async function loadLogs(c: ContainerInfo, tail = logTail) {
    setLogContainer(c); setFsContainer(null); setLogLoading(true); setLogLines([]); setLogFilter('');
    try { const r = await api.dockerLogs(c.id, tail); setLogLines(r.lines); } catch (e) { setLogLines([`Error: ${(e as Error).message}`]); }
    setLogLoading(false);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }
  async function browseFs(c: ContainerInfo, p = '/') {
    setFsContainer(c); setLogContainer(null); setFsLoading(true); setFsPath(p); setFsEntries([]);
    try { const r = await api.dockerFsBrowse(c.id, p); setFsEntries(r.entries); } catch (e) { setFsEntries([{ name: (e as Error).message, type: 'error' }]); }
    setFsLoading(false);
  }

  useEffect(() => { load(); }, []);

  function lineColor(line: string) {
    if (/error|fail|critical/i.test(line)) return 'var(--color-red)';
    if (/warn/i.test(line)) return 'var(--color-gold)';
    return 'var(--color-text3)';
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Container list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Docker</h1>
          {info?.serverVersion && <span className="pill pill-muted" style={{ fontSize: 11 }}>Docker {info.serverVersion}</span>}
          <button onClick={load} disabled={loading} className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}>{loading ? '…' : 'Refresh'}</button>
        </div>

        {error && <div style={{ color: 'var(--color-red)', marginBottom: 16 }}>{error}</div>}
        {info && !info.available && (
          <div style={{ color: 'var(--color-text3)', fontSize: 13 }}>
            Docker not available.{info.hint && <><br /><span style={{ marginTop: 6, display: 'block', fontSize: 12 }}>{info.hint}</span></>}
          </div>
        )}

        {info?.containers?.map(c => (
          <div key={c.id} className="card" style={{ marginBottom: 12, padding: '16px 20px', borderLeft: logContainer?.id === c.id ? '3px solid var(--color-accent)' : '3px solid transparent' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text1)' }}>{c.names.join(', ')}</span>
              <span className={`pill ${c.state === 'running' ? 'pill-teal' : 'pill-red'}`}>{c.status}</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                {actionMsgs[c.id] && <span style={{ fontSize: 11, color: 'var(--color-teal)' }}>{actionMsgs[c.id]}</span>}
                <button onClick={() => loadLogs(c)} className="btn btn-ghost btn-xs">Logs</button>
                <button onClick={() => browseFs(c)} className="btn btn-ghost btn-xs">Files</button>
                <button onClick={() => doRestart(c.id)} className="btn btn-ghost btn-xs">Restart</button>
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text3)' }}>{c.image}</div>
            {c.ports.length > 0 && <div style={{ fontSize: 11, color: 'var(--color-text3)', marginTop: 3 }}>{c.ports.join(' · ')}</div>}
          </div>
        ))}
        {!loading && !error && (!info || (info.available && (!info.containers || info.containers.length === 0))) && (
          <div style={{ color: 'var(--color-text3)', fontSize: 13 }}>No containers found.</div>
        )}
      </div>

      {/* Log panel */}
      {logContainer && (
        <div style={{ width: '55%', borderLeft: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{logContainer.names[0]} logs</span>
            <input className="input" value={logFilter} onChange={e => setLogFilter(e.target.value)} placeholder="Filter…"
              style={{ flex: 1, minWidth: 80, maxWidth: 180, fontSize: 11, padding: '4px 8px' }} />
            <select value={logTail} onChange={e => { setLogTail(Number(e.target.value)); loadLogs(logContainer, Number(e.target.value)); }}
              style={{ background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 5, padding: '4px 6px', fontSize: 12 }}>
              {[50,100,200].map(n => <option key={n} value={n}>Last {n}</option>)}
            </select>
            <button onClick={() => loadLogs(logContainer)} className="btn btn-ghost btn-xs">↺</button>
            <button onClick={() => { setLogContainer(null); setLogLines([]); }} className="btn btn-ghost btn-xs">✕</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6, padding: '8px 12px', background: '#06060f' }}>
            {logLoading && <div style={{ color: 'var(--color-text3)' }}>Loading…</div>}
            {(logFilter ? logLines.filter(l => l.toLowerCase().includes(logFilter.toLowerCase())) : logLines).map((line, i) => (
              <div key={i} style={{ color: lineColor(line), whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line}</div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      {/* FS browser panel */}
      {fsContainer && (
        <div style={{ width: '45%', borderLeft: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{fsContainer.names[0]} files</span>
            <button onClick={() => { setFsContainer(null); setFsEntries([]); }} className="btn btn-ghost btn-xs">✕</button>
          </div>
          <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface2)', fontSize: 11, color: 'var(--color-text3)', fontFamily: 'var(--font-mono)', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fsPath}</span>
            {fsPath !== '/' && (
              <button onClick={() => browseFs(fsContainer, fsPath.replace(/\/?[^/]+\/?$/, '') || '/')} className="btn btn-ghost btn-xs">↑ Up</button>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {fsLoading && <div style={{ padding: '12px 14px', color: 'var(--color-text3)', fontSize: 12 }}>Loading…</div>}
            {!fsLoading && fsEntries.length === 0 && <div style={{ padding: '12px 14px', color: 'var(--color-text3)', fontSize: 12 }}>Empty directory.</div>}
            {fsEntries.map((e, i) => {
              const childPath = (fsPath.replace(/\/$/, '')) + '/' + e.name;
              return (
                <div key={i}
                  onClick={e.type === 'dir' ? () => browseFs(fsContainer, childPath) : undefined}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderBottom: '1px solid rgba(42,42,61,.3)', cursor: e.type === 'dir' ? 'pointer' : 'default',
                    fontSize: 12, color: e.type === 'dir' ? 'var(--color-accent)' : e.type === 'error' ? 'var(--color-red)' : 'var(--color-text2)' }}
                  onMouseEnter={el => e.type === 'dir' && ((el.currentTarget as HTMLElement).style.background = 'var(--color-surface2)')}
                  onMouseLeave={el => (el.currentTarget as HTMLElement).style.background = 'transparent'}>
                  <span style={{ flexShrink: 0 }}>{e.type === 'dir' ? '📁' : '📄'}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
                  {e.size != null && <span style={{ fontSize: 10, color: 'var(--color-text3)', flexShrink: 0 }}>{fmtBytes(e.size)}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
