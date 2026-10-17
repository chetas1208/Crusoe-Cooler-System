import { memo, useEffect, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Canvas, useThree } from '@react-three/fiber/native';
import { Scene, useView } from '@loopkeeper/scene';
import { useWorld } from '@loopkeeper/core/store';
import { colors } from '@/theme';
import { FAST_GL, RENDER_FPS, RENDER_SCALE } from '@/lib/quality';
import { SceneInput } from './SceneInput';

/**
 * Frame pacing. The canvas renders on demand and we ask for a frame at RENDER_FPS (30 by default: half the
 * GPU/CPU/battery cost, plenty for flow tracers and robot motion — the camera rig and pose interpolation are
 * time-based, not frame-based).
 *
 * expo-gl executes GL commands on its own thread, and JS can enqueue frames without bound. If the GPU falls behind
 * (software GL in the Simulator, a thermally throttled phone) the backlog grows until JS issues a *blocking* GL call
 * (shader compile, selection highlight…) and then the whole app appears frozen while it drains. So each tick first
 * fences on the previous frame — a cheap blocking `getError()` that returns once the GL thread has caught up —
 * which caps the queue at one frame: the app slows down gracefully instead of stalling.
 */
function FrameLimiter({ active }: { active: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    if (!active) return;
    const ctx = gl.getContext();
    let raf = 0;
    let last = 0;
    const interval = 1000 / RENDER_FPS - 2;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last >= interval) {
        last = t;
        ctx.getError();
        invalidate();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, invalidate, gl]);
  return null;
}

/** Mobile quality: no shadows, capped render resolution (see lib/quality), low-poly pipes via view.quality = 'low'. */
function Ready() {
  // expo-gl renders at the device's native resolution; we trade a little sharpness for a lot of fill rate
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    invalidate();
  }, [invalidate]);
  return null;
}

function SceneCanvasBase({ active }: { active: boolean }) {
  const phase = useWorld((s) => s.phase);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  const scale = RENDER_SCALE;
  // let the first layout / entering animations settle before the GL surface is created
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (phase !== 'ready') return;
    const t = setTimeout(() => setArmed(true), 900);
    return () => clearTimeout(t);
  }, [phase]);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg }]} onLayout={onLayout}>
      {phase === 'ready' && armed && box.w > 0 && (
        <View style={scale >= 0.999 ? { flex: 1 } : { width: box.w * scale, height: box.h * scale, transform: [{ scale: 1 / scale }], transformOrigin: 'top left' }}>
          <Canvas
            shadows={false}
            frameloop={active ? 'demand' : 'never'}
            camera={{ fov: 42, near: 0.1, far: 300, position: [22, 22, 26] }}
            gl={{ antialias: true }}
            onCreated={({ gl }) => {
              // shader-link status queries are *blocking* round trips to the GL thread; skip them outside dev
              gl.debug.checkShaderErrors = __DEV__ && !FAST_GL;
            }}
            onPointerMissed={() => useView.getState().select(null)}
          >
            <FrameLimiter active={active} />
            <Ready />
            <Scene shadows={false} />
            <SceneInput scale={scale} />
          </Canvas>
        </View>
      )}
    </View>
  );
}

export const SceneCanvas = memo(SceneCanvasBase);
