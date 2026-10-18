import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { useWorld } from '@loopkeeper/core/store';
import { useView } from './view';
import type { Topology } from '@loopkeeper/core/contracts';
import { samplePath } from '@loopkeeper/core';
import { cachedPaths } from './geomCache';
import { mergeParts, xf } from './merge';
import { outerR } from './dims';
import { C, fluidColor } from './theme';

/**
 * Pipe hardware from /topology: `supports[]` (trapeze hangers, floor saddles) and `fittings[]` (elbows, tees).
 * Static, merged into two draw calls, rebuilt only when the topology hash changes.
 */
type RGB = [number, number, number];
const rgb = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

interface Support {
  id: string;
  edge_id: string;
  s_m: number;
  position_xyz_m: number[];
  type: string;
}
interface Fitting {
  id: string;
  type: string;
  edge_id?: string;
  loop?: string;
  position_xyz_m: number[];
  bore_m?: number;
  radius_m?: number;
}

function build(topo: Topology) {
  const supports = ((topo as unknown as { supports?: Support[] }).supports ?? []) as Support[];
  const fittings = ((topo as unknown as { fittings?: Fitting[] }).fittings ?? []) as Fitting[];
  const edges = new Map(topo.edges.map((e) => [e.id, e]));
  const paths = cachedPaths(topo);
  const H = topo.facility.wall_height_m ?? 6;
  const steel = rgb('#7d8899');
  const dark = rgb('#4a5262');
  const sup: Array<{ geo: THREE.BufferGeometry; m?: THREE.Matrix4; c?: RGB }> = [];
  /** threaded rods to the truss line (full height) and the short cut-away version used while the roof structure is hidden */
  const rodsFull: Array<{ geo: THREE.BufferGeometry; m?: THREE.Matrix4; c?: RGB }> = [];
  const rodsStub: Array<{ geo: THREE.BufferGeometry; m?: THREE.Matrix4; c?: RGB }> = [];
  for (const s of supports) {
    const e = edges.get(s.edge_id);
    const path = paths[s.edge_id];
    if (!e || !path) continue;
    const r = outerR(e.diameter_mm);
    const [x, y, z] = s.position_xyz_m;
    const t = samplePath(path, s.s_m).t;
    const yaw = Math.atan2(t[0], t[2]); // pipe axis -> +z after rotation; supports span across it
    if (s.type === 'floor_saddle') {
      const h = Math.max(y - r, 0.05);
      sup.push({ geo: new THREE.BoxGeometry(r * 2.6, h, 0.22), m: xf(x, h / 2, z, 0, yaw, 0), c: dark });
      sup.push({ geo: new THREE.BoxGeometry(r * 2.8, 0.04, 0.34), m: xf(x, 0.02, z, 0, yaw, 0), c: steel });
      sup.push({ geo: new THREE.BoxGeometry(r * 2.4, 0.05, 0.2), m: xf(x, y - r - 0.02, z, 0, yaw, 0), c: steel });
    } else {
      // trapeze hanger: channel under the pipe, two threaded rods up to the truss line, clamp strap over the pipe
      const top = Math.max(H - 0.45, y + r + 0.3);
      const half = r * 1.5 + 0.06;
      const rodH = top - (y - r);
      const across = (dx: number) => new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().makeRotationY(yaw), new THREE.Matrix4().makeTranslation(dx, 0, 0));
      const place = (g: THREE.BufferGeometry, dx: number, dy: number, c: RGB) => {
        const m = new THREE.Matrix4().makeTranslation(x, dy, z).multiply(across(dx));
        sup.push({ geo: g, m, c });
      };
      place(new THREE.BoxGeometry(half * 2, 0.04, 0.06), 0, y - r - 0.03, steel);
      const stubH = Math.min(rodH, r * 2 + 0.4);
      const at = (g: THREE.BufferGeometry, dx: number, dy: number, c: RGB, into: typeof sup) => into.push({ geo: g, m: new THREE.Matrix4().makeTranslation(x, dy, z).multiply(across(dx)), c });
      for (const sx of [-1, 1]) {
        at(new THREE.CylinderGeometry(0.01, 0.01, rodH, 6), sx * half, y - r + rodH / 2, dark, rodsFull);
        at(new THREE.CylinderGeometry(0.01, 0.01, stubH, 6), sx * half, y - r + stubH / 2, dark, rodsStub);
      }
      // cut-away: a beam-clamp plate caps each stub so the hanger reads as anchored, not floating
      at(new THREE.BoxGeometry(half * 2 + 0.08, 0.025, 0.07), 0, y - r + stubH, dark, rodsStub);
      place(new THREE.BoxGeometry(r * 2.3, 0.02, 0.05), 0, y + r * 0.9, steel);
    }
  }
  const fit: Array<{ geo: THREE.BufferGeometry; m?: THREE.Matrix4; c?: RGB }> = [];
  const loopCol: Record<string, RGB> = { fws: rgb(C.fwsReturn), tcs: rgb('#8a97a8') };
  for (const f of fittings) {
    const [x, y, z] = f.position_xyz_m;
    const bore = f.bore_m ?? (f.edge_id ? (edges.get(f.edge_id)?.diameter_mm ?? 100) / 1000 : 0.1);
    const r = outerR(bore * 1000);
    // fittings carry the jacket colour of the pipe they sit on (so a TCS elbow is cyan / amber, an FWS elbow navy / slate), a hair proud of the pipe
    const ed = f.edge_id ? edges.get(f.edge_id) : undefined;
    const c = ed ? rgb(fluidColor(ed.loop, ed.role)) : (loopCol[f.loop ?? 'tcs'] ?? steel);
    const cc: RGB = [c[0] * 0.78, c[1] * 0.78, c[2] * 0.78];
    fit.push({ geo: new THREE.SphereGeometry(r * 1.03, 14, 10), m: xf(x, y, z), c: cc });
    if (f.type === 'tee') fit.push({ geo: new THREE.CylinderGeometry(r * 0.72, r * 0.72, r * 1.8, 12), m: xf(x, y - r * 0.9, z), c: cc });
  }
  return { sup: sup.length ? mergeParts(sup) : null, rodsFull: rodsFull.length ? mergeParts(rodsFull) : null, rodsStub: rodsStub.length ? mergeParts(rodsStub) : null, fit: fit.length ? mergeParts(fit) : null };
}

