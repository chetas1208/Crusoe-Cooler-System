import type {
  Asset,
  NavObstacle,
  PipeEdge,
  Topology,
  TopologyNode,
  Vec3,
  Zone,
} from '../contracts';
import { buildPath, polylineLength, samplePath } from '../geometry';

/**
 * An original, fictional small data-center wing ("Lab Hall 01").
 * 2 cooling zones · 16 liquid-fed racks (4 instrumented GPU racks + 12 network/storage/CPU racks) · 1 CDU · 2 loops (FWS ↔ TCS) joined only
 * through the CDU heat exchanger. Heat crosses the CDU, mass does not.
 *
 * Coordinates are metres: x = hall length, z = hall depth, y = up.
 * Hall interior: x ∈ [-10.5, 9.5], z ∈ [-6, 6], wall height 4.6.
 */

export { HALL, RACK, ROW_Z, BAY_X, RACK_X } from './layout';
import { BAY_X, HALL, RACK, RACK_SLOTS, ROW_Z } from './layout';

const Y_SUP = 3.1;
const Y_RET = 2.75;
const FILLET = 0.28;
/** x where the zone headers end (one pitch past the last rack tap) */
const HDR_END = BAY_X[BAY_X.length - 1] + 0.6;

const n = (id: string, label: string, loop: 'fws' | 'tcs', p: Vec3): TopologyNode => ({
  id,
  label,
  loop,
  position_xyz_m: p,
});

interface EdgeDef {
  id: string;
  label: string;
  name: string;
  loop: 'fws' | 'tcs';
  role: 'supply' | 'return';
  zone_id?: string;
  from: string;
  to: string;
  pts: Vec3[];
  dn: number;
  passable: boolean;
  ports?: string[];
  fillet?: number;
  reason?: string;
}

const NOT_PASSABLE = 'Bore ≤ 40 mm — too small for any crawler. Inspect from outside only.';

