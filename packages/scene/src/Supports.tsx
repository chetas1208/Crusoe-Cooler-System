import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useWorld } from '@loopkeeper/core/store';
import type { Topology } from '@loopkeeper/core/contracts';
import { samplePath } from '@loopkeeper/core';
import { cachedPaths } from './geomCache';
import { mergeParts, xf } from './merge';
import { outerR } from './dims';
import { C } from './theme';

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
      for (const sx of [-1, 1]) place(new THREE.CylinderGeometry(0.01, 0.01, rodH, 6), sx * half, y - r + rodH / 2, dark);
      place(new THREE.BoxGeometry(r * 2.3, 0.02, 0.05), 0, y + r * 0.9, steel);
    }
  }
  const fit: Array<{ geo: THREE.BufferGeometry; m?: THREE.Matrix4; c?: RGB }> = [];
  const loopCol: Record<string, RGB> = { fws: rgb(C.fwsReturn), tcs: rgb('#8a97a8') };
  for (const f of fittings) {
    const [x, y, z] = f.position_xyz_m;
    const bore = f.bore_m ?? (f.edge_id ? (edges.get(f.edge_id)?.diameter_mm ?? 100) / 1000 : 0.1);
    const r = outerR(bore * 1000);
    const c = loopCol[f.loop ?? 'tcs'] ?? steel;
    // elbow / tee knuckle: a slightly oversized insulated ball joint with a flange collar
    fit.push({ geo: new THREE.SphereGeometry(r * 1.12, 14, 10), m: xf(x, y, z), c });
    fit.push({ geo: new THREE.TorusGeometry(r * 1.2, r * 0.12, 6, 18), m: xf(x, y, z, Math.PI / 2, 0, 0), c: rgb('#aab3c1') });
    if (f.type === 'tee') fit.push({ geo: new THREE.CylinderGeometry(r * 0.72, r * 0.72, r * 1.8, 12), m: xf(x, y - r * 0.9, z), c });
  }
  return { sup: sup.length ? mergeParts(sup) : null, fit: fit.length ? mergeParts(fit) : null };
}

export function PipeSupports() {
  const topo = useWorld((s) => s.topology);
  const g = useMemo(() => (topo ? build(topo) : null), [topo]);
  useEffect(() => () => (g?.sup?.dispose(), g?.fit?.dispose()), [g]);
  if (!g) return null;
  return (
    <group name="pipe-hardware">
      {g.sup && (
        <mesh geometry={g.sup}>
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
