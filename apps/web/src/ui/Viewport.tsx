import { lazy, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import { Scene, useView, useMapCamera } from '@loopkeeper/scene';
import { useWorld } from '@loopkeeper/core/store';
import { usePlayer } from '@loopkeeper/core/runs';
import { AnchorProjector } from './AnchorProjector';
import { benchEnabled } from '../bench/flag';
import { AutoQuality } from './AutoQuality';
import { useUi } from './store';
import { FrameWatchdog } from '../features/visualization/FrameWatchdog';

const BenchProbe = lazy(() => import('../bench').then((m) => ({ default: m.BenchProbe })));

/** Pointer / wheel input → camera *goals* in the view store. The rig does the easing. */
function CanvasInput() {
  const { gl } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    let last: { x: number; y: number } | null = null;
    let mode: 'orbit' | 'pan' | null = null;
    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
      mode = e.button === 2 || e.button === 1 || e.shiftKey ? 'pan' : 'orbit';
    };
    const move = (e: PointerEvent) => {
      if (!last || !mode) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      const mc = useMapCamera.getState();
      if (mc.active) {
        if (mc.cameraMode === 'third_person' && mc.thirdPersonMode === 'orbit') {
          mc.orbit(-dx * 0.007, dy * 0.007);
          return;
        }
        if (mc.cameraMode === 'first_person') {
          mc.look(-dx * 0.005, -dy * 0.005);
          return;
        }
      }
      const v = useView.getState();
      if (mode === 'orbit') {
        if (v.mode === 'pipe') return;
        v.orbit(-dx * 0.0062, dy * 0.0052);
      } else v.pan(-dx, -dy);
    };
    const up = (e: PointerEvent) => {
      last = null;
      mode = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const mc = useMapCamera.getState();
      if (mc.active && mc.cameraMode === 'third_person') {
        mc.zoom(Math.exp(e.deltaY * 0.0015));
        return;
      }
      if (useView.getState().mode === 'pipe') return;
      useView.getState().zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0013)));
    };
    const ctx = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', ctx);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', ctx);
    };
  }, [gl]);
  return null;
}

/**
 * The Agents tab covers the canvas with a graph; the 3D scene behind it is a dimmed backdrop. Profiling showed that tab at 86-92 %
 * main-thread busy (React Flow + 30 fps WebGL). Render the backdrop at ~10 fps there; every other tab stays on the display's rAF.
 */
function FrameGovernor() {
  const tab = useUi((s) => s.tab);
  const setFrameloop = useThree((s) => s.setFrameloop);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (tab !== 'agents') {
      setFrameloop('always');
      return;
    }
    setFrameloop('demand');
    const id = setInterval(() => invalidate(), 100);
    return () => {
      clearInterval(id);
      setFrameloop('always');
    };
  }, [tab, setFrameloop, invalidate]);
  return null;
}

/** dev-only: expose three internals for debugging from the console */
function DevHook() {
  const three = useThree();
  useEffect(() => {
    // debug / measurement hook (dev server, or ?probe / ?bench in a build): scripts/bench/framing.py projects the hall with the live camera
    if (import.meta.env.DEV || /[?&](probe|bench)\b/.test(location.search)) {
      (window as unknown as { __three: unknown }).__three = three;
      (window as unknown as { __lk: unknown }).__lk = { view: useView, world: useWorld, mapCamera: useMapCamera, player: usePlayer, three };
    }
  }, [three]);
  return null;
}

/** Frame-time + context-loss watchdog (falls back to the Tactical 2D view; see features/visualization). */
function Watch() {
  const gl = useThree((s) => s.gl);
  return <FrameWatchdog canvas={gl.domElement} />;
}

/** Procedural studio reflections for the glass pipes — no HDR download needed. */
function Studio() {
  return (
    <Environment resolution={256} frames={1} environmentIntensity={0.9}>
      <Lightformer form="rect" intensity={3.2} color="#ffffff" position={[0, 9, 4]} rotation={[Math.PI / 2, 0, 0]} scale={[16, 6, 1]} />
      <Lightformer form="rect" intensity={1.6} color="#9fc2ff" position={[-9, 4, 2]} rotation={[0, Math.PI / 2, 0]} scale={[10, 4, 1]} />
      <Lightformer form="rect" intensity={1.8} color="#ffd9b0" position={[9, 5, 6]} rotation={[0, -Math.PI / 2, 0]} scale={[10, 4, 1]} />
      <Lightformer form="ring" intensity={1.2} color="#ffffff" position={[0, 6, -9]} scale={6} />
    </Environment>
  );
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function Viewport() {
  const quality = useView((s) => s.quality);
  // Performance tier also drops the CSS backdrop blur behind every panel (a full-screen blur over a WebGL canvas is costly on weak GPUs)
  useEffect(() => {
    document.documentElement.dataset.quality = quality;
  }, [quality]);
  const native4k = useView((s) => s.native4k);
  const [ok] = useState(webglAvailable);
  if (!ok)
    return (
      <div className="nogl panel">
        <div className="nogl__t">3D view unavailable</div>
        <div className="nogl__s">This browser can't create a WebGL context, so the spatial view is off. Everything else still works: open Incidents in the dock for the full 2D incident and action list.</div>
      </div>
    );
  const wrap = useRef<HTMLDivElement>(null);
  return (
    <div className="viewport" ref={wrap}>
      <Canvas
        shadows="soft"
        dpr={native4k ? 2.0 : quality === 'high' ? [1, 2] : quality === 'medium' ? [1, 1.5] : [1, 1]}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance', toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
        camera={{ fov: 32, near: 0.1, far: 300, position: [22, 22, 26] }}
        onPointerMissed={(e) => {
          if ((e as unknown as { delta?: number }).delta === undefined || (e as unknown as { delta: number }).delta < 5) useView.getState().select(null);
        }}
      >
        <Studio />
        <Scene shadows />
        <AnchorProjector />
        <CanvasInput />
        <DevHook />
        <AutoQuality />
        <FrameGovernor />
        <Watch />
        {benchEnabled && <BenchProbe />}
      </Canvas>
    </div>
  );
}
