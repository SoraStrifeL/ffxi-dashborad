import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as PIXI from 'pixi.js';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useWS } from '../../hooks/useWS';
import { useStore } from '../../store';
import type { MobEntry, NpcEntry, PosEntry, Zone, CalibrationBounds, PopEntry, EvtTriggerDef, EvtTimer } from '../../types';

// ── Constants ─────────────────────────────────────────────────────────────────
const ECOSYSTEM_COLOR: Record<number, number> = {1:0x96cc3a,2:0xd4823a,3:0x3acc7a,4:0x3a8adc,5:0x5ab83a,6:0x9868d8,7:0xd8386a,8:0x3ac8a8,9:0xd838d0,10:0x7898b8,11:0xd8a838};
const DETECT_LABELS: Record<number, string> = {1:'Sight',2:'Sound',4:'Magic',8:'LowHP',16:'Asleep',32:'TP',64:'Blood',256:'Scent'};
const JOB = ['','WAR','MNK','WHM','BLM','RDM','THF','PLD','DRK','BST','BRD','RNG','SAM','NIN','DRG','SMN','BLU','COR','PUP','DNC','SCH','GEO','RUN'];
const POP_RING_TTL = 30000;

function detectStr(d: number) { return Object.entries(DETECT_LABELS).filter(([b]) => d & Number(b)).map(([,l]) => l).join(' · '); }
function fmtDur(ms: number) {
  const s = Math.round(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return ss > 0 ? `${m}m ${ss}s` : `${m}m`;
  return `${ss}s`;
}
function esc(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

type Layers = {players:boolean;npcs:boolean;mobs:boolean;bounds:boolean;aggroonly:boolean;labels:boolean;offlineplayers:boolean;hidezero:boolean;grid:boolean};

// ── Pixi map hook ─────────────────────────────────────────────────────────────
function usePixi(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const appRef    = useRef<PIXI.Application | null>(null);
  const layersRef = useRef<{player: PIXI.Container; npc: PIXI.Container; mob: PIXI.Container; overlay: PIXI.Container} | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const app = new PIXI.Application({
      view: canvas,
      backgroundAlpha: 0,
      width:  parent.clientWidth  || 800,
      height: parent.clientHeight || 600,
    });

    // Pan/zoom is applied directly to app.stage — no intermediate container needed
    app.stage.sortableChildren = true;

    const playerLayer  = new PIXI.Container(); playerLayer.zIndex  = 3;
    const npcLayer     = new PIXI.Container(); npcLayer.zIndex     = 2;
    const mobLayer     = new PIXI.Container(); mobLayer.zIndex     = 1;
    const overlayLayer = new PIXI.Container(); overlayLayer.zIndex = 4;
    app.stage.addChild(playerLayer, npcLayer, mobLayer, overlayLayer);

    layersRef.current = { player: playerLayer, npc: npcLayer, mob: mobLayer, overlay: overlayLayer };
    appRef.current    = app;

    // Manual resize observer — avoids Pixi's resizeTo which can fire after unmount
    const ro = new ResizeObserver(() => {
      if (!appRef.current || !parent.isConnected) return;
      appRef.current.renderer.resize(parent.clientWidth, parent.clientHeight);
    });
    ro.observe(parent);

    return () => {
      ro.disconnect();
      app.destroy(false);
      appRef.current    = null;
      layersRef.current = null;
    };
  }, [canvasRef]);

  return { appRef, layersRef };
}

