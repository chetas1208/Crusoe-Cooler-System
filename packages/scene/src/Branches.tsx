import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Asset, PipeEdge, Vec3 } from '@loopkeeper/core/contracts';
import { useWorld } from '@loopkeeper/core/store';
import { C, STATUS_COLOR, fluidColor } from './theme';
import { useView } from './view';
import { useRelevanceSet } from './context';
import { filterIndex, pressureColor, useDashView } from './dashView';
import { box, mergeParts, xf } from './merge';
import { makeShader } from './tube';
import { outerR } from './dims';
import { FLOW_EPS } from './flow';

/* ──────────────────────────────────────────────────────────────────────────────
 * Rack branches: for EVERY rack — supply drop, return drop, balancing valve, branch flow
 * meter, and the flanged tap collars. All instanced (≈ 8 draw calls for the whole hall).
 * Everything is derived from topology ids: edge `n_<k>_in` / `n_<k>_out`, `valve_<k>`, `sn_rack_<k>`.
 * ────────────────────────────────────────────────────────────────────────────── */

export const isRackDrop = (e: PipeEdge) => /^n_[a-z]\d+_in$/.test(e.to) || /^n_[a-z]\d+_out$/.test(e.from);

const DROP_VERT = /* glsl */ `
  attribute vec3 aCol; attribute float aLen; attribute float aPhase; attribute float aHi; attribute float aDimI; attribute float aAlert;
  varying vec3 vCol; varying float vS; varying float vHi; varying float vDimI; varying float vAlert; varying vec3 vN; varying vec3 vV; varying float vPhase;
  void main(){
    vCol = aCol; vS = uv.y * aLen; vHi = aHi; vDimI = aDimI; vAlert = aAlert; vPhase = aPhase;
    mat3 im = mat3(instanceMatrix);
    vN = normalize(normalMatrix * im * normal);
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const DROP_FRAG = /* glsl */ `
  varying vec3 vCol; varying float vS; varying float vHi; varying float vDimI; varying float vAlert; varying vec3 vN; varying vec3 vV; varying float vPhase;
  uniform float uDimAll;
  void main(){
    float ph = fract((vS - vPhase) / 0.7);
    float streak = smoothstep(0.0, 0.1, ph) * (1.0 - smoothstep(0.1, 0.6, ph));
    float fres = pow(1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), 1.7);
    vec3 col = vCol * (0.46 + 0.7 * streak) + vCol * fres * 0.5;
    col = mix(col, vec3(1.0, 0.6, 0.24), vAlert * (0.25 + 0.5 * fres));
    col += vec3(1.0) * vHi * 0.4 * (0.35 + fres);
    col *= vDimI * uDimAll;
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

