import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Asset } from '@loopkeeper/core/contracts';
import { useWorld } from '@loopkeeper/core/store';
import { clamp } from '@loopkeeper/core';
import { C, STATUS_COLOR, marginColor } from './theme';
import { useView } from './view';
import { useRelevanceSet } from './context';
import { filterIndex, useDashView } from './dashView';
import { box, mergeParts, xf } from './merge';
import { makeShader } from './tube';

/* ──────────────────────────────────────────────────────────────────────────────
 * All racks are ONE set of InstancedMeshes (body, front face, rear face, hardware, plume).
 * Per-rack state (thermal margin, load, status, relevance) rides in instanced attributes,
 * so adding racks adds no draw calls. Kind (GPU / network / storage / CPU) comes from the
 * topology's rack `spec.Role`.
 * ────────────────────────────────────────────────────────────────────────────── */

const ATTR = /* glsl */ `
  attribute float aHeat; attribute float aLive; attribute float aKind; attribute float aDim; attribute float aPlume;
  attribute vec3 aGlow; attribute vec3 aBeacon;
  varying float vHeat; varying float vLive; varying float vKind; varying float vDim; varying float vPlume;
  varying vec3 vGlow; varying vec3 vBeacon; varying vec2 vUv;
`;
const VERT = /* glsl */ `
  ${ATTR}
  void main(){
    vUv = uv; vHeat = aHeat; vLive = aLive; vKind = aKind; vDim = aDim; vPlume = aPlume; vGlow = aGlow; vBeacon = aBeacon;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;
const FRAG_HEAD = /* glsl */ `
  varying float vHeat; varying float vLive; varying float vKind; varying float vDim; varying float vPlume;
  varying vec3 vGlow; varying vec3 vBeacon; varying vec2 vUv;
  uniform float uTime; uniform float uPx; uniform float uThermal; uniform float uDimAll;
  float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float bx(vec2 p, vec2 c, vec2 hs){ vec2 d = abs(p - c) - hs; return 1.0 - step(0.0, max(d.x, d.y)); }
