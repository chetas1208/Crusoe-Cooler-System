import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { anchors, type Anchor } from './anchors';

// Viewer-chunk half of the label system (needs three + R3F); the DOM half lives in anchors.tsx so the shell never loads 3D just to render labels.
const v = new THREE.Vector3();
let frame = 0;

/** Greedy label culling: highest priority first, a label that would overlap an already placed one is hidden (never stacked on top). */
function cull() {
  const items: Array<{ a: Anchor; r: DOMRect; p: number }> = [];
  for (const a of anchors) {
    if (!a.shown) {
      a.culled = false;
      continue;
    }
    const child = (a.el.firstElementChild as HTMLElement | null) ?? a.el;
    const r = child.getBoundingClientRect();
    if (r.width < 1) continue;
    items.push({ a, r, p: a.priority() });
  }
  items.sort((x, y) => y.p - x.p);
  const placed: DOMRect[] = [];
  for (const it of items) {
    const pad = 4;
    const hit = placed.some((q) => it.r.left < q.right + pad && it.r.right > q.left - pad && it.r.top < q.bottom + pad && it.r.bottom > q.top - pad);
    it.a.culled = hit;
    if (!hit) placed.push(it.r);
  }
}

/** Mount inside <Canvas>. */
export function AnchorProjector() {
  useFrame(({ camera, size }) => {
    frame++;
    for (const a of anchors) {
      const p = a.get();
      if (!p) {
        a.shown = false;
        a.el.style.opacity = '0';
        a.el.style.pointerEvents = 'none';
        continue;
      }
      v.set(p[0], p[1], p[2]).project(camera);
      const visible = v.z < 1 && v.z > -1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15;
      if (!visible) {
        a.shown = false;
        a.el.style.opacity = '0';
        a.el.style.pointerEvents = 'none';
        continue;
      }
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      a.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      a.shown = true;
      a.el.style.opacity = a.culled ? '0' : '1';
      a.el.style.pointerEvents = a.culled ? 'none' : '';
    }
    if (frame % 6 === 0) cull();
  });
  return null;
}
