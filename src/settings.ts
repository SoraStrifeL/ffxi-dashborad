import fs from 'fs';
import path from 'path';
import { LSB_SETTINGS_DIR } from './catalog';

export const SETTINGS_DIR = LSB_SETTINGS_DIR;

export interface RateCatalogEntry {
  group: string;
  key: string;
  label: string;
  file: string;
  step?: number;
  type?: string;
  value?: number | boolean | null;
}

export const RATE_CATALOG: RateCatalogEntry[] = [
  // Experience
  { group: 'Experience',        key: 'EXP_RATE',                   label: 'EXP Rate (script)',          file: 'main.lua',  step: 1    },
  { group: 'Experience',        key: 'BOOK_EXP_RATE',              label: 'FoV/GoV Book EXP',           file: 'main.lua',  step: 0.1  },
  { group: 'Experience',        key: 'ROE_EXP_RATE',               label: 'RoE EXP',                    file: 'main.lua',  step: 0.1  },
  { group: 'Experience',        key: 'CAPACITY_RATE',              label: 'Capacity Points',            file: 'main.lua',  step: 0.1  },
  { group: 'Experience',        key: 'TABS_RATE',                  label: 'FoV Tabs',                   file: 'main.lua',  step: 0.1  },
  { group: 'Experience',        key: 'SPARKS_RATE',                label: 'Sparks of Eminence',         file: 'main.lua',  step: 0.1  },
  // Economy
  { group: 'Economy',           key: 'GIL_RATE',                   label: 'Quest Gil',                  file: 'main.lua',  step: 0.1  },
  { group: 'Economy',           key: 'BAYLD_RATE',                 label: 'Bayld',                      file: 'main.lua',  step: 0.1  },
  { group: 'Economy',           key: 'SHOP_PRICE',                 label: 'NPC Shop Prices',            file: 'main.lua',  step: 0.1  },
  // Drops & Mob Gil
  { group: 'Drops & Mob Gil',   key: 'DROP_RATE_MULTIPLIER',       label: 'Drop Rate',                  file: 'map.lua',   step: 0.1  },
  { group: 'Drops & Mob Gil',   key: 'MOB_GIL_MULTIPLIER',         label: 'Mob Gil',                    file: 'map.lua',   step: 0.1  },
  { group: 'Drops & Mob Gil',   key: 'ALL_MOBS_GIL_BONUS',         label: 'Flat Gil Bonus',             file: 'map.lua',   step: 1    },
  // Skills & Crafting
  { group: 'Skills & Crafting', key: 'SKILLUP_CHANCE_MULTIPLIER',  label: 'Skill-up Chance',            file: 'map.lua',   step: 0.1  },
  { group: 'Skills & Crafting', key: 'SKILLUP_AMOUNT_MULTIPLIER',  label: 'Skill-up Amount',            file: 'map.lua',   step: 0.1  },
  { group: 'Skills & Crafting', key: 'CRAFT_CHANCE_MULTIPLIER',    label: 'Craft Skill-up Chance',      file: 'map.lua',   step: 0.1  },
  { group: 'Skills & Crafting', key: 'CRAFT_AMOUNT_MULTIPLIER',    label: 'Craft Skill-up Amount',      file: 'map.lua',   step: 0.1  },
  { group: 'Skills & Crafting', key: 'CRAFT_HQ_CHANCE_MULTIPLIER', label: 'Craft HQ Chance',            file: 'map.lua',   step: 0.1  },
  { group: 'Skills & Crafting', key: 'FAME_MULTIPLIER',            label: 'Fame',                       file: 'map.lua',   step: 0.1  },
  { group: 'Skills & Crafting', key: 'FISHING_SKILL_MULTIPLIER',   label: 'Fishing Skill-up',           file: 'map.lua',   step: 0.1  },
  // Gathering
  { group: 'Gathering',         key: 'HARVESTING_RATE',            label: 'Harvesting (%)',             file: 'main.lua',  step: 1    },
  { group: 'Gathering',         key: 'EXCAVATION_RATE',            label: 'Excavation (%)',             file: 'main.lua',  step: 1    },
  { group: 'Gathering',         key: 'LOGGING_RATE',               label: 'Logging (%)',                file: 'main.lua',  step: 1    },
  { group: 'Gathering',         key: 'MINING_RATE',                label: 'Mining (%)',                 file: 'main.lua',  step: 1    },
  { group: 'Gathering',         key: 'DIGGING_RATE',               label: 'Chocobo Digging (%)',        file: 'main.lua',  step: 1    },
  // Death Penalties
  { group: 'Death Penalties',   key: 'EXP_LOSS_RATE',              label: 'EXP Loss Rate',              file: 'map.lua',   step: 0.1  },
  { group: 'Death Penalties',   key: 'EXP_RETAIN',                 label: 'EXP Retained on Death (%)', file: 'map.lua',   step: 1    },
  { group: 'Death Penalties',   key: 'EXP_LOSS_LEVEL',             label: 'Min Level for EXP Loss',     file: 'map.lua',   step: 1    },
  // Player
  { group: 'Player',            key: 'BASE_SPEED',                 label: 'Base Movement Speed',        file: 'map.lua',   step: 1    },
  { group: 'Player',            key: 'SPEED_LIMIT',                label: 'Speed Cap',                  file: 'map.lua',   step: 1    },
  { group: 'Player',            key: 'MOUNT_SPEED',                label: 'Mount Speed',                file: 'map.lua',   step: 1    },
  { group: 'Player',            key: 'PLAYER_TP_MULTIPLIER',       label: 'Player TP',                  file: 'map.lua',   step: 0.1  },
  { group: 'Player',            key: 'ABILITY_RECAST_MULTIPLIER',  label: 'Ability Recast',             file: 'map.lua',   step: 0.1  },
  // Mobs
  { group: 'Mobs',              key: 'MOB_HP_MULTIPLIER',          label: 'Mob HP',                     file: 'map.lua',   step: 0.1  },
  { group: 'Mobs',              key: 'MOB_MP_MULTIPLIER',          label: 'Mob MP',                     file: 'map.lua',   step: 0.1  },
  { group: 'Mobs',              key: 'MOB_STAT_MULTIPLIER',        label: 'Mob Stats',                  file: 'map.lua',   step: 0.1  },
  { group: 'Mobs',              key: 'MOB_TP_MULTIPLIER',          label: 'Mob TP',                     file: 'map.lua',   step: 0.1  },
  { group: 'Mobs',              key: 'MOB_RUN_SPEED_MULTIPLIER',   label: 'Mob Run Speed',              file: 'map.lua',   step: 0.1  },
  // NM
  { group: 'NM',                key: 'NM_HP_MULTIPLIER',           label: 'NM HP',                      file: 'map.lua',   step: 0.1  },
  { group: 'NM',                key: 'NM_MP_MULTIPLIER',           label: 'NM MP',                      file: 'map.lua',   step: 0.1  },
  { group: 'NM',                key: 'NM_STAT_MULTIPLIER',         label: 'NM Stats',                   file: 'map.lua',   step: 0.1  },
  // Trust / Alter Ego
  { group: 'Trust / Alter Ego', key: 'ALTER_EGO_HP_MULTIPLIER',    label: 'Alter Ego HP',               file: 'map.lua',   step: 0.1  },
  { group: 'Trust / Alter Ego', key: 'ALTER_EGO_MP_MULTIPLIER',    label: 'Alter Ego MP',               file: 'map.lua',   step: 0.1  },
  { group: 'Trust / Alter Ego', key: 'ALTER_EGO_STAT_MULTIPLIER',  label: 'Alter Ego Stats',            file: 'map.lua',   step: 0.1  },
  { group: 'Trust / Alter Ego', key: 'ALTER_EGO_SKILL_MULTIPLIER', label: 'Alter Ego Skills',           file: 'map.lua',   step: 0.1  },
  { group: 'Trust / Alter Ego', key: 'PET_TP_MULTIPLIER',          label: 'Pet TP',                     file: 'map.lua',   step: 0.1  },
  { group: 'Trust / Alter Ego', key: 'FELLOW_TP_MULTIPLIER',       label: 'Fellow TP',                  file: 'map.lua',   step: 0.1  },
  // Auction House
  { group: 'Auction House',     key: 'AH_BASE_FEE_SINGLE',         label: 'Base Fee (Single)',          file: 'map.lua',   step: 1    },
  { group: 'Auction House',     key: 'AH_BASE_FEE_STACKS',         label: 'Base Fee (Stacks)',          file: 'map.lua',   step: 1    },
  { group: 'Auction House',     key: 'AH_TAX_RATE_SINGLE',         label: 'Tax Rate (Single)',          file: 'map.lua',   step: 0.1  },
  { group: 'Auction House',     key: 'AH_TAX_RATE_STACKS',         label: 'Tax Rate (Stacks)',          file: 'map.lua',   step: 0.1  },
  { group: 'Auction House',     key: 'AH_MAX_FEE',                 label: 'Max Fee',                    file: 'map.lua',   step: 100  },
  { group: 'Auction House',     key: 'AH_LIST_LIMIT',              label: 'Listing Limit',              file: 'map.lua',   step: 1    },
  // Zone
  { group: 'Zone',              key: 'ZONE_PLAYER_CAP',            label: 'Player Cap per Zone',        file: 'map.lua',   step: 1    },
  { group: 'Zone',              key: 'ZONE_PLAYER_GM_RESERVED',    label: 'GM Reserved Slots',          file: 'map.lua',   step: 1    },
  // Server Control
  { group: 'Server Control',    key: 'MAINT_MODE',                 label: 'Maintenance Mode',           file: 'login.lua', step: 1    },
  { group: 'Server Control',    key: 'LOGIN_LIMIT',                label: 'Login Limit (0 = off)',      file: 'login.lua', step: 1    },
  { group: 'Server Control',    key: 'VER_LOCK',                   label: 'Version Lock',               file: 'login.lua', step: 1    },
  { group: 'Server Control',    key: 'ACCOUNT_CREATION',           label: 'Account Creation',           file: 'login.lua', type: 'bool' },
  { group: 'Server Control',    key: 'CHARACTER_CREATION',         label: 'Character Creation',         file: 'login.lua', type: 'bool' },
  { group: 'Server Control',    key: 'CHARACTER_DELETION',         label: 'Character Deletion',         file: 'login.lua', type: 'bool' },
];

