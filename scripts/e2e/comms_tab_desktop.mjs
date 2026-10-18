#!/usr/bin/env node
// Desktop Communications TAB check (regular chrome, >= 900 x 520): ONE chromium, one context per size.
//   nice -n 15 node scripts/e2e/comms_tab_desktop.mjs [--url http://localhost:5191/] [--sizes 1440x900,1920x1080,1280x720,2560x1440] [--shots artifacts/screenshots/v12/comms_tab]
// Per size and per tab (Dashboard / Map / Agents / Execution): the tab-styled Comms button is visible in the top bar tab group, the panel is docked open on first
// load (no click), takes layout space (the app narrows beside it) instead of floating over controls, overlaps no other chrome, shows rows from the live API (read-only),
// `C` toggles it, Escape closes it, and reopening shows rows again.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://localhost:5191/');
const shots = arg('shots', 'artifacts/screenshots/v12/comms_tab');
const sizes = arg('sizes', '1440x900,1920x1080,1280x720,2560x1440').split(',');
const out = arg('out', 'artifacts/tests/comms_tab_desktop_v12.json');
mkdirSync(shots, { recursive: true });
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const TABS = ['dashboard', 'map', 'agents', 'execution'];
const rows = [];
const failures = [];
const state = () => {
  const shown = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const r = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; };
  const tab = document.querySelector('[data-testid=comms-tab]');
  const dock = document.querySelector('.phost--dock');
  const app = document.querySelector('.app');
  const bar = ['.topbar__left', '.topbar__center', '.topbar__right'].map((s) => document.querySelector(s)).filter(shown).map((e) => ({ s: e.className.split(' ')[0], ...r(e) }));
  const sib = [...document.querySelectorAll('.seg__item')].filter((e) => shown(e) && !e.classList.contains('cm-launcher') && e.closest('.topbar'));
  const clip = ['.hs', '.dd', '.sb', '.ad', '.ex-state', '.ex-left', '.ex-right', '.ex-tl', '.ex-library', '.map-leftcol', '.map-rightcol', '.map-dock', '.ag', '.drivepad'].flatMap((s) => [...document.querySelectorAll(s)].filter(shown).map((e) => ({ s, ...r(e) })));
  return {
    tab: tab && shown(tab) ? { ...r(tab), text: tab.textContent.trim(), aria: tab.getAttribute('aria-label'), pressed: tab.getAttribute('aria-pressed'), sibH: sib[0] ? r(sib[0]).h : null } : null,
    dock: dock && shown(dock) ? r(dock) : null,
    app: app ? r(app) : null,
    dockAttr: document.documentElement.dataset.dock,
    rows: document.querySelectorAll('#lk-comms-panel .cm-row').length,
    panel: document.querySelector('#lk-comms-panel') ? r(document.querySelector('#lk-comms-panel')) : null,
    bar, clip, vw: innerWidth, vh: innerHeight,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};
