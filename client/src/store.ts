import { create } from 'zustand';
import type { User, ServerStats, Player } from './types';

interface AppStore {
  token: string | null;
  user: User | null;
  permissions: string[];
  stats: ServerStats | null;
  players: Player[];
  wsReady: boolean;

  setToken: (t: string | null) => void;
  setUser:  (u: User | null)   => void;
  setPermissions: (p: string[]) => void;
  setStats: (s: ServerStats)   => void;
  setPlayers: (p: Player[])    => void;
  setWsReady: (r: boolean)     => void;
  logout: () => void;
}

export const useStore = create<AppStore>((set) => ({
  token:   localStorage.getItem('token'),
  user:    null,
  permissions: [],
  stats:   null,
  players: [],
  wsReady: false,

  setToken:   (token)   => { localStorage.setItem('token', token ?? ''); set({ token }); },
  setUser:    (user)    => set({ user }),
  setPermissions: (permissions) => set({ permissions }),
  setStats:   (stats)   => set({ stats }),
  setPlayers: (players) => set({ players }),
  setWsReady: (wsReady) => set({ wsReady }),
  logout: () => {
    localStorage.removeItem('token');
    set({ token: null, user: null, permissions: [], stats: null, players: [], wsReady: false });
  },
}));
