#!/usr/bin/env node
// Viewport matrix for the Execution tab panels (Communications, Definition of Done, Team, Scorecard) against a REAL backend.
//   node scripts/e2e/mobile_matrix.mjs --url "http://localhost:5183/?api=http://localhost:8801" [--out artifacts/tests/mobile_matrix.json] [--shots artifacts/screenshots/v11/mobile]
// Per viewport (and once more with WebGL disabled): no horizontal page overflow, panels open/close from their launchers, touch-target
// sizes of the controls we ship, console errors, first-usable time, and a screenshot. Headless Chromium emulation only: no physical phone.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://localhost:5183/?api=http://localhost:8801');
const out = arg('out', 'artifacts/tests/mobile_matrix.json');
const shots = arg('shots', 'artifacts/screenshots/v11/mobile');
mkdirSync(shots, { recursive: true });
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const VIEWPORTS = [
  { name: '390x844', w: 390, h: 844, touch: true, dpr: 3 },
  { name: '844x390', w: 844, h: 390, touch: true, dpr: 3 },
  { name: '820x1180', w: 820, h: 1180, touch: true, dpr: 2 },
  { name: '1024x768', w: 1024, h: 768, touch: true, dpr: 2 },
];
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];

async function run(vp, noWebgl) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr, hasTouch: vp.touch, isMobile: vp.w < 900, userAgent: undefined });
  if (noWebgl) await ctx.addInitScript(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/i.test(t) ? null : g.call(this, t, ...a); }; });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 160)));
  page.on('console', (m) => m.type() === 'error' && !/WebGL|GPU|Failed to load resource|context/i.test(m.text()) && errs.push(m.text().slice(0, 160)));
  const r = { viewport: vp.name, webgl: !noWebgl, checks: {}, errors: [] };
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForSelector('[role=tab], .mtab, nav', { timeout: 40000 }).catch(() => {});
  r.first_usable_ms = Date.now() - t0;
  await page.waitForTimeout(5000);
  const tabBtn = page.getByRole('tab', { name: /Execution/ }).or(page.locator('button', { hasText: /^Execution$/ })).first();
  await tabBtn.tap({ timeout: 8000 }).catch(async () => { await page.keyboard.press('4'); });
  await page.waitForTimeout(3500);
  await page.keyboard.press('Escape'); // close the scenario library overlay
  await page.waitForTimeout(400);
  const overflow = async () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
  const ov = await overflow();
  r.checks.no_horizontal_overflow = ov.sw <= ov.cw + 1 && ov.bw <= ov.cw + 1;
  r.overflow = ov;
  const pick = async (label, locator, expectSel) => {
    try {
      await locator.first().tap({ timeout: 6000 });
      await page.waitForSelector(expectSel, { timeout: 6000 });
      const box = await page.locator(expectSel).first().boundingBox();
      const o2 = await overflow();
      r.checks[label] = { opens: true, fits_viewport: !!box && box.x >= -1 && box.x + box.width <= vp.w + 1, no_overflow: o2.sw <= o2.cw + 1 };
    } catch (e) {
      r.checks[label] = { opens: false, error: String(e.message).slice(0, 120) };
    }
  };
  // Communications
  const comms = page.locator('button.cm-launcher');
  r.comms_launcher_visible = (await comms.count()) > 0 && (await comms.first().isVisible().catch(() => false));
  const commsOpen = await page.locator('#lk-comms-panel').count();
  if (!commsOpen) await pick('communications', comms, '#lk-comms-panel');
  else r.checks.communications = { opens: true, opened_by_default: true };
  r.comms_in_sheet = await page.locator('.sheet #lk-comms-panel').count() > 0;
  r.comms_panels_in_dom = await page.locator('#lk-comms-panel').count();
  await page.screenshot({ path: `${shots}/${vp.name}${noWebgl ? '_nowebgl' : ''}_comms.png` });
  // close comms
  await page.locator('#lk-comms-panel .cm-x').first().tap().catch(() => {});
  await page.waitForTimeout(400);
  // DOD / Team / Scorecard
  await pick('definition_of_done', page.locator('button.chip', { hasText: /^Done$/ }), '.dd-panel[aria-label="Definition of Done"]');
  r.dod_in_sheet = await page.locator('.sheet .dd-panel').count() > 0;
  await page.screenshot({ path: `${shots}/${vp.name}${noWebgl ? '_nowebgl' : ''}_dod.png` });
  // when the sheet is open the page's chip rail may be behind it: use the toggles inside the sheet if present
  const chip = (name) => ((page.locator('.sheet .dd-sheetchips').count()) ? page.locator('.sheet .dd-sheetchips button.chip', { hasText: name }) : page.locator('button.chip', { hasText: name }));
  await pick('team', await chip(/^Team$/).count() ? chip(/^Team$/) : page.locator('button.chip', { hasText: /^Team$/ }), '.dd-panel[aria-label="Team"]');
  await pick('scorecard', await chip(/^Scorecard$/).count() ? chip(/^Scorecard$/) : page.locator('button.chip', { hasText: /^Scorecard$/ }), '.sc-panel');
  await page.screenshot({ path: `${shots}/${vp.name}${noWebgl ? '_nowebgl' : ''}_scorecard.png` });
  // touch targets of shipped controls (CSS px). WCAG 2.5.8 minimum 24, platform guidance 44.
  r.touch_targets = await page.evaluate(() => {
    const sel = ['button.cm-launcher', '.cm-x', '.cm-chip', 'button.chip', '.sheet__btn', '.dd-x', '.cm-search input'];
    const out = {};
    for (const s of sel) {
      const els = [...document.querySelectorAll(s)].filter((e) => e.getBoundingClientRect().width > 0);
      if (!els.length) continue;
      const hs = els.map((e) => Math.round(e.getBoundingClientRect().height)), ws = els.map((e) => Math.round(e.getBoundingClientRect().width));
      out[s] = { n: els.length, min_h: Math.min(...hs), min_w: Math.min(...ws) };
    }
    return out;
  });
  r.errors = errs.slice(0, 5);
  await ctx.close();
  return r;
}

for (const vp of VIEWPORTS) results.push(await run(vp, false));
results.push(await run(VIEWPORTS[0], true)); // phone portrait with WebGL disabled
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ schema: 'loopkeeper.mobile-matrix/v1', at: new Date().toISOString(), url, browser: await browser.version(), note: 'headless Chromium device emulation (touch, DPR, viewport); no physical iOS/Android device', results }, null, 2));
await browser.close();
for (const r of results) console.log(r.viewport, r.webgl ? 'webgl' : 'NO-WEBGL', 'overflow-ok', r.checks.no_horizontal_overflow, 'comms', JSON.stringify(r.checks.communications), 'dod', r.checks.definition_of_done?.opens, 'team', r.checks.team?.opens, 'score', r.checks.scorecard?.opens, 'sheet(c/d)', r.comms_in_sheet, r.dod_in_sheet, 'usable', r.first_usable_ms + 'ms', r.errors.length ? 'ERR ' + r.errors[0] : '');
