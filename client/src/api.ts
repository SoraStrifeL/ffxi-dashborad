// ── Token helpers + refresh ──────────────────────────────────────────
// Access token is short-lived; a refresh token (rotating, single-use) is
// exchanged at /api/refresh for a fresh pair. getToken() is the single
// source read everywhere (req, uploads, WS).
export function getToken(): string | null { return localStorage.getItem('token'); }
export function getRefreshToken(): string | null { return localStorage.getItem('refreshToken'); }
export function setTokens(token: string, refreshToken?: string): void {
  localStorage.setItem('token', token);
  if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
}
export function clearTokens(): void {
  localStorage.removeItem('token');
  localStorage.removeItem('refreshToken');
}

// Single-flight refresh: concurrent 401s share one /api/refresh call.
let refreshInFlight: Promise<string | null> | null = null;
export function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  const rt = getRefreshToken();
  if (!rt) return Promise.resolve(null);
  refreshInFlight = fetch('/api/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
  })
    .then(async (r) => {
      if (!r.ok) { clearTokens(); return null; }
      const body = await r.json() as { token: string; refreshToken: string };
      setTokens(body.token, body.refreshToken);
      return body.token;
    })
    .catch(() => null)
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const doFetch = (token: string | null) => fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  let res = await doFetch(getToken());
  // Access token expired/revoked → refresh once and retry.
  if (res.status === 401 && getRefreshToken()) {
    const fresh = await refreshAccessToken();
    if (fresh) res = await doFetch(fresh);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  login: (username: string, password: string) =>
    req<{ token: string; refreshToken: string }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ login: username, password }),
    }),

  // Revoke the refresh token server-side (best-effort; fire-and-forget on logout).
  logout: () => {
    const refreshToken = getRefreshToken();
    return fetch('/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {});
  },

  version: () => req<{ version: string; commit: string; buildDate: string; node: string; uptime: number }>('/api/version'),

  // Optional FFXI DAT fetcher
  datStatus: () => req<{ enabled: boolean; resources: string[]; categories: string[] }>('/api/dat/status'),
  datTable:  (cat: string, q = '', page = 0) =>
    req<{ cat: string; total: number; page: number; hasMore: boolean; rows: { id: number; name: string; description?: string }[] }>(
      `/api/dat/table/${cat}?q=${encodeURIComponent(q)}&page=${page}`),
  datDialogZones: () => req<{ zones: { id: number; name: string }[] }>('/api/dat/dialog-zones'),
  datDialog: (zone: number, q = '', page = 0) =>
    req<{ zoneId: number; total: number; page: number; hasMore: boolean; rows: { id: number; text: string }[] }>(
      `/api/dat/dialog/${zone}?q=${encodeURIComponent(q)}&page=${page}`),
  datEnrich: (cat: string, key: string | number) =>
    req<{ name: string; description: string; datId: number } | null>(
      `/api/dat/enrich/${cat}/${encodeURIComponent(String(key))}`),

  me: () => req<{ login: string; tier: 'admin' | 'player'; accid: number }>('/api/me'),
  mePermissions: () => req<{ login: string; tier: string; permissions: string[] }>('/api/me/permissions'),

  stats:   () => req<import('./types').ServerStats>('/api/stats'),
  players: () => req<import('./types').Player[]>('/api/players'),

  // All characters (same endpoint as online players, returns all with online flag)
  chars: () => req<import('./types').Player[]>('/api/players'),

  char: (id: number) => req<import('./types').CharBasic>(`/api/character/${id}`),
  charExtended: (id: number) => req<import('./types').CharExtended>(`/api/character/${id}/extended`),
  charEquipment: (id: number) => req<{ slot: number; itemId: number; name: string }[]>(`/api/character/${id}/equipment`),
  // Aggregate: basic + extended + equipment in one request (character page load)
  charFull: (id: number) => req<{
    basic: import('./types').CharBasic;
    extended: import('./types').CharExtended;
    equipment: { slot: number; itemId: number; name: string }[];
  }>(`/api/character/${id}/full`),

  maps:         ()          => req<Record<number, string[]>>('/api/maps'),
  mapImage:     (z: number, floor = 0) => `/api/map/${z}?floor=${floor}`,
  npcs:         (z: number) => req<import('./types').NpcEntry[]>(`/api/npcs/${z}`),
  mobs:         (z: number) => req<import('./types').MobEntry[]>(`/api/mobs/${z}`),
  bounds:       ()          => req<Record<number, import('./types').CalibrationBounds>>('/api/bounds'),
  calibrations: ()          => req<Record<number, import('./types').CalibrationBounds>>('/api/calibrations'),

  zones:      () => req<import('./types').Zone[]>('/api/zones'),
  dbItems:    (p: Record<string, string | number>) => req<unknown[]>(`/api/db/items?${new URLSearchParams(p as Record<string,string>)}`),
  dbNpcs:     (p: Record<string, string | number>) => req<unknown[]>(`/api/db/npcs?${new URLSearchParams(p as Record<string,string>)}`),
  dbMobs:     (p: Record<string, string | number>) => req<unknown[]>(`/api/db/mobs?${new URLSearchParams(p as Record<string,string>)}`),
  dbJobs:     () => req<unknown[]>('/api/db/jobs'),
  dbSkills:   () => req<unknown[]>('/api/db/skills'),
  dbAbilities:(p: Record<string, string | number>) => req<unknown[]>(`/api/db/abilities?${new URLSearchParams(p as Record<string,string>)}`),
  dbQuests:   (p: Record<string, string | number>) => req<unknown[]>(`/api/db/quests?${new URLSearchParams(p as Record<string,string>)}`),
  dbKeyItems: (p: Record<string, string | number>) => req<unknown[]>(`/api/db/keyitems?${new URLSearchParams(p as Record<string,string>)}`),
  dbTrusts:   () => req<unknown[]>('/api/db/trusts'),
  dbMounts:   () => req<unknown[]>('/api/db/mounts'),

  // Timers / NM tracking
  timers:      () => req<unknown[]>('/api/timers'),
  saveTimer:   (d: object) => req<{ ok: boolean; timers: unknown[] }>('/api/timers', { method: 'POST', body: JSON.stringify(d) }),
  deleteTimer: (id: string) => req<{ ok: boolean }>(`/api/timers/${id}`, { method: 'DELETE' }),
  killTimer:   (id: string) => req<{ ok: boolean }>(`/api/timers/${id}/kill`, { method: 'POST', body: JSON.stringify({}) }),
  resetTimer:  (id: string) => req<{ ok: boolean }>(`/api/timers/${id}/reset`, { method: 'POST', body: JSON.stringify({}) }),
  searchNMs:   (q: string, minRespawn = 3600) => req<unknown[]>(`/api/db/nms?q=${encodeURIComponent(q)}&minRespawn=${minRespawn}`),
  checkNM:     (groupId: number, nmName: string) => req<{ queued: boolean; id?: number }>('/api/nm/check', { method: 'POST', body: JSON.stringify({ groupId, nmName }) }),
  nmResult:    (queueId: number) => req<{ status: string; result: string | null }>(`/api/nm/result/${queueId}`),

  // Saved scripts + server file browser
  scripts:      () => req<unknown[]>('/api/scripts'),
  saveScript:   (d: object) => req<{ ok: boolean; scripts: unknown[] }>('/api/scripts', { method: 'POST', body: JSON.stringify(d) }),
  deleteScript: (id: string) => req<{ ok: boolean }>(`/api/scripts/${id}`, { method: 'DELETE' }),
  scriptBrowse: (p: string) => req<{ name: string; type: string }[]>(`/api/scriptbrowser?path=${encodeURIComponent(p)}`),
  scriptFileText: async (p: string): Promise<string> => {
    const token = getToken();
    const r = await fetch(`/api/scriptbrowser/file?path=${encodeURIComponent(p)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  },

  // Accounts management
  accounts:         () => req<unknown[]>('/api/accounts'),
  setAccountStatus: (id: number, status: 0 | 1) => req<{ ok: boolean }>(`/api/accounts/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  setAccountPriv:   (id: number, priv: number)   => req<{ ok: boolean }>(`/api/accounts/${id}/priv`,   { method: 'POST', body: JSON.stringify({ priv }) }),

  // Console Lua executor
  consoleExec:  (cmd: string) => req<{ id: number }>('/api/console', { method: 'POST', body: JSON.stringify({ cmd }) }),
  queueEntry:   (id: number) => req<{ id: number; status: string; result: string | null }>(`/api/queue/${id}`),

  // Settings – rates (fixed type: server returns array of {group,key,label,file,step,type,value})
  settings:     () => req<unknown[]>('/api/settings/rates'),
  saveSettings: (data: Record<string, unknown>) =>
    req<{ ok: boolean }>('/api/settings/rates', { method: 'POST', body: JSON.stringify(data) }),
  saveRate:     (key: string, value: unknown) => req<{ ok: boolean }>('/api/settings/rates', { method: 'POST', body: JSON.stringify({ key, value }) }),
  settingsScan: () => req<Record<string, { entries: { key: string; value: unknown; curated: boolean }[]; missing: boolean }>>('/api/settings/scan'),
  saveScanKey:  (file: string, key: string, value: unknown) => req<{ ok: boolean }>('/api/settings/scan', { method: 'POST', body: JSON.stringify({ file, key, value }) }),
  serverVars:   () => req<{ varname: string; value: number }[]>('/api/settings/variables'),
  saveServerVar: (varname: string, value: number) => req<{ ok: boolean }>('/api/settings/variables', { method: 'POST', body: JSON.stringify({ varname, value }) }),
  dashboardSettings:     () => req<Record<string, unknown>>('/api/dashboard/settings'),
  saveDashboardSettings: (d: object) => req<{ ok: boolean; settings: Record<string, unknown> }>('/api/dashboard/settings', { method: 'POST', body: JSON.stringify(d) }),

  // Character extra endpoints
  charBlobs:      (id: number) => req<Record<string, unknown>>(`/api/character/${id}/blobs`),
  charEffects:    (id: number) => req<unknown[]>(`/api/character/${id}/effects`),
  charQuestsById: (id: number) => req<unknown[]>(`/api/character/${id}/quests`),
  charVarsById:   (id: number) => req<Record<string, unknown>>(`/api/character/${id}/vars`),
  setCharVar:     (id: number, varname: string, value: unknown) => req<{ ok: boolean }>(`/api/character/${id}/setvar`, { method: 'POST', body: JSON.stringify({ varname, value }) }),

  queue:   (p: Record<string, string | number>) =>
    req<{ rows: import('./types').QueueEntry[]; hasMore: boolean }>(`/api/queue?${new URLSearchParams(p as Record<string,string>)}`),
  enqueue: (data: Record<string, unknown>) =>
    req<{ id: number }>('/api/queue', { method: 'POST', body: JSON.stringify(data) }),

  docker:       () => req<unknown>('/api/docker/status'),
  dockerAction: (containerId: string, action: string) =>
    req<{ ok: boolean }>(`/api/docker/containers/${containerId}/${action}`, { method: 'POST' }),

  ghBrowse: (path: string, branch: string) =>
    req<unknown>(`/api/github/browse?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}`),
  ghFile: (path: string, branch: string) =>
    req<{ content: string }>(`/api/github/content?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}`),

  lsbCheck:      () => req<unknown>('/api/lsb/status'),
  lsbConfig:     () => req<Record<string, unknown>>('/api/lsb/config'),
  saveLsbConfig: (d: object) => req<{ ok: boolean }>('/api/lsb/config', { method: 'POST', body: JSON.stringify(d) }),

  ghConfig:     () => req<Record<string, unknown>>('/api/github/config'),
  saveGhConfig: (d: object) => req<{ ok: boolean }>('/api/github/config', { method: 'POST', body: JSON.stringify(d) }),

  dashboardDb:        () => req<Record<string, unknown>>('/api/dashboard/db'),
  saveDashboardDb:    (d: object) => req<{ ok: boolean; restartRequired?: boolean }>('/api/dashboard/db', { method: 'POST', body: JSON.stringify(d) }),
  testDashboardDb:    (d: object) => req<{ ok: boolean; version?: string; database?: string; error?: string }>('/api/dashboard/db/test', { method: 'POST', body: JSON.stringify(d) }),
  dashboardPaths:     () => req<{ effective: Record<string,string>; saved: Record<string,string>; defaults: Record<string,string> }>('/api/dashboard/paths'),
  saveDashboardPaths: (d: object) => req<{ ok: boolean; restartRequired?: boolean }>('/api/dashboard/paths', { method: 'POST', body: JSON.stringify(d) }),

  crashLog:      () => req<unknown[]>('/api/crash-log'),
  clearCrashLog: () => req<{ ok: boolean }>('/api/crash-log', { method: 'DELETE' }),

  charInventory: (id: number) => req<unknown[]>(`/api/inventory/${id}`),

  dockerLogs:      (containerId: string, tail = 100) => req<{ lines: string[] }>(`/api/docker/containers/${containerId}/logs?tail=${tail}`),
  dockerFsBrowse:  (containerId: string, path: string) => req<{ path: string; entries: { name: string; type: string; size?: number }[] }>(`/api/docker/containers/${containerId}/fs/browse?path=${encodeURIComponent(path)}`),

  dbItemTypes: () => req<{ type: number; cnt: number }[]>('/api/db/item-types'),
  dbQuestLogs: () => req<{ logId: number; name: string; total: number; scripted: number }[]>('/api/db/quest-logs'),
  dbItemDetail:(id: number) => req<Record<string, unknown>>(`/api/db/items/${id}`),
  dbMobDetail: (name: string, zone: number) => req<Record<string, unknown>>(`/api/db/mobs/detail?name=${encodeURIComponent(name)}&zone=${zone}`),

  // Wiki lookups per DB category
  // NOTE: /api/db/items/wiki (src/routes/db.ts) reads req.query.name, but
  // this helper used to send ?id= — meaning the Items "Wiki" fetch has
  // always silently returned null. Fixed here to send the item's internal
  // `name` field (e.g. "bronze_subligar"), same convention as every other
  // dbXWiki helper below.
  dbItemWiki:  (name: string) => req<{ description?: string | null; flags?: string | null; ahCategory?: string | null; itemType?: string | null; wikiUrl?: string; cachedAt?: number } | null>(`/api/db/items/wiki?name=${encodeURIComponent(name)}`),
  dbNpcWiki:   (name: string) => req<{ description?: string; quests?: string[]; wikiUrl?: string; notFound?: boolean }>(`/api/db/npcs/wiki?name=${encodeURIComponent(name)}`),
  dbQuestWiki: (name: string) => req<{ description?: string; startNpc?: string; repeatable?: boolean; wikiUrl?: string; notFound?: boolean }>(`/api/db/quests/wiki?name=${encodeURIComponent(name)}`),
  dbAbilityWiki: (name: string) => req<{ description?: string | null; wikiUrl?: string; notFound?: boolean } | null>(`/api/db/abilities/wiki?name=${encodeURIComponent(name)}`),
  dbKeyItemWiki: (name: string) => req<{ description?: string | null; wikiUrl?: string; notFound?: boolean } | null>(`/api/db/keyitems/wiki?name=${encodeURIComponent(name)}`),
  dbZoneWiki:  (name: string) => req<{ description?: string; wikiUrl?: string; notFound?: boolean }>(`/api/db/zones/wiki?name=${encodeURIComponent(name)}`),

  // Image uploads (multipart form data)
  uploadMapImage:  (zoneId: number, file: File) => { const f = new FormData(); f.append('image', file); const token = getToken(); return fetch(`/api/upload/map/${zoneId}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: f }).then(r => r.ok ? r.json() : r.json().then((e: {error?:string}) => Promise.reject(new Error(e.error)))); },
  uploadItemImage: (itemId: number, file: File) => { const f = new FormData(); f.append('image', file); const token = getToken(); return fetch(`/api/upload/item/${itemId}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: f }).then(r => r.ok ? r.json() : r.json().then((e: {error?:string}) => Promise.reject(new Error(e.error)))); },
  uploadNpcImage:  (npcId: number, file: File) => { const f = new FormData(); f.append('image', file); const token = getToken(); return fetch(`/api/upload/npc/${npcId}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: f }).then(r => r.ok ? r.json() : r.json().then((e: {error?:string}) => Promise.reject(new Error(e.error)))); },
  uploadMobImage:  (name: string, file: File) => { const f = new FormData(); f.append('image', file); const token = getToken(); return fetch(`/api/upload/mob?name=${encodeURIComponent(name)}`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: f }).then(r => r.ok ? r.json() : r.json().then((e: {error?:string}) => Promise.reject(new Error(e.error)))); },
  uploadCheck: (type: 'item'|'npc'|'mob', id?: number, name?: string) =>
    req<{ exists: boolean; url: string | null }>(`/api/upload/check/${type}?${id != null ? `id=${id}` : `name=${encodeURIComponent(name ?? '')}`}`),

  // Map calibration save/delete
  saveCalibration:   (zoneId: number, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }) =>
    req<{ ok: boolean }>(`/api/calibrations/${zoneId}`, { method: 'POST', body: JSON.stringify(bounds) }),
  deleteCalibration: (zoneId: number) => req<{ ok: boolean }>(`/api/calibrations/${zoneId}`, { method: 'DELETE' }),

  // RoE records
  roeRecords: (q = '', type = 'all') => req<{ id: number; name: string; flags: string[]; description?: string }[]>(`/api/roe/records?q=${encodeURIComponent(q)}&type=${type}`),

  // Quest server settings
  questSettings: () => req<Record<string, unknown>>('/api/quest-settings'),

  // Bulk NM HP check
  nmCheckAll: (items: { groupId: number; nmName: string }[]) =>
    req<{ queued: boolean; id?: number; count?: number }>('/api/nm/checkall', { method: 'POST', body: JSON.stringify(items) }),

  // NM spawn point lookup (admin)
  nmSpawnpoint: (groupId: number, nmName: string) =>
    req<{ found: boolean; x?: number; y?: number; z?: number; zoneId?: number }>(`/api/nm/spawnpoint?groupId=${groupId}&nmName=${encodeURIComponent(nmName)}`),

  // All storage bags for a character (excludes main inventory)
  charBags: (charId: number) =>
    req<{ items: { location: number; slot: number; itemId: number; quantity: number; name?: string }[]; storage: Record<string, number> | null }>(`/api/character/${charId}/bags`),

  // Quest Lua script viewer (admin)
  questScript: (name: string) =>
    req<{ found: boolean; path?: string; content?: string; reason?: string }>(`/api/questscript?name=${encodeURIComponent(name)}`),

  // Recent queue entries for a character
  charRecentQueue: (charId: number) =>
    req<{ id: number; action: string; params: string; status: string; result: string | null; created_at: string; processed_at: string | null }[]>(`/api/queue/recent/${charId}`),

  // Server filesystem browser (admin, host OS dirs only)
  fsBrowse: (dirPath: string) =>
    req<{ path: string; parent: string | null; dirs: { name: string; path: string }[] }>(`/api/fs/browse?path=${encodeURIComponent(dirPath)}`),
};
