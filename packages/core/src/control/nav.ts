/**
 * V12 navigation client + operator route session (backend: api/routes_nav.py, nav/navigator.py).
 *
 * - `HttpNavApi`: typed REST client for graphs, reachability, route plan / commit / cancel and traffic. Server refusals RESOLVE
 *   with `{ok:false, refusal}` carrying the server's reason code and detail VERBATIM (NO_ACCESS, TURN_RADIUS, EQUIPMENT_BLOCK,
 *   RESERVATION_CONFLICT, PRESSURE_UNSAFE, BATTERY, PIPE_CLEARANCE, STALE_*, LEASE_REQUIRED ...). Transport failures resolve with
 *   reason `NETWORK` so the UI never mistakes "no answer" for "refused" and never invents a route.
 * - `useNav`: destination-mode state machine (select -> plan -> preview -> commit -> follow -> pause / reroute / cancel), the
 *   traffic markers, and the latest authoritative graph / traffic revisions. Everything shown is what the server reported:
 *   a preview is a preview (nothing reserved), a committed route is only "following" after the server accepted the commit.
 */
import { create } from 'zustand';
import type { Vec3 } from '../contracts';
import { authFetch } from '../client/auth';
import { controlActions, controlHooks, useControl } from './session';
import { useWorld } from '../store/world';

/* ───────────────────────────── contract ───────────────────────────── */

/** Refusal reasons the planner can give (nav/reasons.py), shown verbatim. */
export const NAV_DENIAL_REASONS = ['NO_ACCESS', 'TURN_RADIUS', 'EQUIPMENT_BLOCK', 'RESERVATION_CONFLICT', 'PRESSURE_UNSAFE', 'BATTERY', 'PIPE_CLEARANCE'] as const;
export type NavDenialReason = (typeof NAV_DENIAL_REASONS)[number];

export interface NavRefusal {
  /** server reason code, or NETWORK when no answer came back */
  reason: string;
  detail: string;
  graph_revision?: string;
  traffic_revision?: number;
  blocked_by?: unknown;
  owner?: string;
  http_status?: number;
}

export interface RoutePlan {
  plan_id: string;
  robot_id: string;
  kind: 'exterior' | 'interior';
  target: string;
  /** world-frame polyline (x, y, z), start to target */
  waypoints: Vec3[] | null;
  nodes?: string[];
  edges?: string[];
  length_m: number;
  eta_s: number;
  wait_s: number;
  depart_t: number;
  arrive_t: number;
  valid_until: number;
  battery_needed_pct?: number;
  graph_revision: string;
  traffic_revision: number;
}

export interface RouteCommitted {
  plan_id: string;
  robot_id: string;
  eta_s?: number;
  length_m?: number;
  depart_t?: number;
  arrive_t?: number;
  graph_revision: string;
  traffic_revision: number;
}

export type NavResult<T> = { ok: true; value: T } | { ok: false; refusal: NavRefusal };

