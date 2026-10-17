import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { PipeEdge, Topology } from '@loopkeeper/core/contracts';
import { useWorld } from '@loopkeeper/core/store';
import { buildPath } from '@loopkeeper/core';
import { fluidColor } from './theme';
import { outerR } from './dims';
import { useView } from './view';
import { FLOW_EPS } from './flow';
import { cachedPaths } from './geomCache';

/**
 * Two instanced layers over the pipe network, both derived only from /topology + the solved world:
 *  - PipeFittings: a joint sphere at every node where edges meet (tees / elbows between edges), a tee collar at every
 *    header tap, and a cap at every dead end — so no pipe ever ends in the air.
 *  - FlowArrows: direction cones, spaced along each edge, pointing along the SIGN of the solved flow (flow_kg_s along the
 *    edge's nominal from→to). |flow| ≤ FLOW_EPS → no arrow. They flip when the solver reverses an edge.
 */

const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);

type NodeRec = { id: string; position_xyz_m: [number, number, number] };

export function PipeFittings() {
  const topo = useWorld((s) => s.topology);
  const ref = useRef<THREE.InstancedMesh>(null);
  const fits = useMemo(() => {
    if (!topo) return [];
    const nodes = new Map(((topo as unknown as { nodes?: NodeRec[] }).nodes ?? []).map((n) => [n.id, n.position_xyz_m]));
    const touching = new Map<string, PipeEdge[]>();
    const tapNodes = new Map<string, number>(); // node id -> header radius
    for (const e of topo.edges) {
      for (const nid of [e.from, e.to]) touching.set(nid, [...(touching.get(nid) ?? []), e]);
      for (const t of (e as unknown as { taps?: Array<{ node_id: string }> }).taps ?? []) tapNodes.set(t.node_id, outerR(e.diameter_mm));
    }
    const out: Array<{ p: [number, number, number]; r: number; color: string; loop: string; roles: Set<string> }> = [];
    for (const [nid, es] of touching) {
      const p = nodes.get(nid);
      if (!p) continue;
      const rMax = Math.max(...es.map((e) => outerR(e.diameter_mm)));
      const hdr = tapNodes.get(nid);
      // joints between edges (deg ≥ 2) and tee collars where a drop leaves a header
      const r = hdr !== undefined ? Math.max(rMax, hdr) * 1.1 : es.length >= 2 ? rMax * 1.1 : rMax * 1.06;
      out.push({ p: p as [number, number, number], r, color: es[0] ? fluidColor(es[0].loop, es[0].role) : '#aab3c1', loop: es[0].loop, roles: new Set(es.map((e) => `${e.loop}:${e.role}`)) });
    }
    return out;
  }, [topo]);
  const mats = useMemo(() => fits.map((f) => new THREE.Matrix4().compose(new THREE.Vector3(...f.p), new THREE.Quaternion(), new THREE.Vector3(f.r, f.r, f.r))), [fits]);
  const maskKey = useRef(-1);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const c = new THREE.Color();
    fits.forEach((f, i) => {
      m.setMatrixAt(i, mats[i]);
      c.set(f.color).lerp(new THREE.Color('#c5ccd8'), 0.4);
      m.setColorAt(i, c);
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    maskKey.current = -1;
  }, [fits, mats]);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const v = useView.getState();
    const L = v.layers;
    m.visible = v.mode !== 'pipe';
    // a fitting shows while at least one of the circuits it joins is switched on (FWS, TCS supply, TCS return are separate layers)
    const key = (L.facility_water ? 1 : 0) | (L.technology_cooling && L.tcs_supply ? 2 : 0) | (L.technology_cooling && L.tcs_return ? 4 : 0);
    if (key === maskKey.current) return;
    maskKey.current = key;
    const on = (r: string) => (r.startsWith('fws') ? !!(key & 1) : r === 'tcs:supply' ? !!(key & 2) : !!(key & 4));
    fits.forEach((f, i) => m.setMatrixAt(i, [...f.roles].some(on) ? mats[i] : ZERO_M));
    m.instanceMatrix.needsUpdate = true;
  });
  if (!fits.length) return null;
  return (
    <instancedMesh key={fits.length} ref={ref} args={[undefined, undefined, fits.length]} frustumCulled={false} name="pipe-fittings">
      <sphereGeometry args={[1, 12, 8]} />
      <meshStandardMaterial metalness={0.2} roughness={0.55} />
    </instancedMesh>
  );
}

