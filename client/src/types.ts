export interface User {
  login: string;
  tier: 'admin' | 'player';
  accid: number;
}

// Shape of queryStats() — broadcast as the WS 'stats' message and /api/stats
export interface ServerStats {
  online_players: number;
  total_players: number;
  total_accounts: number;
  total_zones?: number;
}

// Shape returned by /api/players (queryPlayers) — also used in WS 'players' broadcast
export interface Player {
  charid: number;
  charname: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  pos_zone: number;
  zone_name?: string;
  gmlevel: number;
  nation: number;
  playtime?: number;
  last_logout?: number;
  // DB field names from char_stats
  mjob: number;  // main job
  mlvl: number;  // main job level
  sjob: number;  // sub job
  slvl: number;  // sub job level
  hp: number;    // max HP (char_stats)
  mp: number;    // max MP (char_stats)
  online?: boolean | number;
  race?: number; // not in queryPlayers; present after char detail fetch
}

// Shape returned by /api/character/:charid
export interface CharBasic {
  charid: number;
  charname: string;
  pos_zone: number;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  gmlevel: number;
  nation: number;
  playtime: number;
  timecreated: number;
  last_logout: number;
  accid: number;
  home_zone: number;
  home_x: number;
  home_y: number;
  home_z: number;
  zone_name: string;
  home_zone_name: string;
  prev_zone_name: string;
  mentor: number;
  job_master: number;
  moghancement: number;
  moghancement_name: string | null;
  mjob: number;
  mlvl: number;
  sjob: number;
  slvl: number;
  hp: number;
  mp: number;
  race: number;
  char_size: number;
  face: number;
  genkai: number;
  // job levels from char_jobs
  war: number; mnk: number; whm: number; blm: number; rdm: number; thf: number;
  pld: number; drk: number; bst: number; brd: number; rng: number; sam: number;
  nin: number; drg: number; smn: number; blu: number; cor: number; pup: number;
  dnc: number; sch: number; geo: number; run: number;
  account_login: string;
  account_status: number;
  account_priv: number;
  online: boolean | number;
  gil: number;
  gear_hp: number;
  gear_mp: number;
}

// Shape returned by /api/character/:charid/extended
export interface CharExtended {
  exp: Record<string, number> | null;
  history: {
    enemies_defeated?: number;
    times_knocked_out?: number;
    battles_fought?: number;
    spells_cast?: number;
    abilities_used?: number;
    ws_used?: number;
    items_used?: number;
    npc_interactions?: number;
    chats_sent?: number;
    distance_travelled?: number;
    [key: string]: number | undefined;
  } | null;
  profile: Record<string, number | string> | null;
  points: Record<string, number> | null;
  skills: Skill[];
  flags: { gmModeEnabled?: boolean; gmHiddenEnabled?: boolean; muted?: boolean } | null;
  job_points: { jobid: number; capacity_points: number; job_points: number; job_points_spent: number }[];
  merits: { meritid: number; upgrades: number; name: string }[];
  spells: { spellid: number; name: string; group: number; groupName: string }[];
  pet: Record<string, unknown> | null;
  chocobo: Record<string, unknown> | null;
  unlocks: Record<string, unknown> | null;
  storage: { inventory?: number; safe?: number; locker?: number; satchel?: number; sack?: number; case?: number; wardrobe?: number } | null;
  bag_counts: { location: number; count: number }[];
  vars: { varname: string; value: number }[];
  expPerLevel: number[];
}

// Skill shape from /api/character/:charid/extended
export interface Skill {
  skillid: number;
  value: number;  // current skill value
  rank: number;   // skill rank (0-13)
  cap: number;    // cap for current rank/level
}

export interface ZonePlayer {
  charid: number;
  charname: string;
  pos_x: number;
  pos_z: number;
  hp: number;
  mp: number;
  mjob: number;
  mlvl: number;
}

export interface PosEntry {
  i: number;
  n: string;
  x: number;
  y: number;
  z: number;
  z_id: number;
  b?: number;
}

export interface MobEntry {
  mobid: number;
  name: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  aggro: number;
  links: number;
  mJob: number;
  ecosystem: number;
  family: number;
  detects: number;
}

export interface NpcEntry {
  npcid: number;
  name: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
}

export interface LoginMessage {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  active: boolean;
  createdAt: number;
}

export type LoginMessagePublic = Pick<LoginMessage, 'id' | 'title' | 'body' | 'imageUrl'>;

export interface CalibrationBounds {
  minX: number; maxX: number; minZ: number; maxZ: number;
}

export interface PopEntry {
  name: string;
  mobid: number;
  pos_x: number;
  pos_z: number;
  ts: number;
  watched: boolean;
}

export interface EvtTriggerDef {
  id: number;
  name: string;
  mob: string;
  minMin: number;
  maxMin: number | null;
}

export interface EvtTimer {
  id: number;
  trigId: number;
  name: string;
  reason: string;
  startTs: number;
  minMs: number;
  maxMs: number | null;
  alerted: boolean;
}

export interface DbItem {
  itemid: number;
  name: string;
  sortname: string;
  type: number;
  flags: number;
  stack: number;
  jobs: number;
  slot: number;
  skill: number;
  [key: string]: unknown;
}

export interface Zone {
  zoneid: number;
  name: string;
  region: number;
}

export interface QueueEntry {
  id: number;
  charid: number;
  action: string;
  status: string;
  result: string | null;
  requested_by: string;
  created_at: string;
  processed_at: string | null;
}
