import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * Where the free stage is, between the fleet drawer and the inspector, in the coordinate space of the HUD wrapper (`.map-hudwrap`).
 * Everything that floats over the stage (control strip, route strip, badges, View dock) is laid out inside [left, width - right] so it
 * can never sit on a drawer. Measured from the real drawers (`[data-inset=left|right]`), so collapsed drawers and the phone layout
 * (drawers in a column beside / below the stage, where they do not intersect the HUD) are handled without special cases.
 */
export interface StageInsets {
  left: number;
  right: number;
}
export const useStageInsets = create<StageInsets>()(() => ({ left: 0, right: 0 }));

export function measureStage(hud: DOMRect, drawers: DOMRect[]): StageInsets {
  let left = 0;
  let right = 0;
  const mid = hud.left + hud.width / 2;
  for (const d of drawers) {
    if (d.width < 2 || d.height < 2) continue;
    const overlapsX = d.right > hud.left && d.left < hud.right;
    const overlapsY = d.bottom > hud.top && d.top < hud.bottom;
    if (!overlapsX || !overlapsY) continue;
    if (d.left + d.width / 2 < mid) left = Math.max(left, d.right - hud.left);
    else right = Math.max(right, hud.right - d.left);
  }
  return { left: Math.max(0, Math.round(left)), right: Math.max(0, Math.round(right)) };
}

/** Mount once in the Map tab. Re-measures on resize, on drawer size changes and on a slow tick (collapse / expand animations). */
export function useStageInsetsProbe() {
  useEffect(() => {
    const measure = () => {
      const hud = document.querySelector<HTMLElement>('.map-hudwrap');
      if (!hud) return;
      const rects = [...document.querySelectorAll<HTMLElement>('.map-tab-container [data-inset="left"], .map-tab-container [data-inset="right"]')].map((e) => e.getBoundingClientRect());
      const next = measureStage(hud.getBoundingClientRect(), rects);
      const cur = useStageInsets.getState();
      if (next.left !== cur.left || next.right !== cur.right) useStageInsets.setState(next);
    };
    measure();
    const t = setInterval(measure, 250);
    window.addEventListener('resize', measure);
    return () => {
      clearInterval(t);
      window.removeEventListener('resize', measure);
    };
  }, []);
}
