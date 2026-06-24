import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

const DB_CONFIG_FILE = path.join(__dirname, '..', 'data', 'db-config.json');

export interface DbConfig {
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASS: string;
  DB_NAME: string;
}

const DB_DEFAULTS: DbConfig = {
  DB_HOST: 'localhost',
  DB_PORT: 3306,
  DB_USER: 'xiadmin',
  DB_PASS: 'changeme',
  DB_NAME: 'xidb',
};

export function loadDbConfig(): DbConfig {
  let saved: Partial<DbConfig> = {};
  try { saved = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8')); } catch (_) {}
  return {
    DB_HOST: saved.DB_HOST || process.env.DB_HOST || DB_DEFAULTS.DB_HOST,
    DB_PORT: saved.DB_PORT ? Number(saved.DB_PORT) : parseInt(process.env.DB_PORT || '') || DB_DEFAULTS.DB_PORT,
    DB_USER: saved.DB_USER || process.env.DB_USER || DB_DEFAULTS.DB_USER,
    DB_PASS: saved.DB_PASS || process.env.DB_PASS || DB_DEFAULTS.DB_PASS,
    DB_NAME: saved.DB_NAME || process.env.DB_NAME || DB_DEFAULTS.DB_NAME,
  };
}

export function saveDbConfig(cfg: Partial<DbConfig>): void {
  let current: Partial<DbConfig> = {};
  try { current = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8')); } catch (_) {}
  const updated = { ...current, ...cfg };
  // Remove keys that match env/default so the file stays minimal
  for (const k of Object.keys(updated) as (keyof DbConfig)[]) {
    const envVal = process.env[k] || String(DB_DEFAULTS[k]);
    if (String(updated[k]) === envVal) delete updated[k];
  }
  fs.mkdirSync(path.dirname(DB_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(DB_CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf8');
}

export { DB_CONFIG_FILE };

const cfg = loadDbConfig();

export const pool = mysql.createPool({
  host:                  cfg.DB_HOST,
  port:                  cfg.DB_PORT,
  user:                  cfg.DB_USER,
  password:              cfg.DB_PASS,
  database:              cfg.DB_NAME,
  waitForConnections:    true,
  connectionLimit:       10,
  queueLimit:            0,
  enableKeepAlive:       true,
  keepAliveInitialDelay: 0,
});
