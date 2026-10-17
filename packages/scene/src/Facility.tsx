import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { useWorld } from '@loopkeeper/core/store';
import { C } from './theme';
import { makeShader } from './tube';
import { RoomFloors, RoadDecals, RowHighlights } from './Rooms';
import { Batched } from './Batch';
import { mergeParts, xf } from './merge';
import { useView } from './view';

const PLINTH = 1.05;

/**
 * Modular Liquid-Cooled Data Center facility envelope:
 * - Structural concrete foundation slab with floor thickness and expansion joints
 * - Separated Mechanical Gallery (CDU & pump skids) and IT Server Hall (racks)
 * - Interior acoustic partition wall at x = -5.5m with industrial double doors and observation glazing
 * - North wall sealed rubber penetration sleeves for FWS supply (p_01) and return (p_03)
 * - Outdoor Heat Rejection Yard with reinforced equipment pad, security fence, pipe sleepers, and auxiliary power unit
 * - Heavy wide-flange structural steel H-columns and overhead open-web roof trusses with pipe trapeze hangers
 * - Architectural site apron with 2m paving grid replacing expansive empty void
 */
export function Facility() {
  const topo = useWorld((s) => s.topology);
  if (!topo) return null;
  const { interior_min: mn, interior_max: mx, wall_height_m: H } = topo.facility;
  const w = mx[0] - mn[0];
  const d = mx[2] - mn[2];
  const cx = (mx[0] + mn[0]) / 2;
  const cz = (mx[2] + mn[2]) / 2;

  return (
    <group name="facility">
      <SiteApron cx={cx} cz={cz} w={w} d={d} />
      <Floor cx={cx} cz={cz} w={w} d={d} />
      <MechanicalPad />
      <PartitionWalls H={H} />
      <Batched>
        <WallPenetrations />
        <OutdoorYard />
      </Batched>
      <Walls mn={mn} mx={mx} H={H} />
      <StructuralFrame mn={mn} mx={mx} H={H} />
      <Roof cx={cx} cz={cz} w={w} d={d} H={H} />
      <Markings mn={mn} mx={mx} />
    </group>
  );
}

/* ───────────────────────────── 1. SITE APRON & GROUND ───────────────────────────── */

const APRON_VERT = /* glsl */ `varying vec3 vP; void main(){ vP = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vP, 1.0); }`;
const APRON_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vP; uniform vec2 uC; uniform vec2 uHalf; uniform float uAmt;
  void main(){
    vec2 p = vP.xz - uC;
    // 2m modular concrete paving grid
    vec2 g = abs(fract(p / 2.0 + 0.5) - 0.5) * 2.0;
    float line = clamp(1.0 - smoothstep(0.0, 0.04, min(g.x, g.y)), 0.0, 1.0);
    // Smooth elliptical falloff focused tightly on the facility perimeter
    float dx = abs(p.x) / uHalf.x;
    float dz = abs(p.y) / uHalf.y;
    float dist = max(dx, dz);
    float fade = clamp((1.0 - dist) / 0.25, 0.0, 1.0);
    float glow = clamp((1.0 - dist) / 0.25, 0.0, 1.0) * 0.035;
    float k = clamp(line * 0.35 * fade + glow, 0.0, 1.0) * clamp(uAmt, 0.0, 1.0);
    // Subtle architectural graphite/slate line tone
    gl_FragColor = vec4(vec3(0.24, 0.30, 0.40) * k, 1.0);
  }
