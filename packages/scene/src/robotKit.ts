import * as THREE from 'three';
import { mergeParts, xf } from './merge';
import { C } from './theme';
import { ARM_DIMS } from './armKinematics';

/**
 * Shared robot assets: geometry and materials are built ONCE for the whole fleet (16 robots must not own 16 copies).
 * Static parts are merged into a few vertex-coloured meshes grouped by surface finish; only genuinely animated
 * parts (turret, telescoping mast, arm, bristles) stay separate and are drawn through InstancedMesh.
 */

type RGB = [number, number, number];
const rgb = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

interface Piece {
  geo: THREE.BufferGeometry;
  m: THREE.Matrix4;
  color: string;
  /** finish bucket */
  f: 'paint' | 'metal' | 'rubber' | 'glow';
}

const FINISH = {
  paint: { roughness: 0.45, metalness: 0.28 },
  metal: { roughness: 0.38, metalness: 0.7 },
  rubber: { roughness: 0.85, metalness: 0.0 },
} as const;

function bucketGeos(pieces: Piece[]) {
  const out: Partial<Record<Piece['f'], THREE.BufferGeometry>> = {};
  for (const f of ['paint', 'metal', 'rubber', 'glow'] as const) {
    const ps = pieces.filter((p) => p.f === f);
    if (!ps.length) continue;
    out[f] = mergeParts(ps.map((p) => ({ geo: p.geo, m: p.m, c: rgb(p.color) })));
    ps.forEach((p) => p.geo.dispose());
  }
  return out;
}

const mats = {
  paint: new THREE.MeshStandardMaterial({ vertexColors: true, ...FINISH.paint }),
  metal: new THREE.MeshStandardMaterial({ vertexColors: true, ...FINISH.metal }),
  rubber: new THREE.MeshStandardMaterial({ vertexColors: true, ...FINISH.rubber }),
  glow: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
};
export const kitMaterials = mats;

const cyl = (rt: number, rb: number, h: number, seg = 14) => new THREE.CylinderGeometry(rt, rb, h, seg);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

/* ───────────────────────────── OUTRIG ───────────────────────────── */

export interface ArmPartKit {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
}

export interface OutrigKit {
  /** merged, never-moving relative to the chassis */
  static: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material }>;
  /**
   * Articulated arm parts, authored in the backend's sim axes (link along local +z) and placed by armKinematics.armFK.
   * Order matches armKinematics.PART: l1 l2 l3 l4 l5 palm fingerL fingerR, then the end-effector triad and a held object.
   */
  arm: { l1: ArmPartKit; l2: ArmPartKit; l3: ArmPartKit; l4: ArmPartKit; l5: ArmPartKit; palm: ArmPartKit; finger: ArmPartKit; ee: ArmPartKit; held: ArmPartKit };
  beacon: THREE.BufferGeometry;
  beaconMat: THREE.MeshBasicMaterial;
}

let outrig: OutrigKit | null = null;

/** CylinderGeometry is y-up; arm links run along local +z */
function zCyl(r: number, h: number, seg = 18, zc = 0) {
  const g = new THREE.CylinderGeometry(r, r, h, seg);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, zc);
  return g;
}
function zCapsule(r: number, len: number) {
  const g = new THREE.CapsuleGeometry(r, len, 6, 14);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, len / 2);
  return g;
}

