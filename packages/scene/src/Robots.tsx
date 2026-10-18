import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import type { Robot } from '@loopkeeper/core/contracts';
import { samplePose, useWorld } from '@loopkeeper/core/store';
import { clamp, samplePath } from '@loopkeeper/core';
import { C } from './theme';
import { Brackets } from './Select';
import { rigFor } from './rig';
import { useView } from './view';
import { useRelevanceSet } from './context';
import { buildTubeGeometry } from './tube';
import { buildPath } from '@loopkeeper/core';
import { cachedPaths } from './geomCache';
import { RobotTrail } from './Trail';
import { crawlerArms, crawlerKit, markerGeo, outrigKit } from './robotKit';
import type { ArmPartKit } from './robotKit';
import { ARM_DIMS, ArmInterp, PART, REST_JOINTS, armFK, armLod, armRigFor, clampJoints, makePartMatrices, readManipulator } from './armKinematics';
import type { ArmLod } from './armKinematics';
import { GhostRobotOverlay } from './GhostRobotOverlay';

/**
 * Fleet rendering. Geometry and materials are pooled (robotKit.ts); every robot is driven by direct transform
 * writes inside useFrame (no React state per frame):
 *  - INPIPE close-up model: 5 pooled meshes per crawler, only while the camera is within 7 m (or inside a bore)
 *  - OUTRIG: ~12 InstancedMeshes for the WHOLE class, whatever the robot count
 *  - overview locator markers: 4 InstancedMeshes for the whole fleet, instance-id picking
 */

const FWD = new THREE.Vector3(0, 0, 1);
const Y = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _a = new THREE.Matrix4();
const _b = new THREE.Matrix4();
const _c = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _col = new THREE.Color();

const T = (x: number, y: number, z: number) => _a.makeTranslation(x, y, z);

/* ───────────────────────────── INPIPE crawler (close-up) ───────────────────────────── */

