#!/usr/bin/env node
// V12 layout matrix: ONE experience in every layout and orientation, checked as pairs (portrait vs landscape of the same device).
//   node scripts/e2e/mobile_matrix.mjs [--url http://localhost:5190/] [--out artifacts/tests/mobile_matrix_v12.json] [--shots artifacts/screenshots/v12]
//        [--only 390x844,844x390] [--tabs dashboard,map] [--nowebgl]
// Needs Playwright (PLAYWRIGHT_MODULE, default 'playwright'), a Chromium (CHROME_PATH), LD_LIBRARY_PATH=$HOME/.local/lib and a web app that talks to a REAL
// backend (the dev app on :5173 / a spare vite on :5190 with VITE_API_URL=http://localhost:8787, or ?api=http://localhost:8806 for a spare in-memory API).
// Everything here is READ-ONLY against the backend: it only opens panels, switches tabs and filters, selects a robot (a UI selection, not a command).
//
// Per viewport and per tab (Dashboard / Map / Agents / Execution):
//   - tab reachable and selected, no horizontal page overflow (also with the panel open)
//   - the Communications launcher is visible; it opens a panel with rows (frames to first row measured), closes, reopens x3
//   - the panel host exposes every panel tab (Comms / Done / Team / Scorecard) and each one opens
//   - a control inventory (tabs, launcher chips, panel tabs, scenario input, playback controls, robot roster access ...)
// Per device pair: the inventories must be EQUAL in both orientations (the run fails if either lacks one), rotation keeps the tab, the open panel, the
// filter and search text, the selected robot and the run, and one side-by-side image per tab is written to <shots>/pairs/.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const flag = (k) => process.argv.includes(`--${k}`);
const url = arg('url', 'http://localhost:5190/');
const out = arg('out', 'artifacts/tests/mobile_matrix_v12.json');
const shots = arg('shots', 'artifacts/screenshots/v12');
const only = arg('only', '')?.split(',').filter(Boolean);
const TABS = (arg('tabs', 'dashboard,map,agents,execution')).split(',');
const SETTLE = Number(arg('settle', 2500));
mkdirSync(`${shots}/pairs`, { recursive: true });
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

// device classes: touch + DPR like the real device; desktops use a mouse
const V = {
  '390x844': { w: 390, h: 844, touch: true, dpr: 3 },
  '844x390': { w: 844, h: 390, touch: true, dpr: 3 },
  '932x430': { w: 932, h: 430, touch: true, dpr: 3 },
  '430x932': { w: 430, h: 932, touch: true, dpr: 3 },
  '768x1024': { w: 768, h: 1024, touch: true, dpr: 2 },
  '1024x768': { w: 1024, h: 768, touch: true, dpr: 2 },
  '820x1180': { w: 820, h: 1180, touch: true, dpr: 2 },
  '1180x820': { w: 1180, h: 820, touch: true, dpr: 2 },
  '1280x720': { w: 1280, h: 720, touch: false, dpr: 1 },
  '1440x900': { w: 1440, h: 900, touch: false, dpr: 1 },
};
const MATRIX = ['390x844', '844x390', '932x430', '768x1024', '1024x768', '1180x820', '1280x720', '1440x900'];
const PAIRS = [['390x844', '844x390'], ['430x932', '932x430'], ['768x1024', '1024x768'], ['820x1180', '1180x820']];
const run = only?.length ? only : [...new Set([...MATRIX, ...PAIRS.flat()])];
const TAB_LABEL = { dashboard: 'Dashboard', map: 'Map', agents: 'Agents', execution: 'Execution' };
const PTABS = ['comms', 'dod', 'team', 'scorecard'];

const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

