#!/usr/bin/env node
// Communications panel browser flows (Playwright). Runs against the app opened with ?e2e (embedded mock transport, no backend),
// feeding FIXTURE events through window.__lkComms. Writes artifacts/tests/comms_flows.json with pass/fail + measured numbers.
//   node scripts/e2e/comms_flows.mjs --url http://127.0.0.1:5183/ [--out artifacts/tests/comms_flows.json]
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://127.0.0.1:5183/');
const out = arg('out', 'artifacts/tests/comms_flows.json');
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: process.env.SOFTWARE_GL ? ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--no-sandbox', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface'] /* host GPU: keeps the 3D backdrop from drowning the list measurement */ });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/WebGL|GPU stall|favicon|Failed to load resource/i.test(m.text()) && errors.push(m.text().slice(0, 200))); // 404s are the embedded mock having no /api (Scenario Library fetch)
await page.addInitScript(() => { window.__long = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ entryTypes: ['longtask'] }); } catch {} });
await page.goto(`${url}?e2e&seed=8`);
await page.waitForTimeout(3500);
await page.keyboard.press('4'); // Execution tab (the shortcut also keeps this independent of header layout)
await page.waitForFunction(() => window.__lkComms?.runId(), null, { timeout: 30000 });
const S = () => page.evaluate(() => window.__lkComms.state());
const results = [];
const flow = async (name, fn) => {
  const t0 = Date.now();
  try { const extra = (await fn()) ?? {}; results.push({ name, pass: true, ms: Date.now() - t0, ...extra }); console.log('PASS', name, JSON.stringify(extra)); }
  catch (e) { results.push({ name, pass: false, error: String(e.message).slice(0, 300) }); console.log('FAIL', name, e.message); }
};
const ok = (c, m) => { if (!c) throw new Error(m); };
const launcher = () => page.locator('button.cm-launcher').first();
const feed = () => page.locator('.cm-feed');
const rowCount = () => page.locator('.cm-row').count();
const openPanel = async () => { if (!(await page.locator('#lk-comms-panel').count())) { await launcher().click(); await page.locator('#lk-comms-panel').waitFor(); } };

await flow('panel opens from launcher with empty state', async () => {
  await page.evaluate(() => window.__lkComms.reset());
  await page.evaluate(() => window.__lkComms.freeze(true)); // the app's own run/connection sync would overwrite the state the flows drive
  await page.evaluate(() => window.__lkComms.ensureRun(window.__lkComms.runId() ?? 'run_baseline'));
  await openPanel();
  const txt = await page.locator('.cm-empty').innerText();
  ok(/No messages yet|Waiting for backend/.test(txt), 'empty state text: ' + txt);
  ok(await page.locator('[role=log]').count() === 1, 'role=log present');
});

await flow('live burst renders newest, bounded DOM, follows live', async () => {
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) await page.evaluate((i) => window.__lkComms.burst(1 + i * 10, 10), i);
  await page.waitForTimeout(400);
  const s = await S();
  ok(s.n === 100, 'ingested 100, got ' + s.n);
  const rows = await rowCount();
  ok(rows > 0 && rows < 60, 'rows in DOM ' + rows);
  ok(s.follow === true, 'following live');
  const last = await page.locator('.cm-row').last().innerText();
  ok(/event 100/.test(last), 'newest row visible: ' + last.slice(0, 60));
  return { burst_to_render_ms: Date.now() - t0, rows_in_dom: rows };
});

await flow('no forced scroll while reading history; unread + Jump to live', async () => {
  await feed().evaluate((el) => { el.scrollTop = 200; });
  await page.waitForTimeout(250);
  const before = (await S());
  ok(before.follow === false, 'follow off after scrolling back');
  const top = await feed().evaluate((el) => el.scrollTop);
  await page.evaluate(() => window.__lkComms.burst(101, 20));
  await page.waitForTimeout(400);
  const after = await S();
  const top2 = await feed().evaluate((el) => el.scrollTop);
  ok(Math.abs(top2 - top) < 2, `scrollTop moved ${top} -> ${top2}`);
  ok(after.unread === 20, 'unread ' + after.unread);
  await page.getByRole('button', { name: /Jump to live/ }).click();
  await page.waitForTimeout(250);
  const s = await S();
  ok(s.follow && s.unread === 0, 'back at live edge');
});

await flow('duplicates and reconnect overlap never add rows', async () => {
  const before = (await S()).n;
  await page.evaluate(() => { window.__lkComms.burst(50, 60); window.__lkComms.burst(50, 60); window.__lkComms.conn('RECONNECTING'); });
  await page.waitForTimeout(300);
  ok((await S()).n === before, 'row count changed with duplicates');
  ok(await page.locator('.cm-note', { hasText: 'Reconnecting' }).count() === 1, 'reconnecting note');
  await page.evaluate(() => window.__lkComms.conn('LIVE'));
});

await flow('close/reopen x3 keeps filters, search, scroll and run; ingestion continues while closed', async () => {
  await page.locator('.cm-chip', { hasText: 'Tools' }).click();
  await page.locator('.cm-search input').fill('ir-');
  await page.waitForTimeout(300);
  const n0 = (await S()).n;
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape'); // closes the panel
    await page.locator('#lk-comms-panel').waitFor({ state: 'detached' });
    await page.evaluate((i) => window.__lkComms.burst(500 + i * 10, 10), i);
    await page.waitForTimeout(250);
    const badge = await launcher().innerText();
    ok(/\d/.test(badge), 'launcher shows unread while closed: ' + badge);
    ok(await page.evaluate(() => document.activeElement?.classList.contains('cm-launcher')), 'focus restored to launcher');
    await launcher().click();
    await page.locator('#lk-comms-panel').waitFor();
  }
  const s = await S();
  ok(s.filter === 'tools' && s.query === 'ir-', 'filters kept: ' + s.filter + '/' + s.query);
  ok(s.n === n0 + 30, 'ingestion continued while closed: ' + n0 + ' -> ' + s.n);
  await page.locator('.cm-chip', { hasText: 'All' }).click();
  await page.locator('.cm-search input').fill('');
});