interface BranchData {
  rack: Asset;
  sup: PipeEdge;
  ret: PipeEdge;
  valve?: Asset;
  meter?: Asset;
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();
const _eul = new THREE.Euler();

const FLANGE = new THREE.LatheGeometry(
  [new THREE.Vector2(0.6, -0.5), new THREE.Vector2(1, -0.5), new THREE.Vector2(1, 0.5), new THREE.Vector2(0.6, 0.5), new THREE.Vector2(0.6, -0.5)],
  10,
);

export function RackBranches() {
  const topo = useWorld((s) => s.topology);
  const data = useMemo<BranchData[]>(() => {
    if (!topo) return [];
    const byId = new Map(topo.assets.map((a) => [a.id, a]));
    const out: BranchData[] = [];
    for (const rack of topo.assets.filter((a) => a.type === 'rack')) {
      const k = rack.id.replace('rack_', '');
      const sup = topo.edges.find((e) => e.to === `n_${k}_in`);
      const ret = topo.edges.find((e) => e.from === `n_${k}_out`);
      if (sup && ret) out.push({ rack, sup, ret, valve: byId.get(`valve_${k}`), meter: byId.get(`sn_rack_${k}`) });
    }
    return out;
  }, [topo]);
  if (!data.length) return null;
  return (
    <>
      <Drops data={data} />
      <Hardware data={data} />
      <FocusBox which="hover" data={data} />
      <FocusBox which="selected" data={data} />
    </>
  );
}

/* ── supply / return drops: one InstancedMesh ── */
function Drops({ data }: { data: BranchData[] }) {
  const edges = useMemo(() => data.flatMap((d) => [d.sup, d.ret]), [data]);
  const n = edges.length;
  const ref = useRef<THREE.InstancedMesh>(null);
  const grp = useRef<THREE.Group>(null);
  const relSet = useRelevanceSet();
  const relRef = useRef(relSet);
  relRef.current = relSet;
  const rt = useMemo(() => {
    const mk = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(n * size), size).setUsage(THREE.DynamicDrawUsage);
    const attrs = { aCol: mk(3), aLen: mk(1), aPhase: mk(1), aHi: mk(1), aDimI: mk(1), aAlert: mk(1) };
    const geo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    for (const [k, a] of Object.entries(attrs)) geo.setAttribute(k, a);
    const uniforms = { uDimAll: { value: 1 } };
    const phase = new Float32Array(n);
    const hi = new Float32Array(n);
    return { attrs, geo, uniforms, mat: makeShader(DROP_VERT, DROP_FRAG, uniforms), phase, hi, base: [] as THREE.Matrix4[], maskKey: -1, lastF: new Int8Array(n).fill(-2), lastDp: new Int32Array(n).fill(-9) };
  }, [n]);
  useEffect(() => () => (rt.geo.dispose(), rt.mat.dispose()), [rt]);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    edges.forEach((e, i) => {
      const pts = e.centerline_xyz_m;
      _a.set(...(pts[0] as Vec3));
      _b.set(...(pts[pts.length - 1] as Vec3));
      const len = _a.distanceTo(_b);
      _p.copy(_a).add(_b).multiplyScalar(0.5);
      _q.setFromUnitVectors(_up, _b.clone().sub(_a).normalize());
      const r = outerR(e.diameter_mm) * 0.92;
      _s.set(r, len, r);
      _m.compose(_p, _q, _s);
      m.setMatrixAt(i, _m);
      rt.base[i] = _m.clone();
      rt.maskKey = -1; // layer mask is re-applied on the next frame
      rt.attrs.aLen.setX(i, len);
      rt.phase[i] = (i * 0.37) % 0.7;
    });
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [edges, rt]);

  const tick = useRef(0);
  useFrame((_, dt) => {
    const v = useView.getState();
    const dv = useDashView.getState();
    const w = useWorld.getState();
    const f = filterIndex(dv.filter);
    if (grp.current) grp.current.visible = v.layers.technology_cooling && (v.layers.tcs_supply || v.layers.tcs_return) && v.mode !== 'pipe';
    const dim = (v.xray ? 0.7 : 1) * (f === 3 ? 0.35 : f === 2 ? 0.28 : 1);
    rt.uniforms.uDimAll.value = dim;
    // TCS supply / return toggles act per drop: hide the role whose layer is off (scale 0), without rebuilding anything
    const maskKey = (v.layers.tcs_supply ? 1 : 0) | (v.layers.tcs_return ? 2 : 0);
    if (maskKey !== rt.maskKey && ref.current && rt.base.length === n) {
      rt.maskKey = maskKey;
      for (let i = 0; i < n; i++) ref.current.setMatrixAt(i, (edges[i].role === 'supply' ? v.layers.tcs_supply : v.layers.tcs_return) ? rt.base[i] : _zero);
      ref.current.instanceMatrix.needsUpdate = true;
    }
    const A = rt.attrs;
    tick.current++;
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      const a = w.assets[e.id];
      const vel = a?.readings.velocity_m_s ?? 0.4;
      const status = a?.status ?? 'nominal';
      // direction = sign of the SOLVED flow along the edge's nominal from→to; no flow, no particles
      const fl = a?.readings.flow_kg_s ?? 0;
      const dir = Math.abs(fl) > FLOW_EPS ? Math.sign(fl) : 0;
      const spd = v.layers.flow && status !== 'isolated' ? dir * Math.min(vel, 2.5) * 1.1 : 0;
      rt.phase[i] += dt * spd;
      A.aPhase.setX(i, rt.phase[i]);
      const hiT = v.selectedId === e.id ? 1 : v.hoverId === e.id ? 0.6 : 0;
      rt.hi[i] += (hiT - rt.hi[i]) * (1 - Math.exp(-dt * 10));
      A.aHi.setX(i, rt.hi[i]);
      const rel = relRef.current === null ? 1 : relRef.current.has(e.id) || relRef.current.has(`rack_${e.id}`) ? 1 : 0.2;
      A.aDimI.setX(i, status === 'isolated' ? rel * 0.45 : rel);
      A.aAlert.setX(i, status === 'warning' || status === 'critical' ? 0.7 : 0);
      // colour: loop/direction, or ΔP in the pressure view — recomputed only when its inputs change
      const dpv = f === 4 ? Math.round((a?.readings.dp_kpa ?? 0) * 20) : -1;
      if (f !== rt.lastF[i] || dpv !== rt.lastDp[i]) {
        rt.lastF[i] = f;
        rt.lastDp[i] = dpv;
        _col.set(f === 4 ? pressureColor(a?.readings.dp_kpa ?? 0) : fluidColor(e.loop, e.role));
        A.aCol.setXYZ(i, _col.r, _col.g, _col.b);
      }
    }
    for (const at of Object.values(A)) at.needsUpdate = true;
  });

  const idOf = (e: { instanceId?: number }) => (e.instanceId !== undefined ? edges[e.instanceId]?.id : undefined);
  return (
    <group ref={grp} name="rack-drops">
      <instancedMesh
        ref={ref}
        args={[rt.geo, rt.mat, n]}
        onPointerOver={(e) => {
          e.stopPropagation();
          const id = idOf(e as never);
          if (id) useView.getState().hover(id);
        }}
        onPointerMove={(e) => {
          const id = idOf(e as never);
          if (id && useView.getState().hoverId !== id) useView.getState().hover(id);
        }}
        onPointerOut={() => useView.getState().hover(null)}
        onClick={(e) => {
          e.stopPropagation();
          const id = idOf(e as never);
          if (id) useView.getState().select(id);
        }}
      />
    </group>
  );
}