/** in-page helpers, installed once per page */
const HELPERS = () => {
  const shown = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const vis = (sel, root = document) => [...root.querySelectorAll(sel)].filter(shown);
  window.__m = {
    vis,
    launcher: () => vis('button.cm-launcher')[0],
    inventory: (tab) => {
      const ids = [];
      const add = (id, ok) => ok && ids.push(id);
      for (const [k, label] of Object.entries({ dashboard: 'Dashboard', map: 'Map', agents: 'Agents', execution: 'Execution' })) {
        add(`tab:${k}`, vis('[role=tab]').some((b) => !b.classList.contains('phost__tab') && ((b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\d+$/, '') === label)));
      }
      add('launcher:comms', !!vis('button.cm-launcher')[0]);
      add('panel-entry', !!vis('.mtabs__panels, .chip--panel, button.cm-launcher')[0]);
      add('search', vis('button[aria-label=Search]').length > 0);
      add('sim-launcher', vis('.topbar .btn--primary').length > 0);
      if (tab === 'dashboard') {
        add('dashboard:health', vis('.hs').length > 0);
        add('dashboard:incident-or-ops', vis('.dd').length > 0);
        add('dashboard:scene-bar', vis('.sb').length > 0);
      }
      if (tab === 'map') {
        add('map:roster', /IR-0\d/.test(document.body.innerText));
        add('map:camera-modes', vis('.hud-cam-modes').length > 0);
        add('map:status-pill', vis('.hud-pill').length > 0);
        add('map:presets', vis('.map-dock').length > 0);
        add('map:inspector', vis('.map-rightcol, .map-rightcol *').length > 0 || /Select a robot|Inspector/i.test(document.body.innerText));
      }
      if (tab === 'agents') {
        add('agents:list', vis('.ag-left, .ag > *').length > 0);
        add('agents:inspector', vis('.ag-inspector, .ag aside, .ag section').length > 0 || /SENTINEL|seats|task/i.test(document.body.innerText));
      }
      if (tab === 'execution') {
        add('execution:state', vis('.ex-state').length > 0);
        add('execution:scenario-input', vis('.ex-library textarea').length > 0);
        add('execution:scenarios', vis('.ex-library').length > 0);
        // compact chrome shows one Execution panel at a time: the control is "there" when its panel is open OR its toggle chip is on screen (and a row check opens it)
        const chip = (t) => vis('.ex-state button.chip').some((b) => new RegExp(`^${t}`).test(b.textContent.trim()));
        add('execution:playback', vis('.ex-tl button[title=Play], .ex-tl button[title=Pause]').length > 0 || chip('Timeline'));
        add('execution:timeline', vis('.ex-tl .ex-track').length > 0 || chip('Timeline'));
        add('execution:inspector', vis('.ex-right').length > 0 || chip('Details'));
        add('execution:toggle-chips', chip('Scenarios') && chip('Timeline') && chip('Details'));
      }
      return ids.sort();
    },
    overflow: () => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }),
    /** click the visible launcher and count animation frames until the first row exists */
    openAndCount: () =>
      new Promise((res) => {
        const b = window.__m.launcher();
        if (!b) return res({ error: 'no launcher' });
        const t0 = performance.now();
        b.click();
        let f = 0;
        const chk = () => {
          const rows = document.querySelectorAll('#lk-comms-panel .cm-row').length;
          if (rows) return res({ frames: f, ms: Math.round(performance.now() - t0), rows });
          if (++f > 900) return res({ frames: f, ms: -1, rows: 0 });
          requestAnimationFrame(chk);
        };
        requestAnimationFrame(chk);
      }),
    /** programmatic click on the first VISIBLE match (real taps are flaky when the software GL renderer starves the main thread) */
    click: (sel, re) => {
      const el = vis(sel).find((e) => !re || new RegExp(re).test(((e.getAttribute('aria-label') || '') + ' ' + (e.textContent || '')).trim()));
      if (!el) return false;
      el.click();
      return true;
    },
    hostKind: () => {
      const h = document.querySelector('.phost, .sheet.phost');
      return h ? (h.classList.contains('phost--dock') ? 'dock' : h.classList.contains('phost--drawer') ? 'drawer' : 'sheet') : null;
    },
  };
};

