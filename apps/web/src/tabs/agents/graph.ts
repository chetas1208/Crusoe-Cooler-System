import type { AgentTask, Incident } from '@loopkeeper/core/contracts';
import { FAMILIES, deriveStatus, type DerivedStatus, type RobotCtx } from './status';

export const NODE_W = 188;
export const NODE_H = 58;
export const ROBOT_H = 26;
const GAP_X = 34;
const GAP_Y = 10;
const LANE_PAD = 12;
const LANE_LABEL_W = 84;

export type EdgeKind = 'delegated' | 'evidence' | 'robot' | 'escalation';

export interface TaskNodeData extends Record<string, unknown> {
  task: AgentTask;
  st: DerivedStatus;
  family: string;
  children: number;
  collapsed: boolean;
  selected: boolean;
  dim: boolean;
  tools: number;
  lastTool?: string;
}
export interface RobotNodeData extends Record<string, unknown> {
  robotId: string;
  mode?: string;
  human: boolean;
  dim: boolean;
}
export interface LaneNodeData extends Record<string, unknown> {
  label: string;
  sub: string;
  color: string;
  count: number;
  width: number;
  height: number;
}
export interface EdgeData extends Record<string, unknown> {
  kind: EdgeKind;
  color: string;
  live: boolean;
  dim: boolean;
  label?: string;
  verify?: 'pass' | 'reject' | 'pending';
}

export interface FlowNode {
  id: string;
  type: 'task' | 'robot' | 'lane';
  position: { x: number; y: number };
  data: TaskNodeData | RobotNodeData | LaneNodeData;
  style?: Record<string, string | number>;
  zIndex?: number;
  draggable: false;
  selectable: boolean;
  focusable?: boolean;
  width?: number;
  height?: number;
}
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  type: EdgeKind;
  data: EdgeData;
  zIndex?: number;
}

export interface GraphInput {
  tasks: AgentTask[];
  incidents: Record<string, Incident>;
  robots: Record<string, RobotCtx>;
  collapsed: ReadonlySet<string>;
  selectedId: string | null;
  matches: (t: AgentTask, s: DerivedStatus) => boolean;
}

export interface GraphOutput {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** changes only when the set of visible nodes / edges changes — drives auto-fit */
  structureKey: string;
  bounds: { w: number; h: number };
  statusById: Map<string, DerivedStatus>;
  positions: Map<string, { x: number; y: number }>;
}

const primaryParent = (t: AgentTask, byId: Map<string, AgentTask>) => {
  if (t.parent_id && byId.has(t.parent_id)) return t.parent_id;
  return t.caused_by.find((c) => byId.has(c));
};