export function outrigKit(): OutrigKit {
  if (outrig) return outrig;
  const P: Piece[] = [];
  const add = (geo: THREE.BufferGeometry, m: THREE.Matrix4, color: string, f: Piece['f']) => P.push({ geo, m, color, f });
  add(box(0.62, 0.2, 0.92), xf(0, 0.27, 0), '#e8eaef', 'paint');
  add(box(0.6, 0.1, 0.05), xf(0, 0.2, 0.47), '#20242b', 'metal');
  add(box(0.52, 0.025, 0.8), xf(0, 0.372, 0), C.outrig, 'paint');
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      // wheels are plain cylinders: spinning them is invisible, so they are static geometry
      add(cyl(0.15, 0.15, 0.1, 20), xf(sx * 0.36, 0.15, sz * 0.32, 0, 0, Math.PI / 2), '#14171c', 'rubber');
      add(cyl(0.07, 0.07, 0.012, 14), xf(sx * 0.415, 0.15, sz * 0.32, 0, 0, Math.PI / 2), '#9aa3b2', 'metal');
    }
  add(box(0.44, 0.03, 0.012), xf(0, 0.3, 0.465), '#f4f7ff', 'glow');
  add(box(0.66, 0.06, 0.06), xf(0, 0.1, 0.5), '#14181f', 'metal');
  // shoulder pedestal ring where the arm leaves the deck (the arm origin is the backend's mount point)
  add(cyl(0.085, 0.095, 0.03, 20), xf(0, 0.392, 0.16), '#2c323c', 'metal');
  // sensor mast + lidar head (rotating a cylinder about its own axis is invisible)
  add(cyl(0.012, 0.012, 0.3, 8), xf(0, 0.54, 0.34), '#59606e', 'metal');
  add(cyl(0.05, 0.05, 0.05, 14), xf(0, 0.72, 0.34), '#1f242c', 'metal');
  const g = bucketGeos(P);
  const stat: OutrigKit['static'] = [];
  for (const f of ['paint', 'metal', 'rubber', 'glow'] as const) if (g[f]) stat.push({ geo: g[f]!, mat: mats[f] });

  const mk = (hex: string, r: number, m: number) => new THREE.MeshStandardMaterial({ color: hex, roughness: r, metalness: m });
  const D = ARM_DIMS;
  const dark = mk('#4d596b', 0.4, 0.6);
  // each link carries a barrel at its own joint (pitch joints turn about local y, the cylinder's native axis)
  const l2 = mergeParts([
    { geo: zCapsule(D.l2.r, D.l2.len), c: rgb('#d1d9e6') },
    { geo: new THREE.CylinderGeometry(D.l2.r * 1.15, D.l2.r * 1.15, D.l2.r * 2.6, 16), c: rgb('#4d596b') },
  ]);
  const l3 = mergeParts([
    { geo: zCapsule(D.l3.r, D.l3.len), c: rgb('#d1d9e6') },
    { geo: new THREE.CylinderGeometry(D.l3.r * 1.2, D.l3.r * 1.2, D.l3.r * 2.8, 16), c: rgb('#4d596b') },
  ]);
  const triad = mergeParts([
    { geo: new THREE.BoxGeometry(0.05, 0.004, 0.004), m: xf(0.025, 0, 0), c: rgb('#ff5d5d') },
    { geo: new THREE.BoxGeometry(0.004, 0.05, 0.004), m: xf(0, 0.025, 0), c: rgb('#5dff9a') },
    { geo: new THREE.BoxGeometry(0.004, 0.004, 0.05), m: xf(0, 0, 0.025), c: rgb('#5d9bff') },
    { geo: new THREE.SphereGeometry(0.009, 10, 8), c: rgb('#ffffff') },
  ]);
  const vcMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.5 });
  outrig = {
    static: stat,
    arm: {
      l1: { geo: zCyl(D.l1.r, D.l1.h), mat: dark },
      l2: { geo: l2, mat: vcMat },
      l3: { geo: l3, mat: vcMat },
      l4: { geo: zCyl(D.l4.r, D.l4.h), mat: dark },
      l5: { geo: zCyl(D.l5.r, D.l5.h), mat: dark },
      palm: { geo: new THREE.BoxGeometry(D.palm[0], D.palm[1], D.palm[2]), mat: mk('#333f52', 0.4, 0.6) },
      finger: { geo: new THREE.BoxGeometry(D.finger.half[0] * 2, D.finger.half[1] * 2, D.finger.half[2] * 2), mat: mk('#ebf0f5', 0.35, 0.5) },
      ee: { geo: triad, mat: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, depthTest: false, transparent: true }) },
      // the backend's strainer cartridge (r 22 mm, h 90 mm), axis along the gripper's local z
      held: { geo: zCyl(0.022, 0.09, 16), mat: mk('#1fbfea', 0.35, 0.5) },
    },
    beacon: new THREE.SphereGeometry(0.035, 10, 8),
    beaconMat: new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
  };
  return outrig;
}

/* ───────────────────────────── INPIPE crawler ───────────────────────────── */

export interface CrawlerKit {
  body: THREE.BufferGeometry;
  bodyMat: THREE.Material;
  led: THREE.BufferGeometry;
  ledWarm: THREE.MeshBasicMaterial;
  ledWhite: THREE.MeshBasicMaterial;
  status: THREE.BufferGeometry;
  /** [moving on, moving off, idle on, idle off] */
  statusMats: THREE.MeshBasicMaterial[];
  brush: THREE.BufferGeometry;
  brushMat: THREE.Material;
  hit: THREE.BufferGeometry;
  hitMat: THREE.Material;
}

