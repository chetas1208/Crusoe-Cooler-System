import { create } from 'zustand';
import { useWorld } from '@loopkeeper/core/store';
import type { Vec3 } from '@loopkeeper/core/contracts';
import { clamp } from '@loopkeeper/core';
import { fitCamera, measureInsets, OVERVIEW_VIEW, overviewBoxes } from './fit';
import { siteModel } from './siteModel';

export type ViewMode = 'facility' | 'pipe' | 'agents';
export type PipeCam = 'front' | 'section';
/** User-facing quality choice. Presets change rendering cost only (DPR, shadows, pipe tessellation, effects) — never simulated robots, topology or physics. */
export type QualityPreset = 'auto' | 'high' | 'balanced' | 'performance';
export type QualityTier = 'high' | 'medium' | 'low';
export const PRESET_TIER: Record<Exclude<QualityPreset, 'auto'>, QualityTier> = { high: 'high', balanced: 'medium', performance: 'low' };
export const TIER_PRESET: Record<QualityTier, Exclude<QualityPreset, 'auto'>> = { high: 'high', medium: 'balanced', low: 'performance' };

export interface Layers {
  roof: boolean;
  walls: boolean;
  floor: boolean;
  service: boolean;
  facility_water: boolean;
  technology_cooling: boolean;
  sensors: boolean;
  robots: boolean;
  thermal: boolean;
  flow: boolean;
  labels: boolean;
  /** cabinet rows (solver racks + architectural cabinets) */
  rows: boolean;
  /** robot roads / aisles painted on the floor */
  roads: boolean;
  tcs_supply: boolean;
  tcs_return: boolean;
  /** emphasise what a robot can reach: passable pipe segments, docks and ports; dim the rest */
  robot_access: boolean;
}

export interface CamGoal {
  /** radians, 0 = looking from +z toward -z, positive swings toward +x */
  azimuth: number;
  /** radians above the ground plane */
  elevation: number;
  distance: number;
  target: Vec3;
  fov: number;
}

export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Notice {
  id: number;
  text: string;
  tone: 'info' | 'warn';
}

/** fallback only (before a topology exists): looks at the middle of the v6 hall. Real framing is fitCamera() on the manifest box. */
export const DEFAULT_CAM: CamGoal = { azimuth: 0.2, elevation: 1.15, distance: 46, target: [2.75, 1.0, 0], fov: 32 };

/** Camera goal framing a topology-derived box (default: the whole hall) in the area the panels leave free. */
function fitGoal(box?: { min: Vec3; max: Vec3 }, o?: { azimuth?: number; elevation?: number; fill?: number }): CamGoal | null {
  const topo = useWorld.getState().topology;
  if (!topo || typeof window === 'undefined') return null;
  return fitCamera({ boxes: box ? [box] : overviewBoxes(topo), width: window.innerWidth, height: window.innerHeight, insets: measureInsets(), ...OVERVIEW_VIEW, ...o });
}

function roomBox(kinds: string[]): { min: Vec3; max: Vec3 } | undefined {
  const topo = useWorld.getState().topology;
  if (!topo) return undefined;
  const r = siteModel(topo).rooms.find((x) => kinds.includes(x.kind));
  return r ? { min: [r.rect[0], 0, r.rect[1]], max: [r.rect[2], 3.4, r.rect[3]] } : undefined;
}

const DEG = Math.PI / 180;
export const CAM_LIMITS = { minEl: 6 * DEG, maxEl: 86 * DEG, minDist: 1.6, maxDist: 52 };

export interface ViewState {
  mode: ViewMode;
  selectedId: string | null;
  hoverId: string | null;
  followRobotId: string | null;
  layers: Layers;
  xray: boolean;
  cam: CamGoal;
  insets: Insets;
  pipeEdgeId: string | null;
  pipeCam: PipeCam;
  /** probe position (m along the segment) used when no crawler is inside the segment */
  pipeProbeS: number | null;
  focusedIncidentId: string | null;
  /** road being inspected (siteModel road id); brightens its floor paint */
  roadFocus: string | null;
  notice: Notice | null;
  reducedMotion: boolean;
  /** applied tier (what the renderer reads); under preset 'auto' the AutoQuality controller moves it */
  quality: QualityTier;
  /** the operator's choice */
  qualityPreset: QualityPreset;
  /** bumps whenever a camera move should be treated as cinematic (not user-driven) */
  camNonce: number;

