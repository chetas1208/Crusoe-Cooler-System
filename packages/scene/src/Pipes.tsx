import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { PipeEdge } from '@loopkeeper/core/contracts';
import { type Path } from '@loopkeeper/core';
import { useWorld } from '@loopkeeper/core/store';
import { C, fluidColor } from './theme';
import { FLOW_FRAG, FLOW_VERT, makeShader } from './tube';
import { cachedPaths, cachedTube } from './geomCache';
import { useRelevance } from './context';
import { useView } from './view';
import { outerR } from './dims';
import { filterIndex, pressureColor, useDashView } from './dashView';
import { isRackDrop } from './Branches';
import { FLOW_EPS } from './flow';
import { FlowArrows, PipeFittings } from './PipeFlow';
import { mergeParts, xf } from './merge';

/** unit-radius pipe hardware (instances scale it by the pipe's outer radius): a bolted flange pair with a raised face + a thin cladding band */
const FLANGE_GEO = (() => {
  const g = mergeParts([
    { geo: new THREE.CylinderGeometry(1.3, 1.3, 0.16, 20), m: xf(0, -0.12, 0) },
    { geo: new THREE.CylinderGeometry(1.3, 1.3, 0.16, 20), m: xf(0, 0.12, 0) },
    { geo: new THREE.CylinderGeometry(1.06, 1.06, 0.12, 20) },
    ...Array.from({ length: 6 }, (_, i) => ({ geo: new THREE.CylinderGeometry(0.075, 0.075, 0.5, 5), m: xf(Math.cos((i * Math.PI) / 3) * 1.12, 0, Math.sin((i * Math.PI) / 3) * 1.12) })),
  ]);
  return g;
})();
const BAND_GEO = new THREE.CylinderGeometry(1.055, 1.055, 0.16, 18, 1, true);

const ALERT: Record<string, number> = { nominal: 0, watch: 0.3, warning: 0.65, critical: 1, isolated: 0, service: 0.5, offline: 0 };
const ALERT_COLOR: Record<string, string> = { watch: C.watch, warning: C.warning, critical: C.critical, service: C.service };

export function usePaths() {
  const topo = useWorld((s) => s.topology);
  // cached by topology hash: a refetch of identical geometry returns the same Path objects
  return useMemo(() => cachedPaths(topo), [topo]);
}

export function Pipes() {
  const topo = useWorld((s) => s.topology);
  const paths = usePaths();
  if (!topo) return null;
  return (
    <group name="pipes">
      {topo.edges.filter((e) => !isRackDrop(e)).map((e) => (
        <Pipe key={e.id} edge={e} path={paths[e.id]} />
      ))}
      <PipeHardware paths={paths} />
      <PipeFittings />
      <FlowArrows />
    </group>
  );
}

