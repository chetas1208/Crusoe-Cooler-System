import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useWorld } from '@loopkeeper/core/store';
import type { Topology } from '@loopkeeper/core/contracts';
import { useView } from './view';
import { filterIndex, useDashView } from './dashView';
import { box, mergeParts, xf } from './merge';
import { makeShader } from './tube';
import { siteModel, type Pod } from './siteModel';

/* ──────────────────────────────────────────────────────────────────────────────
 * Server-hall furniture, per pod (hall): cold-aisle glow + hot-aisle bands, aisle containment with end doors and
 * luminaires, overhead cable trays and busway with a drop into every cabinet, robot lane + dock aprons,
 * wall-side CRAH / UPS / PDU gear (architectural context, muted palette) and soft contact shadows.
 * Everything is derived from the topology via siteModel(): rows, aisles, rooms, docks. No coordinates are hard-coded.
 * ────────────────────────────────────────────────────────────────────────────── */

type RGB = [number, number, number];
type Part = { geo: THREE.BufferGeometry; m?: THREE.Matrix4; c?: RGB };
const rgb = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

const FLOOR_VERT = /* glsl */ `varying vec3 vP; void main(){ vP = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vP, 1.0); }`;
const HOT_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vP; uniform float uAmt; uniform vec2 uZ; uniform float uDim;
  void main(){
    float t = clamp((vP.z - uZ.x) / (uZ.y - uZ.x), 0.0, 1.0);
    float band = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.55, 1.0, t));
    vec2 tc = abs(fract(vP.xz / 0.6) - 0.5);
    float seam = step(0.488, max(tc.x, tc.y));
    vec3 col = vec3(1.0, 0.52, 0.2) * band * (0.07 + 0.34 * uAmt) + vec3(1.0, 0.7, 0.4) * seam * band * 0.10;
    gl_FragColor = vec4(col * uDim, 1.0);
  }
`;
const COLD_GLOW_FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vP; uniform float uAmt; uniform vec2 uZ; uniform float uDim;
  void main(){
    float t = clamp((vP.z - uZ.x) / (uZ.y - uZ.x), 0.0, 1.0);
    float c = 1.0 - abs(t - 0.5) * 2.0;
    vec3 col = vec3(0.1, 0.62, 0.8) * pow(c, 0.7) * (0.05 + 0.24 * uAmt);
    gl_FragColor = vec4(col * uDim, 1.0);
  }
`;

