import * as THREE from 'three';

export type RobotCameraClass = 'inpipe' | 'outrig';
export type MountedDirection = 'front' | 'rear' | 'left' | 'right' | 'top';

export interface CameraMountConfig {
  id: MountedDirection;
  label: string;
  viewportBadge: string;
  positionLocal: [number, number, number];
  rotationEuler: [number, number, number]; // [x, y, z] in radians
  fixed: boolean;
  fov: number;
  gimbalLimits: {
    minYaw: number;
    maxYaw: number;
    minPitch: number;
    maxPitch: number;
  };
}

const DEG = Math.PI / 180;

/**
 * Authoritative virtual camera mount definitions conforming to Section A3 and F.
 * Local frame convention:
 * +Z is Forward
 * +Y is Up
 * +X is Right
 */
export const CAMERA_MOUNTS: Record<RobotCameraClass, Record<MountedDirection, CameraMountConfig>> = {
  inpipe: {
    front: {
      id: 'front',
      label: 'Front POV',
      viewportBadge: 'FRONT · Downstream',
      positionLocal: [0, 0, 0.105],
      rotationEuler: [0, 0, 0],
      fixed: false,
      fov: 82,
      gimbalLimits: { minYaw: -35 * DEG, maxYaw: 35 * DEG, minPitch: -20 * DEG, maxPitch: 20 * DEG },
    },
    rear: {
      id: 'rear',
      label: 'Rear POV',
      viewportBadge: 'REAR · Upstream',
      positionLocal: [0, 0.02, -0.09],
      rotationEuler: [0, Math.PI, 0],
      fixed: false,
      fov: 80,
      gimbalLimits: { minYaw: -30 * DEG, maxYaw: 30 * DEG, minPitch: -15 * DEG, maxPitch: 15 * DEG },
    },
    left: {
      id: 'left',
      label: 'Left Wall',
      viewportBadge: 'LEFT · Lateral Bore',
      positionLocal: [-0.028, 0, 0.02],
      rotationEuler: [0, Math.PI / 2, 0],
      fixed: true,
      fov: 75,
      gimbalLimits: { minYaw: 0, maxYaw: 0, minPitch: 0, maxPitch: 0 },
    },
    right: {
      id: 'right',
      label: 'Right Wall',
      viewportBadge: 'RIGHT · Lateral Bore',
      positionLocal: [0.028, 0, 0.02],
      rotationEuler: [0, -Math.PI / 2, 0],
      fixed: true,
      fov: 75,
      gimbalLimits: { minYaw: 0, maxYaw: 0, minPitch: 0, maxPitch: 0 },
    },
    top: {
      id: 'top',
      label: 'Top Crown',
      viewportBadge: 'TOP · Crown Bore View',
      positionLocal: [0, 0.028, 0.04],
      rotationEuler: [-Math.PI / 2, 0, 0],
      fixed: true,
      fov: 75,
      gimbalLimits: { minYaw: 0, maxYaw: 0, minPitch: 0, maxPitch: 0 },
    },
  },
  outrig: {
    front: {
      id: 'front',
      label: 'Driver Front',
      viewportBadge: 'FRONT · Driver Guidance',
      positionLocal: [0, 0.44, 0.48],
      rotationEuler: [0, 0, 0],
      fixed: false,
      fov: 78,
      gimbalLimits: { minYaw: -50 * DEG, maxYaw: 50 * DEG, minPitch: -25 * DEG, maxPitch: 25 * DEG },
    },
    rear: {
      id: 'rear',
      label: 'Reverse Backing',
      viewportBadge: 'REAR · Reverse Assist',
      positionLocal: [0, 0.44, -0.45],
      rotationEuler: [0, Math.PI, 0],
      fixed: false,
      fov: 78,
      gimbalLimits: { minYaw: -40 * DEG, maxYaw: 40 * DEG, minPitch: -20 * DEG, maxPitch: 20 * DEG },
    },
    left: {
      id: 'left',
      label: 'Left Pod',
      viewportBadge: 'LEFT · Lateral Pod',
      positionLocal: [-0.32, 0.42, 0.0],
      rotationEuler: [0, Math.PI / 2, 0],
      fixed: true,
      fov: 72,
      gimbalLimits: { minYaw: 0, maxYaw: 0, minPitch: 0, maxPitch: 0 },
    },
    right: {
      id: 'right',
      label: 'Right Pod',
      viewportBadge: 'RIGHT · Lateral Pod',
      positionLocal: [0.32, 0.42, 0.0],
      rotationEuler: [0, -Math.PI / 2, 0],
      fixed: true,
      fov: 72,
      gimbalLimits: { minYaw: 0, maxYaw: 0, minPitch: 0, maxPitch: 0 },
    },
    top: {
      id: 'top',
      label: 'Boom Tool Cam',
      viewportBadge: 'TOP · Manipulator Boom',
      positionLocal: [0, 1.45, 0.35],
      rotationEuler: [-Math.PI / 4, 0, 0],
      fixed: true,
      fov: 65,
      gimbalLimits: { minYaw: 0, maxYaw: 0, minPitch: 0, maxPitch: 0 },
    },
  },
};

const _mountQuat = new THREE.Quaternion();
const _mountEuler = new THREE.Euler();
const _gimbalQuat = new THREE.Quaternion();
const _gimbalEuler = new THREE.Euler();
const _localOffset = new THREE.Vector3();

export function getCameraMount(klass: RobotCameraClass, dir: MountedDirection): CameraMountConfig {
  return CAMERA_MOUNTS[klass][dir];
}

/**
 * Computes world camera position and quaternion:
 * cameraWorldMatrix = robotWorldMatrix * cameraMountLocalMatrix * gimbalRotationMatrix
 */
export function computeMountTransform(
  robotPos: THREE.Vector3,
  robotQuat: THREE.Quaternion,
  mount: CameraMountConfig,
  gimbalYaw = 0,
  gimbalPitch = 0,
  outPos = new THREE.Vector3(),
  outQuat = new THREE.Quaternion(),
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  _localOffset.set(...mount.positionLocal);
  _localOffset.applyQuaternion(robotQuat);
  outPos.copy(robotPos).add(_localOffset);

  _mountEuler.set(mount.rotationEuler[0], mount.rotationEuler[1], mount.rotationEuler[2], 'YXZ');
  _mountQuat.setFromEuler(_mountEuler);

  if (!mount.fixed && (gimbalYaw !== 0 || gimbalPitch !== 0)) {
    const lim = mount.gimbalLimits;
    const clampedYaw = Math.max(lim.minYaw, Math.min(lim.maxYaw, gimbalYaw));
    const clampedPitch = Math.max(lim.minPitch, Math.min(lim.maxPitch, gimbalPitch));
    _gimbalEuler.set(clampedPitch, clampedYaw, 0, 'YXZ');
    _gimbalQuat.setFromEuler(_gimbalEuler);
    _mountQuat.multiply(_gimbalQuat);
  }

  outQuat.copy(robotQuat).multiply(_mountQuat);
  return { position: outPos, quaternion: outQuat };
}