export function readRate(content: string, key: string, type?: string): number | boolean | null {
  if (type === 'bool') {
    const m = content.match(new RegExp(`\\b${key}\\s*=\\s*(true|false)`));
    return m ? m[1] === 'true' : null;
  }
  const m = content.match(new RegExp(`\\b${key}\\s*=\\s*(-?[\\d.]+)`));
  return m ? parseFloat(m[1]) : null;
}

export function writeRate(content: string, key: string, value: unknown, type?: string): string {
  if (type === 'bool') {
    return content.replace(new RegExp(`(\\b${key}\\s*=\\s*)(?:true|false)`), `$1${value}`);
  }
  return content.replace(new RegExp(`(\\b${key}\\s*=\\s*)-?[\\d.]+`), `$1${value}`);
}

export const SCAN_FILES = ['main.lua', 'map.lua', 'login.lua'];

// ── Dashboard settings ────────────────────────────────────────────────────────
const DASHBOARD_SETTINGS_PATH = path.join(__dirname, '..', 'data', 'dashboard.json');

export interface DashboardSettings {
  serverName: string;
  motd: string;
  autoSwitchZone: boolean;
  autologin: boolean;
}

const DASHBOARD_DEFAULTS: DashboardSettings = {
  serverName: 'FFXI Dashboard',
  motd: '',
  autoSwitchZone: true,
  autologin: process.env.AUTOLOGIN === 'true',
};