/* ── floor: airflow glow + hot-aisle bands (the perforated tiles themselves are the room decal, Rooms.tsx) ── */
function FloorDetail({ pod }: { pod: Pod }) {
  const d = pod.dims.d;
  const cold = pod.cold;
  const lo = pod.rows[0];
  const hi = pod.rows[pod.rows.length - 1];
  const hotLo = useMemo(() => ({ uAmt: { value: 0 }, uZ: { value: new THREE.Vector2(lo.z - d / 2 - 1.4, lo.z - d / 2) }, uDim: { value: 1 } }), [lo.z, d]);
  const hotHi = useMemo(() => ({ uAmt: { value: 0 }, uZ: { value: new THREE.Vector2(hi.z + d / 2, hi.z + d / 2 + 1.4) }, uDim: { value: 1 } }), [hi.z, d]);
  const coldU = useMemo(() => ({ uAmt: { value: 0 }, uZ: { value: new THREE.Vector2(cold?.z0 ?? 0, cold?.z1 ?? 1) }, uDim: { value: 1 } }), [cold]);
  const mk = (frag: string, u: Record<string, THREE.IUniform>) => makeShader(FLOOR_VERT, frag, u, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const hotMA = useMemo(() => mk(HOT_FRAG, hotLo), [hotLo]);
  const hotMB = useMemo(() => mk(HOT_FRAG, hotHi), [hotHi]);
  const coldM = useMemo(() => mk(COLD_GLOW_FRAG, coldU), [coldU]);
  useEffect(() => () => (hotMA.dispose(), hotMB.dispose(), coldM.dispose()), [hotMA, hotMB, coldM]);
  useFrame((_, dt) => {
    const f = filterIndex(useDashView.getState().filter);
    const v = useView.getState();
    const k = 1 - Math.exp(-dt * 4);
    const amt = f === 3 ? 1 : 0;
    const dim = v.mode === 'pipe' ? 0 : v.mode === 'agents' ? 0.5 : f === 2 || f === 1 ? 0.6 : 1;
    for (const u of [hotLo, hotHi, coldU]) {
      u.uDim.value += (dim - u.uDim.value) * k;
      u.uAmt.value += (amt - u.uAmt.value) * k;
    }
  });
  const len = pod.x1 - pod.x0;
  const cx = (pod.x0 + pod.x1) / 2;
  return (
    <group>
      {cold && (
        <mesh position={[cx, 0.013, (cold.z0 + cold.z1) / 2]} rotation={[-Math.PI / 2, 0, 0]} material={coldM} renderOrder={2}>
          <planeGeometry args={[len, cold.z1 - cold.z0]} />
        </mesh>
      )}
      <mesh position={[cx, 0.012, lo.z - d / 2 - 0.7]} rotation={[-Math.PI / 2, 0, 0]} material={hotMA} renderOrder={2}>
        <planeGeometry args={[len, 1.4]} />
      </mesh>
      <mesh position={[cx, 0.012, hi.z + d / 2 + 0.7]} rotation={[-Math.PI / 2, 0, 0]} material={hotMB} renderOrder={2}>
        <planeGeometry args={[len, 1.4]} />
      </mesh>
    </group>
  );
}

/* ── airflow chevrons: cold air into every solver rack front, hot air out of the rear ── */
function chevronGeo() {
  const t = 0.07;
  const v = (x: number, z: number) => [x, 0, z];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  const left = quad(v(-0.22, -0.1), v(0, 0.12), v(0, 0.12 - t * 1.4), v(-0.22, -0.1 - t * 1.4));
  const right = quad(v(0, 0.12), v(0.22, -0.1), v(0.22, -0.1 - t * 1.4), v(0, 0.12 - t * 1.4));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...left, ...right], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(36).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  return g;
}

function Chevrons({ pods }: { pods: Pod[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(chevronGeo, []);
  const items = useMemo(() => {
    const out: Array<{ x: number; z: number; hot: boolean; flip: boolean }> = [];
    for (const p of pods) {
      for (const r of p.racks) {
        const row = p.rows.find((rw) => Math.abs(rw.z - r.position_xyz_m[2]) < 0.2);
        const frontSign = Math.cos(row?.yaw ?? 0) >= 0 ? 1 : -1; // +1: front faces +z
        const z = r.position_xyz_m[2];
        // cold air moves from the aisle toward the rack front, i.e. against the front normal
        out.push({ x: r.position_xyz_m[0], z: z + frontSign * (p.dims.d / 2 + 0.55), hot: false, flip: frontSign > 0 });
        out.push({ x: r.position_xyz_m[0], z: z - frontSign * (p.dims.d / 2 + 0.7), hot: true, flip: frontSign > 0 });
      }
    }
    return out;
  }, [pods]);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const q = new THREE.Quaternion();
    const mat = new THREE.Matrix4();
    const c = new THREE.Color();
    items.forEach((it, i) => {
      // chevrons point +z at yaw 0. cold: toward the rack (flip when the front faces +z, so the flow runs -z). hot: away from the rack.
      const towardsMinusZ = it.hot ? !it.flip : it.flip;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), towardsMinusZ ? Math.PI : 0);
      mat.compose(new THREE.Vector3(it.x, 0.015, it.z), q, new THREE.Vector3(1, 1, 1));
      m.setMatrixAt(i, mat);
      m.setColorAt(i, c.set(it.hot ? '#ff9a3c' : '#2fd3e8'));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh ref={ref} args={[geo, undefined, items.length]} frustumCulled={false}>
      <meshBasicMaterial transparent opacity={0.62} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} />
    </instancedMesh>
  );
}

