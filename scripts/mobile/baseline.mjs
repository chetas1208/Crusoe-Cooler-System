// V10 baseline: measure the CURRENT production build on desktop/phone/tablet viewports.
//   node scripts/mobile/baseline.mjs <distDir> <outDir> [live-api-url]
// Device emulation (viewport, DPR, touch, CPU/network throttling) is NOT a real mobile GPU: WebGL here is SwiftShader (software).
import fs from 'node:fs';
import { launch, newPage, serve, VIEWPORTS, INIT_SCRIPT, measure, cdpNetworkBytes, NET } from './lib.mjs';

const [dist, out, live] = [process.argv[2], process.argv[3], process.argv[4]];
fs.mkdirSync(out, { recursive: true });
const srv = await serve(dist);
const browser = await launch();
const results = {};
const q = live ? `?api=${encodeURIComponent(live)}` : '';

async function run(name, vp, { tab, net = 'none', cpu = 1, settle = 6000, webgl = true } = {}) {
  const b = webgl ? browser : await launch({ webgl: false });
  const { ctx, page } = await newPage(b, vp);
  await page.addInitScript(INIT_SCRIPT);
  const nb = await cdpNetworkBytes(page);
  if (NET[net]) await nb.cdp.send('Network.emulateNetworkConditions', NET[net]);
  if (cpu > 1) await nb.cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  const t0 = Date.now();
  await page.goto(srv.url + '/' + q, { waitUntil: 'commit' });
  let usable = null;
  try { await page.waitForSelector('.topbar', { timeout: 60000 }); usable = Date.now() - t0; } catch {}
  let firstPaintMs = await page.evaluate(() => (performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null)).catch(() => null);
  if (tab) { await page.getByRole('tab', { name: new RegExp(tab, 'i') }).first().click().catch(() => {}); }
  await page.waitForTimeout(settle);
  const m = await measure(page);
  const perf = await nb.cdp.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
  await nb.cdp.send('Performance.enable').catch(() => {});
  const perf2 = await nb.cdp.send('Performance.getMetrics').catch(() => ({ metrics: [] }));
  const pm = Object.fromEntries(perf2.metrics.map((x) => [x.name, x.value]));
  const file = `${name}.png`;
  await page.screenshot({ path: `${out}/${file}` });
  results[name] = {
    viewport: `${vp.w}x${vp.h}`, tab: tab ?? 'dashboard', net, cpu, webgl, firstUsableMs: usable, fcpMs: firstPaintMs && Math.round(firstPaintMs),
    transferKB: Math.round(nb.total() / 1024), jsTransferKB: Math.round(nb.js() / 1024), requests: nb.rows.length,
    jsHeapMB: pm.JSHeapUsedSize ? Math.round(pm.JSHeapUsedSize / 1048576) : null, nodes: pm.Nodes, layoutCount: pm.LayoutCount, ...m, shot: file,
  };
  await ctx.close();
  if (!webgl) await b.close();
  console.log(name, JSON.stringify({ u: usable, x: m.xOverflow, c: m.canvases.length, gl: m.gl.ok, small: m.smallTargets, lt: m.longTaskMaxMs, kb: results[name].transferKB, heap: results[name].jsHeapMB }));
}

for (const k of ['d1440', 'd1920', 'p390', 'l844', 't820', 't1024']) await run(`dash_${k}`, VIEWPORTS[k]);
for (const t of ['Map', 'Agents', 'Execution']) { await run(`${t.toLowerCase()}_p390`, VIEWPORTS.p390, { tab: t }); await run(`${t.toLowerCase()}_d1440`, VIEWPORTS.d1440, { tab: t }); }
await run('dash_p320', VIEWPORTS.p320);
await run('dash_p390_4g_cpu4', VIEWPORTS.p390, { net: '4g', cpu: 4, settle: 8000 });
await run('dash_p390_nowebgl', VIEWPORTS.p390, { webgl: false });
fs.writeFileSync(`${out}/baseline.json`, JSON.stringify({ server: srv.url, generated: new Date().toISOString(), results }, null, 1));
await browser.close();
srv.close();
