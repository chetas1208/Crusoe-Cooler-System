#!/usr/bin/env node
// Screenshots of Dashboard + Map at the three spec resolutions.
// usage: node scripts/bench/shots.mjs <outDir> [baseUrl]
// env: PLAYWRIGHT_MODULE (path to playwright pkg), CHROME_PATH (optional executable)
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const out = process.argv[2];
const base = process.argv[3] ?? 'http://127.0.0.1:5183/';
if (!out) throw new Error('usage: shots.mjs <outDir> [baseUrl]');
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await pw.chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
for (const [w, h] of [[1366, 768], [1440, 900], [1920, 1080]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  await page.goto(`${base}?seed=8`, { waitUntil: 'load' });
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `${out}/dashboard_${w}x${h}.png` });
  await page.getByRole('tab', { name: /map/i }).or(page.locator('button', { hasText: /^Map$/ })).first().click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${out}/map_${w}x${h}.png` });
  await ctx.close();
}
await browser.close();
console.log('done', out);
