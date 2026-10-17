import { useEffect, useRef, type ReactNode } from 'react';
import type { Vec3 } from '@loopkeeper/core/contracts';

/**
 * DOM labels pinned to 3D points.
 * React renders the label content (outside the canvas); a tiny projector inside the canvas
 * writes each label's screen position straight to the DOM every frame — no React re-render,
 * no <Html> portals, nothing to unmount during a canvas commit.
 */
export interface Anchor {
  el: HTMLElement;
  get: () => Vec3 | null;
  /** higher wins when two labels would overlap on screen (0 = ambient zone name, 10 = incident pin, 20 = selected / hovered tag) */
  priority: () => number;
  culled: boolean;
  shown: boolean;
}
export const anchors = new Set<Anchor>();

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
