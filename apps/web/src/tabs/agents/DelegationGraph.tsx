import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  getStraightPath,
  useReactFlow,
  type EdgeProps,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Ban, Bot, Check, CircleDashed, CircleHelp, CircleSlash, ClipboardList, Cog, Crosshair, Hand, Hourglass, Minus, Plus, RotateCcw, Search, ShieldCheck, X, ChevronRight, ChevronDown, ScanSearch, Maximize, type LucideIcon } from 'lucide-react';
import type { AgentTask } from '@loopkeeper/core/contracts';
import { robotLabel, type AgentStatus, type DerivedStatus } from './status';
import { buildGraph, NODE_H, NODE_W, type EdgeData, type FlowEdge, type FlowNode, type LaneNodeData, type RobotNodeData, type TaskNodeData } from './graph';

const ICON: Record<AgentStatus, LucideIcon> = {
  queued: CircleDashed,
  planning: ClipboardList,
  investigating: Search,
  waiting_on_robot: Hourglass,
  waiting_on_tool: Hourglass,
  blocked: Ban,
  retrying: RotateCcw,
  executing: Cog,
  verifying: ScanSearch,
  completed: Check,
  failed: X,
  cancelled: CircleSlash,
  suspended_by_human: Hand,
  unknown: CircleHelp,
};

export function StatusIcon({ st, size = 13 }: { st: DerivedStatus; size?: number }) {
  if (st.verified) return <ShieldCheck size={size + 1} />;
  if (st.negative) return <X size={size} strokeWidth={2.6} />;
  const I = ICON[st.status];
  return <I size={size} strokeWidth={st.status === 'completed' || st.status === 'failed' ? 2.6 : 2} />;
}

interface Actions {
  select(id: string): void;
  toggle(id: string): void;
}
const ActionsCtx = createContext<Actions>({ select: () => {}, toggle: () => {} });

/* ───────────── nodes ───────────── */