interface Arrow {
  edge: PipeEdge;
  pos: THREE.Vector3;
  tan: THREE.Vector3;
  r: number;
  color: THREE.Color;
}

function buildArrows(topo: Topology): Arrow[] {
  const paths = cachedPaths(topo);
  const out: Arrow[] = [];
  const isDrop = (e: PipeEdge) => /^n_[a-z]\d+_in$/.test(e.to) || /^n_[a-z]\d+_out$/.test(e.from);
  for (const e of topo.edges) {
    if (isDrop(e) || e.length_m < 1.2) continue; // rack drops are < 1 m: the tracers and the rack LED carry their direction
    const p = paths[e.id] ?? buildPath(e.centerline_xyz_m, e.fillet_radius_m);
    const n = Math.max(1, Math.floor(e.length_m / 2.6));
    const r = outerR(e.diameter_mm);
    const col = new THREE.Color(fluidColor(e.loop, e.role)).lerp(new THREE.Color('#ffffff'), 0.25);
    for (let k = 0; k < n; k++) {
      const s = ((k + 0.5) / n) * p.length;
      let seg = 0;
      while (seg < p.cum.length - 2 && p.cum[seg + 1] < s) seg++;
      const a = p.points[seg];
      const b = p.points[seg + 1];
      const f = (s - p.cum[seg]) / (p.cum[seg + 1] - p.cum[seg] || 1);
      const pos = new THREE.Vector3(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
      const tan = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      out.push({ edge: e, pos, tan, r, color: col });
    }
  }
  return out;
}

export function FlowArrows() {
  const topo = useWorld((s) => s.topology);
  const ref = useRef<THREE.InstancedMesh>(null);
  const arrows = useMemo(() => (topo ? buildArrows(topo) : []), [topo]);
  const state = useRef<{ key: string }>({ key: '' });
  const acc = useRef(0);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), d: new THREE.Vector3() }), []);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    arrows.forEach((a, i) => m.setColorAt(i, a.color));
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    state.current.key = '';
  }, [arrows]);
  useFrame((_, dt) => {
    const m = ref.current;
    if (!m) return;
    const v = useView.getState();
    m.visible = v.layers.flow && v.mode !== 'pipe';
    acc.current += dt;
    if (acc.current < 0.25) return;
    acc.current = 0;
    const w = useWorld.getState();
    // one pass over the arrows; the matrices are rewritten only when a sign / layer actually changed
    let key = '';
    const signs = new Int8Array(arrows.length);
    for (let i = 0; i < arrows.length; i++) {
      const e = arrows[i].edge;
      const loopOn = e.loop === 'fws' ? v.layers.facility_water : v.layers.technology_cooling && (e.role === 'supply' ? v.layers.tcs_supply : v.layers.tcs_return);
      const fl = w.assets[e.id]?.readings.flow_kg_s ?? 0;
      signs[i] = !loopOn || Math.abs(fl) <= FLOW_EPS ? 0 : fl > 0 ? 1 : -1;
    }
    key = signs.join('');
    if (key === state.current.key) return;
    state.current.key = key;
    const { m: mat, q, s, p, d } = tmp;
    arrows.forEach((a, i) => {
      const sg = signs[i];
      if (sg === 0) s.set(0, 0, 0);
      else {
        const len = Math.min(0.5, Math.max(0.24, a.r * 4));
        s.set(len * 0.3, len, len * 0.3);
      }
      d.copy(a.tan).multiplyScalar(sg || 1);
      q.setFromUnitVectors(up, d);
      p.copy(a.pos);
      p.y += a.r * 0.9; // sit on the pipe crown so it reads from above
      mat.compose(p, q, s);
      m.setMatrixAt(i, mat);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  if (!arrows.length) return null;
  return (
    <instancedMesh key={arrows.length} ref={ref} args={[undefined, undefined, arrows.length]} frustumCulled={false} renderOrder={4} raycast={() => null} name="flow-arrows">
      <coneGeometry args={[1, 1, 8]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}
