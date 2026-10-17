import type { Asset, PipeEdge, Robot, RobotMode, Topology, Vec3 } from '../contracts';
import type { RobotControlInfo } from '../contracts.control';
import {
  angleDelta,
  buildPath,
  clamp,
  joinPaths,
  reversePath,
  samplePath,
  v3,
  yawOf,
  type Path,
} from '../geometry';

/* ───────────────────────── INPIPE routing (pipe graph) ───────────────────────── */

export interface RouteLeg {
  edge_id: string;
  s0: number;
  s1: number;
}

export interface InpipeRoute {
  legs: RouteLeg[];
  path: Path;
  /** cumulative distance at which each leg begins */
  legStart: number[];
  length: number;
}

export class PipeGraph {
  private paths: Record<string, Path> = {};
  private edges: Record<string, PipeEdge> = {};
  constructor(private topo: Topology) {
    for (const e of topo.edges) {
      this.edges[e.id] = e;
      this.paths[e.id] = buildPath(e.centerline_xyz_m, e.fillet_radius_m);
    }
  }
  edge(id: string) {
    return this.edges[id];
  }
  path(id: string) {
    return this.paths[id];
  }
  length(id: string) {
    return this.paths[id].length;
  }
  passable(id: string) {
    return !!this.edges[id]?.robot_passable;
  }
  position(edgeId: string, s: number): Vec3 {
    return samplePath(this.paths[edgeId], s).p;
  }

  /** Dijkstra over passable edges between two points that lie on edges. */
  route(from: { edge_id: string; s: number }, to: { edge_id: string; s: number }): InpipeRoute | null {
    if (!this.passable(from.edge_id) || !this.passable(to.edge_id)) return null;
    const legs: RouteLeg[] = [];
    if (from.edge_id === to.edge_id) {
      legs.push({ edge_id: from.edge_id, s0: from.s, s1: to.s });
    } else {
      const eFrom = this.edges[from.edge_id];
      const eTo = this.edges[to.edge_id];
      let best: { cost: number; legs: RouteLeg[] } | null = null;
      for (const exitNode of [eFrom.from, eFrom.to]) {
        const exitS = exitNode === eFrom.from ? 0 : this.length(eFrom.id);
        for (const entryNode of [eTo.from, eTo.to]) {
          const entryS = entryNode === eTo.from ? 0 : this.length(eTo.id);
          const mid = this.dijkstra(exitNode, entryNode, new Set([eFrom.id, eTo.id]));
          if (!mid) continue;
          const cost = Math.abs(from.s - exitS) + mid.cost + Math.abs(entryS - to.s);
          if (!best || cost < best.cost) {
            best = {
              cost,
              legs: [
                { edge_id: eFrom.id, s0: from.s, s1: exitS },
                ...mid.legs,
                { edge_id: eTo.id, s0: entryS, s1: to.s },
              ],
            };
          }
        }
      }
      if (!best) return null;
      legs.push(...best.legs);
    }
    return this.assemble(legs);
  }

  private dijkstra(a: string, b: string, exclude: Set<string>): { cost: number; legs: RouteLeg[] } | null {
    if (a === b) return { cost: 0, legs: [] };
    const dist: Record<string, number> = { [a]: 0 };
    const prev: Record<string, { node: string; edge: string; forward: boolean }> = {};
    const open = new Set<string>([a]);
    while (open.size) {
      let u = '';
      let best = Infinity;
      for (const n of open) if (dist[n] < best) ((best = dist[n]), (u = n));
      open.delete(u);
      if (u === b) break;
      for (const e of this.topo.edges) {
        if (!e.robot_passable || exclude.has(e.id)) continue;
        let v: string | null = null;
        let forward = true;
        if (e.from === u) v = e.to;
        else if (e.to === u) ((v = e.from), (forward = false));
        if (!v) continue;
        const nd = dist[u] + this.length(e.id);
        if (nd < (dist[v] ?? Infinity)) {
          dist[v] = nd;
          prev[v] = { node: u, edge: e.id, forward };
          open.add(v);
        }
      }
    }
    if (dist[b] === undefined) return null;
    const legs: RouteLeg[] = [];
    let cur = b;
    while (cur !== a) {
      const p = prev[cur];
      const L = this.length(p.edge);
      legs.unshift({ edge_id: p.edge, s0: p.forward ? 0 : L, s1: p.forward ? L : 0 });
      cur = p.node;
    }
    return { cost: dist[b], legs };
  }

