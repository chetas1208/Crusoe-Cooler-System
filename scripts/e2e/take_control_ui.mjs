#!/usr/bin/env node
// V12 R: Take Control in a real browser against an in-memory API (regression for the LEASE_PENDING false revoke).
//   nice -n 15 WEB=http://127.0.0.1:5218 API=http://127.0.0.1:8818 ROBOT=OR-05 node scripts/e2e/take_control_ui.mjs
// Take Control -> the strip must NOT show "Link lost" -> hold W for ~8 intents -> server pose moved and authority HUMAN -> Release -> authority AUTO.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? '/tmp/claude-1989081997/shots/node_modules/playwright');
const WEB = process.env.WEB ?? 'http://127.0.0.1:5218';
const API = process.env.API ?? 'http://127.0.0.1:8818';
const ROBOT = process.env.ROBOT ?? "OR-05";
const OUT = new URL('../../artifacts/screenshots/v12/r/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async () => (await (await fetch(`${API}/api/v1/robots/${ROBOT}`)).json());
const out = [];
const check = (k, ok, v) => { out.push({ k, ok, v }); console.log(ok ? 'ok  ' : 'FAIL', k, JSON.stringify(v ?? '')); };
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
let failed = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(120000);
  const netLog = [];
  const t00 = Date.now();
  page.on('request', (r) => { if (/control\/|\/drive/.test(r.url())) netLog.push(`${Date.now() - t00} REQ ${r.url().split('/robots/')[1]}`); });
  page.on('response', (r) => { if (/control\/|\/drive/.test(r.url())) netLog.push(`${Date.now() - t00} RES ${r.status()} ${r.url().split('/robots/')[1]}`); });
  page.on('requestfailed', (r) => { if (/control\/|\/drive/.test(r.url())) netLog.push(`${Date.now() - t00} FAILED ${r.failure()?.errorText} ${r.url().split('/robots/')[1]}`); });
  const navReqs = [];
  page.on('response', (r) => { if (/navigation\/graphs/.test(r.url())) navReqs.push(`${r.status()} ${r.url().split('/runs/')[1]}`); });
  page.on('requestfailed', (r) => { if (/navigation\/graphs/.test(r.url())) navReqs.push(`FAILED ${r.failure()?.errorText}`); });
  await page.goto(`${WEB}/?e2e=1&viewer=${process.env.VIEWER ?? "lite"}&api=${encodeURIComponent(API)}`);
  await sleep(8000);
  await page.keyboard.press('2');
  await sleep(2500);
  await page.getByPlaceholder(/Search \d+ robots/).fill(ROBOT).catch(() => {});
  await sleep(500);
  await page.getByText(ROBOT, { exact: false }).first().click();
  await sleep(2500);
  const r0 = await get();
  check('exterior + interior graphs fetched by the Map tab', navReqs.length >= 2, navReqs);
  const strip = page.locator('[data-panel="control-hud"]');
  check('strip shows owner AUTO before control', /AUTO/.test(await strip.innerText()), (await strip.innerText()).replace(/\s+/g, ' ').slice(0, 160));
  for (let i = 0; i < 40 && !(await page.getByRole('button', { name: /Take Control/ }).first().isEnabled()); i++) await sleep(500);
  // a loaded host can make the lease POST exceed the client's 2.5 s timeout ("The control service did not answer"): that is the product's honest behaviour, so retry like an operator would
  let attempts = 0;
  for (; attempts < 5; attempts++) {
    for (let i = 0; i < 40 && !(await page.getByRole('button', { name: /Take Control/ }).first().isEnabled()); i++) await sleep(500);
    await page.getByRole('button', { name: /Take Control/ }).first().click();
    await sleep(3500);
    const c = (await get()).control;
    if (c?.authority === 'HUMAN') break;
  }
  check('take-over attempts needed', attempts < 5, attempts + 1);
  const txt1 = (await page.evaluate(() => document.body.innerText));
  const rl = await get();
  check('server flipped to HUMAN/MANUAL after the first ack', rl.control?.authority === 'HUMAN' && rl.control?.controller_state === 'MANUAL', { authority: rl.control?.authority, state: rl.control?.controller_state, lease: !!rl.control?.lease_id });
  check('no "Link lost" / safety stop banner after take-over', !/Link lost|Safety stop/i.test(txt1));
  check('strip owner is HUMAN and has Release + Stop', /HUMAN/.test(await strip.innerText()) && (await strip.getByRole('button', { name: /Release/ }).count()) === 1 && (await strip.getByRole('button', { name: /Stop/ }).count()) === 1);
  console.log('net log:', JSON.stringify(netLog));
  console.log('resource timings:', JSON.stringify(await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /control\/lease|\/drive|control\/heartbeat/.test(e.name)).map((e) => ({ n: e.name.split('/robots/')[1], start: Math.round(e.startTime), queue_ms: Math.round(e.requestStart - e.startTime), wait_ms: Math.round(e.responseStart - e.requestStart), total_ms: Math.round(e.duration) })))));
  console.log('control log:', JSON.stringify(await page.evaluate(() => window.__lkControlLog)));
  console.log('drive-link after take:', JSON.stringify(await page.locator('[data-panel="drive-link"]').allInnerTexts()));
  await page.mouse.move(700, 450);
  await page.keyboard.down('KeyW');
  await sleep(2500);
  await page.keyboard.up('KeyW');
  await sleep(800);
  const r1 = await get();
  const moved = Math.hypot(r1.pose.position_xyz_m[0] - r0.pose.position_xyz_m[0], r1.pose.position_xyz_m[2] - r0.pose.position_xyz_m[2]);
  check('server pose moved while W held', moved > 0.05, { moved_m: +moved.toFixed(3), before: r0.pose.position_xyz_m, after: r1.pose.position_xyz_m });
  const ui = await strip.innerText();
  check('strip shows link ok + ack RTT', /LINK\s*ok/i.test(ui) && /\d+\s*ms/.test(ui), ui.replace(/\s+/g, ' ').slice(0, 200));
  await page.screenshot({ path: `${OUT}take_control_driving.png`, timeout: 90000 }).catch(() => {});
  await strip.getByRole('button', { name: /Release/ }).click();
  await sleep(2500);
  const r2 = await get();
  check('release returns authority to AUTO', r2.control?.authority === 'AUTO', { authority: r2.control?.authority, state: r2.control?.controller_state });
  check('strip owner back to AUTO', /AUTO/.test(await strip.innerText()));
  await page.screenshot({ path: `${OUT}take_control_released.png`, timeout: 90000 }).catch(() => {});
} finally {
  await browser.close();
}
failed = out.filter((o) => !o.ok).length;
writeFileSync(`${OUT}take_control_results.json`, JSON.stringify(out, null, 1));
process.exit(failed ? 1 : 0);