export function loadDashboardSettings(): DashboardSettings {
  try {
    return { ...DASHBOARD_DEFAULTS, ...JSON.parse(fs.readFileSync(DASHBOARD_SETTINGS_PATH, 'utf8')) };
  } catch (_) {
    return { ...DASHBOARD_DEFAULTS };
  }
}

export function saveDashboardSettings(s: DashboardSettings): void {
  fs.writeFileSync(DASHBOARD_SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8');
}
export const CURATED_KEYS = new Set(RATE_CATALOG.map(e => e.key));

export function scanSettingsFile(file: string): { entries: Array<{ key: string; value: unknown; curated: boolean }>; missing: boolean } {
  const entries: Array<{ key: string; value: unknown; curated: boolean }> = [];
  const tryPaths = [path.join(SETTINGS_DIR, file), path.join(SETTINGS_DIR, 'default', file)];
  let content = '';
  for (const p of tryPaths) {
    try { content = fs.readFileSync(p, 'utf8'); break; } catch (_) {}
  }
  if (!content) return { entries, missing: true };
  const re = /^\s*([A-Z][A-Z0-9_]+)\s*=\s*([^,\n]+)/gm;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = m[2].replace(/--[^\n]*$/, '').replace(/,\s*$/, '').trim();
    let value: unknown;
    if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (raw !== '' && !isNaN(Number(raw))) value = parseFloat(raw);
    else continue; // skip strings, tables, and anything non-scalar
    entries.push({ key, value, curated: CURATED_KEYS.has(key) });
  }
  return { entries, missing: false };
}
