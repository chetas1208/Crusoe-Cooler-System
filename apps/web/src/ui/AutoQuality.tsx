import { useEffect } from 'react';
import { useView } from '@loopkeeper/scene';
import type { QualityTier } from '@loopkeeper/scene';

/**
 * Preset "Auto": steps the *rendering* tier (DPR, shadows, pipe tessellation, cosmetics) down when the measured
 * frame time overruns the display cadence, and back up only after a long stable stretch (hysteresis).
 * It reads real requestAnimationFrame intervals; it never touches simulated robots, topology or physics, and it
 * shows no FPS number anywhere.
 */
const ORDER: QualityTier[] = ['high', 'medium', 'low'];
const WINDOW = 150; // frames
const WARMUP_MS = 6000; // shader compilation / first-frame spikes are not an overrun
const DOWN_HOLD_MS = 2500; // sustained overrun before stepping down
const UP_HOLD_MS = 15000; // sustained headroom before stepping up
const COOLDOWN_MS = 20000; // minimum time between any two changes

const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];

export function AutoQuality() {
  const preset = useView((s) => s.qualityPreset);
  useEffect(() => {
    if (preset !== 'auto') return;
    let id = 0;
    let last = 0;
    const iv: number[] = [];
    const t0 = performance.now();
    let cadence = 16.7; // best sustained interval seen (the display's cadence when the GPU keeps up)
    let overSince = 0;
    let okSince = 0;
    let changedAt = t0;
    let evalAt = t0;
    const tick = (t: number) => {
      id = requestAnimationFrame(tick);
      if (document.hidden) {
        last = 0;
        return;
      }
      if (last) {
        const d = t - last;
        if (d < 250) iv.push(d); // tab switches / debugger pauses are not render cost
        if (iv.length > WINDOW) iv.shift();
      }
      last = t;
      if (t - evalAt < 500 || iv.length < 60 || t - t0 < WARMUP_MS) return;
      evalAt = t;
      const s = [...iv].sort((a, b) => a - b);
      const p50 = q(s, 50);
      const p95 = q(s, 95);
      cadence = Math.max(4.5, Math.min(cadence, p50));
      const cur = useView.getState().quality;
      const i = ORDER.indexOf(cur);
      const over = p95 > Math.max(1.4 * cadence, 9);
      const ok = p95 < 1.12 * cadence + 0.5;
      if (over) {
        overSince ||= t;
        okSince = 0;
      } else if (ok) {
        okSince ||= t;
        overSince = 0;
      } else {
        overSince = 0;
        okSince = 0;
      }
      if (t - changedAt < COOLDOWN_MS) return;
      if (over && t - overSince > DOWN_HOLD_MS && i < ORDER.length - 1) {
        useView.getState().setQuality(ORDER[i + 1]);
        changedAt = t;
        overSince = 0;
        iv.length = 0;
      } else if (ok && t - okSince > UP_HOLD_MS && i > 0) {
        useView.getState().setQuality(ORDER[i - 1]);
        changedAt = t;
        okSince = 0;
        iv.length = 0;
      }
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [preset]);
  return null;
}
