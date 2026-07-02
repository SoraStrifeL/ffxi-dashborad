import { useEffect, useRef, useCallback } from 'react';
import { useStore } from '../store';

type MsgHandler = (type: string, data: unknown) => void;

let globalWs: WebSocket | null = null;
const handlers = new Set<MsgHandler>();

function connect(onReady: (r: boolean) => void) {
  // Read the token fresh each attempt so reconnects after logout stop cleanly
  const token = localStorage.getItem('token');
  if (!token) return;
  if (globalWs && globalWs.readyState < 2) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  globalWs = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', data: { token } }));
  };

  ws.onmessage = (e) => {
    try {
      const { type, data } = JSON.parse(e.data as string) as { type: string; data: unknown };
      if (type === 'stats' || type === 'players') onReady(true);
      handlers.forEach((h) => h(type, data));
    } catch (_) { /* ignore */ }
  };

  ws.onclose = (e) => {
    onReady(false);
    if (globalWs === ws) globalWs = null;
    // 1008 = server rejected auth (expired/invalid token) — retrying won't help;
    // a fresh login re-triggers connect via the useWS effect
    if (e.code === 1008) return;
    setTimeout(() => connect(onReady), 3000);
  };

  ws.onerror = () => ws.close();
}

export function useWS(onMessage?: MsgHandler) {
  const token    = useStore((s) => s.token);
  const setStats = useStore((s) => s.setStats);
  const setPlayers = useStore((s) => s.setPlayers);
  const setWsReady = useStore((s) => s.setWsReady);
  const handlerRef = useRef<MsgHandler | null>(null);

  const globalHandler = useCallback((type: string, data: unknown) => {
    if (type === 'stats')   setStats(data as import('../types').ServerStats);
    if (type === 'players') setPlayers(data as import('../types').Player[]);
    handlerRef.current?.(type, data);
  }, [setStats, setPlayers]);

  useEffect(() => {
    handlerRef.current = onMessage ?? null;
  }, [onMessage]);

  useEffect(() => {
    if (!token) {
      // Logged out — close the shared socket so the server drops the session
      globalWs?.close();
      globalWs = null;
      return;
    }
    handlers.add(globalHandler);
    connect(setWsReady);
    return () => { handlers.delete(globalHandler); };
  }, [token, globalHandler, setWsReady]);

  const send = useCallback((type: string, data: unknown) => {
    if (globalWs?.readyState === 1) globalWs.send(JSON.stringify({ type, data }));
  }, []);

  return { send };
}