async function newPage(vp, { noWebgl = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dpr, hasTouch: vp.touch, isMobile: vp.touch && Math.min(vp.w, vp.h) < 600 });
  if (noWebgl) await ctx.addInitScript(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/i.test(t) ? null : g.call(this, t, ...a); }; });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 160)));
  page.on('console', (m) => m.type() === 'error' && !/WebGL|GPU|Failed to load resource|context|ResizeObserver/i.test(m.text()) && errs.push(m.text().slice(0, 160)));
  await page.goto(url);
  await page.waitForSelector('[role=tab]', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(SETTLE + 2500);
  await page.evaluate(HELPERS);
  return { ctx, page, errs };
}

async function gotoTab(page, tab) {
  const label = TAB_LABEL[tab];
  const ok = await page.evaluate((l) => window.__m.click('[role=tab]:not(.phost__tab)', `^${l}`), label);
  if (!ok) throw new Error(`tab ${label} not reachable`);
  await page.waitForTimeout(SETTLE);
}
const active = (page) => page.evaluate(() => window.__lkApp?.useUi.getState().tab ?? null);
const commsOpen = (page) => page.locator('#lk-comms-panel').count().then((n) => n > 0);
async function closeComms(page) {
  if (!(await commsOpen(page))) return;
  await page.evaluate(() => window.__m.click('.phost__close, .sheet .cm-x, button.cm-x'));
  await page.locator('#lk-comms-panel').waitFor({ state: 'detached', timeout: 8000 });
}
async function openComms(page) {
  if (await commsOpen(page)) return page.evaluate(() => ({ frames: 0, ms: 0, rows: document.querySelectorAll('#lk-comms-panel .cm-row').length, byDefault: true }));
  return page.evaluate(() => window.__m.openAndCount());
}

const report = { schema: 'loopkeeper.layout-matrix/v12', at: new Date().toISOString(), url, browser: await browser.version(), note: 'headless Chromium device emulation (touch, DPR, viewport); no physical iOS/Android device', rows: [], pairs: [], failures: [] };
const fail = (m) => { report.failures.push(m); console.log('FAIL', m); };
const inv = {}; // inv[vp][tab] = ids

