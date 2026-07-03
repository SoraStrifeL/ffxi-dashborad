import React, { useState, useEffect, useRef } from 'react';
import { useWS } from '../../hooks/useWS';
import { useStore } from '../../store';
import { api } from '../../api';

const FILES = ['map', 'world', 'connect', 'search'] as const;
type FileKey = typeof FILES[number];

export function Console() {
  const [activeFile, setActiveFile] = useState<FileKey>('map');
  const [lines, setLines]   = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [luaCode,    setLuaCode]    = useState('');
  const [luaOutput,  setLuaOutput]  = useState('');
  const [luaRunning, setLuaRunning] = useState(false);
  const [history,    setHistory]    = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('luaHistory') || '[]'); } catch { return []; } });
  const histIdx = useRef(-1);
  const players = useStore((s) => s.players);
  const wsReady = useStore((s) => s.wsReady);
  const canConsole = useStore((s) => s.permissions.includes('run:console'));
  const { send } = useWS((type, data) => {
    if (type === 'log') {
      const d = data as { file: string; lines: string[] };
      if (d.file === activeFile) {
        setLines((prev) => [...prev, ...d.lines].slice(-2000));
      }
    }
  });

  // wsReady dependency: subscribe once the socket is up, and re-subscribe
  // after a reconnect (server-side subscription state is lost on close)
  useEffect(() => {
    if (!wsReady) return;
    setLines([]);
    send('log_sub', { file: activeFile });
    return () => { send('log_unsub', {}); };
  }, [activeFile, send, wsReady]);

  useEffect(() => {
    if (follow) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines, follow]);

  const filtered = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines;

  function pushHistory(cmd: string) {
    const next = [cmd, ...history.filter(h => h !== cmd)].slice(0, 50);
    setHistory(next);
    localStorage.setItem('luaHistory', JSON.stringify(next));
    histIdx.current = -1;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'ArrowUp' && e.ctrlKey) {
      e.preventDefault();
      const idx = Math.min(histIdx.current + 1, history.length - 1);
      histIdx.current = idx;
      if (history[idx] !== undefined) setLuaCode(history[idx]);
    } else if (e.key === 'ArrowDown' && e.ctrlKey) {
      e.preventDefault();
      const idx = Math.max(histIdx.current - 1, -1);
      histIdx.current = idx;
      setLuaCode(idx === -1 ? '' : history[idx]);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      runLua();
    }
  }

  async function runLua() {
    if (!luaCode.trim()) return;
    pushHistory(luaCode.trim());
    setLuaRunning(true); setLuaOutput('Running…');
    try {
      const { id } = await api.consoleExec(luaCode);
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        try {
          const entry = await api.queueEntry(id);
          if (entry.status === 'complete' || entry.status === 'failed') {
            clearInterval(poll); setLuaRunning(false);
            setLuaOutput(entry.result ?? entry.status);
          } else if (tries > 30) {
            clearInterval(poll); setLuaRunning(false); setLuaOutput('timeout');
          }
        } catch (err) {
          clearInterval(poll); setLuaRunning(false); setLuaOutput((err as Error).message);
        }
      }, 500);
    } catch (e) { setLuaRunning(false); setLuaOutput((e as Error).message); }
  }

  if (!canConsole) return <div style={{ padding: 24, color: 'var(--color-text3)' }}>Console access requires the run:console permission.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {FILES.map((f) => (
            <button key={f} onClick={() => setActiveFile(f)} className={`btn btn-ghost btn-sm ${activeFile === f ? 'btn-primary' : ''}`}
              style={activeFile === f ? { background: 'var(--color-accent)', color: '#fff', borderColor: 'var(--color-accent)' } : {}}>
              {f}
            </button>
          ))}
        </div>
        <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" style={{ maxWidth: 220, fontSize: 12, padding: '5px 10px' }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--color-text2)', cursor: 'pointer', marginLeft: 'auto' }}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
        <button onClick={() => setLines([])} className="btn btn-ghost btn-sm">Clear</button>
      </div>

      {/* Log output */}
      <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6, padding: '8px 16px', background: '#06060f' }}>
        {filtered.map((line, i) => (
          <div key={i} style={{ color: lineColor(line), whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line}</div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Lua executor */}
      <div style={{ flexShrink: 0, borderTop: '2px solid var(--color-border)', background: 'var(--color-surface)' }}>
        <div style={{ padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--color-border)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text3)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Lua Console</span>
          {players.length > 0 && (
            <select onChange={e => { if (e.target.value) { setLuaCode(c => c ? c : `GetPlayerByName("${e.target.value}")`); } e.target.value = ''; }}
              style={{ fontSize: 11, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text2)', borderRadius: 5, padding: '3px 6px', maxWidth: 160 }}
              defaultValue="">
              <option value="" disabled>Insert player…</option>
              {players.map(p => <option key={p.charid} value={p.charname}>{p.charname}</option>)}
            </select>
          )}
          {history.length > 0 && (
            <>
              <select onChange={e => { if (e.target.value) { setLuaCode(e.target.value); histIdx.current = -1; } e.target.value = ''; }}
                style={{ fontSize: 11, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text2)', borderRadius: 5, padding: '3px 6px', maxWidth: 200 }}
                defaultValue="">
                <option value="" disabled>History ({history.length})</option>
                {history.map((h, i) => <option key={i} value={h}>{h.length > 60 ? h.slice(0, 60) + '…' : h}</option>)}
              </select>
              <button onClick={() => { setHistory([]); localStorage.removeItem('luaHistory'); histIdx.current = -1; }} className="btn btn-ghost btn-xs" title="Clear history">✕ Hist</button>
            </>
          )}
          <button onClick={runLua} disabled={luaRunning || !luaCode.trim()} className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }}>{luaRunning ? 'Running…' : '▶ Run'}</button>
          <button onClick={() => { setLuaCode(''); setLuaOutput(''); histIdx.current = -1; }} className="btn btn-ghost btn-sm">Clear</button>
        </div>
        <div style={{ display: 'flex', height: 120 }}>
          <textarea value={luaCode} onChange={e => { setLuaCode(e.target.value); histIdx.current = -1; }}
            placeholder={'GetPlayerByName("Name"):addItem(1000, 1)'}
            onKeyDown={handleKeyDown}
            style={{ flex: 1, background: '#06060f', color: 'var(--color-text1)', fontFamily: 'var(--font-mono)', fontSize: 11, padding: '8px 12px', border: 'none', outline: 'none', resize: 'none', borderRight: '1px solid var(--color-border)' }} />
          <div style={{ width: '40%', overflowY: 'auto', padding: '8px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: luaOutput.includes('Error') ? 'var(--color-red)' : 'var(--color-teal)', background: '#06060f', whiteSpace: 'pre-wrap' }}>
            {luaOutput || <span style={{ color: 'var(--color-text3)' }}>Output (Ctrl+Enter to run)</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function lineColor(line: string) {
  if (/error|fail|critical/i.test(line)) return 'var(--color-red)';
  if (/warn/i.test(line)) return 'var(--color-gold)';
  if (/info|success/i.test(line)) return 'var(--color-teal)';
  return 'var(--color-text3)';
}
