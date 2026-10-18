import { useWorld, enterReplay, exitReplay, seekReplay, useReplay, replayFrames, activeTransport } from '@loopkeeper/core/store';
import { useView, useMapCamera, useTileMode, geomCacheStats, type QualityPreset, type TileMode } from '@loopkeeper/scene';
import { useUi } from '../ui/store';
import { applyPreset } from '../ui/presets';
import { glRenderer, hasRenderer, startSampling, stopSampling, summarize, ensureRaf, type Summary } from './probe';
import { dist, round } from './stats';
import { wsStats, resetWsStats } from './net';

export type ScenarioId = 'dashboard_orbit' | 'map_pipe_pov' | 'outrig_chase' | 'agent_graph' | 'execution_replay';
export const SCENARIOS: ScenarioId[] = ['dashboard_orbit', 'map_pipe_pov', 'outrig_chase', 'agent_graph', 'execution_replay'];
const PRESETS: QualityPreset[] = ['high', 'balanced', 'performance'];

export interface RunOptions {
  scenarios?: ScenarioId[];
  presets?: QualityPreset[];
  /** run every preset x scenario once per tile mode (off = procedural hall, on = server tiles replace it, auto = default policy) */
  tileModes?: TileMode[];
  durationMs?: number;
  warmupMs?: number;
  label?: string;
  onProgress?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const raf = () => new Promise<number>((r) => requestAnimationFrame(r));

/** estimate the display refresh from rAF cadence: median of 90 consecutive intervals while the page is otherwise idle */
async function estimateRefresh() {
  const ts: number[] = [];
  for (let i = 0; i < 90; i++) ts.push(await raf());
  const iv: number[] = [];
  for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
  const d = dist(iv);
  return { median_interval_ms: round(d.p50), hz: round(1000 / d.p50, 1), min_interval_ms: round(Math.min(...iv)) };
}

interface TileWindow {
  __lkTiles?: { stats(): Record<string, unknown> | null; state(): string; mode(): string; attempts(): { count: number; lastError: string | null } };
}
const tileWin = () => window as unknown as TileWindow;

/** what the tile layer looks like right now (null while it is not mounted: procedural hall only) */
function tileSnapshot() {
  const t = tileWin().__lkTiles;
  if (!t) return { mode: useTileMode.getState().mode, mounted: false as const };
  const st = t.stats();
  return { mode: t.mode(), mounted: true as const, state: t.state(), attempts: t.attempts(), stats: st };
}

/** wait until the requested tile mode has taken effect and the streamer is quiet (no in-flight / queued loads), or give up after maxMs */
async function settleTiles(mode: TileMode, maxMs = 20000) {
  useTileMode.getState().setMode(mode);
  const t0 = performance.now();
  await sleep(500);
  while (performance.now() - t0 < maxMs) {
    const t = tileWin().__lkTiles;
    if (mode === 'off') return true;
    if (!t) {
      if (mode === 'auto') return true; // auto stays procedural at this quality tier: nothing to wait for
      await sleep(250);
      continue;
    }
    const st = t.stats() as { inflight?: number; queued?: number } | null;
    if (t.state() === 'failed') return false;
    if (t.state() === 'ready' && st && (st.inflight ?? 0) === 0 && (st.queued ?? 0) === 0) return true;
    await sleep(250);
  }
  return false;
}

function glInfo() {
  const r = glRenderer();
  if (!r) return null;
  const c = r.getContext() as WebGL2RenderingContext;
  const dbg = c.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? String(c.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(c.getParameter(c.RENDERER));
  const vendor = dbg ? String(c.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : String(c.getParameter(c.VENDOR));
  const software = /swiftshader|llvmpipe|software|softpipe|microsoft basic/i.test(renderer);
  return {
    renderer,
    vendor,
    version: String(c.getParameter(c.VERSION)),
    software_rasteriser: software,
    timer_query: !!c.getExtension('EXT_disjoint_timer_query_webgl2'),
    max_texture_size: c.getParameter(c.MAX_TEXTURE_SIZE) as number,
    drawing_buffer: [c.drawingBufferWidth, c.drawingBufferHeight],
    pixel_ratio_applied: r.getPixelRatio(),
    shadow_map_enabled: r.shadowMap.enabled,
  };
}

function bundleBytes() {
  const rows = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const acc = { js: [0, 0], css: [0, 0], font: [0, 0], image: [0, 0], other: [0, 0] };
  for (const e of rows) {
    const k = /\.js(\?|$)/.test(e.name) || e.initiatorType === 'script' ? 'js' : /\.css(\?|$)/.test(e.name) ? 'css' : /\.(woff2?|ttf)/.test(e.name) ? 'font' : /\.(png|jpe?g|svg|webp|glb|ktx2)/.test(e.name) ? 'image' : 'other';
    acc[k][0] += e.encodedBodySize || e.transferSize || 0;
    acc[k][1] += e.decodedBodySize || 0;
  }
  const total = Object.values(acc).reduce((a, [e]) => a + e, 0) + (nav?.encodedBodySize ?? 0);
  return {
    note: 'encoded = bytes on the wire (compressed if the server compresses); decoded = after decompression. vite dev serves unbundled sources: only a production build (vite build + preview) is a meaningful bundle size.',
    encoded: { js: acc.js[0], css: acc.css[0], font: acc.font[0], image: acc.image[0], other: acc.other[0], html: nav?.encodedBodySize ?? 0, total },
    decoded: { js: acc.js[1], css: acc.css[1], font: acc.font[1], image: acc.image[1], other: acc.other[1] },
    requests: rows.length,
    dom_content_loaded_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    load_event_ms: nav ? Math.round(nav.loadEventEnd) : null,
  };
}

function simState() {
  const w = useWorld.getState();
  const robots = Object.values(w.robots);
  return {
    robot_count: robots.length,
    robots_by_class: robots.reduce<Record<string, number>>((a, r) => ((a[r.class] = (a[r.class] ?? 0) + 1), a), {}),
    robot_modes: robots.reduce<Record<string, number>>((a, r) => ((a[r.mode] = (a[r.mode] ?? 0) + 1), a), {}),
    asset_count: Object.keys(w.assetsById).length,
    edge_count: Object.keys(w.edgesById).length,
    sim_time_s: round(w.simTimeS, 1),
    last_seq: w.lastSeq,
  };
}

const firstRobot = (cls: string) => Object.values(useWorld.getState().robots).find((r) => r.class === cls);

type Setup = (t: number) => void; // per-frame camera/state driver, t = ms since scenario start
interface Scenario {
  prepare(): { drive?: Setup; note?: string } | void;
  cleanup?(): void;
}

const SCEN: Record<ScenarioId, Scenario> = {
  dashboard_orbit: {
    prepare() {
      useMapCamera.getState().setActive(false);
      useUi.getState().setTab('dashboard');
      useView.getState().select(null);
      // start from the fitted whole-facility overview (v6 hall: five rows, four roads, CDU bay), not a legacy fixed camera
      applyPreset('fit');
      const base = useView.getState().cam;
      // full orbit in 24 s, mild elevation sweep; deterministic function of time only
      return {
        drive: (t) => useView.getState().setCam({ azimuth: base.azimuth + (t / 24000) * Math.PI * 2, elevation: 0.5 + 0.12 * Math.sin(t / 6000), distance: base.distance * (0.9 + 0.1 * Math.sin(t / 9000)) }),
      };
    },
  },
  map_pipe_pov: {
    prepare() {
      const r = firstRobot('inpipe');
      useUi.getState().setTab('map');
      if (!r) return { note: 'no inpipe robot in world' };
      const mc = useMapCamera.getState();
      mc.selectRobot(r.id, 'inpipe');
      mc.setCameraMode('first_person');
      mc.setFirstPersonDirection('front');
      return { drive: (t) => useMapCamera.getState().look(Math.sin(t / 1500) * 0.012, Math.sin(t / 2300) * 0.004), note: `first-person front camera on ${r.id}` };
    },
    cleanup() {
      useMapCamera.getState().setCameraMode('tactical');
    },
  },
  outrig_chase: {
    prepare() {
      const r = firstRobot('outrig');
      useUi.getState().setTab('map');
      if (!r) return { note: 'no outrig robot in world' };
      const mc = useMapCamera.getState();
      mc.selectRobot(r.id, 'outrig');
      mc.setThirdPersonMode('chase');
      return { note: `third-person chase camera on ${r.id}` };
    },
    cleanup() {
      useMapCamera.getState().setCameraMode('tactical');
    },
  },
  agent_graph: {
    prepare() {
      useMapCamera.getState().setCameraMode('tactical');
      useUi.getState().setTab('agents');
    },
  },
  execution_replay: {
    prepare() {
      useMapCamera.getState().setCameraMode('tactical');
      useUi.getState().setTab('execution');
      const n = replayFrames().length;
      if (n >= 4 && !useReplay.getState().active) {
        enterReplay();
        let i = 0;
        return { drive: (t) => { const k = Math.floor(t / 1000) % n; if (k !== i) { i = k; seekReplay(k); } }, note: `scrubbing ${n} recorded 1 Hz frames` };
      }
      return { note: 'Execution tab only (fewer than 4 recorded frames, replay not entered)' };
    },
    cleanup() {
      if (useReplay.getState().active) void exitReplay();
    },
  },
};

async function runOne(id: ScenarioId, durationMs: number, warmupMs: number, onProgress?: (m: string) => void) {
  const sc = SCEN[id];
  const prep = sc.prepare() ?? {};
  let stop = false;
  let t0 = performance.now();
  const driver = (async () => {
    while (!stop) {
      await raf();
      prep.drive?.(performance.now() - t0);
    }
  })();
  onProgress?.(`${id}: warm-up`);
  await sleep(warmupMs);
  resetWsStats();
  const sim0 = simState();
  startSampling();
  const tStart = performance.now();
  t0 = tStart - warmupMs; // keep the camera path continuous
  onProgress?.(`${id}: sampling ${Math.round(durationMs / 1000)} s`);
  await sleep(durationMs);
  const wall = performance.now() - tStart;
  const sample = stopSampling();
  stop = true;
  await driver;
  sc.cleanup?.();
  const sim1 = simState();
  const s: Summary = summarize(sample);
  const gpuP = s.gpu_ms.available ? s.gpu_ms : null;
  const cost50 = Math.max(s.cpu_frame_ms.p50, gpuP?.p50 ?? 0);
  const cost95 = Math.max(s.cpu_frame_ms.p95, gpuP?.p95 ?? 0);
  return {
    scenario: id,
    note: prep.note ?? null,
    duration_ms: Math.round(wall),
    produced_fps: round((s.frames / wall) * 1000, 2),
    ...s,
    headroom: {
      cost_ms_p50: round(cost50),
      cost_ms_p95: round(cost95),
      implied_max_fps_p95: cost95 > 0 ? round(1000 / cost95, 1) : null,
      note: 'ESTIMATE of renderer headroom = 1000 / max(cpu_frame_ms, gpu_ms). It ignores main-thread work outside the render frame (React, stores, simulator, layout) and is NOT a displayed frame rate. Browsers cap requestAnimationFrame at the display refresh (headless Chromium: 60 Hz), so frame_interval_ms cannot show more than that.',
    },
    ws: wsStats(wall),
    sim_before: sim0,
    sim_after: sim1,
  };
}

export async function runBenchmark(opts: RunOptions = {}) {
  if (!hasRenderer()) throw new Error('no WebGL renderer attached (is the canvas mounted?)');
  ensureRaf();
  const scenarios = opts.scenarios ?? SCENARIOS;
  const durationMs = opts.durationMs ?? 8000;
  const warmupMs = opts.warmupMs ?? 1500;
  const presets = opts.presets ?? ['high'];
  const tileModes = opts.tileModes ?? [];
  const prevTileMode = useTileMode.getState().mode;
  const view = useView.getState();
  const prevPreset = view.qualityPreset;
  const t = activeTransport();
  const topo = useWorld.getState().topology;
  const tileSnapshotAtStart = tileSnapshot();
  const refresh = await estimateRefresh();
  const gl = glInfo();
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { brands?: Array<{ brand: string; version: string }>; platform?: string } };
  const started = new Date().toISOString();
  const results: Array<Record<string, unknown>> = [];
  for (const preset of presets) {
    view.setPreset(preset);
    await sleep(600);
    const invariants = simState();
    for (const tm of tileModes.length ? tileModes : [null]) {
     const settled = tm ? await settleTiles(tm) : null;
     for (const sc of scenarios) {
      opts.onProgress?.(`preset ${preset}${tm ? ` tiles=${tm}` : ''}`);
      const r = await runOne(sc, durationMs, warmupMs, opts.onProgress);
      results.push({ preset, ...(tm ? { tile_mode_requested: tm, tiles_settled: settled } : {}), ...r, tiles: tileSnapshot(), quality_tier_applied: useView.getState().quality, sim_invariants_equal: JSON.stringify({ ...invariants, sim_time_s: 0, last_seq: 0, robot_modes: 0 }) === JSON.stringify({ ...simState(), sim_time_s: 0, last_seq: 0, robot_modes: 0 }) });
     }
    }
  }
  if (tileModes.length) useTileMode.getState().setMode(prevTileMode);
  view.setPreset(prevPreset);
  const headless = !!navigator.webdriver;
  const gc = geomCacheStats;
  const rendered = results as Array<{ frame_interval_ms: { p95: number }; preset: string }>;
  const worst95 = Math.max(...rendered.map((r) => r.frame_interval_ms.p95));
  const canClaim120 = !!gl && !gl.software_rasteriser && !headless && refresh.hz >= 115 && worst95 <= 8.34 * 1.02;
  return {
    schema: 'loopkeeper.bench/v1',
    label: opts.label ?? 'unlabelled',
    started_at: started,
    seeded: { url_seed: new URLSearchParams(location.search).get('seed') ?? 'default(8)', note: 'seed fixes the simulated world; camera paths are pure functions of elapsed time' },
    options: { durationMs, warmupMs, presets, scenarios, tileModes },
    environment: {
      user_agent: navigator.userAgent,
      platform: nav.userAgentData?.platform ?? navigator.platform,
      cpu_logical_cores: navigator.hardwareConcurrency,
      device_memory_gb: nav.deviceMemory ?? null,
      automation_controlled: headless,
      viewport: [innerWidth, innerHeight],
      screen: [screen.width, screen.height],
      device_pixel_ratio: devicePixelRatio,
      display_refresh_estimate: {
        ...refresh,
        method: 'median requestAnimationFrame interval over 90 frames; is a lower bound of the real refresh when the page cannot keep up, and browsers may cap rAF',
        trustworthy_as_display_refresh: !headless,
        caveat: headless ? 'automation-controlled browser: rAF is driven by the harness flags (vsync / frame-rate limit may be disabled), so this is NOT a display refresh rate' : null,
      },
      gl,
      build: import.meta.env.DEV ? 'vite-dev (unminified, NOT representative)' : 'production',
      transport: t?.info ?? null,
      tile_mode_at_start: prevTileMode,
      tiles_at_start: tileSnapshotAtStart,
      topology: topo ? { id: topo.facility.id, assets: Object.keys(useWorld.getState().assetsById).length, edges: topo.edges.length } : null,
      url: location.pathname + location.search,
    },
    page_load: bundleBytes(),
    geom_cache: { ...gc, note: 'pipe path/tube geometry builds vs cache hits since page load (keyed by topology hash)' },
    results,
    verdict: {
      worst_frame_interval_p95_ms: round(worst95),
      budget_120fps_ms: 8.333,
      budget_200fps_ms: 5.0,
      can_claim_120fps: canClaim120,
      reason: canClaim120
        ? 'hardware GL, non-automated browser, display >=115 Hz, p95 frame interval within 8.33 ms in every scenario'
        : [
            gl?.software_rasteriser ? 'software rasteriser (not a GPU measurement)' : null,
            headless ? 'automation-controlled/headless browser' : null,
            refresh.hz < 115 ? `display/rAF cadence ${refresh.hz} Hz < 115 Hz so 120 unique frames/s cannot be presented` : null,
            worst95 > 8.34 ? `worst p95 frame interval ${round(worst95)} ms > 8.33 ms` : null,
          ].filter(Boolean).join('; '),
    },
    limitations: [
      'cpu_frame_ms measures JS submission cost; GPU raster time is only present when gpu_ms.available is true.',
      'Camera paths are deterministic; the simulated world advances in real time so robot/incident state differs slightly between runs (see sim_before/sim_after).',
      'Robot count reflects the connected backend or embedded mock; synthetic robots are never added.',
    ],
  };
}