export function PipeSupports() {
  const topo = useWorld((s) => s.topology);
  const g = useMemo(() => (topo ? build(topo) : null), [topo]);
  useEffect(() => () => (g?.sup?.dispose(), g?.fit?.dispose(), g?.rodsFull?.dispose(), g?.rodsStub?.dispose()), [g]);
  const full = useRef<THREE.Mesh>(null);
  const stub = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const v = useView.getState();
    // full-height rods only while the roof structure they hang from is drawn
    const roofOn = v.layers.walls && !v.xray && v.mode !== 'pipe';
    if (full.current) full.current.visible = roofOn;
    if (stub.current) stub.current.visible = !roofOn;
  });
  if (!g) return null;
  return (
    <group name="pipe-hardware">
      {g.sup && (
        <mesh geometry={g.sup}>
          <meshStandardMaterial vertexColors metalness={0.6} roughness={0.5} />
        </mesh>
      )}
      {g.rodsFull && (
        <mesh ref={full} geometry={g.rodsFull}>
          <meshStandardMaterial vertexColors metalness={0.6} roughness={0.5} />
        </mesh>
      )}
      {g.rodsStub && (
        <mesh ref={stub} geometry={g.rodsStub}>
          <meshStandardMaterial vertexColors metalness={0.6} roughness={0.5} />
        </mesh>
      )}
      {g.fit && (
        <mesh geometry={g.fit}>
          <meshStandardMaterial vertexColors metalness={0.35} roughness={0.55} />
        </mesh>
      )}
    </group>
  );
}
