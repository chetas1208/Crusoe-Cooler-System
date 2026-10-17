import { useEffect } from 'react';
import { useThree } from '@react-three/fiber/native';
import { entityFocus, useView } from '@loopkeeper/scene';
import { haptic } from '@/lib/haptics';
import { MOBILE_PRESETS } from '@/lib/camera';

interface TouchPt {
  identifier?: number;
  pageX: number;
  pageY: number;
  locationX?: number;
  locationY?: number;
}

const ORBIT_AZ = 0.0056;
const ORBIT_EL = 0.0046;

/**
 * Touch → camera *goals* (the shared CameraRig eases the real camera). We listen on the fake canvas that
 * @react-three/fiber/native feeds from its PanResponder, so there is one touch pipeline and no responder fights:
 *   1 finger  → orbit      2 fingers → pinch zoom + pan
 *   tap       → select     double tap → focus selection (or reset framing)
 * R3F's own click needs sub-2px precision; fingers jitter, so taps are re-issued to the raycaster here.
 */
export function SceneInput({ scale }: { scale: number }) {
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    const el = gl.domElement as unknown as {
      addEventListener: (t: string, f: (e: any) => void) => void;
      removeEventListener: (t: string, f: (e: any) => void) => void;
      dispatchEvent: (e: unknown) => void;
    };
    const g = {
      touches: [] as TouchPt[],
      startT: 0,
      startX: 0,
      startY: 0,
      locX: 0,
      locY: 0,
      moved: false,
      maxTouches: 0,
      lastX: 0,
      lastY: 0,
      prevDist: 0,
      prevCx: 0,
      prevCy: 0,
      lastTap: null as null | { t: number; x: number; y: number },
    };

    const read = (e: any): TouchPt[] => (e?.touches && e.touches.length ? Array.from(e.touches) : []) as TouchPt[];

    const synth = (type: string, x: number, y: number) =>
      el.dispatchEvent({ type, offsetX: x, offsetY: y, clientX: x, clientY: y, pointerType: 'touch', pointerId: 1, button: 0, buttons: 1, isPrimary: true, timeStamp: Date.now(), nativeEvent: {}, preventDefault() {}, stopPropagation() {} });

    const down = (e: any) => {
      const t = read(e);
      g.touches = t;
      if (t.length === 1) {
        g.startT = Date.now();
        g.startX = g.lastX = t[0].pageX;
        g.startY = g.lastY = t[0].pageY;
        g.locX = e.locationX ?? t[0].locationX ?? 0;
        g.locY = e.locationY ?? t[0].locationY ?? 0;
        g.moved = false;
        g.maxTouches = 1;
      } else if (t.length >= 2) {
        g.maxTouches = 2;
        g.moved = true;
        g.prevDist = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
        g.prevCx = (t[0].pageX + t[1].pageX) / 2;
        g.prevCy = (t[0].pageY + t[1].pageY) / 2;
      }
    };

    const move = (e: any) => {
      const t = read(e);
      const v = useView.getState();
      if (t.length >= 2) {
        const d = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
        const cx = (t[0].pageX + t[1].pageX) / 2;
        const cy = (t[0].pageY + t[1].pageY) / 2;
        if (g.prevDist > 8 && v.mode !== 'pipe') {
          v.zoom(Math.pow(g.prevDist / Math.max(d, 8), 1.15));
          v.pan(-(cx - g.prevCx), -(cy - g.prevCy));
        }
        g.prevDist = d;
        g.prevCx = cx;
        g.prevCy = cy;
        g.moved = true;
        g.maxTouches = 2;
        return;
      }
      if (t.length === 1 && g.maxTouches === 1) {
        const dx = t[0].pageX - g.lastX;
        const dy = t[0].pageY - g.lastY;
        g.lastX = t[0].pageX;
        g.lastY = t[0].pageY;
        if (!g.moved && Math.hypot(t[0].pageX - g.startX, t[0].pageY - g.startY) > 9) g.moved = true;
        if (g.moved && v.mode !== 'pipe') v.orbit(-dx * ORBIT_AZ, dy * ORBIT_EL);
      }
    };

    const up = (e: any) => {
      const remaining = read(e).length;
      if (remaining > 0) {
        // a finger lifted during a pinch: re-seat the baseline so the scene doesn't jump
        g.touches = read(e);
        if (g.touches.length === 1) {
          g.lastX = g.touches[0].pageX;
          g.lastY = g.touches[0].pageY;
          g.maxTouches = 2; // not a tap
        }
        return;
      }
      const dt = Date.now() - g.startT;
      if (!g.moved && g.maxTouches === 1 && dt < 420) {
        // location in the (scaled) canvas space — what the raycaster expects
        const x = g.locX;
        const y = g.locY;
        synth('pointerdown', x, y);
        synth('click', x, y);
        const now = Date.now();
        const prev = g.lastTap;
        if (prev && now - prev.t < 320 && Math.hypot(g.startX - prev.x, g.startY - prev.y) < 36) {
          g.lastTap = null;
          const v = useView.getState();
          if (v.mode !== 'pipe') {
            haptic.medium();
            if (v.selectedId) v.focusEntity(v.selectedId);
            else v.setCam(MOBILE_PRESETS.whole);
          }
        } else {
          g.lastTap = { t: now, x: g.startX, y: g.startY };
          // tapped something selectable: tick, and glide it into the free area above the sheet (keeping zoom + angle)
          const before = useView.getState().selectedId;
          setTimeout(() => {
            const v = useView.getState();
            if (v.selectedId && v.selectedId !== before) {
              haptic.select();
              const f = entityFocus(v.selectedId);
              if (f && v.mode !== 'pipe') v.setCam({ target: f.target });
            }
          }, 0);
        }
      }
      g.touches = [];
      g.maxTouches = 0;
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
  }, [gl, scale]);

  return null;
}
