#!/usr/bin/env node
// Instrumented freeze audit: drives the real app through the phases a user hits and records, per phase,
// long tasks, frame/GL stats, React commit rate, WebSocket volume, CDP metrics (script/layout/task time, heap, nodes),
// and a CPU profile (top self-time functions). Raw CPU profiles are saved gzipped next to the summary.
//
//   node scripts/bench/perf_audit.mjs --url http://127.0.0.1:5184/ --api http://127.0.0.1:8801 --out artifacts/perf/baseline [--gpu] [--w 1440 --h 900] [--secs 8]
// Needs a build opened with ?bench (exposes window.__lkApp and window.__lkBench) and an API that accepts test.inject_fault.
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };
const base = arg('url', 'http://127.0.0.1:5184/');
const api = arg('api', 'http://127.0.0.1:8801');
const out = arg('out', 'artifacts/perf/baseline');
const gpu = arg('gpu', false) === true;
const W = Number(arg('w', 1440)), H = Number(arg('h', 900));
const SECS = Number(arg('secs', 8));
const EXTRA = String(arg('query', ''));  // e.g. --query "&tiles=1"
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const args = ['--no-sandbox', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
if (gpu) args.push('--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface');
else args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

await page.addInitScript(() => {
  const P = (window.__perf = { long: [], commits: 0, ws: { msgs: 0, bytes: 0 }, fetchBytes: 0, rec: false, t0: performance.now() });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push([e.startTime, e.duration]); }).observe({ entryTypes: ['longtask'] }); } catch {}
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject() { return 1; }, onCommitFiberRoot() { P.commits++; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {} };
  const NW = window.WebSocket;
  window.WebSocket = new Proxy(NW, { construct(t, a) { const ws = new t(...a); ws.addEventListener('message', (e) => { P.ws.msgs++; P.ws.bytes += typeof e.data === 'string' ? e.data.length : (e.data.byteLength ?? 0); }); return ws; } });
});
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
const cdp = await ctx.newCDPSession(page);
await cdp.send('Performance.enable');
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });

const post = (body) => fetch(`${api}/api/v1/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const q = (xs, p) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

const PIN = String(arg('preset', 'high')); // pin the quality preset: Auto would step down on the headless 30 fps floor and change what is measured
const t0 = Date.now();
await page.goto(`${base}?bench=1&seed=8${EXTRA}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__lkBench?.ready === true && window.__lkApp, null, { timeout: 90000 });
const coldMs = Date.now() - t0;
await page.evaluate((p) => window.__lkApp.useView.getState().setPreset(p), PIN);
const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const rs = performance.getEntriesByType('resource'); return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), js_bytes: rs.filter((r) => /\.js/.test(r.name)).reduce((a, r) => a + (r.encodedBodySize || 0), 0), requests: rs.length }; });
await page.waitForTimeout(4000);

const results = [];
async function phase(name, setup, during) {
  if (setup) await setup();
  await page.waitForTimeout(1200);
  const m0 = await metrics();
  const s0 = await page.evaluate(() => { const P = window.__perf; P.long.length = 0; const c = P.commits, w = { ...P.ws }; window.__lkBench.sample.start(); return { c, w }; });
  await cdp.send('Profiler.start');
  if (during) await during();
  else await page.waitForTimeout(SECS * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  const m1 = await metrics();
  const s1 = await page.evaluate(() => { const P = window.__perf; return { sample: window.__lkBench.sample.stop(), long: P.long.slice(), c: P.commits, w: { ...P.ws }, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, tiles: window.__lkTiles?.stats() ?? null, progs: (window.__lk?.three?.gl?.info.programs ?? []).map((x) => x.name + '|' + x.cacheKey.length) }; });
  const dur = (m1.Timestamp - m0.Timestamp);
  // cpu profile -> self time by function
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  profile.samples.forEach((id, i) => { const n = byId.get(id); const d = profile.timeDeltas[i] / 1000; total += d; const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + d); });
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => ({ fn: k, ms: Math.round(v), pct: +(100 * v / total).toFixed(1) }));
  const pctOf = (re) => +(100 * [...self.entries()].filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0) / total).toFixed(1);
  const lt = s1.long.map((l) => l[1]);
  const r = {
    phase: name, seconds: +dur.toFixed(1),
    frames: s1.sample.frames, frame_interval_ms: s1.sample.frame_interval_ms, cpu_frame_ms: s1.sample.cpu_frame_ms, gpu_ms: s1.sample.gpu_ms,
    draw_calls_p50: s1.sample.draw_calls.p50, triangles_p50: s1.sample.triangles.p50, geometries: s1.sample.geometries, textures: s1.sample.textures, programs: s1.sample.programs,
    long_tasks: { count: lt.length, total_ms: Math.round(lt.reduce((a, b) => a + b, 0)), max_ms: Math.round(Math.max(0, ...lt)), p95_ms: Math.round(q(lt, 95)) },
    react_commits_per_s: +((s1.c - s0.c) / dur).toFixed(1),
    ws: { msgs_per_s: +((s1.w.msgs - s0.w.msgs) / dur).toFixed(1), kb_per_s: +((s1.w.bytes - s0.w.bytes) / 1024 / dur).toFixed(1) },
    main_thread: { task_pct: +(100 * (m1.TaskDuration - m0.TaskDuration) / dur).toFixed(1), script_pct: +(100 * (m1.ScriptDuration - m0.ScriptDuration) / dur).toFixed(1), layout_pct: +(100 * (m1.LayoutDuration - m0.LayoutDuration) / dur).toFixed(1), style_pct: +(100 * (m1.RecalcStyleDuration - m0.RecalcStyleDuration) / dur).toFixed(1), layouts_per_s: +((m1.LayoutCount - m0.LayoutCount) / dur).toFixed(1), style_recalcs_per_s: +((m1.RecalcStyleCount - m0.RecalcStyleCount) / dur).toFixed(1) },
    cpu_profile: { idle_pct: pctOf(/^\(idle\)/), gc_pct: pctOf(/garbage collector/), program_pct: pctOf(/^\(program\)/), json_parse_pct: pctOf(/JSON|parse/i), three_program_pct: pctOf(/getProgram|getParameters|setProgram|WebGLProgram/), top },
    heap_mb: s1.heap, dom_nodes: m1.Nodes, tiles: s1.tiles,
    program_names: Object.fromEntries([...new Set(s1.progs)].sort().map((n) => [n, s1.progs.filter((x) => x === n).length])),
  };
  results.push(r);
  writeFileSync(`${out}/${name}.cpuprofile.gz`, gzipSync(JSON.stringify(profile)));
  console.log(`${name.padEnd(22)} frames=${String(r.frames).padStart(4)} int p50/p95=${r.frame_interval_ms.p50}/${r.frame_interval_ms.p95} cpu p50/p95=${r.cpu_frame_ms.p50}/${r.cpu_frame_ms.p95} calls=${r.draw_calls_p50} long=${r.long_tasks.count}(${r.long_tasks.total_ms}ms max ${r.long_tasks.max_ms}) react=${r.react_commits_per_s}/s ws=${r.ws.msgs_per_s}/s ${r.ws.kb_per_s}KB/s script=${r.main_thread.script_pct}% gc=${r.cpu_profile.gc_pct}% heap=${r.heap_mb}MB`);
}
const ev = (fn, a) => page.evaluate(fn, a);
const robots = () => ev(() => Object.values(window.__lkApp.useWorld.getState().robots).map((r) => ({ id: r.id, class: r.class, mode: r.mode })));
const setTab = (t) => ev((t) => window.__lkApp.useUi.getState().setTab(t), t);