function Crawler({ robot }: { robot: Robot }) {
  const kit = useMemo(() => crawlerKit(), []);
  const root = useRef<THREE.Group>(null);
  const model = useRef<THREE.Group>(null);
  const arms = useRef<THREE.Mesh>(null);
  const led = useRef<THREE.Mesh>(null);
  const status = useRef<THREE.Mesh>(null);
  const brush = useRef<THREE.Mesh>(null);
  const { camera } = useThree();
  const prev = useRef(new THREE.Vector3());
  const dirS = useRef(new THREE.Vector3(0, 0, 1));
  const tgt = useRef(new THREE.Vector3());
  const qTmp = useRef(new THREE.Quaternion());
  const armKey = useRef(-1);
  const edges = useWorld((s) => s.edgesById);

  useFrame((state, dt) => {
    const w = useWorld.getState();
    const r = w.robots[robot.id] ?? robot;
    const sp = samplePose(robot.id);
    if (!sp || !root.current) return;
    const st = rigFor(robot.id);
    root.current.position.set(sp.pos[0], sp.pos[1], sp.pos[2]);
    // heading: the server's nose direction when it sends one (a reversing crawler keeps facing forward);
    // otherwise derived from motion, holding the last heading when stationary
    if (sp.dir) {
      tgt.current.set(sp.dir[0], sp.dir[1], sp.dir[2]);
      if (prev.current.lengthSq() === 0) dirS.current.copy(tgt.current);
      else dirS.current.lerp(tgt.current, 1 - Math.exp(-dt * 14)).normalize();
    } else {
      tgt.current.set(sp.pos[0] - prev.current.x, sp.pos[1] - prev.current.y, sp.pos[2] - prev.current.z);
      if (tgt.current.length() > 0.0004) dirS.current.lerp(tgt.current.normalize(), 1 - Math.exp(-dt * 10)).normalize();
      else if (prev.current.lengthSq() === 0) {
        // first sight / parked: the pipe centerline tangent gives the true 3-D (pitched) nose, signed by the server yaw
        const topo = w.topology;
        const path = topo && sp.seg ? cachedPaths(topo)[sp.seg] : undefined;
        if (path && sp.s !== undefined) {
          const t = samplePath(path, sp.s).t;
          const sgn = t[0] * Math.sin(sp.yaw) + t[2] * Math.cos(sp.yaw) < 0 ? -1 : 1;
          dirS.current.set(t[0] * sgn, t[1] * sgn, t[2] * sgn);
        } else dirS.current.set(Math.sin(sp.yaw), 0, Math.cos(sp.yaw));
      }
    }
    prev.current.set(sp.pos[0], sp.pos[1], sp.pos[2]);
    qTmp.current.setFromUnitVectors(FWD, dirS.current);
    root.current.quaternion.slerp(qTmp.current, 1 - Math.exp(-dt * 12));
    st.pos.set(sp.pos[0], sp.pos[1], sp.pos[2]);
    st.dir.copy(dirS.current);
    st.quat.copy(root.current.quaternion);
    st.valid = true;

    const v = useView.getState();
    const pipe = v.mode === 'pipe';
    const dist = camera.position.distanceTo(root.current.position);
    const show = (dist < 7 || pipe) && v.layers.robots;
    if (model.current) model.current.visible = show;
    if (!show) return;
    const mode = r.mode ?? 'DOCKED';
    const moving = mode === 'TRAVELING' || mode === 'RETURNING';
    // spring arms follow the bore of the segment the crawler is in (geometry shared per bore size)
    const seg = r.pose.segment_id ? edges[r.pose.segment_id] : undefined;
    const bore = seg ? seg.diameter_mm / 2000 : 0.05;
    const key = Math.round(Math.max(bore - 0.004, 0.04) * 2000);
    if (arms.current && key !== armKey.current) {
      armKey.current = key;
      arms.current.geometry = crawlerArms(bore);
    }
    if (led.current) led.current.material = mode === 'INSPECTING' ? kit.ledWhite : kit.ledWarm;
    if (status.current) {
      const on = Math.sin(state.clock.elapsedTime * (moving ? 7 : 2.5)) > 0;
      status.current.material = kit.statusMats[(moving ? 0 : 2) + (on ? 0 : 1)];
    }
    if (brush.current) {
      brush.current.visible = r.tool === 'brush' && mode === 'WORKING';
      brush.current.rotation.z += dt * 18;
    }
  });

  return (
    <group
      ref={root}
      onPointerOver={(e) => {
        e.stopPropagation();
        useView.getState().hover(robot.id);
        if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        useView.getState().hover(null);
        if (typeof document !== 'undefined') document.body.style.cursor = '';
      }}
      onClick={(e) => {
        e.stopPropagation();
        useView.getState().select(robot.id);
      }}
    >
      <group ref={model} visible={false}>
        <mesh geometry={kit.body} material={kit.bodyMat} castShadow={false} />
        <mesh ref={led} geometry={kit.led} material={kit.ledWarm} />
        <mesh ref={status} geometry={kit.status} material={kit.statusMats[2]} />
        <mesh ref={arms} geometry={crawlerArms(0.05)} material={kit.bodyMat} />
        <mesh ref={brush} geometry={kit.brush} material={kit.brushMat} position={[0, 0, 0.115]} visible={false} />
      </group>
      <mesh geometry={kit.hit} material={kit.hitMat} />
    </group>
  );
}

/* ───────────────────────────── OUTRIG (instanced fleet) ───────────────────────────── */

interface OutrigArmState {
  interp: ArmInterp;
  /** the store object the last sample was read from; the store replaces a robot's object when its data changes */
  src: unknown;
  lod: ArmLod;
  limits?: number[][];
  held: string | null;
}

const _q6 = [0, 0, 0, 0, 0, 0];
const _smp = new Float64Array(7);
const _stick = new THREE.Matrix4().makeScale(0.4, 0.4, 1);

/**
 * OUTRIG fleet: chassis + beacon + hit proxy + a 6-DOF arm per robot, all as InstancedMesh for the WHOLE class (instance i = robot i).
 * Every robot draws its OWN arm pose: the joints come from robot.manipulator (or the older arm_qpos_rad), are smoothed between
 * server updates by ArmInterp (never past the last sample), and placed by the same forward kinematics as the backend's MuJoCo
 * model. A robot with no joint data is drawn stowed (the backend's REST_POSE), never animated on invented motion.
 * LOD: full detail within ~6 m of the camera, a thin 3-segment stick to ~16 m, nothing beyond (the locator ring takes over).
 */
