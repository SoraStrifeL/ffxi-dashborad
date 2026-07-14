import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setTokens } from '../../api';
import { useStore } from '../../store';
import type { LoginMessagePublic } from '../../types';

export function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [messages, setMessages] = useState<LoginMessagePublic[]>([]);
  const setToken = useStore((s) => s.setToken);
  const navigate = useNavigate();

  useEffect(() => { api.loginMessages().then(setMessages).catch(() => {}); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true); setError('');
    try {
      const { token, refreshToken } = await api.login(username, password);
      setTokens(token, refreshToken);  // persist both (access + rotating refresh)
      setToken(token);                 // update store state
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 24,
      overflowY: 'auto',
      padding: 24,
      background: 'radial-gradient(ellipse at 50% 30%, #16162a, #0a0a12)',
    }}>
      {messages.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: 360 }}>
          {messages.map((m) => (
            <div key={m.id} style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 16,
              padding: '20px 22px',
              boxShadow: '0 20px 60px rgba(0,0,0,.6)',
            }}>
              {m.imageUrl && (
                <img src={m.imageUrl} alt="" style={{ width: '100%', maxHeight: 160, objectFit: 'cover', borderRadius: 10, marginBottom: 12 }} />
              )}
              <h2 style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text1)', marginBottom: 6 }}>{m.title}</h2>
              <p style={{ fontSize: 13, color: 'var(--color-text2)', whiteSpace: 'pre-wrap', margin: 0 }}>{m.body}</p>
            </div>
          ))}
        </div>
      )}

      <div style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 16,
        padding: '36px 32px',
        width: 360,
        boxShadow: '0 20px 60px rgba(0,0,0,.6)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>⚔</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text1)', marginBottom: 4 }}>
            FFXI Dashboard
          </h1>
          <p style={{ fontSize: 12, color: 'var(--color-text3)' }}>
            Sign in with your game account
          </p>
        </div>

        <form onSubmit={submit}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text2)', marginBottom: 6, fontWeight: 500 }}>
              Username
            </label>
            <input
              className="input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              placeholder="Your game account name"
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text2)', marginBottom: 6, fontWeight: 500 }}>
              Password
            </label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div style={{ color: 'var(--color-red)', fontSize: 12, marginBottom: 12, textAlign: 'center' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', padding: '10px 16px', opacity: loading ? .6 : 1 }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
