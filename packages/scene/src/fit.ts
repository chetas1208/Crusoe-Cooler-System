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
  // Plain-math perspective projection (exactly what a THREE.PerspectiveCamera + Vector3.project gives for x/y NDC), so this module -
  // and therefore the view store that imports it - never pulls three.js into the first-paint bundle.
  type V = [number, number, number];
  const norm = (a: V): V => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const corners: V[] = [];
  const lo3: V = [Infinity, Infinity, Infinity];
  const hi3: V = [-Infinity, -Infinity, -Infinity];
  for (const b of o.boxes) {
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push([x, y, z]);
    for (let k = 0; k < 3; k++) {
      lo3[k] = Math.min(lo3[k], b.min[k]);
      hi3[k] = Math.max(hi3[k], b.max[k]);
    }
  }
  const target: V = [(lo3[0] + hi3[0]) / 2, (lo3[1] + hi3[1]) / 2, (lo3[2] + hi3[2]) / 2];
  const dir: V = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  const aspect = freeW / freeH;
  // camera basis for lookAt(target) from target + dir*dist with world up +y (dir is the camera's +z axis)
  const bz = norm(dir);
  const bx = norm(cross([0, 1, 0], bz));
  const by = cross(bz, bx);
  const extent = (dist: number) => {
    const p: V = [target[0] + dir[0] * dist, target[1] + dir[1] * dist, target[2] + dir[2] * dist];
    let mx = 0;
    let minx = 9;
    let maxx = -9;
    let miny = 9;
    let maxy = -9;
    for (const c of corners) {
      const d: V = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
      const w = -(d[0] * bz[0] + d[1] * bz[1] + d[2] * bz[2]);
      const nx = (d[0] * bx[0] + d[1] * bx[1] + d[2] * bx[2]) / (w * tanHalf * aspect);
      const ny = (d[0] * by[0] + d[1] * by[1] + d[2] * by[2]) / (w * tanHalf);
      mx = Math.max(mx, Math.abs(nx), Math.abs(ny));
      minx = Math.min(minx, nx);
      maxx = Math.max(maxx, nx);
      miny = Math.min(miny, ny);
      maxy = Math.max(maxy, ny);
    }
    return { mx, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 };
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
    const halfW = halfH * aspect;
    for (let k = 0; k < 3; k++) target[k] += bx[k] * cx * halfW + by[k] * cy * halfH;
  }
  return { azimuth: az, elevation: el, distance: dist, target: [target[0], target[1], target[2]], fov };
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
  // phone layout: panels live BELOW the stage (normal flow), so the stage is the whole canvas under the compact top bar
  if (typeof document !== 'undefined' && document.documentElement.dataset.phone === '1') return { left: 0, right: 0, top: 64, bottom: 0 };
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
