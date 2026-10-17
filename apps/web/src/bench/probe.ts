import * as THREE from 'three';
import { addEffect, addAfterEffect } from '@react-three/fiber';
import { dist, roundDist, type Dist } from './stats';

/**
 * Real measurements only. Nothing here is ever drawn on screen; numbers leave through `window.__lkBench`
 * (and the downloadable JSON). A sample window is opened by the runner, never continuously.
 *
 *  - frame interval: gap between consecutive requestAnimationFrame timestamps (what the display path actually produced)
 *  - cpu_frame: JS time from the R3F frame start to just after `gl.render` returned (submission cost; GPU raster time of
 *    a software or async GPU is NOT in this number)
 *  - gpu_ms: EXT_disjoint_timer_query_webgl2 when the browser exposes it; null otherwise
 *  - draw calls / triangles: three.js `renderer.info`, summed over every pass of one frame (shadow + main)
 */
export interface FrameSample {
  interval: number[];
  cpu: number[];
  calls: number[];
  tris: number[];
  lines: number[];
  points: number[];
  gpu: number[];
  geometries: number;
  textures: number;
  programs: number;
  longTasks: { count: number; totalMs: number };
  heapMb: number | null;
}

let gl: THREE.WebGLRenderer | null = null;
let sampling: FrameSample | null = null;
let tStart = 0;
let lastRaf = 0;
let rafId = 0;
let installed = false;
let timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
const pending: Array<{ q: WebGLQuery; s: FrameSample }> = [];
let curQuery: WebGLQuery | null = null;
let lo: PerformanceObserver | null = null;

export const hasRenderer = () => gl !== null;
export const glRenderer = () => gl;

export function attachRenderer(r: THREE.WebGLRenderer) {
  gl = r;
  r.info.autoReset = false; // accumulate shadow + main pass; we reset once per frame ourselves
  const ctx = r.getContext() as WebGL2RenderingContext;
  try {
    const ext = ctx.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    timerExt = ext ?? null;
  } catch {
    timerExt = null;
  }
  if (installed) return;
  installed = true;
  addEffect(() => {
    tStart = performance.now();
    const s = sampling;
    if (s && gl) {
      // info now holds the PREVIOUS frame's totals
      const i = gl.info.render;
      if (i.frame > 0) {
        s.calls.push(i.calls);
        s.tris.push(i.triangles);
        s.lines.push(i.lines);
        s.points.push(i.points);
      }
      if (timerExt) {
        const c = gl.getContext() as WebGL2RenderingContext;
        curQuery = c.createQuery();
        if (curQuery) c.beginQuery(timerExt.TIME_ELAPSED_EXT, curQuery);
      }
    }
    gl?.info.reset();
  });
  addAfterEffect(() => {
    const s = sampling;
    if (!s || !gl) return;
    s.cpu.push(performance.now() - tStart);
    if (timerExt && curQuery) {
      const c = gl.getContext() as WebGL2RenderingContext;
      c.endQuery(timerExt.TIME_ELAPSED_EXT);
      pending.push({ q: curQuery, s });
      curQuery = null;
    }
  });
}

function pollGpu() {
  if (!gl || !timerExt) return;
  const c = gl.getContext() as WebGL2RenderingContext;
  const disjoint = c.getParameter(timerExt.GPU_DISJOINT_EXT);
  while (pending.length) {
    const p = pending[0];
    if (!c.getQueryParameter(p.q, c.QUERY_RESULT_AVAILABLE)) break;
    pending.shift();
    if (!disjoint) p.s.gpu.push(Number(c.getQueryParameter(p.q, c.QUERY_RESULT)) / 1e6);
    c.deleteQuery(p.q);
  }
}

function loop(t: number) {
  if (sampling) {
    if (lastRaf) sampling.interval.push(t - lastRaf);
    pollGpu();
  }
  lastRaf = t;
  rafId = requestAnimationFrame(loop);
}

export function startSampling(): void {
  const s: FrameSample = { interval: [], cpu: [], calls: [], tris: [], lines: [], points: [], gpu: [], geometries: 0, textures: 0, programs: 0, longTasks: { count: 0, totalMs: 0 }, heapMb: null };
  lastRaf = 0;
  if (!rafId) rafId = requestAnimationFrame(loop);
  try {
    lo = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        s.longTasks.count++;
        s.longTasks.totalMs += e.duration;
      }
    });
    lo.observe({ entryTypes: ['longtask'] });
  } catch {
    lo = null;
  }
  sampling = s;
}

export function stopSampling(): FrameSample {
  const s = sampling!;
  sampling = null;
  lo?.disconnect();
  lo = null;
  pollGpu();
  if (gl) {
    s.geometries = gl.info.memory.geometries;
    s.textures = gl.info.memory.textures;
    s.programs = gl.info.programs?.length ?? 0;
  }
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  s.heapMb = mem ? Math.round(mem.usedJSHeapSize / 1048576) : null;
  return s;
}

export function ensureRaf() {
  if (!rafId) rafId = requestAnimationFrame(loop);
}

export interface Summary {
  frames: number;
  frame_interval_ms: Dist;
  cpu_frame_ms: Dist;
  gpu_ms: (Dist & { available: true }) | { available: false };
  draw_calls: Dist;
  triangles: Dist;
  lines: Dist;
  points: Dist;
  geometries: number;
  textures: number;
  programs: number;
  long_tasks: { count: number; total_ms: number };
  js_heap_mb: number | null;
}

export function summarize(s: FrameSample): Summary {
  return {
    frames: s.interval.length,
    frame_interval_ms: roundDist(dist(s.interval)),
    cpu_frame_ms: roundDist(dist(s.cpu)),
    gpu_ms: s.gpu.length ? { available: true, ...roundDist(dist(s.gpu)) } : { available: false },
    draw_calls: roundDist(dist(s.calls)),
    triangles: roundDist(dist(s.tris)),
    lines: roundDist(dist(s.lines)),
    points: roundDist(dist(s.points)),
    geometries: s.geometries,
    textures: s.textures,
    programs: s.programs,
    long_tasks: { count: s.longTasks.count, total_ms: Math.round(s.longTasks.totalMs) },
    js_heap_mb: s.heapMb,
  };
}