/* ── valves, flow meters, flanged taps ── */
function Hardware({ data }: { data: BranchData[] }) {
  const n = data.length;
  const relSet = useRelevanceSet();
  const relRef = useRef(relSet);
  relRef.current = relSet;
  const grp = useRef<THREE.Group>(null);
  const meterGrp = useRef<THREE.Group>(null);
  const flangeRef = useRef<THREE.InstancedMesh>(null);
  const valveBody = useRef<THREE.InstancedMesh>(null);
  const actuator = useRef<THREE.InstancedMesh>(null);
  const lever = useRef<THREE.InstancedMesh>(null);
  const meterBody = useRef<THREE.InstancedMesh>(null);
  const meterLed = useRef<THREE.InstancedMesh>(null);

  const geos = useMemo(
    () => ({
      // valve in its local frame: pipe axis = Y, stem toward +Z (the aisle side)
      valve: mergeParts([
        { geo: new THREE.SphereGeometry(0.095, 10, 7) },
        { geo: new THREE.CylinderGeometry(0.03, 0.03, 0.13, 10), m: xf(0, 0, 0.1, Math.PI / 2) },
      ]),
      actuator: box(0.1, 0.07, 0.07).translate(0, 0, 0.185),
      lever: box(0.22, 0.02, 0.035).translate(0.1, 0, 0.235),
      meter: mergeParts([
        { geo: new THREE.CylinderGeometry(0.075, 0.075, 0.07, 14) },
        { geo: box(0.06, 0.05, 0.05), m: xf(0, 0, 0.1) },
        { geo: new THREE.CylinderGeometry(0.012, 0.012, 0.05, 6), m: xf(0, 0.04, 0.1) },
      ]),
      led: new THREE.SphereGeometry(0.02, 8, 6).translate(0, 0.075, 0.1),
    }),
    [],
  );
  useEffect(() => () => Object.values(geos).forEach((g) => g.dispose()), [geos]);

  // flanges at both ends of every drop
  const flanges = useMemo(() => {
    const out: THREE.Matrix4[] = [];
    for (const d of data) {
      for (const e of [d.sup, d.ret]) {
        const pts = e.centerline_xyz_m;
        const a = new THREE.Vector3(...(pts[0] as Vec3));
        const b = new THREE.Vector3(...(pts[pts.length - 1] as Vec3));
        const dir = b.clone().sub(a).normalize();
        const r = outerR(e.diameter_mm) * 1.28;
        const q = new THREE.Quaternion().setFromUnitVectors(_up, dir);
        for (const [p, off] of [[a, 0.07], [b, -0.07]] as const) {
          out.push(new THREE.Matrix4().compose(p.clone().addScaledVector(dir, off), q, new THREE.Vector3(r, 0.05, r)));
        }
      }
    }
    return out;
  }, [data]);

  useEffect(() => {
    flanges.forEach((m, i) => flangeRef.current?.setMatrixAt(i, m));
    if (flangeRef.current) {
      flangeRef.current.instanceMatrix.needsUpdate = true;
      flangeRef.current.computeBoundingSphere();
    }
    data.forEach((d, i) => {
      const yaw = d.rack.yaw_rad ?? 0;
      if (d.valve) {
        _q.setFromAxisAngle(_up, yaw);
        _p.set(...d.valve.position_xyz_m);
        _m.compose(_p, _q, _s.set(1, 1, 1));
        valveBody.current?.setMatrixAt(i, _m);
        actuator.current?.setMatrixAt(i, _m);
      }
      if (d.meter) {
        _q.setFromAxisAngle(_up, yaw);
        _p.set(...d.meter.position_xyz_m);
        _m.compose(_p, _q, _s.set(1, 1, 1));
        meterBody.current?.setMatrixAt(i, _m);
        meterLed.current?.setMatrixAt(i, _m);
      }
    });
    for (const r of [valveBody, actuator, meterBody, meterLed]) {
      if (r.current) {
        r.current.instanceMatrix.needsUpdate = true;
        r.current.computeBoundingSphere();
      }
    }
  }, [data, flanges]);

  const openCur = useRef<number[]>(data.map(() => 0.85));
  const lastCol = useRef<string[]>(data.map(() => ''));
  const lastLed = useRef<string[]>(data.map(() => ''));
  useFrame((_, dt) => {
    const v = useView.getState();
    const w = useWorld.getState();
    if (grp.current) grp.current.visible = v.layers.technology_cooling && (v.layers.tcs_supply || v.layers.tcs_return) && v.mode !== 'pipe';
    if (meterGrp.current) meterGrp.current.visible = v.layers.sensors && v.layers.technology_cooling && v.mode !== 'pipe';
    const k = 1 - Math.exp(-dt * 6);
    let leverDirty = false;
    for (let i = 0; i < n; i++) {
      const d = data[i];
      if (d.valve) {
        const a = w.assets[d.valve.id];
        const eff = a?.fault?.opening ?? (a?.readings.opening_pct ?? 85) / 100;
        const isolated = a?.status === 'isolated' || a?.status === 'service';
        const tgt = isolated ? 0 : eff;
        const cur = openCur.current[i];
        const nx = cur + (tgt - cur) * k;
        if (Math.abs(nx - cur) > 1e-4 || lastCol.current[i] === '') {
          openCur.current[i] = nx;
          _q.setFromEuler(_eul.set(0, d.rack.yaw_rad ?? 0, 0));
          const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (1 - nx) * (Math.PI / 2));
          _q.multiply(rot);
          _p.set(...d.valve.position_xyz_m);
          _m.compose(_p, _q, _s.set(1, 1, 1));
          lever.current?.setMatrixAt(i, _m);
          leverDirty = true;
        }
        const col = a?.fault?.opening !== undefined ? C.warning : a?.status === 'service' ? C.service : '#3d6fb6';
        if (col !== lastCol.current[i]) {
          lastCol.current[i] = col;
          actuator.current?.setColorAt(i, _col.set(col));
          if (actuator.current?.instanceColor) actuator.current.instanceColor.needsUpdate = true;
        }
      }
      if (d.meter) {
        const a = w.assets[d.meter.id];
        const col = a?.suspect?.length ? C.warning : STATUS_COLOR[a?.status ?? 'nominal'];
        if (col !== lastLed.current[i]) {
          lastLed.current[i] = col;
          meterLed.current?.setColorAt(i, _col.set(col));
          if (meterLed.current?.instanceColor) meterLed.current.instanceColor.needsUpdate = true;
        }
      }
    }
    if (leverDirty && lever.current) lever.current.instanceMatrix.needsUpdate = true;
  });

  const idFor = (kind: 'valve' | 'meter') => (e: { instanceId?: number }) => (e.instanceId !== undefined ? (kind === 'valve' ? data[e.instanceId]?.valve?.id : data[e.instanceId]?.meter?.id) : undefined);
  const handlers = (kind: 'valve' | 'meter') => {
    const idOf = idFor(kind);
    return {
      onPointerOver: (e: { stopPropagation(): void; instanceId?: number }) => {
        e.stopPropagation();
        const id = idOf(e);
        if (id) useView.getState().hover(id);
      },
      onPointerMove: (e: { instanceId?: number }) => {
        const id = idOf(e);
        if (id && useView.getState().hoverId !== id) useView.getState().hover(id);
      },
      onPointerOut: () => useView.getState().hover(null),
      onClick: (e: { stopPropagation(): void; instanceId?: number }) => {
        e.stopPropagation();
        const id = idOf(e);
        if (id) useView.getState().select(id);
      },
    };
  };
  const nFl = flanges.length;
  return (
    <>
      <group ref={grp} name="rack-valves">
        <instancedMesh ref={flangeRef} args={[FLANGE, undefined, nFl]}>
          <meshStandardMaterial color="#aab3c1" metalness={0.45} roughness={0.42} />
        </instancedMesh>
        <instancedMesh ref={valveBody} args={[geos.valve, undefined, n]} {...handlers('valve')}>
          <meshStandardMaterial color="#a9b3c2" metalness={0.5} roughness={0.4} />
        </instancedMesh>
        <instancedMesh ref={actuator} args={[geos.actuator, undefined, n]} {...handlers('valve')}>
          <meshStandardMaterial color="#ffffff" roughness={0.4} metalness={0.4} />
        </instancedMesh>
        <instancedMesh ref={lever} args={[geos.lever, undefined, n]} {...handlers('valve')}>
          <meshStandardMaterial color="#e5e8ee" roughness={0.5} />
        </instancedMesh>
      </group>
      <group ref={meterGrp} name="rack-meters">
        <instancedMesh ref={meterBody} args={[geos.meter, undefined, n]} {...handlers('meter')}>
          <meshStandardMaterial color="#5d6676" metalness={0.7} roughness={0.4} />
        </instancedMesh>
        <instancedMesh ref={meterLed} args={[geos.led, undefined, n]} raycast={() => null}>
          <meshBasicMaterial color="#ffffff" toneMapped={false} />
        </instancedMesh>
      </group>
    </>
  );
}