export interface GraphNode {
  id: string;
  kinds?: string[];
  x?: number;
  z?: number;
  position_xyz_m?: Vec3;
  road_id?: string;
  label?: string;
}
export interface GraphEdge {
  id: string;
  a: string;
  b: string;
  kind?: string;
  centerline_xz_m?: Array<[number, number]>;
  centerline_xyz_m?: Vec3[];
  length_m?: number;
  road_id?: string;
}
export interface NavGraph {
  kind: 'exterior' | 'interior';
  graph_revision: string;
  traffic_revision?: number;
  closed_edges: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Reachability {
  reachable: boolean;
  length_m?: number;
  eta_s?: number;
  via?: string[];
  graph_revision: string;
  traffic_revision: number;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpNavApi {
  private base: string;
  constructor(
    baseUrl: string,
    private runId = 'current',
    private fetcher: Fetcher = authFetch as Fetcher,
    private timeoutMs = 4000,
  ) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  private url(path: string) {
    return `${this.base}/api/v1/runs/${encodeURIComponent(this.runId)}/${path}`;
  }

  private async call(path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> } | NavRefusal> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
    try {
      const res = await this.fetcher(this.url(path), {
        ...init,
        headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: ctl?.signal,
      });
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { reason: 'NETWORK', detail: `${path} -> ${res.status} (unreadable response)`, http_status: res.status };
      }
      if (!json || typeof json !== 'object') return { reason: 'NETWORK', detail: `${path} -> ${res.status}`, http_status: res.status };
      return { status: res.status, json: json as Record<string, unknown> };
    } catch (err) {
      return { reason: 'NETWORK', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private refusalOf(status: number, j: Record<string, unknown>): NavRefusal {
    // FastAPI HTTPException bodies carry `detail` only; navigation refusals carry reason + detail
    const reason = typeof j.reason === 'string' ? j.reason : status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : `HTTP_${status}`;
    const detail = typeof j.detail === 'string' ? j.detail : typeof j.reason === 'string' && j.detail === undefined ? j.reason : JSON.stringify(j.detail ?? j);
    return {
      reason,
      detail,
      graph_revision: typeof j.graph_revision === 'string' ? j.graph_revision : undefined,
      traffic_revision: typeof j.traffic_revision === 'number' ? j.traffic_revision : undefined,
      blocked_by: j.blocked_by,
      owner: typeof j.owner === 'string' ? j.owner : undefined,
      http_status: status,
    };
  }

  private async result<T>(path: string, init: RequestInit | undefined, pick: (j: Record<string, unknown>) => T): Promise<NavResult<T>> {
    const r = await this.call(path, init);
    if ('reason' in r) return { ok: false, refusal: r };
    const { status, json } = r;
    if (status >= 400 || json.accepted === false || json.ok === false) return { ok: false, refusal: this.refusalOf(status, json) };
    return { ok: true, value: pick(json) };
  }

  graphs(kind: 'exterior' | 'interior'): Promise<NavResult<NavGraph>> {
    return this.result(`navigation/graphs?kind=${kind}`, undefined, (j) => j as unknown as NavGraph);
  }

  reachability(robotId: string, targetId: string): Promise<NavResult<Reachability>> {
    return this.result(`navigation/reachability?robot_id=${encodeURIComponent(robotId)}&target_id=${encodeURIComponent(targetId)}`, undefined, (j) => j as unknown as Reachability);
  }

  traffic(): Promise<NavResult<Record<string, unknown>>> {
    return this.result('navigation/traffic', undefined, (j) => j);
  }

  plan(robotId: string, target: string | { x: number; z: number }): Promise<NavResult<RoutePlan>> {
    return this.result(`robots/${encodeURIComponent(robotId)}/route/plan`, { method: 'POST', body: JSON.stringify({ target }) }, (j) => j as unknown as RoutePlan);
  }

  commit(robotId: string, p: { plan_id: string; graph_revision: string; traffic_revision: number; lease_id?: string | null; idempotency_key?: string }): Promise<NavResult<RouteCommitted>> {
    const body: Record<string, unknown> = { plan_id: p.plan_id, graph_revision: p.graph_revision, traffic_revision: p.traffic_revision };
    if (p.lease_id) body.lease_id = p.lease_id;
    if (p.idempotency_key) body.idempotency_key = p.idempotency_key;
    return this.result(`robots/${encodeURIComponent(robotId)}/route/commit`, { method: 'POST', body: JSON.stringify(body) }, (j) => j as unknown as RouteCommitted);
  }

  cancel(robotId: string, reason = 'operator'): Promise<NavResult<{ cancelled: boolean; plan_id?: string }>> {
    return this.result(`robots/${encodeURIComponent(robotId)}/route/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }, (j) => j as unknown as { cancelled: boolean; plan_id?: string });
  }
}

/* ───────────────────────────── stream events ───────────────────────────── */

/** Event types this module consumes (all carry `entity_id`, `seq`, `payload.graph_revision`). */
export const NAV_EVENT_TYPES = ['robot.route_planned', 'robot.route_committed', 'robot.route_replanned', 'robot.route_cancelled', 'robot.route_paused', 'robot.arrived', 'traffic.reservation', 'traffic.yield', 'traffic.blocked', 'nav.graph_changed'] as const;
export const isNavEvent = (t: string) => (NAV_EVENT_TYPES as readonly string[]).includes(t);

export interface NavStreamEvent {
  type: string;
  seq?: number;
  sim_time_s?: number;
  entity_id?: string;
  payload: Record<string, unknown>;
}

/* ───────────────────────────── session store ───────────────────────────── */

export type NavPhase = 'idle' | 'selecting' | 'planning' | 'planned' | 'committing' | 'following' | 'paused' | 'arrived' | 'refused';

export interface TrafficMark {
  robot_id: string;
  kind: 'yield' | 'blocked';
  /** robot being given way to (yield) or the deadlock cycle (blocked) */
  to?: string;
  reason?: string;
  detail?: string;
  at: number;
}

export interface ActiveRoute {
  robot_id: string;
  plan_id: string;
  target?: string;
  eta_s?: number;
  length_m?: number;
  edges: string[];
  status: 'committed' | 'paused' | 'replanned';
  source?: string;
}

export interface NavState {
  phase: NavPhase;
  robotId: string | null;
  target: string | null;
  plan: RoutePlan | null;
  committed: RouteCommitted | null;
  refusal: NavRefusal | null;
  arrived: { plan_id: string; eta_s?: number; actual_s?: number; at: number } | null;
  graphRevision: string | null;
  trafficRevision: number | null;
  graphs: { exterior?: NavGraph; interior?: NavGraph };
  routes: Record<string, ActiveRoute>;
  traffic: Record<string, TrafficMark>;
  /** set when the stream announced a graph change we have not re-read yet */
  graphStale: boolean;
}

const initial: NavState = {
  phase: 'idle',
  robotId: null,
  target: null,
  plan: null,
  committed: null,
  refusal: null,
  arrived: null,
  graphRevision: null,
  trafficRevision: null,
  graphs: {},
  routes: {},
  traffic: {},
  graphStale: false,
};

export const useNav = create<NavState>()(() => initial);
const set = (p: Partial<NavState> | ((s: NavState) => Partial<NavState>)) => useNav.setState(p as Partial<NavState>);
const get = () => useNav.getState();

let api: HttpNavApi | null = null;
/** Test seam / transport wiring. */
export const setNavApi = (a: HttpNavApi | null) => {
  api = a;
};
function navApi(): HttpNavApi | null {
  if (api) return api;
  const url = useWorld.getState().transport?.url;
  if (!url) return null;
  api = new HttpNavApi(url);
  return api;
}

const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `nav_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);

const NO_API: NavRefusal = { reason: 'NETWORK', detail: 'This backend does not offer the navigation API (or is not connected).' };

export function applyNavEvent(e: NavStreamEvent) {
  const p = e.payload ?? {};
  const rid = (typeof p.robot_id === 'string' ? p.robot_id : e.entity_id) ?? '';
  const rev = typeof p.graph_revision === 'string' ? p.graph_revision : undefined;
  const trev = typeof p.traffic_revision === 'number' ? p.traffic_revision : undefined;
  if (rev || trev !== undefined) set((s) => ({ graphRevision: rev ?? s.graphRevision, trafficRevision: trev ?? s.trafficRevision }));
  const mine = (pid: unknown) => {
    const s = get();
    return s.robotId === rid && (s.committed?.plan_id === pid || s.plan?.plan_id === pid);
  };
  switch (e.type) {
    case 'robot.route_committed':
    case 'robot.route_replanned': {
      const r: ActiveRoute = {
        robot_id: rid,
        plan_id: String(p.plan_id),
        target: typeof p.target === 'string' ? p.target : undefined,
        eta_s: typeof p.eta_s === 'number' ? p.eta_s : undefined,
        length_m: typeof p.length_m === 'number' ? p.length_m : undefined,
        edges: Array.isArray(p.edges) ? (p.edges as string[]) : [],
        status: e.type === 'robot.route_replanned' ? 'replanned' : 'committed',
        source: typeof p.source === 'string' ? p.source : undefined,
      };
      set((s) => ({ routes: { ...s.routes, [rid]: r }, ...(mine(p.plan_id) && s.phase !== 'paused' ? { phase: 'following' as NavPhase } : {}) }));
      return;
    }
    case 'robot.route_paused':
      set((s) => ({ routes: s.routes[rid] ? { ...s.routes, [rid]: { ...s.routes[rid], status: 'paused' } } : s.routes, ...(s.robotId === rid && s.phase === 'following' ? { phase: 'paused' as NavPhase } : {}) }));
      return;
    case 'robot.route_cancelled': {
      set((s) => {
        const routes = { ...s.routes };
        delete routes[rid];
        const traffic = { ...s.traffic };
        delete traffic[rid];
        return { routes, traffic, ...(s.robotId === rid && (s.phase === 'following' || s.phase === 'paused') ? { phase: 'idle' as NavPhase, committed: null, plan: null, target: null } : {}) };
      });
      return;
    }
    case 'robot.arrived': {
      set((s) => {
        const routes = { ...s.routes };
        delete routes[rid];
        const traffic = { ...s.traffic };
        delete traffic[rid];
        const arrived = { plan_id: String(p.plan_id ?? ''), eta_s: typeof p.eta_s === 'number' ? p.eta_s : undefined, actual_s: typeof p.actual_s === 'number' ? p.actual_s : undefined, at: Date.now() };
        return { routes, traffic, ...(s.robotId === rid ? { phase: 'arrived' as NavPhase, arrived, committed: null } : {}) };
      });
      return;
    }
    case 'traffic.yield':
      set((s) => ({ traffic: { ...s.traffic, [rid]: { robot_id: rid, kind: 'yield', to: typeof p.to === 'string' ? p.to : undefined, reason: typeof p.strategy === 'string' ? p.strategy : undefined, at: Date.now() } } }));
      return;
    case 'traffic.blocked':
      set((s) => ({
        traffic: {
          ...s.traffic,
          [rid]: { robot_id: rid, kind: 'blocked', to: Array.isArray(p.cycle) ? (p.cycle as string[]).join(' > ') : undefined, reason: typeof p.reason === 'string' ? p.reason : undefined, detail: typeof p.detail === 'string' ? p.detail : undefined, at: Date.now() },
        },
      }));
      return;
    case 'traffic.reservation':
      // a release means the hold that caused a yield / block is gone
      if (p.action === 'released' || p.action === 'expired') set((s) => (s.traffic[rid] ? { traffic: Object.fromEntries(Object.entries(s.traffic).filter(([k]) => k !== rid)) } : {}));
      return;
    case 'nav.graph_changed':
      set({ graphStale: true, graphs: {} });
      return;
  }
}

/** Subscribe to nav events dispatched by the live transport (window event `lk-nav-event`). Returns teardown. */
export function bindNavEvents(): () => void {
  const w = (globalThis as { addEventListener?: (t: string, h: (e: unknown) => void) => void; removeEventListener?: (t: string, h: (e: unknown) => void) => void });
  if (!w.addEventListener || !w.removeEventListener) return () => undefined;
  const h = (ev: unknown) => applyNavEvent((ev as { detail: NavStreamEvent }).detail);
  w.addEventListener('lk-nav-event', h);
  return () => w.removeEventListener?.('lk-nav-event', h);
}

/** Staleness: if the world stream is gone, whatever route is on screen is stale; say so instead of animating it. */
export const navLinkLive = () => {
  const w = useWorld.getState();
  return w.connection === 'live' && !w.stale;
};

async function loadGraph(kind: 'exterior' | 'interior') {
  const a = navApi();
  if (!a) return null;
  const r = await a.graphs(kind);
  if (!r.ok) return null;
  set((s) => ({ graphs: { ...s.graphs, [kind]: r.value }, graphRevision: r.value.graph_revision, trafficRevision: r.value.traffic_revision ?? s.trafficRevision, graphStale: false }));
  return r.value;
}

/** Arm destination mode for a robot: loads the graph of its class so reachable nodes can be offered. */
async function begin(robotId: string) {
  const robot = useWorld.getState().robots[robotId];
  if (!robot) return;
  set({ phase: 'selecting', robotId, target: null, plan: null, committed: null, refusal: null, arrived: null });
  await loadGraph(robot.class === 'inpipe' ? 'interior' : 'exterior');
}

async function planTo(target: string | { x: number; z: number }) {
  const s = get();
  if (!s.robotId) return;
  const a = navApi();
  if (!a) return set({ phase: 'refused', refusal: NO_API });
  const robotId = s.robotId;
  set({ phase: 'planning', target: typeof target === 'string' ? target : `(${target.x.toFixed(1)}, ${target.z.toFixed(1)})`, plan: null, refusal: null, committed: null, arrived: null });
  const r = await a.plan(robotId, target);
  if (get().robotId !== robotId || get().phase !== 'planning') return; // superseded
  if (!r.ok) return set({ phase: 'refused', refusal: r.refusal, plan: null, ...(r.refusal.graph_revision ? { graphRevision: r.refusal.graph_revision } : {}) });
  set({ phase: 'planned', plan: r.value, refusal: null, graphRevision: r.value.graph_revision, trafficRevision: r.value.traffic_revision });
}

/** Commit the previewed plan. Under a manual lease the lease id travels with it; the server decides, we only show its answer. */
async function commit() {
  const s = get();
  if (s.phase !== 'planned' || !s.plan || !s.robotId) return;
  const a = navApi();
  if (!a) return set({ phase: 'refused', refusal: NO_API });
  const ctl = useControl.getState();
  const lease = ctl.robotId === s.robotId && ctl.leaseId ? ctl.leaseId : null;
  const plan = s.plan;
  set({ phase: 'committing' });
  // the server only follows a destination for a MANUAL robot: under a fresh lease it stays LEASE_PENDING until the first intent is acked
  if (lease) {
    const t0 = Date.now();
    while (useControl.getState().ack === null && useControl.getState().leaseId === lease && Date.now() - t0 < 2500) await new Promise((r) => setTimeout(r, 50));
  }
  const r = await a.commit(s.robotId, { plan_id: plan.plan_id, graph_revision: plan.graph_revision, traffic_revision: plan.traffic_revision, lease_id: lease, idempotency_key: uuid() });
  if (get().phase !== 'committing') return;
  if (!r.ok) return set({ phase: 'refused', refusal: r.refusal });
  // the stream's robot.route_committed may already have moved us to `following`; both mean the server accepted
  set((st) => ({ phase: st.phase === 'committing' ? 'following' : st.phase, committed: r.value, refusal: null, graphRevision: r.value.graph_revision, trafficRevision: r.value.traffic_revision }));
}

async function cancel(reason = 'operator') {
  const s = get();
  if (!s.robotId) return;
  const a = navApi();
  const robotId = s.robotId;
  if (s.phase === 'following' || s.phase === 'paused' || s.phase === 'committing') {
    if (!a) return set({ refusal: NO_API });
    const r = await a.cancel(robotId, reason);
    if (!r.ok) return set({ phase: 'refused', refusal: r.refusal });
  }
  set((st) => {
    const routes = { ...st.routes };
    delete routes[robotId];
    return { phase: 'idle', plan: null, committed: null, target: null, refusal: null, routes };
  });
}

/** Leave destination mode without touching a route the server is already following. */
function dismiss() {
  const s = get();
  if (s.phase === 'following' || s.phase === 'paused') return set({ phase: s.phase });
  set({ phase: 'idle', robotId: s.phase === 'idle' ? null : s.robotId, plan: null, refusal: null, target: null, arrived: null });
}

/**
 * Reroute: re-plan from the robot's CURRENT pose to the same target and commit the new plan. The old route is superseded by the
 * server (commit cancels the active one); if the new plan is refused the refusal is shown and the old state is left as the server has it.
 */
async function reroute() {
  const s = get();
  const target = s.routes[s.robotId ?? '']?.target ?? s.plan?.target;
  if (!s.robotId || !target) return;
  const robotId = s.robotId;
  const a = navApi();
  if (!a) return set({ phase: 'refused', refusal: NO_API });
  set({ phase: 'planning', plan: null, refusal: null, committed: null, target });
  const p = await a.plan(robotId, target);
  if (!p.ok) return set({ phase: 'refused', refusal: p.refusal });
  set({ phase: 'planned', plan: p.value, graphRevision: p.value.graph_revision, trafficRevision: p.value.traffic_revision });
  await commit();
}

/**
 * Pause. Under a manual lease a brake pulse is a real operator input: the server pauses destination mode (robot.route_paused) and keeps the
 * lease. Without a lease there is no pause primitive, so the route is cancelled (the robot stops where it is); the label says so.
 */
async function pause() {
  const s = get();
  if (!s.robotId || s.phase !== 'following') return;
  const ctl = useControl.getState();
  if (ctl.robotId === s.robotId && ctl.inputEnabled) {
    controlActions.setInput('route-pause', { brake: true });
    setTimeout(() => controlActions.setInput('route-pause', { brake: false }), 400);
    return;
  }
  await cancel('operator_stop');
}

controlHooks.graphRevision = () => useNav.getState().graphRevision;
controlHooks.onStaleGraph = () => {
  const s = useNav.getState();
  const robot = s.robotId ? useWorld.getState().robots[s.robotId] : undefined;
  const ctl = useControl.getState();
  const cls = (ctl.robotId ? useWorld.getState().robots[ctl.robotId] : robot)?.class;
  void loadGraph(cls === 'inpipe' ? 'interior' : 'exterior');
};

export const navActions = { begin, planTo, commit, cancel, dismiss, reroute, pause, loadGraph };

/** Test / teardown helper. */
export function resetNav() {
  api = null;
  useNav.setState({ ...initial });
}