/* ── aisle containment: glass roof, light frame, end doors, luminaires ── */
function Containment({ pod }: { pod: Pod }) {
  const cold = pod.cold;
  const geoms = useMemo(() => {
    if (!cold) return null;
    const y = pod.dims.h + 0.08;
    const len = pod.x1 - pod.x0;
    const cx = (pod.x0 + pod.x1) / 2;
    const zc = (cold.z0 + cold.z1) / 2;
    const hz = (cold.z1 - cold.z0) / 2;
    const steel = rgb('#aab4c4');
    const parts: Part[] = [];
    for (const s of [-1, 1]) parts.push({ geo: box(len, 0.06, 0.06), m: xf(cx, y, zc + s * hz), c: steel });
    const pitch = pod.dims.w + 0.1;
    for (let x = pod.x0; x <= pod.x1 + 0.01; x += pitch * 2) parts.push({ geo: box(0.04, 0.04, hz * 2), m: xf(x, y, zc), c: steel });
    for (const x of [pod.x0, pod.x1]) {
      for (const s of [-1, 1]) parts.push({ geo: box(0.07, y, 0.07), m: xf(x, y / 2, zc + s * hz), c: steel });
      parts.push({ geo: box(0.07, 0.07, hz * 2), m: xf(x, y, zc), c: steel });
      parts.push({ geo: box(0.05, y, 0.05), m: xf(x, y / 2, zc), c: steel });
      // door handles
      for (const s of [-0.12, 0.12]) parts.push({ geo: box(0.03, 0.3, 0.03), m: xf(x + (x === pod.x0 ? -0.03 : 0.03), 1.05, zc + s), c: rgb('#e9ecf1') });
    }
    const doors = mergeParts(
      [pod.x0, pod.x1].flatMap((x) => [
        { geo: box(0.02, y - 0.1, hz - 0.1), m: xf(x, y / 2, zc - hz / 2) },
        { geo: box(0.02, y - 0.1, hz - 0.1), m: xf(x, y / 2, zc + hz / 2) },
      ]),
    );
    const lights: Part[] = [];
    for (let x = pod.x0 + 0.7; x < pod.x1; x += 2.2) lights.push({ geo: box(1.4, 0.03, 0.12), m: xf(x, y - 0.06, zc - hz * 0.45) }, { geo: box(1.4, 0.03, 0.12), m: xf(x, y - 0.06, zc + hz * 0.45) });
    return { frame: mergeParts(parts), doors, lights: mergeParts(lights), y, len, cx, zc, hz };
  }, [pod, cold]);
  useEffect(
    () => () => {
      geoms?.frame.dispose();
      geoms?.doors.dispose();
      geoms?.lights.dispose();
    },
    [geoms],
  );
  const glass = useRef<THREE.MeshStandardMaterial>(null);
  const doorM = useRef<THREE.MeshStandardMaterial>(null);
  useFrame((_, dt) => {
    const v = useView.getState();
    const t = v.mode === 'pipe' ? 0 : v.xray ? 0.05 : 0.15;
    if (glass.current) glass.current.opacity += (t - glass.current.opacity) * (1 - Math.exp(-dt * 4));
    if (doorM.current) doorM.current.opacity += (t * 1.5 - doorM.current.opacity) * (1 - Math.exp(-dt * 4));
  });
  if (!geoms) return null;
  return (
    <group>
      <mesh geometry={geoms.frame}>
        <meshStandardMaterial vertexColors metalness={0.6} roughness={0.4} />
      </mesh>
      <mesh position={[geoms.cx, geoms.y, geoms.zc]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={3}>
        <planeGeometry args={[geoms.len, geoms.hz * 2]} />
        <meshStandardMaterial ref={glass} color="#a8e6f2" transparent opacity={0.15} roughness={0.1} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geoms.doors} renderOrder={3}>
        <meshStandardMaterial ref={doorM} color="#a8e6f2" transparent opacity={0.22} roughness={0.1} depthWrite={false} />
      </mesh>
      <mesh geometry={geoms.lights}>
        <meshBasicMaterial color="#eaf6ff" toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ── overhead cable trays + busway with a drop into every cabinet row slot ── */
function Overhead({ pod }: { pod: Pod }) {
  const geo = useMemo(() => {
    const parts: Part[] = [];
    const { h, w, d } = pod.dims;
    const steel = rgb('#8d98aa');
    const rung = rgb('#6b7485');
    const bus = rgb('#d9a42a');
    const pitch = w + 0.1;
    for (const row of pod.rows) {
      const frontSign = Math.cos(row.yaw) >= 0 ? 1 : -1;
      const len = row.x1 - row.x0 + 0.3;
      const cx = (row.x0 + row.x1) / 2;
      const zt = row.z + frontSign * (d / 2 - 0.4); // data / fibre tray over the front third
      const yt = h + 0.34;
      for (const s of [-1, 1]) parts.push({ geo: box(len, 0.06, 0.025), m: xf(cx, yt, zt + s * 0.17), c: steel });
      for (let x = row.x0; x <= row.x1; x += 0.35) parts.push({ geo: box(0.025, 0.02, 0.34), m: xf(x, yt - 0.02, zt), c: rung });
      parts.push({ geo: box(len - 0.1, 0.07, 0.08), m: xf(cx, yt + 0.045, zt - 0.09), c: rgb('#121316') });
      parts.push({ geo: box(len - 0.1, 0.05, 0.06), m: xf(cx, yt + 0.035, zt + 0.02), c: rgb('#e5b823') });
      parts.push({ geo: box(len - 0.1, 0.05, 0.06), m: xf(cx, yt + 0.035, zt + 0.1), c: rgb('#2d6ad9') });
      // busway over the rear third: housing + a tap box above each cabinet
      const zb = row.z - frontSign * (d / 2 - 0.4);
      const yb = h + 0.62;
      parts.push({ geo: box(len, 0.13, 0.15), m: xf(cx, yb, zb), c: bus });
      parts.push({ geo: box(len, 0.02, 0.17), m: xf(cx, yb + 0.075, zb), c: rgb('#333a46') });
      for (let k = 0, x = row.x0 + w / 2; x < row.x1; k++, x += pitch) {
        parts.push({ geo: box(0.2, 0.16, 0.14), m: xf(x, yb - 0.14, zb), c: rgb('#46505f') });
        parts.push({ geo: box(0.05, h + 0.62 - 0.14 - h, 0.05), m: xf(x, h + (0.62 - 0.14) / 2, zb), c: rgb('#16181c') });
        if (k % 4 === 0) parts.push({ geo: box(0.04, 0.34, 0.04), m: xf(x + w / 2, h + 0.17, zt), c: steel });
      }
      // threaded-rod hangers from the roof every 3 rows' worth of cabinets would be hidden; keep the tray clean
    }
    return mergeParts(parts);
  }, [pod]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo}>
      <meshStandardMaterial vertexColors metalness={0.55} roughness={0.5} />
    </mesh>
  );
}

/* ── wall-side gear (architectural context): CRAH units on the exterior wall, UPS/PDU line on the corridor wall,
 *    row-end PDUs. Muted palette so nobody mistakes it for a solver-backed rack. ── */
function SideGear({ pod, topo }: { pod: Pod; topo: Topology }) {
  const parts = useMemo(() => {
    const [rx0, rz0, rx1, rz1] = pod.rect;
    const mn = topo.facility.interior_min;
    const mx = topo.facility.interior_max;
    const exteriorLow = rz0 <= mn[2] + 0.05;
    const exteriorHigh = rz1 >= mx[2] - 0.05;
    const lit: Part[] = [];
    const led: Part[] = [];
    const crah = rgb('#5f7288');
    const louver = rgb('#26303c');
    const ups = rgb('#3d6a66');
    const pdu = rgb('#454f5e');
    const dark = rgb('#15181d');
    // CRAH row along the exterior wall of this hall
    const zWall = exteriorLow ? rz0 + 0.75 : exteriorHigh ? rz1 - 0.75 : null;
    if (zWall !== null) {
      const face = exteriorLow ? 1 : -1;
      for (let x = rx0 + 2.0; x <= rx1 - 2.0; x += 2.6) {
        lit.push({ geo: box(2.0, 2.3, 1.0), m: xf(x, 1.15, zWall), c: crah });
        lit.push({ geo: box(1.8, 0.9, 0.04), m: xf(x, 1.35, zWall + face * 0.51), c: louver });
        lit.push({ geo: box(2.04, 0.08, 1.04), m: xf(x, 2.34, zWall), c: rgb('#8794a6') });
        led.push({ geo: box(0.3, 0.04, 0.02), m: xf(x + 0.7, 0.45, zWall + face * 0.51), c: rgb('#41d6a3') });
      }
    }
    // UPS / PDU line along the corridor-side wall
    const zElec = exteriorLow ? rz1 - 1.1 : rz0 + 1.1;
    const face2 = exteriorLow ? -1 : 1; // doors face away from the wall, into the hall
    for (let x = rx0 + 2.2, i = 0; x <= rx1 - 2.0; x += 1.0, i++) {
      const big = i % 4 === 0;
      lit.push({ geo: box(big ? 1.2 : 0.8, 2.2, 0.9), m: xf(x, 1.1, zElec), c: big ? ups : pdu });
      lit.push({ geo: box(big ? 1.0 : 0.62, 1.7, 0.03), m: xf(x, 1.2, zElec - face2 * 0.46), c: dark });
      led.push({ geo: box(big ? 0.7 : 0.4, 0.04, 0.02), m: xf(x, 2.0, zElec - face2 * 0.47), c: i % 7 === 3 ? rgb('#ffb347') : rgb('#41d6a3') });
    }
    // row-end PDUs
    for (const row of pod.rows) {
      for (const x of [row.x0 - 0.4, row.x1 + 0.4]) {
        lit.push({ geo: box(0.55, 2.25, 1.0), m: xf(x, 1.125, row.z), c: pdu });
        led.push({ geo: box(0.3, 0.04, 0.02), m: xf(x, 1.9, row.z + (x < row.x0 ? 0.51 : 0.51)), c: rgb('#5be3d0') });
      }
    }
    return { lit: mergeParts(lit), led: mergeParts(led) };
  }, [pod, topo]);
  useEffect(() => () => (parts.lit.dispose(), parts.led.dispose()), [parts]);
  return (
    <group name={`sidegear-${pod.hallId}`}>
      <mesh geometry={parts.lit} castShadow receiveShadow>
        <meshStandardMaterial vertexColors metalness={0.35} roughness={0.55} />
      </mesh>
      <mesh geometry={parts.led}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>
    </group>
  );
}

/* ── floor markings: aisle edges, robot lane, dock aprons + charging pads ── */
function Markings({ pods, topo }: { pods: Pod[]; topo: Topology }) {
  const geo = useMemo(() => {
    const parts: Part[] = [];
    const y = 0.017;
    const yel = rgb('#e8b93b');
    const cyan = rgb('#2fd3e8');
    for (const d of siteModel(topo).docks) {
      const [dx, , dz] = d.position_xyz_m;
      const [sx, , sz] = d.size_m ?? [1.4, 0.05, 1.8];
      const hx = sx / 2 + 0.25;
      const hz = sz / 2 + 0.25;
      parts.push({ geo: box(hx * 2, 0.003, 0.05), m: xf(dx, y, dz - hz), c: yel });
      parts.push({ geo: box(hx * 2, 0.003, 0.05), m: xf(dx, y, dz + hz), c: yel });
      parts.push({ geo: box(0.05, 0.003, hz * 2), m: xf(dx - hx, y, dz), c: yel });
      parts.push({ geo: box(0.05, 0.003, hz * 2), m: xf(dx + hx, y, dz), c: yel });
      // charging pad: two contact strips with a status LED bar
      for (const s of [-0.28, 0.28]) parts.push({ geo: box(sx * 0.7, 0.006, 0.12), m: xf(dx, y + 0.002, dz + s), c: rgb('#3a4658') });
      parts.push({ geo: box(sx * 0.5, 0.008, 0.04), m: xf(dx, y + 0.004, dz - hz + 0.18), c: rgb('#41d6a3') });
    }
    return mergeParts(parts);
  }, [pods, topo]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo}>
      <meshBasicMaterial vertexColors toneMapped={false} />
    </mesh>
  );
}