function Pipe({ edge, path }: { edge: PipeEdge; path: Path }) {
  const groupRef = useRef<THREE.Group>(null);
  const radius = outerR(edge.diameter_mm);
  const quality = useView((s) => s.quality);
  const radial = quality === 'high' ? 18 : quality === 'medium' ? 12 : 8;

  // (topology_hash, edge, kind, radial) -> geometry; owned by the cache, so no dispose here
  const topo = useWorld((s) => s.topology)!;
  const shellGeo = useMemo(() => cachedTube(topo, edge.id, 'shell', radius, radial, 0.14), [topo, edge.id, radius, radial]);
  const coreGeo = useMemo(() => cachedTube(topo, edge.id, 'core', radius * 0.8, radial, 0.14), [topo, edge.id, radius, radial]);
  void path;

  const baseColor = useMemo(() => new THREE.Color(fluidColor(edge.loop, edge.role)), [edge]);
  const uniforms = useMemo(
    () => ({
      uColor: { value: baseColor.clone() },
      uAlert: { value: new THREE.Color(C.warning) },
      uTime: { value: 0 },
      uSpeed: { value: 0.5 },
      uOcc: { value: 0 },
      uOccS: { value: 0 },
      uAlertAmt: { value: 0 },
      uHi: { value: 0 },
      uOpacity: { value: 0.96 },
      uDim: { value: 1 },
    }),
    [baseColor],
  );
  const coreMat = useMemo(() => makeShader(FLOW_VERT, FLOW_FRAG, uniforms, { transparent: true, depthWrite: false }), [uniforms]);
  useEffect(() => () => coreMat.dispose(), [coreMat]);
  const shellRef = useRef<THREE.MeshPhysicalMaterial>(null);
  const rel = useRelevance(edge.id);
  const relRef = useRef(rel);
  relRef.current = rel;
  const cur = useRef({ hi: 0, dim: 1, shell: 0.2, speed: 0.4, alert: 0 });

  useFrame((state, dt) => {
    const w = useWorld.getState();
    const v = useView.getState();
    const a = w.assets[edge.id];
    const status = a?.status ?? 'nominal';
    const loopOn = edge.loop === 'fws' ? v.layers.facility_water : v.layers.technology_cooling && (edge.role === 'supply' ? v.layers.tcs_supply : v.layers.tcs_return);
    if (groupRef.current) groupRef.current.visible = loopOn && !(v.mode === 'pipe' && v.pipeEdgeId === edge.id);
    const selected = v.selectedId === edge.id;
    const hovered = v.hoverId === edge.id;
    const inPipeMode = v.mode === 'pipe';
    const isCurrent = inPipeMode && v.pipeEdgeId === edge.id;
    // targets
    let hiT = selected ? 1 : hovered ? 0.6 : 0;
    let dimT = relRef.current;
    let shellT = v.xray ? 0.1 : 0.2;
    if (inPipeMode) {
      dimT = isCurrent ? 0.0 : 0.16;
      shellT = isCurrent ? 0.05 : 0.05;
    }
    if (v.layers.robot_access) {
      // robot-access view: what a crawler can enter stays bright, everything else steps back
      if (edge.robot_passable) hiT = Math.max(hiT, 0.4);
      else dimT *= 0.3;
    }
    if (status === 'isolated') dimT *= 0.45;
    const fi = filterIndex(useDashView.getState().filter);
    if (fi === 2) dimT *= 0.3;
    else if (fi === 3) dimT *= 0.4;
    const vel = a?.readings.velocity_m_s ?? 0.5;
    // tracer direction = sign of the SOLVED flow along nominal from→to; no solved flow, no tracers
    const fl = a?.readings.flow_kg_s ?? 0;
    const speedT = v.layers.flow && status !== 'isolated' && Math.abs(fl) > FLOW_EPS ? Math.sign(fl) * Math.min(vel, 2.5) * 1.1 : 0;
    const k = 1 - Math.exp(-dt * 6);
    const c = cur.current;
    c.hi += (hiT - c.hi) * k;
    c.dim += (dimT - c.dim) * k;
    c.shell += (shellT - c.shell) * k;
    c.speed += (speedT - c.speed) * (1 - Math.exp(-dt * 2));
    const pulse = 0.65 + 0.35 * Math.sin(state.clock.elapsedTime * (status === 'critical' ? 6 : 3));
    uniforms.uTime.value += dt;
    if (fi === 4) uniforms.uColor.value.set(pressureColor(a?.readings.dp_kpa ?? 0));
    else uniforms.uColor.value.copy(baseColor);
    uniforms.uSpeed.value = c.speed;
    uniforms.uHi.value = c.hi;
    // cooling cutaway: everything else fades, so the solid pipes get brighter
    uniforms.uDim.value = Math.max(c.dim, 0) * (v.xray ? 1.35 : 1);
    // fully lit pipes are opaque (correct occlusion, early-z, no sort artefacts); they only turn translucent while dimmed
    const opq = c.dim > 0.97 ? 1 : Math.min(0.96, Math.max(c.dim, 0) * 1.4);
    uniforms.uOpacity.value = opq;
    const tr = opq < 0.999;
    if (coreMat.transparent !== tr) {
      coreMat.transparent = tr;
      coreMat.depthWrite = !tr;
    }
    const alertT = (ALERT[status] ?? 0) * (status === 'warning' || status === 'critical' ? pulse : 1);
    c.alert += (alertT - c.alert) * k;
    uniforms.uAlertAmt.value = c.alert;
    if (ALERT_COLOR[status]) uniforms.uAlert.value.set(ALERT_COLOR[status]);
    const occ = a?.fault?.occlusion ?? 0;
    uniforms.uOcc.value = occ;
    uniforms.uOccS.value = a?.fault?.location_s_m ?? 0;
    if (shellRef.current) {
      shellRef.current.opacity = c.shell * (0.45 + 0.55 * Math.max(c.dim, 0.3)) + c.hi * 0.12;
      shellRef.current.visible = shellRef.current.opacity > 0.01;
    }
  });

  return (
    <group
      ref={groupRef}
      onPointerOver={(e) => {
        e.stopPropagation();
        useView.getState().hover(edge.id);
      }}
      onPointerOut={() => useView.getState().hover(null)}
      onClick={(e) => {
        e.stopPropagation();
        useView.getState().select(edge.id);
      }}
    >
      <mesh geometry={coreGeo} renderOrder={1}>
        <primitive object={coreMat} attach="material" />
      </mesh>
      <mesh geometry={shellGeo} renderOrder={2}>
        <meshPhysicalMaterial ref={shellRef} color="#e8f2f8" roughness={0.06} metalness={0} clearcoat={1} clearcoatRoughness={0.05} transparent opacity={0.2} depthWrite={false} envMapIntensity={1.4} />
      </mesh>
    </group>
  );
}

