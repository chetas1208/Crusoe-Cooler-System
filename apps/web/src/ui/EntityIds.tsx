import { useMemo } from 'react';
import { Crosshair } from 'lucide-react';
import { useWorld } from '@loopkeeper/core/store';
import { entityBounds, fitCamera, isRoadSel, isRowSel, measureInsets, selKey, siteModel, useMapCamera, useView } from '@loopkeeper/scene';
import type { Robot, Topology } from '@loopkeeper/core/contracts';
import { useUi } from './store';

type Row = [string, string];

/** Real topology ids for whatever is selected: pipe, rack, row, road, equipment. Everything is read from /topology and the solved world. */
interface Ctx {
  readings?: Record<string, number>;
  assets: Record<string, { readings: Record<string, number>; status?: string }>;
  robots: Record<string, Robot>;
}

type Layout = {
  roads?: Array<{ road_id: string; z_m: number; clear_width_m?: number; between_rows?: string[]; dock_ids?: string[]; service_target_ids?: string[] }>;
  robots?: { outrig?: Array<{ id: string; road_id: string; sector?: string; dock_id?: string }> };
  cross_aisles?: Array<{ id: string }>;
};
const layoutOf = (topo: Topology) => (topo as unknown as { facility_layout_v6?: Layout }).facility_layout_v6;

