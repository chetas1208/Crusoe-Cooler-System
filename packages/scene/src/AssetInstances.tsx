import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Asset } from '@loopkeeper/core/contracts';
import { useWorld } from '@loopkeeper/core/store';
import { C, STATUS_COLOR } from './theme';
import { Brackets } from './Select';
import { useView } from './view';
import { usePaths } from './Pipes';
import { mergeParts, xf } from './merge';

/**
 * Small repeated hardware (crawler ports, robot docks, sensor glyphs) as InstancedMeshes with instance-id picking.
 * One draw call per part for the whole facility instead of 3-6 meshes + a bracket object + a useFrame per asset.
 */
type RGB = [number, number, number];
const rgb = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const Y = new THREE.Vector3(0, 1, 0);

function tangentAt(path: { points: Array<[number, number, number]>; cum: number[] }, s: number) {
  let i = 0;
  while (i < path.cum.length - 2 && path.cum[i + 1] < s) i++;
  const a = path.points[i];
  const b = path.points[i + 1];
  return new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
}

function usePick(ids: string[]) {
  return useMemo(() => {
    const idOf = (e: { instanceId?: number }) => (e.instanceId !== undefined ? ids[e.instanceId] : undefined);
    return {
      onPointerOver: (e: { stopPropagation(): void; instanceId?: number }) => {
        e.stopPropagation();
        const id = idOf(e);
        if (id) useView.getState().hover(id);
        if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
      },
      onPointerOut: () => {
        useView.getState().hover(null);
        if (typeof document !== 'undefined') document.body.style.cursor = '';
      },
      onClick: (e: { stopPropagation(): void; instanceId?: number }) => {
        e.stopPropagation();
        const id = idOf(e);
        if (id) useView.getState().select(id);
      },
    };
  }, [ids]);
}

const nr = () => null;

/* ── crawler access ports ── */
const portLit = (() => {
  const g = mergeParts([
    { geo: new THREE.CylinderGeometry(0.1, 0.1, 0.16, 18), m: xf(0, 0.11, 0), c: rgb('#98a2b2') },
    { geo: new THREE.CylinderGeometry(0.125, 0.125, 0.03, 18), m: xf(0, 0.2, 0), c: rgb('#c3ccd9') },
  ]);
  return g;
})();
const portGlow = new THREE.CylinderGeometry(0.05, 0.05, 0.012, 14).translate(0, 0.218, 0);

export function PortsInstanced({ ports }: { ports: Asset[] }) {
  const paths = usePaths();
  const lit = useRef<THREE.InstancedMesh>(null);
  const glow = useRef<THREE.InstancedMesh>(null);
  const ids = useMemo(() => ports.map((p) => p.id), [ports]);
  const pick = usePick(ids);
  useEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3();
    const side = new THREE.Vector3();
    const n = new THREE.Vector3();
    ports.forEach((a, i) => {
      const p = a.edge_id ? paths[a.edge_id] : undefined;
      const t = p ? tangentAt(p, a.s_m ?? 0.5) : new THREE.Vector3(1, 0, 0);
      // the hatch stands perpendicular to the pipe: pick the "up-ish" perpendicular
      up.copy(Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : Y);
      side.crossVectors(t, up).normalize();
      n.crossVectors(side, t).normalize();
      q.setFromUnitVectors(Y, n);
      m.compose(new THREE.Vector3(...a.position_xyz_m), q, new THREE.Vector3(1, 1, 1));
      lit.current?.setMatrixAt(i, m);
      glow.current?.setMatrixAt(i, m);
    });
    for (const r of [lit.current, glow.current]) {
      if (!r) continue;
      r.instanceMatrix.needsUpdate = true;
      r.computeBoundingSphere();
    }
  }, [ports, paths]);
  if (!ports.length) return null;
  return (
    <group name="ports">
      <instancedMesh ref={lit} args={[portLit, undefined, ports.length]} {...pick}>
        <meshStandardMaterial vertexColors metalness={0.5} roughness={0.4} />
      </instancedMesh>
      <instancedMesh ref={glow} args={[portGlow, undefined, ports.length]} raycast={nr}>
        <meshBasicMaterial color={C.accent} />
      </instancedMesh>
    </group>
  );
}