/* ── one CAD-style bracket box that follows hover / selection of any instanced rack part ── */
const UNIT_BRACKETS = (() => {
  const L = 0.22;
  const pts: number[] = [];
  for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
    pts.push(sx, sy, sz, sx - Math.sign(sx) * L, sy, sz, sx, sy, sz, sx, sy - Math.sign(sy) * L, sz, sx, sy, sz, sx, sy, sz - Math.sign(sz) * L);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
})();

function FocusBox({ which, data }: { which: 'hover' | 'selected'; data: BranchData[] }) {
  const id = useView((s) => (which === 'hover' ? s.hoverId : s.selectedId));
  const sel = which === 'selected';
  const target = useMemo(() => {
    if (!id) return null;
    for (const d of data) {
      if (d.rack.id === id) {
        const [w, h, dd] = d.rack.size_m!;
        return { pos: [d.rack.position_xyz_m[0], h / 2, d.rack.position_xyz_m[2]] as Vec3, size: [w + 0.14, h + 0.14, dd + 0.14] as Vec3, yaw: d.rack.yaw_rad ?? 0 };
      }
      if (d.valve?.id === id) return { pos: d.valve.position_xyz_m, size: [0.5, 0.5, 0.5] as Vec3, yaw: 0 };
      if (d.meter?.id === id) return { pos: d.meter.position_xyz_m, size: [0.4, 0.4, 0.4] as Vec3, yaw: 0 };
    }
    return null;
  }, [id, data]);
  const mat = useRef<THREE.LineBasicMaterial>(null);
  useFrame((state) => {
    if (!mat.current) return;
    mat.current.opacity = sel ? 0.75 + 0.25 * Math.sin(state.clock.elapsedTime * 3.5) : 0.5;
  });
  if (!target) return null;
  return (
    <lineSegments geometry={UNIT_BRACKETS} position={target.pos} rotation={[0, target.yaw, 0]} scale={target.size} renderOrder={10}>
      <lineBasicMaterial ref={mat} color={sel ? C.accent : '#ffffff'} transparent opacity={0.6} depthTest={false} toneMapped={false} />
    </lineSegments>
  );
}