/** Real topology ids for whatever is selected: pipe, rack, row, road, equipment, robot. Everything is read from /topology and the solved world. */
export function entityRows(topo: Topology, id: string, ctx: Ctx): Row[] {
  const m = siteModel(topo);
  const L = layoutOf(topo);
  const out: Row[] = [];
  const readings = ctx.readings;
  const fmt = (v: number | undefined, d: number, u: string) => (v === undefined ? 'no reading' : `${v.toFixed(d)} ${u}`);
  if (isRoadSel(id)) {
    const k = selKey(id);
    const r = m.roads.find((x) => (x.roadId ?? x.id) === k || x.id === k);
    if (!r) return out;
    const rid = r.roadId ?? r.id;
    out.push(['road_id', rid], ['clear width', `${(r.meta?.clear_width_m ?? r.width).toFixed(2)} m`], ['x range', `${r.x0.toFixed(1)} → ${r.x1.toFixed(1)} m`], ['z', `${((r.z0 + r.z1) / 2).toFixed(1)} m`]);
    if (r.meta?.between_rows) out.push(['between rows', r.meta.between_rows.join(' · ')]);
    if (r.meta?.dock_ids?.length) out.push(['dock ids', r.meta.dock_ids.join(' · ')]);
    const outr = (L?.robots?.outrig ?? []).filter((o) => o.road_id === rid);
    if (outr.length) out.push(['assigned OUTRIG', outr.map((o) => `${o.id}${o.sector ? ` (${o.sector})` : ''}`).join(' · ')]);
    const onRoad = Object.values(ctx.robots).filter((x) => x.class === 'outrig' && x.pose.position_xyz_m[2] > r.z0 - 0.05 && x.pose.position_xyz_m[2] < r.z1 + 0.05).map((x) => x.id);
    out.push(['on the road now', onRoad.length ? onRoad.join(' · ') : 'none']);
    if (r.meta?.service_target_ids?.length) out.push(['service targets', `${r.meta.service_target_ids.length}: ${r.meta.service_target_ids.slice(0, 6).join(' · ')}${r.meta.service_target_ids.length > 6 ? ' …' : ''}`]);
    return out;
  }
  if (isRowSel(id)) {
    for (const p of m.pods)
      for (const r of p.rows)
        if ((r.rowId ?? r.id) === selKey(id)) {
          out.push(['row_id', r.rowId ?? r.id], ['racks', `${r.n}${r.rackIds ? ` (${r.rackIds[0]} … ${r.rackIds[r.rackIds.length - 1]})` : ''}`], ['x range', `${r.x0.toFixed(1)} → ${r.x1.toFixed(1)} m`], ['z', `${r.z.toFixed(1)} m`]);
          const tapsOf = (e: unknown) => ((e as { taps?: Array<{ rack_id: string }> }).taps ?? []).some((t) => r.rackIds?.includes(t.rack_id));
          const sup = topo.edges.find((e) => e.role === 'supply' && tapsOf(e));
          const ret = topo.edges.find((e) => e.role === 'return' && tapsOf(e));
          if (sup) out.push(['supply header', `${sup.id} · ${fmt(ctx.assets[sup.id]?.readings.flow_kg_s, 2, 'kg/s')}`]);
          if (ret) out.push(['return header', `${ret.id} · ${fmt(ctx.assets[ret.id]?.readings.flow_kg_s, 2, 'kg/s')}`]);
          const road = L?.roads?.find((q) => q.between_rows?.includes(r.rowId ?? ''));
          if (road) out.push(['adjacent roads', (L?.roads ?? []).filter((q) => q.between_rows?.includes(r.rowId ?? '')).map((q) => q.road_id).join(' · ')]);
        }
    return out;
  }
  const robot = ctx.robots[id];
  if (robot) {
    out.push(['robot_id', robot.id], ['class', robot.class === 'inpipe' ? 'INPIPE crawler' : 'OUTRIG rover'], ['state', `${robot.fleet?.state ?? robot.mode.toLowerCase()}`]);
    const p = robot.pose.position_xyz_m;
    out.push(['pose xyz', `${p.map((q) => q.toFixed(2)).join(', ')} m`]);
    const fl = robot.fleet as { road_id?: string; sector?: string } | undefined;
    if (fl?.road_id) out.push(['road', `${fl.road_id}${fl.sector ? ` · ${fl.sector}` : ''}`]);
    if (robot.pose.segment_id) out.push(['segment', `${robot.pose.segment_id}${robot.pose.s_m != null ? ` @ ${robot.pose.s_m.toFixed(1)} m` : ''}`]);
    if (robot.fleet?.dock_id) out.push(['dock', robot.fleet.dock_id]);
    return out;
  }
  const e = topo.edges.find((x) => x.id === id);
  if (e) {
    const x = e as typeof e & { circuit_id?: string; taps?: Array<{ rack_id: string; drop_edge_id: string }>; service_access?: { ports?: string[]; valves?: string[]; sensors?: string[]; strainers?: string[]; outrig_service_xyz_m?: number[][] } };
    const flow = readings?.flow_kg_s;
    out.push(['edge_id', e.id], ['loop · role', `${e.loop} · ${e.role}${x.circuit_id ? ` · ${x.circuit_id}` : ''}`], ['upstream node', e.from], ['downstream node', e.to], ['length · bore', `${e.length_m.toFixed(2)} m · DN${e.diameter_mm}`]);
    out.push(['nominal direction', `${e.from} → ${e.to} (+)`]);
    out.push(['SOLVED flow', flow === undefined ? 'no reading' : `${flow >= 0 ? '+' : '−'}${Math.abs(flow).toFixed(3)} kg/s (${flow >= 0 ? 'along nominal' : 'REVERSED'})`]);
    out.push(['pressure', fmt(readings?.pressure_kpa, 1, 'kPa')]);
    if (readings?.dp_kpa !== undefined) out.push(['ΔP', fmt(readings.dp_kpa, 2, 'kPa')]);
    if (readings?.temperature_c !== undefined) out.push(['temperature', fmt(readings.temperature_c, 1, '°C')]);
    else out.push(['temperature', 'not measured on this edge']);
    const taps = x.taps?.length ? `${x.taps.length} rack taps (${x.taps[0].rack_id} … ${x.taps[x.taps.length - 1].rack_id})` : '';
    const hw = [...(x.service_access?.valves ?? []), ...(x.service_access?.sensors ?? []), ...(x.service_access?.strainers ?? [])];
    if (taps || hw.length) out.push(['taps / sensors', [taps, hw.join(', ')].filter(Boolean).join(' · ')]);
    out.push(['service access', e.robot_passable ? `crawler-serviceable${e.access_port_ids?.length ? ` via ${e.access_port_ids.join(', ')}` : ''}` : `external only${e.not_passable_reason ? ` (${e.not_passable_reason})` : ''}`]);
    if (x.service_access?.outrig_service_xyz_m?.length) out.push(['OUTRIG service pts', `${x.service_access.outrig_service_xyz_m.length}`]);
    const crawlers = Object.values(ctx.robots).filter((q) => q.class === 'inpipe' && (q.pose.segment_id === e.id || q.nav?.segment_id === e.id)).map((q) => `${q.id}${q.pose.s_m != null ? ` @ ${q.pose.s_m.toFixed(1)} m` : ''}`);
    out.push(['assigned crawler', crawlers.length ? crawlers.join(' · ') : 'none on this segment']);
    return out;
  }
  const a = topo.assets.find((q) => q.id === id);
  if (a) {
    out.push(['asset_id', a.id], ['type', a.type]);
    if (a.loop) out.push(['loop', a.loop]);
    if (a.zone_id) out.push(['zone', a.zone_id]);
    if (a.type === 'rack') {
      const key = a.id.replace(/^rack_/, '');
      for (const p of m.pods) for (const r of p.rows) if (r.rackIds?.includes(a.id)) out.push(['row_id', r.rowId ?? r.id], ['slot', String(r.rackIds.indexOf(a.id) + 1)]);
      const sd = topo.edges.find((q) => q.id === `p_sd_${key}`);
      const rd = topo.edges.find((q) => q.id === `p_rd_${key}`);
      if (sd) out.push(['supply drop edge', sd.id]);
      if (rd) out.push(['return drop edge', rd.id]);
      const valve = topo.assets.find((q) => q.id === `valve_${key}`);
      if (valve) out.push(['valve', valve.id]);
      out.push(['solver', (a as { solver_backed?: boolean }).solver_backed ? 'solver-backed' : 'context']);
    }
    if (a.type === 'cdu') {
      const cdu = a as typeof a & { service_xyz_m?: number[] };
      out.push(['primary (FWS)', topo.edges.filter((q) => q.loop === 'fws').map((q) => q.id).join(' · ')]);
      out.push(['secondary (TCS) trunks', ['p_10', 'p_20'].filter((q) => topo.edges.some((e2) => e2.id === q)).join(' · ')]);
      if (cdu.service_xyz_m) out.push(['OUTRIG service pose', cdu.service_xyz_m.map((q) => q.toFixed(1)).join(', ')]);
    }
    if (a.edge_id) out.push(['on edge', `${a.edge_id}${a.s_m != null ? ` @ ${a.s_m.toFixed(1)} m` : ''}`]);
    if (a.accessible_by?.length) out.push(['serviceable by', a.accessible_by.join(' · ')]);
    for (const [k, v] of Object.entries(readings ?? {}).slice(0, 5)) out.push([k, String(Math.round(v * 100) / 100)]);
    return out;
  }
  return out;
}

