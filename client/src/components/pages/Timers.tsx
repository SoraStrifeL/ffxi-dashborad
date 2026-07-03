import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';

interface Timer {
  id: string; name: string; zone: string; respawnMin: number; respawnMax: number; notes: string;
  groupId: number | null; nmName: string | null; zoneId: number | null;
  spawnX: number | null; spawnY: number | null; spawnZ: number | null;
  type: string; roeId: number | null; goal: number | null;
  lastKill: number | null; created: number; updated: number;
}
interface NMResult {
  groupId: number; name: string; nmName: string; zone: string; zoneId: number;
  spawnX: number | null; spawnY: number | null; spawnZ: number | null;
  respawnSecs: number; respawnMin: number; respawnMax: number;
}

function phase(t: Timer, now: number): { ph: 'idle'|'waiting'|'window'|'overdue'; remaining: number; progress: number } {
  if (!t.lastKill) return { ph: 'idle', remaining: 0, progress: 0 };
  const elapsed = now - t.lastKill;
  const minMs = t.respawnMin * 3600_000;
  const maxMs = t.respawnMax * 3600_000;
  if (elapsed < minMs) return { ph: 'waiting', remaining: minMs - elapsed, progress: elapsed / minMs };
  if (elapsed < maxMs) return { ph: 'window',  remaining: maxMs - elapsed, progress: (elapsed - minMs) / (maxMs - minMs) };
  return { ph: 'overdue', remaining: 0, progress: 1 };
}
function fmtMs(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const PH_COLOR: Record<string, string> = {
  idle: 'var(--color-text3)', waiting: 'var(--color-accent)',
  window: 'var(--color-teal)', overdue: 'var(--color-red)',
};
const PH_ORDER: Record<string, number> = { window: 0, overdue: 1, waiting: 2, idle: 3 };

export function Timers() {
  const navigate = useNavigate();
  const [timers,   setTimers]   = useState<Timer[]>([]);
  const [now,      setNow]      = useState(Date.now());
  const [showAdd,  setShowAdd]  = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [checks,   setChecks]   = useState<Record<string, string>>({});

  const [addName, setAddName] = useState('');
  const [addZone, setAddZone] = useState('');
  const [addMin,  setAddMin]  = useState('1');
  const [addMax,  setAddMax]  = useState('1');
  const [addNotes,setAddNotes]= useState('');

  const [nmQ,         setNmQ]         = useState('');
  const [nmMinResp,   setNmMinResp]   = useState(3600);
  const [nmResults,   setNmResults]   = useState<NMResult[]>([]);
  const [nmLoading,   setNmLoading]   = useState(false);
  const [checkAllLoading, setCheckAllLoading] = useState(false);
  const [spawns,      setSpawns]      = useState<Record<string, { x: number; y: number; z: number; zoneId?: number } | null>>({});
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [editForm,    setEditForm]    = useState({ name: '', zone: '', min: '1', max: '1', notes: '' });

  useEffect(() => { load(); }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  async function load() {
    try { setTimers((await api.timers()) as Timer[]); } catch (_) {}
  }
  async function kill(id: string) { try { await api.killTimer(id); load(); } catch (_) {} }
  async function reset(id: string) { try { await api.resetTimer(id); load(); } catch (_) {} }
  async function del(id: string) { if (!confirm('Delete timer?')) return; try { await api.deleteTimer(id); load(); } catch (_) {} }

  function startEdit(t: Timer) {
    setEditingId(t.id);
    setEditForm({ name: t.name, zone: t.zone, min: String(t.respawnMin), max: String(t.respawnMax), notes: t.notes });
  }
  async function saveEdit(t: Timer) {
    await api.saveTimer({ id: t.id, name: editForm.name.trim() || t.name, zone: editForm.zone, respawnMin: parseFloat(editForm.min)||1, respawnMax: parseFloat(editForm.max)||1, notes: editForm.notes, groupId: t.groupId, nmName: t.nmName, zoneId: t.zoneId, spawnX: t.spawnX, spawnY: t.spawnY, spawnZ: t.spawnZ, type: t.type, roeId: t.roeId, goal: t.goal });
    setEditingId(null); load();
  }

  async function addManual() {
    if (!addName.trim()) return;
    await api.saveTimer({ name: addName.trim(), zone: addZone, respawnMin: parseFloat(addMin)||1, respawnMax: parseFloat(addMax)||1, notes: addNotes });
    setAddName(''); setAddZone(''); setAddMin('1'); setAddMax('1'); setAddNotes('');
    setShowAdd(false); load();
  }

  async function searchNMs() {
    setNmLoading(true);
    try { setNmResults((await api.searchNMs(nmQ, nmMinResp)) as NMResult[]); } catch (_) {}
    setNmLoading(false);
  }
  async function importNM(nm: NMResult) {
    await api.saveTimer({ name: nm.name, zone: nm.zone, respawnMin: nm.respawnMin, respawnMax: nm.respawnMax, notes: '', groupId: nm.groupId, nmName: nm.nmName, zoneId: nm.zoneId, spawnX: nm.spawnX, spawnY: nm.spawnY, spawnZ: nm.spawnZ });
    load();
  }
  async function lookupSpawn(t: Timer) {
    if (!t.groupId || !t.nmName) return;
    try {
      const r = await api.nmSpawnpoint(t.groupId, t.nmName);
      setSpawns(p => ({ ...p, [t.id]: r.found ? { x: r.x!, y: r.y!, z: r.z!, zoneId: r.zoneId } : null }));
    } catch (_) { setSpawns(p => ({ ...p, [t.id]: null })); }
  }
  async function checkHP(t: Timer) {
    if (!t.groupId || !t.nmName) return;
    setChecks(p => ({ ...p, [t.id]: 'checking…' }));
    try {
      const r = await api.checkNM(t.groupId, t.nmName) as { queued: boolean; id?: number };
      if (!r.queued || !r.id) { setChecks(p => ({ ...p, [t.id]: 'no spawn pts' })); return; }
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        try {
          const entry = await api.nmResult(r.id!);
          if (entry.status === 'complete' && entry.result) {
            clearInterval(poll);
            const [spawned, hpp] = entry.result.split('|');
            setChecks(p => ({ ...p, [t.id]: spawned === 'spawned' ? `HP ${hpp}%` : 'Not up' }));
          } else if (entry.status === 'failed') {
            clearInterval(poll); setChecks(p => ({ ...p, [t.id]: 'failed' }));
          } else if (tries > 20) {
            clearInterval(poll); setChecks(p => ({ ...p, [t.id]: 'timeout' }));
          }
        } catch (_) {
          clearInterval(poll); setChecks(p => ({ ...p, [t.id]: 'error' }));
        }
      }, 600);
    } catch (_) { setChecks(p => ({ ...p, [t.id]: 'error' })); }
  }
  async function checkAll() {
    // Snapshot the trackable timers now — results are matched back by index,
    // so re-filtering at poll time would misalign if the list changes meanwhile
    const trackable = timers.filter(t => t.groupId && t.nmName);
    const targets = trackable.map(t => ({ groupId: t.groupId!, nmName: t.nmName! }));
    if (!targets.length) return;
    setCheckAllLoading(true);
    try {
      const r = await api.nmCheckAll(targets) as { queued: boolean; id?: number; count?: number };
      if (!r.queued || !r.id) { setCheckAllLoading(false); return; }
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        let entry;
        try { entry = await api.nmResult(r.id!); }
        catch (_) { clearInterval(poll); setCheckAllLoading(false); return; }
        if (entry.status === 'complete' && entry.result) {
          clearInterval(poll);
          const parts = String(entry.result).split(';');
          const newChecks: Record<string, string> = {};
          parts.forEach((p, i) => {
            const t = trackable[i];
            if (!t) return;
            const [spawned, hpp] = p.split('|');
            newChecks[t.id] = spawned === '1' ? `HP ${hpp}%` : 'Not up';
          });
          setChecks(prev => ({ ...prev, ...newChecks }));
          setCheckAllLoading(false);
        } else if (entry.status === 'failed' || tries > 30) {
          clearInterval(poll); setCheckAllLoading(false);
        }
      }, 600);
    } catch (_) { setCheckAllLoading(false); }
  }


  const sorted = [...timers].sort((a, b) => (PH_ORDER[phase(a, now).ph] ?? 3) - (PH_ORDER[phase(b, now).ph] ?? 3));

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ padding: '11px 16px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface)', display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Timers</span>
          <span className="pill pill-muted" style={{ fontSize: 11 }}>{timers.length}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => { setShowAdd(!showAdd); setShowImport(false); }} className="btn btn-ghost btn-sm">{showAdd ? 'Cancel' : '+ Add'}</button>
            <button onClick={() => { setShowImport(!showImport); setShowAdd(false); }} className="btn btn-ghost btn-sm">{showImport ? 'Close' : 'Import NM'}</button>
            {timers.some(t => t.groupId && t.nmName) && <button onClick={checkAll} disabled={checkAllLoading} className="btn btn-ghost btn-sm">{checkAllLoading ? 'Checking…' : 'Check All'}</button>}
          </div>
        </div>

        {/* Add form */}
        {showAdd && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-surface2)', flexShrink: 0, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {[['Name', addName, setAddName, '2', 'NM Name'],['Zone', addZone, setAddZone, '2', 'Zone']].map(([lbl, val, set, fl, ph]) => (
              <div key={lbl as string} style={{ flex: fl as string }}>
                <label style={{ display: 'block', fontSize: 10, color: 'var(--color-text3)', marginBottom: 2 }}>{lbl as string}</label>
                <input className="input" value={val as string} onChange={e => (set as React.Dispatch<React.SetStateAction<string>>)(e.target.value)} placeholder={ph as string} />
              </div>
            ))}
            {[['Min h', addMin, setAddMin],['Max h', addMax, setAddMax]].map(([lbl, val, set]) => (
              <div key={lbl as string} style={{ width: 80 }}>
                <label style={{ display: 'block', fontSize: 10, color: 'var(--color-text3)', marginBottom: 2 }}>{lbl as string}</label>
                <input className="input" type="number" step="0.5" value={val as string} onChange={e => (set as React.Dispatch<React.SetStateAction<string>>)(e.target.value)} />
              </div>
            ))}
            <div style={{ flex: '3' }}>
              <label style={{ display: 'block', fontSize: 10, color: 'var(--color-text3)', marginBottom: 2 }}>Notes</label>
              <input className="input" value={addNotes} onChange={e => setAddNotes(e.target.value)} placeholder="Optional" />
            </div>
            <button onClick={addManual} className="btn btn-primary btn-sm">Add</button>
          </div>
        )}

        {/* Timer list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          {sorted.length === 0 && <div style={{ color: 'var(--color-text3)', fontSize: 13, padding: '32px 0', textAlign: 'center' }}>No timers yet. Add a timer or import from the NM database.</div>}
          {sorted.map(t => {
            const { ph, remaining, progress } = phase(t, now);
            const col = PH_COLOR[ph];
            return (
              <div key={t.id} className="card" style={{ marginBottom: 10, padding: '12px 14px', borderLeft: `3px solid ${col}` }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--color-text1)' }}>{t.name}</span>
                      {t.zone && <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>{t.zone}</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: col }}>
                        {ph.toUpperCase()}{remaining > 0 ? ` · ${fmtMs(remaining)}` : ''}
                      </span>
                    </div>
                    {t.notes && <div style={{ fontSize: 11, color: 'var(--color-text3)', marginBottom: 4 }}>{t.notes}</div>}
                    {(ph === 'waiting' || ph === 'window') && (
                      <div style={{ height: 3, background: 'var(--color-surface2)', borderRadius: 2, overflow: 'hidden', margin: '5px 0 3px' }}>
                        <div style={{ width: `${Math.min(100, progress * 100)}%`, height: '100%', background: col, borderRadius: 2 }} />
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--color-text3)', marginTop: 2 }}>
                      {t.respawnMin === t.respawnMax ? `${t.respawnMin}h` : `${t.respawnMin}–${t.respawnMax}h`}
                      {t.lastKill && <> · killed {new Date(t.lastKill).toLocaleTimeString()}</>}
                    </div>
                    {checks[t.id] && <div style={{ fontSize: 11, color: 'var(--color-accent)', marginTop: 3 }}>HP check: {checks[t.id]}</div>}
                    {t.id in spawns && (spawns[t.id]
                      ? <div style={{ fontSize: 11, color: 'var(--color-text3)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span>Spawn: ({spawns[t.id]!.x.toFixed(1)}, {spawns[t.id]!.y.toFixed(1)}, {spawns[t.id]!.z.toFixed(1)})</span>
                          {spawns[t.id]!.zoneId != null && (
                            <button onClick={() => navigate('/map', { state: { zoneId: spawns[t.id]!.zoneId } })}
                              className="btn btn-ghost btn-xs" style={{ fontSize: 10, padding: '2px 6px' }}>Map ↗</button>
                          )}
                        </div>
                      : <div style={{ fontSize: 11, color: 'var(--color-text3)', marginTop: 2 }}>No spawn point found</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button onClick={() => kill(t.id)} className="btn btn-ghost btn-xs" style={{ color: 'var(--color-red)' }}>Kill</button>
                    <button onClick={() => reset(t.id)} className="btn btn-ghost btn-xs">Reset</button>
                    {t.groupId && t.nmName && <button onClick={() => checkHP(t)} className="btn btn-ghost btn-xs">HP?</button>}
                    {t.groupId && t.nmName && <button onClick={() => lookupSpawn(t)} className="btn btn-ghost btn-xs" title="Lookup spawn coordinates">⊕</button>}
                    <button onClick={() => editingId === t.id ? setEditingId(null) : startEdit(t)} className="btn btn-ghost btn-xs" title="Edit timer">✎</button>
                    <button onClick={() => del(t.id)} className="btn btn-ghost btn-xs" style={{ color: 'var(--color-text3)' }}>✕</button>
                  </div>
                </div>
                {editingId === t.id && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input className="input" value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} placeholder="Name" style={{ flex: 2, fontSize: 12, padding: '5px 8px' }} />
                      <input className="input" value={editForm.zone} onChange={e => setEditForm(f => ({ ...f, zone: e.target.value }))} placeholder="Zone" style={{ flex: 1, fontSize: 12, padding: '5px 8px' }} />
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: 'var(--color-text3)', flexShrink: 0 }}>Window</span>
                      <input className="input" type="number" value={editForm.min} onChange={e => setEditForm(f => ({ ...f, min: e.target.value }))} placeholder="Min" style={{ width: 60, fontSize: 12, padding: '5px 8px' }} />
                      <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>–</span>
                      <input className="input" type="number" value={editForm.max} onChange={e => setEditForm(f => ({ ...f, max: e.target.value }))} placeholder="Max" style={{ width: 60, fontSize: 12, padding: '5px 8px' }} />
                      <span style={{ fontSize: 11, color: 'var(--color-text3)', flexShrink: 0 }}>h</span>
                      <input className="input" value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes" style={{ flex: 1, fontSize: 12, padding: '5px 8px' }} />
                      <button onClick={() => saveEdit(t)} className="btn btn-primary btn-xs">Save</button>
                      <button onClick={() => setEditingId(null)} className="btn btn-ghost btn-xs">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Import NM panel */}
      {showImport && (
        <div style={{ width: 340, borderLeft: '1px solid var(--color-border)', background: 'var(--color-surface)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflow: 'hidden' }}>
          <div style={{ padding: '11px 14px', borderBottom: '1px solid var(--color-border)', fontSize: 13, fontWeight: 700 }}>Import from NM Database</div>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input className="input" placeholder="Search NMs…" value={nmQ} onChange={e => setNmQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && searchNMs()} style={{ flex: 1 }} />
              <button onClick={searchNMs} className="btn btn-ghost btn-sm">Go</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>Min respawn</span>
              <select value={nmMinResp} onChange={e => setNmMinResp(Number(e.target.value))}
                style={{ background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '4px 8px', borderRadius: 6, fontSize: 12 }}>
                {[[1800,'30m+'],[3600,'1h+'],[7200,'2h+'],[21600,'6h+'],[43200,'12h+'],[86400,'24h+']].map(([v,l]) =>
                  <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {nmLoading && <div style={{ padding: 14, color: 'var(--color-text3)', fontSize: 12 }}>Searching…</div>}
            {!nmLoading && nmResults.length === 0 && <div style={{ padding: 14, color: 'var(--color-text3)', fontSize: 12 }}>Search to find NMs.</div>}
            {nmResults.map(nm => {
              const added = timers.some(t => t.groupId === nm.groupId);
              return (
                <div key={nm.groupId} style={{ padding: '9px 14px', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text1)' }}>{nm.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-text3)' }}>{nm.zone} · {nm.respawnMin === nm.respawnMax ? `${nm.respawnMin}h` : `${nm.respawnMin}–${nm.respawnMax}h`}</div>
                  </div>
                  <button onClick={() => importNM(nm)} disabled={added} className="btn btn-ghost btn-xs" style={{ flexShrink: 0 }}>{added ? '✓' : 'Add'}</button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
