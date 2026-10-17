import * as THREE from 'three';
import type { CameraMountConfig } from './MountedCameraTransforms';

// three-bound half of the camera-mount helpers (viewer chunk only); the pure mount table lives in MountedCameraTransforms.ts so the shell never loads three.
const _mountQuat = new THREE.Quaternion();
const _mountEuler = new THREE.Euler();
const _gimbalQuat = new THREE.Quaternion();
const _gimbalEuler = new THREE.Euler();
const _localOffset = new THREE.Vector3();

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
