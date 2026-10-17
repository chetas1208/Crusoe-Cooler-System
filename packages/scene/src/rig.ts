import * as THREE from 'three';

/** Mutable per-frame robot transforms shared between the robot models and the camera rig (no React state). */
export const rig = {
  robots: {} as Record<string, { pos: THREE.Vector3; dir: THREE.Vector3; quat: THREE.Quaternion; valid: boolean }>,
};

export function rigFor(id: string) {
  return (rig.robots[id] ??= { pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), quat: new THREE.Quaternion(), valid: false });
}

/** Section-slice plane: clips the near half of a bore wall so the crawler can be seen in profile. */
export const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 1e6);
