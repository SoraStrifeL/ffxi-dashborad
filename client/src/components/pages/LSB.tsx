import React, { useState, useEffect } from 'react';
import { api } from '../../api';

type LsbCommit = { sha: string; message: string; author: string; date: string };
interface LsbStatus {
  fork?: { branch?: string; sha?: string; shortSha?: string; date?: string; message?: string; error?: string };
  upstream?: { sha?: string; shortSha?: string; date?: string; message?: string };
  forkVsUpstream?: { status?: string; behindBy?: number; aheadBy?: number };
  forkMissingCommits?: LsbCommit[];
  localVsRef?: { status?: string; behindBy?: number; aheadBy?: number; comparedTo?: string };
  localMissingCommits?: LsbCommit[];
  error?: string;
}
interface LsbCfg { serverPath?: string; forkRepo?: string; upstreamRepo?: string; upstreamBranch?: string; githubToken?: string }

export function LSB() {
  const [checking,  setChecking]  = useState(false);
  const [status,    setStatus]    = useState<LsbStatus | null>(null);
  const [cfg,       setCfg]       = useState<LsbCfg>({});
  const [form,      setForm]      = useState<LsbCfg>({});
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgMsg,    setCfgMsg]    = useState('');
  const [showCfg,   setShowCfg]   = useState(false);

  useEffect(() => {
    api.lsbConfig().then(r => {
      const c = r as LsbCfg; setCfg(c);
      setForm({ serverPath: c.serverPath ?? '', forkRepo: c.forkRepo ?? '', upstreamRepo: c.upstreamRepo ?? '', upstreamBranch: c.upstreamBranch ?? '', githubToken: '' });
    }).catch(() => {});
  }, []);

  async function check() {
    setChecking(true); setStatus(null);
    try { setStatus(await api.lsbCheck() as LsbStatus); } catch (e) { setStatus({ error: (e as Error).message }); }
    setChecking(false);
  }
  async function saveCfg() {
    setSavingCfg(true); setCfgMsg('');
    try { await api.saveLsbConfig(form); setCfgMsg('Saved'); setTimeout(() => setCfgMsg(''), 3000); }
    catch (e) { setCfgMsg((e as Error).message); }
    setSavingCfg(false);
  }

  // Prefer the fork↔upstream comparison; fall back to local↔ref when no fork configured
  const cmp = status?.forkVsUpstream ?? status?.localVsRef;
  const commits = (status?.forkVsUpstream ? status?.forkMissingCommits : status?.localMissingCommits) ?? [];
  const behind = cmp?.behindBy ?? 0;

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>LandSandBoat</h1>
        <button onClick={check} disabled={checking} className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }}>
          {checking ? 'Checking…' : 'Check Updates'}
        </button>
        <button onClick={() => setShowCfg(!showCfg)} className="btn btn-ghost btn-sm">⚙ Config</button>
      </div>

      {/* Config form */}
      {showCfg && (
        <div className="card" style={{ marginBottom: 20, maxWidth: 540 }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', flex: 1 }}>LSB Config</span>
            <button onClick={saveCfg} disabled={savingCfg} className="btn btn-primary btn-sm">Save</button>
            {cfgMsg && <span style={{ fontSize: 12, color: 'var(--color-teal)' }}>{cfgMsg}</span>}
          </div>
          {([
            ['serverPath',    'Server path',     'text',     '/opt/lsb'],
            ['forkRepo',      'Fork repo',        'text',     'user/LandSandBoat'],
            ['upstreamRepo',  'Upstream repo',    'text',     'LandSandBoat/server'],
            ['upstreamBranch','Upstream branch',  'text',     'base'],
            ['githubToken',   'GitHub token',     'password', '(stored separately)'],
          ] as [keyof LsbCfg, string, string, string][]).map(([k, lbl, type, ph]) => (
            <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid rgba(42,42,61,.3)' }}>
              <span style={{ flex: '0 0 140px', fontSize: 12, color: 'var(--color-text2)' }}>{lbl}</span>
              <input type={type} value={form[k] ?? ''} placeholder={ph}
                onChange={e => setForm(p => ({ ...p, [k]: e.target.value }))}
                style={{ flex: 1, background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 5, padding: '5px 8px', fontSize: 12, fontFamily: k === 'serverPath' ? 'var(--font-mono)' : 'inherit' }} />
            </div>
          ))}
          {cfg.forkRepo && <div style={{ padding: '8px 16px', fontSize: 11, color: 'var(--color-text3)' }}>Repo: {cfg.forkRepo} · Branch: {cfg.upstreamBranch || 'base'}</div>}
        </div>
      )}

      {/* Status error */}
      {status?.error && <div style={{ color: 'var(--color-red)', marginBottom: 16, fontSize: 13 }}>{status.error}</div>}

      {/* Status cards */}
      {status && !status.error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {/* Fork */}
            {status.fork && (
              <div className="card" style={{ padding: '14px 18px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', marginBottom: 8 }}>Your Fork</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-accent)', marginBottom: 4 }}>{status.fork.shortSha}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text1)', marginBottom: 2 }}>{status.fork.message}</div>
                <div style={{ fontSize: 11, color: 'var(--color-text3)' }}>{status.fork.branch} · {status.fork.date ? new Date(status.fork.date).toLocaleDateString() : ''}</div>
              </div>
            )}
            {/* Upstream */}
            {status.upstream && (
              <div className="card" style={{ padding: '14px 18px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', marginBottom: 8 }}>Upstream (LSB)</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-teal)', marginBottom: 4 }}>{status.upstream.shortSha}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text1)', marginBottom: 2 }}>{status.upstream.message}</div>
                <div style={{ fontSize: 11, color: 'var(--color-text3)' }}>{status.upstream.date ? new Date(status.upstream.date).toLocaleDateString() : ''}</div>
              </div>
            )}
          </div>

          {/* Comparison summary */}
          {cmp && (
            <div className="card" style={{ padding: '12px 18px' }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: behind > 0 ? 12 : 0 }}>
                <span className={`pill ${behind === 0 ? 'pill-teal' : 'pill-red'}`}>{cmp.status}</span>
                {behind > 0 && <span style={{ fontSize: 13, color: 'var(--color-red)' }}>{behind} commit{behind !== 1 ? 's' : ''} behind upstream</span>}
                {(cmp.aheadBy ?? 0) > 0 && <span style={{ fontSize: 13, color: 'var(--color-gold)' }}>{cmp.aheadBy} ahead</span>}
                {behind === 0 && <span style={{ fontSize: 13, color: 'var(--color-teal)' }}>Up to date</span>}
              </div>
              {commits.length > 0 && (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text3)', marginBottom: 6 }}>Upstream commits ahead</div>
                  {commits.map(c => (
                    <div key={c.sha} style={{ display: 'flex', gap: 10, padding: '5px 0', borderBottom: '1px solid rgba(42,42,61,.3)', fontSize: 12 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-accent)', flexShrink: 0, width: 54 }}>{c.sha}</span>
                      <span style={{ flex: 1, color: 'var(--color-text1)' }}>{c.message}</span>
                      <span style={{ color: 'var(--color-text3)', fontSize: 11, flexShrink: 0 }}>{c.author}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!checking && !status && (
        <div style={{ color: 'var(--color-text3)', fontSize: 13 }}>
          Configure your fork and upstream repos in ⚙ Config, then click Check Updates.
        </div>
      )}
    </div>
  );
}