for (const name of run) {
  const vp = V[name];
  if (!vp) continue;
  const { ctx, page, errs } = await newPage(vp, { noWebgl: flag('nowebgl') });
  inv[name] = {};
  const layout = await page.evaluate(() => ({ ...document.documentElement.dataset }));
  for (const tab of TABS) {
    const row = { viewport: name, tab, layout: layout.layout, compact: layout.compact, host: layout.commsHost, checks: {} };
    try {
      await gotoTab(page, tab);
      row.checks.tab_selected = (await active(page)) === tab;
      await closeComms(page).catch(() => {});
      const ov0 = await page.evaluate(() => window.__m.overflow());
      row.checks.no_overflow_closed = ov0.sw <= ov0.cw + 1 && ov0.bw <= ov0.cw + 1;
      row.overflow = ov0;
      inv[name][tab] = await page.evaluate((t) => window.__m.inventory(t), tab);
      row.inventory = inv[name][tab];
      await page.screenshot({ path: `${shots}/${tab}_${name}.png` });
      if (tab === 'execution') {
        // playback must be reachable in every layout: open the Timeline panel through its chip when it is not already showing
        if (!(await page.evaluate(() => window.__m.vis('.ex-tl button[title=Play], .ex-tl button[title=Pause]').length > 0))) await page.evaluate(() => window.__m.click('.ex-state button.chip', '^Timeline'));
        await page.waitForTimeout(700);
        row.checks.playback_reachable = await page.evaluate(() => window.__m.vis('.ex-tl button[title=Play], .ex-tl button[title=Pause]').length > 0);
      }
      // launcher visible, panel opens with rows, closes, reopens x3
      row.checks.launcher_visible = await page.evaluate(() => !!window.__m.launcher());
      const first = await openComms(page);
      row.checks.opens_with_rows = (first.rows ?? 0) > 0;
      row.first_open = first;
      row.host_kind = await page.evaluate(() => window.__m.hostKind());
      row.checks.host_matches_layout = row.host_kind === layout.commsHost;
      const ov1 = await page.evaluate(() => window.__m.overflow());
      row.checks.no_overflow_open = ov1.sw <= ov1.cw + 1 && ov1.bw <= ov1.cw + 1;
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})))); // the dock / drawer / sheet slides in
      const box = await page.locator('#lk-comms-panel').first().boundingBox();
      row.checks.panel_fits_viewport = !!box && box.x >= -1 && box.y >= -1 && box.x + box.width <= vp.w + 1 && box.y + box.height <= vp.h + 1;
      await page.screenshot({ path: `${shots}/${tab}_${name}_comms.png` });
      // every panel is reachable from the host tab strip, from every tab
      const ptabs = await page.evaluate((ids) => ids.filter((k) => window.__m.vis(`[data-testid=ptab-${k}]`).length > 0), PTABS);
      row.checks.panel_tabs_all = ptabs.length === 4;
      inv[name][tab] = [...inv[name][tab], ...ptabs.map((k) => `ptab:${k}`)].sort();
      for (const k of ['dod', 'team', 'scorecard']) {
        await page.evaluate((k) => window.__m.click(`[data-testid=ptab-${k}]`), k);
        await page.waitForTimeout(700);
        const label = { dod: 'Definition of Done', team: 'Team', scorecard: 'Evaluation scorecard' }[k];
        row.checks[`panel_${k}_opens`] = (await page.locator(`.phost__body [aria-label="${label}"]`).count()) > 0;
      }
      await page.evaluate(() => window.__m.click('[data-testid=ptab-comms]'));
      await page.waitForTimeout(700);
      row.checks.comms_back = await commsOpen(page);
      await closeComms(page).catch(() => {});
      // reopen x3: rows must be there within a few frames each time
      const reopen = [];
      for (let i = 0; i < 3; i++) {
        if (await commsOpen(page)) await closeComms(page);
        const r = await page.evaluate(() => window.__m.openAndCount());
        reopen.push(r);
        await page.waitForTimeout(250);
      }
      row.reopen = reopen;
      row.checks.reopen_x3_rows = reopen.every((r) => r.rows > 0);
      row.checks.reopen_rows_within_5_frames = reopen.every((r) => r.rows > 0 && r.frames <= 5);
      await closeComms(page).catch(() => {});
      row.checks.closes = !(await commsOpen(page));
    } catch (e) {
      row.error = String(e.message).slice(0, 200);
      row.checks.exception = false;
    }
    for (const [k, v] of Object.entries(row.checks)) if (v === false) fail(`${name} ${tab}: ${k}${row.error ? ' (' + row.error + ')' : ''}`);
    report.rows.push(row);
    console.log(name.padEnd(9), tab.padEnd(9), row.layout, row.host_kind ?? '-', Object.entries(row.checks).filter(([, v]) => v === false).map(([k]) => k).join(',') || 'ok', JSON.stringify(row.first_open ?? {}));
  }
  if (errs.length) report.rows.push({ viewport: name, console_errors: errs.slice(0, 5) });
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------------- parity per device pair
for (const [p, l] of PAIRS) {
  if (!inv[p] || !inv[l]) continue;
  const pair = { portrait: p, landscape: l, tabs: {} };
  for (const tab of TABS) {
    const a = inv[p][tab] ?? [];
    const b = inv[l][tab] ?? [];
    const missingInLandscape = a.filter((x) => !b.includes(x));
    const missingInPortrait = b.filter((x) => !a.includes(x));
    pair.tabs[tab] = { portrait: a, landscape: b, missingInLandscape, missingInPortrait, equal: !missingInLandscape.length && !missingInPortrait.length };
    if (!pair.tabs[tab].equal) fail(`parity ${p} vs ${l} ${tab}: portrait lacks [${missingInPortrait}] landscape lacks [${missingInLandscape}]`);
  }
  report.pairs.push(pair);
}

