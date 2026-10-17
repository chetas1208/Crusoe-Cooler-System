#!/usr/bin/env node
// Headless benchmark driver. The harness itself lives in the page (apps/web/src/bench); this only opens a browser,
// calls window.__lkBench.run() and writes the JSON it returns.
//
//   node scripts/bench/run.mjs --out artifacts/benchmarks/before.json --label before [--url http://127.0.0.1:5184/]
//        [--presets high,balanced,performance] [--duration 8000] [--warmup 1500] [--w 1440 --h 900]
//        [--scenarios dashboard_orbit,map_pipe_pov,...] [--gpu]   (--gpu: try the host GPU via ANGLE/Vulkan instead of SwiftShader)
//
// env: PLAYWRIGHT_MODULE (path to playwright package), CHROME_PATH (browser executable)
//
// Headless Chromium on a server normally rasterises in software (SwiftShader). The JSON says so
// (environment.gl.software_rasteriser) and verdict.can_claim_120fps will be false. For real numbers open
// <app>/?bench=1 in your own browser on your own display and press "Run all presets".
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };
const out = arg('out', 'bench.json');
const base = arg('url', 'http://127.0.0.1:5184/');
const presets = String(arg('presets', 'high')).split(',');
const durationMs = Number(arg('duration', 8000));
const warmupMs = Number(arg('warmup', 1500));
const w = Number(arg('w', 1440));
const h = Number(arg('h', 900));
const label = String(arg('label', 'run'));
const scenarios = arg('scenarios', undefined);
const gpu = arg('gpu', false) === true;
const seed = String(arg('seed', 8));

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const args = ['--no-sandbox', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
if (gpu) args.push('--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--enable-gpu-rasterization', '--disable-gpu-vsync', '--disable-frame-rate-limit');
else args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args });
const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(`${base}?bench=1&seed=${seed}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__lkBench?.ready === true, null, { timeout: 90000 });
await page.waitForTimeout(8000); // let the mock world produce some history and shaders compile
const report = await page.evaluate(
  ([o]) => window.__lkBench.run(o),
  [{ presets, durationMs, warmupMs, label, ...(scenarios ? { scenarios: String(scenarios).split(',') } : {}) }],
);
await browser.close();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`wrote ${out}`);
for (const r of report.results)
  console.log(`${r.preset.padEnd(12)} ${r.scenario.padEnd(18)} frames=${String(r.frames).padStart(4)} interval p50/p95/p99=${r.frame_interval_ms.p50}/${r.frame_interval_ms.p95}/${r.frame_interval_ms.p99}ms cpu p50/p95=${r.cpu_frame_ms.p50}/${r.cpu_frame_ms.p95}ms calls=${r.draw_calls.p50} tris=${r.triangles.p50}`);
console.log('gl:', report.environment.gl?.renderer, '| software:', report.environment.gl?.software_rasteriser, '| refresh~', report.environment.display_refresh_estimate.hz, 'Hz');
console.log('verdict:', report.verdict.can_claim_120fps, '-', report.verdict.reason);
