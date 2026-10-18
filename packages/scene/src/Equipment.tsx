import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Asset } from '@loopkeeper/core/contracts';
import { useWorld } from '@loopkeeper/core/store';
import { clamp } from '@loopkeeper/core';
import { C, STATUS_COLOR, marginColor } from './theme';
import { Selectable } from './Select';
import { useView } from './view';
import { useRelevance } from './context';
import { usePaths } from './Pipes';
import { buildTubeGeometry } from './tube';
import { Batched } from './Batch';
import { useDashView } from './dashView';
import { AssetBrackets, DocksInstanced, PortsInstanced, SensorsInstanced } from './AssetInstances';

/* ───────────────────────────── shared shaders ───────────────────────────── */

function useAssetStatus(id: string) {
  return useWorld((s) => s.assets[id]?.status ?? 'nominal');
}

/* ───────────────────────────── racks ───────────────────────────── */

function ExpansionBays() {
  const topo = useWorld((s) => s.topology);
  const show = useView((s) => s.layers.service);
  const mode = useView((s) => s.mode);
  const xray = useView((s) => s.xray);
  const ref = useRef<THREE.InstancedMesh>(null);
  const bays = topo?.expansion_bays ?? [];
  useEffect(() => {
    if (!ref.current) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    bays.forEach((b, i) => {
      q.setFromEuler(new THREE.Euler(0, b.yaw_rad, 0));
      m.compose(new THREE.Vector3(b.position_xyz_m[0], b.size_m[1] / 2, b.position_xyz_m[2]), q, new THREE.Vector3(b.size_m[0], b.size_m[1], b.size_m[2]));
      ref.current!.setMatrixAt(i, m);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  }, [bays]);
  if (!bays.length || !show || mode === 'pipe') return null;
  return (
    // reserved bays read as empty, deliberately unpopulated slots (translucent volume + outline from HallDetail),
    // not as unfinished racks
    <instancedMesh ref={ref} args={[undefined, undefined, bays.length]} raycast={() => null}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#8fa3c0" roughness={0.6} metalness={0.2} transparent opacity={xray ? 0.05 : mode === 'agents' ? 0.06 : 0.12} depthWrite={false} />
    </instancedMesh>
  );
}

/* ───────────────────────────── CDU ───────────────────────────── */

/** loop colour bands: the only saturated colours on the plant are the four fluid channels (FWS navy/slate, TCS cyan/amber) */
const BAND = { fs: C.fwsSupply, fr: C.fwsReturn, ts: C.tcsSupply, tr: C.tcsReturn } as const;

/** a nozzle: short stub from the exchanger to the skid face, a raised flange with bolts, and a colour collar */
function Nozzle({ from, to, r, color }: { from: [number, number, number]; to: [number, number, number]; r: number; color: string }) {
  const { pos, quat, len } = useMemo(() => {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const d = b.clone().sub(a);
    return { pos: a.clone().add(b).multiplyScalar(0.5), quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()), len: d.length() };
  }, [from, to]);
  return (
    <group position={pos} quaternion={quat}>
      <mesh>
        <cylinderGeometry args={[r, r, len, 16]} />
        <meshStandardMaterial color="#aeb7c4" metalness={0.55} roughness={0.4} />
      </mesh>
      <mesh position={[0, len / 2 - 0.02, 0]}>
        <cylinderGeometry args={[r * 1.55, r * 1.55, 0.04, 20]} />
        <meshStandardMaterial color="#7e8999" metalness={0.7} roughness={0.35} />
      </mesh>
      <mesh position={[0, len / 2 - 0.075, 0]}>
        <cylinderGeometry args={[r * 1.18, r * 1.18, 0.05, 16]} />
        <meshStandardMaterial color={color} metalness={0.3} roughness={0.5} />
      </mesh>
    </group>
  );
}

function Cdu({ asset }: { asset: Asset }) {
  const [w, h, d] = asset.size_m!;
  const rel = useRelevance(asset.id);
  const nodes = useWorld((s) => s.topology?.nodes) as Array<{ id: string; position_xyz_m: [number, number, number] }> | undefined;
  const ledRef = useRef<THREE.MeshBasicMaterial>(null);
  const barA = useRef<THREE.Mesh>(null);
  const barB = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const a = useWorld.getState().assets[asset.id];
    if (ledRef.current) ledRef.current.color.set(STATUS_COLOR[a?.status ?? 'nominal']);
    const duty = clamp((a?.readings.heat_duty_kw ?? 0) / 600, 0, 1);
    const ap = clamp((a?.readings.approach_k ?? 6) / 12, 0, 1);
    if (barA.current) barA.current.scale.x = Math.max(duty, 0.02);
    if (barB.current) barB.current.scale.x = Math.max(ap, 0.02);
  });
  const mode = useView((s) => s.mode);
  const dim = mode === 'pipe' ? 0.14 : rel;
  // port positions come from the topology nodes (FWS on the -z face, TCS on the +x face), relative to the skid
  const port = (id: string, fb: [number, number, number]): [number, number, number] => {
    const n = nodes?.find((x) => x.id === id)?.position_xyz_m;
    return n ? [n[0] - asset.position_xyz_m[0], n[1] - asset.position_xyz_m[1], n[2] - asset.position_xyz_m[2]] : fb;
  };
  const fs = port('n_cdu_fs', [-0.3, 0.9, -d / 2]);
  const fr = port('n_cdu_fr', [0.3, 0.9, -d / 2]);
  const ts = port('n_cdu_ts', [w / 2, 1.5, -0.45]);
  const tr = port('n_cdu_tr', [w / 2, 1.5, 0.45]);
  const px0 = -w * 0.38;
  const px1 = w * 0.38;
  const pz0 = -d * 0.27; // exchanger z extent: fixed end plate at pz0, pressure plate at pz1
  const pz1 = d * 0.2;
  const phH = h * 0.58;
  const phY = 0.28 + phH / 2;
  const plates = 26;
  const pitch = (pz1 - pz0 - 0.1) / plates;
  const mat = (c: string, m = 0.5, r = 0.45) => ({ color: c, metalness: m, roughness: r });
  return (
    <Selectable id={asset.id} size={[w + 0.15, h + 0.15, d + 0.15]} offset={[0, h / 2, 0]} position={asset.position_xyz_m}>
      <Batched dim={dim}>
        {/* skid base with fork pockets and a drip rim */}
        <mesh position={[0, 0.07, 0]} receiveShadow castShadow>
          <boxGeometry args={[w + 0.1, 0.14, d + 0.1]} />
          <meshStandardMaterial {...mat('#232b38', 0.7, 0.45)} />
        </mesh>
        <mesh position={[0, 0.16, 0]}>
          <boxGeometry args={[w - 0.04, 0.04, d - 0.04]} />
          <meshStandardMaterial {...mat('#3a4454', 0.5, 0.6)} />
        </mesh>
        {/* open frame: four posts, top rails; the exchanger stays visible instead of being boxed in */}
        {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => (
          <mesh key={`${sx}${sz}`} position={[sx * (w / 2 - 0.03), h / 2 + 0.07, sz * (d / 2 - 0.03)]} castShadow>
            <boxGeometry args={[0.06, h - 0.1, 0.06]} />
            <meshStandardMaterial {...mat('#cdd3dc', 0.35, 0.45)} />
          </mesh>
        )))}
        {[-1, 1].map((sx) => (
          <mesh key={`rx${sx}`} position={[sx * (w / 2 - 0.03), h + 0.02, 0]}>
            <boxGeometry args={[0.06, 0.06, d - 0.06]} />
            <meshStandardMaterial {...mat(sx < 0 ? '#cdd3dc' : '#cdd3dc', 0.35, 0.45)} />
          </mesh>
        ))}
        {[-1, 1].map((sz) => (
          <mesh key={`rz${sz}`} position={[0, h + 0.02, sz * (d / 2 - 0.03)]}>
            <boxGeometry args={[w - 0.06, 0.06, 0.06]} />
            <meshStandardMaterial {...mat('#cdd3dc', 0.35, 0.45)} />
          </mesh>
        ))}
        {/* side colour bands on the top rails: FWS face (north, -z) navy over slate, TCS face (east, +x) cyan over amber */}
        <mesh position={[0, h + 0.02, -d / 2 + 0.032]}>
          <boxGeometry args={[w * 0.5, 0.03, 0.01]} />
          <meshStandardMaterial {...mat(BAND.fs, 0.2, 0.55)} />
        </mesh>
        <mesh position={[w * 0.5, h + 0.02, -d / 2 + 0.032]}>
          <boxGeometry args={[w * 0.5, 0.03, 0.01]} />
          <meshStandardMaterial {...mat(BAND.fr, 0.2, 0.55)} />
        </mesh>
        <mesh position={[w / 2 + 0.002, h + 0.02, -d * 0.2]}>
          <boxGeometry args={[0.01, 0.03, d * 0.3]} />
          <meshStandardMaterial {...mat(BAND.ts, 0.2, 0.55)} />
        </mesh>
        <mesh position={[w / 2 + 0.002, h + 0.02, d * 0.2]}>
          <boxGeometry args={[0.01, 0.03, d * 0.3]} />
          <meshStandardMaterial {...mat(BAND.tr, 0.2, 0.55)} />
        </mesh>
        {/* ── gasketed plate heat exchanger: fixed end plate, plate pack, pressure plate, tie bars ── */}
        <mesh position={[0, phY, pz0 - 0.03]} castShadow>
          <boxGeometry args={[px1 - px0 + 0.06, phH + 0.08, 0.06]} />
          <meshStandardMaterial {...mat('#2b3a63', 0.45, 0.5)} />
        </mesh>
        <mesh position={[0, phY, pz1 + 0.04]} castShadow>
          <boxGeometry args={[px1 - px0 + 0.06, phH + 0.08, 0.06]} />
          <meshStandardMaterial {...mat('#3b4a5d', 0.5, 0.5)} />
        </mesh>
        {Array.from({ length: plates }).map((_, i) => (
          <mesh key={i} position={[0, phY, pz0 + 0.05 + i * pitch + pitch / 2]}>
            <boxGeometry args={[px1 - px0, phH, pitch * 0.72]} />
            <meshStandardMaterial {...mat(i % 2 === 0 ? '#d3dae4' : '#b6c0cf', 0.85, 0.28)} />
          </mesh>
        ))}
        {[-1, 1].flatMap((sx) => [-1, 1].map((sy) => (
          <mesh key={`tie${sx}${sy}`} position={[sx * (px1 - px0) / 2, phY + sy * (phH / 2 + 0.01), (pz0 + pz1) / 2]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.014, 0.014, pz1 - pz0 + 0.14, 8]} />
            <meshStandardMaterial {...mat('#6c7686', 0.8, 0.35)} />
          </mesh>
        )))}
        {/* FWS header plate on the fixed end plate (navy) and TCS header bar on the east side of the pack (cyan | amber) */}
        <mesh position={[0, phY, pz0 - 0.065]}>
          <boxGeometry args={[px1 - px0 - 0.04, 0.05, 0.012]} />
          <meshStandardMaterial {...mat(BAND.fs, 0.2, 0.55)} />
        </mesh>
        <mesh position={[px1 + 0.025, phY + phH * 0.2, (pz0 + pz1) / 2 - 0.2]}>
          <boxGeometry args={[0.02, 0.07, pz1 - pz0 - 0.5]} />
          <meshStandardMaterial {...mat(BAND.ts, 0.25, 0.5)} />
        </mesh>
        <mesh position={[px1 + 0.025, phY - phH * 0.2, (pz0 + pz1) / 2 + 0.2]}>
          <boxGeometry args={[0.02, 0.07, pz1 - pz0 - 0.5]} />
          <meshStandardMaterial {...mat(BAND.tr, 0.25, 0.5)} />
        </mesh>
        {/* nozzles: FWS primary through the north face, TCS secondary through the east face (positions = topology nodes) */}
        <Nozzle from={[fs[0], fs[1], pz0 - 0.06]} to={[fs[0], fs[1], -d / 2 - 0.02]} r={0.085} color={BAND.fs} />
        <Nozzle from={[fr[0], fr[1], pz0 - 0.06]} to={[fr[0], fr[1], -d / 2 - 0.02]} r={0.085} color={BAND.fr} />
        <Nozzle from={[px1 + 0.03, ts[1], ts[2]]} to={[w / 2 + 0.02, ts[1], ts[2]]} r={0.07} color={BAND.ts} />
        <Nozzle from={[px1 + 0.03, tr[1], tr[2]]} to={[w / 2 + 0.02, tr[1], tr[2]]} r={0.07} color={BAND.tr} />
        {/* control cabinet at the south end, HMI facing the hall */}
        <mesh position={[0, 0.16 + (h - 0.3) / 2 + 0.02, d / 2 - 0.3]} castShadow receiveShadow>
          <boxGeometry args={[w - 0.14, h - 0.3, 0.5]} />
          <meshStandardMaterial {...mat('#c3cad5', 0.35, 0.5)} />
        </mesh>
        <mesh position={[0, h - 0.2, d / 2 - 0.3]}>
          <boxGeometry args={[w - 0.1, 0.06, 0.54]} />
          <meshStandardMaterial {...mat('#4a5568', 0.6, 0.5)} />
        </mesh>
        {Array.from({ length: 7 }).map((_, i) => (
          <mesh key={i} position={[-w / 2 + 0.08 + 0.001, 0.4 + i * 0.075, d / 2 - 0.3]} rotation={[0, -Math.PI / 2, 0]}>
            <planeGeometry args={[0.36, 0.03]} />
            <meshBasicMaterial color="#6f7888" />
          </mesh>
        ))}
        {/* HMI on the +x face of the cabinet */}
        <group position={[w / 2 - 0.07 + 0.002, h * 0.66, d / 2 - 0.3]} rotation={[0, Math.PI / 2, 0]}>
          <mesh>
            <planeGeometry args={[0.46, 0.4]} />
            <meshStandardMaterial {...mat('#0b0f17', 0.8, 0.25)} />
          </mesh>
          <mesh position={[0, 0.15, 0.004]}>
            <planeGeometry args={[0.4, 0.05]} />
            <meshBasicMaterial color="#1e293b" />
          </mesh>
          {[
            { y: 0.04, ref: barA, c: '#7fb3a8' },
            { y: -0.07, ref: barB, c: '#c9a46a' },
          ].map((b, i) => (
            <group key={i} position={[-0.18, b.y, 0.004]}>
              <mesh position={[0.18, 0, 0]}>
                <planeGeometry args={[0.36, 0.04]} />
                <meshBasicMaterial color="#1e293b" />
              </mesh>
              <mesh ref={b.ref} position={[0, 0, 0.002]} scale={[0.5, 1, 1]} userData={{ dyn: true }}>
                <planeGeometry args={[0.36, 0.04]} />
                <meshBasicMaterial color={b.c} />
              </mesh>
            </group>
          ))}
          <mesh position={[0.17, 0.15, 0.006]} userData={{ dyn: true }}>
            <circleGeometry args={[0.02, 20]} />
            <meshBasicMaterial ref={ledRef} color={C.nominal} />
          </mesh>
        </group>
      </Batched>
    </Selectable>
  );
}

