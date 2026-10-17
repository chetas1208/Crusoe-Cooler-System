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

function Cdu({ asset }: { asset: Asset }) {
  const [w, h, d] = asset.size_m!;
  const rel = useRelevance(asset.id);
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
  return (
    <Selectable id={asset.id} size={[w + 0.15, h + 0.15, d + 0.15]} offset={[0, h / 2, 0]} position={asset.position_xyz_m}>
      <Batched dim={dim}>
      {/* Heavy structural steel skid base frame */}
      <mesh position={[0, 0.05, 0]} receiveShadow castShadow>
        <boxGeometry args={[w + 0.1, 0.1, d + 0.1]} />
        <meshStandardMaterial color="#1e293b" roughness={0.4} metalness={0.8} />
      </mesh>

      {/* Main cabinet enclosure */}
      <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color="#c5ccd6" roughness={0.42} metalness={0.35} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
      </mesh>
      {/* Top cap frame with lifting eye brackets */}
      <mesh position={[0, h + 0.03, 0]}>
        <boxGeometry args={[w + 0.06, 0.06, d + 0.06]} />
        <meshStandardMaterial color="#475569" roughness={0.5} metalness={0.6} />
      </mesh>
      {[-0.5, 0.5].map((x) =>
        [-0.9, 0.9].map((z) => (
          <mesh key={`${x}_${z}`} position={[x, h + 0.08, z]}>
            <torusGeometry args={[0.04, 0.012, 8, 16]} />
            <meshStandardMaterial color="#cbd5e1" metalness={0.9} roughness={0.2} />
          </mesh>
        )),
      )}

      {/* ── Internal Brazed Plate Heat Exchanger (BPHE) Core visible in cutaway/side ── */}
      <group position={[-0.1, h * 0.45, 0]}>
        {/* Core frame container */}
        <mesh position={[0, 0, 0]} castShadow>
          <boxGeometry args={[w * 0.55, h * 0.58, d * 0.45]} />
          <meshStandardMaterial color="#334155" roughness={0.6} metalness={0.5} />
        </mesh>
        {/* Stainless steel brazed corrugated plate ridge pack */}
        {Array.from({ length: 18 }).map((_, i) => (
          <mesh key={i} position={[(i - 8.5) * 0.032, 0, 0]}>
            <boxGeometry args={[0.014, h * 0.54, d * 0.42]} />
            <meshStandardMaterial color={i % 2 === 0 ? "#e2e8f0" : "#94a3b8"} metalness={0.85} roughness={0.25} />
          </mesh>
        ))}
        {/* Primary FWS inlet/outlet header block (Navy) */}
        <mesh position={[-w * 0.28, 0, -d * 0.15]}>
          <boxGeometry args={[0.08, h * 0.5, 0.12]} />
          <meshStandardMaterial color={C.fwsSupply} roughness={0.4} metalness={0.6} />
        </mesh>
        {/* Secondary TCS supply/return header block (Cyan) */}
        <mesh position={[w * 0.28, 0, d * 0.15]}>
          <boxGeometry args={[0.08, h * 0.5, 0.12]} />
          <meshStandardMaterial color={C.tcsSupply} roughness={0.4} metalness={0.6} />
        </mesh>
      </group>

      {/* Flanged Primary (FWS) Connection Ports on West Face (facing pump skid) */}
      <group position={[-w / 2 - 0.05, 0, 0]}>
        {/* Primary In (FWS Supply) */}
        <mesh position={[0, 0.9, -d * 0.25]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.11, 0.11, 0.1, 20]} />
          <meshStandardMaterial color="#475569" metalness={0.7} roughness={0.3} />
        </mesh>
        {/* Primary Out (FWS Return) */}
        <mesh position={[0, 0.9, d * 0.25]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.11, 0.11, 0.1, 20]} />
          <meshStandardMaterial color="#475569" metalness={0.7} roughness={0.3} />
        </mesh>
      </group>

      {/* Flanged Secondary (TCS) Connection Ports on East Face (facing hall) */}
      <group position={[w / 2 + 0.05, 0, 0]}>
        {/* Secondary Out (TCS Supply) */}
        <mesh position={[0, 1.5, -0.45]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.09, 0.09, 0.1, 20]} />
          <meshStandardMaterial color="#475569" metalness={0.7} roughness={0.3} />
        </mesh>
        {/* Secondary In (TCS Return) */}
        <mesh position={[0, 1.5, 0.45]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.09, 0.09, 0.1, 20]} />
          <meshStandardMaterial color="#475569" metalness={0.7} roughness={0.3} />
        </mesh>
      </group>

      {/* Front operator panel + touchscreen HMI display (faces +x, toward the hall) */}
      <mesh position={[w / 2 + 0.005, h * 0.62, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[d * 0.65, h * 0.35]} />
        <meshStandardMaterial color="#0b0f17" roughness={0.2} metalness={0.8} />
      </mesh>
      <group position={[w / 2 + 0.009, h * 0.62, 0]} rotation={[0, Math.PI / 2, 0]}>
        {/* Status display header bar */}
        <mesh position={[0, 0.26, 0.002]}>
          <planeGeometry args={[d * 0.58, 0.06]} />
          <meshBasicMaterial color="#1e293b" />
        </mesh>
        {/* Duty kW and Approach K live bar graphs */}
        {[
          { y: 0.12, ref: barA, c: C.accent },
          { y: -0.06, ref: barB, c: C.warning },
        ].map((b, i) => (
          <group key={i} position={[-d * 0.26, b.y, 0.003]}>
            <mesh position={[d * 0.26, 0, 0]}>
              <planeGeometry args={[d * 0.52, 0.045]} />
              <meshBasicMaterial color="#1e293b" />
            </mesh>
            <mesh ref={b.ref} position={[0, 0, 0.002]} scale={[0.5, 1, 1]} userData={{ dyn: true }}>
              <planeGeometry args={[d * 0.52, 0.045]} />
              <meshBasicMaterial color={b.c} />
            </mesh>
          </group>
        ))}
        {/* High-visibility circular status LED */}
        <mesh position={[d * 0.22, 0.26, 0.004]} userData={{ dyn: true }}>
          <circleGeometry args={[0.024, 20]} />
          <meshBasicMaterial ref={ledRef} color={C.nominal} />
        </mesh>
      </group>

      {/* Ventilation louvers along service access panels */}
      {Array.from({ length: 9 }).map((_, i) => (
        <mesh key={i} position={[-w / 2 - 0.004, 0.45 + i * 0.12, 0]} rotation={[0, -Math.PI / 2, 0]}>
          <planeGeometry args={[d * 0.7, 0.04]} />
          <meshBasicMaterial color="#8d95a3" />
        </mesh>
      ))}
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
    const sp: THREE.Vector3[] = [new THREE.Vector3(px, 0.62, pz), new THREE.Vector3(px, best[1], pz), new THREE.Vector3(best[0], best[1], best[2])];
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
  return (
    <>
      <Selectable id={asset.id} size={[1.05, 1.0, 0.8]} offset={[0, 0.5, 0]} position={asset.position_xyz_m}>
        <group ref={grp}>
          <Batched dim={dim}>
          <mesh position={[0, 0.05, 0]} receiveShadow castShadow>
            <boxGeometry args={[1.0, 0.1, 0.62]} />
            <meshStandardMaterial color="#454c58" roughness={0.6} metalness={0.5} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
          </mesh>
          <group ref={motor} position={[-0.22, 0.33, 0]} userData={{ dyn: true }}>
            <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
              <cylinderGeometry args={[0.17, 0.17, 0.5, 20]} />
              <meshStandardMaterial color="#35506f" roughness={0.45} metalness={0.55} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
            </mesh>
            {[-0.18, -0.09, 0, 0.09, 0.18].map((x) => (
              <mesh key={x} position={[x, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.178, 0.178, 0.015, 20]} />
                <meshStandardMaterial color="#27384e" roughness={0.5} metalness={0.5} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
              </mesh>
            ))}
          </group>
          <mesh position={[0.23, 0.33, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <cylinderGeometry args={[0.23, 0.23, 0.17, 24]} />
            <meshStandardMaterial color="#b4bece" roughness={0.4} metalness={0.5} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
          </mesh>
          <mesh position={[0.23, 0.5, 0]}>
            <cylinderGeometry args={[0.055, 0.055, 0.14, 14]} />
            <meshStandardMaterial color="#9aa4b4" metalness={0.5} roughness={0.4} />
          </mesh>
          <mesh position={[-0.22, 0.52, 0.0]} userData={{ dyn: true }}>
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

function Valve({ asset }: { asset: Asset }) {
  const paths = usePaths();
  const rel = useRelevance(asset.id);
  const lever = useRef<THREE.Group>(null);
  const cap = useRef<THREE.MeshStandardMaterial>(null);
  const q = useMemo(() => {
    const p = asset.edge_id ? paths[asset.edge_id] : undefined;
    const t = p ? tangentAt(p, asset.s_m ?? p.length * 0.5) : new THREE.Vector3(0, 1, 0);
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), t);
  }, [asset, paths]);
  const cur = useRef(0.85);
  useFrame((_, dt) => {
    const a = useWorld.getState().assets[asset.id];
    const eff = a?.fault?.opening ?? (a?.readings.opening_pct ?? 100) / 100;
    const isolated = a?.status === 'isolated' || a?.status === 'service';
    const open = isolated && asset.id.startsWith('valve_z') ? 0 : eff;
    cur.current += (open - cur.current) * (1 - Math.exp(-dt * 6));
    if (lever.current) lever.current.rotation.z = (1 - cur.current) * (Math.PI / 2);
    if (cap.current) cap.current.color.set(a?.fault?.opening !== undefined ? C.warning : a?.status === 'service' ? C.service : '#3d6fb6');
  });
  const mode = useView((s) => s.mode);
  const dim = mode === 'pipe' ? 0.14 : rel;
  const small = asset.id.length === 8 && asset.id.startsWith('valve_') && !asset.id.startsWith('valve_z');
  const s = small ? 1 : 1.35;
  return (
    <Selectable id={asset.id} size={[0.5 * s, 0.5 * s, 0.5 * s]} position={asset.position_xyz_m}>
      <group quaternion={q} scale={s}>
        <mesh>
          <sphereGeometry args={[0.095, 16, 12]} />
          <meshStandardMaterial color="#a9b3c2" metalness={0.5} roughness={0.4} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
        </mesh>
        <mesh position={[0, 0.1, 0]}>
          <cylinderGeometry args={[0.03, 0.03, 0.12, 10]} />
          <meshStandardMaterial color="#6e7787" metalness={0.8} roughness={0.35} />
        </mesh>
        <mesh position={[0, 0.17, 0]}>
          <boxGeometry args={[0.1, 0.07, 0.07]} />
          <meshStandardMaterial ref={cap} color="#3d6fb6" roughness={0.4} metalness={0.4} />
        </mesh>
        <group ref={lever} position={[0, 0.17, 0]}>
          <mesh position={[0.1, 0.045, 0]}>
            <boxGeometry args={[0.22, 0.02, 0.035]} />
            <meshStandardMaterial color="#e5e8ee" roughness={0.5} />
          </mesh>
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
  const capMat = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    const a = useWorld.getState().assets[asset.id];
    const col = STATUS_COLOR[a?.status ?? 'nominal'];
    if (capMat.current) capMat.current.color.set(a?.status && a.status !== 'nominal' ? col : '#5f6c80');
  });
  const mode = useView((s) => s.mode);
  const dim = mode === 'pipe' ? 0.14 : rel;
  return (
    <Selectable id={asset.id} size={[0.7, 0.7, 0.7]} position={asset.position_xyz_m}>
      <group quaternion={q}>
        <mesh>
          <cylinderGeometry args={[0.13, 0.13, 0.42, 18]} />
          <meshStandardMaterial color="#aab4c3" metalness={0.5} roughness={0.42} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
        </mesh>
        <group rotation={[0, 0, -Math.PI / 4]} position={[0.1, -0.1, 0]}>
          <mesh position={[0, -0.2, 0]}>
            <cylinderGeometry args={[0.1, 0.1, 0.34, 16]} />
            <meshStandardMaterial color="#aab4c3" metalness={0.5} roughness={0.42} transparent={dim < 1} opacity={Math.max(dim, 0.14)} />
          </mesh>
          <mesh position={[0, -0.4, 0]}>
            <cylinderGeometry args={[0.12, 0.12, 0.05, 16]} />
            <meshStandardMaterial ref={capMat} color="#5f6c80" metalness={0.6} roughness={0.4} />
          </mesh>
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

      {/* Flanged Header Manifold Stubs connecting directly into p_01 and p_03 */}
      <group position={[0, 0.9, 0]}>
        {/* Supply header outlet stub (FWS to plant) */}
        <mesh position={[-0.3, 0, d / 2 + 0.12]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.12, 0.12, 0.24, 20]} />
          <meshStandardMaterial color={C.fwsSupply} metalness={0.7} roughness={0.3} />
        </mesh>
        {/* Return header inlet stub (from CDU) */}
        <mesh position={[0.3, 0, d / 2 + 0.12]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.12, 0.12, 0.24, 20]} />
          <meshStandardMaterial color={C.fwsReturn} metalness={0.7} roughness={0.3} />
        </mesh>
      </group>
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