/* ── robot docks: charging pad + marker chevrons + beacon post ── */
const dockPad = new THREE.BoxGeometry(1, 0.024, 1).translate(0, 0.012, 0);
const dockPost = mergeParts([
  { geo: new THREE.BoxGeometry(0.08, 0.5, 0.08), m: xf(0.45, 0.25, 0.65), c: rgb('#3b424e') },
]);
const dockGlow = mergeParts(
  [
    ...[-0.4, 0, 0.4].map((z, i) => ({ geo: new THREE.PlaneGeometry(0.3, 0.12), m: xf(0, 0.026, z, -Math.PI / 2, 0, Math.PI / 2), c: (() => { const c = rgb(C.outrig); const k = 0.5 + i * 0.15; return [c[0] * k, c[1] * k, c[2] * k] as RGB; })() })),
    { geo: new THREE.SphereGeometry(0.035, 10, 8), m: xf(0.45, 0.52, 0.65), c: rgb(C.nominal) },
  ],
);

export function DocksInstanced({ docks }: { docks: Asset[] }) {
  const pad = useRef<THREE.InstancedMesh>(null);
  const post = useRef<THREE.InstancedMesh>(null);
  const glow = useRef<THREE.InstancedMesh>(null);
  const ids = useMemo(() => docks.map((d) => d.id), [docks]);
  const pick = usePick(ids);
  useEffect(() => {
    const m = new THREE.Matrix4();
    docks.forEach((a, i) => {
      const [w, , d] = a.size_m ?? [1.4, 0.05, 1.8];
      pad.current?.setMatrixAt(i, m.compose(new THREE.Vector3(...a.position_xyz_m), new THREE.Quaternion(), new THREE.Vector3(w, 1, d)));
      const t = m.makeTranslation(a.position_xyz_m[0], a.position_xyz_m[1], a.position_xyz_m[2]);
      post.current?.setMatrixAt(i, t);
      glow.current?.setMatrixAt(i, t);
    });
    for (const r of [pad.current, post.current, glow.current]) {
      if (!r) continue;
      r.instanceMatrix.needsUpdate = true;
      r.computeBoundingSphere();
    }
  }, [docks]);
  if (!docks.length) return null;
  return (
    <group name="docks">
      <instancedMesh ref={pad} args={[dockPad, undefined, docks.length]} receiveShadow {...pick}>
        <meshStandardMaterial color="#2e343e" roughness={0.8} />
      </instancedMesh>
      <instancedMesh ref={post} args={[dockPost, undefined, docks.length]} raycast={nr}>
        <meshStandardMaterial vertexColors metalness={0.6} roughness={0.4} />
      </instancedMesh>
      <instancedMesh ref={glow} args={[dockGlow, undefined, docks.length]} raycast={nr}>
        <meshBasicMaterial vertexColors />
      </instancedMesh>
    </group>
  );
}

/* ── sensor glyphs ── */
const sensStem = new THREE.CylinderGeometry(0.035, 0.035, 0.16, 10).translate(0, 0.16, 0);
const sensHead = new THREE.SphereGeometry(0.05, 14, 10).translate(0, 0.27, 0);
const sensRing = new THREE.TorusGeometry(0.085, 0.006, 6, 24).rotateX(Math.PI / 2).translate(0, 0.27, 0);