  private assemble(legs: RouteLeg[]): InpipeRoute {
    const cleaned = legs.filter((l) => Math.abs(l.s1 - l.s0) > 1e-3);
    const subs: Path[] = [];
    const legStart: number[] = [];
    let acc = 0;
    for (const l of cleaned) {
      const full = this.paths[l.edge_id];
      const lo = Math.min(l.s0, l.s1);
      const hi = Math.max(l.s0, l.s1);
      let sub = slicePath(full, lo, hi);
      if (l.s1 < l.s0) sub = reversePath(sub);
      subs.push(sub);
      legStart.push(acc);
      acc += sub.length;
    }
    if (!subs.length) {
      const l = legs[0];
      const p = this.position(l.edge_id, l.s0);
      return { legs: legs.slice(0, 1), path: { points: [p, p], cum: [0, 0], length: 0 }, legStart: [0], length: 0 };
    }
    const path = joinPaths(subs);
    return { legs: cleaned, path, legStart, length: path.length };
  }
}

function slicePath(path: Path, s0: number, s1: number): Path {
  const pts: Vec3[] = [samplePath(path, s0).p];
  for (let i = 0; i < path.points.length; i++) {
    if (path.cum[i] > s0 + 1e-6 && path.cum[i] < s1 - 1e-6) pts.push(path.points[i]);
  }
  pts.push(samplePath(path, s1).p);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + v3.dist(pts[i - 1], pts[i]));
  return { points: pts, cum, length: cum[cum.length - 1] };
}

/* ───────────────────────── OUTRIG routing (nav grid A*) ───────────────────────── */

export class NavGrid {
  private cell: number;
  private minX: number;
  private minZ: number;
  private w: number;
  private h: number;
  private blocked: Uint8Array;