function OutrigFleet({ ids }: { ids: string[] }) {
  const kit = useMemo(() => outrigKit(), []);
  const n = ids.length;
  const { camera } = useThree();
  const statics = useRef<Array<THREE.InstancedMesh | null>>([]);
  const armMesh = useRef<Array<THREE.InstancedMesh | null>>([]);
  const fingers = useRef<THREE.InstancedMesh>(null);
  const held = useRef<THREE.InstancedMesh>(null);
  const eeMark = useRef<THREE.InstancedMesh>(null);
  const beacon = useRef<THREE.InstancedMesh>(null);
  const hit = useRef<THREE.InstancedMesh>(null);
  const st = useRef<OutrigArmState[]>([]);
  if (st.current.length !== n) st.current = ids.map((_, i) => st.current[i] ?? { interp: new ArmInterp(), src: undefined, lod: 'full', held: null });
  const parts = useMemo(() => makePartMatrices(), []);
  const hitGeo = useMemo(() => {
    const g = new THREE.BoxGeometry(1.1, 1.0, 0.85);
    g.translate(0, 0.5, 0);
    return g;
  }, []);
  const hitMat = useMemo(() => {
    const m = new THREE.MeshBasicMaterial();
    m.visible = false;
    return m;
  }, []);

  useFrame((state) => {
    const w = useWorld.getState();
    const v = useView.getState();
    const show = v.layers.robots && v.mode !== 'pipe';
    const now = state.clock.elapsedTime;
    const arms = armMesh.current;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const r = w.robots[id];
      const sp = samplePose(id);
      const rg = rigFor(id);
      if (sp) {
        rg.pos.set(sp.pos[0], 0.4, sp.pos[2]);
        rg.dir.set(Math.sin(sp.yaw), 0, Math.cos(sp.yaw));
        rg.quat.setFromAxisAngle(Y, sp.yaw);
        rg.valid = true;
      }
      if (!r || !sp || !show) {
        for (const m of statics.current) m?.setMatrixAt(i, ZERO);
        for (const m of arms) m?.setMatrixAt(i, ZERO);
        fingers.current?.setMatrixAt(2 * i, ZERO);
        fingers.current?.setMatrixAt(2 * i + 1, ZERO);
        held.current?.setMatrixAt(i, ZERO);
        eeMark.current?.setMatrixAt(i, ZERO);
        beacon.current?.setMatrixAt(i, ZERO);
        hit.current?.setMatrixAt(i, ZERO);
        armRigFor(id).valid = false;
        continue;
      }
      const s = st.current[i];
      const working = r.mode === 'WORKING' || r.mode === 'INSPECTING';
      // chassis frame
      const R = _c.makeRotationY(sp.yaw).setPosition(sp.pos[0], 0, sp.pos[2]);
      for (const mesh of statics.current) mesh?.setMatrixAt(i, R);
      hit.current?.setMatrixAt(i, R);
      beacon.current?.setMatrixAt(i, _b.copy(R).multiply(T(-0.22, 0.4, -0.38)));
      const moving = sp.speed > 0.02 || working;
      _col.set(moving ? (Math.sin(now * 8) > 0 ? '#ffb347' : '#3a2a10') : '#2e7d5b');
      beacon.current?.setColorAt(i, _col);

      // arm: newest server sample -> smoother -> FK
      if (s.src !== r) {
        s.src = r;
        const mp = readManipulator(r);
        if (mp) {
          clampJoints(mp.joints_rad, mp.joint_limits_rad, _q6);
          s.interp.push(_q6, mp.gripper_aperture_m ?? ARM_DIMS.apertureOpen, now);
        } else if (!s.interp.ready) s.interp.push(REST_JOINTS, ARM_DIMS.apertureOpen, now);
        s.limits = mp?.joint_limits_rad;
        s.held = mp?.held_object_id ?? null;
      }
      s.interp.sample(now, _smp);
      clampJoints(_smp, s.limits, _q6);
      armFK(_q6, _smp[6], parts);
      // end effector in the world, for the arm close-up camera
      const ea = armRigFor(id);
      ea.pos.setFromMatrixPosition(parts[PART.EE]).applyMatrix4(R);
      ea.valid = true;

      s.lod = armLod(camera.position.distanceTo(_p.set(sp.pos[0], 0.5, sp.pos[2])), s.lod);
      const full = s.lod === 'full';
      const stick = s.lod === 'stick';
      const put = (mesh: THREE.InstancedMesh | null | undefined, idx: number, k: number, thin: boolean) => {
        if (!mesh) return;
        _a.multiplyMatrices(R, parts[k]);
        mesh.setMatrixAt(idx, thin ? _a.multiply(_stick) : _a);
      };
      const off = (mesh: THREE.InstancedMesh | null | undefined, idx: number) => mesh?.setMatrixAt(idx, ZERO);
      for (let k = 0; k < 6; k++) {
        const mesh = arms[k];
        if (k === PART.L2 || k === PART.L3) (full || stick ? put(mesh, i, k, stick) : off(mesh, i));
        else if (k === PART.PALM) (full || stick ? put(mesh, i, k, false) : off(mesh, i));
        else full ? put(mesh, i, k, false) : off(mesh, i);
      }
      if (full) {
        put(fingers.current, 2 * i, PART.FL, false);
        put(fingers.current, 2 * i + 1, PART.FR, false);
        put(eeMark.current, i, PART.EE, false);
      } else {
        off(fingers.current, 2 * i);
        off(fingers.current, 2 * i + 1);
        off(eeMark.current, i);
      }
      const isHeld = !!s.held && s.lod !== 'none';
      if (isHeld) put(held.current, i, PART.EE, false);
      else off(held.current, i);
    }
    for (const m of [...statics.current, ...arms, fingers.current, held.current, eeMark.current, beacon.current, hit.current]) if (m) m.instanceMatrix.needsUpdate = true;
    if (beacon.current?.instanceColor) beacon.current.instanceColor.needsUpdate = true;
  });

  const idOf = (e: { instanceId?: number }) => (e.instanceId !== undefined ? ids[e.instanceId] : undefined);
  const over = (e: { stopPropagation(): void; instanceId?: number }) => {
    e.stopPropagation();
    const id = idOf(e);
    if (id) useView.getState().hover(id);
    if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
  };
  const out = () => {
    useView.getState().hover(null);
    if (typeof document !== 'undefined') document.body.style.cursor = '';
  };
  const click = (e: { stopPropagation(): void; instanceId?: number }) => {
    e.stopPropagation();
    const id = idOf(e);
    if (id) useView.getState().select(id);
  };
  if (!n) return null;
  const nr = () => null;
  const A = kit.arm;
  const armParts: ArmPartKit[] = [A.l1, A.l2, A.l3, A.l4, A.l5, A.palm];
  return (
    <group name="outrig-fleet">
      {kit.static.map((p, k) => (
        <instancedMesh key={`s${k}`} ref={(m) => void (statics.current[k] = m)} args={[p.geo, p.mat, n]} frustumCulled={false} castShadow raycast={nr} />
      ))}
      {armParts.map((p, k) => (
        <instancedMesh key={`a${k}`} ref={(m) => void (armMesh.current[k] = m)} args={[p.geo, p.mat, n]} frustumCulled={false} raycast={nr} />
      ))}
      <instancedMesh ref={fingers} args={[A.finger.geo, A.finger.mat, 2 * n]} frustumCulled={false} raycast={nr} />
      <instancedMesh ref={held} args={[A.held.geo, A.held.mat, n]} frustumCulled={false} raycast={nr} />
      <instancedMesh ref={eeMark} args={[A.ee.geo, A.ee.mat, n]} frustumCulled={false} renderOrder={11} raycast={nr} />
      <instancedMesh ref={beacon} args={[kit.beacon, kit.beaconMat, n]} frustumCulled={false} raycast={nr} />
      <instancedMesh ref={hit} args={[hitGeo, hitMat, n]} frustumCulled={false} onPointerOver={over} onPointerOut={out} onClick={click} />
    </group>
  );
}

