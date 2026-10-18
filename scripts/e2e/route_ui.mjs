#!/usr/bin/env node
// V12 R: browser verification of destination mode on the Map tab against an in-memory API.
//   WEB=http://127.0.0.1:5218 API=http://127.0.0.1:8818 VP=1440x900 TAG=1440x900 node scripts/e2e/route_ui.mjs
// Real canvas click on a destination marker (screen position via the ?e2e seam), plan -> preview -> commit -> arrives; asserts the pose over GET /robots/<id>.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? '/tmp/claude-1989081997/shots/node_modules/playwright');
const WEB = process.env.WEB ?? 'http://127.0.0.1:5218';
const API = (process.env.API ?? 'http://127.0.0.1:8818') + '/api/v1';
const VP = (process.env.VP ?? '1440x900').split('x').map(Number);
const TAG = process.env.TAG ?? `${VP[0]}x${VP[1]}`;
const ROBOT = process.env.ROBOT ?? 'OR-03';
const TARGET = process.env.TARGET ?? 'SV:ROAD-04:11.30';
const MOBILE = VP[0] < 900;
const OUT = new URL('../../artifacts/screenshots/v12/r/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p) => (await fetch(API + p)).json();
const res = [];
const note = (k, v) => { res.push({ k, v }); console.log(k, JSON.stringify(v)); };
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: VP[0], height: VP[1] }, hasTouch: MOBILE, isMobile: MOBILE, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.setDefaultTimeout(120000);
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message.slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
const snap = async (n) => { await page.screenshot({ path: `${OUT}${TAG}_${n}.png`, timeout: 120000 }); };
const text = () => page.evaluate(() => document.body.innerText);

await page.goto(`${WEB}/?e2e=1&viewer=lite&api=${encodeURIComponent(API.replace('/api/v1', ''))}`);
await sleep(9000);
// Map tab
if (MOBILE) {
  const b = page.locator('button.seg__item, [role=tab], nav button, button').filter({ hasText: /^\s*Map\s*$/ }).first();
  await b.click().catch(async () => page.keyboard.press('2'));
} else await page.keyboard.press('2');
await sleep(2500);
const start = (await api(`/robots/${ROBOT}`)).pose.position_xyz_m;
note('start', start);
// select robot (fleet drawer search on desktop; on phones the same list lives in a sheet)
const search = page.getByPlaceholder(/Search \d+ robots/);
if (await search.count()) { await search.fill(ROBOT); await sleep(600); }
await page.getByText(ROBOT, { exact: false }).first().click().catch(() => note('select', 'could not click robot row'));
await sleep(2500);
await snap('1_selected');
const send = page.getByRole('button', { name: /Send to destination/ });
note('send_button_visible', await send.count());
note('banners', await page.locator('.banner').allInnerTexts());
for (let i = 0; i < 40 && (await send.first().isDisabled()); i++) await sleep(500);
note('send_enabled', !(await send.first().isDisabled()));
note('banners_now', await page.locator('.banner').allInnerTexts());
const t0c = Date.now();
await send.first().evaluate((b) => b.click());
note('dom_click_ms', Date.now() - t0c);
await sleep(2500);
await snap('2_destination_mode');
const pos = await page.evaluate((id) => window.__lkRouteScreen?.(id) ?? null, TARGET);
note('marker_screen_pos', pos);
if (!pos) { console.error('no marker position'); await browser.close(); process.exit(2); }
await page.mouse.click(pos.x, pos.y);
await sleep(2500);
await snap('3_preview');
const t1 = await text();
note('preview_text', /PREVIEW · nothing reserved/.test(t1) && /ETA/i.test(t1));
const commit = page.getByRole('button', { name: /Commit route/ });
note('commit_visible', await commit.count());
await commit.first().click();
await sleep(3000);
await snap('4_reserved');
const t2 = await text();
note('reserved_text', /RESERVED/.test(t2));
const tgt = (await api('/runs/current/navigation/graphs?kind=exterior')).nodes.find((n) => n.id === TARGET);
let end = start;
for (let i = 0; i < 80; i++) { end = (await api(`/robots/${ROBOT}`)).pose.position_xyz_m; if (Math.hypot(end[0] - tgt.x, end[2] - tgt.z) < 0.7) break; await sleep(1000); if (i === 3) await snap('5_en_route'); }
await sleep(1500);
await snap('6_arrived');
const d = Math.hypot(end[0] - tgt.x, end[2] - tgt.z);
note('end_pose', { end, distance_to_target_m: +d.toFixed(2), target: TARGET });
note('arrived_text', /ARRIVED/.test(await text()));
note('console_errors', errors.slice(0, 8));
writeFileSync(`${OUT}${TAG}_results.json`, JSON.stringify(res, null, 1));
await browser.close();
process.exit(d < 0.7 ? 0 : 1);