/** Pure layout: columns = causal depth, lanes = agent family. Stable for a stable task set. */
export function buildGraph(inp: GraphInput): GraphOutput {
  const { tasks, incidents, robots, collapsed } = inp;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const kids = new Map<string, string[]>();
  for (const t of tasks) {
    const p = primaryParent(t, byId);
    if (p) kids.set(p, [...(kids.get(p) ?? []), t.id]);
  }
  // hide descendants of collapsed nodes
  const hidden = new Set<string>();
  const hide = (id: string) => {
    for (const c of kids.get(id) ?? []) {
      if (hidden.has(c)) continue;
      hidden.add(c);
      hide(c);
    }
  };
  for (const id of collapsed) if (byId.has(id)) hide(id);
  const countDesc = (id: string): number => (kids.get(id) ?? []).reduce((a, c) => a + 1 + countDesc(c), 0);

  const vis = tasks.filter((t) => !hidden.has(t.id)).sort((a, b) => a.incident_id.localeCompare(b.incident_id) || a.started_tick - b.started_tick || a.id.localeCompare(b.id));
  const visIds = new Set(vis.map((t) => t.id));
  const statusById = new Map<string, DerivedStatus>();
  for (const t of tasks) statusById.set(t.id, deriveStatus(t, t.robot_id ? robots[t.robot_id] : undefined));

  const col = new Map<string, number>();
  for (const t of vis) {
    const ps = [t.parent_id, ...t.caused_by].filter((p): p is string => !!p && visIds.has(p) && col.has(p));
    col.set(t.id, ps.length ? 1 + Math.max(...ps.map((p) => col.get(p) ?? 0)) : 0);
  }
  const hasRobot = (t: AgentTask) => !!t.robot_id && !!robots[t.robot_id];
  const laneHasRobot: Record<string, boolean> = {};
  for (const t of vis) if (hasRobot(t)) laneHasRobot[t.role] = true;

  const slot = new Map<string, number>();
  const rowOf = new Map<string, number>();
  const laneRows: Record<string, number> = {};
  for (const t of vis) {
    const k = `${t.role}:${col.get(t.id)}`;
    const n = slot.get(k) ?? 0;
    slot.set(k, n + 1);
    rowOf.set(t.id, n);
    laneRows[t.role] = Math.max(laneRows[t.role] ?? 1, n + 1);
  }
  const rowH = (role: string) => NODE_H + (laneHasRobot[role] ? ROBOT_H + 8 : 0) + GAP_Y;
  const laneTop: Record<string, number> = {};
  const laneH: Record<string, number> = {};
  let y = 0;
  for (const f of FAMILIES) {
    laneTop[f.role] = y;
    laneH[f.role] = (laneRows[f.role] ?? 1) * rowH(f.role) - GAP_Y + LANE_PAD * 2;
    y += laneH[f.role] + 8;
  }
  const maxCol = Math.max(0, ...vis.map((t) => col.get(t.id) ?? 0));
  const width = LANE_LABEL_W + (maxCol + 1) * (NODE_W + GAP_X) + 8;

  const nodes: FlowNode[] = [];
  for (const f of FAMILIES) {
    nodes.push({
      id: `lane:${f.role}`,
      type: 'lane',
      position: { x: 0, y: laneTop[f.role] },
      data: { label: f.label, sub: f.sub, color: f.color, count: vis.filter((t) => t.role === f.role).length, width, height: laneH[f.role] },
      draggable: false,
      selectable: false,
      focusable: false,
      zIndex: -2,
      width,
      height: laneH[f.role],
    });
  }
  const positions = new Map<string, { x: number; y: number }>();
  const edges: FlowEdge[] = [];
  for (const t of vis) {
    const st = statusById.get(t.id)!;
    const x = LANE_LABEL_W + (col.get(t.id) ?? 0) * (NODE_W + GAP_X);
    const ty = laneTop[t.role] + LANE_PAD + (rowOf.get(t.id) ?? 0) * rowH(t.role);
    positions.set(t.id, { x, y: ty });
    const last = [...t.tool_calls].reverse().find((c) => c.status !== 'running') ?? t.tool_calls[t.tool_calls.length - 1];
    nodes.push({
      id: t.id,
      type: 'task',
      position: { x, y: ty },
      width: NODE_W,
      height: NODE_H,
      draggable: false,
      selectable: true,
      data: {
        task: t,
        st,
        family: t.role,
        children: countDesc(t.id),
        collapsed: collapsed.has(t.id),
        selected: inp.selectedId === t.id,
        dim: !inp.matches(t, st),
        tools: t.tool_calls.length,
        lastTool: last ? last.name : undefined,
      },
    });
    const color = FAMILIES.find((f) => f.role === t.role)?.color ?? 'var(--t3)';
    const live = st.group === 'working' && st.status !== 'queued';
    // delegation (solid) from the primary parent, shared evidence (fine dashed) from other causes
    const p = t.parent_id && visIds.has(t.parent_id) ? t.parent_id : undefined;
    const srcs = new Set<string>();
    if (p) srcs.add(p);
    for (const c of t.caused_by) if (visIds.has(c)) srcs.add(c);
    const delegatedFrom = p ?? (t.caused_by.find((c) => visIds.has(c)) as string | undefined);
    for (const s of srcs) {
      const src = byId.get(s)!;
      const isDelegation = s === delegatedFrom;
      const srcSt = statusById.get(s);
      const escalated = isDelegation && (t.kind === 'escalate' || t.kind === 'replan');
      const kind: EdgeKind = escalated ? 'escalation' : isDelegation ? 'delegated' : 'evidence';
      let verify: EdgeData['verify'];
      if (isDelegation && t.kind === 'verify') {
        const vr = incidents[t.incident_id]?.verification;
        verify = st.group !== 'done' ? 'pending' : st.status === 'failed' || st.negative || (vr?.status === 'rejected' && t.outcome?.ok !== true) ? 'reject' : 'pass';
      }
      edges.push({
        id: `${s}>${t.id}:${kind}`,
        source: s,
        target: t.id,
        type: kind,
        zIndex: kind === 'evidence' ? 0 : 1,
        data: {
          kind,
          color: kind === 'escalation' ? 'var(--warning)' : kind === 'evidence' ? 'var(--t3)' : color,
          live: live && isDelegation,
          dim: !inp.matches(t, st) && !inp.matches(src, srcSt ?? st),
          label: escalated ? (t.kind === 'escalate' ? 'escalated' : 'replan after reject') : undefined,
          verify,
        },
      });
    }
    // robot ownership
    if (hasRobot(t) && t.robot_id) {
      const rid = `rb:${t.id}`;
      nodes.push({
        id: rid,
        type: 'robot',
        position: { x, y: ty + NODE_H + 8 },
        width: NODE_W,
        height: ROBOT_H,
        draggable: false,
        selectable: false,
        focusable: false,
        data: { robotId: t.robot_id, mode: robots[t.robot_id]?.mode, human: !!robots[t.robot_id]?.human, dim: !inp.matches(t, st) },
      });
      edges.push({ id: `${t.id}>${rid}`, source: t.id, sourceHandle: 'b', target: rid, type: 'robot', zIndex: 1, data: { kind: 'robot', color: 'var(--t2)', live: false, dim: !inp.matches(t, st) } });
    }
  }
  const structureKey = `${vis.map((t) => t.id).join(',')}|${edges.length}`;
  return { nodes, edges, structureKey, bounds: { w: width, h: y }, statusById, positions };
}
