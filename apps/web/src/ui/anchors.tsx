import { useEffect, useRef, type ReactNode } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { Vec3 } from '@loopkeeper/core/contracts';

/**
 * DOM labels pinned to 3D points.
 * React renders the label content (outside the canvas); a tiny projector inside the canvas
 * writes each label's screen position straight to the DOM every frame — no React re-render,
 * no <Html> portals, nothing to unmount during a canvas commit.
 */
interface Anchor {
  el: HTMLElement;
  get: () => Vec3 | null;
  /** higher wins when two labels would overlap on screen (0 = ambient zone name, 10 = incident pin, 20 = selected / hovered tag) */
  priority: () => number;
  culled: boolean;
  shown: boolean;
}
const anchors = new Set<Anchor>();

export function AnchoredLabel({ get, children, className, priority = 0 }: { get: () => Vec3 | null; children: ReactNode; className?: string; priority?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const getRef = useRef(get);
  getRef.current = get;
  const prioRef = useRef(priority);
  prioRef.current = priority;
  useEffect(() => {
    const a: Anchor = { el: ref.current!, get: () => getRef.current(), priority: () => prioRef.current, culled: false, shown: false };
    anchors.add(a);
    return () => void anchors.delete(a);
  }, []);
  return (
    <div ref={ref} className={`anchor ${className ?? ''}`} style={{ opacity: 0 }}>
      {children}
    </div>
  );
}

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