  setMode(m: ViewMode): void;
  select(id: string | null): void;
  hover(id: string | null): void;
  setLayer<K extends keyof Layers>(k: K, v: boolean): void;
  toggleXray(): void;
  orbit(dAz: number, dEl: number): void;
  zoom(factor: number): void;
  pan(dx: number, dz: number): void;
  setCam(partial: Partial<CamGoal>): void;
  setInsets(i: Partial<Insets>): void;
  focusEntity(id: string, opts?: { distance?: number }): void;
  resetCamera(): void;
  preset(name: 'whole' | 'plant' | 'zone_a' | 'zone_b' | 'skeleton' | 'exterior' | 'structure' | 'cooling' | 'racks' | 'pipe'): void;
  follow(robotId: string | null): void;
  enterPipe(edgeId: string, robotId?: string | null): boolean;
  exitPipe(): void;
  setPipeCam(c: PipeCam): void;
  setPipeProbe(s: number | null): void;
  focusIncident(id: string | null): void;
  setRoadFocus(id: string | null): void;
  say(text: string, tone?: 'info' | 'warn'): void;
  setQuality(q: QualityTier): void;
  setPreset(p: QualityPreset): void;
  setReducedMotion(v: boolean): void;
  native4k: boolean;
  setNative4k(v: boolean): void;
  toggle4k(): void;
}

const LAYERS: Layers = {
  roof: false,
  walls: false,
  floor: true,
  service: true,
  facility_water: true,
  technology_cooling: true,
  sensors: true,
  robots: true,
  thermal: true,
  flow: true,
  labels: true,
  rows: true,
  roads: true,
  tcs_supply: true,
  tcs_return: true,
  robot_access: false,
};

let noticeSeq = 0;

/** Where should the camera look for a given entity id? */
export function entityFocus(id: string): { target: Vec3; distance: number } | null {
  const w = useWorld.getState();
  const topo = w.topology;
  if (!topo) return null;
  const robot = w.robots[id];
  if (robot) return { target: [...robot.pose.position_xyz_m] as Vec3, distance: robot.class === 'inpipe' ? 3.2 : 4.5 };
  const zone = topo.zones.find((z) => z.id === id);
  if (zone) return { target: [zone.anchor_xyz_m[0] + 0.5, 1.6, zone.anchor_xyz_m[2]], distance: 10 };
  const a = w.assetsById[id];
  if (a) {
    const h = a.size_m?.[1] ?? 0.6;
    const dist: Record<string, number> = { rack: 5.2, cdu: 6.8, pump: 3.6, valve: 3.0, strainer: 3.4, sensor: 2.8, port: 3.0, chiller: 11, dock: 4.5 };
    const y = a.type === 'rack' || a.type === 'cdu' || a.type === 'chiller' ? h / 2 : a.position_xyz_m[1];
    return { target: [a.position_xyz_m[0], y, a.position_xyz_m[2]], distance: dist[a.type] ?? 4 };
  }
  const e = w.edgesById[id];
  if (e) {
    const fault = w.assets[id]?.fault?.location_s_m;
    const pts = e.centerline_xyz_m;
    // point at arc-length fraction along the polyline (cheap: by vertex index fraction)
    const f = fault && e.length_m ? clamp(fault / e.length_m, 0.05, 0.95) : 0.5;
    const idx = f * (pts.length - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, pts.length - 1);
    const t = idx - i0;
    const p: Vec3 = [pts[i0][0] + (pts[i1][0] - pts[i0][0]) * t, pts[i0][1] + (pts[i1][1] - pts[i0][1]) * t, pts[i0][2] + (pts[i1][2] - pts[i0][2]) * t];
    return { target: p, distance: clamp(e.length_m * 0.95, 6.5, 13) };
  }
  return null;
}

