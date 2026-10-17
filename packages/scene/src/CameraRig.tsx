import { useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { samplePose, useWorld } from '@loopkeeper/core/store';
import { clamp, samplePath } from '@loopkeeper/core';
import { rigFor, sectionPlane } from './rig';
import { CAM_LIMITS, useView } from './view';
import { usePaths } from './Pipes';
import { fitCamera, overviewBoxes, OVERVIEW_VIEW } from './fit';
import type { CamGoal } from './view';
import type { Topology } from '@loopkeeper/core/contracts';
import { useCockpit } from './cockpit';
import { useMapCamera } from './mapCamera';
import { getCameraMount } from './MountedCameraTransforms';
import { computeMountTransform } from './mountTransform';

const damp = (cur: number, goal: number, lambda: number, dt: number) => cur + (goal - cur) * (1 - Math.exp(-lambda * dt));

/** Obstacle rectangles on the floor [minX, minZ, maxX, maxZ] for chase-camera collision avoidance, derived from the topology (racks, CDU, pumps, chiller), cached per topology object. */
const rectCache = new WeakMap<object, number[][]>();
function obstacleRects(topo: Topology | null): number[][] {
  if (!topo) return [];
  const hit = rectCache.get(topo);
  if (hit) return hit;
  const r = topo.assets
    .filter((a) => ['rack', 'cdu', 'pump', 'chiller'].includes(a.type) && a.size_m)
    .map((a) => [a.position_xyz_m[0] - a.size_m![0] / 2, a.position_xyz_m[2] - a.size_m![2] / 2, a.position_xyz_m[0] + a.size_m![0] / 2, a.position_xyz_m[2] + a.size_m![2] / 2]);
  rectCache.set(topo, r);
  return r;
}

function isObstacleBlocked(topo: Topology | null, x: number, z: number, pad = 0.3): boolean {
  for (const r of obstacleRects(topo)) {
    if (x >= r[0] - pad && x <= r[2] + pad && z >= r[1] - pad && z <= r[3] + pad) {
      return true;
    }
  }
  return false;
}

export function CameraRig() {
  const { camera, size, gl } = useThree();
  const cur = useRef({ az: 0.58, el: 0.58, dist: 23, tx: -1.2, ty: 1, tz: -0.6, fov: 32, ox: 0, oy: 0 });
  const lastNonce = useRef(-1);
  const slowUntil = useRef(0);
  const pipePos = useRef(new THREE.Vector3());
  const pipeLook = useRef(new THREE.Vector3());
  const pipeInit = useRef(false);
  const wasPipe = useRef(false);
  const paths = usePaths();
  const upVec = useRef(new THREE.Vector3(0, 1, 0));
  const tacticalFit = useRef<{ key: string; goal: CamGoal } | null>(null);
  const tmp = useRef({
    pos: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    side: new THREE.Vector3(),
    desired: new THREE.Vector3(),
    look: new THREE.Vector3(),
    targetQuat: new THREE.Quaternion(),
    forward: new THREE.Vector3(),
  });

  useFrame((state, dt0) => {
    const dt = Math.min(dt0, 0.05);
    const v = useView.getState();
    const mc = useMapCamera.getState();
    const c = cur.current;
    const cam = camera as THREE.PerspectiveCamera;
    const now = state.clock.elapsedTime;
    const w = useWorld.getState();
    const T = tmp.current;

    if (v.camNonce !== lastNonce.current) {
      lastNonce.current = v.camNonce;
      slowUntil.current = now + (v.reducedMotion ? 0.3 : 1.5);
    }
    const cinematic = now < slowUntil.current;
    const lam = v.reducedMotion ? 16 : cinematic ? 3.4 : 11;

    // ─────────────────────────── MAP TAB: DUAL-ROBOT RIG ───────────────────────────
    if (mc.active) {
      const robotId = mc.selectedRobotId;
      const robot = w.robots[robotId];
      // POV / chase / cutaway are meaningless without a real robot: fall back to the fitted overview, never a fixed mount
      const effMode = robot ? mc.cameraMode : 'tactical';
      const klass = mc.robotClass;
      const st = rigFor(robotId);
      const sp = samplePose(robotId);

      const rPos = st.valid ? st.pos : sp ? new THREE.Vector3(sp.pos[0], klass === 'outrig' ? 0.4 : sp.pos[1], sp.pos[2]) : new THREE.Vector3();
      const rQuat = st.valid ? st.quat : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sp?.yaw ?? 0);
      const rDir = st.valid ? st.dir : new THREE.Vector3(Math.sin(sp?.yaw ?? 0), 0, Math.cos(sp?.yaw ?? 0));

      const vertical = Math.abs(rDir.y) >= 0.92;
      upVec.current.set(vertical ? 0 : 0, vertical ? 0 : 1, vertical ? 1 : 0);
      gl.localClippingEnabled = true;

      if (effMode === 'first_person') {
        const mount = getCameraMount(klass, mc.firstPersonDirection);
        const { position: tPos, quaternion: tQuat } = computeMountTransform(
          rPos,
          rQuat,
          mount,
          mc.gimbal.yaw,
          mc.gimbal.pitch,
          T.desired,
          T.targetQuat,
        );

        cam.position.lerp(tPos, 1 - Math.exp(-22 * dt));
        cam.quaternion.slerp(tQuat, 1 - Math.exp(-22 * dt));
        c.fov = damp(c.fov, mount.fov, 8, dt);
        cam.near = klass === 'inpipe' ? 0.004 : 0.04;
        cam.far = klass === 'inpipe' ? 120 : 250;
        sectionPlane.constant = 1e6; // full walls visible in first person
        wasPipe.current = klass === 'inpipe';
      } else if (effMode === 'third_person') {
        const side = T.side.crossVectors(rDir, upVec.current).normalize();

        if (mc.thirdPersonMode === 'chase') {
          if (klass === 'inpipe') {
            // inside pipe: follow behind along tangent
            T.desired.copy(rPos).addScaledVector(rDir, -0.55).addScaledVector(upVec.current, 0.02);
            T.look.copy(rPos).addScaledVector(rDir, 0.45);
            sectionPlane.constant = 1e6;
            c.fov = damp(c.fov, 72, 6, dt);
            cam.near = 0.004;
            cam.far = 120;
          } else {
            // outrig on floor: chase behind and above rover
            const fwd = T.forward.set(rDir.x, 0, rDir.z).normalize();
            let distBack = 3.0;
            const lookY = 0.55;
            T.look.set(rPos.x + fwd.x * 1.2, rPos.y + lookY, rPos.z + fwd.z * 1.2);

            // Obstacle collision prevention: check if camera would be inside an obstacle
            let camX = rPos.x - fwd.x * distBack;
            let camZ = rPos.z - fwd.z * distBack;
            if (isObstacleBlocked(w.topology, camX, camZ)) {
              // Pull camera closer to rover
              distBack = 1.4;
              camX = rPos.x - fwd.x * distBack;
              camZ = rPos.z - fwd.z * distBack;
            }
            T.desired.set(camX, rPos.y + 1.6, camZ);
            sectionPlane.constant = 1e6;
            c.fov = damp(c.fov, 65, 6, dt);
            cam.near = 0.05;
            cam.far = 250;
          }

          cam.position.lerp(T.desired, 1 - Math.exp(-12 * dt));
          cam.up.copy(klass === 'inpipe' ? upVec.current : new THREE.Vector3(0, 1, 0));
          cam.lookAt(T.look);
          wasPipe.current = klass === 'inpipe';
        } else if (mc.thirdPersonMode === 'cutaway') {
          if (klass === 'inpipe') {
            // Cutaway follower: camera beside pipe, section plane clips the near half of wall
            T.desired.copy(rPos).addScaledVector(rDir, 0.15).addScaledVector(side, 0.45).addScaledVector(upVec.current, 0.04);
            T.look.copy(rPos).addScaledVector(rDir, 0.15);
            sectionPlane.normal.copy(side).negate();
            sectionPlane.constant = side.dot(rPos);
            c.fov = damp(c.fov, 38, 6, dt);
            cam.near = 0.004;
            cam.far = 120;
            cam.position.lerp(T.desired, 1 - Math.exp(-12 * dt));
            cam.up.copy(upVec.current);
            cam.lookAt(T.look);
            wasPipe.current = true;
          } else {
            // For outrig, cutaway mode acts as close tactical zoom
            const fwd = T.forward.set(rDir.x, 0, rDir.z).normalize();
            T.desired.set(rPos.x - fwd.x * 2.0, rPos.y + 1.2, rPos.z - fwd.z * 2.0);
            T.look.set(rPos.x, rPos.y + 0.4, rPos.z);
            sectionPlane.constant = 1e6;
            c.fov = damp(c.fov, 50, 6, dt);
            cam.near = 0.05;
            cam.far = 250;
            cam.position.lerp(T.desired, 1 - Math.exp(-12 * dt));
            cam.up.set(0, 1, 0);
            cam.lookAt(T.look);
            wasPipe.current = false;
          }
        } else {
          // Orbit mode around robot
          const orb = mc.orbitState;
          const ce = Math.cos(orb.elevation);
          const tgtY = klass === 'outrig' ? 0.45 : rPos.y;
          T.desired.set(
            rPos.x + orb.distance * Math.sin(orb.azimuth) * ce,
            tgtY + orb.distance * Math.sin(orb.elevation),
            rPos.z + orb.distance * Math.cos(orb.azimuth) * ce,
          );
          T.look.set(rPos.x, tgtY, rPos.z);
          sectionPlane.constant = 1e6;
          c.fov = damp(c.fov, 42, 6, dt);
          cam.near = 0.05;
          cam.far = 250;
          cam.position.lerp(T.desired, 1 - Math.exp(-14 * dt));
          cam.up.set(0, 1, 0);
          cam.lookAt(T.look);
          wasPipe.current = false;
        }
      } else {
        // Tactical Map View: a true overview of the hall and its pipe network (the selected robot is drawn in it,
        // highlighted by Robots.tsx). Fitted to the area the panels leave free, so nothing is cropped.
        const topo = w.topology;
        const key = `${size.width}x${size.height}|${v.insets.left}|${v.insets.right}|${v.insets.top}|${v.insets.bottom}|${topo ? topo.facility.topology_hash : ''}`;
        if (topo && tacticalFit.current?.key !== key) {
          tacticalFit.current = {
            key,
            goal: fitCamera({ boxes: overviewBoxes(topo), width: size.width, height: size.height, insets: v.insets, ...OVERVIEW_VIEW }),
          };
        }
        const g = mc.tacticalGoal ?? tacticalFit.current?.goal ?? { azimuth: 0.58, elevation: 0.62, distance: 28, target: [-1.2, 1, -1] as [number, number, number], fov: 32 };
        const ceT = Math.cos(g.elevation);
        T.desired.set(g.target[0] + g.distance * Math.sin(g.azimuth) * ceT, g.target[1] + g.distance * Math.sin(g.elevation), g.target[2] + g.distance * Math.cos(g.azimuth) * ceT);
        T.look.set(g.target[0], g.target[1], g.target[2]);
        sectionPlane.constant = 1e6;
        c.fov = damp(c.fov, g.fov, 6, dt);
        cam.near = 0.5;
        cam.far = 300;
        cam.position.lerp(T.desired, 1 - Math.exp(-8 * dt));
        cam.up.set(0, 1, 0);
        cam.lookAt(T.look);
        wasPipe.current = false;
      }
    } else if (v.mode === 'pipe' && v.pipeEdgeId) {
      /* ── inside the bore (legacy pipe inspection) ── */
      const edgeId = v.pipeEdgeId;
      const path = paths[edgeId];
      const ck = useCockpit.getState();
      const rider = ck.robotId ? w.robots[ck.robotId] : undefined;
      const crawler = rider?.class === 'inpipe' ? rider : ck.robotId ? undefined : Object.values(w.robots).find((r) => r.class === 'inpipe' && r.pose.segment_id === edgeId && r.mode !== 'DOCKED');
      const cam3 = rider ? ck.cam : v.pipeCam === 'front' ? 'nose' : 'side';
      const pos = T.pos;
      const dir = T.dir;
      dir.set(0, 0, 1);
      pos.set(0, 0, 0);
      if (crawler) {
        const st = rigFor(crawler.id);
        const sp = samplePose(crawler.id);
        if (sp) pos.set(sp.pos[0], sp.pos[1], sp.pos[2]);
        dir.copy(st.dir);
      } else if (path) {
        const fault = w.assets[edgeId]?.fault?.location_s_m;
        const s = v.pipeProbeS ?? clamp((fault ?? path.length * 0.55) - 1.1, 0.2, path.length - 0.6);
        const sm = samplePath(path, s);
        pos.set(...sm.p);
        dir.set(...sm.t);
      }
      const vertical = Math.abs(dir.y) >= 0.92;
      upVec.current.set(vertical ? 0 : 0, vertical ? 0 : 1, vertical ? 1 : 0);
      gl.localClippingEnabled = true;
      const side = T.side.crossVectors(dir, upVec.current).normalize();
      const desired = T.desired;
      const look = T.look;
      let fovT = 84;
      if (cam3 === 'nose') {
        desired.copy(pos).addScaledVector(dir, 0.105);
        look.copy(pos).addScaledVector(dir, 1.5);
        sectionPlane.constant = 1e6;
        fovT = 84;
      } else if (cam3 === 'chase') {
        desired.copy(pos).addScaledVector(dir, -0.5).addScaledVector(upVec.current, 0.02);
        look.copy(pos).addScaledVector(dir, 0.45);
        sectionPlane.constant = 1e6;
        fovT = 70;
      } else if (cam3 === 'rear') {
        desired.copy(pos).addScaledVector(dir, -0.19);
        look.copy(pos).addScaledVector(dir, -1.6);
        sectionPlane.constant = 1e6;
        fovT = 80;
      } else if (cam3 === 'side') {
        desired.copy(pos).addScaledVector(dir, 0.2).addScaledVector(side, 0.5).addScaledVector(upVec.current, 0.03);
        look.copy(pos).addScaledVector(dir, 0.2);
        sectionPlane.normal.copy(side).negate();
        sectionPlane.constant = side.dot(pos);
        fovT = 36;
      } else {
        const axis = vertical ? side : upVec.current;
        desired.copy(pos).addScaledVector(dir, 0.2).addScaledVector(axis, 0.5);
        look.copy(pos).addScaledVector(dir, 0.2);
        sectionPlane.normal.copy(axis).negate();
        sectionPlane.constant = axis.dot(pos);
        fovT = 36;
      }
      if (!pipeInit.current || !wasPipe.current) {
        pipePos.current.copy(cam.position);
        pipeLook.current.set(c.tx, c.ty, c.tz);
        pipeInit.current = true;
      }
      const l = cinematic ? 2.6 : 14;
      pipePos.current.lerp(desired, 1 - Math.exp(-l * dt));
      pipeLook.current.lerp(look, 1 - Math.exp(-l * dt));
      cam.position.copy(pipePos.current);
      if (cam3 === 'top') cam.up.copy(dir);
      else cam.up.copy(upVec.current);
      cam.lookAt(pipeLook.current);
      c.fov = damp(c.fov, cinematic ? 60 : fovT, 5, dt);
      cam.near = 0.004;
      cam.far = 120;
      wasPipe.current = true;
      c.dist = Math.hypot(pipePos.current.x - c.tx, pipePos.current.y - c.ty, pipePos.current.z - c.tz);
    } else {
      /* ── orbit rig for facility overview ── */
      if (wasPipe.current) {
        wasPipe.current = false;
        slowUntil.current = now + 1.6;
        cam.up.set(0, 1, 0);
      }
      let tx = v.cam.target[0];
      let ty = v.cam.target[1];
      let tz = v.cam.target[2];
      if (v.followRobotId) {
        const sp = samplePose(v.followRobotId);
        if (sp) {
          tx = sp.pos[0];
          ty = sp.pos[1] + 0.2;
          tz = sp.pos[2];
        }
      }
      let da = v.cam.azimuth - c.az;
      da = ((da + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      c.az += da * (1 - Math.exp(-lam * dt));
      c.el = damp(c.el, clamp(v.cam.elevation, CAM_LIMITS.minEl, CAM_LIMITS.maxEl), lam, dt);
      c.dist = damp(c.dist, v.followRobotId ? Math.min(v.cam.distance, 14) : v.cam.distance, lam, dt);
      c.tx = damp(c.tx, tx, v.followRobotId ? 9 : lam, dt);
      c.ty = damp(c.ty, ty, lam, dt);
      c.tz = damp(c.tz, tz, v.followRobotId ? 9 : lam, dt);
      c.fov = damp(c.fov, v.cam.fov, 4, dt);
      const ce = Math.cos(c.el);
      cam.position.set(c.tx + c.dist * Math.sin(c.az) * ce, c.ty + c.dist * Math.sin(c.el), c.tz + c.dist * Math.cos(c.az) * ce);
      cam.up.set(0, 1, 0);
      cam.lookAt(c.tx, c.ty, c.tz);
      cam.near = Math.max(0.05, c.dist * 0.02);
      cam.far = 300;
      sectionPlane.constant = 1e6;
    }
    cam.fov = c.fov;

    // safe-area offset: keep the subject inside the free region between the UI panels
    const W = size.width;
    const H = size.height;
    const freeCenterX = (v.insets.left + (W - v.insets.right)) / 2;
    const freeCenterY = (v.insets.top + (H - v.insets.bottom)) / 2;
    c.ox = damp(c.ox, W / 2 - freeCenterX, 6, dt);
    c.oy = damp(c.oy, H / 2 - freeCenterY, 6, dt);
    if (Math.abs(c.ox) > 0.5 || Math.abs(c.oy) > 0.5) cam.setViewOffset(W, H, c.ox, c.oy, W, H);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
  });
  return null;
}
