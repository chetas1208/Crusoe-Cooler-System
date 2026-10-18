#!/usr/bin/env node
// Top-level chrome must never overlap: pairwise getBoundingClientRect intersections of the top bar clusters and the panels that sit beside them,
// at the sizes the user reported plus the phone / tablet / desktop matrix, on Dashboard and Execution. Also screenshots (top bar crop + full page).
//   node scripts/e2e/chrome_overlap.mjs [--url http://localhost:5191/] [--out artifacts/tests/chrome_overlap_v12.json] [--shots artifacts/screenshots/v12/topbar]
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://localhost:5191/');
const out = arg('out', 'artifacts/tests/chrome_overlap_v12.json');
const shots = arg('shots', 'artifacts/screenshots/v12/topbar');
const only = arg('only', '')?.split(',').filter(Boolean);
mkdirSync(shots, { recursive: true });
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const SIZES = ['3840x2160', '2878x1200', '2560x1440', '1920x1080', '1440x900', '1280x720', '1180x820', '1024x768', '932x430', '844x390', '768x1024', '390x844', '320x640'];
const TABS = ['dashboard', 'execution'];
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const rows = [];
const failures = [];

const probe = () => {
  const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const compact = document.documentElement.dataset.compact === '1';
  const regular = ['.topbar__left', '.topbar__center', '.topbar__right', '.hs', '.dd', '.sb', '.ad', '.ex-state', '.ex-left', '.ex-right', '.ex-tl', '.ex-library', '.phost--dock', '.phost--drawer', '.map-leftcol', '.map-rightcol', '.map-dock'];
  const compactSet = ['.topbar__left', '.topbar__right', '.mtabs', '.phost--sheet', '.sheet', '.phost--drawer'];
  const names = compact ? compactSet : regular;
  const items = [];
  for (const sel of names) for (const el of document.querySelectorAll(sel)) if (shown(el)) { const r = el.getBoundingClientRect(); if (r.width > 4 && r.height > 4) items.push({ sel, x: r.x, y: r.y, w: r.width, h: r.height, el }); }
  const hits = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (ix > 2 && iy > 2) hits.push(`${a.sel} x ${b.sel} (${Math.round(ix)}x${Math.round(iy)} px)`);
  }
  const bar = document.querySelector('.topbar');
  const wraps = [...document.querySelectorAll('.topbar .vital__label, .topbar .btn--sim, .topbar .status__name, .topbar .cm-launcher')].filter(shown).filter((e) => e.getBoundingClientRect().height > 40).map((e) => e.className);
  const tbox = bar?.getBoundingClientRect();
  const parts = ['.topbar__left', '.topbar__center', '.topbar__right'].map((s) => document.querySelector(s)).filter((e) => e && shown(e));
  const outside = parts.filter((p) => { const r = p.getBoundingClientRect(); return tbox && (r.right > tbox.right + 1 || r.left < tbox.left - 1); }).length;
  return { compact, level: bar?.dataset.d ?? null, hits, wraps, outside, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, panels: items.length };
};

for (const size of only?.length ? only : SIZES) {
  const [w, h] = size.split('x').map(Number);
  const touch = Math.min(w, h) <= 1024 && w < 1280;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch && Math.min(w, h) < 600 });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector('.topbar', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);
  for (const tab of TABS) {
    await page.keyboard.press(String(['dashboard', 'map', 'agents', 'execution'].indexOf(tab) + 1));
    await page.waitForTimeout(3500);
    const r = await page.evaluate(probe);
    const row = { size, tab, ...r };
    rows.push(row);
    const bad = r.hits.length || r.wraps.length || r.outside || r.sw > r.cw + 1;
    if (bad) failures.push(`${size} ${tab}: ${[...r.hits, ...r.wraps.map((x) => 'wrapped:' + x), r.outside ? 'bar cluster outside bar' : '', r.sw > r.cw + 1 ? 'h-overflow' : ''].filter(Boolean).join('; ')}`);
    console.log(size.padEnd(10), tab.padEnd(10), r.compact ? 'compact' : 'regular', 'level', r.level, bad ? 'FAIL ' + r.hits.join('; ') + ' ' + r.wraps.join(',') : 'ok');
    await page.screenshot({ path: `${shots}/${tab}_${size}.png`, timeout: 120000 });
    if (!r.compact) await page.screenshot({ path: `${shots}/${tab}_${size}_bar.png`, clip: { x: 0, y: 0, width: Math.min(w, 2878), height: Math.min(h, 200) }, timeout: 120000 });
  }
  await ctx.close();
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ schema: 'loopkeeper.chrome-overlap/v12', at: new Date().toISOString(), url, rows, failures }, null, 2));
await browser.close();
console.log(failures.length ? `\n${failures.length} FAILURES` : '\nNO OVERLAPS');
process.exit(failures.length ? 1 : 0);
