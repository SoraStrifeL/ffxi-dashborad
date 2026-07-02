import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import { useWS } from '../../hooks/useWS';
import type { Player } from '../../types';

const JOB_ABBR = ['','WAR','MNK','WHM','BLM','RDM','THF','PLD','DRK','BST','BRD','RNG','SAM','NIN','DRG','SMN','BLU','COR','PUP','DNC','SCH','GEO','RUN'];

function OnlineCard({ p }: { p: Player }) {
  const navigate = useNavigate();
  const job = `${JOB_ABBR[p.mjob] ?? '?'}${p.mlvl}${p.sjob ? `/${JOB_ABBR[p.sjob] ?? '?'}${p.slvl}` : ''}`;

  return (
    <div
      onClick={() => navigate(`/chars/${p.charid}`)}
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderLeft: '3px solid var(--color-teal)',
        borderRadius: 10,
        padding: '14px 16px',
        cursor: 'pointer',
        transition: 'border-color .12s, background .12s',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface2)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ flex: 1, fontWeight: 700, fontSize: 14, color: 'var(--color-text1)' }}>
          {p.charname}
          {p.gmlevel > 0 && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--color-gold)', fontWeight: 600 }}>GM</span>}
        </div>
        <span className="pill pill-accent" style={{ fontSize: 10 }}>{job}</span>
      </div>

      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--color-text3)', marginTop: 4 }}>
        <span>HP <span style={{ color: 'var(--color-teal)', fontWeight: 600 }}>{p.hp}</span></span>
        <span>MP <span style={{ color: '#6aa0f0', fontWeight: 600 }}>{p.mp}</span></span>
        {p.zone_name && <span style={{ marginLeft: 'auto', color: 'var(--color-text3)' }}>{p.zone_name}</span>}
      </div>
    </div>
  );
}

export function Dashboard() {
  const stats   = useStore((s) => s.stats);
  const players = useStore((s) => s.players);
  const wsReady = useStore((s) => s.wsReady);

  useWS();

  const online = players.filter((p) => p.online);

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text1)' }}>Dashboard</h1>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          fontSize: 11, color: wsReady ? 'var(--color-teal)' : 'var(--color-text3)',
        }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: wsReady ? 'var(--color-teal)' : 'var(--color-text3)' }} />
          {wsReady ? 'Live' : 'Connecting…'}
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14, marginBottom: 28 }}>
        <StatCard value={stats?.online ?? '—'} label="Online" color="var(--color-teal)" />
        <StatCard value={stats?.total_chars ?? '—'} label="Characters" color="var(--color-accent)" />
        <StatCard value={stats?.total_accounts ?? '—'} label="Accounts" color="var(--color-text2)" />
        {(stats?.total_zones ?? 0) > 0 && <StatCard value={stats!.total_zones!} label="Zones" color="var(--color-gold)" />}
        {stats?.version && <StatCard value={stats.version} label="DB Version" color="var(--color-text3)" small />}
      </div>

      {/* Online players */}
      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text1)' }}>Online Players</h2>
        {online.length > 0 && (
          <span className="pill pill-teal">{online.length}</span>
        )}
      </div>

      {online.length === 0 ? (
        <div style={{ color: 'var(--color-text3)', fontSize: 13, padding: '20px 0' }}>
          No players online
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
          {online.map((p) => <OnlineCard key={p.charid} p={p} />)}
        </div>
      )}
    </div>
  );
}

function StatCard({ value, label, color, small }: { value: string | number; label: string; color: string; small?: boolean }) {
  return (
    <div className="stat-card">
      <div className="stat-card-value" style={{ color, fontSize: small ? 16 : 28 }}>{value}</div>
      <div className="stat-card-label">{label}</div>
    </div>
  );
}
