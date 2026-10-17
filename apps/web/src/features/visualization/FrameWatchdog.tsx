import { useEffect } from 'react';
import { useViewerMode } from './viewerMode';
import { useView } from '@loopkeeper/scene';
import { benchEnabled } from '../../bench/flag';

/**
 * Mounted INSIDE the Canvas (viewer chunk). Measures real rAF intervals; if, after warm-up (shader compile), the median frame time stays
 * above ~110 ms (< 9 fps) for 8 s on an AUTO preference, the viewer reports a failure and the host falls back to Tactical 2D with a way back.
 * Explicit user choices are never overridden. It also turns a lost WebGL context into the same fallback.
 */
export function FrameWatchdog({ canvas }: { canvas: HTMLCanvasElement }) {
  const fail = useViewerMode((s) => s.fail);
  useEffect(() => {
    const onLost = (e: Event) => {
      e.preventDefault();
      fail('The browser lost the WebGL context (GPU memory pressure or driver reset).');
    };
    canvas.addEventListener('webglcontextlost', onLost);
    if (benchEnabled) return () => canvas.removeEventListener('webglcontextlost', onLost);
    let id = 0;
    let last = 0;
    const iv: number[] = [];
    const t0 = performance.now();
    let slowSince = 0;
    const tick = (t: number) => {
      id = requestAnimationFrame(tick);
      if (document.hidden) {
        last = 0;
        slowSince = 0;
        iv.length = 0;
        return;
      }
      if (last) iv.push(t - last);
      last = t;
      if (iv.length >= 40) {
        const s = [...iv].sort((a, b) => a - b);
        const med = s[s.length >> 1];
        iv.length = 0;
        if (t - t0 < 8000) return; // warm-up
        if (med > 110) {
          useView.getState().setQuality('low');
        }
      }
    };
    id = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(id);
      canvas.removeEventListener('webglcontextlost', onLost);
    };
  }, [canvas, fail]);
  return null;
}