  constructor(topo: Topology, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, radius = 0.55) {
    this.cell = topo.nav.cell_m;
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.w = Math.ceil((bounds.maxX - bounds.minX) / this.cell);
    this.h = Math.ceil((bounds.maxZ - bounds.minZ) / this.cell);
    this.blocked = new Uint8Array(this.w * this.h);
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const x = this.minX + (i + 0.5) * this.cell;
        const z = this.minZ + (j + 0.5) * this.cell;
        let b = x < bounds.minX + radius || x > bounds.maxX - radius || z < bounds.minZ + radius || z > bounds.maxZ - radius;
        for (const o of topo.nav.obstacles) {
          const [x0, z0, x1, z1] = o.rect;
          if (x > x0 - radius && x < x1 + radius && z > z0 - radius && z < z1 + radius) b = true;
        }
        this.blocked[j * this.w + i] = b ? 1 : 0;
      }
    }
  }

  private idx(x: number, z: number): [number, number] {
    return [clamp(Math.floor((x - this.minX) / this.cell), 0, this.w - 1), clamp(Math.floor((z - this.minZ) / this.cell), 0, this.h - 1)];
  }
  private world(i: number, j: number): Vec3 {
    return [this.minX + (i + 0.5) * this.cell, 0, this.minZ + (j + 0.5) * this.cell];
  }
  isFree(x: number, z: number) {
    const [i, j] = this.idx(x, z);
    return !this.blocked[j * this.w + i];
  }
  /** nearest free cell to a point (service poses may sit inside a clearance halo) */
  snap(p: Vec3): Vec3 {
    const [ci, cj] = this.idx(p[0], p[2]);
    if (!this.blocked[cj * this.w + ci]) return this.world(ci, cj);
    for (let r = 1; r < 30; r++) {
      let best: [number, number] | null = null;
      let bd = Infinity;
      for (let j = cj - r; j <= cj + r; j++) {
        for (let i = ci - r; i <= ci + r; i++) {
          if (i < 0 || j < 0 || i >= this.w || j >= this.h) continue;
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          if (this.blocked[j * this.w + i]) continue;
          const d = (i - ci) ** 2 + (j - cj) ** 2;
          if (d < bd) ((bd = d), (best = [i, j]));
        }
      }
      if (best) return this.world(best[0], best[1]);
    }
    return p;
  }

  private lineFree(a: Vec3, b: Vec3) {
    const n = Math.ceil(v3.dist(a, b) / (this.cell * 0.5));
    for (let k = 0; k <= n; k++) {
      const p = v3.lerp(a, b, k / Math.max(n, 1));
      if (!this.isFree(p[0], p[2])) return false;
    }
    return true;
  }

  /** A* over an 8-connected grid then string-pulling smoothing. Returns waypoints on y=0. */
  route(from: Vec3, to: Vec3): Vec3[] | null {
    const s = this.snap(from);
    const g = this.snap(to);
    const [si, sj] = this.idx(s[0], s[2]);
    const [gi, gj] = this.idx(g[0], g[2]);
    const key = (i: number, j: number) => j * this.w + i;
    const open: Array<{ i: number; j: number; f: number }> = [{ i: si, j: sj, f: 0 }];
    const gScore = new Map<number, number>([[key(si, sj), 0]]);
    const came = new Map<number, number>();
    const closed = new Set<number>();
    const hFn = (i: number, j: number) => Math.hypot(i - gi, j - gj);
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k++) if (open[k].f < open[bi].f) bi = k;
      const cur = open.splice(bi, 1)[0];
      const ck = key(cur.i, cur.j);
      if (closed.has(ck)) continue;
      closed.add(ck);
      if (cur.i === gi && cur.j === gj) {
        const cells: Vec3[] = [];
        let k: number | undefined = ck;
        while (k !== undefined) {
          cells.unshift(this.world(k % this.w, Math.floor(k / this.w)));
          k = came.get(k);
        }
        return this.smooth([from[0] === s[0] && from[2] === s[2] ? from : [from[0], 0, from[2]], ...cells.slice(1, -1), g, ...(to[0] === g[0] && to[2] === g[2] ? [] : [])]);
      }
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = cur.i + di;
          const nj = cur.j + dj;
          if (ni < 0 || nj < 0 || ni >= this.w || nj >= this.h) continue;
          if (this.blocked[key(ni, nj)]) continue;
          if (di && dj && (this.blocked[key(cur.i + di, cur.j)] || this.blocked[key(cur.i, cur.j + dj)])) continue;
          const tg = (gScore.get(ck) ?? 0) + (di && dj ? Math.SQRT2 : 1);
          const nk = key(ni, nj);
          if (tg < (gScore.get(nk) ?? Infinity)) {
            gScore.set(nk, tg);
            came.set(nk, ck);
            open.push({ i: ni, j: nj, f: tg + hFn(ni, nj) });
          }
        }
      }
    }
    return null;
  }

  private smooth(pts: Vec3[]): Vec3[] {
    const out: Vec3[] = [pts[0]];
    let anchor = 0;
    while (anchor < pts.length - 1) {
      let far = pts.length - 1;
      while (far > anchor + 1 && !this.lineFree(pts[anchor], pts[far])) far--;
      out.push(pts[far]);
      anchor = far;
    }
    return out;
  }
}

/* ───────────────────────────── robot actors ───────────────────────────── */

export const CRAWLER_SPEED = 0.12; // m/s inside the pipe
export const OUTRIG_SPEED = 0.45; // m/s through corridors
const TURN_RATE = 1.6; // rad/s

/** Kinematic state while an operator (or a SAFE_HOLD) owns an INPIPE robot. */
export interface ManualKin {
  edge_id?: string;
  s?: number;
  /** +1: nose toward increasing s */
  facing: 1 | -1;
  /** signed velocity along the nose direction */
  v: number;
  x?: number;
  z?: number;
  yaw?: number;
}

export type RobotCommand =
  | { kind: 'move_inpipe'; route: InpipeRoute; label: string; mode?: RobotMode }
  | { kind: 'move_outrig'; waypoints: Vec3[]; label: string; mode?: RobotMode }
  | { kind: 'action'; label: string; duration_s: number; mode: RobotMode; tool?: string | null; on_done?: () => void };

export interface ActiveCmd {
  cmd: RobotCommand;
  elapsed: number;
  progress: number;
  moved: number;
  length: number;
  path?: Path;
}