/* ───────────────────────────── locator markers (overview scale) ───────────────────────────── */

/**
 * Opaque pipes hide a 17 cm crawler and a 1 m rover is a speck from across the hall, so far robots are drawn as
 * billboarded rings. One InstancedMesh per marker part for the entire fleet; instance-id picking.
 */
function Markers({ ids, classes }: { ids: string[]; classes: string[] }) {
  const { camera } = useThree();
  const rel = useRelevanceSet();
  const n = ids.length;
  const cIdx = useMemo(() => ids.map((_, i) => i).filter((i) => classes[i] === 'inpipe'), [ids, classes]);
  const oIdx = useMemo(() => ids.map((_, i) => i).filter((i) => classes[i] !== 'inpipe'), [ids, classes]);
  const cRing = useRef<THREE.InstancedMesh>(null);
  const oRing = useRef<THREE.InstancedMesh>(null);
  const dots = useRef<THREE.InstancedMesh>(null);
  const beams = useRef<THREE.InstancedMesh>(null);
  const hit = useRef<THREE.InstancedMesh>(null);
  const mats = useMemo(() => {
    const mk = (c: string, o = 1) => new THREE.MeshBasicMaterial({ color: c, transparent: true, depthTest: false, toneMapped: false, opacity: o });
    const hm = new THREE.MeshBasicMaterial();
    hm.visible = false;
    return { cRing: mk(C.inpipe), oRing: mk(C.outrig), dot: mk(C.inpipe, 0.9), beam: mk(C.inpipe), hit: hm };
  }, []);

  useFrame((_, dt) => {
    void dt;
    const w = useWorld.getState();
    const v = useView.getState();
    const pipe = v.mode === 'pipe';
    const pulse = 0.75 + 0.25 * Math.sin(performance.now() / 260);
    mats.cRing.opacity = 0.95 * pulse;
    mats.oRing.opacity = 0.9 * pulse;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const inpipe = classes[i] === 'inpipe';
      const sp = samplePose(id);
      let M: THREE.Matrix4 = ZERO;
      let tint = 1;
      if (sp && !pipe && v.layers.robots) {
        _p.set(sp.pos[0], inpipe ? sp.pos[1] : 0.05, sp.pos[2]);
        const dist = camera.position.distanceTo(_p);
        if (dist > (inpipe ? 2.2 : 9)) {
          const sc = inpipe ? clamp(dist * 0.03, 0.3, 1.5) : clamp(dist * 0.03, 0.5, 1.5);
          M = _c.compose(_p, camera.quaternion, _s.set(sc, sc, sc));
          const r = w.robots[id];
          const active = inpipe ? r?.mode !== 'DOCKED' : true;
          const relv = rel === null ? 1 : rel.has(id) ? 1 : 0.2;
          tint = (active ? 1 : 0.37) * relv;
        }
      }
      hit.current?.setMatrixAt(i, M);
      const k = inpipe ? cIdx.indexOf(i) : oIdx.indexOf(i);
      const ring = inpipe ? cRing.current : oRing.current;
      ring?.setMatrixAt(k, M);
      _col.setScalar(tint);
      ring?.setColorAt(k, _col);
      if (inpipe) {
        dots.current?.setMatrixAt(k, M);
        beams.current?.setMatrixAt(k, M);
        dots.current?.setColorAt(k, _col);
        beams.current?.setColorAt(k, _col);
      }
    }
    for (const m of [cRing.current, oRing.current, dots.current, beams.current, hit.current]) {
      if (!m) continue;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  });

  const over = (e: { stopPropagation(): void; instanceId?: number }) => {
    e.stopPropagation();
    const id = e.instanceId !== undefined ? ids[e.instanceId] : undefined;
    if (id) useView.getState().hover(id);
    if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
  };
  const out = () => {
    useView.getState().hover(null);
    if (typeof document !== 'undefined') document.body.style.cursor = '';
  };
  const click = (e: { stopPropagation(): void; instanceId?: number }) => {
    e.stopPropagation();
    const id = e.instanceId !== undefined ? ids[e.instanceId] : undefined;
    if (id) useView.getState().select(id);
  };
  const nr = () => null;
  if (!n) return null;
  return (
    <group name="robot-markers">
      {cIdx.length > 0 && (
        <>
          <instancedMesh key={`cr${cIdx.length}`} ref={cRing} args={[markerGeo.crawlerRing, mats.cRing, cIdx.length]} frustumCulled={false} renderOrder={12} raycast={nr} />
          <instancedMesh key={`cd${cIdx.length}`} ref={dots} args={[markerGeo.dot, mats.dot, cIdx.length]} frustumCulled={false} renderOrder={12} raycast={nr} />
          <instancedMesh key={`cb${cIdx.length}`} ref={beams} args={[markerGeo.beam, mats.beam, cIdx.length]} frustumCulled={false} renderOrder={12} raycast={nr} />
        </>
      )}
      {oIdx.length > 0 && <instancedMesh key={`or${oIdx.length}`} ref={oRing} args={[markerGeo.outrigRing, mats.oRing, oIdx.length]} frustumCulled={false} renderOrder={12} raycast={nr} />}
      <instancedMesh key={`h${n}`} ref={hit} args={[markerGeo.hit, mats.hit, n]} frustumCulled={false} onPointerOver={over} onPointerOut={out} onClick={click} />
    </group>
  );
}

