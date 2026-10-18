#!/usr/bin/env node
// V12 R: Map tab layout check. One chromium, run it niced:  nice -n 15 node scripts/e2e/map_layout.mjs
//   WEB=http://127.0.0.1:5218 API=http://127.0.0.1:8818 ROBOT=OR-03 VPS=1280x720,1440x900 node scripts/e2e/map_layout.mjs
// For every viewport: open the Map tab with a robot selected, read getBoundingClientRect of every [data-panel] element that is on screen,
// assert NO pairwise overlap (nested panels excepted) and that the control strip shows the required fields; screenshot to artifacts/screenshots/v12/r/.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? '/tmp/claude-1989081997/shots/node_modules/playwright');
const WEB = process.env.WEB ?? 'http://127.0.0.1:5218';
const API = process.env.API ?? 'http://127.0.0.1:8818';
const ROBOT = process.env.ROBOT ?? 'OR-03';
const VPS = (process.env.VPS ?? '1280x720,1440x900,1920x1080,2560x1440,844x390,390x844').split(',').map((v) => v.split('x').map(Number));
const OUT = new URL('../../artifacts/screenshots/v12/r/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];
let failed = 0;
try {
  for (const [w, h] of VPS) {
    const mobile = w < 900 || h < 500;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120000);
    await page.goto(`${WEB}/?e2e=1&viewer=lite&api=${encodeURIComponent(API)}`);
    await sleep(8000);
    if (mobile) {
      await page.locator('button, [role=tab]').filter({ hasText: /^\s*Map\s*$/ }).first().click().catch(() => page.keyboard.press('2'));
    } else await page.keyboard.press('2');
    await sleep(2500);
    const search = page.getByPlaceholder(/Search \d+ robots/);
    if (await search.count()) { await search.fill(ROBOT); await sleep(500); }
    await page.getByText(ROBOT, { exact: false }).first().click().catch(() => {});
    await sleep(2500);
    const tag = `${w}x${h}`;
    const m = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
      const els = [...document.querySelectorAll('.map-tab-container [data-panel], .map-hudwrap [data-panel]')].filter(vis);
      const rect = (e) => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; };
      const panels = els.map((e, i) => ({ i, id: e.getAttribute('data-panel'), ...rect(e) }));
      const overlaps = [];
      for (let a = 0; a < els.length; a++) for (let b = a + 1; b < els.length; b++) {
        if (els[a].contains(els[b]) || els[b].contains(els[a])) continue;
        const A = panels[a], B = panels[b];
        const ox = Math.min(A.r, B.r) - Math.max(A.l, B.l), oy = Math.min(A.b, B.b) - Math.max(A.t, B.t);
        if (ox > 1 && oy > 1) overlaps.push({ a: A.id, b: B.id, ox, oy });
      }
      const strip = document.querySelector('[data-panel="control-hud"]');
      const txt = strip ? strip.innerText : '';
      const fields = { robot_id: /OR-\d\d|IR-\d\d/.test(txt), owner: !!strip?.querySelector('[data-testid=owner-chip]'), mode: /MODE/i.test(txt), speed: /SPEED/i.test(txt), segment: /SEGMENT|ROAD/i.test(txt), battery: /BATTERY/i.test(txt), link: /LINK/i.test(txt), button: /Take Control|Release|Acknowledge|Acquiring/.test(txt) };
      const sr = strip ? strip.getBoundingClientRect() : null;
      const inView = !!sr && sr.left >= 0 && sr.right <= innerWidth && sr.top >= 0 && sr.bottom <= innerHeight;
      return { panels, overlaps, fields, strip_text: txt.replace(/\s+/g, ' ').slice(0, 220), strip_in_viewport: inView, strip_rect: sr && { l: Math.round(sr.left), t: Math.round(sr.top), r: Math.round(sr.right), b: Math.round(sr.bottom) } };
    });
    let shot = 'ok';
    for (let k = 0; k < 3; k++) {
      try { await page.screenshot({ path: `${OUT}layout_${tag}.png`, timeout: 90000 }); shot = 'ok'; break; } catch (e) { shot = 'failed: ' + String(e.message).split('\n')[0]; }
    }
    m.shot = shot;
    const missing = Object.entries(m.fields).filter(([, v]) => !v).map(([k]) => k);
    const ok = m.overlaps.length === 0 && missing.length === 0 && m.strip_in_viewport;
    if (!ok) failed++;
    results.push({ viewport: tag, screenshot: shot, ok, overlaps: m.overlaps, missing_fields: missing, strip_in_viewport: m.strip_in_viewport, strip_rect: m.strip_rect, panel_ids: m.panels.map((p) => p.id), strip_text: m.strip_text });
    console.log(tag, ok ? 'OK' : 'FAIL', JSON.stringify({ overlaps: m.overlaps, missing, in_view: m.strip_in_viewport, panels: m.panels.map((p) => `${p.id}[${p.l},${p.t},${p.r},${p.b}]`) }));
    await ctx.close();
  }
} finally {
  await browser.close();
}
writeFileSync(`${OUT}layout_results.json`, JSON.stringify(results, null, 1));
process.exit(failed ? 1 : 0);
