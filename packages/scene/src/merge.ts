import * as THREE from 'three';

/** Merge transformed copies of simple (position/normal/uv) geometries into one non-indexed geometry. */
export function mergeParts(parts: Array<{ geo: THREE.BufferGeometry; m?: THREE.Matrix4; c?: [number, number, number] }>): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const cols: number[] = [];
  const useColor = parts.some((p) => p.c);
  for (const { geo, m, c } of parts) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (m) {
      g.applyMatrix4(m);
    }
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      if (n) nor.push(n.getX(i), n.getY(i), n.getZ(i));
      uvs.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
      if (useColor) cols.push(c ? c[0] : 1, c ? c[1] : 1, c ? c[2] : 1);
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (useColor) out.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return out;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
/** translate / rotate (euler xyz) / scale helper */
export function xf(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q, new THREE.Vector3(sx, sy, sz));
}
export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
