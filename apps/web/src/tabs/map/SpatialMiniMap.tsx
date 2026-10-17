import { useMemo } from 'react';
import { useWorld } from '@loopkeeper/core/store';
import { useView, useMapCamera, siteModel, roadSel, rowSel, fitCamera, measureInsets } from '@loopkeeper/scene';

const COL = {
  tcs_supply: '#2fd3e8',
  tcs_return: '#ff9a3c',
  fws_supply: '#5b8dff',
  fws_return: '#d36bff',
};

interface SpatialMiniMapProps {
  width?: number;
  height?: number;
  selectedRobotId?: string | null;
  onSelectRobot?: (id: string) => void;
}

/**
 * Interactive 2D plan-view mini-map for the Map tab.
 * Uses exact authoritative facility topology coordinates matching the 3D scene 1:1.
 */
export function SpatialMiniMap({
  width = 256,
  height = 176,
  selectedRobotId,
  onSelectRobot,
}: SpatialMiniMapProps) {
  const topo = useWorld((s) => s.topology);
  const robots = useWorld((s) => s.robots);
  const missions = useWorld((s) => s.missions);
  const incidents = useWorld((s) => s.incidents);
  const selectAsset = useView((s) => s.select);
  const selectedId = useView((s) => s.selectedId);
  const selectCamRobot = useMapCamera((s) => s.selectRobot);

  const hall = topo?.facility;
  const site = useMemo(() => (topo ? siteModel(topo) : null), [topo]);
  const edges = useMemo(() => topo?.edges ?? [], [topo]);

  // Derived coordinate projection bounds from facility interior
  const bounds = useMemo(() => {
    if (!hall) return { minX: -16, maxX: 11, minZ: -11, maxZ: 7.5 };
    const pad = 1.0;
    return {
      minX: hall.interior_min[0] - pad,
      maxX: hall.interior_max[0] + pad,
      minZ: hall.interior_min[2] - pad,
      maxZ: hall.interior_max[2] + pad,
    };
  }, [hall]);

  // uniform metres→px scale, plan centred in the box (the map is a true plan, never stretched)
  const scale = Math.min(width / (bounds.maxX - bounds.minX), height / (bounds.maxZ - bounds.minZ));
  const offX = (width - (bounds.maxX - bounds.minX) * scale) / 2;
  const offZ = (height - (bounds.maxZ - bounds.minZ) * scale) / 2;
  const sx = (x: number) => offX + (x - bounds.minX) * scale;
  const sz = (z: number) => offZ + (z - bounds.minZ) * scale;

  if (!topo || !hall) return null;

  const openAnchors = Object.values(incidents)
    .filter((i) => !i.closed_tick)
    .map((i) => i.anchor);

  const activeMission = Object.values(missions).find(
    (m) => !m.closed_tick && m.route_xyz_m && m.route_xyz_m.length > 1,
  );

  const handleRobotClick = (id: string, klass: 'inpipe' | 'outrig') => {
    selectCamRobot(id, klass);
    selectAsset(id);
    void klass;
    onSelectRobot?.(id);
  };

  return (
    <div className="spatial-minimap-wrap" style={{ position: 'relative', width, height }}>
      <svg
        width={width}
        height={height}
        className="minimap spatial-minimap"
        role="img"
        aria-label="Authoritative facility plan view"
        style={{
          background: 'rgba(8, 12, 18, 0.75)',
          borderRadius: 6,
          border: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'block',
        }}
      >
        <defs>
          <radialGradient id="robot-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#2fd3e8" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#2fd3e8" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="rover-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ff9a3c" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#ff9a3c" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Facility perimeter / floor outline */}
        <rect
          x={sx(hall.interior_min[0])}
          y={sz(hall.interior_min[2])}
          width={sx(hall.interior_max[0]) - sx(hall.interior_min[0])}
          height={sz(hall.interior_max[2]) - sz(hall.interior_min[2])}
          rx="4"
          fill="rgba(255, 255, 255, 0.025)"
          stroke="rgba(255, 255, 255, 0.18)"
          strokeWidth="1"
          style={{ cursor: 'crosshair' }}
          onClick={(ev) => {
            // locator: click empty floor → the 3D camera flies to that spot
            const r = (ev.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
            const x = (ev.clientX - r.left - offX) / scale + bounds.minX;
            const z = (ev.clientY - r.top - offZ) / scale + bounds.minZ;
            const goal = fitCamera({ boxes: [{ min: [x - 5, 0, z - 4], max: [x + 5, 3.4, z + 4] }], width: window.innerWidth, height: window.innerHeight, insets: measureInsets(), azimuth: 0.35, elevation: 0.9, fov: 32, fill: 0.8 });
            useMapCamera.getState().setTactical(goal);
          }}
        />

        {/* Everything below is generated from the topology manifest: rooms (mechanical bay, XA-W/XA-E), the five ROW stripes, the four ROAD lanes. Clicking one selects it (the 3D camera flies there). */}
        {site?.rooms.filter((r) => r.kind !== 'yard' && r.kind !== 'road').map((r) => (
          <g key={r.id}>
            <rect x={sx(r.rect[0])} y={sz(r.rect[1])} width={sx(r.rect[2]) - sx(r.rect[0])} height={sz(r.rect[3]) - sz(r.rect[1])} fill={r.kind === 'cross_aisle' ? 'rgba(232,185,59,0.06)' : 'none'} stroke="rgba(255,255,255,0.09)" strokeWidth="0.8" />
            {(r.kind === 'cross_aisle' || r.kind === 'mechanical') && (
              <text x={(sx(r.rect[0]) + sx(r.rect[2])) / 2} y={sz(r.rect[1]) + 9} fontSize="6.5" textAnchor="middle" fill="rgba(190,210,230,0.55)">
                {r.kind === 'mechanical' ? 'MECH / CDU BAY' : r.id === 'xa_w' ? 'XA-W' : 'XA-E'}
              </text>
            )}
          </g>
        ))}
        {site?.roads.map((r) => {
          const key = r.roadId ?? r.id;
          const on = selectedId === roadSel(key);
          return (
            <g key={r.id} onClick={() => selectAsset(roadSel(key))} style={{ cursor: 'pointer' }}>
              <rect x={sx(r.x0)} y={sz(r.z0)} width={sx(r.x1) - sx(r.x0)} height={Math.max(sz(r.z1) - sz(r.z0), 2)} fill={on ? 'rgba(47,211,232,0.4)' : 'rgba(47,211,232,0.12)'} stroke={on ? '#2fd3e8' : 'none'} />
              <line x1={sx(r.x0)} x2={sx(r.x1)} y1={sz((r.z0 + r.z1) / 2)} y2={sz((r.z0 + r.z1) / 2)} stroke="rgba(47,211,232,0.55)" strokeDasharray="3 3" strokeWidth="0.8" />
              <text x={sx(r.x1) + 2} y={sz((r.z0 + r.z1) / 2) + 2.5} fontSize="6.5" fill="rgba(120,220,235,0.9)">{key.replace('ROAD-0', 'R')}</text>
              <title>{`${key} · ${(r.meta?.clear_width_m ?? r.width).toFixed(1)} m clear`}</title>
            </g>
          );
        })}
        {site?.pods.flatMap((p) => p.rows).map((row) => {
          const key = row.rowId ?? row.id;
          const on = selectedId === rowSel(key) || (!!selectedId && !!row.rackIds?.includes(selectedId));
          return (
            <g key={row.id} onClick={() => selectAsset(rowSel(key))} style={{ cursor: 'pointer' }}>
              <rect x={sx(row.x0)} y={sz(row.z - site.rackDims.d / 2)} width={sx(row.x1) - sx(row.x0)} height={Math.max(sz(site.rackDims.d) - sz(0), 2)} fill={on ? 'rgba(91,227,208,0.55)' : 'rgba(255,255,255,0.14)'} />
              <text x={sx(row.x0) - 2} y={sz(row.z) + 2.5} fontSize="6.5" textAnchor="end" fill="rgba(200,210,225,0.75)">{key.replace('ROW-0', 'W')}</text>
              <title>{`${key} · ${row.n} racks`}</title>
            </g>
          );
        })}

        {/* Expansion Bays */}
        {topo.expansion_bays.map((b) => (
          <rect
            key={b.id}
            x={sx(b.position_xyz_m[0] - b.size_m[0] / 2)}
            y={sz(b.position_xyz_m[2] - b.size_m[2] / 2)}
            width={sx(b.size_m[0]) - sx(0)}
            height={sz(b.size_m[2]) - sz(0)}
            fill="rgba(255, 255, 255, 0.04)"
            stroke="rgba(255, 255, 255, 0.08)"
            strokeDasharray="2 2"
          />
        ))}

        {/* Server Racks, CDU, Chillers */}
        {topo.assets
          .filter((a) => a.size_m && ['rack', 'cdu', 'chiller', 'pump'].includes(a.type))
          .map((a) => {
            const rx = sx(a.position_xyz_m[0] - a.size_m![0] / 2);
            const rz = sz(a.position_xyz_m[2] - a.size_m![2] / 2);
            const rw = Math.max(sx(a.size_m![0]) - sx(0), 3);
            const rh = Math.max(sz(a.size_m![2]) - sz(0), 3);
            const isRack = a.type === 'rack';
            const isCdu = a.type === 'cdu';
            return (
              <rect
                key={a.id}
                x={rx}
                y={rz}
                width={rw}
                height={rh}
                rx="1.5"
                fill={isRack ? 'rgba(255, 255, 255, 0.22)' : isCdu ? 'rgba(47, 211, 232, 0.35)' : 'rgba(255, 255, 255, 0.14)'}
                stroke={isCdu ? '#2fd3e8' : 'rgba(255, 255, 255, 0.12)'}
                strokeWidth={isCdu ? 1 : 0.5}
                onClick={() => selectAsset(a.id)}
                style={{ cursor: 'pointer' }}
              >
                <title>{`${a.label ?? a.id} (${a.type})`}</title>
              </rect>
            );
          })}

        {/* Pipe graph centerlines */}
        {edges.map((e) => {
          const d = e.centerline_xyz_m
            .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${sx(p[0]).toFixed(1)},${sz(p[2]).toFixed(1)}`)
            .join(' ');
          const c = COL[`${e.loop}_${e.role}` as keyof typeof COL] ?? 'rgba(255,255,255,0.3)';
          return (
            <path
              key={e.id}
              d={d}
              fill="none"
              stroke={c}
              strokeWidth={e.robot_passable ? 1.6 : 0.9}
              opacity={e.robot_passable ? 0.8 : 0.35}
              strokeLinejoin="round"
              strokeLinecap="round"
              onClick={() => selectAsset(e.id)}
              style={{ cursor: 'pointer' }}
            >
              <title>{`${e.label} · ${e.name} (${e.loop} ${e.role})`}</title>
            </path>
          );
        })}

        {/* Active mission path */}
        {activeMission?.route_xyz_m && (
          <path
            d={activeMission.route_xyz_m
              .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${sx(p[0]).toFixed(1)},${sz(p[2]).toFixed(1)}`)
              .join(' ')}
            fill="none"
            stroke={activeMission.robot_id.startsWith('c_') ? '#2fd3e8' : '#ff9a3c'}
            strokeWidth="1.8"
            strokeDasharray="3 3"
            opacity="0.95"
          />
        )}

        {/* Open incident markers */}
        {openAnchors.map((a, idx) => (
          <g key={idx} transform={`translate(${sx(a.position_xyz_m[0])}, ${sz(a.position_xyz_m[2])})`}>
            <circle r="7" fill="rgba(255, 154, 60, 0.2)">
              <animate attributeName="r" values="4;9;4" dur="2s" repeatCount="indefinite" />
            </circle>
            <circle r="2.8" fill="#ff9a3c" />
          </g>
        ))}

        {/* Robots */}
        {Object.values(robots).map((r) => {
          const isSelected = r.id === selectedRobotId;
          const isCrawler = r.class === 'inpipe';
          const rx = sx(r.pose.position_xyz_m[0]);
          const rz = sz(r.pose.position_xyz_m[2]);
          const col = isCrawler ? '#2fd3e8' : '#ff9a3c';

          return (
            <g
              key={r.id}
              transform={`translate(${rx}, ${rz})`}
              onClick={() => handleRobotClick(r.id, r.class)}
              style={{ cursor: 'pointer' }}
            >
              {isSelected && (
                <circle
                  r="10"
                  fill={isCrawler ? 'url(#robot-halo)' : 'url(#rover-halo)'}
                  stroke={col}
                  strokeWidth="1.2"
                  strokeDasharray="2 2"
                >
                  <animateTransform
                    attributeName="transform"
                    type="rotate"
                    from="0"
                    to="360"
                    dur="4s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              <circle
                r={isSelected ? 5.5 : r.mode === 'DOCKED' ? 3.5 : 4.5}
                fill={r.mode === 'DOCKED' ? 'rgba(255,255,255,0.4)' : col}
                stroke="#080c12"
                strokeWidth="1"
              />
              <title>{`${r.name} (${r.class.toUpperCase()}) · ${r.mode}`}</title>
            </g>
          );
        })}
      </svg>
      <div
        style={{
          position: 'absolute',
          bottom: 4,
          left: 6,
          fontSize: '9px',
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--t3, rgba(255,255,255,0.4))',
          pointerEvents: 'none',
        }}
      >
        Twin Plan · Authoritative
      </div>
    </div>
  );
}
