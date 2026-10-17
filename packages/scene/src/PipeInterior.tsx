import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { PipeEdge } from '@loopkeeper/core/contracts';
import { buildPath, clamp, samplePath, type Path } from '@loopkeeper/core';
import { samplePose, useWorld } from '@loopkeeper/core/store';
import { C } from './theme';
import { rigFor, sectionPlane } from './rig';
import { useView } from './view';
import { usePaths } from './Pipes';
import { useCockpit } from './cockpit';
import { buildTubeGeometry, makeShader } from './tube';

/**
 * Inside-pipe view. Pipes are small (DN100–DN150) and sealed: the only light in the bore is the
 * crawler's own LED ring and floodlight. Everything else falls to black.
 */

const STEEL: [number, number, number] = [0.2, 0.21, 0.235];
const RUST: [number, number, number] = [0.33, 0.17, 0.07];
const SCALE: [number, number, number] = [0.42, 0.34, 0.2];

function depositProfile(s: number, s0: number) {
  const x = (s - s0) / 0.42;
  return Math.exp(-x * x);
}
function noise(s: number, th: number) {
  return 0.5 + 0.28 * Math.sin(th * 3 + s * 9.1) + 0.22 * Math.sin(th * 7 - s * 17.3 + 1.7) + 0.12 * Math.sin(th * 13 + s * 31.0);
}

function Interior({ edge, path }: { edge: PipeEdge; path: Path }) {
  const rIn = edge.diameter_mm / 2000;
  const grp = useRef<THREE.Group>(null);
  const [occ, setOcc] = useState(0);
  const shown = useRef(0);
  const s0 = useWorld((s) => s.assets[edge.id]?.fault?.location_s_m ?? path.length * 0.5);

  // smooth the deposit changing (brush clear / replacement) instead of popping
  useFrame((_, dt) => {
    const v = useView.getState();
    if (grp.current) grp.current.visible = v.mode === 'pipe';
    if (v.mode !== 'pipe') return;
    const target = useWorld.getState().assets[edge.id]?.fault?.occlusion ?? 0;
    shown.current += (target - shown.current) * (1 - Math.exp(-dt * 2.2));
    if (Math.abs(shown.current - occ) > 0.012) setOcc(shown.current);
  });

  const geo = useMemo(
    () =>
      buildTubeGeometry(
        path,
        rIn,
        36,
        0.05,
        true,
        (s, th) => {
          const dep = occ * depositProfile(s, s0) * (0.55 + 0.45 * noise(s, th));
          return rIn * (1 - clamp(dep * 0.92, 0, 0.9));
        },
        (s, th) => {
          const dep = occ * depositProfile(s, s0) * (0.55 + 0.45 * noise(s, th));
          const m = clamp(dep * 2.3, 0, 1);
          const sc = clamp((dep - 0.3) * 2.0, 0, 1);
          const base: [number, number, number] = [STEEL[0] + 0.03 * Math.sin(s * 40 + th), STEEL[1], STEEL[2]];
          const rustC: [number, number, number] = [RUST[0] + (SCALE[0] - RUST[0]) * sc, RUST[1] + (SCALE[1] - RUST[1]) * sc, RUST[2] + (SCALE[2] - RUST[2]) * sc];
          return [base[0] + (rustC[0] - base[0]) * m, base[1] + (rustC[1] - base[1]) * m, base[2] + (rustC[2] - base[2]) * m];
        },
      ),
    [path, rIn, occ, s0],
  );
  useEffect(() => () => geo.dispose(), [geo]);

  // weld seams / flange joints every 1.5 m: visual odometry in the dark
  const rings = useMemo(() => {
    const list: Array<{ p: THREE.Vector3; q: THREE.Quaternion }> = [];
    for (let s = 1.5; s < path.length - 0.2; s += 1.5) {
      const { p, t } = samplePath(path, s);
      list.push({ p: new THREE.Vector3(...p), q: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...t)) });
    }
    return list;
  }, [path]);

  return (
    <group ref={grp} visible={false}>
      <mesh geometry={geo}>
        <meshStandardMaterial vertexColors roughness={0.7} metalness={0.35} side={THREE.DoubleSide} envMapIntensity={0} clippingPlanes={[sectionPlane]} />
      </mesh>
      {rings.map((r, i) => (
        <mesh key={i} position={r.p} quaternion={r.q}>
          <torusGeometry args={[rIn * 0.995, 0.0028, 6, 40]} />
          <meshStandardMaterial color="#6b727e" roughness={0.4} metalness={0.6} clippingPlanes={[sectionPlane]} />
        </mesh>
      ))}
    </group>
  );
}

/** Allocation-free point-on-path (the dust field samples this 500+ times a frame). */
function pathPoint(path: Path, s: number, out: [number, number, number]) {
  const { points, cum, length } = path;
  const ss = s < 0 ? 0 : s > length ? length : s;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= ss) lo = mid;
    else hi = mid;
  }
  const f = (ss - cum[lo]) / (cum[hi] - cum[lo] || 1e-9);
  const a = points[lo];
  const c = points[hi];
  out[0] = a[0] + (c[0] - a[0]) * f;
  out[1] = a[1] + (c[1] - a[1]) * f;
  out[2] = a[2] + (c[2] - a[2]) * f;
}