export const useView = create<ViewState>()((set, get) => ({
  mode: 'facility',
  selectedId: null,
  hoverId: null,
  followRobotId: null,
  layers: LAYERS,
  xray: false,
  cam: DEFAULT_CAM,
  insets: { left: 0, right: 0, top: 0, bottom: 0 },
  pipeEdgeId: null,
  pipeCam: 'front',
  pipeProbeS: null,
  focusedIncidentId: null,
  roadFocus: null,
  notice: null,
  reducedMotion: false,
  quality: 'high',
  qualityPreset: 'auto',
  camNonce: 0,

  setMode: (m) => {
    const s = get();
    if (m === s.mode) return;
    if (m === 'pipe') {
      // enter the selected passable segment, or the segment the followed crawler is in
      const w = useWorld.getState();
      const robot = s.followRobotId ? w.robots[s.followRobotId] : Object.values(w.robots).find((r) => r.class === 'inpipe' && r.mode !== 'DOCKED');
      const sel = s.selectedId && w.edgesById[s.selectedId]?.robot_passable ? s.selectedId : null;
      const incidentEdge = Object.values(w.incidents).find((i) => !i.closed_tick && w.edgesById[i.anchor.entity_id]?.robot_passable)?.anchor.entity_id;
      const passable = Object.values(w.edgesById).find((e) => e.robot_passable)?.id;
      const edge = sel ?? robot?.pose.segment_id ?? incidentEdge ?? passable ?? null;
      if (!edge) {
        s.say('Pick a serviceable pipe (or follow a crawler) first — only robot-passable segments can be entered.', 'warn');
        return;
      }
      get().enterPipe(edge, robot?.class === 'inpipe' ? robot.id : null);
      return;
    }
    if (s.mode === 'pipe') set({ pipeEdgeId: null });
    set({ mode: m, camNonce: s.camNonce + 1 });
    if (m === 'agents') {
      // agent operations are anchored to an incident: focus the one in play (or the most severe open one)
      const w = useWorld.getState();
      const all = Object.values(w.incidents);
      const rank = { critical: 3, warning: 2, watch: 1, nominal: 0 } as const;
      const open = all.filter((i) => !i.closed_tick).sort((a, b) => rank[b.severity] - rank[a.severity] || b.opened_tick - a.opened_tick);
      const current = s.focusedIncidentId ? w.incidents[s.focusedIncidentId] : undefined;
      const pick = current ?? open[0] ?? all.sort((a, b) => b.opened_tick - a.opened_tick)[0];
      if (pick) get().focusIncident(pick.id);
    }
  },

  select: (id) => set({ selectedId: id }),
  hover: (id) => set({ hoverId: id }),
  setLayer: (k, v) => set((s) => ({ layers: { ...s.layers, [k]: v } })),
  toggleXray: () => set((s) => ({ xray: !s.xray, layers: { ...s.layers, roof: s.xray ? s.layers.roof : false } })),

  orbit: (dAz, dEl) =>
    set((s) => ({ cam: { ...s.cam, azimuth: s.cam.azimuth + dAz, elevation: clamp(s.cam.elevation + dEl, CAM_LIMITS.minEl, CAM_LIMITS.maxEl) }, followRobotId: s.mode === 'pipe' ? s.followRobotId : s.followRobotId })),
  zoom: (f) => set((s) => ({ cam: { ...s.cam, distance: clamp(s.cam.distance * f, CAM_LIMITS.minDist, CAM_LIMITS.maxDist) } })),
  pan: (dx, dz) =>
    set((s) => {
      // pan on the ground plane relative to the current azimuth
      const c = Math.cos(s.cam.azimuth);
      const si = Math.sin(s.cam.azimuth);
      const k = s.cam.distance * 0.0016;
      return {
        followRobotId: null,
        cam: { ...s.cam, target: [clamp(s.cam.target[0] + (dx * c + dz * si) * k, -14, 12), s.cam.target[1], clamp(s.cam.target[2] + (-dx * si + dz * c) * k, -10, 8)] },
      };
    }),
  setCam: (partial) => set((s) => ({ cam: { ...s.cam, ...partial }, camNonce: s.camNonce + 1 })),
  setInsets: (i) => set((s) => ({ insets: { ...s.insets, ...i } })),

  focusEntity: (id, opts) => {
    const f = entityFocus(id);
    if (!f) {
      get().say('That item has no position in the facility model.', 'warn');
      return;
    }
    set((s) => ({ cam: { ...s.cam, target: f.target, distance: opts?.distance ?? f.distance, elevation: clamp(Math.max(s.cam.elevation, 0.5), CAM_LIMITS.minEl, 1.1) }, followRobotId: null, camNonce: s.camNonce + 1 }));
  },

  resetCamera: () => set((s) => ({ cam: fitGoal() ?? DEFAULT_CAM, followRobotId: null, camNonce: s.camNonce + 1, selectedId: null })),

  preset: (name) => {
    if (name === 'pipe') {
      get().setMode('pipe');
      return;
    }
    const hall = roomBox(['hall']);
    const mech = roomBox(['mechanical']);
    const presets: Record<string, CamGoal> = {
      whole: fitGoal() ?? DEFAULT_CAM,
      structure: fitGoal() ?? DEFAULT_CAM,
      exterior: fitGoal(undefined, { azimuth: 0.65, elevation: 0.42 }) ?? DEFAULT_CAM,
      cooling: fitGoal(undefined, { azimuth: 0.35, elevation: 0.95 }) ?? DEFAULT_CAM,
      skeleton: fitGoal(undefined, { azimuth: 0.35, elevation: 0.95 }) ?? DEFAULT_CAM,
      racks: fitGoal(hall, { azimuth: 0.38, elevation: 0.8, fill: 0.85 }) ?? DEFAULT_CAM,
      zone_a: fitGoal(hall, { azimuth: 0.38, elevation: 0.8, fill: 0.85 }) ?? DEFAULT_CAM,
      zone_b: fitGoal(hall, { azimuth: 0.38, elevation: 0.8, fill: 0.85 }) ?? DEFAULT_CAM,
      plant: fitGoal(mech, { azimuth: 0.88, elevation: 0.7, fill: 0.85 }) ?? DEFAULT_CAM,
    };
    const goal = presets[name] ?? DEFAULT_CAM;
    const isXray = name === 'cooling' || name === 'skeleton';
    const isExterior = name === 'exterior';
    set((s) => ({
      cam: goal,
      followRobotId: null,
      camNonce: s.camNonce + 1,
      layers: {
        ...s.layers,
        roof: isExterior,
        walls: isExterior || name === 'whole' || name === 'structure',
      },
      xray: isXray,
    }));
  },

  follow: (robotId) => {
    set((s) => ({ followRobotId: robotId, camNonce: s.camNonce + 1 }));
    if (robotId) get().say(`Following ${robotId.toUpperCase().replace('_', '-')} — drag to orbit, Esc to release.`);
  },

  enterPipe: (edgeId, robotId) => {
    const w = useWorld.getState();
    const e = w.edgesById[edgeId];
    if (!e) return false;
    if (!e.robot_passable) {
      get().say(`${e.label} cannot be entered: ${e.not_passable_reason ?? 'not robot-passable'}`, 'warn');
      return false;
    }
    set((s) => ({ mode: 'pipe', pipeEdgeId: edgeId, pipeProbeS: null, followRobotId: robotId ?? s.followRobotId, selectedId: edgeId, camNonce: s.camNonce + 1, pipeCam: s.pipeCam }));
    return true;
  },

  exitPipe: () => set((s) => ({ mode: 'facility', pipeEdgeId: null, camNonce: s.camNonce + 1 })),
  setPipeCam: (c) => set({ pipeCam: c }),
  setPipeProbe: (s) => set({ pipeProbeS: s }),
  setRoadFocus: (roadFocus) => set({ roadFocus }),
  focusIncident: (id) => {
    set({ focusedIncidentId: id });
    if (id) {
      const inc = useWorld.getState().incidents[id];
      if (inc) {
        // incidents are about context (the hardware *and* its neighbours) — never zoom closer than ~8 m
        const f = entityFocus(inc.anchor.entity_id);
        get().focusEntity(inc.anchor.entity_id, { distance: Math.max(f?.distance ?? 8, get().mode === 'agents' ? 22 : 14) });
      }
    }
  },
  say: (text, tone = 'info') => set({ notice: { id: ++noticeSeq, text, tone } }),
  setQuality: (q) => set({ quality: q }),
  setPreset: (p) => set(p === 'auto' ? { qualityPreset: p } : { qualityPreset: p, quality: PRESET_TIER[p] }),
  setReducedMotion: (v) => set({ reducedMotion: v }),
  native4k: false,
  setNative4k: (v) => set({ native4k: v }),
  toggle4k: () => set((s) => ({ native4k: !s.native4k })),
}));
