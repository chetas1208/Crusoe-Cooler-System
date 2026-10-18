import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useWorld } from '@loopkeeper/core/store';
import { useView } from '../view';

/**
 * The key light's shadow map does not depend on the camera: it only changes when a caster moves, appears or disappears.
 * three.js re-renders every caster into it on every frame (about 15 % of all draw calls here, plus the caster vertices), even when
 * all 18 robots are docked. This takes over that decision:
 *
 *  - robots moving (pose signature changed in the last 400 ms)  -> refresh at `activeHz` (30)
 *  - nothing moving                                              -> refresh at `idleHz` (4), which still picks up spinning fans,
 *                                                                  pump vibration and layer / relevance fades within 250 ms
 *  - view changes that add or remove casters (layers, mode, x-ray, quality tier) -> refresh on the next frame
 *
 * The map is never skipped on its first frames, and `autoUpdate` is restored when the governor unmounts.
 * `?shadowhz=0` in the URL (or localStorage lk.shadowhz=0) turns it off (every frame, the three.js default) for A/B measurements.
 */
export const SHADOW_ACTIVE_HZ = 30;
export const SHADOW_IDLE_HZ = 4;

function configured(): number | null {
  try {
    const q = new URLSearchParams(location.search).get('shadowhz') ?? localStorage.getItem('lk.shadowhz');
    if (q == null) return null;
    const n = Number(q);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** quantised robot pose signature: changes when any robot moved by >= 1 mm or turned by >= 0.001 rad */
export function robotSignature(robots: Record<string, { pose: { position_xyz_m: [number, number, number]; yaw_rad: number } }>): number {
  let h = 0;
  for (const id in robots) {
    const p = robots[id].pose;
    h = (h * 31 + Math.round(p.position_xyz_m[0] * 1000) * 7 + Math.round(p.position_xyz_m[1] * 1000) * 11 + Math.round(p.position_xyz_m[2] * 1000) * 13 + Math.round(p.yaw_rad * 1000) * 17) % 1_000_000_007;
  }
  return h;
}

export function ShadowGovernor({ enabled = true }: { enabled?: boolean }) {
  const gl = useThree((s) => s.gl);
  const dirty = useRef(4); // frames still to force: a tier change disposes the map a React commit later
  const since = useRef(0);
  const sig = useRef(-1);
  const sigAt = useRef(0);
  const lastMotion = useRef(-1e9);
  const forced = useRef(configured());
  const stats = useRef({ updates: 0, frames: 0 });

  useEffect(() => {
    if (!enabled || forced.current === 0) return;
    const prev = gl.shadowMap.autoUpdate;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    (window as unknown as { __lkShadow?: unknown }).__lkShadow = { stats: stats.current };
    return () => {
      gl.shadowMap.autoUpdate = prev;
      gl.shadowMap.needsUpdate = true;
    };
  }, [gl, enabled]);

  useEffect(
    () =>
      useView.subscribe((s, p) => {
        if (s.layers !== p.layers || s.mode !== p.mode || s.quality !== p.quality || s.xray !== p.xray) dirty.current = 4;
      }),
    [],
  );

  useFrame((state, dt) => {
    if (!enabled || forced.current === 0) return;
    stats.current.frames++;
    const now = state.clock.elapsedTime;
    since.current += dt;
    if (now - sigAt.current >= 0.1) {
      sigAt.current = now;
      const s = robotSignature(useWorld.getState().robots as never);
      if (s !== sig.current) {
        if (sig.current !== -1) lastMotion.current = now;
        sig.current = s;
      }
    }
    const hz = forced.current ?? (now - lastMotion.current < 0.4 ? SHADOW_ACTIVE_HZ : SHADOW_IDLE_HZ);
    if (dirty.current > 0 || since.current >= 1 / hz) {
      if (dirty.current > 0) dirty.current--;
      since.current = 0;
      gl.shadowMap.needsUpdate = true;
      stats.current.updates++;
    }
  });
  return null;
}