/* ───────────────────────────── selection brackets (one per hover/selection, not per robot) ───────────────────────────── */

function FollowBrackets({ id, klass }: { id: string; klass: string }) {
  const g = useRef<THREE.Group>(null);
  useFrame(() => {
    const st = rigFor(id);
    if (!g.current || !st.valid) return;
    g.current.position.set(st.pos.x, klass === 'inpipe' ? st.pos.y : 0, st.pos.z);
    g.current.quaternion.copy(st.quat);
  });
  const outrig = klass !== 'inpipe';
  const size = useMemo<[number, number, number]>(() => (outrig ? [1.1, 1.0, 0.85] : [0.5, 0.5, 0.5]), [outrig]);
  const off = useMemo<[number, number, number]>(() => (outrig ? [0, 0.5, 0] : [0, 0, 0]), [outrig]);
  return (
    <group ref={g}>
      <Brackets size={size} id={id} offset={off} />
    </group>
  );
}

function BracketsLayer({ classes }: { classes: Record<string, string> }) {
  const sel = useView((s) => s.selectedId);
  const hov = useView((s) => s.hoverId);
  return (
    <>
      {sel && classes[sel] && <FollowBrackets key={sel} id={sel} klass={classes[sel]} />}
      {hov && hov !== sel && classes[hov] && <FollowBrackets key={hov} id={hov} klass={classes[hov]} />}
    </>
  );
}