export class RobotActor {
  mode: RobotMode = 'DOCKED';
  battery = 100;
  tool: string | null = null;
  missionId?: string;
  taskId?: string;
  pos: Vec3;
  yaw = 0;
  speed = 0;
  segment_id?: string;
  s_m?: number;
  route?: Vec3[];
  private active: ActiveCmd | null = null;
  /** Latched until the orchestrator consumes it. */
  doneFlag = 0;
  heading: Vec3 = [0, 0, 1];
  /** Manual-control kinematic state, owned by ControlService while a lease (or SAFE_HOLD) exists. */
  manual: ManualKin | null = null;
  /** The autonomous command suspended by a manual takeover. */
  private paused: ActiveCmd | null = null;
  private pausedAnchor: { edge_id: string; s: number } | null = null;
  private resumeAfterReconcile: ActiveCmd | null = null;
  private savedMode: RobotMode = 'DOCKED';
  private autoDock = false;
  private homePort?: { edge_id: string; s: number };
  /** set by ControlService so snapshots carry control authority */
  controlProvider?: (r: RobotActor) => RobotControlInfo;

  constructor(
    readonly id: string,
    readonly klass: 'inpipe' | 'outrig',
    readonly name: string,
    readonly homeId: string,
    pos: Vec3,
    yaw: number,
    private graph: PipeGraph,
    readonly spec: Record<string, string | number>,
    home?: { edge_id: string; s: number },
  ) {
    this.pos = pos;
    this.yaw = yaw;
    if (home) {
      this.segment_id = home.edge_id;
      this.s_m = home.s;
      this.homePort = home;
      const t = samplePath(graph.path(home.edge_id), home.s).t;
      this.heading = [t[0], t[1], t[2]];
    }
  }

  /** True while a human lease (or the hold that follows an unplanned stop) owns the motors. */
  get controlled() {
    return this.manual !== null;
  }

  get busy() {
    return this.active !== null;
  }