export function EntityIds({ id }: { id: string }) {
  const topo = useWorld((s) => s.topology);
  const readings = useWorld((s) => s.assets[id]?.readings);
  const assets = useWorld((s) => s.assets);
  const robots = useWorld((s) => s.robots);
  const rows = useMemo(() => (topo ? entityRows(topo, id, { readings, assets, robots }) : []), [topo, id, readings, assets, robots]);
  if (!rows.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '98px 1fr', gap: '3px 8px', fontSize: 11.5, margin: '8px 0' }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <span style={{ color: 'var(--t3)' }}>{k}</span>
          <b className="mono" style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{v}</b>
        </div>
      ))}
    </div>
  );
}

/** Fly the camera to an entity's real bounds (works in Dashboard and Map; safe-area aware through the measured insets). */
export function flyTo(id: string, opts?: { fill?: number }) {
  const w = useWorld.getState();
  if (!w.topology) return false;
  const b = entityBounds(w.topology, id, w.robots);
  if (!b) return false;
  const v = useView.getState();
  const isRobot = !!w.robots[id];
  const goal = fitCamera({ boxes: [b], width: window.innerWidth, height: window.innerHeight, insets: measureInsets(), azimuth: 0.35, elevation: isRobot ? 0.9 : 0.85, fov: 32, fill: opts?.fill ?? 0.8 });
  if (useUi.getState().tab === 'map') useMapCamera.getState().setTactical(goal);
  else v.setCam(goal);
  return true;
}

export function FlyButton({ id }: { id: string }) {
  return (
    <button className="btn btn--sm" onClick={() => flyTo(id)}>
      <Crosshair size={13} /> Fly to
    </button>
  );
}