/** flanges (bolted pair every 2.6 m and at every end) and cladding bands (every 1.3 m between them): two InstancedMeshes for the whole network */
function PipeHardware({ paths }: { paths: Record<string, Path> }) {
  const topo = useWorld((s) => s.topology);
  const refF = useRef<THREE.InstancedMesh>(null);
  const refB = useRef<THREE.InstancedMesh>(null);
  const { fl, bd } = useMemo(() => {
    const fl: THREE.Matrix4[] = [];
    const bd: THREE.Matrix4[] = [];
    if (!topo) return { fl, bd };
    const up = new THREE.Vector3(0, 1, 0);
    const at = (p: Path, s: number, r: number, thick: number, into: THREE.Matrix4[]) => {
      let seg = 0;
      while (seg < p.cum.length - 2 && p.cum[seg + 1] < s) seg++;
      const a = p.points[seg];
      const b = p.points[seg + 1];
      const f = (s - p.cum[seg]) / (p.cum[seg + 1] - p.cum[seg] || 1);
      const pos = new THREE.Vector3(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
      const tan = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      into.push(new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromUnitVectors(up, tan), new THREE.Vector3(r, r * thick, r)));
    };
    for (const e of topo.edges) {
      const p = paths[e.id];
      if (!p || isRackDrop(e)) continue;
      const r = outerR(e.diameter_mm);
      const stops: number[] = [0.07, p.length - 0.07];
      for (let s = 2.6; s < p.length - 1.2; s += 2.6) stops.push(s);
      for (const s of stops) at(p, s, r, 1, fl);
      for (let s = 1.3; s < p.length - 0.4; s += 1.3) if (stops.every((x) => Math.abs(x - s) > 0.35)) at(p, s, r, 1, bd);
    }
    return { fl, bd };
  }, [topo, paths]);
  useEffect(() => {
    if (refF.current) {
      fl.forEach((m, i) => refF.current!.setMatrixAt(i, m));
      refF.current.instanceMatrix.needsUpdate = true;
    }
    if (refB.current) {
      bd.forEach((m, i) => refB.current!.setMatrixAt(i, m));
      refB.current.instanceMatrix.needsUpdate = true;
    }
  }, [fl, bd]);
  if (!fl.length) return null;
  return (
    <>
      <instancedMesh key={`f${fl.length}`} ref={refF} args={[FLANGE_GEO, undefined, fl.length]} castShadow={false} frustumCulled={false} raycast={() => null}>
        <meshStandardMaterial color="#8a94a5" metalness={0.65} roughness={0.38} />
      </instancedMesh>
      {bd.length > 0 && (
        <instancedMesh key={`b${bd.length}`} ref={refB} args={[BAND_GEO, undefined, bd.length]} castShadow={false} frustumCulled={false} raycast={() => null}>
          <meshStandardMaterial color="#c3cad5" metalness={0.7} roughness={0.35} />
        </instancedMesh>
      )}
    </>
  );
}