`;

function SiteApron({ cx, cz, w = 60, d = 42 }: { cx: number; cz: number; w?: number; d?: number }) {
  const u = useMemo(() => ({ uC: { value: new THREE.Vector2(cx, cz) }, uHalf: { value: new THREE.Vector2((w + 7) / 2, (d + 7) / 2) }, uAmt: { value: 1 } }), [cx, cz, w, d]);
  const mat = useMemo(() => makeShader(APRON_VERT, APRON_FRAG, u, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), [u]);
  useFrame((_, dt) => {
    const v = useView.getState();
    const t = v.mode === 'pipe' ? 0 : v.xray ? 0.15 : v.mode === 'agents' ? 0.4 : 1;
    u.uAmt.value += (t - u.uAmt.value) * (1 - Math.exp(-dt * 4));
  });

  // a narrow paved margin around the hall (the outdoor yard has its own pad); a big grey grid would shrink the building in every overview
  const apronW = w + 7;
  const apronD = d + 7;
  const hw = apronW / 2;
  const hd = apronD / 2;

  return (
    <group position={[cx, -0.34, cz]}>
      {/* Site sub-base pavement */}
      <mesh receiveShadow position={[0, -0.01, 0]}>
        <boxGeometry args={[apronW, 0.02, apronD]} />
        <meshStandardMaterial color="#0d1117" roughness={0.95} metalness={0.05} />
      </mesh>
      {/* Fine 2m paving grid line overlay */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1} position={[0, 0.005, 0]}>
        <planeGeometry args={[apronW, apronD]} />
        <primitive object={mat} attach="material" />
      </mesh>
      {/* Perimeter site curb border */}
      <mesh position={[0, 0.02, -hd]}>
        <boxGeometry args={[apronW, 0.04, 0.3]} />
        <meshStandardMaterial color="#1a202c" roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.02, hd]}>
        <boxGeometry args={[apronW, 0.04, 0.3]} />
        <meshStandardMaterial color="#1a202c" roughness={0.8} />
      </mesh>
      <mesh position={[-hw, 0.02, 0]}>
        <boxGeometry args={[0.3, 0.04, apronD]} />
        <meshStandardMaterial color="#1a202c" roughness={0.8} />
      </mesh>
      <mesh position={[hw, 0.02, 0]}>
        <boxGeometry args={[0.3, 0.04, apronD]} />
        <meshStandardMaterial color="#1a202c" roughness={0.8} />
      </mesh>
    </group>
  );
}

/* ───────────────────────────── 2. BUILDING FLOOR SLAB ───────────────────────────── */

function Floor({ cx, cz, w, d }: { cx: number; cz: number; w: number; d: number }) {
  const opacityRef = useRef<THREE.MeshStandardMaterial>(null);
  useFrame((_, dt) => {
    const v = useView.getState();
    const t = !v.layers.floor ? 0.0 : v.xray ? 0.16 : v.mode === 'pipe' ? 0.05 : v.mode === 'agents' ? 0.45 : 1;
    if (opacityRef.current) {
      opacityRef.current.opacity += (t - opacityRef.current.opacity) * (1 - Math.exp(-dt * 5));
      opacityRef.current.visible = opacityRef.current.opacity > 0.01;
    }
  });

  return (
    <group>
      {/* 360 mm structural slab with foundation toe; the per-room finishes are decals (Rooms.tsx) */}
      <mesh position={[cx, -0.18, cz]} receiveShadow>
        <boxGeometry args={[w + 0.8, 0.36, d + 0.8]} />
        <meshStandardMaterial ref={opacityRef} color="#2a3039" roughness={0.9} metalness={0.04} transparent />
      </mesh>
      <RoomFloors />
      <RoadDecals />
      <RowHighlights />
    </group>
  );
}

function mx_val(cx: number, w: number) {
  return cx + w / 2;
}

/* ───────────────────────────── 3. MECHANICAL GALLERY CURBS ───────────────────────────── */

function MechanicalPad() {
  const topo = useWorld((s) => s.topology);
  // equipment plinths come from the asset list (position + footprint), never from a fixed coordinate
  const pads = useMemo(() => (topo?.assets ?? []).filter((a) => (a.type === 'cdu' || a.type === 'pump') && a.size_m), [topo]);
  return (
    <group name="mechanical_pads">
      {pads.map((a) => (
        <mesh key={a.id} position={[a.position_xyz_m[0], 0.02, a.position_xyz_m[2]]} receiveShadow>
          <boxGeometry args={[a.size_m![0] + 0.5, 0.04, a.size_m![2] + 0.5]} />
          <meshStandardMaterial color="#334155" roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

/* ───────────────────────────── 4. INTERIOR PARTITION WALLS & CORRIDORS ───────────────────────────── */

function PartitionWalls({ H }: { H: number }) {
  const topo = useWorld((s) => s.topology);
  const interiorWalls = useMemo(() => {
    return (topo?.site as any)?.walls?.filter((w: any) => !w.exterior) ?? [];
  }, [topo]);
  const doors = useMemo(() => {
    return (topo?.site as any)?.doors ?? [];
  }, [topo]);

  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame((_, dt) => {
    const v = useView.getState();
    const target = v.xray || v.mode === 'pipe' ? 0.08 : v.mode === 'agents' ? 0.35 : 0.95;
    if (matRef.current) {
      matRef.current.opacity += (target - matRef.current.opacity) * (1 - Math.exp(-dt * 4));
      matRef.current.transparent = matRef.current.opacity < 0.98;
    }
  });

  return (
    <group name="interior_partitions">
      {interiorWalls.map((w: any) => (
        <group key={w.id}>
          {w.rect_segments.map(([x0, z0, x1, z1]: [number, number, number, number], idx: number) => {
            const cx = (x0 + x1) / 2;
            const cz = (z0 + z1) / 2;
            const sx = Math.max(0.2, Math.abs(x1 - x0));
            const sz = Math.max(0.2, Math.abs(z1 - z0));
            return (
              <group key={idx} position={[cx, 0, cz]}>
                <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
                  <boxGeometry args={[sx, 1.0, sz]} />
                  <meshStandardMaterial ref={matRef} color={C.wall} roughness={0.88} />
                </mesh>
                <mesh position={[0, 1.02, 0]}>
                  <boxGeometry args={[sx + 0.04, 0.04, sz + 0.04]} />
                  <meshStandardMaterial color={C.wallTop} roughness={0.7} />
                </mesh>
              </group>
            );
          })}
        </group>
      ))}
      {doors.map((d: any) => {
        const [x, y, z] = d.position_xyz_m;
        return (
          <group key={d.id} position={[x, y + 1.25, z]}>
            <mesh position={[0, 1.2, 0]}>
              <boxGeometry args={[d.width_m || 2.0, 0.1, 0.28]} />
              <meshStandardMaterial color="#475569" roughness={0.6} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}


/* ───────────────────────────── 5. WALL PENETRATION SLEEVES ───────────────────────────── */

function WallPenetrations() {
  const topo = useWorld((s) => s.topology);
  const pens = useMemo(() => (topo?.site as any)?.penetrations ?? [], [topo]);

  if (!pens.length) {
    return (
      <group position={[0, 0.9, -6.0]}>
        <group position={[-8.5, 0, 0]}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.16, 0.16, 0.42, 24]} />
            <meshStandardMaterial color="#1e293b" metalness={0.7} roughness={0.3} />
          </mesh>
        </group>
      </group>
    );
  }

  return (
    <group name="wall_penetrations">
      {pens.map((p: any) => {
        const [x, y, z] = p.position_xyz_m;
        return (
          <group key={p.id} position={[x, y, z]}>
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.14, 0.14, 0.42, 16]} />
              <meshStandardMaterial color="#1e293b" metalness={0.7} roughness={0.3} />
            </mesh>
            <mesh position={[0, 0, 0.16]}>
              <boxGeometry args={[0.34, 0.34, 0.02]} />
              <meshStandardMaterial color="#475569" metalness={0.6} roughness={0.4} />
            </mesh>
            <mesh position={[0, 0, -0.16]}>
              <boxGeometry args={[0.34, 0.34, 0.02]} />
              <meshStandardMaterial color="#475569" metalness={0.6} roughness={0.4} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/* ───────────────────────────── 6. OUTDOOR HEAT REJECTION YARD ───────────────────────────── */

function OutdoorYard() {
  const topo = useWorld((s) => s.topology);
  const yardRoom = useMemo(() => {
    return (topo?.site as any)?.rooms?.find((r: any) => r.id === 'yard');
  }, [topo]);

  const chiller = useMemo(() => topo?.assets.find((a) => a.type === 'chiller'), [topo]);
  const x0 = yardRoom?.rect?.[0] ?? -30.0;
  const z0 = yardRoom?.rect?.[1] ?? -30.0;
  const x1 = yardRoom?.rect?.[2] ?? -14.0;
  const z1 = yardRoom?.rect?.[3] ?? -21.0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const yw = Math.abs(x1 - x0);
  const yd = Math.abs(z1 - z0);

  const posts = useMemo(() => {
    const list: Array<[number, number]> = [];
    for (let x = x0; x <= x1 + 0.01; x += 2.0) {
      list.push([x, z0]);
    }
    for (let z = z0 + 1.8; z <= z1 - 0.2; z += 1.8) {
      list.push([x0, z]);
      list.push([x1, z]);
    }
    return list;
  }, [x0, z0, x1, z1]);

  const showYard = useView((s) => s.layers.facility_water);
  if (!showYard) return null;

  return (
    <group name="outdoor_yard">
      {/* Heavy reinforced concrete equipment pad */}
      <mesh position={[cx, -0.05, cz]} receiveShadow>
        <boxGeometry args={[yw, 0.22, yd]} />
        <meshStandardMaterial color="#475569" roughness={0.92} metalness={0.05} />
      </mesh>
      {/* Vibration isolation equipment curb beneath dry-cooler / chiller_01 */}
      {chiller && (
        <mesh position={[chiller.position_xyz_m[0], 0.08, chiller.position_xyz_m[2]]} receiveShadow>
          <boxGeometry args={[(chiller.size_m?.[0] ?? 5) + 0.6, 0.12, (chiller.size_m?.[2] ?? 3) + 0.6]} />
          <meshStandardMaterial color="#334155" roughness={0.88} />
        </mesh>
      )}

      {/* Auxiliary step-down power transformer unit */}
      <group position={[x1 - 1.4, 0.95, z0 + 1.2]}>
        <mesh castShadow receiveShadow>
          <boxGeometry args={[1.6, 1.9, 1.8]} />
          <meshStandardMaterial color="#1e293b" roughness={0.55} metalness={0.6} />
        </mesh>
        {[-0.82, 0.82].map((x, i) => (
          <mesh key={i} position={[x, 0, 0]}>
            <boxGeometry args={[0.08, 1.5, 1.5]} />
            <meshStandardMaterial color="#334155" roughness={0.6} />
          </mesh>
        ))}
        <mesh position={[0, 0.3, 0.91]}>
          <planeGeometry args={[0.3, 0.2]} />
          <meshBasicMaterial color={C.warning} />
        </mesh>
      </group>

      {/* Industrial Security Perimeter Fence */}
      <group name="security_fence">
        {posts.map(([x, z], i) => (
          <mesh key={i} position={[x, 1.05, z]} castShadow>
            <cylinderGeometry args={[0.035, 0.035, 2.1, 12]} />
            <meshStandardMaterial color="#64748b" metalness={0.8} roughness={0.3} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/* ───────────────────────────── 7. EXTERIOR WALLS & CUTAWAY ───────────────────────────── */

function Walls({ mn, mx, H }: { mn: number[]; mx: number[]; H: number }) {
  const refs = useRef<Record<string, THREE.Group | null>>({});
  const { camera } = useThree();
  const T = 0.3;
  const defs = useMemo(
    () => [
      { id: 'back', pos: [(mn[0] + mx[0]) / 2, 0, mn[2] - T / 2], size: [mx[0] - mn[0] + T * 2, 1, T], outside: (c: THREE.Vector3) => c.z < mn[2] },
      { id: 'front', pos: [(mn[0] + mx[0]) / 2, 0, mx[2] + T / 2], size: [mx[0] - mn[0] + T * 2, 1, T], outside: (c: THREE.Vector3) => c.z > mx[2] },
      { id: 'left', pos: [mn[0] - T / 2, 0, (mn[2] + mx[2]) / 2], size: [T, 1, mx[2] - mn[2]], outside: (c: THREE.Vector3) => c.x < mn[0] },
      { id: 'right', pos: [mx[0] + T / 2, 0, (mn[2] + mx[2]) / 2], size: [T, 1, mx[2] - mn[2]], outside: (c: THREE.Vector3) => c.x > mx[0] },
    ],
    [mn, mx],
  );

  useFrame((_, dt) => {
    const v = useView.getState();
    for (const wl of defs) {
      const g = refs.current[wl.id];
      if (!g) continue;
      let h = PLINTH;
      if (v.layers.walls && !v.xray && v.mode !== 'pipe') {
        h = wl.outside(camera.position) ? PLINTH : H;
      }
      if (v.mode === 'agents') h = Math.min(h, PLINTH);
      if (v.xray || v.mode === 'pipe') h = 0.2;
      g.scale.y += (h - g.scale.y) * (1 - Math.exp(-dt * 4));
    }
  });

  return (
    <group>
      {defs.map((wl) => (
        <group key={wl.id} ref={(g) => void (refs.current[wl.id] = g)} position={[wl.pos[0], 0, wl.pos[2]]} scale={[1, PLINTH, 1]}>
          {/* Main wall body: durable concrete plinth base */}
          <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
            <boxGeometry args={[wl.size[0], 1, wl.size[2]]} />
            <meshStandardMaterial color={C.wall} roughness={0.88} metalness={0.05} />
          </mesh>
          {/* Upper wall cap / architectural trim reveal */}
          <mesh position={[0, 1.0, 0]}>
            <boxGeometry args={[wl.size[0] + 0.04, 0.015, wl.size[2] + 0.04]} />
            <meshStandardMaterial color={C.wallTop} roughness={0.65} metalness={0.3} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** slim wide-flange columns, one instanced draw: web + two flanges, light galvanised steel with a base plate */
function Columns({ pos, H }: { pos: Array<[number, number]>; H: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(() => {
    const g = mergeParts([
      { geo: new THREE.BoxGeometry(0.03, H, 0.22) },
      { geo: new THREE.BoxGeometry(0.2, H, 0.03), m: xf(0, 0, 0.095) },
      { geo: new THREE.BoxGeometry(0.2, H, 0.03), m: xf(0, 0, -0.095) },
      { geo: new THREE.BoxGeometry(0.34, 0.03, 0.34), m: xf(0, -H / 2 + 0.015, 0) },
      { geo: new THREE.BoxGeometry(0.3, 0.2, 0.3), m: xf(0, H / 2 - 0.1, 0) },
    ]);
    return g;
  }, [H]);
  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const t = new THREE.Matrix4();
    pos.forEach(([x, z], i) => {
      t.makeTranslation(x, H / 2, z);
      m.setMatrixAt(i, t);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [pos, H]);
  if (!pos.length) return null;
  return (
    <instancedMesh ref={ref} args={[geo, undefined, pos.length]} castShadow receiveShadow frustumCulled={false}>
      <meshStandardMaterial color="#b0bac9" roughness={0.4} metalness={0.5} />
    </instancedMesh>
  );
}

/* ───────────────────────────── 8. STRUCTURAL STEEL H-COLUMNS & ROOF TRUSSES ───────────────────────────── */

function StructuralFrame({ mn, mx, H }: { mn: number[]; mx: number[]; H: number }) {
  const topo = useWorld((s) => s.topology);
  const cols = useMemo(() => (topo?.site as any)?.columns ?? [], [topo]);

  const colPositions = useMemo(() => {
    if (cols.length > 0) {
      return cols.map((c: any) => [c.position_xyz_m[0], c.position_xyz_m[2]]);
    }
    const list: Array<[number, number]> = [];
    const xs = [-25.0, -18.0, -12.0, -5.0, 5.0, 15.0, 25.0];
    for (const x of xs) {
      list.push([x, mn[2]]);
      list.push([x, mx[2]]);
    }
    return list;
  }, [cols, mn, mx]);

  // Open-web structural steel roof trusses spanning North-South across the hall
  const trussLines = useMemo(() => {
    const pts: number[] = [];
    const yTop = H;
    const yBottom = H - 0.45;
    const xs: number[] = [];
    for (let x = mn[0] + 3; x <= mx[0] - 3; x += 6.0) xs.push(x);

    // Perimeter roof beam ring
    pts.push(mn[0], yTop, mn[2], mx[0], yTop, mn[2]);
    pts.push(mx[0], yTop, mn[2], mx[0], yTop, mx[2]);
    pts.push(mx[0], yTop, mx[2], mn[0], yTop, mx[2]);
    pts.push(mn[0], yTop, mx[2], mn[0], yTop, mn[2]);

    for (const x of xs) {
      pts.push(x, yTop, mn[2], x, yTop, mx[2]);
      pts.push(x, yBottom, mn[2], x, yBottom, mx[2]);
      for (let z = mn[2]; z < mx[2] - 0.1; z += 1.5) {
        const nextZ = Math.min(z + 1.5, mx[2]);
        pts.push(x, yBottom, z, x, yTop, nextZ);
        pts.push(x, yTop, nextZ, x, yBottom, nextZ);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [mn, mx, H]);
  useEffect(() => () => trussLines.dispose(), [trussLines]);

  const grp = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const v = useView.getState();
    const t = v.mode === 'pipe' || !v.layers.walls ? 0 : v.xray ? 0.35 : 1;
    if (grp.current) {
      const s = grp.current.scale.x;
      const n = s + (t - s) * (1 - Math.exp(-dt * 4));
      grp.current.scale.set(n, n, n);
    }
  });

  return (
    <group ref={grp}>
      <Columns pos={colPositions} H={H} />
      <lineSegments geometry={trussLines}>
        <lineBasicMaterial color="#7a889d" transparent opacity={0.55} />
      </lineSegments>
    </group>
  );
}

/* ───────────────────────────── 9. ROOF CUTAWAY & EXHAUST HOODS ───────────────────────────── */

function Roof({ cx, cz, w, d, H }: { cx: number; cz: number; w: number; d: number; H: number }) {
  const ref = useRef<THREE.Group>(null);
  const mat = useRef<THREE.MeshStandardMaterial>(null);

  useFrame((_, dt) => {
    const v = useView.getState();
    const on = v.layers.roof && !v.xray && v.mode === 'facility';
    const t = on ? 0.95 : 0;
    if (mat.current && ref.current) {
      mat.current.opacity += (t - mat.current.opacity) * (1 - Math.exp(-dt * 4));
      ref.current.visible = mat.current.opacity > 0.02;
      ref.current.position.y = H + 0.12 + (on ? 0 : 1.4);
    }
  });

  return (
    <group ref={ref} position={[cx, H + 0.12, cz]}>
      {/* Insulated architectural roof slab */}
      <mesh castShadow>
        <boxGeometry args={[w + 1.0, 0.22, d + 1.0]} />
        <meshStandardMaterial ref={mat} color="#1e293b" roughness={0.65} metalness={0.3} transparent opacity={0} />
      </mesh>
      {/* Industrial roof exhaust ventilators / hoods */}
      {[-4.0, 2.0].map((rx, i) => (
        <group key={i} position={[rx, 0.35, 0]}>
          <mesh>
            <cylinderGeometry args={[0.7, 0.9, 0.5, 16]} />
            <meshStandardMaterial color="#334155" roughness={0.5} metalness={0.5} />
          </mesh>
          <mesh position={[0, 0.3, 0]}>
            <cylinderGeometry args={[1.0, 0.7, 0.15, 16]} />
            <meshStandardMaterial color="#475569" roughness={0.5} metalness={0.5} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/* ───────────────────────────── 10. FLOOR & AISLE SAFETY MARKINGS ───────────────────────────── */

function Markings({ mn, mx }: { mn: number[]; mx: number[] }) {
  // lane / aisle paint is drawn from the topology roads (Rooms.tsx RoadDecals); nothing here may use a fixed coordinate.
  void mn;
  void mx;
  return null;
}