export function buildTopology(): Topology {
  /* ── nodes ── */
  const nodes: TopologyNode[] = [
    n('n_fws_chiller_s', 'Chiller supply', 'fws', [-8.5, 0.9, -7.4]),
    n('n_fws_pump', 'FWS pump skid', 'fws', [-8.5, 0.9, -3.4]),
    n('n_cdu_fs', 'CDU primary in', 'fws', [-8.5, 0.9, -1.2]),
    n('n_cdu_fr', 'CDU primary out', 'fws', [-7.9, 0.9, -1.2]),
    n('n_fws_chiller_r', 'Chiller return', 'fws', [-7.9, 0.9, -7.4]),
    n('n_cdu_ts', 'CDU secondary out', 'tcs', [-7.55, 1.5, -0.45]),
    n('n_js', 'Supply junction', 'tcs', [-3.6, Y_SUP, -0.45]),
    n('n_a_s_end', 'Zone A supply end', 'tcs', [HDR_END, Y_SUP, -2.85]),
    n('n_b_s_end', 'Zone B supply end', 'tcs', [HDR_END, Y_SUP, 2.85]),
    n('n_cdu_tr', 'CDU secondary in', 'tcs', [-7.55, 1.5, 0.45]),
    n('n_jr', 'Return junction', 'tcs', [-4.0, Y_RET, 0.45]),
    n('n_a_r_end', 'Zone A return end', 'tcs', [HDR_END, Y_RET, -3.2]),
    n('n_b_r_end', 'Zone B return end', 'tcs', [HDR_END, Y_RET, 3.2]),
  ];
  // taps for rack drops
  const racks = RACK_SLOTS;
  const supZ = { a: -2.85, b: 2.85 };
  const retZ = { a: -3.2, b: 3.2 };
  for (const r of racks) {
    nodes.push(n(`n_${r.key}_s`, `${r.key.toUpperCase()} supply tap`, 'tcs', [r.x - 0.2, Y_SUP, supZ[r.zone]]));
    nodes.push(n(`n_${r.key}_r`, `${r.key.toUpperCase()} return tap`, 'tcs', [r.x + 0.2, Y_RET, retZ[r.zone]]));
    nodes.push(n(`n_${r.key}_in`, `${r.key.toUpperCase()} coolant in`, 'tcs', [r.x - 0.2, RACK.h, supZ[r.zone]]));
    nodes.push(n(`n_${r.key}_out`, `${r.key.toUpperCase()} coolant out`, 'tcs', [r.x + 0.2, RACK.h, retZ[r.zone]]));
  }

  /* ── edges ── */
  const defs: EdgeDef[] = [
    // Facility-water loop (primary) — wall penetration to CDU
    {
      id: 'p_01', label: 'P-01', name: 'FWS supply · chiller to pump skid', loop: 'fws', role: 'supply',
      from: 'n_fws_chiller_s', to: 'n_fws_pump', dn: 200, passable: true, ports: ['port_a1'],
      pts: [[-8.5, 0.9, -7.4], [-8.5, 0.9, -3.4]],
    },
    {
      id: 'p_02', label: 'P-02', name: 'FWS supply · skid to CDU', loop: 'fws', role: 'supply',
      from: 'n_fws_pump', to: 'n_cdu_fs', dn: 200, passable: true,
      pts: [[-8.5, 0.9, -3.4], [-8.5, 0.9, -1.2]],
    },
    {
      id: 'p_03', label: 'P-03', name: 'FWS return · CDU to chiller', loop: 'fws', role: 'return',
      from: 'n_cdu_fr', to: 'n_fws_chiller_r', dn: 200, passable: true,
      pts: [[-7.9, 0.9, -1.2], [-7.9, 0.9, -7.4]],
    },
    // Technology-cooling loop (secondary) — supply
    {
      id: 'p_10', label: 'P-10', name: 'TCS supply trunk', loop: 'tcs', role: 'supply',
      from: 'n_cdu_ts', to: 'n_js', dn: 150, passable: true, ports: ['port_a2'],
      pts: [[-7.55, 1.5, -0.45], [-5.9, 1.5, -0.45], [-5.9, Y_SUP, -0.45], [-3.6, Y_SUP, -0.45]],
    },
    {
      id: 'p_12', label: 'P-12', name: 'Zone A supply header', loop: 'tcs', role: 'supply', zone_id: 'zone_a',
      from: 'n_js', to: 'n_a_s_end', dn: 100, passable: true,
      pts: [[-3.6, Y_SUP, -0.45], [-3.6, Y_SUP, supZ.a], [HDR_END, Y_SUP, supZ.a]],
    },
    {
      id: 'p_17', label: 'P-17', name: 'Zone B supply header', loop: 'tcs', role: 'supply', zone_id: 'zone_b',
      from: 'n_js', to: 'n_b_s_end', dn: 100, passable: true, ports: ['port_b1'],
      pts: [[-3.6, Y_SUP, -0.45], [-3.6, Y_SUP, supZ.b], [HDR_END, Y_SUP, supZ.b]],
    },
    // Technology-cooling loop — return
    {
      id: 'p_20', label: 'P-20', name: 'TCS return trunk', loop: 'tcs', role: 'return',
      from: 'n_jr', to: 'n_cdu_tr', dn: 150, passable: true,
      pts: [[-4.0, Y_RET, 0.45], [-6.3, Y_RET, 0.45], [-6.3, 1.5, 0.45], [-7.55, 1.5, 0.45]],
    },
    {
      id: 'p_22', label: 'P-22', name: 'Zone A return header', loop: 'tcs', role: 'return', zone_id: 'zone_a',
      from: 'n_a_r_end', to: 'n_jr', dn: 100, passable: true,
      pts: [[HDR_END, Y_RET, retZ.a], [-4.0, Y_RET, retZ.a], [-4.0, Y_RET, 0.45]],
    },
    {
      id: 'p_27', label: 'P-27', name: 'Zone B return header', loop: 'tcs', role: 'return', zone_id: 'zone_b',
      from: 'n_b_r_end', to: 'n_jr', dn: 100, passable: true,
      pts: [[HDR_END, Y_RET, retZ.b], [-4.0, Y_RET, retZ.b], [-4.0, Y_RET, 0.45]],
    },
  ];
  // rack drops (DN40 — not crawler-passable)
  for (const r of racks) {
    const sId = r.supEdge.slice(2);
    const rId = r.retEdge.slice(2);
    const dn = r.hero ? 40 : 25;
    defs.push({
      id: `p_${sId}`, label: `P-${sId}`, name: `Rack ${r.key.toUpperCase()} supply drop`, loop: 'tcs', role: 'supply',
      zone_id: `zone_${r.zone}`, from: `n_${r.key}_s`, to: `n_${r.key}_in`, dn, passable: false, reason: NOT_PASSABLE, fillet: 0.1,
      pts: [[r.x - 0.2, Y_SUP, supZ[r.zone]], [r.x - 0.2, RACK.h, supZ[r.zone]]],
    });
    defs.push({
      id: `p_${rId}`, label: `P-${rId}`, name: `Rack ${r.key.toUpperCase()} return drop`, loop: 'tcs', role: 'return',
      zone_id: `zone_${r.zone}`, from: `n_${r.key}_out`, to: `n_${r.key}_r`, dn, passable: false, reason: NOT_PASSABLE, fillet: 0.1,
      pts: [[r.x + 0.2, RACK.h, retZ[r.zone]], [r.x + 0.2, Y_RET, retZ[r.zone]]],
    });
  }

  const edges: PipeEdge[] = defs.map((d) => ({
    id: d.id,
    label: d.label,
    name: d.name,
    loop: d.loop,
    role: d.role,
    zone_id: d.zone_id,
    from: d.from,
    to: d.to,
    centerline_xyz_m: d.pts,
    fillet_radius_m: d.fillet ?? FILLET,
    length_m: round(buildPath(d.pts, d.fillet ?? FILLET).length, 2),
    diameter_mm: d.dn,
    clearance_mm: d.passable ? Math.round(d.dn * 0.5 - 20) : 0,
    robot_passable: d.passable,
    not_passable_reason: d.passable ? undefined : d.reason,
    access_port_ids: d.ports ?? [],
  }));
  const edgeById = Object.fromEntries(edges.map((e) => [e.id, e]));

  const onEdge = (edgeId: string, s: number): Vec3 => {
    const e = edgeById[edgeId];
    const path = buildPath(e.centerline_xyz_m, e.fillet_radius_m);
    return samplePath(path, s).p;
  };

  /* ── assets ── */
  const assets: Asset[] = [];
  const zones: Zone[] = [
    { id: 'zone_a', name: 'Zone A', rack_ids: racks.filter((r) => r.zone === 'a').map((r) => `rack_${r.key}`), anchor_xyz_m: [2.8, 0, ROW_Z.a] },
    { id: 'zone_b', name: 'Zone B', rack_ids: racks.filter((r) => r.zone === 'b').map((r) => `rack_${r.key}`), anchor_xyz_m: [2.8, 0, ROW_Z.b] },
  ];

  for (const r of racks) {
    assets.push({
      id: `rack_${r.key}`, type: 'rack', label: `R-${r.key.toUpperCase()}`, name: r.hero ? `Rack ${r.key.toUpperCase()} · liquid-cooled GPU` : `Rack ${r.key.toUpperCase()} · ${r.role}`,
      loop: 'tcs', zone_id: `zone_${r.zone}`, position_xyz_m: [r.x, 0, r.z],
      size_m: [RACK.w, RACK.h, RACK.d], yaw_rad: r.zone === 'a' ? 0 : Math.PI,
      accessible_by: [],
      spec: { 'Role': r.role, 'Design load': `${r.kw} kW`, 'Coolant': 'PG25', 'Throttle limit': '90 °C', 'Diagnosis': r.hero ? 'Instrumented (fault target)' : 'Telemetry only' },
    });
  }
  assets.push({
    id: 'cdu_01', type: 'cdu', label: 'CDU-01', name: 'Coolant distribution unit',
    position_xyz_m: [-8.2, 0, 0], size_m: [1.3, 2.2, 2.4], accessible_by: ['outrig'],
    spec: { 'Capacity': '600 kW', 'Heat exchanger': 'Brazed plate', 'Primary': 'FWS (facility water)', 'Secondary': 'TCS (PG25)' },
    service_xyz_m: [-5.6, 0, -1.9],
  });
  assets.push({
    id: 'chiller_01', type: 'chiller', label: 'CHL-01', name: 'Dry-cooler bank (external)',
    position_xyz_m: [-8.2, 0, -9.0], size_m: [5.2, 2.2, 3.0], accessible_by: [],
    spec: { 'Supply setpoint': '27 °C', 'Note': 'Outside the hall' },
  });
  // pumps
  const pumpDefs: Array<[string, string, string, 'fws' | 'tcs', Vec3, string, Vec3]> = [
    ['pump_t1', 'TCS-PMP-1', 'TCS circulation pump · duty', 'tcs', [-6.85, 0, -1.55], 'p_10', [-5.4, 0, -2.4]],
    ['pump_t2', 'TCS-PMP-2', 'TCS circulation pump · standby', 'tcs', [-6.0, 0, -1.55], 'p_10', [-5.4, 0, -2.4]],
    ['pump_f1', 'FWS-PMP-1', 'FWS pump · duty', 'fws', [-9.7, 0, -4.1], 'p_01', [-7.2, 0, -4.4]],
    ['pump_f2', 'FWS-PMP-2', 'FWS pump · standby', 'fws', [-9.7, 0, -5.1], 'p_01', [-7.2, 0, -4.9]],
  ];
  for (const [id, label, name, loop, pos, edge_id, svc] of pumpDefs) {
    assets.push({
      id, type: 'pump', label, name, loop, position_xyz_m: pos, size_m: [0.7, 0.9, 0.5], edge_id,
      accessible_by: ['outrig'], service_xyz_m: svc,
      spec: loop === 'tcs'
        ? { 'Type': 'End-suction centrifugal', 'Rated flow': '8 kg/s', 'Rated head': '290 kPa shut-off' }
        : { 'Type': 'End-suction centrifugal', 'Rated flow': '13 kg/s', 'Rated head': '270 kPa' },
    });
  }
  // strainers
  assets.push({
    id: 'strainer_01', type: 'strainer', label: 'S-01', name: 'FWS Y-strainer', loop: 'fws',
    position_xyz_m: [-8.5, 0.9, -2.9], edge_id: 'p_02', s_m: 0.5, accessible_by: ['outrig'], service_xyz_m: [-7.0, 0, -3.0],
    spec: { 'Mesh': '1.5 mm', 'Service': 'Basket exchange' },
  });
  assets.push({
    id: 'strainer_02', type: 'strainer', label: 'S-02', name: 'TCS basket strainer', loop: 'tcs',
    position_xyz_m: [-5.9, 2.2, -0.45], edge_id: 'p_10', s_m: 2.4, accessible_by: ['outrig'], service_xyz_m: [-5.3, 0, -1.5],
    spec: { 'Mesh': '0.8 mm', 'Service': 'Basket exchange' },
  });
  // balancing valves on rack branches + zone isolation valves
  for (const r of racks) {
    const edge = r.supEdge;
    assets.push({
      id: `valve_${r.key}`, type: 'valve', label: `V-${r.key.toUpperCase()}`, name: `Rack ${r.key.toUpperCase()} balancing valve`, loop: 'tcs',
      zone_id: `zone_${r.zone}`, position_xyz_m: [r.x - 0.2, 2.63, supZ[r.zone]], edge_id: edge, accessible_by: ['outrig'],
      service_xyz_m: [r.x - 0.2, 0, r.zone === 'a' ? -1.55 : 1.55],
      spec: { 'Type': 'Motorised ball', 'Kv': 'Rack-balanced', 'Actuator': 'Rotary 24 V' },
    });
  }
  // per-rack branch flow meters (the redundant meters the monitor trusts over a drifting header meter)
  for (const r of racks) {
    assets.push({
      id: `sn_rack_${r.key}`, type: 'sensor', label: `FM-${r.key.toUpperCase()}`, name: `Rack ${r.key.toUpperCase()} branch flow meter`, loop: 'tcs',
      zone_id: `zone_${r.zone}`, edge_id: r.supEdge, s_m: 0.42, position_xyz_m: [r.x - 0.2, 2.9, supZ[r.zone]], accessible_by: ['outrig'],
      service_xyz_m: [r.x - 0.2, 0, r.zone === 'a' ? -1.55 : 1.55],
      spec: { 'Principle': 'Ultrasonic transit-time', 'Accuracy': '±1 % of reading' },
    });
  }
  assets.push({
    id: 'valve_za', type: 'valve', label: 'V-ZA', name: 'Zone A isolation valve', loop: 'tcs', zone_id: 'zone_a',
    position_xyz_m: onEdge('p_12', 3.0), edge_id: 'p_12', s_m: 3.0, accessible_by: ['outrig'], service_xyz_m: [-3.1, 0, -1.55],
    spec: { 'Type': 'Butterfly · lever' },
  });
  assets.push({
    id: 'valve_zb', type: 'valve', label: 'V-ZB', name: 'Zone B isolation valve', loop: 'tcs', zone_id: 'zone_b',
    position_xyz_m: onEdge('p_17', 3.2), edge_id: 'p_17', s_m: 3.2, accessible_by: ['outrig'], service_xyz_m: [-3.1, 0, 1.55],
    spec: { 'Type': 'Butterfly · lever' },
  });
  // flow meters (can drift)
  const meters: Array<[string, string, string, 'tcs' | 'fws', string, number]> = [
    ['sn_flow_trunk', 'FM-10', 'TCS trunk flow meter', 'tcs', 'p_10', 1.2],
    ['sn_flow_za', 'FM-12', 'Zone A flow meter', 'tcs', 'p_12', 4.2],
    ['sn_flow_zb', 'FM-17', 'Zone B flow meter', 'tcs', 'p_17', 4.6],
  ];
  for (const [id, label, name, loop, edge_id, s] of meters) {
    assets.push({
      id, type: 'sensor', label, name, loop, edge_id, s_m: s, position_xyz_m: onEdge(edge_id, s), accessible_by: ['outrig', 'inpipe'],
      service_xyz_m: id === 'sn_flow_zb' ? [-2.4, 0, 1.6] : id === 'sn_flow_za' ? [-2.4, 0, -1.6] : [-5.3, 0, -1.5],
      spec: { 'Principle': 'Ultrasonic transit-time', 'Accuracy': '±0.5 % of reading' },
    });
  }
  // access ports + docks
  assets.push({
    id: 'port_a1', type: 'port', label: 'PORT-A1', name: 'FWS crawler launch port', loop: 'fws', edge_id: 'p_01', s_m: 0.6,
    position_xyz_m: onEdge('p_01', 0.6), accessible_by: ['inpipe'],
  });
  assets.push({
    id: 'port_a2', type: 'port', label: 'PORT-A2', name: 'TCS supply launch port', loop: 'tcs', edge_id: 'p_10', s_m: 0.5,
    position_xyz_m: onEdge('p_10', 0.5), accessible_by: ['inpipe'],
  });
  assets.push({
    id: 'port_b1', type: 'port', label: 'PORT-B1', name: 'Zone B header service port', loop: 'tcs', edge_id: 'p_17', s_m: 7.9,
    position_xyz_m: onEdge('p_17', 7.9), accessible_by: ['inpipe'],
  });
  assets.push({
    id: 'dock_o1', type: 'dock', label: 'DOCK-O1', name: 'OUTRIG charging bay', position_xyz_m: [8.3, 0, 0.0], size_m: [1.4, 0.05, 1.8],
    accessible_by: [],
  });

  /* ── navigation obstacles (ground-plane rectangles) ── */
  const lastBayX = BAY_X[BAY_X.length - 1];
  const firstBayX = BAY_X[0];
  const rowRect = (z: number): [number, number, number, number] => [
    firstBayX - RACK.w / 2, z - RACK.d / 2, lastBayX + RACK.w / 2, z + RACK.d / 2,
  ];
  const obstacles: NavObstacle[] = [
    { id: 'obs_row_a', rect: rowRect(ROW_Z.a), label: 'Rack row A' },
    { id: 'obs_row_b', rect: rowRect(ROW_Z.b), label: 'Rack row B' },
    { id: 'obs_cdu', rect: [-8.85, -1.2, -7.55, 1.2], label: 'CDU-01' },
    { id: 'obs_tcs_pumps', rect: [-7.3, -1.95, -5.6, -1.1], label: 'TCS pumps' },
    { id: 'obs_fws_pumps', rect: [-10.1, -5.5, -9.2, -3.7], label: 'FWS pumps' },
  ];

  const topo: Topology = {
    facility: {
      id: 'lab_01',
      name: 'Lab Hall 01',
      label: 'Simulated facility',
      config_version: 'facility-small@0.1',
      topology_hash: hashStr(JSON.stringify({ edges: edges.map((e) => e.id), assets: assets.map((a) => a.id) })),
      bounds_min: [HALL.minX - 3, 0, HALL.minZ - 5],
      bounds_max: [HALL.maxX, HALL.height, HALL.maxZ],
      interior_min: [HALL.minX, 0, HALL.minZ],
      interior_max: [HALL.maxX, HALL.height, HALL.maxZ],
      wall_height_m: HALL.height,
    },
    expansion_bays: BAY_X.flatMap((x) =>
      (['a', 'b'] as const)
        .filter((z) => !racks.some((r) => r.zone === z && Math.abs(r.x - x) < 0.01))
        .map((z) => ({
          id: `bay_${z}_${x.toFixed(1)}`,
          position_xyz_m: [x, 0, ROW_Z[z]] as Vec3,
          size_m: [RACK.w, RACK.h, RACK.d] as Vec3,
          yaw_rad: z === 'a' ? 0 : Math.PI,
        })),
    ),
    zones,
    nodes,
    edges,
    assets,
    nav: { cell_m: 0.25, obstacles, dock_ids: ['dock_o1', 'port_a1', 'port_a2'] },
    limits: { chip_limit_c: 90, margin_warn_k: 11, margin_crit_k: 5, nominal_rack_kw: 120 },
  };
  return topo;
}

/* ── helpers ── */

export function round(x: number, d = 2) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export { polylineLength };