/* ───────────────────────────── route ribbons ───────────────────────────── */

/** Highlight the legal route a robot is following (pipe edges for crawlers, corridor for OUTRIG). */
function RouteRibbon({ robot }: { robot: Robot }) {
  const missionId = useWorld((s) => s.robots[robot.id]?.mission_id);
  const mission = useWorld((s) => (missionId ? s.missions[missionId] : undefined));
  const modeNow = useWorld((s) => s.robots[robot.id]?.mode ?? robot.mode);
  const sel = useView((s) => s.selectedId);
  const follow = useView((s) => s.followRobotId);
  const route = mission?.route_xyz_m;
  const show = !!route && route.length > 1 && (sel === robot.id || follow === robot.id || (mission && mission.status !== 'DOCKED' && modeNow !== 'DOCKED'));
  const obj = useMemo(() => {
    if (!route || route.length < 2) return null;
    if (robot.class === 'inpipe') {
      const p = buildPath(route as Array<[number, number, number]>, 0);
      const m = new THREE.Mesh(buildTubeGeometry(p, 0.028, 6, 0.3), new THREE.MeshBasicMaterial({ color: C.inpipe, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false }));
      m.renderOrder = 4;
      return m;
    }
    const pts = route.map((p) => new THREE.Vector3(p[0], 0.02, p[2]));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: C.outrig, transparent: true, opacity: 0.85, dashSize: 0.3, gapSize: 0.18, depthWrite: false, toneMapped: false }));
    line.computeLineDistances();
    line.renderOrder = 4;
    return line;
  }, [route, robot.class]);
  useEffect(
    () => () => {
      if (!obj) return;
      (obj as THREE.Mesh).geometry.dispose();
      ((obj as THREE.Mesh).material as THREE.Material).dispose();
    },
    [obj],
  );
  useFrame((state) => {
    if (!obj) return;
    const m = (obj as THREE.Mesh).material as THREE.Material;
    m.opacity = 0.45 + 0.25 * Math.sin(state.clock.elapsedTime * 3);
    obj.visible = !!show && useView.getState().mode !== 'pipe';
  });
  if (!obj) return null;
  return <primitive object={obj} />;
}

/* ───────────────────────────── Rigid Objects & Maintenance Fixtures ───────────────────────────── */