// ---------------------------------------------------------------------------------------------------------------- rotation keeps state
async function rotation(pName, lName) {
  const res = { pair: `${pName} -> ${lName} -> ${pName}`, checks: {} };
  const { ctx, page, errs } = await newPage(V[pName]);
  try {
    await gotoTab(page, 'map');
    // select a robot (UI selection only), open Communications, set a filter and a search text
    const robot = await page.evaluate(() => { const w = window.__lkApp.useWorld.getState(); const id = Object.keys(w.robots)[0]; if (id) window.__lkApp.useView.getState().select(id); return id ?? null; });
    res.robot = robot;
    await closeComms(page).catch(() => {});
    await page.evaluate(() => window.__m.openAndCount());
    await page.evaluate(() => window.__m.click('.cm-chip', '^Tools'));
    await page.locator('.cm-search input').fill('ir-');
    await page.waitForTimeout(600);
    const snap = () => page.evaluate(() => ({
      tab: window.__lkApp.useUi.getState().tab,
      selected: window.__lkApp.useView.getState().selectedId,
      open: !!document.querySelector('#lk-comms-panel'),
      host: window.__m.hostKind(),
      filter: document.querySelector('.cm-chip[aria-pressed=true]')?.textContent?.trim() ?? null,
      query: document.querySelector('.cm-search input')?.value ?? null,
      run: document.querySelector('.cm-run')?.textContent?.trim() ?? null,
      layout: document.documentElement.dataset.layout + '/' + document.documentElement.dataset.orient,
    }));
    const s0 = await snap();
    for (const [w, h] of [[V[lName].w, V[lName].h], [V[pName].w, V[pName].h]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(1800);
      const s = await snap();
      const k = `${w}x${h}`;
      res.checks[`${k}: same tab`] = s.tab === s0.tab;
      res.checks[`${k}: selected robot kept`] = s.selected === s0.selected;
      res.checks[`${k}: panel still open`] = s.open;
      res.checks[`${k}: filter kept`] = s.filter === s0.filter;
      res.checks[`${k}: search text kept`] = s.query === s0.query;
      res.checks[`${k}: run kept`] = s.run === s0.run;
      res.after = { ...(res.after ?? {}), [k]: s };
    }
    res.before = s0;
  } catch (e) {
    res.error = String(e.message).slice(0, 200);
    res.checks.exception = false;
  }
  for (const [k, v] of Object.entries(res.checks)) if (v === false) fail(`rotation ${res.pair}: ${k}${res.error ? ' (' + res.error + ')' : ''}`);
  report.rotation = [...(report.rotation ?? []), res];
  console.log('rotation', res.pair, Object.entries(res.checks).filter(([, v]) => v === false).map(([k]) => k).join(',') || 'ok');
  await ctx.close();
}
for (const [p, l] of [['390x844', '844x390'], ['768x1024', '1024x768']]) if (run.includes(p) && run.includes(l)) await rotation(p, l);

// ---------------------------------------------------------------------------------------------------------------- side-by-side images (portrait left, landscape right)
const b64 = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
for (const [p, l] of PAIRS) {
  if (!inv[p] || !inv[l]) continue;
  for (const tab of TABS) {
    for (const suffix of ['', '_comms']) {
      try {
        const fp = `${shots}/${tab}_${p}${suffix}.png`;
        const fl = `${shots}/${tab}_${l}${suffix}.png`;
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        await page.setContent(`<body style="margin:0;background:#2b2f36;display:flex;gap:16px;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;height:100vh"><figure style="margin:0;color:#aab;font:12px sans-serif;height:100%;display:flex;flex-direction:column;gap:6px;align-items:center"><img style="height:calc(100% - 20px)" src="${b64(fp)}"/><figcaption>${p} portrait</figcaption></figure><figure style="margin:0;color:#aab;font:12px sans-serif;height:100%;display:flex;flex-direction:column;gap:6px;align-items:center;min-width:0"><img style="max-width:100%;max-height:calc(100% - 20px)" src="${b64(fl)}"/><figcaption>${l} landscape</figcaption></figure></body>`);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${shots}/pairs/${tab}_${p}__${l}${suffix}.png` });
        await page.close();
      } catch { /* a missing half (failed row) is already reported */ }
    }
  }
}

mkdirSync(dirname(out), { recursive: true });
report.failures_total = report.failures.length;
writeFileSync(out, JSON.stringify(report, null, 2));
await browser.close();
console.log(report.failures.length ? `\n${report.failures.length} FAILURES` : '\nALL CHECKS PASSED');
process.exit(report.failures.length ? 1 : 0);