// ── Map page ──────────────────────────────────────────────────────────────────
export function MapPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [zones, setZones] = useState<Zone[]>([]);
  const [zone, setZone]   = useState<number | null>(null);
  const [floor, setFloor] = useState(0);
  const floorRef = useRef(0);
  const [floorCount, setFloorCount] = useState(1);
  const [mapsAvail, setMapsAvail]   = useState<Record<number, number>>({});
  const [bounds, setBounds]  = useState<Record<number, CalibrationBounds>>({});
  const [dbMobs, setDbMobs]  = useState<MobEntry[]>([]);
  const [dbNpcs, setDbNpcs]  = useState<NpcEntry[]>([]);
  const [layers, setLayers]  = useState<Layers>({ players:true, npcs:true, mobs:true, bounds:false, aggroonly:false, labels:false, offlineplayers:false, hidezero:false, grid:false });
  const [detectFilter, setDetectFilter] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [calForm, setCalForm] = useState({ minX: -512, maxX: 512, minZ: -512, maxZ: 512 });
  const [calSaving, setCalSaving] = useState(false);
  const [calMsg, setCalMsg] = useState("");
  const [dbBounds, setDbBounds] = useState<Record<number, CalibrationBounds>>({});
  type Anchor = { cx: number; cy: number; wx: string; wz: string; pixelSet?: boolean };
  const [calAnchorA, setCalAnchorA] = useState<Anchor | null>(null);
  const [calAnchorB, setCalAnchorB] = useState<Anchor | null>(null);
  const [showOrigin, setShowOrigin] = useState(false);
  const showOriginRef = useRef(false);
  const [gridOffsetX, setGridOffsetX] = useState(0);
  const [gridOffsetZ, setGridOffsetZ] = useState(0);
  const gridOffsetXRef = useRef(0);
  const gridOffsetZRef = useRef(0);
  const [calCapture, setCalCapture] = useState<'A' | 'B' | null>(null);
  const [calScale, setCalScale] = useState('1'); // world units per native map pixel
  const [mapUploadMsg, setMapUploadMsg] = useState('');
  const mapUploadRef = useRef<HTMLInputElement>(null);
  const user = useStore((s) => s.user);
  const allPlayers = useStore((s) => s.players);
  const wsReady = useStore((s) => s.wsReady);
  const [entitySearch, setEntitySearch] = useState('');
  const entitySearchRef = useRef('');
  const [zoneSearch, setZoneSearch] = useState('');
  const zonePlayersRef  = useRef<unknown[]>([]);
  const offlineZonePlayersRef = useRef<unknown[]>([]);

  // Live data — sidebar list derived from global players store; WS zone_players overrides with fresher positions
  const [zonePlayers, setZonePlayers] = useState<unknown[]>([]);
  const [popLog, setPopLog]   = useState<PopEntry[]>([]);
  const recentPopsRef = useRef<Map<number, { ts: number; pos_x: number; pos_z: number; name: string; watched: boolean }>>(new Map());
  const prevMobIdsRef = useRef<Set<number>>(new Set());
  const prevMobNamesRef = useRef<Map<number, string>>(new Map());
  const mobStaticMapRef = useRef<Map<number, Partial<MobEntry>>>(new Map());

  // Toast
  const [toast, setToast] = useState<{ msg: string; color: string; x?: number; z?: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Event timers
  const [evtDefs, setEvtDefs] = useState<EvtTriggerDef[]>(() => {
    try { return JSON.parse(localStorage.getItem('evtTriggers') || '[]'); } catch { return []; }
  });
  const [evtTimers, setEvtTimers] = useState<EvtTimer[]>([]);
  const [showEvtForm, setShowEvtForm] = useState(false);
  const [evtForm, setEvtForm] = useState({ name: '', mob: '', minMin: '', maxMin: '' });

  // Watch list
  const [watchList, setWatchList] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('popWatchList') || '[]'); } catch { return []; }
  });
  const [watchInput, setWatchInput] = useState('');

  // Pixi
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const { appRef, layersRef } = usePixi(canvasRef);
  const bgSpriteRef = useRef<PIXI.Sprite | null>(null);
  // pad must stay 0: calibration bounds are world coords at the exact image edges
  // (auto-calibration from get_map_data depends on this) — inset would shift entities
  const mapAdj = useRef({ ox: 0, oy: 0, sx: 1, sy: 1, pad: 0 });
  const stageTransform = useRef({ zoom: 1, panX: 0, panY: 0 });
  const dragRef = useRef({ active: false, startX: 0, startY: 0, startPanX: 0, startPanY: 0, moved: false });
  const layersFlagsRef = useRef(layers);                  // up-to-date layers flags for PIXI ticker (no stale closure)
  const zoneDrawRef   = useRef<number | null>(null);      // mirrors zone for drawOverlay ticker
  const boundsDrawRef = useRef<Record<number, CalibrationBounds>>({}); // mirrors bounds for drawOverlay ticker
  const highlightTick = useRef(0);
  const overlayTickerRef = useRef<PIXI.Ticker | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tipRef         = useRef<HTMLDivElement>(null);
  const coordDisplayRef = useRef<HTMLDivElement>(null);

  // Load zones + maps on mount; auto-select zone from navigation state
  useEffect(() => {
    Promise.all([api.zones(), api.maps(), api.bounds(), api.calibrations()]).then(([z, m, b, cals]) => {
      setZones(z.sort((a, b) => a.name.localeCompare(b.name)));
      setMapsAvail(m);
      setDbBounds(b);
      setBounds({ ...b, ...cals }); // saved calibrations override DB auto-bounds
      const stateZone = (location.state as { zoneId?: number } | null)?.zoneId;
      if (stateZone != null && m[stateZone]) setZone(stateZone);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load zone when selected
  useEffect(() => {
    if (zone === null) return;
    mobStaticMapRef.current.clear();
    prevMobIdsRef.current.clear();
    prevMobNamesRef.current.clear();
    setEvtTimers([]);
    setPopLog([]);
    recentPopsRef.current.clear();
    setZonePlayers([]);
    zonePlayersRef.current = [];
    setEntitySearch('');
    entitySearchRef.current = '';
    const cb = bounds[zone] ?? { minX: -512, maxX: 512, minZ: -512, maxZ: 512 };
    setCalForm({ minX: cb.minX, maxX: cb.maxX, minZ: cb.minZ, maxZ: cb.maxZ });
    setCalMsg("");
    setCalAnchorA(null); setCalAnchorB(null); setCalCapture(null);
    setShowOrigin(false); showOriginRef.current = false;

    const fc = mapsAvail[zone] ?? 1;
    setFloorCount(fc);
    setFloor(0);

    Promise.all([api.mobs(zone), api.npcs(zone)]).then(([mobs, npcs]) => {
      mobs.forEach((m) => mobStaticMapRef.current.set(m.mobid, { detects: m.detects, aggro: m.aggro, links: m.links, ecosystem: m.ecosystem, family: m.family, mJob: m.mJob }));
      setDbMobs(mobs);
      setDbNpcs(npcs);
      drawEntities(mobs, npcs, layers, detectFilter);
    });
    // Map image is loaded by the floor effect (which fires on zone change too, since zone is in its deps)
  }, [zone]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    floorRef.current = floor;
    if (zone !== null) loadMapImage(zone, floor);
  }, [floor, zone]); // eslint-disable-line react-hooks/exhaustive-deps

  function loadMapImage(z: number, f: number, bustCache = false) {
    const app = appRef.current;
    if (!app) return;
    function removeOldSprite() {
      if (bgSpriteRef.current) {
        app!.stage.removeChild(bgSpriteRef.current);
        bgSpriteRef.current.destroy(true);
        bgSpriteRef.current = null;
      }
    }
    // bustCache skips the 24h Cache-Control on /api/map — needed after replacing the image
    const url = api.mapImage(z, f) + (bustCache ? `&t=${Date.now()}` : '');
    // Load via plain Image — never enters Pixi's async texture queue,
    // so there's no Pixi listener that can fire after app.destroy().
    const img = new Image();
    img.onload = () => {
      if (appRef.current !== app) return; // app was destroyed while image was loading
      removeOldSprite(); // swap only once the new image is ready — no blank flash
      const tex = PIXI.Texture.from(img); // image is ready; tex.valid = true immediately
      const sprite = new PIXI.Sprite(tex);
      sprite.zIndex = 0; // behind all entity layers (zIndex 1-4)
      app.stage.addChild(sprite);
      bgSpriteRef.current = sprite;
      fitMap(app, sprite);
    };
    img.onerror = () => {
      // New image failed to load — drop the old zone's map so entities aren't
      // drawn over the wrong background
      if (appRef.current !== app) return;
      removeOldSprite();
    };
    img.src = url;
  }

  function applyContainerTransform() {
    const app = appRef.current;
    if (!app) return;
    const st = stageTransform.current;
    app.stage.scale.set(st.zoom);
    app.stage.position.set(st.panX, st.panY);
  }

  function fitMap(app: PIXI.Application, sprite: PIXI.Sprite) {
    if (!app.screen || !sprite.texture?.width) return; // renderer may be torn down
    // Reset pan/zoom so fitMap positions sprite in identity-transform space
    const st = stageTransform.current;
    st.zoom = 1; st.panX = 0; st.panY = 0;
    applyContainerTransform();

    const sw = app.screen.width, sh = app.screen.height;
    const iw = sprite.texture.width, ih = sprite.texture.height;
    const scale = Math.min(sw / iw, sh / ih);
    sprite.scale.set(scale);
    sprite.position.set((sw - iw * scale) / 2, (sh - ih * scale) / 2);
    const adj = mapAdj.current;
    const b = bounds[zone!] ?? { minX: -512, maxX: 512, minZ: -512, maxZ: 512 };
    const rangeX = b.minX - b.maxX, rangeZ = b.minZ - b.maxZ;
    adj.sx = (iw * scale - adj.pad * 2) / rangeX;
    adj.sy = (ih * scale - adj.pad * 2) / rangeZ;
    adj.ox = sprite.x + adj.pad - b.maxX * adj.sx;
    adj.oy = sprite.y + adj.pad - b.maxZ * adj.sy;
    drawEntities(dbMobs, dbNpcs, layers, detectFilter);
  }

  // Recompute mapAdj from a bounds object + current sprite — call after calibration changes
  // so entities reposition immediately without reloading the map image.
  function recomputeMapAdj(b: CalibrationBounds) {
    const app = appRef.current;
    const sprite = bgSpriteRef.current;
    if (!app || !sprite || !sprite.texture?.width) return;
    const iw = sprite.texture.width, ih = sprite.texture.height;
    const scale = Math.min(app.screen.width / iw, app.screen.height / ih);
    const adj = mapAdj.current;
    const rangeX = b.minX - b.maxX, rangeZ = b.minZ - b.maxZ;
    adj.sx = (iw * scale - adj.pad * 2) / rangeX;
    adj.sy = (ih * scale - adj.pad * 2) / rangeZ;
    adj.ox = sprite.x + adj.pad - b.maxX * adj.sx;
    adj.oy = sprite.y + adj.pad - b.maxZ * adj.sy;
  }

  // Stage-local coords — use for PIXI object positions
  function worldToContainer(x: number, z: number) {
    const adj = mapAdj.current;
    return { x: adj.ox + x * adj.sx, y: adj.oy + z * adj.sy };
  }

  // Screen-space coords — use for DOM elements (tooltip)
  function containerToScreen(cx: number, cy: number) {
    const st = stageTransform.current;
    return { x: cx * st.zoom + st.panX, y: cy * st.zoom + st.panY };
  }

  // Convenience: world → screen (tooltip / panToWorld)
  function worldToScreen(x: number, z: number) {
    const cp = worldToContainer(x, z);
    return containerToScreen(cp.x, cp.y);
  }

  // Inverse: screen pixel → world X/Z (for coordinate HUD)
  function screenToWorld(sx: number, sy: number) {
    const st = stageTransform.current; const adj = mapAdj.current;
    const cx = (sx - st.panX) / st.zoom; const cy = (sy - st.panY) / st.zoom;
    return { x: (cx - adj.ox) / adj.sx, z: (cy - adj.oy) / adj.sy };
  }

  function isInBounds(wx: number, wz: number): boolean {
    const zn = zoneDrawRef.current;
    if (zn === null) return true;
    const b = boundsDrawRef.current[zn];
    if (!b) return true;
    const x0 = Math.min(b.minX, b.maxX), x1 = Math.max(b.minX, b.maxX);
    const z0 = Math.min(b.minZ, b.maxZ), z1 = Math.max(b.minZ, b.maxZ);
    return wx >= x0 && wx <= x1 && wz >= z0 && wz <= z1;
  }

  function drawEntities(mobs: MobEntry[], npcs: NpcEntry[], lay: Layers, dFilter: number) {
    const l = layersRef.current;
    if (!l) return;
    l.npc.removeChildren();
    l.mob.removeChildren();
    l.player.removeChildren();
    const srch = entitySearchRef.current.toLowerCase();
    if (srch) {
      mobs = mobs.filter(m => m.name.toLowerCase().includes(srch));
      npcs = npcs.filter(n => n.name.toLowerCase().includes(srch));
    }

    if (lay.npcs) {
      npcs.forEach((n) => {
        if (lay.hidezero && n.pos_x === 0 && n.pos_z === 0) return;
        if (!isInBounds(n.pos_x, n.pos_z)) return;
        const pos = worldToContainer(n.pos_x, n.pos_z);
        const g = new PIXI.Graphics();
        g.beginFill(0x4fc3a1); g.drawCircle(0, 0, 4); g.endFill();
        g.position.set(pos.x, pos.y); g.eventMode = 'static'; g.cursor = 'pointer';
        g.on('pointerover', () => showTip(n.name, 'NPC', pos.x, pos.y));
        g.on('pointerout',  hideTip);
        l.npc.addChild(g);
        if (lay.labels) {
          const txt = new PIXI.Text(n.name, { fontSize: 8, fill: 0x90e8cc, stroke: 0x000000, strokeThickness: 2 });
          txt.position.set(pos.x - txt.width / 2, pos.y + 6);
          l.npc.addChild(txt);
        }
      });
    }

    if (lay.mobs) {
      let list = lay.aggroonly ? mobs.filter((m) => m.aggro) : mobs;
      if (lay.hidezero) list = list.filter((m) => m.pos_x !== 0 || m.pos_z !== 0);
      if (dFilter) list = list.filter((m) => (m.detects || 0) & dFilter);
      list.forEach((m) => {
        if (!isInBounds(m.pos_x, m.pos_z)) return;
        const pos = worldToContainer(m.pos_x, m.pos_z);
        const col = ECOSYSTEM_COLOR[m.ecosystem] ?? 0xe0e040;
        const g = new PIXI.Graphics();
        if (m.aggro) {
          g.lineStyle(1.2, 0xe05c5c, 0.5); g.beginFill(col); g.drawPolygon([0,-6,5,4,-5,4]); g.endFill();
        } else {
          g.beginFill(col, 0.7); g.drawPolygon([0,-5,4.5,3.5,-4.5,3.5]); g.endFill();
        }
        g.position.set(pos.x, pos.y); g.eventMode = 'static'; g.cursor = 'pointer';
        const dStr = detectStr(m.detects || 0);
        const linksStr = m.links ? ' · Links' : '';
        g.on('pointerover', () => showTip(m.name, `${JOB[m.mJob] || 'Mob'}${dStr ? ` · ${dStr}` : ''}${linksStr}`, pos.x, pos.y));
        g.on('pointerout',  hideTip);
        l.mob.addChild(g);
        if (lay.labels) {
          const txt = new PIXI.Text(m.name, { fontSize: 8, fill: 0xddcc88, stroke: 0x000000, strokeThickness: 2 });
          txt.position.set(pos.x - txt.width / 2, pos.y + 8);
          l.mob.addChild(txt);
        }
      });
    }

    drawPlayers(lay);
  }

  function drawPlayers(lay: Layers) {
    const l = layersRef.current;
    if (!l) return;
    l.player.removeChildren();
    type ZP = { charid?: number | null; charname?: string; name?: string; mjob?: number; mlvl?: number; sjob?: number; slvl?: number; pos_x?: number; pos_z?: number; x?: number; z?: number; map_index?: number };

    function renderPlayer(p: ZP, online: boolean) {
      const label = p.charname ?? p.name ?? 'Player';
      const wx = p.pos_x ?? p.x;
      const wz = p.pos_z ?? p.z;
      if (wx == null || wz == null) return;
      if (wx === 0 && wz === 0) return;
      if (p.map_index != null && p.map_index !== floorRef.current) return;
      if (!isInBounds(wx, wz)) return;
      const pos = worldToContainer(wx, wz);
      const g = new PIXI.Graphics();
      if (online) {
        g.beginFill(0x7c6af7, 0.9); g.drawCircle(0, 0, 6); g.endFill();
        g.lineStyle(1.5, 0xffffff, 0.3); g.drawCircle(0, 0, 6);
      } else {
        g.beginFill(0x555566, 0.6); g.drawCircle(0, 0, 5); g.endFill();
        g.lineStyle(1, 0x888899, 0.4); g.drawCircle(0, 0, 5);
      }
      g.position.set(pos.x, pos.y); g.eventMode = 'static'; g.cursor = 'pointer';
      const jobStr = p.mjob ? `${JOB[p.mjob] ?? '?'}${p.mlvl ?? ''}${p.sjob ? `/${JOB[p.sjob]}${p.slvl}` : ''}` : 'Player';
      g.on('pointerover', () => showTip(label, online ? jobStr : `${label} (offline)`, pos.x, pos.y));
      g.on('pointerout', hideTip);
      g.on('pointertap', () => { if (!dragRef.current.moved) p.charid && navigate(`/chars/${p.charid}`); });
      l!.player.addChild(g);
      if (lay.labels) {
        const txt = new PIXI.Text(label, { fontSize: 9, fill: online ? 0xc8b8ff : 0x777788, stroke: 0x000000, strokeThickness: 2 });
        txt.position.set(pos.x - txt.width / 2, pos.y + 9);
        l!.player.addChild(txt);
      }
    }

    if (lay.offlineplayers) {
      (offlineZonePlayersRef.current as ZP[]).forEach((p) => renderPlayer(p, false));
    }
    if (lay.players) {
      (zonePlayersRef.current as ZP[]).forEach((p) => renderPlayer(p, true));
    }
  }

  function drawOverlay(lay: Layers) {
    const l = layersRef.current;
    if (!l) return;
    l.overlay.removeChildren();

    // Bounds rectangle — use refs so this works inside the stale ticker closure
    const zn = zoneDrawRef.current;
    if (lay.bounds && zn !== null) {
      const b = boundsDrawRef.current[zn] ?? { minX: -512, maxX: 512, minZ: -512, maxZ: 512 };
      // Axes may be inverted, so normalize to screen-space corners before drawing
      const p1 = worldToContainer(b.minX, b.minZ);
      const p2 = worldToContainer(b.maxX, b.maxZ);
      const L = Math.min(p1.x, p2.x), R = Math.max(p1.x, p2.x);
      const T = Math.min(p1.y, p2.y), B = Math.max(p1.y, p2.y);
      const wxL = p1.x <= p2.x ? b.minX : b.maxX, wxR = p1.x <= p2.x ? b.maxX : b.minX;
      const wzT = p1.y <= p2.y ? b.minZ : b.maxZ, wzB = p1.y <= p2.y ? b.maxZ : b.minZ;
      const g = new PIXI.Graphics();
      g.lineStyle(1.5, 0xffdd44, 0.6);
      g.drawRect(L, T, R - L, B - T);
      g.lineStyle(0);
      g.beginFill(0xffdd44, 0.04);
      g.drawRect(L, T, R - L, B - T);
      g.endFill();
      l.overlay.addChild(g);

      const corners: [number, number, number, number, number, number][] = [
        // [worldX, worldZ, containerX, containerY, anchorX, anchorY]
        [wxL, wzT, L, T, 1, 1], // top-left: label inside
        [wxR, wzT, R, T, 0, 1], // top-right
        [wxL, wzB, L, B, 1, 0], // bottom-left
        [wxR, wzB, R, B, 0, 0], // bottom-right
      ];
      for (const [wx, wz, cx, cy, ax, ay] of corners) {
        const t = new PIXI.Text(`x${Math.round(wx)} z${Math.round(wz)}`, {
          fontSize: 10, fill: 0xffdd44, fontFamily: 'monospace', dropShadow: true,
          dropShadowColor: 0x000000, dropShadowDistance: 1, dropShadowAlpha: 0.9,
        });
        t.anchor.set(ax, ay);
        t.position.set(cx + (ax === 1 ? 3 : -3), cy + (ay === 1 ? 3 : -3));
        l.overlay.addChild(t);
      }
    }

    // Coordinate grid — aligned with calibration bounds (same extent as the bounds box)
    if (lay.grid && zn !== null) {
      const b = boundsDrawRef.current[zn] ?? { minX: -512, maxX: 512, minZ: -512, maxZ: 512 };
      const x0 = Math.min(b.minX, b.maxX), x1 = Math.max(b.minX, b.maxX);
      const z0 = Math.min(b.minZ, b.maxZ), z1 = Math.max(b.minZ, b.maxZ);
      // Zoom-aware spacing: keep ~80 screen px between lines, snapped to a nice round step,
      // so zooming in reveals finer coordinate intervals instead of stretching sparse ones.
      const st = stageTransform.current;
      const pxPerUnit = Math.abs(mapAdj.current.sx) * st.zoom; // screen px per world unit
      const NICE_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
      const spacing = NICE_STEPS.find(s => s * pxPerUnit >= 80) ?? 2000;

      // Always include the bound edges; fill interior starting from the user-defined origin
      const ox = gridOffsetXRef.current, oz = gridOffsetZRef.current;
      const xSet = new Set<number>([x0, x1]);
      for (let wx = Math.ceil((x0 - ox) / spacing) * spacing + ox; wx <= x1; wx += spacing) xSet.add(wx);
      const xPositions = [...xSet].sort((a, b) => a - b);

      const zSet = new Set<number>([z0, z1]);
      for (let wz = Math.ceil((z0 - oz) / spacing) * spacing + oz; wz <= z1; wz += spacing) zSet.add(wz);
      const zPositions = [...zSet].sort((a, b) => a - b);

      const gg = new PIXI.Graphics();
      gg.lineStyle(1 / st.zoom, 0x4488cc, 0.22); // constant 1px on screen regardless of zoom
      for (const wx of xPositions) {
        const p0 = worldToContainer(wx, z0); const p1 = worldToContainer(wx, z1);
        gg.moveTo(p0.x, p0.y); gg.lineTo(p1.x, p1.y);
      }
      for (const wz of zPositions) {
        const p0 = worldToContainer(x0, wz); const p1 = worldToContainer(x1, wz);
        gg.moveTo(p0.x, p0.y); gg.lineTo(p1.x, p1.y);
      }
      l.overlay.addChild(gg);

      // Labels: X values along the top canvas edge, Z values along the left canvas edge
      const textStyle = { fontSize: 8, fill: 0x6699cc as number, fontFamily: 'monospace', dropShadow: true, dropShadowColor: 0x000000 as number, dropShadowDistance: 1, dropShadowAlpha: 0.9 };
      for (const wx of xPositions) {
        const pa = worldToContainer(wx, z0); const pb = worldToContainer(wx, z1);
        const topY = Math.min(pa.y, pb.y);
        const t = new PIXI.Text(`x${Math.round(wx)}`, textStyle);
        t.anchor.set(0.5, 1); t.scale.set(1 / st.zoom);
        t.position.set(pa.x, topY - 2 / st.zoom);
        l.overlay.addChild(t);
      }
      for (const wz of zPositions) {
        const pa = worldToContainer(x0, wz); const pb = worldToContainer(x1, wz);
        const leftX = Math.min(pa.x, pb.x);
        const t = new PIXI.Text(`z${Math.round(wz)}`, textStyle);
        t.anchor.set(1, 0.5); t.scale.set(1 / st.zoom);
        t.position.set(leftX - 3 / st.zoom, pa.y);
        l.overlay.addChild(t);
      }
    }

    // Origin marker (0, 0) — shown when toggle is on
    if (showOriginRef.current && zn !== null && boundsDrawRef.current[zn]) {
      const o = worldToContainer(0, 0);
      const og = new PIXI.Graphics();
      og.lineStyle(1.5, 0xff4466, 0.85);
      og.moveTo(o.x - 14, o.y); og.lineTo(o.x + 14, o.y);
      og.moveTo(o.x, o.y - 14); og.lineTo(o.x, o.y + 14);
      og.lineStyle(1, 0xff4466, 0.5);
      og.drawCircle(o.x, o.y, 5);
      l.overlay.addChild(og);
      const ot = new PIXI.Text('x0, z0', { fontSize: 9, fill: 0xff4466, fontFamily: 'monospace', dropShadow: true, dropShadowColor: 0x000000, dropShadowDistance: 1, dropShadowAlpha: 0.9 });
      ot.anchor.set(0, 1);
      ot.position.set(o.x + 8, o.y - 2);
      l.overlay.addChild(ot);
    }

    // Pop rings
    const now = Date.now();
    recentPopsRef.current.forEach((pop) => {
      const age = now - pop.ts;
      if (age > POP_RING_TTL) return;
      const frac = age / POP_RING_TTL; // 0→1 as ring ages
      const alpha = 1 - frac;
      const radius = 8 + frac * 24;
      const pos = worldToContainer(pop.pos_x, pop.pos_z);
      const col = pop.watched ? 0xffbb33 : 0xe05c5c;
      const g = new PIXI.Graphics();
      g.lineStyle(2, col, alpha * 0.85);
      g.drawCircle(pos.x, pos.y, radius);
      g.lineStyle(0);
      g.beginFill(col, alpha * 0.15);
      g.drawCircle(pos.x, pos.y, 5);
      g.endFill();
      l.overlay.addChild(g);
    });
  }

  // Start overlay ticker when PIXI is ready
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    // Use a shared ticker that redraws overlay at ~10 fps (enough for ring fade)
    const ticker = new PIXI.Ticker();
    ticker.minFPS = 8; ticker.maxFPS = 15;
    ticker.add(() => { if (layersRef.current) drawOverlay(layersFlagsRef.current); });
    ticker.start();
    overlayTickerRef.current = ticker;
    return () => { ticker.destroy(); overlayTickerRef.current = null; };
  }, [appRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw overlay when bounds toggle changes
  useEffect(() => { if (layersRef.current) drawOverlay(layers); }, [layers.bounds, layers.grid, bounds, zone]); // eslint-disable-line react-hooks/exhaustive-deps

  function panToWorld(wx: number, wz: number) {
    const app = appRef.current;
    if (!app) return;
    const cp = worldToContainer(wx, wz);
    const st = stageTransform.current;
    st.panX = app.screen.width  / 2 - cp.x * st.zoom;
    st.panY = app.screen.height / 2 - cp.y * st.zoom;
    applyContainerTransform();
  }

  function resetView() {
    const st = stageTransform.current;
    st.zoom = 1; st.panX = 0; st.panY = 0;
    applyContainerTransform();
  }

  // cx/cy are container-local coords; convert to screen for DOM positioning
  function showTip(name: string, type: string, cx: number, cy: number) {
    const tip = tipRef.current; if (!tip) return;
    tip.innerHTML = `<strong>${esc(name)}</strong><br><span style="opacity:.65;font-size:10px">${esc(type)}</span>`;
    tip.style.display = 'block';
    const sp = containerToScreen(cx, cy);
    const wrap = canvasWrapRef.current!;
    const rect = wrap.getBoundingClientRect();
    tip.style.left = `${Math.min(sp.x + 10, rect.width - 160)}px`;
    tip.style.top  = `${sp.y - 36}px`;
  }
  function hideTip() { if (tipRef.current) tipRef.current.style.display = 'none'; }

  // Pop detection
  function onMobPop(mob: { mobid: number; name: string; pos_x: number; pos_z: number }) {
    const watched = watchList.some((w) => mob.name.toLowerCase().includes(w.toLowerCase()));
    const now = Date.now();
    recentPopsRef.current.set(mob.mobid, { ts: now, pos_x: mob.pos_x, pos_z: mob.pos_z, name: mob.name, watched });
    setTimeout(() => { recentPopsRef.current.delete(mob.mobid); }, POP_RING_TTL);
    setPopLog((prev) => [{ name: mob.name, mobid: mob.mobid, pos_x: mob.pos_x, pos_z: mob.pos_z, ts: now, watched }, ...prev].slice(0, 30));
    showToast((watched ? '★ ' : '') + mob.name + ' popped!', watched ? 'var(--color-amber)' : 'var(--color-red)', mob.pos_x, mob.pos_z);
  }

  function onMobKill(name: string) {
    evtDefs.forEach((t) => {
      if (t.mob && name.toLowerCase().includes(t.mob.toLowerCase())) startEvtTimer(t, `${name} killed`);
    });
  }

  function startEvtTimer(trigger: EvtTriggerDef, reason: string) {
    const now = Date.now();
    setEvtTimers((prev) => {
      if (prev.some((t) => t.trigId === trigger.id && now - t.startTs < 10000)) return prev;
      return [...prev, { id: now + Math.random(), trigId: trigger.id, name: trigger.name, reason, startTs: now, minMs: trigger.minMin * 60000, maxMs: trigger.maxMin ? trigger.maxMin * 60000 : null, alerted: false }];
    });
  }

  // Timer tick
  useEffect(() => {
    const id = setInterval(() => {
      setEvtTimers((prev) => {
        const now = Date.now();
        return prev
          .map((t) => {
            if (!t.alerted && now - t.startTs >= t.minMs) {
              showToast(`⏰ ${t.name} window OPEN!`, 'var(--color-teal)');
              return { ...t, alerted: true };
            }
            return t;
          })
          .filter((t) => !t.maxMs || now - t.startTs < t.maxMs + 300000);
      });
    }, 1000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function showToast(msg: string, color: string, x?: number, z?: number) {
    setToast({ msg, color, x, z });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  }

  // WS handler
  const wsHandler = useCallback((type: string, data: unknown) => {
    const d = data as Record<string, unknown>;
    if (type === 'zone_players') {
      // zoneId arrives as number (Windower) or string (poll Object.entries) — coerce both
      if (Number(d.zoneId) === zone) {
        const players = (d.players as unknown[]) ?? [];
        setZonePlayers(players);
        zonePlayersRef.current = players;
        drawPlayers(layers);
      }
    }
    if (type === 'positions' && zone !== null) {
      const pos = d as { players?: PosEntry[]; npcs?: PosEntry[]; mobs?: PosEntry[] };
      const liveMobs = (pos.mobs ?? []).filter((m) => m.z_id === zone && (m.x !== 0 || m.z !== 0));
      const updatedMobs: MobEntry[] = liveMobs.map((m) => {
        const st = mobStaticMapRef.current.get(m.i) ?? {};
        return { mobid: m.i, name: m.n, pos_x: m.x, pos_y: m.y, pos_z: m.z, ...st } as MobEntry;
      });
      // Pop/kill detection
      if (prevMobIdsRef.current.size > 0) {
        const curIds = new Set(updatedMobs.map((m) => m.mobid));
        updatedMobs.forEach((m) => { if (!prevMobIdsRef.current.has(m.mobid)) onMobPop(m); });
        prevMobIdsRef.current.forEach((id) => { if (!curIds.has(id)) onMobKill(prevMobNamesRef.current.get(id) ?? ''); });
      }
      prevMobNamesRef.current = new Map(updatedMobs.map((m) => [m.mobid, m.name]));
      prevMobIdsRef.current   = new Set(prevMobNamesRef.current.keys());
      drawEntities(updatedMobs, dbNpcs, layers, detectFilter);
    }
  }, [zone, dbNpcs, layers, detectFilter, watchList, evtDefs]); // eslint-disable-line react-hooks/exhaustive-deps

  const { send } = useWS(wsHandler);

  // Re-send on wsReady so the watch survives WebSocket reconnects; unwatch on
  // zone change/unmount so the server resumes the global position feed.
  useEffect(() => {
    if (zone === null || !wsReady) return;
    send('watch_zone', { zoneId: zone });
    return () => send('unwatch_zone', {});
  }, [zone, send, wsReady]);

  // Layer toggle helper
  const toggleLayer = (key: keyof Layers) => setLayers((l) => ({ ...l, [key]: !l[key] }));

  // Watch list
  function addWatch() {
    const v = watchInput.trim();
    if (!v || watchList.some((w) => w.toLowerCase() === v.toLowerCase())) return;
    const nl = [...watchList, v];
    setWatchList(nl);
    localStorage.setItem('popWatchList', JSON.stringify(nl));
    setWatchInput('');
  }
  function removeWatch(i: number) {
    const nl = watchList.filter((_, idx) => idx !== i);
    setWatchList(nl);
    localStorage.setItem('popWatchList', JSON.stringify(nl));
  }

  // Event trigger helpers
  function saveEvtDef() {
    const { name, mob, minMin, maxMin } = evtForm;
    if (!name || !parseInt(minMin)) return;
    const defs = [...evtDefs, { id: Date.now() + Math.random(), name, mob, minMin: parseInt(minMin), maxMin: parseInt(maxMin) || null }];
    setEvtDefs(defs);
    localStorage.setItem('evtTriggers', JSON.stringify(defs));
    setEvtForm({ name: '', mob: '', minMin: '', maxMin: '' });
    setShowEvtForm(false);
  }
  function deleteEvtDef(id: number) {
    const defs = evtDefs.filter((d) => d.id !== id);
    setEvtDefs(defs);
    localStorage.setItem('evtTriggers', JSON.stringify(defs));
  }

  // Keep ticker refs in sync with state so drawOverlay never uses stale closures
  useEffect(() => { zoneDrawRef.current   = zone;   }, [zone]);
  useEffect(() => { boundsDrawRef.current = bounds; }, [bounds]);


  // Re-draw on layer/filter change
  useEffect(() => { layersFlagsRef.current = layers; drawEntities(dbMobs, dbNpcs, layers, detectFilter); }, [layers, detectFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { entitySearchRef.current = entitySearch; drawEntities(dbMobs, dbNpcs, layers, detectFilter); }, [entitySearch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (zone == null) {
      offlineZonePlayersRef.current = [];
      zonePlayersRef.current = [];
      setZonePlayers([]);
    } else {
      offlineZonePlayersRef.current = allPlayers.filter((p) => !p.online && p.pos_zone === zone);
      // Seed online zone players from the global store — zone_players WS messages will
      // override with fresher / Windower positions when they arrive.
      const online = allPlayers.filter((p) => p.online && p.pos_zone === zone);
      zonePlayersRef.current = online;
      setZonePlayers(online);
    }
    if (layersRef.current) drawPlayers(layersFlagsRef.current);
  }, [allPlayers, zone]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel zoom — registered as non-passive so preventDefault works
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const st = stageTransform.current;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newZoom = Math.max(0.15, Math.min(12, st.zoom * factor));
      const rect = canvasRef.current!.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // Zoom toward cursor: keep the canvas point under the cursor fixed
      st.panX = cx - (cx - st.panX) * (newZoom / st.zoom);
      st.panY = cy - (cy - st.panY) * (newZoom / st.zoom);
      st.zoom = newZoom;
      applyContainerTransform();
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function onCanvasPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = { active: true, moved: false, startX: e.clientX, startY: e.clientY, startPanX: stageTransform.current.panX, startPanY: stageTransform.current.panY };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  }

  function onCanvasPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    // Update coordinate HUD regardless of drag state
    if (zone !== null && canvasRef.current && coordDisplayRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const { x, z } = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      coordDisplayRef.current.textContent = `x: ${x.toFixed(3)} z: ${z.toFixed(3)}`;
    }
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (!dragRef.current.moved && Math.hypot(dx, dy) > 4) dragRef.current.moved = true;
    if (!dragRef.current.moved) return;
    const st = stageTransform.current;
    st.panX = dragRef.current.startPanX + dx;
    st.panY = dragRef.current.startPanY + dy;
    applyContainerTransform();
    hideTip();
  }

  function onCanvasPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const wasDrag = dragRef.current.moved;
    dragRef.current.active = false;
    dragRef.current.moved  = false;
    // Calibration pick — only on clean tap (not after drag)
    if (!wasDrag && calCapture && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const st = stageTransform.current;
      const cx = (sx - st.panX) / st.zoom;  // container-local
      const cy = (sy - st.panY) / st.zoom;
      // Preserve wx/wz pre-filled by quick-fill chips
      const existing = calCapture === 'A' ? calAnchorA : calAnchorB;
      const anchor: Anchor = { cx, cy, wx: existing?.wx ?? '', wz: existing?.wz ?? '', pixelSet: true };
      if (calCapture === 'A') setCalAnchorA(anchor);
      else setCalAnchorB(anchor);
      setCalCapture(null);
    }
  }

  function computeFromAnchors() {
    if (!calAnchorA?.pixelSet || !calAnchorB?.pixelSet || !bgSpriteRef.current) return;
    const wx1 = parseFloat(calAnchorA.wx), wz1 = parseFloat(calAnchorA.wz);
    const wx2 = parseFloat(calAnchorB.wx), wz2 = parseFloat(calAnchorB.wz);
    if (isNaN(wx1) || isNaN(wz1) || isNaN(wx2) || isNaN(wz2) || wx1 === wx2 || wz1 === wz2) return;
    const sx = (calAnchorB.cx - calAnchorA.cx) / (wx2 - wx1);
    const sy = (calAnchorB.cy - calAnchorA.cy) / (wz2 - wz1);
    const ox = calAnchorA.cx - wx1 * sx;
    const oy = calAnchorA.cy - wz1 * sy;
    const sprite = bgSpriteRef.current;
    const pad = mapAdj.current.pad;
    // Rendering convention: maxX anchors the left edge, maxZ the top edge
    // (fitMap/recomputeMapAdj use rangeX = minX - maxX, rangeZ = minZ - maxZ)
    const maxX = (sprite.x + pad - ox) / sx;
    const minX = maxX + (sprite.width - 2 * pad) / sx;
    const maxZ = (sprite.y + pad - oy) / sy;
    const minZ = maxZ + (sprite.height - 2 * pad) / sy;
    const newBounds = {
      minX: Math.round(minX * 10) / 10,
      maxX: Math.round(maxX * 10) / 10,
      minZ: Math.round(minZ * 10) / 10,
      maxZ: Math.round(maxZ * 10) / 10,
    };
    setCalForm(newBounds);
    // Live preview — apply immediately so entities and grid update without requiring Save
    if (zone !== null) {
      recomputeMapAdj(newBounds);
      boundsDrawRef.current = { ...boundsDrawRef.current, [zone]: newBounds };
      drawEntities(dbMobs, dbNpcs, layersFlagsRef.current, detectFilter);
    }
  }

  // Scale calibration: one anchor + known world-units-per-pixel derived from the
  // map image size (FFXI maps are typically ~1 yalm per native pixel).
  function computeFromScale() {
    const sprite = bgSpriteRef.current;
    if (!calAnchorA?.pixelSet || !sprite) return;
    const wx = parseFloat(calAnchorA.wx), wz = parseFloat(calAnchorA.wz);
    const s = parseFloat(calScale);
    if (isNaN(wx) || isNaN(wz) || isNaN(s) || s <= 0) return;
    const pad = mapAdj.current.pad;
    const upp = s / sprite.scale.x; // world units per container pixel
    // Current axis convention: world X decreases left→right, world Z increases top→bottom
    const maxX = wx + (calAnchorA.cx - (sprite.x + pad)) * upp;
    const minX = maxX - (sprite.width - 2 * pad) * upp;
    const maxZ = wz - (calAnchorA.cy - (sprite.y + pad)) * upp;
    const minZ = maxZ + (sprite.height - 2 * pad) * upp;
    const newBounds = {
      minX: Math.round(minX * 10) / 10,
      maxX: Math.round(maxX * 10) / 10,
      minZ: Math.round(minZ * 10) / 10,
      maxZ: Math.round(maxZ * 10) / 10,
    };
    setCalForm(newBounds);
    if (zone !== null) {
      recomputeMapAdj(newBounds);
      boundsDrawRef.current = { ...boundsDrawRef.current, [zone]: newBounds };
      drawEntities(dbMobs, dbNpcs, layersFlagsRef.current, detectFilter);
    }
  }

  function previewBounds() {
    if (zone === null) return;
    recomputeMapAdj(calForm);
    boundsDrawRef.current = { ...boundsDrawRef.current, [zone]: calForm };
    drawEntities(dbMobs, dbNpcs, layersFlagsRef.current, detectFilter);
  }

  async function saveCalibration() {
    if (zone === null) return;
    setCalSaving(true); setCalMsg("");
    try {
      await api.saveCalibration(zone, calForm);
      setBounds(p => ({ ...p, [zone]: calForm }));
      boundsDrawRef.current = { ...boundsDrawRef.current, [zone]: calForm };
      recomputeMapAdj(calForm);
      drawEntities(dbMobs, dbNpcs, layersFlagsRef.current, detectFilter);
      setCalMsg("Saved"); setTimeout(() => setCalMsg(""), 2000);
    } catch (e) { setCalMsg((e as Error).message); }
    setCalSaving(false);
  }
  async function deleteCalibration() {
    if (zone === null || !confirm("Reset calibration for this zone?")) return;
    try {
      await api.deleteCalibration(zone);
      const newBounds = { ...bounds }; delete newBounds[zone];
      setBounds(newBounds);
      boundsDrawRef.current = newBounds;
      const fallback = dbBounds[zone] ?? { minX: -512, maxX: 512, minZ: -512, maxZ: 512 };
      setCalForm(fallback);
      recomputeMapAdj(fallback);
      drawEntities(dbMobs, dbNpcs, layersFlagsRef.current, detectFilter);
      setCalMsg("Reset"); setTimeout(() => setCalMsg(""), 2000);
    } catch (e) { setCalMsg((e as Error).message); }
  }
  async function handleMapUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || zone === null) return;
    try {
      await api.uploadMapImage(zone, file);
      setMapUploadMsg('Uploaded');
      setTimeout(() => setMapUploadMsg(''), 2500);
      // Show the new image immediately — cache-busted, since /api/map serves
      // with a 24h Cache-Control that would otherwise keep the old PNG
      loadMapImage(zone, floorRef.current, true);
    } catch (err) { setMapUploadMsg((err as Error).message); }
    e.target.value = '';
  }

  const hasSidebar = sidebarOpen;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Sidebar */}
      {hasSidebar && (
        <div style={{ width: 260, background: 'var(--color-surface)', borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', flexShrink: 0, overflowY: 'auto' }}>
          {/* Zone picker */}
          <SideSection title={`Zone${zoneSearch ? ` (${zones.filter(z => mapsAvail[z.zoneid] && z.name.toLowerCase().includes(zoneSearch.toLowerCase())).length})` : ` (${Object.keys(mapsAvail).length})`}`}>
            <div style={{ position: 'relative', marginBottom: 5 }}>
              <input
                className="input"
                placeholder="Search zones…"
                value={zoneSearch}
                onChange={(e) => setZoneSearch(e.target.value)}
                style={{ width: '100%', fontSize: 11, padding: '5px 8px', paddingRight: zoneSearch ? 22 : 8 }}
              />
              {zoneSearch && (
                <button onClick={() => setZoneSearch('')}
                  style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--color-text3)', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
              )}
            </div>
            <select
              value={zone ?? ''}
              onChange={(e) => { setZone(e.target.value ? Number(e.target.value) : null); setZoneSearch(''); }}
              style={{ width: '100%', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', padding: '7px 9px', borderRadius: 7, fontSize: 12 }}
            >
              <option value="">Select zone…</option>
              {zones.filter((z) => mapsAvail[z.zoneid] && (!zoneSearch || z.name.toLowerCase().includes(zoneSearch.toLowerCase()))).map((z) => (
                <option key={z.zoneid} value={z.zoneid}>{z.name}</option>
              ))}
            </select>
            {floorCount > 1 && (
              <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                {Array.from({ length: floorCount }, (_, i) => (
                  <button key={i} onClick={() => setFloor(i)} className={`btn btn-ghost btn-xs ${floor === i ? 'btn-primary' : ''}`}
                    style={floor === i ? { background: 'var(--color-accent)', color: '#fff' } : {}}>
                    {i + 1}
                  </button>
                ))}
              </div>
            )}
          </SideSection>

          {/* Layers */}
          <SideSection title="Layers">
            {([
              { key: 'players', label: 'Players', color: '#7c6af7', badge: zone !== null ? (zonePlayers as unknown[]).length : undefined },
              { key: 'npcs',    label: 'NPCs',    color: '#4fc3a1', badge: zone !== null ? dbNpcs.length : undefined },
              { key: 'mobs',    label: 'Mobs',    color: '#ccc',    badge: zone !== null ? dbMobs.length : undefined },
            ] as const).map(({ key, label, color, badge }) => (
              <LayerToggle key={key} active={layers[key]} color={color} label={label} badge={badge} onClick={() => toggleLayer(key)} />
            ))}
            <LayerToggle active={layers.offlineplayers} color="#556" label="Offline players" onClick={() => toggleLayer('offlineplayers')} sub />
            <LayerToggle active={layers.aggroonly} color="#e05c5c" label="Aggro only" onClick={() => toggleLayer('aggroonly')} sub />
            <LayerToggle active={layers.labels} color="var(--color-text3)" label="Labels" onClick={() => toggleLayer('labels')} sub />
            <LayerToggle active={layers.hidezero} color="#555" label="Hide invisible" onClick={() => toggleLayer('hidezero')} sub />
            <LayerToggle active={layers.bounds} color="#ffdd44" label="Bounds box" onClick={() => toggleLayer('bounds')} sub />
            <LayerToggle active={layers.grid} color="#4488cc" label="Coord grid" onClick={() => toggleLayer('grid')} sub />
            {layers.grid && (
              <div style={{ marginLeft: 28, display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--color-text3)' }}>Origin</span>
                <label style={{ fontSize: 10, color: 'var(--color-text3)', display: 'flex', alignItems: 'center', gap: 3 }}>
                  X
                  <input type="number" value={gridOffsetX} step="any" onChange={e => {
                    const v = parseFloat(e.target.value) || 0;
                    gridOffsetXRef.current = v; setGridOffsetX(v);
                  }} style={{ width: 60, fontSize: 10, padding: '2px 4px', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'var(--color-text1)' }} />
                </label>
                <label style={{ fontSize: 10, color: 'var(--color-text3)', display: 'flex', alignItems: 'center', gap: 3 }}>
                  Z
                  <input type="number" value={gridOffsetZ} step="any" onChange={e => {
                    const v = parseFloat(e.target.value) || 0;
                    gridOffsetZRef.current = v; setGridOffsetZ(v);
                  }} style={{ width: 60, fontSize: 10, padding: '2px 4px', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'var(--color-text1)' }} />
                </label>
              </div>
            )}
          </SideSection>

          {/* Entity search */}
          {zone !== null && (
            <SideSection title="Search">
              <div style={{ position: 'relative' }}>
                <input
                  className="input"
                  placeholder="NPC or mob name…"
                  value={entitySearch}
                  onChange={(e) => setEntitySearch(e.target.value)}
                  style={{ width: '100%', fontSize: 11, padding: '5px 8px', paddingRight: entitySearch ? 22 : 8 }}
                />
                {entitySearch && (
                  <button onClick={() => setEntitySearch('')}
                    style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--color-text3)', cursor: 'pointer', fontSize: 13, lineHeight: 1 }}>×</button>
                )}
              </div>
              {entitySearch && (() => {
                const npcHits = dbNpcs.filter(n => n.name.toLowerCase().includes(entitySearch.toLowerCase())).length;
                const mobHits = dbMobs.filter(m => m.name.toLowerCase().includes(entitySearch.toLowerCase())).length;
                return (
                  <div style={{ fontSize: 10, color: npcHits + mobHits === 0 ? 'var(--color-red)' : 'var(--color-text3)', marginTop: 4 }}>
                    {npcHits + mobHits === 0 ? 'No matches' : `${npcHits} NPCs · ${mobHits} mobs`}
                  </div>
                );
              })()}
            </SideSection>
          )}

          {/* Detection filter */}
          <SideSection title="Detection Filter">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {([{ b: 0, l: 'All' }, ...Object.entries(DETECT_LABELS).map(([b, l]) => ({ b: Number(b), l }))]).map(({ b, l }) => (
                <button
                  key={b}
                  onClick={() => setDetectFilter(b)}
                  style={{
                    fontSize: 10, padding: '2px 7px', borderRadius: 4,
                    border: `1px solid ${detectFilter === b ? 'var(--color-accent)' : 'var(--color-border)'}`,
                    background: detectFilter === b ? 'rgba(124,106,247,.18)' : 'var(--color-surface2)',
                    color: detectFilter === b ? 'var(--color-accent)' : 'var(--color-text3)',
                    cursor: 'pointer',
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
          </SideSection>

          {/* Event timers */}
          <SideSection title="Event Timers" action={<button onClick={() => setShowEvtForm((v) => !v)} className="btn btn-ghost btn-xs">+ New</button>}>
            {showEvtForm && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingBottom: 8, borderBottom: '1px solid var(--color-border)', marginBottom: 8 }}>
                <input className="input" placeholder="Timer name" value={evtForm.name} onChange={(e) => setEvtForm((f) => ({ ...f, name: e.target.value }))} style={{ fontSize: 11, padding: '4px 8px' }} />
                <input className="input" placeholder="Mob name (optional)" value={evtForm.mob} onChange={(e) => setEvtForm((f) => ({ ...f, mob: e.target.value }))} style={{ fontSize: 11, padding: '4px 8px' }} />
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: 'var(--color-text2)' }}>
                  Open <input className="input" type="number" placeholder="min" value={evtForm.minMin} onChange={(e) => setEvtForm((f) => ({ ...f, minMin: e.target.value }))} style={{ width: 50, fontSize: 11, padding: '3px 5px' }} />
                  – close <input className="input" type="number" placeholder="max" value={evtForm.maxMin} onChange={(e) => setEvtForm((f) => ({ ...f, maxMin: e.target.value }))} style={{ width: 50, fontSize: 11, padding: '3px 5px' }} />
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={saveEvtDef} className="btn btn-primary btn-xs" style={{ flex: 1 }}>Save</button>
                  <button onClick={() => setShowEvtForm(false)} className="btn btn-ghost btn-xs">Cancel</button>
                </div>
              </div>
            )}
            {/* Defined triggers */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 110, overflowY: 'auto', marginBottom: 6 }}>
              {evtDefs.map((t) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 5px', borderRadius: 4, background: 'var(--color-surface2)', border: '1px solid var(--color-border)' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text2)' }}>{t.name}</span>
                  <span style={{ fontSize: 10, color: 'var(--color-text3)' }}>{t.minMin}{t.maxMin ? `–${t.maxMin}` : ''}m</span>
                  <button onClick={() => startEvtTimer(t, 'Manual')} style={{ background: 'none', border: 'none', color: 'var(--color-text3)', cursor: 'pointer', fontSize: 11 }}>▶</button>
                  <button onClick={() => deleteEvtDef(t.id)} style={{ background: 'none', border: 'none', color: 'var(--color-text3)', cursor: 'pointer', fontSize: 12 }}>×</button>
                </div>
              ))}
              {evtDefs.length === 0 && evtTimers.length === 0 && <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>No timers defined.</span>}
            </div>
            {/* Active timers */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <EvtTimerList timers={evtTimers} onRemove={(id) => setEvtTimers((t) => t.filter((x) => x.id !== id))} />
            </div>
          </SideSection>

          {/* Calibration editor */}
          {zone !== null && (
            <SideSection title="Calibration" defaultOpen={false} action={
              <button onClick={deleteCalibration} className="btn btn-ghost btn-xs" style={{ color: 'var(--color-red)', fontSize: 9 }}>Reset</button>
            }>
              {/* Auto-fill */}
              {dbBounds[zone] && (
                <button onClick={() => {
                  const b = dbBounds[zone];
                  setCalForm(b);
                  recomputeMapAdj(b);
                  boundsDrawRef.current = { ...boundsDrawRef.current, [zone]: b };
                  drawEntities(dbMobs, dbNpcs, layersFlagsRef.current, detectFilter);
                }} className="btn btn-ghost btn-xs" style={{ width: '100%', marginBottom: 8 }}>
                  Auto-fill from NPC / mob data
                </button>
              )}

              {/* Anchor A & B — each with its own pick button, coord inputs, and quick-fill chips */}
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text2)', marginBottom: 5 }}>Anchor Calibration</div>
              {(['A', 'B'] as const).map((pt) => {
                const anchor = pt === 'A' ? calAnchorA : calAnchorB;
                const setAnchor = (pt === 'A' ? setCalAnchorA : setCalAnchorB) as React.Dispatch<React.SetStateAction<Anchor | null>>;
                const picking = calCapture === pt;
                const ready = !!(anchor?.pixelSet && anchor.wx !== '' && anchor.wz !== '');
                return (
                  <div key={pt} style={{
                    marginBottom: 6, padding: '7px 8px', borderRadius: 6,
                    background: 'var(--color-surface2)',
                    border: `1px solid ${picking ? 'var(--color-accent)' : ready ? 'rgba(79,195,161,.35)' : 'var(--color-border)'}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: ready ? 'var(--color-teal)' : 'var(--color-text3)', minWidth: 10 }}>{pt}</span>
                      <button
                        onClick={() => setCalCapture(picking ? null : pt)}
                        className={`btn btn-xs ${picking ? 'btn-primary' : 'btn-ghost'}`}
                        style={{ fontSize: 10, flex: 1 }}
                      >
                        {picking ? 'Click on map…' : anchor?.pixelSet ? '✓ Repick pixel' : 'Pick pixel'}
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 5 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 9, color: 'var(--color-text3)', marginBottom: 1 }}>World X</div>
                        <input type="number" placeholder="X" value={anchor?.wx ?? ''}
                          onChange={e => setAnchor(a => a ? { ...a, wx: e.target.value } : { cx: 0, cy: 0, wx: e.target.value, wz: '' })}
                          style={{ width: '100%', background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 4, padding: '3px 5px', fontSize: 10 }} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 9, color: 'var(--color-text3)', marginBottom: 1 }}>World Z</div>
                        <input type="number" placeholder="Z" value={anchor?.wz ?? ''}
                          onChange={e => setAnchor(a => a ? { ...a, wz: e.target.value } : { cx: 0, cy: 0, wx: '', wz: e.target.value })}
                          style={{ width: '100%', background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 4, padding: '3px 5px', fontSize: 10 }} />
                      </div>
                    </div>
                    {/* Per-anchor quick-fill chips — clicking resets pixel so user re-picks */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                      {(zonePlayers as Array<{ charname?: string; name?: string; pos_x?: number; pos_z?: number }>)
                        .filter(p => p.pos_x != null)
                        .map((p, i) => (
                          <button key={i} className="btn btn-ghost btn-xs" style={{ fontSize: 8, padding: '1px 5px' }}
                            onClick={() => { setAnchor({ cx: 0, cy: 0, wx: String(p.pos_x!.toFixed(2)), wz: String(p.pos_z!.toFixed(2)) }); setCalCapture(pt); }}>
                            ⊙ {p.charname ?? p.name ?? 'Player'}
                          </button>
                        ))}
                      <button className="btn btn-ghost btn-xs" style={{ fontSize: 8, padding: '1px 5px' }}
                        onClick={() => { setAnchor({ cx: 0, cy: 0, wx: '0', wz: '0' }); setCalCapture(pt); }}>
                        ⊙ 0, 0
                      </button>
                    </div>
                  </div>
                );
              })}
              <button
                onClick={computeFromAnchors}
                disabled={!calAnchorA?.pixelSet || !calAnchorB?.pixelSet}
                className="btn btn-primary btn-xs"
                style={{ width: '100%', marginBottom: 10 }}
              >
                Compute &amp; Preview
              </button>

              {/* Scale calibration — anchor A + map image size, no second anchor needed */}
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text2)', marginBottom: 5 }}>Map Scale (Anchor A only)</div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', marginBottom: 10 }}>
                <div style={{ flex: '0 0 72px' }}>
                  <div style={{ fontSize: 9, color: 'var(--color-text3)', marginBottom: 1 }}>Units / pixel</div>
                  <input type="number" step="0.05" value={calScale} onChange={e => setCalScale(e.target.value)}
                    style={{ width: '100%', background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 4, padding: '3px 5px', fontSize: 10 }} />
                </div>
                <button
                  onClick={computeFromScale}
                  disabled={!calAnchorA?.pixelSet || calAnchorA.wx === '' || calAnchorA.wz === ''}
                  className="btn btn-primary btn-xs"
                  style={{ flex: 1 }}
                >
                  Compute from map size
                </button>
              </div>

              {/* Show origin toggle */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--color-text3)', cursor: 'pointer', marginBottom: 10, userSelect: 'none' }}>
                <input type="checkbox" checked={showOrigin}
                  onChange={e => { showOriginRef.current = e.target.checked; setShowOrigin(e.target.checked); }} />
                Show origin (x0, z0)
              </label>

              {/* Manual bounds fine-tune */}
              <div style={{ paddingTop: 8, borderTop: '1px solid var(--color-border)' }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text2)', marginBottom: 5 }}>Bounds</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 6 }}>
                  {(['minX','maxX','minZ','maxZ'] as const).map(k => (
                    <div key={k}>
                      <label style={{ fontSize: 9, color: 'var(--color-text3)', display: 'block', marginBottom: 1 }}>{k}</label>
                      <input type="number" value={calForm[k]} onChange={e => setCalForm(p => ({ ...p, [k]: parseFloat(e.target.value) || 0 }))}
                        style={{ width: '100%', background: 'var(--color-surface2)', border: '1px solid var(--color-border)', color: 'var(--color-text1)', borderRadius: 4, padding: '3px 5px', fontSize: 11 }} />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <button onClick={previewBounds} className="btn btn-ghost btn-xs" style={{ flex: 1 }}>Preview</button>
                  <button onClick={saveCalibration} disabled={calSaving} className="btn btn-primary btn-xs" style={{ flex: 1 }}>{calSaving ? '…' : 'Save'}</button>
                  {calMsg && <span style={{ fontSize: 10, color: calMsg === 'Saved' ? 'var(--color-teal)' : 'var(--color-red)' }}>{calMsg}</span>}
                </div>
              </div>
            </SideSection>
          )}


          {/* Map image upload (admin only) */}
          {zone !== null && user?.tier === 'admin' && (
            <SideSection title="Map Image">
              <input ref={mapUploadRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleMapUpload} style={{ display: 'none' }} />
              <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <button onClick={() => mapUploadRef.current?.click()} className="btn btn-ghost btn-xs" style={{ flex: 1 }}>Upload PNG</button>
                {mapUploadMsg && <span style={{ fontSize: 10, color: mapUploadMsg === 'Uploaded' ? 'var(--color-teal)' : 'var(--color-red)' }}>{mapUploadMsg}</span>}
              </div>
              <div style={{ fontSize: 10, color: 'var(--color-text3)', marginTop: 4 }}>Replaces the map image for this zone.</div>
            </SideSection>
          )}

          {/* Pop watch */}
          <SideSection title="Pop Watch">
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <input className="input" placeholder="Mob name…" value={watchInput} onChange={(e) => setWatchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addWatch()} style={{ fontSize: 11, padding: '4px 8px' }} />
              <button onClick={addWatch} className="btn btn-ghost btn-xs">+</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {watchList.map((w, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'rgba(240,160,80,.07)', border: '1px solid rgba(240,160,80,.15)', color: 'var(--color-gold)' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w}</span>
                  <button onClick={() => removeWatch(i)} style={{ background: 'none', border: 'none', color: 'var(--color-text3)', cursor: 'pointer', fontSize: 12 }}>×</button>
                </div>
              ))}
            </div>
          </SideSection>

          {/* Players in zone */}
          <SideSection title={`Players in Zone (${(zonePlayers as unknown[]).length})`} flex>
            {(zonePlayers as unknown[]).length === 0
              ? <span style={{ fontSize: 11, color: 'var(--color-text3)' }}>No players in zone</span>
              : (zonePlayers as Array<{ charid?: number | null; charname?: string; name?: string; mjob?: number; mlvl?: number; sjob?: number; slvl?: number; hp?: number; mp?: number; pos_x?: number; pos_z?: number }>).map((p, i) => {
                  const label = p.charname ?? p.name ?? 'Player';
                  return (
                  <div key={p.charid ?? i} onClick={() => p.charid && navigate(`/chars/${p.charid}`)}
                    style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '5px 6px', borderRadius: 5, fontSize: 11, cursor: 'pointer' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-surface2)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#7c6af7', flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                      <span style={{ color: 'var(--color-accent)', fontSize: 10, flexShrink: 0 }}>
                        {p.mjob ? `${JOB[p.mjob] ?? '?'}${p.mlvl ?? ''}${(p.sjob ?? 0) > 0 ? `/${JOB[p.sjob!]}${p.slvl}` : ''}` : ''}
                      </span>
                    </div>
                    {((p.hp ?? 0) > 0 || (p.mp ?? 0) > 0) && (
                      <div style={{ display: 'flex', gap: 8, fontSize: 9, color: 'var(--color-text3)' }}>
                        {(p.hp ?? 0) > 0 && <span>♥ <span style={{ color: 'var(--color-teal)' }}>{p.hp}</span></span>}
                        {(p.mp ?? 0) > 0 && <span>♦ <span style={{ color: '#7c9ef7' }}>{p.mp}</span></span>}
                      </div>
                    )}
                  </div>
                  );})
            }
          </SideSection>

          {/* Pop log */}
          {popLog.length > 0 && (
            <SideSection title="Pop Alerts" action={<button onClick={() => setPopLog([])} className="btn btn-ghost btn-xs">clear</button>}>
              <div style={{ maxHeight: 140, overflowY: 'auto' }}>
                <PopLogList log={popLog} onCenter={panToWorld} />
              </div>
            </SideSection>
          )}
        </div>
      )}

      {/* Canvas area */}
      <div
        style={{ flex: 1, position: 'relative', background: '#07070e', overflow: 'hidden', cursor: calCapture ? 'crosshair' : dragRef.current.active && dragRef.current.moved ? 'grabbing' : 'grab' }}
        ref={canvasWrapRef}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerLeave={(e) => { if (dragRef.current.active) onCanvasPointerUp(e); }}
        onDoubleClick={resetView}
      >
        {/* Collapse sidebar btn */}
        <button onClick={() => setSidebarOpen((v) => !v)}
          style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, background: 'rgba(10,10,18,.8)', border: '1px solid var(--color-border)', borderRadius: 6, color: 'var(--color-text2)', padding: '4px 8px', fontSize: 12 }}>
          {sidebarOpen ? '◀' : '▶'}
        </button>

        {/* Coordinate HUD */}
        {zone !== null && (
          <div ref={coordDisplayRef} style={{ position: 'absolute', bottom: 16, left: 16, zIndex: 10, fontFamily: 'monospace', fontSize: 11, color: 'var(--color-text3)', background: 'rgba(10,10,18,.75)', padding: '3px 9px', borderRadius: 5, pointerEvents: 'none', border: '1px solid rgba(255,255,255,.06)', letterSpacing: '.03em' }}>
            x: 0.000 z: 0.000
          </div>
        )}

        {/* Zoom controls */}
        {zone !== null && (
          <div style={{ position: 'absolute', bottom: 16, right: 16, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button onClick={() => { const st = stageTransform.current; const newZoom = Math.min(12, st.zoom * 1.3); const app = appRef.current; if (app) { const cx = app.screen.width/2, cy = app.screen.height/2; st.panX = cx-(cx-st.panX)*(newZoom/st.zoom); st.panY = cy-(cy-st.panY)*(newZoom/st.zoom); } st.zoom = newZoom; applyContainerTransform(); }}
              style={{ width: 28, height: 28, background: 'rgba(10,10,18,.85)', border: '1px solid var(--color-border)', borderRadius: 5, color: 'var(--color-text1)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>+</button>
            <button onClick={() => { const st = stageTransform.current; const newZoom = Math.max(0.15, st.zoom / 1.3); const app = appRef.current; if (app) { const cx = app.screen.width/2, cy = app.screen.height/2; st.panX = cx-(cx-st.panX)*(newZoom/st.zoom); st.panY = cy-(cy-st.panY)*(newZoom/st.zoom); } st.zoom = newZoom; applyContainerTransform(); }}
              style={{ width: 28, height: 28, background: 'rgba(10,10,18,.85)', border: '1px solid var(--color-border)', borderRadius: 5, color: 'var(--color-text1)', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>−</button>
            <button onClick={resetView} title="Reset view (double-click canvas)"
              style={{ width: 28, height: 28, background: 'rgba(10,10,18,.85)', border: '1px solid var(--color-border)', borderRadius: 5, color: 'var(--color-text2)', fontSize: 11, cursor: 'pointer', lineHeight: 1 }}>⊡</button>
          </div>
        )}

        {zone === null && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center', color: 'var(--color-text3)', fontSize: 14 }}>
            Select a zone from the sidebar to load the map
          </div>
        )}

        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />

        {/* Tooltip */}
        <div ref={tipRef} style={{
          display: 'none', position: 'absolute', background: 'rgba(10,10,18,.95)',
          border: '1px solid var(--color-border)', borderRadius: 7, padding: '6px 10px',
          fontSize: 12, pointerEvents: 'none', maxWidth: 180, zIndex: 20,
        }} />

        {/* Toast */}
        {toast && (
          <div style={{
            position: 'absolute', top: 12, right: 12, zIndex: 20,
            background: 'rgba(10,10,18,.95)', border: `1px solid ${toast.color}`,
            borderRadius: 10, padding: '10px 14px', maxWidth: 220,
            animation: 'fadeIn .2s',
          }}>
            <div style={{ fontWeight: 600, color: toast.color, marginBottom: toast.x !== undefined && toast.z !== undefined ? 6 : 0 }}>{toast.msg}</div>
            {toast.x !== undefined && toast.z !== undefined && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                <span style={{ fontSize: 10, color: toast.color, opacity: 0.65 }}>x:{toast.x.toFixed(1)} z:{toast.z?.toFixed(1)}</span>
                <button onClick={() => { panToWorld(toast.x!, toast.z!); setToast(null); }}
                  style={{ fontSize: 11, background: toast.color + '22', border: `1px solid ${toast.color}60`, borderRadius: 5, color: toast.color, padding: '2px 8px', cursor: 'pointer' }}>
                  Go
                </button>
                <button onClick={() => setToast(null)}
                  style={{ fontSize: 11, background: 'none', border: 'none', color: 'var(--color-text3)', padding: '2px 4px', cursor: 'pointer' }}>×</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────
function SideSection({ title, children, action, flex, defaultOpen = true }: { title: string; children: React.ReactNode; action?: React.ReactNode; flex?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: '1px solid var(--color-border)', ...(flex && open ? { flex: 1, overflowY: 'auto' as const, minHeight: 80 } : {}) }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ padding: '8px 12px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.7px', color: 'var(--color-text3)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 8, opacity: 0.5, lineHeight: 1 }}>{open ? '▼' : '▶'}</span>
          {title}
        </span>
        {action && <span onClick={(e) => e.stopPropagation()}>{action}</span>}
      </div>
      {open && <div style={{ padding: '0 12px 10px' }}>{children}</div>}
    </div>
  );
}

function LayerToggle({ active, color, label, onClick, sub, badge }: { active: boolean; color: string; label: string; onClick: () => void; sub?: boolean; badge?: number }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '5px 8px', borderRadius: 6, fontSize: sub ? 11 : 12,
      color: active ? 'var(--color-text1)' : 'var(--color-text3)',
      background: active ? 'var(--color-surface2)' : 'transparent',
      border: `1px solid ${active ? 'rgba(255,255,255,.06)' : 'transparent'}`,
      cursor: 'pointer', userSelect: 'none',
      marginLeft: sub ? 14 : 0,
    }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span style={{ fontSize: 9, color: 'var(--color-text3)', background: 'rgba(255,255,255,.06)', padding: '1px 5px', borderRadius: 3, lineHeight: '14px' }}>
          {badge.toLocaleString()}
        </span>
      )}
    </div>
  );
}

function EvtTimerList({ timers, onRemove }: { timers: EvtTimer[]; onRemove: (id: number) => void }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, []);

  return (
    <>
      {timers.map((t) => {
        const now = Date.now(); const elapsed = now - t.startTs;
        let stateLabel: string, stateColor: string, barPct: number, barColor: string;
        if (elapsed < t.minMs) {
          stateLabel = 'Opens in ' + fmtDur(t.minMs - elapsed); stateColor = 'var(--color-text2)';
          barPct = Math.min(100, elapsed / t.minMs * 100); barColor = 'var(--color-accent)';
        } else if (!t.maxMs || elapsed < t.maxMs) {
          stateLabel = 'OPEN' + (t.maxMs ? ' — ' + fmtDur(t.maxMs - elapsed) + ' left' : ''); stateColor = 'var(--color-teal)';
          barPct = t.maxMs ? Math.min(100, (elapsed - t.minMs) / (t.maxMs - t.minMs) * 100) : 100; barColor = 'var(--color-teal)';
        } else {
          stateLabel = 'CLOSED'; stateColor = 'var(--color-text3)'; barPct = 100; barColor = '#555';
        }
        return (
          <div key={t.id} style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface2)', fontSize: 11 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontWeight: 600, color: 'var(--color-text1)' }}>{t.name}</span>
              <button onClick={() => onRemove(t.id)} style={{ background: 'none', border: 'none', color: 'var(--color-text3)', cursor: 'pointer', fontSize: 12 }}>×</button>
            </div>
            <div style={{ color: 'var(--color-text3)', fontSize: 10, marginBottom: 3 }}>{t.reason}</div>
            <div style={{ fontWeight: 600, color: stateColor, marginBottom: 4 }}>{stateLabel}</div>
            <div style={{ height: 3, borderRadius: 2, background: 'var(--color-surface3)', overflow: 'hidden' }}>
              <div style={{ width: `${barPct.toFixed(1)}%`, height: '100%', background: barColor, borderRadius: 2, transition: 'width .9s linear' }} />
            </div>
          </div>
        );
      })}
    </>
  );
}

function PopLogList({ log, onCenter }: { log: PopEntry[]; onCenter?: (x: number, z: number) => void }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 10000); return () => clearInterval(id); }, []);
  const now = Date.now();
  return (
    <>
      {log.map((p, i) => {
        const s = Math.round((now - p.ts) / 1000);
        const age = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
        const canCenter = p.pos_x != null && onCenter;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,.03)', fontSize: 11 }}>
            <span style={{ color: p.watched ? 'var(--color-amber)' : 'var(--color-red)', fontSize: 9, flexShrink: 0 }}>{p.watched ? '★' : '▲'}</span>
            <span
              onClick={() => canCenter && onCenter!(p.pos_x!, p.pos_z!)}
              title={canCenter ? `Go to x:${p.pos_x!.toFixed(1)} z:${p.pos_z!.toFixed(1)}` : undefined}
              style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: p.watched ? 'var(--color-amber)' : 'var(--color-text1)', cursor: canCenter ? 'pointer' : 'default' }}>
              {p.name}
            </span>
            <span style={{ color: 'var(--color-text3)', fontSize: 10, flexShrink: 0 }}>{age}</span>
          </div>
        );
      })}
    </>
  );
}
