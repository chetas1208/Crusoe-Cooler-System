import { useEffect } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { useWorld } from '@loopkeeper/core/store';

/**
 * Compile every shader program once, up front.
 * Profiling showed 565 ms of `getProgramInfoLog` (a 690 ms long task) the first time robots started moving: close-up crawler
 * meshes, route ribbons, selection brackets etc. were only compiled when they first became visible. Here every object is made
 * temporarily visible for a single synchronous `gl.compile`, then restored, right after the first frames of a topology.
 */
export function ShaderWarmup() {
  const { gl, scene, camera } = useThree();
  const key = useWorld((s) => (s.topology ? s.topology.facility.topology_hash : ''));
  const robots = useWorld((s) => Object.keys(s.robots).length);
  useEffect(() => {
    if (!key || !robots) return;
    const t = setTimeout(() => {
      const saved: Array<[THREE.Object3D, boolean]> = [];
      const lights: THREE.Object3D[] = [];
      scene.traverse((o) => {
        // lights toggle on and off at run time (crawler lamps inside a bore): the number of visible lights is part of every lit
        // material's program key, so both light configurations are compiled — first as the scene normally looks, then with all on
        if ((o as THREE.Light).isLight) {
          lights.push(o);
          return;
        }
        if (!o.visible) {
          saved.push([o, false]);
          o.visible = true;
        }
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (m) for (const x of [m].flat()) if (x && x.visible === false) saved.push([x as unknown as THREE.Object3D, false]);
      });
      try {
        // program key = f(light count, local clipping): compile every combination the app can reach
        const lc = gl.localClippingEnabled;
        for (const clip of [lc, !lc]) {
          gl.localClippingEnabled = clip;
          gl.compile(scene, camera); // lights as the scene normally has them
          const off: THREE.Object3D[] = [];
          for (const l of lights) if (!l.visible) { l.visible = true; off.push(l); }
          gl.compile(scene, camera); // every light on
          for (const l of off) l.visible = false;
        }
        gl.localClippingEnabled = lc;
      } catch {
        /* a failed warm-up only costs the lazy compile it was meant to avoid */
      } finally {
        for (const [o, v] of saved) o.visible = v;
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [gl, scene, camera, key, robots]);
  return null;
}
