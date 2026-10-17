import * as THREE from 'three';
import { mergeParts, xf } from './merge';
import { C } from './theme';

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

export interface OutrigKit {
  /** merged, never-moving relative to the chassis */
  static: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material }>;
  turret: THREE.BufferGeometry;
  turretMat: THREE.Material;
  mast: THREE.BufferGeometry; // unit height 0.6, scaled in y
  mastMat: THREE.Material;
  mast2: THREE.BufferGeometry;
  mast2Mat: THREE.Material;
  armBar: THREE.BufferGeometry; // unit height 0.5, scaled in y
  armBarMat: THREE.Material;
  toolHead: THREE.BufferGeometry;
  toolHeadMat: THREE.Material;
  toolBasket: THREE.BufferGeometry;
  toolClamp: THREE.BufferGeometry;
  toolBox: THREE.BufferGeometry;
  toolBasketMat: THREE.Material;
  toolClampMat: THREE.Material;
  toolBoxMat: THREE.Material;
  beacon: THREE.BufferGeometry;
  beaconMat: THREE.MeshBasicMaterial;
}

let outrig: OutrigKit | null = null;

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
  // rear tool cradle
  add(cyl(0.05, 0.045, 0.1, 12), xf(-0.14, 0.46, -0.34), '#8d97a8', 'metal');
  add(new THREE.TorusGeometry(0.045, 0.013, 8, 16), xf(0.02, 0.45, -0.34, Math.PI / 2, 0, 0), C.outrig, 'paint');
  add(box(0.1, 0.07, 0.08), xf(0.17, 0.455, -0.34), '#3d6fb6', 'paint');
  // sensor mast + lidar head (rotating a cylinder about its own axis is invisible)
  add(cyl(0.012, 0.012, 0.3, 8), xf(0, 0.54, 0.34), '#59606e', 'metal');
  add(cyl(0.05, 0.05, 0.05, 14), xf(0, 0.72, 0.34), '#1f242c', 'metal');
  const g = bucketGeos(P);
  const stat: OutrigKit['static'] = [];
  for (const f of ['paint', 'metal', 'rubber', 'glow'] as const) if (g[f]) stat.push({ geo: g[f]!, mat: mats[f] });

  const mk = (hex: string, r: number, m: number) => new THREE.MeshStandardMaterial({ color: hex, roughness: r, metalness: m });
  const toolHead = mergeParts([
    { geo: box(0.09, 0.05, 0.07) },
    { geo: box(0.014, 0.05, 0.05), m: xf(-0.035, -0.045, 0) },
    { geo: box(0.014, 0.05, 0.05), m: xf(0.035, -0.045, 0) },
  ]);
  outrig = {
    static: stat,
    turret: cyl(0.15, 0.17, 0.08, 18),
    turretMat: mk('#2c323c', 0.4, 0.6),
    mast: box(0.1, 0.6, 0.1),
    mastMat: mk('#d6dae2', 0.4, 0.5),
    mast2: box(0.075, 0.08, 0.075),
    mast2Mat: mk('#8993a3', 0.4, 0.7),
    armBar: box(0.05, 0.5, 0.05),
    armBarMat: mk(C.outrig, 0.4, 0.4),
    toolHead,
    toolHeadMat: mk('#34393f', 0.4, 0.7),
    toolBasket: (() => {
      const g2 = cyl(0.06, 0.05, 0.14, 12);
      g2.translate(0, -0.1, 0);
      return g2;
    })(),
    toolClamp: (() => {
      const g2 = new THREE.TorusGeometry(0.08, 0.02, 8, 18);
      g2.rotateX(Math.PI / 2);
      g2.translate(0, -0.1, 0);
      return g2;
    })(),
    toolBox: (() => {
      const g2 = box(0.11, 0.1, 0.08);
      g2.translate(0, -0.09, 0);
      return g2;
    })(),
    toolBasketMat: (() => {
      const m = mk('#9aa3b2', 0.4, 0.8);
      m.side = THREE.DoubleSide;
      return m;
    })(),
    toolClampMat: mk(C.outrig, 0.5, 0.5),
    toolBoxMat: mk('#3d6fb6', 0.5, 0.4),
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
