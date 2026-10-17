// V10 Playwright matrix against a built dist (device EMULATION in Chromium + SwiftShader, not real devices).
//   node scripts/mobile/matrix.mjs <distDir> <outDir>
import fs from 'node:fs';
import { launch, newPage, serve, VIEWPORTS, INIT_SCRIPT, measure, cdpNetworkBytes, NET } from './lib.mjs';

const [dist, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const srv = await serve(dist);
const browser = await launch();
const rows = [];
const EXTRA = { z200_640: { w: 640, h: 450, mobile: false }, z200_450: { w: 450, h: 600, mobile: false }, d1280x720: { w: 1280, h: 720 }, d1024: { w: 1024, h: 768 } };
const VPS = { ...VIEWPORTS, ...EXTRA };
const TABS = ['Dashboard', 'Map', 'Agents', 'Execution'];

async function clickTab(page, t) {
  await page.evaluate((t) => { const el = [...document.querySelectorAll('[role=tab]')].find((e) => e.textContent.includes(t) && e.getBoundingClientRect().width > 0); el?.click(); }, t);
  await page.waitForTimeout(700);
}

for (const [name, vp] of Object.entries(VPS)) {
  const { ctx, page } = await newPage(browser, vp);
  await page.addInitScript(INIT_SCRIPT);
  await page.goto(srv.url + '/?viewer=2d', { waitUntil: 'commit' });
  await page.waitForSelector('.topbar', { timeout: 30000 });
  await page.waitForTimeout(1500);
  for (const t of TABS) {
    await clickTab(page, t);
    const m = await measure(page);
    rows.push({ viewport: name, size: `${vp.w}x${vp.h}`, tab: t, xOverflow: m.xOverflow, scrollW: m.scrollW, clientW: m.client[0], smallTargets: m.smallTargets, smallSample: m.smallTargetSample.slice(0, 4), overflowers: m.overflowers.slice(0, 3), errors: m.errors });
    if (['d1920', 'd1440', 'p390', 'l844', 't820'].includes(name)) await page.screenshot({ path: `${out}/${name}_${t}.png` });
  }
  await ctx.close();
}

// WebGL disabled: shell + essential flows still work, viewer falls back
{
  const b = await launch({ webgl: false });
  const { ctx, page } = await newPage(b, VIEWPORTS.p390);
  await page.addInitScript(INIT_SCRIPT);
  await page.goto(srv.url + '/', { waitUntil: 'commit' });
  await page.waitForSelector('.topbar', { timeout: 30000 });
  await page.waitForTimeout(2500);
  const mode = await page.evaluate(() => document.documentElement.dataset.viewer);
  const canvas = await page.evaluate(() => !!document.querySelector('[data-testid=tactical-2d] canvas'));
  const tabsWork = [];
  for (const t of TABS) { await clickTab(page, t); tabsWork.push([t, await page.evaluate(() => !!document.querySelector('.mtabs [aria-selected=true]'))]); }
  rows.push({ viewport: 'p390-webgl-disabled', mode, tactical2dCanvas: canvas, tabsWork, errors: (await measure(page)).errors });
  await ctx.close(); await b.close();
}

// 4G + 4x CPU: first usable and bytes before 3D is requested
{
  const { ctx, page } = await newPage(browser, VIEWPORTS.p390);
  await page.addInitScript(INIT_SCRIPT);
  const nb = await cdpNetworkBytes(page);
  await nb.cdp.send('Network.emulateNetworkConditions', NET['4g']);
  await nb.cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const t0 = Date.now();
  await page.goto(srv.url + '/?viewer=2d', { waitUntil: 'commit' });
  await page.waitForSelector('.topbar', { timeout: 90000 });
  rows.push({ viewport: 'p390-4g-cpu4-2d', firstUsableMs: Date.now() - t0, transferKB: Math.round(nb.total() / 1024), jsKB: Math.round(nb.js() / 1024), threeLoaded: nb.rows.some((r) => /three-/.test(r.url)) });
  await ctx.close();
}

// stream-disabled: block the WebSocket + API, the shell must stay usable and say so
{
  const { ctx, page } = await newPage(browser, VIEWPORTS.p390);
  await page.addInitScript(INIT_SCRIPT);
  await ctx.route('**/api/**', (r) => r.abort());
  await page.goto(srv.url + '/?api=http://127.0.0.1:9', { waitUntil: 'commit' });
  await page.waitForTimeout(6000);
  rows.push({ viewport: 'p390-api-blocked', text: (await page.evaluate(() => document.body.innerText)).slice(0, 160).replace(/\n/g, ' | '), xOverflow: (await measure(page)).xOverflow });
  await page.screenshot({ path: `${out}/p390_api_blocked.png` });
  await ctx.close();
}

// 100x open/close of the Communications bottom sheet (leak check: DOM nodes + JS heap before/after, forced GC)
{
  const { ctx, page } = await newPage(browser, VIEWPORTS.p390);
  await page.addInitScript(INIT_SCRIPT);
  await page.goto(srv.url + '/?viewer=2d', { waitUntil: 'commit' });
  await page.waitForSelector('.mtabs', { timeout: 30000 });
  await page.waitForTimeout(2500);
  const cdp = await ctx.newCDPSession(page);
  const snap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(300); const m = await cdp.send('Performance.getMetrics'); const o = Object.fromEntries(m.metrics.map((x) => [x.name, x.value])); return { heapMB: +(o.JSHeapUsedSize / 1048576).toFixed(2), nodes: o.Nodes, listeners: o.JSEventListeners }; };
  await cdp.send('Performance.enable');
  const before = await snap();
  let ok = 0;
  for (let i = 0; i < 100; i++) {
    await page.locator('.mtabs .cm-launcher').click(); ok += (await page.locator('.sheet').count()) ? 1 : 0;
    await page.locator('.mtabs .cm-launcher').click();
  }
  const after = await snap();
  rows.push({ viewport: 'p390-comms-open-close-x100', opened: ok, before, after, sheetsLeft: await page.locator('.sheet').count() });
  await ctx.close();
}

// orientation change keeps tab + selection
{
  const { ctx, page } = await newPage(browser, VIEWPORTS.p390);
  await page.addInitScript(INIT_SCRIPT);
  await page.goto(srv.url + '/?viewer=2d', { waitUntil: 'commit' });
  await page.waitForSelector('.mtabs', { timeout: 30000 });
  await clickTab(page, 'Agents');
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(800);
  const sel = await page.evaluate(() => [...document.querySelectorAll('.mtabs [aria-selected=true]')].map((e) => e.textContent));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const sel2 = await page.evaluate(() => [...document.querySelectorAll('.mtabs [aria-selected=true]')].map((e) => e.textContent));
  rows.push({ viewport: 'orientation-390x844-844x390-390x844', tabAfterLandscape: sel, tabAfterPortrait: sel2 });
  await ctx.close();
}

fs.writeFileSync(`${out}/matrix.json`, JSON.stringify({ generated: new Date().toISOString(), note: 'Chromium device emulation + SwiftShader; no physical device', rows }, null, 1));
const bad = rows.filter((r) => r.xOverflow);
console.log('rows', rows.length, 'x-overflow rows', bad.length, bad.slice(0, 6).map((r) => `${r.viewport}/${r.tab}`));
console.log(JSON.stringify(rows.filter((r) => !r.tab), null, 0).slice(0, 2500));
await browser.close(); srv.close();