export function SensorsInstanced({ sensors }: { sensors: Asset[] }) {
  const stem = useRef<THREE.InstancedMesh>(null);
  const head = useRef<THREE.InstancedMesh>(null);
  const ring = useRef<THREE.InstancedMesh>(null);
  const ids = useMemo(() => sensors.map((s) => s.id), [sensors]);
  const pick = usePick(ids);
  const last = useRef<string[]>([]);
  useEffect(() => {
    const m = new THREE.Matrix4();
    sensors.forEach((a, i) => {
      m.makeTranslation(a.position_xyz_m[0], a.position_xyz_m[1], a.position_xyz_m[2]);
      stem.current?.setMatrixAt(i, m);
      head.current?.setMatrixAt(i, m);
      ring.current?.setMatrixAt(i, m);
    });
    last.current = [];
    for (const r of [stem.current, head.current, ring.current]) {
      if (!r) continue;
      r.instanceMatrix.needsUpdate = true;
      r.computeBoundingSphere();
    }
  }, [sensors]);
  const col = useMemo(() => new THREE.Color(), []);
  const mt = useMemo(() => new THREE.Matrix4(), []);
  useFrame((state) => {
    const h = head.current;
    if (!h) return;
    const w = useWorld.getState();
    let dirty = false;
    let ringDirty = false;
    for (let i = 0; i < sensors.length; i++) {
      const a = w.assets[sensors[i].id];
      const suspect = !!a?.suspect?.length;
      const key = suspect ? 'suspect' : a?.status ?? 'nominal';
      if (last.current[i] !== key) {
        last.current[i] = key;
        h.setColorAt(i, col.set(suspect ? C.warning : STATUS_COLOR[a?.status ?? 'nominal']));
        dirty = true;
      }
      if (suspect) {
        const s = 1 + 0.25 * Math.sin(state.clock.elapsedTime * 3 + sensors[i].position_xyz_m[0]);
        const p = sensors[i].position_xyz_m;
        ring.current?.setMatrixAt(i, mt.compose(new THREE.Vector3(p[0], p[1] + 0.27 * (1 - s), p[2]), new THREE.Quaternion(), new THREE.Vector3(s, s, s)));
        ringDirty = true;
      }
    }
    if (dirty && h.instanceColor) h.instanceColor.needsUpdate = true;
    if (ringDirty && ring.current) ring.current.instanceMatrix.needsUpdate = true;
  });
  if (!sensors.length) return null;
  return (
    <group name="sensors">
      <instancedMesh ref={stem} args={[sensStem, undefined, sensors.length]} {...pick}>
        <meshStandardMaterial color="#5d6676" metalness={0.7} roughness={0.4} />
      </instancedMesh>
      <instancedMesh ref={head} args={[sensHead, undefined, sensors.length]} raycast={nr}>
        <meshBasicMaterial color="#ffffff" />
      </instancedMesh>
      <instancedMesh ref={ring} args={[sensRing, undefined, sensors.length]} raycast={nr}>
        <meshBasicMaterial color="#ffffff" transparent opacity={0.4} />
      </instancedMesh>
    </group>
  );
}

/* ── one bracket set for the hovered / selected asset (replaces a Brackets object + useFrame on every asset) ── */
function sizeOf(a: Asset): { size: [number, number, number]; offset: [number, number, number] } {
  const [w, h, d] = a.size_m ?? [0.5, 0.5, 0.5];
  switch (a.type) {
    case 'cdu':
      return { size: [w + 0.15, h + 0.15, d + 0.15], offset: [0, h / 2, 0] };
    case 'chiller':
    case 'dock':
      return { size: [w + 0.2, h + 0.2, d + 0.2], offset: [0, h / 2, 0] };
    case 'pump':
      return { size: [1.05, 1.0, 0.8], offset: [0, 0.5, 0] };
    case 'valve': {
      const s = a.id.length === 8 && !a.id.startsWith('valve_z') ? 1 : 1.35;
      return { size: [0.5 * s, 0.5 * s, 0.5 * s], offset: [0, 0, 0] };
    }
    case 'strainer':
      return { size: [0.7, 0.7, 0.7], offset: [0, 0, 0] };
    case 'sensor':
      return { size: [0.4, 0.4, 0.4], offset: [0, 0, 0] };
    default:
      return { size: [0.5, 0.5, 0.5], offset: [0, 0, 0] };
  }
}

function Follow({ a }: { a: Asset }) {
  const { size, offset } = useMemo(() => sizeOf(a), [a]);
  return (
    <group position={a.position_xyz_m}>
      <Brackets size={size} id={a.id} offset={offset} />
    </group>
  );
}

export function AssetBrackets() {
  const sel = useView((s) => s.selectedId);
  const hov = useView((s) => s.hoverId);
  const byId = useWorld((s) => s.assetsById);
  const skip = (id: string) => byId[id]?.type === 'rack';
  return (
    <>
      {sel && byId[sel] && !skip(sel) && <Follow key={sel} a={byId[sel]} />}
      {hov && hov !== sel && byId[hov] && !skip(hov) && <Follow key={hov} a={byId[hov]} />}
    </>
  );
}