function RigidObjectsAndFixtures() {
  const rigidObjects = useWorld((s) => s.rigid_objects);
  const mechanicalFixtures = useWorld((s) => s.mechanical_fixtures);

  const cartridgeMesh = useMemo(() => new THREE.CylinderGeometry(0.045, 0.045, 0.16, 16), []);
  const cartridgeMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#e2e8f0', metalness: 0.85, roughness: 0.25 }),
    [],
  );
  const flangeGeo = useMemo(() => new THREE.CylinderGeometry(0.055, 0.055, 0.015, 16), []);
  const flangeMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#475569', metalness: 0.9, roughness: 0.2 }),
    [],
  );
  const handleGeo = useMemo(() => new THREE.TorusGeometry(0.025, 0.005, 8, 16, Math.PI), []);
  const handleMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#f59e0b', metalness: 0.5, roughness: 0.3 }),
    [],
  );

  const fixtureBoxGeo = useMemo(() => new THREE.BoxGeometry(0.24, 0.22, 0.28), []);
  const fixtureBoxMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#1e293b', metalness: 0.7, roughness: 0.4 }),
    [],
  );
  const fixtureCollarGeo = useMemo(() => new THREE.CylinderGeometry(0.065, 0.065, 0.05, 16), []);
  const fixtureCollarMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.8, roughness: 0.3 }),
    [],
  );

  // an object in a robot's gripper is drawn by that robot's arm (smoothed, on the same kinematics); don't draw it twice
  const heldKey = useWorld((st) =>
    Object.values(st.robots)
      .map((r) => readManipulator(r)?.held_object_id ?? '')
      .filter(Boolean)
      .join('|'),
  );
  const heldIds = new Set(heldKey ? heldKey.split('|') : []);
  const objEntries = Object.values(rigidObjects ?? {}).filter((o) => !heldIds.has(o.id));
  const fixEntries = Object.values(mechanicalFixtures ?? {});

  return (
    <group name="rigid-objects-and-fixtures">
      {/* Mechanical Fixtures (e.g. Strainer service port) */}
      {fixEntries.map((f) => {
        const p = f.pos_xyz ?? [14.2, 1.8, 0.27];
        const statusCol = f.cartridge_installed && f.mechanical_fit_pass ? '#10b981' : f.is_isolated ? '#f59e0b' : '#06b6d4';
        return (
          <group key={f.id} position={[p[0], p[1], p[2]]}>
            <mesh geometry={fixtureBoxGeo} material={fixtureBoxMat} castShadow />
            <mesh geometry={fixtureCollarGeo} material={fixtureCollarMat} position={[0, 0.11, 0]} />
            <mesh position={[0, 0.14, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.05, 0.065, 16]} />
              <meshBasicMaterial color={statusCol} toneMapped={false} side={THREE.DoubleSide} />
            </mesh>
            <pointLight color={statusCol} intensity={f.cartridge_installed ? 0.8 : 0.3} distance={1.2} />
          </group>
        );
      })}

      {/* Rigid Objects (e.g. Strainer Cartridge) */}
      {objEntries.map((o) => {
        const p = o.pos_xyz;
        const q = o.quat_xyzw;
        return (
          <group key={o.id} position={[p[0], p[1], p[2]]} quaternion={new THREE.Quaternion(q[0], q[1], q[2], q[3])}>
            <mesh geometry={cartridgeMesh} material={cartridgeMat} castShadow />
            <mesh geometry={flangeGeo} material={flangeMat} position={[0, -0.075, 0]} />
            <mesh geometry={handleGeo} material={handleMat} position={[0, 0.08, 0]} rotation={[0, 0, Math.PI / 2]} />
          </group>
        );
      })}
    </group>
  );
}

export function Robots() {
  // re-render only when the fleet's membership changes, not on every pose; each robot reads its own pose per frame
  const key = useWorld((s) => Object.values(s.robots).map((r) => `${r.id}:${r.class}`).join('|'));
  const robots = useWorld.getState().robots;
  const { ids, classes, byId, outrigIds } = useMemo(() => {
    const ids = key ? key.split('|').map((k) => k.split(':')[0]) : [];
    const classes = ids.map((id) => robots[id]?.class ?? 'inpipe');
    const byId: Record<string, string> = {};
    ids.forEach((id, i) => (byId[id] = classes[i]));
    return { ids, classes, byId, outrigIds: ids.filter((_, i) => classes[i] !== 'inpipe') };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <group name="robots">
      {ids.map((id, i) => {
        const r = robots[id];
        if (!r) return null;
        return (
          <group key={id}>
            {classes[i] === 'inpipe' && <Crawler robot={r} />}
            <RouteRibbon robot={r} />
          </group>
        );
      })}
      <OutrigFleet key={outrigIds.join('|')} ids={outrigIds} />
      <Markers key={key} ids={ids} classes={classes} />
      <BracketsLayer classes={byId} />
      <RobotTrail />
      <RigidObjectsAndFixtures />
      <GhostRobotOverlay />
    </group>
  );
}