/* ───────────────────────────── pumps ───────────────────────────── */

function Pump({ asset }: { asset: Asset }) {
  const paths = usePaths();
  const edge = useWorld((s) => (asset.edge_id ? s.edgesById[asset.edge_id] : undefined));
  const rel = useRelevance(asset.id);
  const motor = useRef<THREE.Group>(null);
  const light = useRef<THREE.MeshBasicMaterial>(null);
  const grp = useRef<THREE.Group>(null);
  const stub = useMemo(() => {
    if (!edge || !paths[edge.id]) return null;
    const p = paths[edge.id];
    const [px, , pz] = asset.position_xyz_m;
    let best = p.points[0];
    let bd = Infinity;
    for (let i = 0; i < p.points.length; i++) {
      const dd = (p.points[i][0] - px) ** 2 + (p.points[i][2] - pz) ** 2;
      if (dd < bd) ((bd = dd), (best = p.points[i]));
    }
    // the discharge nozzle stands 0.27 m ahead of the skid centre (see the casing below)
    const sp: THREE.Vector3[] = [new THREE.Vector3(px + 0.27, 0.7, pz), new THREE.Vector3(px + 0.27, best[1], pz), new THREE.Vector3(best[0], best[1], best[2])];
    const path = { points: sp.map((v) => [v.x, v.y, v.z] as [number, number, number]), cum: [0, 0, 0], length: 0 };
    for (let i = 1; i < 3; i++) path.cum[i] = path.cum[i - 1] + sp[i].distanceTo(sp[i - 1]);
    path.length = path.cum[2];
    return path.length > 0.05 ? buildTubeGeometry(path, 0.07, 10, 0.08) : null;
  }, [asset, edge, paths]);
  useEffect(() => () => stub?.dispose(), [stub]);
  const spin = useRef(0);
  useFrame((state, dt) => {
    const a = useWorld.getState().assets[asset.id];
    const speed = (a?.readings.speed_pct ?? 0) / 100;
    spin.current += dt * speed * 14;
    if (motor.current) motor.current.rotation.x = spin.current;
    const vib = a?.readings.vibration_mm_s ?? 0;
    if (grp.current) {
      const amp = vib > 2.5 ? (vib - 2.5) * 0.0014 : 0.0003 * speed;
      grp.current.position.y = Math.sin(state.clock.elapsedTime * 70) * amp;
    }
    if (light.current) light.current.color.set(STATUS_COLOR[a?.status ?? 'nominal'] ?? C.nominal);
  });
  const mode = useView((s) => s.mode);
  const dim = mode === 'pipe' ? 0.14 : rel;
  const bandColor = asset.id.startsWith('pump_f') ? '#2c4a86' : '#216a7c';
  return (
    <>
      <Selectable id={asset.id} size={[1.05, 1.0, 0.8]} offset={[0, 0.5, 0]} position={asset.position_xyz_m}>
        <group ref={grp}>
          <Batched dim={dim}>
            {/* baseplate on grout rails, with a drip lip */}
            <mesh position={[0, 0.05, 0]} receiveShadow castShadow>
              <boxGeometry args={[1.04, 0.1, 0.6]} />
              <meshStandardMaterial color="#3a4351" roughness={0.6} metalness={0.5} />
            </mesh>
            <mesh position={[0, 0.108, 0]}>
              <boxGeometry args={[0.98, 0.016, 0.54]} />
              <meshStandardMaterial color="#222a36" roughness={0.7} metalness={0.4} />
            </mesh>
            {/* motor: finned frame, fan cowl, terminal box, loop-coloured paint (the only colour on the skid) */}
            <group ref={motor} position={[-0.2, 0.33, 0]} userData={{ dyn: true }}>
              <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
                <cylinderGeometry args={[0.17, 0.17, 0.5, 22]} />
                <meshStandardMaterial color={bandColor} roughness={0.5} metalness={0.45} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
              </mesh>
              {[-0.2, -0.13, -0.065, 0, 0.065, 0.13, 0.2].map((x) => (
                <mesh key={x} position={[x, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
                  <cylinderGeometry args={[0.18, 0.18, 0.016, 22]} />
                  <meshStandardMaterial color="#1c2431" roughness={0.55} metalness={0.5} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
                </mesh>
              ))}
              <mesh position={[-0.3, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.15, 0.17, 0.1, 22]} />
                <meshStandardMaterial color="#232b38" roughness={0.6} metalness={0.5} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
              </mesh>
            </group>
            <mesh position={[-0.2, 0.53, 0]} castShadow>
              <boxGeometry args={[0.15, 0.09, 0.15]} />
              <meshStandardMaterial color="#8a94a4" roughness={0.5} metalness={0.6} />
            </mesh>
            {/* coupling guard + bearing pedestal */}
            <mesh position={[0.07, 0.31, 0]}>
              <boxGeometry args={[0.16, 0.2, 0.22]} />
              <meshStandardMaterial color="#9099a8" roughness={0.5} metalness={0.5} />
            </mesh>
            <mesh position={[0.07, 0.18, 0]}>
              <boxGeometry args={[0.12, 0.1, 0.3]} />
              <meshStandardMaterial color="#4a5465" roughness={0.6} metalness={0.5} />
            </mesh>
            {/* volute casing, suction nozzle (axial, +x) and discharge nozzle (up) with flanges */}
            <mesh position={[0.27, 0.33, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
              <cylinderGeometry args={[0.24, 0.24, 0.18, 28]} />
              <meshStandardMaterial color="#b9c3d2" roughness={0.42} metalness={0.5} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
            </mesh>
            <mesh position={[0.46, 0.33, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.085, 0.085, 0.16, 16]} />
              <meshStandardMaterial color="#aab4c3" roughness={0.4} metalness={0.55} />
            </mesh>
            <mesh position={[0.54, 0.33, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.13, 0.13, 0.03, 20]} />
              <meshStandardMaterial color="#7e8999" roughness={0.35} metalness={0.7} />
            </mesh>
            <mesh position={[0.27, 0.6, 0]}>
              <cylinderGeometry args={[0.065, 0.065, 0.14, 16]} />
              <meshStandardMaterial color="#aab4c3" roughness={0.4} metalness={0.55} />
            </mesh>
            <mesh position={[0.27, 0.68, 0]}>
              <cylinderGeometry args={[0.11, 0.11, 0.03, 20]} />
              <meshStandardMaterial color="#7e8999" roughness={0.35} metalness={0.7} />
            </mesh>
            {/* casing feet */}
            {[-1, 1].map((sz) => (
              <mesh key={sz} position={[0.27, 0.15, sz * 0.15]}>
                <boxGeometry args={[0.3, 0.1, 0.07]} />
                <meshStandardMaterial color="#4a5465" roughness={0.6} metalness={0.5} />
              </mesh>
            ))}
            {/* pressure gauge on the discharge */}
            <mesh position={[0.33, 0.66, 0.1]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.035, 0.035, 0.02, 14]} />
              <meshBasicMaterial color="#dfe4ec" />
            </mesh>
            <mesh position={[-0.2, 0.56, 0.09]} userData={{ dyn: true }}>
              <sphereGeometry args={[0.025, 10, 10]} />
              <meshBasicMaterial ref={light} color={C.nominal} />
            </mesh>
          </Batched>
        </group>
      </Selectable>
      {stub && (
        <mesh geometry={stub}>
          <meshStandardMaterial color="#a9b3c2" metalness={0.5} roughness={0.42} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
        </mesh>
      )}
    </>
  );
}

/* ───────────────────────────── valves / strainers / sensors ───────────────────────────── */

function tangentAt(path: { points: Array<[number, number, number]>; cum: number[] }, s: number) {
  let i = 0;
  while (i < path.cum.length - 2 && path.cum[i + 1] < s) i++;
  const a = path.points[i];
  const b = path.points[i + 1];
  return new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
}

/** orientation of a valve / strainer stem: world-up expressed in the fitting's local frame (local +Y runs along the pipe); a vertical pipe gets a side-mounted stem */
function stemQuat(q: THREE.Quaternion): THREE.Quaternion {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q.clone().invert());
  if (Math.abs(up.y) > 0.9) up.set(1, 0, 0);
  else up.y = 0;
  if (up.lengthSq() < 1e-6) up.set(1, 0, 0);
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up.normalize());
}

/** gate valve: flanged body in line with the pipe, bonnet + rising stem up (or sideways on a vertical run), spoked handwheel on a yoke */
function Handwheel({ rim, wheel, scale = 1 }: { rim?: React.Ref<THREE.MeshStandardMaterial>; wheel?: React.Ref<THREE.Group>; scale?: number }) {
  return (
    <group scale={scale}>
      <mesh position={[0, 0.07, 0]}>
        <cylinderGeometry args={[0.08, 0.1, 0.14, 14]} />
        <meshStandardMaterial color="#8d97a8" metalness={0.65} roughness={0.38} />
      </mesh>
      <mesh position={[0, 0.2, 0]}>
        <cylinderGeometry args={[0.014, 0.014, 0.2, 8]} />
        <meshStandardMaterial color="#c7ceda" metalness={0.8} roughness={0.25} />
      </mesh>
      {[-1, 1].map((sx) => (
        <mesh key={sx} position={[sx * 0.06, 0.15, 0]}>
          <boxGeometry args={[0.014, 0.16, 0.03]} />
          <meshStandardMaterial color="#7a8495" metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      <mesh position={[0, 0.25, 0]}>
        <boxGeometry args={[0.14, 0.02, 0.035]} />
        <meshStandardMaterial color="#7a8495" metalness={0.6} roughness={0.4} />
      </mesh>
      <group ref={wheel} position={[0, 0.3, 0]} userData={{ dyn: true }}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.1, 0.012, 8, 24]} />
          <meshStandardMaterial ref={rim} color="#9aa4b6" metalness={0.5} roughness={0.4} />
        </mesh>
        {[0, 1, 2].map((i) => (
          <mesh key={i} rotation={[0, (i * Math.PI) / 3, 0]}>
            <boxGeometry args={[0.2, 0.008, 0.012]} />
            <meshStandardMaterial color="#9aa4b6" metalness={0.5} roughness={0.4} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

function Valve({ asset }: { asset: Asset }) {
  const paths = usePaths();
  const rel = useRelevance(asset.id);
  const wheel = useRef<THREE.Group>(null);
  const cap = useRef<THREE.MeshStandardMaterial>(null);
  const q = useMemo(() => {
    const p = asset.edge_id ? paths[asset.edge_id] : undefined;
    const t = p ? tangentAt(p, asset.s_m ?? p.length * 0.5) : new THREE.Vector3(0, 1, 0);
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), t);
  }, [asset, paths]);
  const qs = useMemo(() => stemQuat(q), [q]);
  const cur = useRef(0.85);
  useFrame((_, dt) => {
    const a = useWorld.getState().assets[asset.id];
    const eff = a?.fault?.opening ?? (a?.readings.opening_pct ?? 100) / 100;
    const isolated = a?.status === 'isolated' || a?.status === 'service';
    const open = isolated && asset.id.startsWith('valve_z') ? 0 : eff;
    cur.current += (open - cur.current) * (1 - Math.exp(-dt * 6));
    // the handwheel turns with the valve position: three full turns shut to open
    if (wheel.current) wheel.current.rotation.y = (1 - cur.current) * Math.PI * 6;
    if (cap.current) cap.current.color.set(a?.fault?.opening !== undefined ? C.warning : a?.status === 'service' ? C.service : '#9aa4b6');
  });
  const mode = useView((s) => s.mode);
  const dim = mode === 'pipe' ? 0.14 : rel;
  const small = asset.id.length === 8 && asset.id.startsWith('valve_') && !asset.id.startsWith('valve_z');
  const s = small ? 1 : 1.35;
  return (
    <Selectable id={asset.id} size={[0.5 * s, 0.5 * s, 0.5 * s]} position={asset.position_xyz_m}>
      <group quaternion={q} scale={s}>
        <mesh>
          <cylinderGeometry args={[0.1, 0.1, 0.18, 18]} />
          <meshStandardMaterial color="#a9b3c2" metalness={0.5} roughness={0.4} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
        </mesh>
        {[-1, 1].map((sy) => (
          <mesh key={sy} position={[0, sy * 0.095, 0]}>
            <cylinderGeometry args={[0.135, 0.135, 0.03, 20]} />
            <meshStandardMaterial color="#7e8999" metalness={0.7} roughness={0.35} />
          </mesh>
        ))}
        <group quaternion={qs} position={[0, 0, 0]}>
          <group position={[0, 0.08, 0]}>
            <Handwheel rim={cap} wheel={wheel} />
          </group>
        </group>
      </group>
    </Selectable>
  );
}

function Strainer({ asset }: { asset: Asset }) {
  const paths = usePaths();
  const rel = useRelevance(asset.id);
  const q = useMemo(() => {
    const p = asset.edge_id ? paths[asset.edge_id] : undefined;
    const t = p ? tangentAt(p, asset.s_m ?? p.length * 0.5) : new THREE.Vector3(1, 0, 0);
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), t);
  }, [asset, paths]);
  const qs = useMemo(() => stemQuat(q), [q]);
  const capMat = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    const a = useWorld.getState().assets[asset.id];
    const col = STATUS_COLOR[a?.status ?? 'nominal'];
    if (capMat.current) capMat.current.color.set(a?.status && a.status !== 'nominal' ? col : '#5f6c80');
  });
  const mode = useView((s) => s.mode);
  const dim = mode === 'pipe' ? 0.14 : rel;
  const m = { transparent: dim < 1, opacity: Math.max(dim, 0.14) };
  return (
    <Selectable id={asset.id} size={[0.7, 0.7, 0.7]} position={asset.position_xyz_m}>
      <group quaternion={q}>
        {/* Y-strainer: flanged body in line, screen leg at 45 degrees with a blow-down cap, and a handwheel isolation valve downstream */}
        <mesh>
          <cylinderGeometry args={[0.13, 0.13, 0.42, 18]} />
          <meshStandardMaterial color="#aab4c3" metalness={0.5} roughness={0.42} {...m} />
        </mesh>
        {[-1, 1].map((sy) => (
          <mesh key={sy} position={[0, sy * 0.22, 0]}>
            <cylinderGeometry args={[0.175, 0.175, 0.03, 20]} />
            <meshStandardMaterial color="#7e8999" metalness={0.7} roughness={0.35} />
          </mesh>
        ))}
        <group rotation={[0, 0, -Math.PI / 4]} position={[0.1, -0.1, 0]}>
          <mesh position={[0, -0.2, 0]}>
            <cylinderGeometry args={[0.1, 0.1, 0.34, 16]} />
            <meshStandardMaterial color="#aab4c3" metalness={0.5} roughness={0.42} {...m} />
          </mesh>
          <mesh position={[0, -0.4, 0]}>
            <cylinderGeometry args={[0.12, 0.12, 0.05, 16]} />
            <meshStandardMaterial ref={capMat} color="#5f6c80" metalness={0.6} roughness={0.4} />
          </mesh>
        </group>
        <group position={[0, 0.44, 0]}>
          <mesh>
            <cylinderGeometry args={[0.1, 0.1, 0.2, 16]} />
            <meshStandardMaterial color="#a9b3c2" metalness={0.5} roughness={0.4} {...m} />
          </mesh>
          {[-1, 1].map((sy) => (
            <mesh key={sy} position={[0, sy * 0.105, 0]}>
              <cylinderGeometry args={[0.14, 0.14, 0.03, 20]} />
              <meshStandardMaterial color="#7e8999" metalness={0.7} roughness={0.35} />
            </mesh>
          ))}
          <group quaternion={qs}>
            <group position={[0, 0.08, 0]}>
              <Handwheel />
            </group>
          </group>
        </group>
      </group>
    </Selectable>
  );
}

/* ───────────────────────────── chiller & dock ───────────────────────────── */

function Chiller({ asset }: { asset: Asset }) {
  const [w, h, d] = asset.size_m!;
  const fans = useRef<Array<THREE.Group | null>>([]);
  const rel = useRelevance(asset.id);
  useFrame((_, dt) => {
    fans.current.forEach((f, i) => f && (f.rotation.y += dt * (5.5 + i * 0.4)));
  });
  const mode = useView((s) => s.mode);
  const dim = mode === 'pipe' ? 0.14 : rel;
  const nodes = useWorld((s) => s.topology?.nodes) as Array<{ id: string; position_xyz_m: [number, number, number] }> | undefined;
  const portRel = (id: string, fb: [number, number, number]): [number, number, number] => {
    const n = nodes?.find((x) => x.id === id)?.position_xyz_m;
    return n ? [n[0] - asset.position_xyz_m[0], n[1] - asset.position_xyz_m[1], n[2] - asset.position_xyz_m[2]] : fb;
  };
  const fsP = portRel('n_fws_chiller_s', [w / 2, 2.0, -0.5]);
  const frP = portRel('n_fws_chiller_r', [w / 2, 2.0, 0.4]);
  return (
    <Selectable id={asset.id} size={[w + 0.2, h + 0.2, d + 0.2]} offset={[0, h / 2, 0]} position={asset.position_xyz_m}>
      <Batched dim={dim}>
      {/* Heavy structural I-beam base skid with vibration springs */}
      <mesh position={[0, 0.08, 0]} castShadow receiveShadow>
        <boxGeometry args={[w + 0.2, 0.16, d + 0.2]} />
        <meshStandardMaterial color="#1e293b" metalness={0.7} roughness={0.4} />
      </mesh>
      {[-1.8, 0, 1.8].map((x) =>
        [-d / 2, d / 2].map((z) => (
          <mesh key={`${x}_${z}`} position={[x, 0.08, z]}>
            <cylinderGeometry args={[0.08, 0.08, 0.16, 12]} />
            <meshStandardMaterial color="#64748b" metalness={0.8} roughness={0.3} />
          </mesh>
        )),
      )}

      {/* Main V-bank heat rejection coil cabinet casing */}
      <mesh position={[0, h * 0.52, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h * 0.88, d]} />
        <meshStandardMaterial color="#94a3b8" roughness={0.45} metalness={0.4} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
      </mesh>

      {/* Industrial slanted coil pack louvers on both longitudinal sides */}
      {Array.from({ length: 14 }).map((_, i) => (
        <group key={i} position={[0, 0.35 + i * 0.12, 0]}>
          <mesh position={[0, 0, d / 2 + 0.005]}>
            <planeGeometry args={[w * 0.94, 0.06]} />
            <meshStandardMaterial color="#475569" metalness={0.5} roughness={0.5} />
          </mesh>
          <mesh position={[0, 0, -d / 2 - 0.005]} rotation={[0, Math.PI, 0]}>
            <planeGeometry args={[w * 0.94, 0.06]} />
            <meshStandardMaterial color="#475569" metalness={0.5} roughness={0.5} />
          </mesh>
        </group>
      ))}

      {/* 4 Large-Diameter Induced-Draft Axial Cooling Fan Cowls with spinning blades */}
      {[-1.8, -0.6, 0.6, 1.8].map((x, i) => (
        <group key={i} position={[x, h + 0.04, 0]}>
          {/* Aerodynamic bellmouth fan cowl ring */}
          <mesh castShadow>
            <cylinderGeometry args={[0.55, 0.58, 0.16, 28]} />
            <meshStandardMaterial color="#1e293b" roughness={0.4} metalness={0.7} />
          </mesh>
          {/* Circular wire safety protective grill ring */}
          <mesh position={[0, 0.1, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.52, 0.015, 8, 28]} />
            <meshStandardMaterial color="#cbd5e1" metalness={0.8} roughness={0.2} />
          </mesh>
          {/* wire guard: two rings and three spokes over the blades */}
          <mesh position={[0, 0.17, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.3, 0.008, 6, 28]} />
            <meshStandardMaterial color="#cbd5e1" metalness={0.8} roughness={0.25} />
          </mesh>
          {[0, 1, 2].map((k) => (
            <mesh key={k} position={[0, 0.17, 0]} rotation={[0, (k * Math.PI) / 3, 0]}>
              <boxGeometry args={[1.0, 0.008, 0.012]} />
              <meshStandardMaterial color="#cbd5e1" metalness={0.8} roughness={0.25} />
            </mesh>
          ))}
          {/* Fan motor hub */}
          <mesh position={[0, 0.06, 0]}>
            <cylinderGeometry args={[0.14, 0.14, 0.12, 16]} />
            <meshStandardMaterial color="#334155" roughness={0.5} metalness={0.6} />
          </mesh>
          {/* Spinning 5-blade aerodynamic composite fan assembly */}
          <group ref={(g) => void (fans.current[i] = g)} position={[0, 0.07, 0]} userData={{ dyn: true }}>
            {[0, 1, 2, 3, 4].map((b) => (
              <mesh key={b} rotation={[0, (b * Math.PI * 2) / 5, 0]} position={[0.26 * Math.cos((b * Math.PI * 2) / 5), 0, -0.26 * Math.sin((b * Math.PI * 2) / 5)]}>
                <boxGeometry args={[0.42, 0.012, 0.14]} />
                <meshStandardMaterial color="#e2e8f0" roughness={0.3} metalness={0.2} />
              </mesh>
            ))}
          </group>
        </group>
      ))}

      {/* FWS nozzles on the +x face where p_01 / p_03 land: supply navy, return slate (positions from the topology nodes) */}
      <Nozzle from={[w / 2 - 0.35, fsP[1], fsP[2]]} to={[w / 2 + 0.02, fsP[1], fsP[2]]} r={0.1} color={BAND.fs} />
      <Nozzle from={[w / 2 - 0.35, frP[1], frP[2]]} to={[w / 2 + 0.02, frP[1], frP[2]]} r={0.1} color={BAND.fr} />
      {/* coil guard rails + fan-deck handrail posts */}
      {[-1, 1].map((sz) => (
        <mesh key={sz} position={[0, h * 0.95, sz * (d / 2 + 0.02)]}>
          <boxGeometry args={[w, 0.03, 0.03]} />
          <meshStandardMaterial color="#cdd3dc" metalness={0.5} roughness={0.4} />
        </mesh>
      ))}
      </Batched>
    </Selectable>
  );
}

export function Equipment() {
  const topo = useWorld((s) => s.topology);
  const layers = useView((s) => s.layers);
  const plant = useDashView((s) => s.structure.plant);
  const lists = useMemo(
    () => ({
      ports: topo?.assets.filter((a) => a.type === 'port') ?? [],
      docks: topo?.assets.filter((a) => a.type === 'dock' && a.size_m) ?? [],
      sensors: topo?.assets.filter((a) => a.type === 'sensor' && !a.id.startsWith('sn_rack_')) ?? [],
    }),
    [topo],
  );
  if (!topo) return null;
  return (
    <group name="equipment">
      {topo.assets.map((a) => {
        if (!plant && (a.type === 'cdu' || a.type === 'pump' || a.type === 'strainer' || a.type === 'chiller')) return null;
        switch (a.type) {
          case 'cdu':
            return <Cdu key={a.id} asset={a} />;
          case 'pump':
            return <Pump key={a.id} asset={a} />;
          case 'valve':
            // rack balancing valves are drawn instanced by <RackBranches /> (all 40, one draw call set)
            return /^valve_[a-z]\d+$/.test(a.id) ? null : <Valve key={a.id} asset={a} />;
          case 'strainer':
            return <Strainer key={a.id} asset={a} />;
          case 'chiller':
            return <Chiller key={a.id} asset={a} />;
          default:
            return null; // racks: <Racks/>; ports, docks, sensors: instanced below
        }
      })}
      <PortsInstanced ports={lists.ports} />
      <DocksInstanced docks={lists.docks} />
      {layers.sensors && <SensorsInstanced sensors={lists.sensors} />}
      <AssetBrackets />
      <ExpansionBays />
    </group>
  );
}
