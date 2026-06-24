import { Pool } from 'mysql2/promise';

export type AppPool = Pool;

export interface AuthUser {
  accid: number;
  tier: 'admin' | 'player';
  login: string;
  iat: number;
  exp: number;
}

export interface WsClientState {
  user: AuthUser;
  logSub: string | null;
  watchZone: number | null;
}

export interface WindowerPosition {
  name: string;
  zone: number;
  x: number;
  y: number;
  z: number;
  map_index: number;
  hp: number;
  mp: number;
  tp: number;
  ts: number;
}

export interface ZoneEntity {
  id: number;
  index: number;
  name: string;
  x: number;
  y: number;
  z: number;
  spawn_type: string;
  model_id: number;
}

// Extend Express Request to include user and upload helpers
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    _uploadFilename?: string;
  }
}
