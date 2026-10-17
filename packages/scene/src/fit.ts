import * as THREE from 'three';
import type { Topology, Vec3 } from '@loopkeeper/core/contracts';
import type { CamGoal } from './view';

/**
 * Frame a world-space box inside the part of the canvas that no panel covers.
 *
 * The camera rig keeps a safe-area view offset (it only *shifts* the image), so to make a box fit the free
 * region we solve with an equivalent camera whose aspect and vertical fov match that region. Returns an
 * orbit goal (azimuth/elevation/distance/target) the rig can ease to.
 */
export interface FitOptions {
  /** one or more boxes to keep in frame (several tight boxes beat one loose bounding box) */
  boxes: Array<{ min: Vec3; max: Vec3 }>;
  /** canvas size in CSS px */
  width: number;
  height: number;
  /** pixels covered by panels on each side */
  insets: { left: number; right: number; top: number; bottom: number };
  azimuth?: number;
  elevation?: number;
  fov?: number;
  /** fraction of the free region the box may occupy (0..1) */
  fill?: number;
}

export function fitCamera(o: FitOptions): CamGoal {
  const az = o.azimuth ?? 0.58;
  const el = o.elevation ?? 0.72;
  const fov = o.fov ?? 32;
  const fill = o.fill ?? 0.94;
  const freeW = Math.max(240, o.width - o.insets.left - o.insets.right);
  const freeH = Math.max(200, o.height - o.insets.top - o.insets.bottom);
  const tanHalf = Math.tan((fov * Math.PI) / 360) * (freeH / o.height);
  const effFov = (2 * Math.atan(tanHalf) * 180) / Math.PI;
  const cam = new THREE.PerspectiveCamera(effFov, freeW / freeH, 0.1, 500);
  const corners: THREE.Vector3[] = [];
  const lo3 = new THREE.Vector3(Infinity, Infinity, Infinity);
  const hi3 = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const b of o.boxes) {
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push(new THREE.Vector3(x, y, z));
    lo3.min(new THREE.Vector3(...b.min));
    hi3.max(new THREE.Vector3(...b.max));
  }
  const target = lo3.clone().add(hi3).multiplyScalar(0.5);
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  const v = new THREE.Vector3();
  const extent = (dist: number) => {
    cam.position.copy(target).addScaledVector(dir, dist);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    let mx = 0;
    let cx = 0;
    let cy = 0;
    let minx = 9;
    let maxx = -9;
    let miny = 9;
    let maxy = -9;
    for (const c of corners) {
      v.copy(c).project(cam);
      mx = Math.max(mx, Math.abs(v.x), Math.abs(v.y));
      minx = Math.min(minx, v.x);
      maxx = Math.max(maxx, v.x);
      miny = Math.min(miny, v.y);
      maxy = Math.max(maxy, v.y);
    }
    cx = (minx + maxx) / 2;
    cy = (miny + maxy) / 2;
    return { mx, cx, cy };
  };
  let dist = 30;
  for (let pass = 0; pass < 4; pass++) {
    let lo = 4;
    let hi = 160;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      if (extent(mid).mx > fill) lo = mid;
      else hi = mid;
    }
    dist = hi;
    // recentre: shift the target so the projected box is centred in the free region
    const { cx, cy } = extent(dist);
    const halfH = dist * tanHalf;
    const halfW = halfH * (freeW / freeH);
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    target.addScaledVector(right, cx * halfW).addScaledVector(up, cy * halfH);
  }
  return { azimuth: az, elevation: el, distance: dist, target: [target.x, target.y, target.z], fov };
}

/** Default overview camera: a steep 3/4 view that keeps all five rows / four roads countable. Dashboard, Map and Fit Facility share it. */
export const OVERVIEW_VIEW = { azimuth: 0.2, elevation: 1.15, fov: 32, fill: 0.84 } as const;

/**
 * The whole building (mechanical/CDU bay, both cross-aisles, five rows, four roads) as ONE tight box derived from the
 * backend layout manifest (`facility_layout_v6.hall`), falling back to the interior bounds for older topologies.
 * The outdoor yard and site apron are deliberately NOT part of it, so they can never shrink the hall in the frame.
 * Height stops at the pipe trays (3.4 m): the 6 m shell is hidden or cut down in the overview.
 */
export function overviewBoxes(topo: Topology): Array<{ min: Vec3; max: Vec3 }> {
  const h = (topo as unknown as { facility_layout_v6?: { hall?: { x_min_m: number; x_max_m: number; z_min_m: number; z_max_m: number } } }).facility_layout_v6?.hall;
  if (h) return [{ min: [h.x_min_m, 0, h.z_min_m], max: [h.x_max_m, 3.4, h.z_max_m] }];
  const f = topo.facility;
  return [{ min: f.interior_min, max: [f.interior_max[0], Math.min(f.interior_max[1], 3.6), f.interior_max[2]] as Vec3 }];
}

/** Free region (CSS px) the panels leave in a canvas: same rule the Shell uses for the camera rig's safe area. */
export function measureInsets(): { left: number; right: number; top: number; bottom: number } {
  const W = window.innerWidth;
  const H = window.innerHeight;
  let left = 0;
  let right = 0;
  let bottom = 0;
  let top = 70;
  document.querySelectorAll<HTMLElement>('[data-inset]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const side = el.dataset.inset;
    if (side === 'left') left = Math.max(left, r.right + 8);
    if (side === 'right') right = Math.max(right, W - r.left + 8);
    if (side === 'bottom') bottom = Math.max(bottom, H - r.top + 4);
    if (side === 'top') top = Math.max(top, r.bottom + 6);
  });
  return { left: Math.round(left), right: Math.round(right), top: Math.round(top), bottom: Math.round(bottom) };
}