/* ───────────────────────────── lights + dust ───────────────────────────── */

const PARTS = 520;
const DUST_VERT = /* glsl */ `
  attribute float aSize;
  uniform vec3 uLightPos;
  uniform vec3 uLightDir;
  uniform float uScale;
  varying float vLit;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 toP = position - uLightPos;
    float d = length(toP);
    float cone = smoothstep(0.55, 0.92, dot(normalize(toP), normalize(uLightDir)));
    vLit = cone * (1.0 / (1.0 + d * d * 1.4)) + (1.0 / (1.0 + d * d * 90.0)) * 0.5;
    gl_PointSize = min(aSize * uScale / max(-mv.z, 0.02), 5.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const DUST_FRAG = /* glsl */ `
  varying float vLit;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.05, length(c));
    gl_FragColor = vec4(vec3(1.0, 0.93, 0.8) * (0.25 + 1.5 * vLit), a * clamp(vLit * 1.8, 0.0, 0.85));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** The active light source: a crawler (or a service probe) at a pose inside a pipe. */
function CrawlerLight() {
  const spot = useRef<THREE.SpotLight>(null);
  const spotTarget = useRef<THREE.Object3D>(null);
  const point = useRef<THREE.PointLight>(null);
  const tail = useRef<THREE.PointLight>(null);
  const fill = useRef<THREE.PointLight>(null);
  const dust = useRef<THREE.Points>(null);
  const uniforms = useMemo(() => ({ uLightPos: { value: new THREE.Vector3() }, uLightDir: { value: new THREE.Vector3(0, 0, 1) }, uScale: { value: 330 } }), []);
  const attr = useMemo(() => {
    const offs = new Float32Array(PARTS);
    const ang = new Float32Array(PARTS);
    const rad = new Float32Array(PARTS);
    const size = new Float32Array(PARTS);
    for (let i = 0; i < PARTS; i++) {
      offs[i] = Math.random() * 4.4 - 0.9;
      ang[i] = Math.random() * Math.PI * 2;
      rad[i] = Math.sqrt(Math.random());
      size[i] = 0.0011 + Math.random() * 0.0022;
    }
    return { offs, ang, rad, size };
  }, []);
  const dustMat = useMemo(() => makeShader(DUST_VERT, DUST_FRAG, uniforms, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), [uniforms]);
  const posAttr = useMemo(() => new THREE.BufferAttribute(new Float32Array(PARTS * 3), 3), []);
  const paths = usePaths();
  const time = useRef(0);
  const edges = useWorld((s) => s.edgesById);
  const ref = useRef({ s: 0, key: '' });
  const scratch = useMemo(() => ({ pos: new THREE.Vector3(), dir: new THREE.Vector3(), light: new THREE.Vector3(), up: new THREE.Vector3(), side: new THREE.Vector3(), n: new THREE.Vector3(), b: new THREE.Vector3(), pt: [0, 0, 0] as [number, number, number] }), []);

  useFrame((_, dt) => {
    const v = useView.getState();
    const on = v.mode === 'pipe' && !!v.pipeEdgeId;
    if (spot.current) spot.current.visible = on;
    if (point.current) point.current.visible = on;
    if (tail.current) tail.current.visible = on;
    if (fill.current) {
      const ck0 = useCockpit.getState();
      const cam0 = ck0.robotId ? ck0.cam : v.pipeCam === 'section' ? 'side' : 'nose';
      fill.current.visible = on && (cam0 === 'side' || cam0 === 'top');
    }
    if (dust.current) dust.current.visible = on;
    if (!on || !v.pipeEdgeId) return;
    const w = useWorld.getState();
    // the cockpit robot if one is selected, else a crawler inside this segment
    const ck = useCockpit.getState();
    const rider = ck.robotId ? w.robots[ck.robotId] : undefined;
    const edgeId = rider?.pose.segment_id && paths[rider.pose.segment_id] ? rider.pose.segment_id : v.pipeEdgeId;
    const path = paths[edgeId];
    const edge = edges[edgeId];
    if (!path || !edge) return;
    const crawler = rider?.class === 'inpipe' ? rider : ck.robotId ? undefined : (Object.values(w.robots).find((r) => r.class === 'inpipe' && r.pose.segment_id === edgeId && r.mode !== 'DOCKED') ?? (v.followRobotId ? w.robots[v.followRobotId] : undefined));
    const pos = scratch.pos;
    const dir = scratch.dir;
    dir.set(0, 0, 1);
    let sAlong = 0;
    let lampOn = true;
    if (crawler && crawler.class === 'inpipe' && (rider || crawler.pose.segment_id === edgeId)) {
      const st = rigFor(crawler.id);
      const sp = samplePose(crawler.id);
      if (sp) pos.set(sp.pos[0], sp.pos[1], sp.pos[2]);
      dir.copy(st.dir);
      sAlong = crawler.pose.s_m ?? 0;
      lampOn = crawler.control?.lamp !== false;
    } else {
      // service probe: parked just before the fault (or mid-segment), looking along the pipe
      const fault = w.assets[edgeId]?.fault?.location_s_m;
      const s = v.pipeProbeS ?? clamp((fault ?? path.length * 0.55) - 1.1, 0.2, path.length - 0.6);
      const sm = samplePath(path, s);
      pos.set(...sm.p);
      dir.set(...sm.t);
      sAlong = s;
    }
    // the rear camera looks backwards: the lamp follows the camera, as a real crawler's rear light would
    const rear = !!rider && ck.cam === 'rear';
    if (rear) dir.negate();
    ref.current.s = sAlong;
    const lightPos = scratch.light.copy(pos).addScaledVector(dir, 0.1);
    const k = lampOn ? 1 : 0;
    if (spot.current) spot.current.intensity = 0.55 * k;
    if (point.current) point.current.intensity = 0.075 * k + (lampOn ? 0 : 0.004);
    if (spot.current && spotTarget.current) {
      spot.current.position.copy(lightPos);
      spotTarget.current.position.copy(lightPos).addScaledVector(dir, 1);
      spot.current.target = spotTarget.current;
    }
    point.current?.position.copy(pos).addScaledVector(dir, 0.06);
    tail.current?.position.copy(pos).addScaledVector(dir, -0.14);
    if (fill.current) {
      scratch.up.set(Math.abs(dir.y) > 0.9 ? 1 : 0, Math.abs(dir.y) > 0.9 ? 0 : 1, 0);
      const side = scratch.side.crossVectors(dir, scratch.up).normalize();
      fill.current.position.copy(pos).addScaledVector(side, 0.3).addScaledVector(dir, 0.05);
    }
    uniforms.uLightPos.value.copy(lightPos);
    uniforms.uLightDir.value.copy(dir);
    // dust: re-laid out relative to the light each frame, drifting with the flow
    time.current += dt;
    const vel = clamp(w.assets[edgeId]?.readings.velocity_m_s ?? 0.5, 0.05, 2) * (edge.role === 'supply' ? 1 : 1);
    const rIn = edge.diameter_mm / 2000;
    const arr = posAttr.array as Float32Array;
    const n = scratch.n;
    const b = scratch.b;
    scratch.up.set(Math.abs(dir.y) > 0.9 ? 1 : 0, Math.abs(dir.y) > 0.9 ? 0 : 1, 0);
    n.crossVectors(dir, scratch.up).normalize();
    b.crossVectors(dir, n).normalize();
    for (let i = 0; i < PARTS; i++) {
      const adv = (attr.offs[i] + time.current * vel * 0.9 + 0.9) % 4.4;
      const s = clamp(sAlong - 0.9 + adv, 0, path.length);
      pathPoint(path, s, scratch.pt);
      const r = attr.rad[i] * rIn * 0.9;
      const a = attr.ang[i] + time.current * 0.05;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      arr[i * 3] = scratch.pt[0] + (n.x * ca + b.x * sa) * r;
      arr[i * 3 + 1] = scratch.pt[1] + (n.y * ca + b.y * sa) * r;
      arr[i * 3 + 2] = scratch.pt[2] + (n.z * ca + b.z * sa) * r;
    }
    posAttr.needsUpdate = true;
  });

  const sizeAttr = useMemo(() => new THREE.BufferAttribute(attr.size, 1), [attr]);
  return (
    <>
      <spotLight ref={spot} color="#ffe6c2" intensity={0.55} angle={0.95} penumbra={1} distance={6} decay={1.5} />
      <object3D ref={spotTarget} />
      <pointLight ref={point} color="#ffc27d" intensity={0.075} distance={3.2} decay={1.8} />
      <pointLight ref={tail} color="#ff5a3c" intensity={0.01} distance={0.4} decay={1.5} />
      <pointLight ref={fill} color="#bcd4ff" intensity={0.09} distance={1.1} decay={1.1} />
      <points ref={dust} frustumCulled={false} visible={false}>
        <bufferGeometry>
          <primitive object={posAttr} attach="attributes-position" />
          <primitive object={sizeAttr} attach="attributes-aSize" />
        </bufferGeometry>
        <primitive object={dustMat} attach="material" />
      </points>
    </>
  );
}

export function PipeInterior() {
  const topo = useWorld((s) => s.topology);
  const paths = usePaths();
  if (!topo) return null;
  return (
    <group name="pipe-interior">
      {topo.edges
        .filter((e) => e.robot_passable)
        .map((e) => (
          <Interior key={e.id} edge={e} path={paths[e.id]} />
        ))}
      <CrawlerLight />
    </group>
  );
}

export { buildPath, C };