  start(cmd: RobotCommand) {
    let length = 0;
    let path: Path | undefined;
    if (cmd.kind === 'move_inpipe') {
      length = cmd.route.length;
      path = cmd.route.path;
      this.mode = cmd.mode ?? 'TRAVELING';
    } else if (cmd.kind === 'move_outrig') {
      const pts = cmd.waypoints;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + v3.dist(pts[i - 1], pts[i]));
      path = { points: pts, cum, length: cum[cum.length - 1] };
      length = path.length;
      this.mode = cmd.mode ?? 'TRAVELING';
      this.route = pts;
    } else {
      this.mode = cmd.mode;
      if (cmd.tool !== undefined) this.tool = cmd.tool;
    }
    const next: ActiveCmd = { cmd, elapsed: 0, progress: 0, moved: 0, length, path };
    if (this.manual) {
      // the operator holds the motors: queue the agent's command, it runs after the handoff
      this.paused = next;
      this.pausedAnchor = this.pausedAnchor ?? this.anchorHere();
      this.mode = this.savedMode;
      return;
    }
    this.active = next;
  }

  private anchorHere() {
    return this.segment_id !== undefined && this.s_m !== undefined ? { edge_id: this.segment_id, s: this.s_m } : null;
  }

  currentLabel() {
    return this.active?.cmd.label;
  }

  step(dt: number, nothing = false) {
    // battery: moving costs more than idling; docked robots charge
    if (this.manual) {
      // motion is integrated by ControlService; only the battery is drained here
      this.battery = Math.max(0, this.battery - (Math.abs(this.speed) > 0.001 ? 0.03 : 0.012) * dt);
      return;
    }
    const moving = !!this.active && this.active.cmd.kind !== 'action';
    if (this.mode === 'DOCKED' && !this.active) this.battery = Math.min(100, this.battery + 0.05 * dt);
    else this.battery = Math.max(0, this.battery - (moving ? 0.03 : 0.012) * dt);
    if (!this.active) {
      this.speed = 0;
      return;
    }
    const a = this.active;
    a.elapsed += dt;
    if (a.cmd.kind === 'action') {
      this.speed = 0;
      a.progress = clamp(a.elapsed / a.cmd.duration_s, 0, 1);
      if (a.elapsed >= a.cmd.duration_s) this.finish();
      return;
    }
    const v = this.klass === 'inpipe' ? CRAWLER_SPEED : OUTRIG_SPEED;
    const wasPos = this.pos;
    // slow down near the end of a leg for a smooth stop
    const remaining = a.length - a.moved;
    const vEff = Math.min(v, Math.max(0.03, remaining * 0.8));
    a.moved = Math.min(a.length, a.moved + vEff * dt);
    this.speed = vEff;
    a.progress = a.length > 0 ? a.moved / a.length : 1;
    const { p, t } = samplePath(a.path!, a.moved);
    if (this.klass === 'inpipe') {
      this.pos = p;
      const cmd = a.cmd as Extract<RobotCommand, { kind: 'move_inpipe' }>;
      // current leg
      let li = 0;
      for (let i = 0; i < cmd.route.legStart.length; i++) if (a.moved >= cmd.route.legStart[i]) li = i;
      const leg = cmd.route.legs[li];
      const into = a.moved - cmd.route.legStart[li];
      this.segment_id = leg.edge_id;
      this.s_m = leg.s1 >= leg.s0 ? leg.s0 + into : leg.s0 - into;
      this.yaw = Math.atan2(t[0], t[2]);
      this.heading = [t[0], t[1], t[2]];
    } else {
      this.pos = [p[0], 0, p[2]];
      const targetYaw = yawOf(v3.sub(p, wasPos).every((x) => Math.abs(x) < 1e-9) ? t : v3.sub(p, wasPos));
      const dy = angleDelta(this.yaw, targetYaw);
      this.yaw += clamp(dy, -TURN_RATE * dt, TURN_RATE * dt);
    }
    if (a.moved >= a.length - 1e-6) this.finish();
  }

  private finish() {
    const a = this.active!;
    this.active = null;
    this.speed = 0;
    if (a.cmd.kind === 'move_inpipe') {
      const last = a.cmd.route.legs[a.cmd.route.legs.length - 1];
      this.segment_id = last.edge_id;
      this.s_m = last.s1;
    }
    if (this.resumeAfterReconcile) {
      // back on the agent's anchor: carry on with the command the operator interrupted
      const p = this.resumeAfterReconcile;
      this.resumeAfterReconcile = null;
      this.active = p;
      this.mode = p.cmd.kind === 'action' ? p.cmd.mode : (p.cmd.mode ?? 'TRAVELING');
      return;
    }
    this.doneFlag++;
    if (a.cmd.kind === 'move_outrig') this.route = undefined;
    if (a.cmd.kind === 'action') a.cmd.on_done?.();
    if (this.autoDock && a.cmd.kind === 'move_inpipe') {
      this.autoDock = false;
      this.mode = 'DOCKED';
      this.tool = null;
      return;
    }
    if (this.mode === 'TRAVELING' || this.mode === 'RETURNING') this.mode = 'ASSIGNED';
  }

  /* ───────────────────── manual takeover / handoff (ControlService) ───────────────────── */

  /** Suspend the agent's command and hand the motors to the operator. Returns false if the pose is unknown. */
  beginManual(): boolean {
    if (this.klass === 'inpipe') {
      if (this.segment_id === undefined || this.s_m === undefined) return false;
      if (!this.manual) {
        this.savedMode = this.mode === 'DOCKED' ? 'IDLE' : this.mode;
        this.paused = this.active;
        this.active = null;
        this.pausedAnchor = this.anchorHere();
        this.resumeAfterReconcile = null;
        this.autoDock = false;
        const t = this.heading;
        const tan = samplePath(this.graph.path(this.segment_id), this.s_m).t;
        const facing: 1 | -1 = t[0] * tan[0] + t[1] * tan[1] + t[2] * tan[2] >= 0 ? 1 : -1;
        this.manual = { edge_id: this.segment_id, s: this.s_m, facing, v: 0 };
        this.speed = 0;
        if (this.mode === 'DOCKED') this.mode = 'IDLE';
      }
      return true;
    } else if (this.klass === 'outrig') {
      if (!this.manual) {
        this.savedMode = this.mode === 'DOCKED' ? 'IDLE' : this.mode;
        this.paused = this.active;
        this.active = null;
        this.pausedAnchor = null;
        this.resumeAfterReconcile = null;
        this.autoDock = false;
        this.manual = { x: this.pos[0], z: this.pos[2], yaw: this.yaw, facing: 1, v: 0 };
        this.speed = 0;
        if (this.mode === 'DOCKED') this.mode = 'IDLE';
      }
      return true;
    }
    return false;
  }

  /** Write the operator-driven pose for an in-pipe crawler. */
  setManualPose(edgeId: string, s: number, facing: 1 | -1, v: number) {
    const m = this.manual;
    if (!m) return;
    m.edge_id = edgeId;
    m.s = s;
    m.facing = facing;
    m.v = v;
    const { p, t } = samplePath(this.graph.path(edgeId), s);
    this.pos = p;
    this.segment_id = edgeId;
    this.s_m = s;
    this.speed = Math.abs(v);
    this.heading = [t[0] * facing, t[1] * facing, t[2] * facing];
    this.yaw = Math.atan2(this.heading[0], this.heading[2]);
    const moving = Math.abs(v) > 0.004;
    if (this.mode !== 'SAFE_HOLD' && this.mode !== 'FAILED') this.mode = moving ? 'TRAVELING' : this.savedMode === 'TRAVELING' || this.savedMode === 'RETURNING' ? 'IDLE' : this.savedMode;
  }

  /** Write the operator-driven pose for an exterior rover. */
  setManualFloorPose(x: number, z: number, yaw: number, v: number) {
    const m = this.manual;
    if (!m) return;
    m.x = x;
    m.z = z;
    m.yaw = yaw;
    m.v = v;
    this.pos = [x, 0, z];
    this.yaw = yaw;
    this.heading = [Math.sin(yaw), 0, Math.cos(yaw)];
    this.speed = Math.abs(v);
    const moving = Math.abs(v) > 0.004;
    if (this.mode !== 'SAFE_HOLD' && this.mode !== 'FAILED') {
      this.mode = moving ? 'TRAVELING' : this.savedMode === 'TRAVELING' || this.savedMode === 'RETURNING' ? 'IDLE' : this.savedMode;
    }
  }

  setHoldMode(on: boolean) {
    if (on) this.mode = 'SAFE_HOLD';
    else if (this.mode === 'SAFE_HOLD') this.mode = this.savedMode;
  }

  /**
   * The operator let go. Reconcile with the agent: re-plan whatever it was doing from where the
   * operator left the robot, or send an idle robot home. Returns what the agent will do.
   */
  endManual(): 'mission' | 'return_to_port' | 'docked' | 'blocked' {
    const m = this.manual;
    this.manual = null;
    this.speed = 0;
    if (!m) return 'blocked';
    if (this.klass === 'outrig') {
      const p = this.paused;
      this.paused = null;
      if (this.mode === 'SAFE_HOLD' || this.mode === 'IDLE' || this.mode === 'TRAVELING') this.mode = this.savedMode;
      if (p && p.cmd.kind === 'move_outrig') {
        const dest = p.cmd.waypoints[p.cmd.waypoints.length - 1];
        this.start({ kind: 'move_outrig', waypoints: [this.pos, dest], label: p.cmd.label, mode: p.cmd.mode });
        return 'mission';
      }
      if (p && p.cmd.kind === 'action') {
        this.start(p.cmd);
        return 'mission';
      }
      return 'docked';
    }
    const here = { edge_id: m.edge_id!, s: m.s! };
    const p = this.paused;
    const anchor = this.pausedAnchor;
    this.paused = null;
    this.pausedAnchor = null;
    if (this.mode === 'SAFE_HOLD' || this.mode === 'IDLE' || this.mode === 'TRAVELING') this.mode = this.savedMode;
    if (p) {
      if (p.cmd.kind === 'move_inpipe') {
        const last = p.cmd.route.legs[p.cmd.route.legs.length - 1];
        const route = this.graph.route(here, { edge_id: last.edge_id, s: last.s1 });
        if (!route) return this.block(p);
        const cmd = { ...p.cmd, route };
        this.active = { cmd, elapsed: p.elapsed, progress: 0, moved: 0, length: route.length, path: route.path };
        this.mode = cmd.mode ?? 'TRAVELING';
        return 'mission';
      }
      if (p.cmd.kind === 'action') {
        // an action happens at a place: if the operator moved the robot, drive back first
        const displaced = anchor && (anchor.edge_id !== here.edge_id || Math.abs(anchor.s - here.s) > 0.15);
        if (displaced && anchor) {
          const route = this.graph.route(here, anchor);
          if (!route) return this.block(p);
          this.resumeAfterReconcile = p;
          this.active = { cmd: { kind: 'move_inpipe', route, label: 'return to task position', mode: 'RETURNING' }, elapsed: 0, progress: 0, moved: 0, length: route.length, path: route.path };
          this.mode = 'RETURNING';
          return 'mission';
        }
        this.active = p;
        this.mode = p.cmd.mode;
        return 'mission';
      }
      this.active = p;
      return 'mission';
    }
    // no mission: an idle crawler goes home on its own, a docked one stays docked
    const home = this.homePort;
    if (!home) return 'docked';
    if (home.edge_id === here.edge_id && Math.abs(home.s - here.s) < 0.35) {
      this.mode = 'DOCKED';
      this.tool = null;
      return 'docked';
    }
    const route = this.graph.route(here, home);
    if (!route) {
      this.mode = 'SAFE_HOLD';
      return 'blocked';
    }
    this.autoDock = true;
    this.active = { cmd: { kind: 'move_inpipe', route, label: 'return to port', mode: 'RETURNING' }, elapsed: 0, progress: 0, moved: 0, length: route.length, path: route.path };
    this.mode = 'RETURNING';
    return 'return_to_port';
  }

  private block(p: ActiveCmd): 'blocked' {
    // no legal way back to where the agent was going: keep its command parked and stay put
    this.paused = p;
    this.mode = 'SAFE_HOLD';
    this.manual = { edge_id: this.segment_id!, s: this.s_m!, facing: 1, v: 0 };
    return 'blocked';
  }

  progress() {
    return this.active?.progress ?? 1;
  }

  toContract(): Robot {
    return {
      id: this.id,
      class: this.klass,
      name: this.name,
      mode: this.mode,
      battery_pct: Math.round(this.battery * 10) / 10,
      mission_id: this.missionId,
      agent_task_id: this.taskId,
      tool: this.tool,
      home_id: this.homeId,
      pose: {
        position_xyz_m: [this.pos[0], this.pos[1], this.pos[2]],
        yaw_rad: this.yaw,
        speed_m_s: this.speed,
        segment_id: this.segment_id,
        s_m: this.s_m,
        heading_xyz: this.klass === 'inpipe' ? [this.heading[0], this.heading[1], this.heading[2]] : undefined,
      },
      route_xyz_m: this.route,
      spec: this.spec,
      control: this.controlProvider?.(this),
    };
  }
}