const inter = (a, b) => Math.min(a.r, b.r) - Math.max(a.x, b.x) > 2 && Math.min(a.b, b.b) - Math.max(a.y, b.y) > 2;
for (const size of sizes) {
  const [w, h] = size.split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await page.goto(url);
  await page.waitForSelector('[data-testid=comms-tab]', { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(6000);
  for (const [i, tab] of TABS.entries()) {
    const row = { size, tab, checks: {} };
    try {
      await page.evaluate((n) => { const l = ['Dashboard', 'Map', 'Agents', 'Execution'][n]; [...document.querySelectorAll('[role=tab]')].find((b) => !b.classList.contains('phost__tab') && ((b.getAttribute('aria-label') || b.textContent).trim().replace(/\d+$/, '') === l))?.click(); }, i);
      await page.waitForTimeout(3500);
      if (i === 0) { // first load: open without any click
        const s0 = await page.evaluate(state);
        row.checks.open_by_default = !!s0.dock && s0.rows >= 0 && s0.dockAttr === 'open';
      }
      await page.waitForSelector('#lk-comms-panel .cm-row', { timeout: 30000 }).catch(() => {});
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})))); // the dock slides in; measure after it settled
      const s = await page.evaluate(state);
      row.state = { tab: s.tab, dock: s.dock, app: s.app, rows: s.rows };
      row.checks.tab_visible = !!s.tab && s.tab.w > 40;
      row.checks.tab_same_weight_as_tabs = !!s.tab && s.tab.sibH !== null && Math.abs(s.tab.h - s.tab.sibH) <= 2;
      row.checks.tab_has_text_and_state = !!s.tab && /Comms/.test(s.tab.text) && /(Live|Reconnecting|Offline|Stale|Connecting|Replay|Error)/i.test(s.tab.aria ?? '');
      row.checks.dock_visible = !!s.dock && s.dock.w >= 320 && s.dock.w <= 400 && s.dock.r === s.vw && s.dock.h === s.vh;
      row.checks.app_narrowed = !!s.app && !!s.dock && s.app.r <= s.dock.x + 1;
      row.checks.rows_shown = s.rows > 0;
      row.checks.no_h_overflow = s.overflow <= 1;
      const hits = [];
      if (s.dock) {
        for (const c of [...s.bar, ...s.clip]) if (inter(c, s.dock)) hits.push(`${c.s} x dock`);
        for (let a = 0; a < s.bar.length; a++) for (let b = a + 1; b < s.bar.length; b++) if (inter(s.bar[a], s.bar[b])) hits.push(`${s.bar[a].s} x ${s.bar[b].s}`);
      }
      row.checks.no_overlap = hits.length === 0;
      row.hits = hits;
      await page.screenshot({ path: `${shots}/${tab}_${size}.png`, timeout: 120000 });
      // keyboard: C toggles, Escape closes, C reopens with rows
      await page.evaluate(() => document.activeElement?.blur?.());
      const key = tab === 'map' ? 'Alt+c' : 'c'; // on the Map tab plain C keeps cycling the camera
      await page.keyboard.press(key); await page.waitForTimeout(900);
      row.checks.c_closes = (await page.locator('.phost--dock').count()) === 0;
      await page.keyboard.press(key); await page.waitForTimeout(1200);
      row.checks.c_opens = (await page.locator('.phost--dock').count()) === 1;
      await page.keyboard.press('Escape'); await page.waitForTimeout(900);
      row.checks.escape_closes = (await page.locator('.phost--dock').count()) === 0;
      row.checks.app_full_width_when_closed = (await page.evaluate(() => Math.round(document.querySelector('.app').getBoundingClientRect().right))) === w;
      await page.evaluate(() => document.querySelector('[data-testid=comms-tab]').click()); await page.waitForTimeout(1200);
      row.checks.reopen_rows = (await page.evaluate(() => document.querySelectorAll('#lk-comms-panel .cm-row').length)) > 0;
    } catch (e) {
      row.error = String(e.message).slice(0, 200);
      row.checks.exception = false;
    }
    for (const [k, v] of Object.entries(row.checks)) if (v === false) failures.push(`${size} ${tab}: ${k}${row.hits?.length ? ' ' + row.hits.join(',') : ''}${row.error ? ' ' + row.error : ''}`);
    rows.push(row);
    console.log(size.padEnd(10), tab.padEnd(10), Object.entries(row.checks).filter(([, v]) => v === false).map(([k]) => k).join(',') || 'ok', JSON.stringify(row.state?.dock ?? null));
  }
  if (errs.length) rows.push({ size, console_errors: errs.slice(0, 3) });
  await ctx.close();
}
writeFileSync(out, JSON.stringify({ schema: 'loopkeeper.comms-tab-desktop/v12', at: new Date().toISOString(), url, rows, failures }, null, 2));
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILURES\n${failures.join('\n')}` : '\nALL CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
