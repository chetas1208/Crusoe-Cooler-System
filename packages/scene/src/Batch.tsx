import { useEffect, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

/**
 * Static batching for hand-modelled equipment (CDU, dry cooler, pump skids, …).
 *
 * After mount, every plain mesh below the wrapper that is not tagged `userData.dyn` (animated in useFrame)
 * is merged — per material signature — into one mesh in the wrapper's local space, and the originals are
 * hidden (`visible = false`, so they cost nothing to render but stay raycastable for the owner's pointer
 * handlers). A 70-mesh dry cooler becomes ~10 draw calls with identical pixels.
 *
 * Tag anything that moves, changes colour or scale at runtime with `userData={{ dyn: true }}`
 * (on the mesh or any ancestor inside the wrapper). Transparent materials are never batched.
 * A dyn *group* (a spinning fan, a pump motor) keeps animating as one object, but the static meshes inside it are merged in the
 * group's own local space (per material), so a 6-blade fan is 1-2 draw calls and still rotates with its group.
 * `dim` (0..1) fades the whole batch (agents-mode relevance), replacing the per-material opacity props.
 */
interface Bucket {
  mat: THREE.Material;
  pos: number[];
  nor: number[];
  uv: number[];
  cast: boolean;
  recv: boolean;
  order: number;
}

function isBatchable(m: THREE.Mesh, root: THREE.Object3D, rootIsDyn = false): boolean {
  if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || !m.visible || m.userData?.batched) return false;
  const mat = m.material;
  if (Array.isArray(mat) || mat.transparent || (mat as THREE.MeshStandardMaterial).vertexColors) return false;
  if (!(mat instanceof THREE.MeshStandardMaterial || mat instanceof THREE.MeshBasicMaterial)) return false;
  // sub-batching a dyn group: the group itself is the (animated) space the merge happens in, so its own flag does not count
  for (let p: THREE.Object3D | null = m; p && p !== (rootIsDyn ? root : root.parent); p = p.parent) {
    if (p.userData?.dyn || p.userData?.noBatch || !p.visible) return false;
  }
  return true;
}

export function batchStatic(root: THREE.Object3D, rootIsDyn = false): { meshes: THREE.Mesh[]; hidden: THREE.Mesh[] } {
  root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const buckets = new Map<string, Bucket>();
  const hidden: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!isBatchable(m, root, rootIsDyn)) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    const std = mat instanceof THREE.MeshStandardMaterial;
    const key = `${mat.type}|${mat.color.getHex()}|${std ? mat.roughness : 0}|${std ? mat.metalness : 0}|${mat.side}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}|${m.renderOrder}|${mat.toneMapped}`;
    let b = buckets.get(key);
    if (!b) {
      const clone = mat.clone();
      b = { mat: clone, pos: [], nor: [], uv: [], cast: m.castShadow, recv: m.receiveShadow, order: m.renderOrder };
      buckets.set(key, b);
    }
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    rel.multiplyMatrices(inv, m.matrixWorld);
    g.applyMatrix4(rel);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      b.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      b.nor.push(n ? n.getX(i) : 0, n ? n.getY(i) : 1, n ? n.getZ(i) : 0);
      b.uv.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
    }
    g.dispose();
    hidden.push(m);
  });
  const meshes: THREE.Mesh[] = [];
  for (const b of buckets.values()) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    const mesh = new THREE.Mesh(g, b.mat);
    mesh.name = 'batched';
    mesh.castShadow = b.cast;
    mesh.receiveShadow = b.recv;
    mesh.renderOrder = b.order;
    mesh.raycast = () => undefined; // pointer events stay on the (hidden) originals
    mesh.userData.batched = true;
    root.add(mesh);
    meshes.push(mesh);
  }
  for (const m of hidden) m.visible = false;
  if (!rootIsDyn) {
    // dyn groups (fans, pump motors): merge their static children in the group's own space; the group keeps animating
    const dynGroups: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (o !== root && o.userData?.dyn && !(o as THREE.Mesh).isMesh && !o.userData?.noBatch) dynGroups.push(o);
    });
    for (const g of dynGroups) {
      const sub = batchStatic(g, true);
      meshes.push(...sub.meshes);
      hidden.push(...sub.hidden);
    }
  }
  return { meshes, hidden };
}

export function Batched({ children, dim = 1, name }: { children: ReactNode; dim?: number; name?: string }) {
  const ref = useRef<THREE.Group>(null);
  const state = useRef<{ meshes: THREE.Mesh[]; hidden: THREE.Mesh[] } | null>(null);
  const dimRef = useRef(dim);
  dimRef.current = dim;
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    state.current = batchStatic(root);
    return () => {
      const s = state.current;
      if (!s) return;
      for (const m of s.meshes) {
        m.parent?.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      for (const m of s.hidden) m.visible = true;
      state.current = null;
    };
    // children are static by contract: batch once per mount
  }, []);
  const last = useRef(1);
  useFrame(() => {
    const s = state.current;
    if (!s || dimRef.current === last.current) return;
    last.current = dimRef.current;
    for (const m of s.meshes) {
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.transparent = dimRef.current < 0.98;
      mat.opacity = Math.max(dimRef.current, 0.14);
      mat.needsUpdate = true;
    }
  });
  return (
    <group ref={ref} name={name}>
      {children}
    </group>
  );
}