export function buildRobots(topo: Topology, graph: PipeGraph): RobotActor[] {
  const byId = (id: string) => topo.assets.find((a) => a.id === id) as Asset;
  const a2 = byId('port_a2');
  const a1 = byId('port_a1');
  const o1 = byId('dock_o1');
  const c1 = new RobotActor(
    'c_01', 'inpipe', 'CRAWLER C-01', 'port_a2', graph.position(a2.edge_id!, a2.s_m!), 0, graph,
    { 'Body': '14 cm cartridge', 'Min bore': '80 mm', 'Tooling': 'Camera · ultrasonic gauge · retractable brush', 'Endurance': '2.4 h' },
    { edge_id: a2.edge_id!, s: a2.s_m! },
  );
  const c2 = new RobotActor(
    'c_02', 'inpipe', 'CRAWLER C-02', 'port_a1', graph.position(a1.edge_id!, a1.s_m!), 0, graph,
    { 'Body': '18 cm cartridge', 'Min bore': '120 mm', 'Tooling': 'Camera · ultrasonic gauge · retractable brush', 'Endurance': '2.8 h' },
    { edge_id: a1.edge_id!, s: a1.s_m! },
  );
  const o = new RobotActor(
    'o_01', 'outrig', 'OUTRIG O-01', 'dock_o1', [o1.position_xyz_m[0], 0, o1.position_xyz_m[2]], -Math.PI / 2, graph,
    { 'Platform': 'Wheeled industrial base', 'Reach': '3.0 m mast manipulator', 'Tooling': 'Valve actuator · basket · pipe clamp · pressure kit', 'Endurance': '6 h' },
  );
  return [c1, c2, o];
}
