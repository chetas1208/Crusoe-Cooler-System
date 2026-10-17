import { useMemo } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import { useView } from '@loopkeeper/scene';


const COL = { tcs_supply: '#2fd3e8', tcs_return: '#ff9a3c', fws_supply: '#5b8dff', fws_return: '#d36bff' };

/** Plan view of the facility: hall, equipment, both loops, robots and the active route. */
export function MiniMap({ width = 244, height = 166, focusEdge }: { width?: number; height?: number; focusEdge?: string | null }) {
  const topo = useWorld((s) => s.topology);
  const robots = useWorld((s) => s.robots);
  const missions = useWorld((s) => s.missions);
  const incidents = useWorld((s) => s.incidents);
  const select = useView((s) => s.select);
  // plan bounds come from the topology's interior box (never a fixed hall size)
  const mn = topo?.facility.interior_min ?? [-15, 0, -11];
  const mx = topo?.facility.interior_max ?? [11, 0, 7];
  const X0 = mn[0] - 1;
  const X1 = mx[0] + 1;
  const Z0 = mn[2] - 1;
  const Z1 = mx[2] + 1;
  const sc = Math.min(width / (X1 - X0), height / (Z1 - Z0));
  const ox = (width - (X1 - X0) * sc) / 2;
  const oz = (height - (Z1 - Z0) * sc) / 2;
  const sx = (x: number) => ox + (x - X0) * sc;
  const sz = (z: number) => oz + (z - Z0) * sc;
  const hall = topo?.facility;
  const edges = useMemo(() => topo?.edges ?? [], [topo]);
  if (!topo || !hall) return null;
  const openAnchors = Object.values(incidents)
    .filter((i) => !i.closed_tick)
    .map((i) => i.anchor);
  const mission = Object.values(missions).find((m) => !m.closed_tick && m.route_xyz_m);
  return (
    <svg width={width} height={height} className="minimap" role="img" aria-label="Facility plan view">
      <rect
        x={sx(hall.interior_min[0])}
        y={sz(hall.interior_min[2])}
        width={sx(hall.interior_max[0]) - sx(hall.interior_min[0])}
        height={sz(hall.interior_max[2]) - sz(hall.interior_min[2])}
        rx="3"
        fill="rgba(255,255,255,.035)"
        stroke="rgba(255,255,255,.16)"
      />
      {topo.expansion_bays.map((b) => (
        <rect key={b.id} x={sx(b.position_xyz_m[0] - b.size_m[0] / 2)} y={sz(b.position_xyz_m[2] - b.size_m[2] / 2)} width={sx(b.size_m[0]) - sx(0)} height={sz(b.size_m[2]) - sz(0)} fill="rgba(255,255,255,.05)" />
      ))}
      {topo.assets
        .filter((a) => a.size_m && ['rack', 'cdu', 'chiller'].includes(a.type))
        .map((a) => (
          <rect
            key={a.id}
            x={sx(a.position_xyz_m[0] - a.size_m![0] / 2)}
            y={sz(a.position_xyz_m[2] - a.size_m![2] / 2)}
            width={Math.max(sx(a.size_m![0]) - sx(0), 3)}
            height={Math.max(sz(a.size_m![2]) - sz(0), 3)}
            rx="1.5"
            fill={a.type === 'rack' ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.18)'}
            onClick={() => select(a.id)}
            style={{ cursor: 'pointer' }}
          />
        ))}
      {edges.map((e) => {
        const d = e.centerline_xyz_m.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sz(p[2]).toFixed(1)}`).join('');
        const c = COL[`${e.loop}_${e.role}` as keyof typeof COL];
        const on = focusEdge === e.id;
        return <path key={e.id} d={d} fill="none" stroke={c} strokeWidth={on ? 3.2 : e.robot_passable ? 1.7 : 1} opacity={on ? 1 : e.robot_passable ? 0.75 : 0.4} strokeLinejoin="round" strokeLinecap="round" onClick={() => select(e.id)} style={{ cursor: 'pointer' }} />;
      })}
      {mission?.route_xyz_m && mission.route_xyz_m.length > 1 && (
        <path d={mission.route_xyz_m.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sz(p[2]).toFixed(1)}`).join('')} fill="none" stroke={mission.robot_id.startsWith('c_') ? '#2fd3e8' : '#ff9a3c'} strokeWidth="1.6" strokeDasharray="3 3" opacity="0.95" />
      )}
      {openAnchors.map((a, i) => (
        <g key={i} transform={`translate(${sx(a.position_xyz_m[0])},${sz(a.position_xyz_m[2])})`}>
          <circle r="6" fill="rgba(255,154,60,.18)">
            <animate attributeName="r" values="4;9;4" dur="2s" repeatCount="indefinite" />
          </circle>
          <circle r="2.6" fill="#ff9a3c" />
        </g>
      ))}
      {Object.values(robots).map((r) => (
        <g key={r.id} transform={`translate(${sx(r.pose.position_xyz_m[0])},${sz(r.pose.position_xyz_m[2])})`} onClick={() => select(r.id)} style={{ cursor: 'pointer' }}>
          <circle r={r.mode === 'DOCKED' ? 3 : 5} fill={r.class === 'inpipe' ? 'rgba(47,211,232,.3)' : 'rgba(255,154,60,.3)'} />
          <circle r="2.4" fill={r.class === 'inpipe' ? '#2fd3e8' : '#ff9a3c'} />
        </g>
      ))}
    </svg>
  );
}