await phase('01_dashboard_idle', () => setTab('dashboard'));
// make the fleet move: three faults -> missions for crawlers and rovers
for (const kind of ['fouling', 'strainer_blockage', 'valve_stuck']) await post({ command_id: `audit_${kind}_${Date.now()}`, kind: 'test.inject_fault', args: { kind } });
await page.waitForTimeout(20000);
const moving = (await robots()).filter((r) => r.mode !== 'DOCKED' && r.mode !== 'IDLE');
console.log('moving robots:', moving.map((m) => `${m.id}:${m.mode}`).join(' ') || 'none');
await phase('02_dashboard_moving', () => setTab('dashboard'));
await phase('03_map_overview', () => setTab('map'));
await phase('04_map_zoom', null, async () => {
  const box = { x: W * 0.5, y: H * 0.5 };
  await page.mouse.move(box.x, box.y);
  for (let i = 0; i < SECS * 4; i++) { await page.mouse.wheel(0, i % 8 < 4 ? -240 : 240); await page.waitForTimeout(250); }
});
const rov = moving.find((r) => r.class === 'outrig') ?? (await robots()).find((r) => r.class === 'outrig');
const cra = moving.find((r) => r.class === 'inpipe') ?? (await robots()).find((r) => r.class === 'inpipe');
await phase('05_chase_outrig', () => ev((id) => { const mc = window.__lkApp.useMapCamera.getState(); mc.selectRobot(id, 'outrig'); mc.setThirdPersonMode('chase'); }, rov.id));
await phase('06_pipe_pov_crawler', () => ev((id) => { const mc = window.__lkApp.useMapCamera.getState(); mc.selectRobot(id, 'inpipe'); mc.setCameraMode('first_person'); mc.setFirstPersonDirection('front'); }, cra.id));
// driving: take control of the rover with the real UI, then hold W
await ev((id) => { const mc = window.__lkApp.useMapCamera.getState(); mc.selectRobot(id, 'outrig'); mc.setThirdPersonMode('chase'); }, rov.id);
await page.waitForTimeout(800);
await page.locator('button', { hasText: /Take (Manual )?Control/ }).first().click().catch(() => {});
await page.waitForTimeout(2500);
await phase('07_driving_outrig', null, async () => { await page.keyboard.down('w'); await page.waitForTimeout(SECS * 1000); await page.keyboard.up('w'); });
await page.keyboard.press('Escape');
await phase('08_repair_dashboard', async () => { await post({ command_id: `audit_pump_${Date.now()}`, kind: 'test.inject_fault', args: { kind: 'pump_degradation' } }); await setTab('dashboard'); });
await phase('09_agents_tab', () => setTab('agents'));
await phase('10_execution_replay', async () => { await setTab('execution'); await page.locator('button.chip', { hasText: /^replay$/i }).first().click().catch(() => {}); await page.waitForTimeout(8000); });

const env = await page.evaluate(() => ({ ua: navigator.userAgent, cores: navigator.hardwareConcurrency, dpr: devicePixelRatio, gl: (() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c.getExtension('WEBGL_debug_renderer_info'); return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null; })(), robots: Object.keys(window.__lkApp.useWorld.getState().robots).length }));
const report = { schema: 'loopkeeper.perf-audit/v1', at: new Date().toISOString(), url: base, api, viewport: [W, H], gpu_requested: gpu, env, cold: { wall_ms_to_ready: coldMs, ...nav }, page_errors: errs.slice(0, 5), phases: results, note: 'headless Chromium; rAF is ~60 Hz capped here so frame_interval cannot show more; cpu_frame_ms/gpu_ms/long tasks/commit rates are the signals. Not a display-attached measurement.' };
writeFileSync(`${out}/audit.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log('wrote', `${out}/audit.json`);
