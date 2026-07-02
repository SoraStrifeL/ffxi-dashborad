import { create } from 'zustand';
import type { User, ServerStats, Player } from './types';

interface AppStore {
  token: string | null;
  user: User | null;
  stats: ServerStats | null;
  players: Player[];
  wsReady: boolean;

  setToken: (t: string | null) => void;
  setUser:  (u: User | null)   => void;
  setStats: (s: ServerStats)   => void;
  setPlayers: (p: Player[])    => void;
  setWsReady: (r: boolean)     => void;
  logout: () => void;
}

export const useStore = create<AppStore>((set) => ({
  token:   localStorage.getItem('token'),
  user:    null,
  stats:   null,
  players: [],
  wsReady: false,

  setToken:   (token)   => { localStorage.setItem('token', token ?? ''); set({ token }); },
  setUser:    (user)    => set({ user }),
  setStats:   (stats)   => set({ stats }),
  setPlayers: (players) => set({ players }),
  setWsReady: (wsReady) => set({ wsReady }),
  logout: () => {
    localStorage.removeItem('token');
    set({ token: null, user: null, stats: null, players: [], wsReady: false });
  },
}));