await flow('detail view: ESC goes back, then closes', async () => {
  await page.locator('.cm-row').last().click();
  await page.locator('.cm-detail').waitFor();
  ok(/Sequence/.test(await page.locator('.cm-detail').innerText()), 'detail shows ids');
  await page.keyboard.press('Escape');
  await page.locator('.cm-detail').waitFor({ state: 'detached' });
  ok(await page.locator('#lk-comms-panel').count() === 1, 'panel still open after first ESC');
  await page.keyboard.press('Escape');
  await page.locator('#lk-comms-panel').waitFor({ state: 'detached' });
  await launcher().click();
  await page.locator('#lk-comms-panel').waitFor();
});

await flow('replay shows only events at or before the cursor', async () => {
  try {
  await page.evaluate(() => window.__lkComms.mode('replay', 100)); // sim_tick = seq*2 -> seq <= 50
  await page.waitForTimeout(300);
  const total = await page.locator('.cm-count').innerText();
  ok(/REPLAY/i.test(await page.locator('.cm-state').innerText()), 'REPLAY label');
  const rowsText = await page.locator('.cm-row').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  const maxSeq = await page.evaluate(() => window.__lkComms.state().n);
  ok(rowsText.every((t) => !/event (5[1-9]|[6-9]\d|\d{3,}):/.test(t)), 'future events leaked into replay');
  await page.evaluate(() => window.__lkComms.cursor(20));
  await page.waitForTimeout(250);
  const c2 = await page.locator('.cm-count').innerText();
  return { count_at_100: total, count_at_20: c2, total_events: maxSeq };
  } finally { await page.evaluate(() => window.__lkComms.mode('live')); }
});

await flow('agent text is escaped (no HTML execution)', async () => {
  await page.evaluate(() => { window.__lkComms.event(900, { summary: '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>' }); });
  await page.waitForTimeout(300);
  if (await page.getByRole('button', { name: /Jump to live/ }).count()) await page.getByRole('button', { name: /Jump to live/ }).click();
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => window.__pwn === undefined), 'script executed');
  ok(await page.locator('.cm-feed img').count() === 0, 'img element created');
  { const t = await page.locator('.cm-row').last().innerText(); ok(/<img src=x/.test(t), 'literal text shown; last row was: ' + t.replace(/\n/g, '|').slice(0, 120) + ' state=' + JSON.stringify(await S())); }
});

await flow('preview banner shows, and is not a feed row', async () => {
  const before = (await S()).n;
  await page.evaluate(() => window.__lkComms.preview());
  await page.waitForTimeout(250);
  ok(await page.locator('.cm-banner', { hasText: 'Preview only; backend robot unchanged' }).count() === 1, 'banner');
  ok((await S()).n === before, 'preview added a row');
});

await flow('5,000 events stay smooth', async () => {
  await page.evaluate(() => { window.__long.length = 0; });
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) await page.evaluate((i) => window.__lkComms.burst(2000 + i * 100, 100), i);
  await page.waitForTimeout(500);
  const ingest_ms = Date.now() - t0;
  const s = await S();
  ok(s.n >= 5000, 'events ' + s.n);
  const rows = await rowCount();
  ok(rows < 80, 'DOM rows ' + rows);
  // scroll the whole list top -> bottom -> top while sampling frame gaps
  const m = await page.evaluate(async () => {
    const el = document.querySelector('.cm-feed');
    const gaps = []; let last = performance.now(); let raf = 0; let go = true;
    const loop = (t) => { gaps.push(t - last); last = t; if (go) raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    const total = el.scrollHeight - el.clientHeight;
    const t0 = performance.now();
    for (let i = 0; i <= 60; i++) { el.scrollTop = (total * i) / 60; await new Promise((r) => setTimeout(r, 16)); }
    for (let i = 60; i >= 0; i--) { el.scrollTop = (total * i) / 60; await new Promise((r) => setTimeout(r, 16)); }
    go = false; cancelAnimationFrame(raf);
    const s = [...gaps].sort((a, b) => a - b);
    return { scroll_ms: Math.round(performance.now() - t0), frames: s.length, gap_p50: s[Math.floor(s.length * 0.5)], gap_p95: s[Math.floor(s.length * 0.95)], gap_max: Math.max(...s), long_tasks: window.__long.length, long_max: Math.max(0, ...window.__long), rows: document.querySelectorAll('.cm-row').length };
  });
  return { events: s.n, ingest_ms, dom_rows: rows, ...m };
});

await flow('no console errors during the flows', async () => { ok(errors.length === 0, errors.slice(0, 3).join(' | ')); });

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ schema: 'loopkeeper.comms-flows/v1', at: new Date().toISOString(), url, browser: await browser.version(), gl: process.env.SOFTWARE_GL ? 'software (SwiftShader)' : 'host GPU via ANGLE/Vulkan, headless', results }, null, 2));
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} flows passed -> ${out}`);
process.exit(failed.length ? 1 : 0);