let crawler: CrawlerKit | null = null;

export function crawlerKit(): CrawlerKit {
  if (crawler) return crawler;
  const R = Math.PI / 2;
  const P: Piece[] = [];
  const add = (geo: THREE.BufferGeometry, m: THREE.Matrix4, color: string, f: Piece['f']) => P.push({ geo, m, color, f });
  add(cyl(0.029, 0.029, 0.12, 18), xf(0, 0, 0, R, 0, 0), '#59626f', 'metal');
  add(cyl(0.0305, 0.0305, 0.012, 18), xf(0, 0, 0.012, R, 0, 0), '#6f7886', 'metal');
  add(cyl(0.031, 0.027, 0.04, 18), xf(0, 0, 0.078, R, 0, 0), '#1c2027', 'metal');
  add(cyl(0.014, 0.014, 0.004, 16), xf(0, 0, 0.1, R, 0, 0), '#05070a', 'metal');
  add(cyl(0.025, 0.025, 0.07, 16), xf(0, 0, -0.09, R, 0, 0), '#454d59', 'metal');
  add(cyl(0.019, 0.019, 0.02, 12), xf(0, 0, -0.056, R, 0, 0), '#9aa3b2', 'metal');
  const g = bucketGeos(P);
  const body = g.metal!;
  const bristles = mergeParts(
    Array.from({ length: 14 }, (_, i) => {
      const a = (i / 14) * Math.PI * 2;
      return { geo: box(0.014, 0.003, 0.03), m: xf(0.018 * Math.cos(a), 0.018 * Math.sin(a), 0.01, 0, 0, a), c: rgb('#d0a85a') as RGB };
    }),
  );
  const status = new THREE.SphereGeometry(0.004, 8, 6);
  status.translate(0, 0.0262, -0.09);
  const ledGeo = new THREE.RingGeometry(0.016, 0.026, 28);
  ledGeo.translate(0, 0, 0.0995);
  const sm = (c: string) => new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
  crawler = {
    body,
    bodyMat: mats.metal,
    led: ledGeo,
    ledWarm: sm('#ffb871'),
    ledWhite: sm('#fff6e0'),
    status,
    statusMats: [sm('#33ffa8'), sm('#0a3a28'), sm(C.accent), sm('#16413c')],
    brush: bristles,
    brushMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }),
    hit: new THREE.SphereGeometry(0.25, 8, 6),
    hitMat: (() => {
      const m = new THREE.MeshBasicMaterial();
      m.visible = false; // raycastable, never drawn
      return m;
    })(),
  };
  return crawler;
}

/** spring-arm sets are cached by bore (rounded to 0.5 mm): crawlers in the same bore share one geometry */
const armCache = new Map<number, THREE.BufferGeometry>();
export function crawlerArms(boreR: number): THREE.BufferGeometry {
  const reach = Math.max(boreR - 0.004, 0.04);
  const key = Math.round(reach * 2000);
  let g = armCache.get(key);
  if (g) return g;
  const parts: Array<{ geo: THREE.BufferGeometry; m: THREE.Matrix4; c: RGB }> = [];
  const bar = rgb('#aab3c2');
  const wheel = rgb('#14171c');
  for (let k = 0; k < 3; k++) {
    const rot = (k * Math.PI * 2) / 3 + Math.PI / 6;
    const Rz = new THREE.Matrix4().makeRotationZ(rot);
    for (const z of [0.045, -0.075]) {
      parts.push({ geo: box(Math.max(reach - 0.028, 0.004), 0.004, 0.004), m: new THREE.Matrix4().multiplyMatrices(Rz, xf((0.028 + reach) / 2, 0, z)), c: bar });
      parts.push({ geo: cyl(0.0095, 0.0095, 0.012, 12), m: new THREE.Matrix4().multiplyMatrices(Rz, xf(reach, 0, z)), c: wheel });
    }
  }
  g = mergeParts(parts);
  armCache.set(key, g);
  return g;
}

/** overview-scale locator marker geometry (billboarded) */
export const markerGeo = {
  crawlerRing: new THREE.RingGeometry(0.22, 0.27, 40),
  outrigRing: new THREE.RingGeometry(0.3, 0.36, 36),
  dot: new THREE.CircleGeometry(0.07, 20),
  beam: (() => {
    const g = new THREE.PlaneGeometry(0.012, 1.3);
    g.translate(0, 0.9, 0);
    return g;
  })(),
  hit: new THREE.CircleGeometry(0.34, 12),
};