/* ── architectural context equipment in the plant rooms (vessel, dosing skid, MV switchgear) ── */
function ContextEquipment({ topo }: { topo: Topology }) {
  const items = (topo as unknown as { context_equipment?: Array<{ id: string; name: string; label: string; position_xyz_m: number[]; size_m: number[] }> }).context_equipment ?? [];
  const geo = useMemo(() => {
    const lit: Part[] = [];
    const led: Part[] = [];
    for (const e of items) {
      const [x, , z] = e.position_xyz_m;
      const [sx, sy, sz] = e.size_m;
      const n = e.name.toLowerCase();
      if (/vessel|tank/.test(n)) {
        const r = Math.min(sx, sz) / 2;
        lit.push({ geo: new THREE.CylinderGeometry(r, r, sy - r, 24), m: xf(x, (sy - r) / 2 + 0.1, z), c: rgb('#7d8a9c') });
        const dome = new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
        lit.push({ geo: dome, m: xf(x, sy - r + 0.1, z), c: rgb('#8e9bad') });
        for (const a of [0, 1, 2, 3]) lit.push({ geo: box(0.1, 0.5, 0.1), m: xf(x + Math.cos((a * Math.PI) / 2 + 0.78) * r * 0.85, 0.25, z + Math.sin((a * Math.PI) / 2 + 0.78) * r * 0.85), c: rgb('#3b4350') });
        lit.push({ geo: new THREE.CylinderGeometry(r * 0.98, r * 0.98, 0.06, 24), m: xf(x, 0.55, z), c: rgb('#2563eb') });
      } else if (/switchgear|\bmv\b|line-up/.test(n)) {
        const cab = 0.9;
        const nCab = Math.max(1, Math.round(sx / cab));
        for (let i = 0; i < nCab; i++) {
          const cx = x - sx / 2 + cab / 2 + i * cab;
          lit.push({ geo: box(cab - 0.03, sy, sz), m: xf(cx, sy / 2, z), c: rgb('#8d949f') });
          lit.push({ geo: box(cab - 0.2, sy * 0.55, 0.03), m: xf(cx, sy * 0.55, z + sz / 2 + 0.01), c: rgb('#b2b9c4') });
          led.push({ geo: box(0.08, 0.04, 0.02), m: xf(cx, sy * 0.9, z + sz / 2 + 0.02), c: i % 5 === 2 ? rgb('#ffb347') : rgb('#41d6a3') });
        }
      } else {
        lit.push({ geo: box(sx, 0.16, sz), m: xf(x, 0.08, z), c: rgb('#3b4350') });
        lit.push({ geo: box(sx * 0.9, sy - 0.2, sz * 0.9), m: xf(x, 0.16 + (sy - 0.2) / 2, z), c: rgb('#6f8a8f') });
        for (const s of [-1, 1]) lit.push({ geo: new THREE.CylinderGeometry(0.3, 0.3, sy * 0.8, 16), m: xf(x + s * sx * 0.25, 0.16 + sy * 0.4, z - sz * 0.3), c: rgb('#cfd6e0') });
        led.push({ geo: box(0.3, 0.04, 0.02), m: xf(x, sy * 0.7, z + sz * 0.45 + 0.01), c: rgb('#5be3d0') });
      }
    }
    return { lit: lit.length ? mergeParts(lit) : null, led: led.length ? mergeParts(led) : null };
  }, [items]);
  useEffect(() => () => (geo.lit?.dispose(), geo.led?.dispose()), [geo]);
  if (!geo.lit) return null;
  return (
    <group name="context-equipment">
      <mesh geometry={geo.lit} castShadow receiveShadow>
        <meshStandardMaterial vertexColors metalness={0.45} roughness={0.5} />
      </mesh>
      {geo.led && (
        <mesh geometry={geo.led}>
          <meshBasicMaterial vertexColors toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

/* ── soft contact shadows under cabinet rows, plant equipment and docks (one instanced draw) ── */
const AO_FRAG = /* glsl */ `
  precision highp float; varying vec2 vUv; uniform float uAmt;
  void main(){
    vec2 e = min(vUv, 1.0 - vUv);
    float a = smoothstep(0.0, 0.5, min(e.x * 2.0, 1.0)) * smoothstep(0.0, 0.5, min(e.y * 2.0, 1.0));
    gl_FragColor = vec4(0.0, 0.0, 0.0, a * 0.38 * uAmt);
  }
`;
const AO_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`;

function ContactShadows({ pods, topo }: { pods: Pod[]; topo: Topology }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const rects = useMemo(() => {
    const out: Array<[number, number, number, number]> = []; // cx cz sx sz
    for (const p of pods)
      for (const r of p.rows) {
        out.push([(r.x0 + r.x1) / 2, r.z, r.x1 - r.x0 + 1.6, p.dims.d + 1.6]);
      }
    for (const a of topo.assets) {
      if ((a.type === 'cdu' || a.type === 'pump' || a.type === 'chiller') && a.size_m) out.push([a.position_xyz_m[0], a.position_xyz_m[2], a.size_m[0] + 1.0, a.size_m[2] + 1.0]);
      if (a.type === 'dock' && a.size_m) out.push([a.position_xyz_m[0], a.position_xyz_m[2], a.size_m[0] + 0.6, a.size_m[2] + 0.6]);
    }
    return out;
  }, [pods, topo]);
  const mat = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: AO_VERT, fragmentShader: AO_FRAG, uniforms: { uAmt: { value: 1 } }, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    [],
  );
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const mt = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    rects.forEach((r, i) => {
      mt.compose(new THREE.Vector3(r[0], 0.011, r[1]), q, new THREE.Vector3(r[2], r[3], 1));
      m.setMatrixAt(i, mt);
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [rects]);
  useFrame((_, dt) => {
    const v = useView.getState();
    const t = v.mode === 'pipe' ? 0 : v.xray ? 0.3 : 1;
    mat.uniforms.uAmt.value += (t - mat.uniforms.uAmt.value) * (1 - Math.exp(-dt * 4));
  });
  if (!rects.length) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, rects.length]} material={mat} frustumCulled={false} renderOrder={1}>
      <planeGeometry args={[1, 1]} />
    </instancedMesh>
  );
}

/* ── reserved expansion bays: translucent outline (only present when the topology lists any) ── */
function ReservedBays({ topo }: { topo: Topology }) {
  const bays = topo.expansion_bays;
  const edges = useMemo(() => {
    const pts: number[] = [];
    const e = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const p = e.getAttribute('position');
    for (const b of bays) {
      for (let i = 0; i < p.count; i++) pts.push(p.getX(i) * b.size_m[0] + b.position_xyz_m[0], p.getY(i) * b.size_m[1] + b.size_m[1] / 2, p.getZ(i) * b.size_m[2] + b.position_xyz_m[2]);
    }
    e.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [bays]);
  useEffect(() => () => edges.dispose(), [edges]);
  if (!bays.length) return null;
  return (
    <lineSegments geometry={edges}>
      <lineBasicMaterial color="#8fa3c0" transparent opacity={0.45} toneMapped={false} />
    </lineSegments>
  );
}

export function HallDetail() {
  const topo = useWorld((s) => s.topology);
  const hall = useDashView((s) => s.structure.hall);
  const model = useMemo(() => (topo ? siteModel(topo) : null), [topo]);
  if (!topo || !model) return null;
  return (
    <group name="hall-detail" visible={hall}>
      {model.pods.map((p) => (
        <group key={p.hallId} name={`pod-${p.hallId}`}>
          <FloorDetail pod={p} />
          <Containment pod={p} />
          <Overhead pod={p} />
          <SideGear pod={p} topo={topo} />
        </group>
      ))}
      <Chevrons pods={model.pods} />
      <Markings pods={model.pods} topo={topo} />
      <ReservedBays topo={topo} />
    </group>
  );
}

/** plant-room context equipment + contact shadows live outside the "hall" toggle: they belong to the plant */
export function PlantContext() {
  const topo = useWorld((s) => s.topology);
  const plant = useDashView((s) => s.structure.plant);
  const model = useMemo(() => (topo ? siteModel(topo) : null), [topo]);
  if (!topo || !model) return null;
  return (
    <group name="plant-context">
      <group visible={plant}>
        <ContextEquipment topo={topo} />
      </group>
      <ContactShadows pods={model.pods} topo={topo} />
    </group>
  );
}