const TaskNode = memo(function TaskNode({ data }: NodeProps) {
  const d = data as TaskNodeData;
  const { task: t, st } = d;
  const act = useContext(ActionsCtx);
  const running = t.tool_calls.find((c) => c.status === 'running');
  const sub = st.group === 'done' ? t.outcome?.label ?? st.label : running ? `${st.label} · ${running.name}` : st.label;
  const spin = st.status === 'waiting_on_tool' || st.status === 'executing';
  return (
    <div className="ag-node" data-fam={t.role} data-tone={st.tone} data-sel={d.selected} data-dim={d.dim} data-neg={st.negative || st.status === 'failed'} data-group={st.group}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button className="ag-node__main" onClick={() => act.select(t.id)} aria-pressed={d.selected} aria-label={`${t.title}, ${st.label}`}>
        <span className="ag-node__ico">{spin ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <StatusIcon st={st} />}</span>
        <span className="ag-node__txt">
          <span className="ag-node__t">{t.title}</span>
          <span className="ag-node__s">{sub}</span>
        </span>
        {d.tools > 0 && <span className="ag-node__m num" title={`${d.tools} tool calls`}>{d.tools}</span>}
      </button>
      {d.children > 0 && (
        <button className="ag-node__fold" onClick={() => act.toggle(t.id)} aria-expanded={!d.collapsed} aria-label={d.collapsed ? `Show ${d.children} downstream tasks` : 'Hide downstream tasks'} title={d.collapsed ? `Show ${d.children} downstream` : 'Collapse downstream'}>
          {d.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          {d.collapsed && <span className="num">{d.children}</span>}
        </button>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <Handle type="source" id="b" position={Position.Bottom} isConnectable={false} />
    </div>
  );
});

const RobotNode = memo(function RobotNode({ data }: NodeProps) {
  const d = data as RobotNodeData;
  return (
    <div className="ag-robot" data-dim={d.dim} data-human={d.human}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Bot size={13} />
      <b className="mono">{robotLabel(d.robotId)}</b>
      <span>{d.human ? 'human control' : (d.mode ?? '').toLowerCase().replace('_', ' ')}</span>
    </div>
  );
});

const LaneNode = memo(function LaneNode({ data }: NodeProps) {
  const d = data as LaneNodeData;
  return (
    <div className="ag-lane" style={{ width: d.width, height: d.height, ['--lane' as string]: d.color }}>
      <div className="ag-lane__label">
        <b>{d.label}</b>
        <span className="num">{d.count} task{d.count === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
});

/* ───────────── edges ───────────── */

function VerifyBadge({ v }: { v: NonNullable<EdgeData['verify']> }) {
  return (
    <span className="ag-vbadge" data-v={v}>
      {v === 'pass' ? <ShieldCheck size={12} /> : v === 'reject' ? <X size={12} strokeWidth={2.6} /> : <ScanSearch size={12} />}
      {v === 'pass' ? 'verified' : v === 'reject' ? 'rejected' : 'checking'}
    </span>
  );
}

function Label({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return (
    <EdgeLabelRenderer>
      <div className="ag-elabel nodrag nopan" style={{ transform: `translate(-50%,-50%) translate(${x}px,${y}px)` }}>
        {children}
      </div>
    </EdgeLabelRenderer>
  );
}

const DelegatedEdge = memo(function DelegatedEdge(p: EdgeProps) {
  const d = p.data as EdgeData;
  const [path, lx, ly] = getBezierPath(p);
  return (
    <>
      <BaseEdge id={p.id} path={path} markerEnd="url(#ag-arr-n)" className="ag-edge ag-edge--delegated" style={{ opacity: d.dim ? 0.18 : 1 }} />
      {d.live && !d.dim && <path d={path} className="ag-edge ag-edge--flow" />}
      {d.verify && <Label x={lx} y={ly}><VerifyBadge v={d.verify} /></Label>}
    </>
  );
});
const EvidenceEdge = memo(function EvidenceEdge(p: EdgeProps) {
  const d = p.data as EdgeData;
  const [path] = getBezierPath({ ...p, curvature: 0.15 });
  return <BaseEdge id={p.id} path={path} className="ag-edge ag-edge--evidence" style={{ opacity: d.dim ? 0.1 : 0.75 }} />;
});
const EscalationEdge = memo(function EscalationEdge(p: EdgeProps) {
  const d = p.data as EdgeData;
  const [path, lx, ly] = getBezierPath(p);
  return (
    <>
      <BaseEdge id={p.id} path={path} markerEnd="url(#ag-arr-a)" className="ag-edge ag-edge--escalation" style={{ opacity: d.dim ? 0.25 : 1 }} />
      {d.label && <Label x={lx} y={ly}><span className="ag-esc">{d.label}</span></Label>}
    </>
  );
});
const RobotEdge = memo(function RobotEdge(p: EdgeProps) {
  const d = p.data as EdgeData;
  const [path, lx, ly] = getStraightPath(p);
  return (
    <>
      <BaseEdge id={p.id} path={path} className="ag-edge ag-edge--robot" style={{ opacity: d.dim ? 0.2 : 1 }} />
      <Label x={lx} y={ly}><span className="ag-glyph" title="Owns this robot mission"><Bot size={11} /></span></Label>
    </>
  );
});

const nodeTypes = { task: TaskNode, robot: RobotNode, lane: LaneNode };
const edgeTypes = { delegated: DelegatedEdge, evidence: EvidenceEdge, escalation: EscalationEdge, robot: RobotEdge };

/* ───────────── graph ───────────── */

export interface GraphProps {
  tasks: AgentTask[];
  incidents: Parameters<typeof buildGraph>[0]['incidents'];
  robots: Parameters<typeof buildGraph>[0]['robots'];
  selectedId: string | null;
  onSelect(id: string | null): void;
  matches: Parameters<typeof buildGraph>[0]['matches'];
  /** change when the scope/filter changes so we re-fit */
  scopeKey: string;
}

const AUTO_COLLAPSE_AT = 48;
const MIN_READABLE = 0.74;
const FRONTIER_ZOOM = 0.88;
const prefersReduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function GraphInner(p: GraphProps) {
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const [override, setOverride] = useState<Map<string, boolean>>(new Map());
  const [autoFit, setAutoFit] = useState(true);

  const collapsed = useMemo(() => {
    const s = new Set<string>();
    const crowded = p.tasks.length > AUTO_COLLAPSE_AT;
    const hasKids = new Set<string>();
    for (const t of p.tasks) if (t.parent_id) hasKids.add(t.parent_id);
    for (const t of p.tasks) {
      const o = override.get(t.id);
      // when crowded, finished branches below the first level fold away by default (never failed ones)
      const auto = crowded && t.depth >= 1 && hasKids.has(t.id) && (t.status === 'completed' || t.status === 'verified');
      if (o ?? auto) s.add(t.id);
    }
    return s;
  }, [p.tasks, override]);

  const g = useMemo(
    () => buildGraph({ tasks: p.tasks, incidents: p.incidents, robots: p.robots, collapsed, selectedId: p.selectedId, matches: p.matches }),
    [p.tasks, p.incidents, p.robots, collapsed, p.selectedId, p.matches],
  );

  const actions = useMemo<Actions>(
    () => ({
      select: (id) => p.onSelect(p.selectedId === id ? null : id),
      toggle: (id) => setOverride((m) => new Map(m).set(id, !collapsed.has(id))),
    }),
    [p, collapsed],
  );

  const dur = prefersReduced() ? 0 : 220;
  const gRef = useRef(g);
  gRef.current = g;
  /** Fit everything when it stays legible; otherwise follow the live frontier (latest columns, unfinished and selected tasks). */
  const fit = useCallback(
    (all = false) => {
      const cur = gRef.current;
      const r = wrap.current?.getBoundingClientRect();
      let nodes: Array<{ id: string }> | undefined;
      if (!all && r) {
        const need = Math.min(r.width / (cur.bounds.w + 20), r.height / (cur.bounds.h + 20));
        if (need < MIN_READABLE) {
          const tasks = cur.nodes.filter((n) => n.type === 'task');
          const maxX = Math.max(...tasks.map((n) => n.position.x));
          // newest columns that still fit at a comfortable zoom
          const lo = maxX + NODE_W - (r.width / FRONTIER_ZOOM - 24);
          const pick = tasks.filter((n) => n.position.x >= lo);
          nodes = pick.slice(-24).flatMap((n) => [{ id: n.id }, ...(cur.nodes.some((x) => x.id === `rb:${n.id}`) ? [{ id: `rb:${n.id}` }] : [])]);
        }
      }
      void rf.fitView({ nodes, padding: 0.06, maxZoom: 1, minZoom: 0.3, duration: dur });
    },
    [rf, dur],
  );

  // re-enable auto-fit when the scope changes
  useEffect(() => setAutoFit(true), [p.scopeKey]);
  useEffect(() => {
    if (!autoFit) return;
    // give React Flow a beat to ingest and measure the new nodes before fitting
    const id = setTimeout(() => fit(), 90);
    return () => clearTimeout(id);
  }, [g.structureKey, autoFit, fit]);
  useEffect(() => {
    const el = wrap.current;
    if (!el || !autoFit) return;
    let to: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(to);
      to = setTimeout(() => fit(), 120);
    });
    ro.observe(el);
    return () => (ro.disconnect(), clearTimeout(to));
  }, [autoFit, fit]);

  // bring an off-screen selection into view (selected from the list or the ribbon)
  useEffect(() => {
    const pos = p.selectedId ? g.positions.get(p.selectedId) : undefined;
    const el = wrap.current;
    if (!pos || !el) return;
    const vp = rf.getViewport();
    const r = el.getBoundingClientRect();
    const sx = pos.x * vp.zoom + vp.x;
    const sy = pos.y * vp.zoom + vp.y;
    const inside = sx > 0 && sy > 0 && sx + NODE_W * vp.zoom < r.width && sy + NODE_H * vp.zoom < r.height;
    if (!inside) void rf.setCenter(pos.x + NODE_W / 2, pos.y + NODE_H / 2, { zoom: Math.max(vp.zoom, 0.7), duration: dur });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.selectedId]);

  return (
    <ActionsCtx.Provider value={actions}>
      <div className="ag-flow" ref={wrap}>
        <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
          <defs>
            <marker id="ag-arr-n" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="#8b93a7" /></marker>
            <marker id="ag-arr-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0.5 L9.5,5 L0,9.5 z" fill="#ff9a3c" /></marker>
          </defs>
        </svg>
        <ReactFlow
          nodes={g.nodes as never}
          edges={g.edges as FlowEdge[] as never}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode="dark"
          minZoom={0.25}
          maxZoom={1.6}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          onlyRenderVisibleElements
          zoomOnDoubleClick={false}
          panOnScroll={false}
          proOptions={{ hideAttribution: false }}
          onMoveStart={(evt) => evt && setAutoFit(false)}
          onPaneClick={() => p.onSelect(null)}
          aria-label="Agent delegation graph"
        >
          <Panel position="top-right" className="ag-tools">
            <button className="ag-tool" data-on={autoFit} onClick={() => (setAutoFit(true), fit())} title="Keep the newest activity in view as tasks arrive" aria-pressed={autoFit}>
              <Crosshair size={13} /> Follow live
            </button>
            <button className="ag-tool" onClick={() => (setAutoFit(false), fit(true))} title="Fit every task in the view">
              <Maximize size={13} /> Fit all
            </button>
            <button className="ag-tool ag-tool--ico" onClick={() => (setAutoFit(false), void rf.zoomOut({ duration: dur }))} aria-label="Zoom out"><Minus size={13} /></button>
            <button className="ag-tool ag-tool--ico" onClick={() => (setAutoFit(false), void rf.zoomIn({ duration: dur }))} aria-label="Zoom in"><Plus size={13} /></button>
          </Panel>
        </ReactFlow>
      </div>
    </ActionsCtx.Provider>
  );
}

export function DelegationGraph(p: GraphProps) {
  return (
    <ReactFlowProvider>
      <GraphInner {...p} />
    </ReactFlowProvider>
  );
}

export type { FlowNode };
