import * as THREE from 'three';
import type { Path } from '@loopkeeper/core';

/**
 * Tube geometry along a filleted centerline with parallel-transport frames.
 * Adds `aS` (arc length in metres) so shaders can animate flow and place deposits
 * in physical units. Normals point outward (or inward when `inside`).
 */
export function buildTubeGeometry(path: Path, radius: number, radialSegs = 14, stepM = 0.12, inside = false, radiusFn?: (s: number, theta: number) => number, colorFn?: (s: number, theta: number) => [number, number, number], adaptive = false): THREE.BufferGeometry {
  const L = path.length;
  // adaptive: rings only where the centerline bends (every polyline/fillet vertex) plus at most `maxStraight` apart on straights.
  // A 12 m straight header needs ~13 rings, not ~85: same silhouette, ~6x fewer triangles.
  let sList: number[] | null = null;
  if (adaptive) {
    const maxStraight = Math.max(stepM, 1.0);
    sList = [0];
    for (let i = 1; i < path.cum.length; i++) {
      const a = sList[sList.length - 1];
      const b = Math.min(path.cum[i], L);
      if (b - a < 1e-6) continue;
      const n = Math.ceil((b - a) / maxStraight);
      for (let k = 1; k <= n; k++) sList.push(a + ((b - a) * k) / n);
    }
    if (sList.length < 3) sList = null;
  }
  const steps = sList ? sList.length - 1 : Math.max(2, Math.ceil(L / stepM));
  const pts: THREE.Vector3[] = [];
  const tans: THREE.Vector3[] = [];
  const ss: number[] = [];
  // sample uniformly in arc length
  let seg = 0;
  for (let i = 0; i <= steps; i++) {
    const s = sList ? sList[i] : (L * i) / steps;
    while (seg < path.cum.length - 2 && path.cum[seg + 1] < s) seg++;
    const a = path.points[seg];
    const b = path.points[seg + 1];
    const len = path.cum[seg + 1] - path.cum[seg] || 1e-9;
    const f = Math.min(Math.max((s - path.cum[seg]) / len, 0), 1);
    pts.push(new THREE.Vector3(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f));
    tans.push(new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize());
    ss.push(s);
  }
  // smooth tangents slightly so rings don't kink at fillet joins
  for (let i = 1; i < tans.length - 1; i++) {
    tans[i] = tans[i - 1].clone().add(tans[i].clone().multiplyScalar(2)).add(tans[i + 1]).normalize();
  }
  // parallel transport frames
  const normals: THREE.Vector3[] = [];
  const up = Math.abs(tans[0].y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  let n0 = new THREE.Vector3().crossVectors(tans[0], up).normalize();
  n0 = new THREE.Vector3().crossVectors(n0, tans[0]).normalize();
  normals.push(n0);
  for (let i = 1; i < tans.length; i++) {
    const axis = new THREE.Vector3().crossVectors(tans[i - 1], tans[i]);
    let n = normals[i - 1].clone();
    if (axis.length() > 1e-6) {
      axis.normalize();
      const ang = Math.acos(Math.min(1, Math.max(-1, tans[i - 1].dot(tans[i]))));
      n.applyAxisAngle(axis, ang);
    }
    normals.push(n);
  }
  const ring = radialSegs + 1;
  const pos = new Float32Array((steps + 1) * ring * 3);
  const nor = new Float32Array((steps + 1) * ring * 3);
  const uv = new Float32Array((steps + 1) * ring * 2);
  const aS = new Float32Array((steps + 1) * ring);
  const aT = new Float32Array((steps + 1) * ring);
  const col = colorFn ? new Float32Array((steps + 1) * ring * 3) : null;
  const idx: number[] = [];
  const v = new THREE.Vector3();
  const nn = new THREE.Vector3();
  const bin = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    bin.crossVectors(tans[i], normals[i]).normalize();
    for (let j = 0; j <= radialSegs; j++) {
      const th = (j / radialSegs) * Math.PI * 2;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      nn.copy(normals[i]).multiplyScalar(c).addScaledVector(bin, sn);
      const r = radiusFn ? radiusFn(ss[i], th) : radius;
      v.copy(pts[i]).addScaledVector(nn, r);
      const k = (i * ring + j) * 3;
      pos[k] = v.x;
      pos[k + 1] = v.y;
      pos[k + 2] = v.z;
      const sign = inside ? -1 : 1;
      nor[k] = nn.x * sign;
      nor[k + 1] = nn.y * sign;
      nor[k + 2] = nn.z * sign;
      uv[(i * ring + j) * 2] = ss[i] / L;
      uv[(i * ring + j) * 2 + 1] = j / radialSegs;
      aS[i * ring + j] = ss[i];
      aT[i * ring + j] = th;
      if (col && colorFn) {
        const c = colorFn(ss[i], th);
        col[(i * ring + j) * 3] = c[0];
        col[(i * ring + j) * 3 + 1] = c[1];
        col[(i * ring + j) * 3 + 2] = c[2];
      }
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const a = i * ring + j;
      const b = (i + 1) * ring + j;
      const c = (i + 1) * ring + j + 1;
      const d = i * ring + j + 1;
      if (inside) idx.push(a, d, b, d, c, b);
      else idx.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aS', new THREE.BufferAttribute(aS, 1));
  g.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  g.setIndex(idx);
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (radiusFn) g.computeVertexNormals();
  return g;
}

export const FLOW_VERT = /* glsl */ `
  attribute float aS;
  varying float vS;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vS = aS;
    vUv = uv;
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

export const FLOW_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uAlert;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uOcc;
  uniform float uOccS;
  uniform float uAlertAmt;
  uniform float uHi;
  uniform float uOpacity;
  uniform float uDim;
  varying float vS;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float s = vS - uTime * uSpeed;
    float ph = fract(s / 0.85);
    float streak = smoothstep(0.0, 0.1, ph) * (1.0 - smoothstep(0.1, 0.62, ph));
    vec3 n = normalize(vN);
    float fres = pow(1.0 - clamp(dot(n, normalize(vV)), 0.0, 1.0), 2.2);
    // jacketed-pipe shading: a soft key from above-left in view space gives the tube its cylinder form, instead of a flat emissive colour
    float diff = clamp(dot(n, normalize(vec3(-0.35, 0.8, 0.5))), 0.0, 1.0);
    float shade = 0.34 + 0.78 * diff;
    vec3 col = uColor * shade * (0.8 + 0.5 * streak) + uColor * fres * 0.22;
    float d = smoothstep(0.55, 0.0, abs(vS - uOccS) / 0.7);
    col = mix(col, vec3(0.30, 0.19, 0.10), d * uOcc * 0.85);
    col = mix(col, uAlert, uAlertAmt * (0.22 + 0.5 * fres));
    col += vec3(1.0) * uHi * 0.35 * (0.35 + fres);
    col *= uDim;
    gl_FragColor = vec4(col, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Build a ShaderMaterial that *owns* the given uniforms object.
 * (R3F ≥ 9.8 copies `uniforms` props into the material at mount, so per-frame numeric
 * mutations on your own object would never reach the GPU. Mutate `material.uniforms` instead.)
 */
export function makeShader(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, opts: THREE.ShaderMaterialParameters = {}) {
  return new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, ...opts });
}