`;

const FRONT_FRAG = /* glsl */ `
  ${FRAG_HEAD}
  void main(){
    vec2 uv = vUv;
    float lod = smoothstep(14.0, 55.0, uPx);
    float U = uv.y * 42.0;
    float ur = floor(U);
    vec3 ledOk = vec3(0.16, 0.95, 0.58);
    float isLive = step(0.08, vLive);
    vec3 led = mix(ledOk, vGlow, vHeat) * isLive;
    vec3 equip = vec3(0.016, 0.018, 0.024);
    float kind = vKind;
    if (kind < 0.5) {
      // GPU: 4U liquid-cooled compute trays
      float ch = floor(ur / 4.0);
      float cf = fract(U / 4.0);
      float body = smoothstep(0.0, 0.06, cf) * (1.0 - smoothstep(0.92, 0.99, cf));
      equip = mix(vec3(0.018), vec3(0.13, 0.145, 0.18) + 0.015 * h21(vec2(ch, 3.0)), body);
      vec2 g = fract(vec2(uv.x * 34.0, cf * 9.0));
      float grille = step(0.1, uv.x) * step(uv.x, 0.5) * step(0.18, cf) * step(cf, 0.82);
      equip -= grille * step(0.3, g.x) * step(g.x, 0.7) * step(0.25, g.y) * step(g.y, 0.75) * 0.1;
      equip += bx(vec2(uv.x, cf), vec2(0.58, 0.5), vec2(0.012, 0.3)) * 0.12;
      float act = 0.0;
      for (int i = 0; i < 4; i++) {
        float cx = 0.70 + float(i) * 0.062;
        float on = bx(vec2(uv.x, cf), vec2(cx, 0.5), vec2(0.014, 0.16));
        float rnd = h21(vec2(ch * 7.0 + float(i), floor(uTime * (1.5 + vLive * 5.0) + ch * 3.1)));
        float a = step(1.0 - 0.3 - 0.65 * vLive, rnd) * vLive;
        equip += on * led * (0.2 + 1.1 * mix(0.55 * isLive, a, lod)) * isLive;
        act += on;
      }
      // coolant quick-connect tell-tales: supply (cyan) / return (amber) - active only when live
      equip += bx(vec2(uv.x, cf), vec2(0.17, 0.5), vec2(0.02, 0.05)) * vec3(0.1, 0.55, 0.65) * isLive;
      equip += bx(vec2(uv.x, cf), vec2(0.27, 0.5), vec2(0.02, 0.05)) * mix(vec3(0.7, 0.4, 0.12), vGlow, vHeat * 0.8) * isLive;
    } else if (kind < 1.5) {
      // network fabric: 1U switches with port arrays and cable managers
      float sw = step(0.5, fract(ur * 0.5));
      float uf = fract(U);
      equip = mix(vec3(0.018), vec3(0.11, 0.12, 0.15), smoothstep(0.0, 0.1, uf) * (1.0 - smoothstep(0.9, 1.0, uf)));
      float cell = (uv.x - 0.1) / 0.8 * 24.0;
      float pf = fract(cell);
      float port = step(0.12, uv.x) * step(uv.x, 0.9) * step(0.2, pf) * step(pf, 0.8) * step(0.3, uf) * step(uf, 0.7);
      float rnd = h21(vec2(floor(cell), ur + floor(uTime * (1.0 + 4.0 * vLive))));
      float on = step(0.35 - 0.2 * vLive, rnd) * vLive;
      vec3 portC = mix(vec3(0.05, 0.07, 0.08), led * 1.2, mix(0.6 * isLive, on, lod) * isLive);
      equip = mix(equip, portC, port * sw);
      float cm = (1.0 - sw);
      vec3 cab = vec3(0.1) + 0.5 * vec3(h21(vec2(floor(uv.x * 30.0), ur)), h21(vec2(floor(uv.x * 30.0), ur + 7.0)), 0.3) * step(0.15, uv.x) * step(uv.x, 0.85);
      equip = mix(equip, cab * (0.2 + 0.3 * isLive), cm * step(0.2, uf) * step(uf, 0.8));
    } else if (kind < 2.5) {
      // storage: 2U drive trays, 12 bays each
      float tr = floor(ur / 2.0);
      float cf = fract(U / 2.0);
      equip = mix(vec3(0.018), vec3(0.12, 0.13, 0.16), smoothstep(0.0, 0.06, cf) * (1.0 - smoothstep(0.93, 1.0, cf)));
      float bayX = (uv.x - 0.08) / 0.84 * 12.0;
      float bf = fract(bayX);
      float bay = step(0.08, uv.x) * step(uv.x, 0.92) * step(0.1, bf) * step(bf, 0.9) * step(0.2, cf) * step(cf, 0.82);
      equip = mix(equip, vec3(0.045, 0.05, 0.062), bay);
      float rnd = h21(vec2(floor(bayX), tr + floor(uTime * (0.8 + 3.0 * vLive))));
      float act = step(0.55 - 0.3 * vLive, rnd) * vLive;
      float lamp = step(0.08, uv.x) * step(uv.x, 0.92) * step(0.3, bf) * step(bf, 0.7) * step(0.72, cf) * step(cf, 0.82);
      equip += lamp * mix(vec3(0.2, 0.5, 1.0), led, vHeat) * (0.2 * isLive + 1.0 * mix(0.5 * isLive, act, lod)) * isLive;
    } else {
      // CPU / inference: 2U servers with perforated bezels
      float tr = floor(ur / 2.0);
      float cf = fract(U / 2.0);
      equip = mix(vec3(0.018), vec3(0.12, 0.125, 0.15), smoothstep(0.0, 0.06, cf) * (1.0 - smoothstep(0.93, 1.0, cf)));
      vec2 g = fract(vec2(uv.x * 40.0, cf * 12.0));
      float pf = step(0.12, uv.x) * step(uv.x, 0.66) * step(0.2, cf) * step(cf, 0.8) * step(g.x, 0.6) * step(g.y, 0.6);
      equip -= pf * 0.07;
      float rnd = h21(vec2(tr, floor(uTime * (1.0 + 3.0 * vLive))));
      equip += bx(vec2(uv.x, cf), vec2(0.8, 0.5), vec2(0.015, 0.1)) * led * (0.2 * isLive + 1.0 * mix(0.6 * isLive, step(0.4 - 0.2 * vLive, rnd) * vLive, lod)) * isLive;
      equip += bx(vec2(uv.x, cf), vec2(0.88, 0.5), vec2(0.015, 0.1)) * vec3(0.06, 0.07, 0.09) * 2.0;
    }
    // ── door ──
    float hero = 1.0 - step(0.5, kind);
    vec3 steel = vec3(0.075, 0.082, 0.1) + 0.03 * smoothstep(0.0, 1.0, uv.y);
    // hex-ish perforation (fades to its mean coverage when too small to resolve)
    vec2 pg = vec2(uv.x * 0.96 / 0.024, uv.y * 2.24 / 0.0208);
    pg.x += 0.5 * mod(floor(pg.y), 2.0);
    vec2 pfv = fract(pg) - 0.5;
    float hole = 1.0 - smoothstep(0.26, 0.38, length(pfv));
    hole = mix(0.4, hole, lod);
    vec3 door = mix(steel, equip * 1.15 + 0.01, hole);
    float streak = smoothstep(0.015, 0.0, abs(fract(uv.x * 0.9 + uv.y * 0.35) - 0.5) - 0.46);
    vec3 glass = equip * 0.78 + vec3(0.012, 0.018, 0.026) + streak * 0.035;
    vec3 col = mix(door, glass, hero);
    // frame, handle, hinge knuckles
    float frame = 1.0 - step(0.045, uv.x) * step(uv.x, 0.955) * step(0.016, uv.y) * step(uv.y, 0.988);
    col = mix(col, vec3(0.16, 0.175, 0.21), frame);
    col += bx(uv, vec2(0.9, 0.5), vec2(0.012, 0.09)) * vec3(0.3, 0.32, 0.36);
    col += bx(uv, vec2(0.075, 0.25), vec2(0.008, 0.012)) * 0.2 + bx(uv, vec2(0.075, 0.5), vec2(0.008, 0.012)) * 0.2 + bx(uv, vec2(0.075, 0.75), vec2(0.008, 0.012)) * 0.2;
    // status beacon (top) and liquid-ready tell-tales
    col = mix(col, vBeacon * 1.5, bx(uv, vec2(0.5, 0.968), vec2(0.2, 0.011)));
    col = mix(col, vec3(0.18, 0.83, 0.91) * isLive, bx(uv, vec2(0.12, 0.955), vec2(0.018, 0.008)));
    col = mix(col, vec3(1.0, 0.6, 0.24) * isLive, bx(uv, vec2(0.88, 0.955), vec2(0.018, 0.008)));
    // thermal view: tint every face by thermal margin
    col = mix(col, vGlow * 0.62 + col * 0.35, uThermal * (0.28 + 0.55 * vHeat));
    float rim = smoothstep(0.0, 0.02, uv.y) * smoothstep(1.0, 0.98, uv.y);
    col *= (0.7 + 0.3 * rim);
    gl_FragColor = vec4(col * vDim * uDimAll, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const REAR_FRAG = /* glsl */ `
  ${FRAG_HEAD}
  void main(){
    vec2 uv = vUv;
    float isLive = step(0.08, vLive);
    vec3 col = vec3(0.075, 0.083, 0.102) + 0.014 * sin(uv.y * 150.0);
    float sup = smoothstep(0.075, 0.06, abs(uv.x - 0.29));
    float ret = smoothstep(0.075, 0.06, abs(uv.x - 0.71));
    float flow = (0.62 + 0.38 * sin(uv.y * 26.0 - uTime * 2.2)) * isLive;
    vec3 supC = vec3(0.18, 0.83, 0.91) * flow;
    vec3 retC = mix(vec3(1.0, 0.6, 0.24), vec3(1.0, 0.28, 0.2), vHeat) * (flow * 0.8 + 0.2 * vHeat * isLive);
    col = mix(col, supC, sup * 0.8);
    col = mix(col, retC, ret * 0.8);
    float conn = step(0.9, fract(uv.y * 6.0));
    col += (sup + ret) * conn * (0.1 + 0.25 * isLive);
    col += step(abs(uv.x - 0.5), 0.003) * 0.05;
    float pdu = step(abs(uv.x - 0.93), 0.014) + step(abs(uv.x - 0.07), 0.014);
    col += pdu * vec3(0.09, 0.1, 0.12);
    col += step(0.96, fract(uv.y * 11.0)) * step(0.1, uv.x) * step(uv.x, 0.9) * 0.035;
    col = mix(col, vGlow * 0.6 + col * 0.35, uThermal * (0.25 + 0.5 * vHeat));
    gl_FragColor = vec4(col * vDim * uDimAll, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const PLUME_FRAG = /* glsl */ `
  ${FRAG_HEAD}
  void main(){
    float fade = pow(1.0 - vUv.y, 1.6);
    float wob = 0.75 + 0.25 * sin(vUv.x * 9.0 + uTime * 1.6 + vUv.y * 5.0);
    float edge = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
    gl_FragColor = vec4(vGlow * 1.2, fade * edge * wob * vPlume);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const KIND: Record<string, number> = { 'GPU training': 0, 'Network fabric': 1, Storage: 2, 'CPU / inference': 3 };
const _c = new THREE.Color();
const _t = new THREE.Vector3();

export function rackKind(a: Asset) {
  return KIND[a.spec?.Role ?? ''] ?? 0;
}

/** hardware that never changes: top cap, corner posts, door handle standoffs, rear hose bars */
function hardwareGeo(w: number, h: number, d: number) {
  const parts: Array<{ geo: THREE.BufferGeometry; m?: THREE.Matrix4 }> = [{ geo: box(w + 0.03, 0.04, d + 0.03), m: xf(0, h + 0.02, 0) }];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push({ geo: box(0.035, h, 0.035), m: xf(sx * (w / 2), h / 2, sz * (d / 2)) });
  // handle standoff + bar on the door
  parts.push({ geo: box(0.02, 0.4, 0.022), m: xf(w * 0.4, h * 0.5, d / 2 + 0.016) });
  // top-of-rack busway tap box and coolant manifold bars along the rear
  parts.push({ geo: box(0.7, 0.05, 0.1), m: xf(0, h + 0.065, -d * 0.35) });
  parts.push({ geo: box(0.05, h * 0.92, 0.05), m: xf(-0.2, h * 0.5, -d / 2 - 0.03) });
  parts.push({ geo: box(0.05, h * 0.92, 0.05), m: xf(0.2, h * 0.5, -d / 2 - 0.03) });
  return mergeParts(parts);
}

export function Racks() {
  const topo = useWorld((s) => s.topology);
  const racks = useMemo(() => topo?.assets.filter((a) => a.type === 'rack') ?? [], [topo]);
  const contextCabinets = useMemo(() => (topo as any)?.context_cabinets ?? [], [topo]);
  if (!racks.length && !contextCabinets.length) return null;
  return (
    <>
      {racks.length > 0 && <RackSet racks={racks} />}
      {contextCabinets.length > 0 && <ContextCabinetSet cabinets={contextCabinets} />}
    </>
  );
}


function RackSet({ racks }: { racks: Asset[] }) {
  const n = racks.length;
  const [w, h, d] = racks[0].size_m!;
  const lim = useWorld((s) => s.topology?.limits);
  const hall = useDashView((s) => s.structure.hall);
  const rowsOn = useView((s) => s.layers.rows);
  const relSet = useRelevanceSet();
  const relRef = useRef(relSet);
  relRef.current = relSet;

  const rt = useMemo(() => {
    const mk = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(n * size), size).setUsage(THREE.DynamicDrawUsage);
    const attrs = { aHeat: mk(1), aLive: mk(1), aKind: mk(1), aDim: mk(1), aPlume: mk(1), aGlow: mk(3), aBeacon: mk(3) };
    racks.forEach((r, i) => {
      attrs.aKind.setX(i, rackKind(r));
      attrs.aLive.setX(i, 1);
      attrs.aDim.setX(i, 1);
      attrs.aGlow.setXYZ(i, 0.25, 0.84, 0.64);
      attrs.aBeacon.setXYZ(i, 0.25, 0.84, 0.64);
    });
    const withAttrs = (g: THREE.BufferGeometry) => {
      for (const [k, a] of Object.entries(attrs)) g.setAttribute(k, a);
      return g;
    };
    const frontGeo = withAttrs(new THREE.PlaneGeometry(w - 0.04, h - 0.06).translate(0, h / 2, d / 2 + 0.003));
    const rearGeo = withAttrs(new THREE.PlaneGeometry(w - 0.04, h - 0.06).rotateY(Math.PI).translate(0, h / 2, -d / 2 - 0.003));
    const plumeGeo = withAttrs(new THREE.PlaneGeometry(w * 1.6, 1.8).translate(0, h + 0.9, 0));
    const uni = () => ({ uTime: { value: 0 }, uPx: { value: 50 }, uThermal: { value: 0 }, uDimAll: { value: 1 } });
    const shared = uni();
    return {
      attrs,
      bodyGeo: box(w, h, d).translate(0, h / 2, 0),
      hwGeo: hardwareGeo(w, h, d),
      frontGeo,
      rearGeo,
      plumeGeo,
      u: shared,
      frontMat: makeShader(VERT, FRONT_FRAG, shared),
      rearMat: makeShader(VERT, REAR_FRAG, shared),
      plumeMat: makeShader(VERT, PLUME_FRAG, shared, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      cur: racks.map(() => ({ heat: 0, dim: 1, plume: 0, live: 1, margin: -999, status: '' })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);
  useEffect(
    () => () => {
      rt.bodyGeo.dispose();
      rt.hwGeo.dispose();
      rt.frontGeo.dispose();
      rt.rearGeo.dispose();
      rt.plumeGeo.dispose();
      rt.frontMat.dispose();
      rt.rearMat.dispose();
      rt.plumeMat.dispose();
    },
    [rt],
  );

  const body = useRef<THREE.InstancedMesh>(null);
  const hw = useRef<THREE.InstancedMesh>(null);
  const front = useRef<THREE.InstancedMesh>(null);
  const rear = useRef<THREE.InstancedMesh>(null);
  const plume = useRef<THREE.InstancedMesh>(null);
  const bodyMat = useRef<THREE.MeshStandardMaterial>(null);
  const hwMat = useRef<THREE.MeshStandardMaterial>(null);

  useEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    racks.forEach((r, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.yaw_rad ?? 0);
      p.set(r.position_xyz_m[0], r.position_xyz_m[1], r.position_xyz_m[2]);
      m.compose(p, q, one);
      for (const ref of [body, hw, front, rear, plume]) ref.current?.setMatrixAt(i, m);
    });
    for (const ref of [body, hw, front, rear, plume]) {
      if (ref.current) {
        ref.current.instanceMatrix.needsUpdate = true;
        ref.current.computeBoundingSphere();
        ref.current.computeBoundingBox();
      }
    }
  }, [racks, n]);

  const px = useRef(50);
  useFrame((state, dt) => {
    const v = useView.getState();
    const dv = useDashView.getState();
    const world = useWorld.getState();
    const warn = lim?.margin_warn_k ?? 11;
    const crit = lim?.margin_crit_k ?? 5;
    const f = filterIndex(dv.filter);
    const k = 1 - Math.exp(-dt * 4);
    const xray = v.xray;
    const pipeMode = v.mode === 'pipe';
    // global transparency in x-ray / pipe mode
    const globalDim = pipeMode ? 0.12 : xray ? 0.2 : 1;
    const loopsDim = f === 1 ? 0.42 : f === 2 ? 0.3 : f === 4 ? 0.4 : 1; // filters push racks back so the focus layer reads
    rt.u.uTime.value = state.clock.elapsedTime;
    rt.u.uThermal.value += ((f === 3 ? 1 : 0) - rt.u.uThermal.value) * k;
    // pixels per metre at the focus distance → perforation / blade detail LOD
    const cam = state.camera as THREE.PerspectiveCamera;
    _t.set(v.cam.target[0], v.cam.target[1], v.cam.target[2]);
    const pxm = state.size.height / (2 * Math.max(cam.position.distanceTo(_t), 1) * Math.tan((cam.fov * Math.PI) / 360));
    px.current += (pxm - px.current) * 0.1;
    rt.u.uPx.value = px.current;
    rt.u.uDimAll.value = (pipeMode ? 0.12 : xray ? 0.3 : 1) * loopsDim;
    let anyPlume = false;
    const A = rt.attrs;
    for (let i = 0; i < racks.length; i++) {
      const r = racks[i];
      const a = world.assets[r.id];
      const margin = a?.readings.margin_k ?? 40;
      const heatT = clamp((warn + 7 - margin) / (warn + 7 - crit), 0, 1);
      const cu = rt.cur[i];
      cu.heat += (heatT - cu.heat) * k;
      const rel = relRef.current === null ? 1 : relRef.current.has(r.id) ? 1 : 0.2;
      cu.dim += (rel - cu.dim) * k;
      const iso = a?.status === 'isolated';
      const design = Number(String(r.spec?.['Design load'] ?? '').replace(/[^0-9.]/g, '')) || 120;
      const loadFrac = iso ? 0 : clamp((a?.readings.power_kw ?? design) / design, 0, 1.3);
      cu.live += (loadFrac - cu.live) * k;
      const plumeT = v.layers.thermal && !xray && v.mode === 'facility' ? clamp(heatT * 1.25 - 0.12, 0, 1) : 0;
      cu.plume += (plumeT - cu.plume) * k;
      if (cu.plume > 0.02) anyPlume = true;
      const heat = v.layers.thermal ? cu.heat : 0;
      A.aHeat.setX(i, heat);
      A.aLive.setX(i, clamp(cu.live, 0, 1));
      A.aDim.setX(i, cu.dim);
      A.aPlume.setX(i, cu.plume * 0.85);
      // colours only change when the reading does — avoid per-frame string work
      if (Math.abs(margin - cu.margin) > 0.05) {
        cu.margin = margin;
        _c.set(marginColor(margin, warn, crit));
        A.aGlow.setXYZ(i, _c.r, _c.g, _c.b);
      }
      const st = a?.status ?? 'nominal';
      if (st !== cu.status) {
        cu.status = st;
        _c.set(STATUS_COLOR[st] ?? C.nominal);
        A.aBeacon.setXYZ(i, _c.r, _c.g, _c.b);
      }
    }
    for (const at of Object.values(A)) at.needsUpdate = true;
    if (plume.current) plume.current.visible = anyPlume;
    const mat = bodyMat.current;
    if (mat) {
      mat.opacity = globalDim;
      mat.transparent = globalDim < 0.98;
    }
    if (hwMat.current) {
      hwMat.current.opacity = globalDim;
      hwMat.current.transparent = globalDim < 0.98;
    }
  });

  const noRay = () => null;
  const idOf = (e: { instanceId?: number }) => (e.instanceId !== undefined ? racks[e.instanceId]?.id : undefined);
  return (
    <group name="racks" visible={hall && rowsOn}>
      <instancedMesh
        ref={body}
        args={[rt.bodyGeo, undefined, n]}
        castShadow
        receiveShadow
        onPointerOver={(e) => {
          e.stopPropagation();
          const id = idOf(e as never);
          if (id) useView.getState().hover(id);
          if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
        }}
        onPointerMove={(e) => {
          const id = idOf(e as never);
          if (id && useView.getState().hoverId !== id) useView.getState().hover(id);
        }}
        onPointerOut={() => {
          useView.getState().hover(null);
          if (typeof document !== 'undefined') document.body.style.cursor = '';
        }}
        onClick={(e) => {
          e.stopPropagation();
          const id = idOf(e as never);
          if (id) useView.getState().select(id);
        }}
      >
        <meshStandardMaterial ref={bodyMat} color={C.graphite} roughness={0.5} metalness={0.55} />
      </instancedMesh>
      <instancedMesh ref={hw} args={[rt.hwGeo, undefined, n]} castShadow raycast={noRay}>
        <meshStandardMaterial ref={hwMat} color="#3a424e" roughness={0.38} metalness={0.8} />
      </instancedMesh>
      <instancedMesh ref={front} args={[rt.frontGeo, rt.frontMat, n]} raycast={noRay} frustumCulled={false} />
      <instancedMesh ref={rear} args={[rt.rearGeo, rt.rearMat, n]} raycast={noRay} frustumCulled={false} />
      <instancedMesh ref={plume} args={[rt.plumeGeo, rt.plumeMat, n]} raycast={noRay} renderOrder={5} frustumCulled={false} />
    </group>
  );
}

interface ContextCabinet {
  id: string;
  type: string;
  row_id?: string;
  hall_id?: string;
  slot?: number;
  position_xyz_m: [number, number, number];
  size_m?: [number, number, number];
  yaw_rad?: number;
  fidelity?: string;
}

function ContextCabinetSet({ cabinets }: { cabinets: ContextCabinet[] }) {
  const n = cabinets.length;
  const [w, h, d] = cabinets[0]?.size_m ?? [0.6, 2.2, 1.2];
  const hall = useDashView((s) => s.structure.hall);
  const rowsOn = useView((s) => s.layers.rows);

  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const hwRef = useRef<THREE.InstancedMesh>(null);
  const frontRef = useRef<THREE.InstancedMesh>(null);
  const rearRef = useRef<THREE.InstancedMesh>(null);
  const bodyMat = useRef<THREE.MeshStandardMaterial>(null);
  const hwMat = useRef<THREE.MeshStandardMaterial>(null);

  const rt = useMemo(() => {
    const mk = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(n * size), size).setUsage(THREE.DynamicDrawUsage);
    const attrs = { aHeat: mk(1), aLive: mk(1), aKind: mk(1), aDim: mk(1), aPlume: mk(1), aGlow: mk(3), aBeacon: mk(3) };
    cabinets.forEach((c, i) => {
      const slot = c.slot ?? (i % 24) + 1;
      const row = c.row_id ?? '';
      const isLiquidPodRow = row.includes('a1') || row.includes('b1');

      // Realistic allocation across rows:
      // ~62% active loaded units, ~26% cold/dormant standby, ~12% service/maintenance
      let live = 0.0;
      let heat = 0.02;
      let beacon: [number, number, number] = [0.04, 0.16, 0.20]; // idle standby dim sleep beacon
      let glow: [number, number, number] = [0.06, 0.18, 0.22];
      let kind = slot % 3 === 0 ? 3 : slot % 3 === 1 ? 2 : 1;

      if (isLiquidPodRow) {
        // AI pod row continuation (slots 9-24)
        if (slot >= 9 && slot <= 14) {
          // Active high-density compute cluster
          kind = 3;
          live = 0.82 + ((slot * 7) % 15) / 100;
          heat = 0.22;
          beacon = [0.18, 0.94, 0.62]; // bright active emerald
          glow = [0.18, 0.85, 0.65];
        } else if (slot === 15 || slot === 16) {
          // High-throughput spine switches
          kind = 1;
          live = 0.92;
          heat = 0.16;
          beacon = [0.16, 0.82, 0.96]; // active cyan
          glow = [0.15, 0.75, 0.90];
        } else if (slot === 17 || slot === 18) {
          // Cold standby pods (unpowered reserve) - INACTIVE!
          kind = 3;
          live = 0.0;
          heat = 0.01;
          beacon = [0.03, 0.12, 0.16];
          glow = [0.04, 0.12, 0.16];
        } else if (slot >= 19 && slot <= 21) {
          // Active storage array
          kind = 2;
          live = 0.75 + ((slot * 11) % 12) / 100;
          heat = 0.14;
          beacon = [0.20, 0.88, 0.60];
          glow = [0.18, 0.80, 0.60];
        } else if (slot === 22) {
          // Maintenance hold - INACTIVE / SERVICE!
          kind = 1;
          live = 0.0;
          heat = 0.03;
          beacon = [0.95, 0.58, 0.12]; // amber service beacon
          glow = [0.85, 0.48, 0.10];
        } else {
          // Active general inference
          kind = 3;
          live = 0.78;
          heat = 0.18;
          beacon = [0.18, 0.90, 0.62];
          glow = [0.18, 0.82, 0.64];
        }
      } else {
        // General compute & storage rows (row_a2, row_b2, slots 1-24)
        if (slot >= 1 && slot <= 6) {
          // Active general compute
          kind = 3;
          live = 0.76 + ((slot * 9) % 18) / 100;
          heat = 0.18;
          beacon = [0.18, 0.90, 0.62];
          glow = [0.18, 0.82, 0.64];
        } else if (slot === 7 || slot === 8) {
          // Unallocated / powered-down cold reserve - INACTIVE!
          kind = 2;
          live = 0.0;
          heat = 0.01;
          beacon = [0.03, 0.12, 0.16];
          glow = [0.04, 0.12, 0.16];
        } else if (slot >= 9 && slot <= 13) {
          // Active storage cluster
          kind = 2;
          live = 0.70 + ((slot * 13) % 15) / 100;
          heat = 0.15;
          beacon = [0.18, 0.86, 0.62];
          glow = [0.18, 0.80, 0.60];
        } else if (slot === 14 || slot === 15) {
          // Standby storage nodes - INACTIVE!
          kind = 2;
          live = 0.0;
          heat = 0.01;
          beacon = [0.03, 0.12, 0.16];
          glow = [0.04, 0.12, 0.16];
        } else if (slot === 16) {
          // Scheduled firmware maintenance - INACTIVE / SERVICE!
          kind = 3;
          live = 0.0;
          heat = 0.02;
          beacon = [0.95, 0.58, 0.12]; // amber service beacon
          glow = [0.85, 0.48, 0.10];
        } else if (slot >= 17 && slot <= 22) {
          // Active compute & leaf switches
          kind = slot % 2 === 0 ? 3 : 1;
          live = 0.80 + ((slot * 5) % 15) / 100;
          heat = 0.19;
          beacon = [0.18, 0.92, 0.64];
          glow = [0.18, 0.85, 0.65];
        } else {
          // Idle expansion slots - INACTIVE!
          kind = 3;
          live = 0.0;
          heat = 0.01;
          beacon = [0.03, 0.12, 0.16];
          glow = [0.04, 0.12, 0.16];
        }
      }

      attrs.aKind.setX(i, kind);
      attrs.aLive.setX(i, live);
      attrs.aDim.setX(i, 0.95);
      attrs.aHeat.setX(i, heat);
      attrs.aPlume.setX(i, 0);
      attrs.aGlow.setXYZ(i, glow[0], glow[1], glow[2]);
      attrs.aBeacon.setXYZ(i, beacon[0], beacon[1], beacon[2]);
    });
    const withAttrs = (g: THREE.BufferGeometry) => {
      for (const [key, a] of Object.entries(attrs)) g.setAttribute(key, a);
      return g;
    };
    const frontGeo = withAttrs(new THREE.PlaneGeometry(w - 0.04, h - 0.06).translate(0, h / 2, d / 2 + 0.003));
    const rearGeo = withAttrs(new THREE.PlaneGeometry(w - 0.04, h - 0.06).rotateY(Math.PI).translate(0, h / 2, -d / 2 - 0.003));
    const shared = { uTime: { value: 0 }, uPx: { value: 50 }, uThermal: { value: 0 }, uDimAll: { value: 1 } };
    return {
      attrs,
      bodyGeo: box(w, h, d).translate(0, h / 2, 0),
      hwGeo: hardwareGeo(w, h, d),
      frontGeo,
      rearGeo,
      u: shared,
      frontMat: makeShader(VERT, FRONT_FRAG, shared),
      rearMat: makeShader(VERT, REAR_FRAG, shared),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, w, h, d]);

  useEffect(
    () => () => {
      rt.bodyGeo.dispose();
      rt.hwGeo.dispose();
      rt.frontGeo.dispose();
      rt.rearGeo.dispose();
      rt.frontMat.dispose();
      rt.rearMat.dispose();
    },
    [rt],
  );

  useEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    cabinets.forEach((c, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.yaw_rad ?? 0);
      p.set(c.position_xyz_m[0], c.position_xyz_m[1], c.position_xyz_m[2]);
      m.compose(p, q, one);
      bodyRef.current?.setMatrixAt(i, m);
      hwRef.current?.setMatrixAt(i, m);
      frontRef.current?.setMatrixAt(i, m);
      rearRef.current?.setMatrixAt(i, m);
    });
    if (bodyRef.current) {
      bodyRef.current.instanceMatrix.needsUpdate = true;
      bodyRef.current.computeBoundingSphere();
      bodyRef.current.computeBoundingBox();
    }
    if (hwRef.current) hwRef.current.instanceMatrix.needsUpdate = true;
    if (frontRef.current) frontRef.current.instanceMatrix.needsUpdate = true;
    if (rearRef.current) rearRef.current.instanceMatrix.needsUpdate = true;
  }, [cabinets, n]);

  useFrame((state, dt) => {
    const v = useView.getState();
    const xray = v.xray;
    const pipeMode = v.mode === 'pipe';
    const globalDim = pipeMode ? 0.08 : xray ? 0.15 : 0.85;
    rt.u.uTime.value = state.clock.elapsedTime;
    rt.u.uDimAll.value = globalDim;
    if (bodyMat.current) {
      bodyMat.current.opacity += (globalDim - bodyMat.current.opacity) * (1 - Math.exp(-dt * 4));
      bodyMat.current.transparent = bodyMat.current.opacity < 0.98;
    }
    if (hwMat.current) {
      hwMat.current.opacity = bodyMat.current?.opacity ?? globalDim;
      hwMat.current.transparent = hwMat.current.opacity < 0.98;
    }
  });

  const noRay = () => null;
  const idOf = (e: { instanceId?: number }) => (e.instanceId !== undefined ? cabinets[e.instanceId]?.id : undefined);

  return (
    <group name="context_cabinets" visible={hall && rowsOn}>
      <instancedMesh
        ref={bodyRef}
        args={[rt.bodyGeo, undefined, n]}
        castShadow
        receiveShadow
        onPointerOver={(e) => {
          e.stopPropagation();
          const id = idOf(e as never);
          if (id) useView.getState().hover(id);
          if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          useView.getState().hover(null);
          if (typeof document !== 'undefined') document.body.style.cursor = '';
        }}
        onClick={(e) => {
          e.stopPropagation();
          const id = idOf(e as never);
          if (id) useView.getState().select(id);
        }}
      >
        <meshStandardMaterial ref={bodyMat} color={C.graphite} roughness={0.55} metalness={0.5} />
      </instancedMesh>
      <instancedMesh ref={hwRef} args={[rt.hwGeo, undefined, n]} castShadow raycast={noRay}>
        <meshStandardMaterial ref={hwMat} color="#343c48" roughness={0.4} metalness={0.75} />
      </instancedMesh>
      <instancedMesh ref={frontRef} args={[rt.frontGeo, rt.frontMat, n]} raycast={noRay} frustumCulled={false} />
      <instancedMesh ref={rearRef} args={[rt.rearGeo, rt.rearMat, n]} raycast={noRay} frustumCulled={false} />
    </group>
  );
}

