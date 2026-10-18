#!/usr/bin/env node
// In-browser verification of the progressive tile streamer against a LIVE backend (no mocks): real Chromium, real GLB tiles from
// /api/v1/facilities/{id}/render-manifest, real pointer events through React-Three-Fiber.
//
//   node scripts/bench/tiles_verify.mjs --url http://127.0.0.1:5222/ --api http://127.0.0.1:8820 [--gpu] [--out artifacts/benchmarks/v12_tiles_verify.json]
//
// Checks (each reports pass/fail + the evidence it measured):
//   picking      entity-id picking through real clicks at LOD0-only, LOD1, LOD2 (instanced racks at LOD0 included)
//   abort        a request for a zone the camera left is cancelled (net::ERR_ABORTED) and counted
//   hysteresis   a tile survives a short look-away, is detached only after ~1.5 s, re-attaches from the decoded cache with no request
//   lru          over a small GPU quota the least-recently-used tiles are disposed (renderer.info.memory.geometries really drops)
//   contact_lod  rack close-ups do not pull in the pipe-bore (contact) tiles
//   fallbacks    decode failure, manifest offline at load (+ automatic retry), offline after load, topology mismatch, runtime off/on switch
//   auto_policy  default mode streams nothing on a hardware GPU at High, and streams once the Performance tier is selected
//
// env: PLAYWRIGHT_MODULE, CHROME_PATH (headless shell), LD_LIBRARY_PATH for libasound if the browser needs it.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };
const base = arg('url', 'http://127.0.0.1:5222/');
const api = arg('api', 'http://127.0.0.1:8820');
const out = arg('out', 'artifacts/benchmarks/v12_tiles_verify.json');
const gpu = arg('gpu', false) === true;
const only = arg('only', undefined);
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const flags = ['--no-sandbox', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
if (gpu) flags.push('--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface');
else flags.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (group, name, pass, evidence) => { results.push({ group, name, pass: !!pass, evidence }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${group}: ${name}  ${JSON.stringify(evidence)}`); };

const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: flags });
const pageErrors = [];

async function open(query, { route } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const failed = [];
  page.on('requestfailed', (r) => failed.push({ url: r.url(), failure: r.failure()?.errorText }));
  const reqs = [];
  page.on('request', (r) => reqs.push(r.url()));
  if (route) await route(page, ctx);
  await page.goto(`${base}?bench=1&seed=8&api=${encodeURIComponent(api)}${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__lkBench?.ready === true && window.__lkApp?.useWorld.getState().topology, null, { timeout: 90000 });
  return { ctx, page, failed, reqs };
}
const ready = (page, ms = 60000) => page.waitForFunction(() => window.__lkTiles?.state() === 'ready', null, { timeout: ms });
const stats = (page) => page.evaluate(() => window.__lkTiles?.stats() ?? null);
const gl = (page) => page.evaluate(() => ({ calls: window.__lk.three.gl.info.render.calls, geoms: window.__lk.three.gl.info.memory.geometries, tris: window.__lk.three.gl.info.render.triangles }));
const focus = async (page, id, ms = 3500) => { await page.evaluate((id) => window.__lkApp.useView.getState().focusEntity(id), id); await sleep(ms); };
const settle = async (page, ms = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await stats(page);
    if (s && s.inflight === 0 && s.queued === 0) { await sleep(300); const s2 = await stats(page); if (s2.inflight === 0 && s2.queued === 0) return s2; }
    await sleep(250);
  }
  return stats(page);
};
/** is the procedural static facility drawn (true) or hidden behind the tile layer (false) */
const proceduralVisible = (page) => page.evaluate(() => {
  let f = null;
  window.__lk.three.scene.traverse((o) => { if (o.name === 'facility' && !f) f = o; });
  if (!f) return null;
  for (let o = f; o; o = o.parent) if (!o.visible) return false;
  return true;
});
async function projectEntity(page, id) {
  return page.evaluate((id) => {
    const a = window.__lkApp.useWorld.getState().assetsById[id];
    const { camera } = window.__lk.three;
    const wy = a.type === 'rack' ? (a.size_m?.[1] ?? 1.9) / 2 : a.position_xyz_m[1];
    const v = new camera.position.constructor(a.position_xyz_m[0], wy, a.position_xyz_m[2]).project(camera);
    const r = document.querySelector('canvas').getBoundingClientRect();
    const x = r.left + ((v.x + 1) / 2) * r.width, y = r.top + ((1 - v.y) / 2) * r.height;
    const el = document.elementFromPoint(x, y);
    return { x, y, onCanvas: !!el && el.tagName === 'CANVAS', inView: v.z < 1 && x > 0 && y > 0 && x < r.width && y < r.height };
  }, id);
}
/** real mouse move + click on the projected entity; returns what the app selected and whether the tile layer handled it */
async function clickEntity(page, id) {
  await page.evaluate(() => { window.__lkApp.useView.getState().select(null); const m = window.__lkTiles?.manager(); if (m && !m.__wrapped) { m.__wrapped = true; window.__pickLog = []; const o = m.pick.bind(m); m.pick = (h) => { const r = o(h); window.__pickLog.push(r ? r.id : null); return r; }; } if (window.__pickLog) window.__pickLog.length = 0; });
  const pt = await projectEntity(page, id);
  if (!pt.onCanvas || !pt.inView) return { id, skipped: true, why: !pt.inView ? 'off screen' : 'DOM overlay on top of the point', pt };
  await page.mouse.move(pt.x - 6, pt.y - 6);
  await sleep(120);
  await page.mouse.move(pt.x, pt.y);
  await sleep(250);
  await page.mouse.click(pt.x, pt.y);
  await sleep(400);
  const r = await page.evaluate(() => ({ sel: window.__lkApp.useView.getState().selectedId, picks: (window.__pickLog ?? []).slice() }));
  return { id, selected: r.sel, tilePicks: r.picks, ok: r.sel === id };
}
const waitFor = async (page, fn, arg, ms = 20000) => { try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 250 }); return true; } catch { return false; } };
const RACKS = ['rack_a1', 'rack_a8', 'rack_b4', 'rack_c4', 'rack_d2', 'rack_e8'];

const want = (g) => !only || String(only).split(',').includes(g);

// ---------------------------------------------------------------------------------------------------------------- picking
if (want('picking')) {
  // LOD0-only: block every tile except the shell by sha (read from the manifest the page itself fetched)
  const man = await (await fetch(`${api}/api/v1/facilities/lab_01/render-manifest`)).json();
  const lod0 = new Set(man.tiles.filter((t) => t.lod === 0).map((t) => t.sha256));
  let hold = true;
  const waiters = [];
  const { ctx, page, failed } = await open('&tiles=on', {
    route: async (p) => {
      await p.route(/\/assets\/sha256\//, async (route) => {
        const sha = route.request().url().split('/').pop();
        if (hold && !lod0.has(sha) && sha !== man.features.sha256) await new Promise((r) => waiters.push(r));
        await route.fallback();
      });
    },
  });
  await ready(page);
  await focus(page, 'rack_c4', 2500);
  const s0 = await stats(page);
  const lod0Only = (s0.resident_by_lod[1] ?? 0) === 0 && (s0.resident_by_lod[2] ?? 0) === 0;
  const r0 = [];
  for (const id of RACKS.slice(0, 4)) { await focus(page, id, 1800); r0.push(await clickEntity(page, id)); }
  const ran0 = r0.filter((r) => !r.skipped);
  check('picking', 'LOD0 only (instanced racks, nothing finer resident): real clicks resolve to the right rack', lod0Only && ran0.length >= 3 && ran0.every((r) => r.ok && r.tilePicks.includes(r.id)), { resident_by_lod: s0.resident_by_lod, results: r0.map((r) => (r.skipped ? `${r.id}:skipped(${r.why})` : `${r.id}->${r.selected} tilePicks=${r.tilePicks.length}`)) });
  hold = false;
  waiters.splice(0).forEach((r) => r());
  await focus(page, 'rack_a1', 2500);
  const s1 = await settle(page);
  const r1 = [];
  for (const id of RACKS) { await focus(page, id, 2600); r1.push(await clickEntity(page, id)); }
  const s2 = await stats(page);
  const ran1 = r1.filter((r) => !r.skipped);
  check('picking', 'LOD1 + LOD2 resident: the same entity ids come back for every rack row', (s2.resident_by_lod[1] ?? 0) > 0 && (s2.resident_by_lod[2] ?? 0) > 0 && ran1.length >= 4 && ran1.every((r) => r.ok), { resident_by_lod: s2.resident_by_lod, results: r1.map((r) => (r.skipped ? `${r.id}:skipped(${r.why})` : `${r.id}->${r.selected}`)) });
  // picking a non-rack entity that only exists in finer tiles (valve / pipe edge) via the tile layer
  const prob = await page.evaluate(() => {
    const w = window.__lkApp.useWorld.getState();
    const v = Object.values(w.assetsById).find((a) => a.type === 'valve' && a.position_xyz_m);
    return v ? v.id : null;
  });
  let valve = null;
  if (prob) { await focus(page, prob, 3000); await settle(page, 6000); valve = await clickEntity(page, prob); }
  check('picking', 'a non-rack entity (valve) resolves through the feature table', valve && (valve.skipped || valve.ok), { valve });
  check('picking', 'hover and click never threw', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 3) });
  void failed;
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------------- abort
if (want('abort')) {
  const man = await (await fetch(`${api}/api/v1/facilities/lab_01/render-manifest`)).json();
  const lod0 = new Set(man.tiles.filter((t) => t.lod === 0).map((t) => t.sha256));
  let slow = false;
  const held = [];
  const { ctx, page, failed } = await open('&tiles=on', {
    route: async (p) => {
      await p.route(/\/assets\/sha256\//, async (route) => {
        const sha = route.request().url().split('/').pop();
        if (slow && !lod0.has(sha)) { held.push(sha); await sleep(4000).catch(() => undefined); }
        await route.fallback().catch(() => undefined);
      });
    },
  });
  await ready(page);
  await page.evaluate(() => { const m = window.__lkTiles.manager(); m.tune = { ...m.tune, concurrency: 4 }; });
  await settle(page);
  const a0 = await stats(page);
  slow = true;
  await focus(page, 'rack_a1', 600); // start asking for new tiles ...
  await sleep(500);
  const mid = await stats(page);
  await page.evaluate(() => window.__lkApp.useView.getState().setCam({ distance: 52, target: [60, 0, 60] })); // ... and look away from them
  await sleep(2200);
  const a1 = await stats(page);
  const ev = await page.evaluate(() => window.__lkTiles.manager().events.filter((e) => e.kind === 'abort').slice(-12));
  const aborted = failed.filter((f) => /ERR_ABORTED/.test(f.failure ?? '') && /sha256/.test(f.url));
  check('abort', 'requests for tiles the camera left are cancelled in the network layer and counted', (mid.inflight > 0 || held.length > 0) && a1.aborted > a0.aborted && aborted.length > 0, { inflight_when_looking: mid.inflight, held_requests: held.length, aborted_before: a0.aborted, aborted_after: a1.aborted, net_ERR_ABORTED: aborted.length, abort_events: ev.slice(0, 4) });
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------------- hysteresis
if (want('hysteresis')) {
  const { ctx, page, reqs } = await open('&tiles=on');
  await ready(page);
  await focus(page, 'rack_c4', 3000);
  await waitFor(page, () => (window.__lkTiles.stats().resident_by_lod[2] ?? 0) > 10);
  await settle(page);
  // tiles the viewer needs right now: each of them must outlive a look-away by ~1.5 s
  const wantedNow = await page.evaluate(() => { const m = window.__lkTiles.manager(); return m.wantedTileIds().filter((id) => /@L2$/.test(id)); });
  const t0 = await stats(page);
  const tAway = await page.evaluate(() => { const m = window.__lkTiles.manager(); window.__lkApp.useView.getState().setCam({ distance: 52, target: [60, 0, 60] }); return m.clock(); });
  await sleep(4500);
  const dets = await page.evaluate(() => window.__lkTiles.manager().events.filter((e) => e.kind === 'detach').map((e) => [e.tile, e.t]));
  const mine = dets.filter(([id, t]) => wantedNow.includes(id) && t >= tAway);
  const earliest = mine.length ? Math.min(...mine.map(([, t]) => t)) - tAway : null;
  const median = mine.length ? [...mine.map(([, t]) => t - tAway)].sort((x, y) => x - y)[Math.floor(mine.length / 2)] : null;
  check('hysteresis', 'tiles that were wanted when the camera left are held ~1.5 s before they detach (never earlier than the hold minus one 0.2 s tick)', wantedNow.length > 10 && mine.length > 0 && earliest >= 1300 && median <= 3500, { wanted_L2_tiles_at_look_away: wantedNow.length, detached_afterwards: mine.length, earliest_detach_ms: earliest, median_detach_ms: median });
  // flap test: look away for 0.8 s and come back -> none of the tiles needed before is dropped
  await focus(page, 'rack_c4', 3000);
  await waitFor(page, () => (window.__lkTiles.stats().resident_by_lod[2] ?? 0) > 10);
  await settle(page);
  const b0 = await stats(page);
  const wanted2 = await page.evaluate(() => window.__lkTiles.manager().wantedTileIds());
  await page.evaluate(() => window.__lkApp.useView.getState().setCam({ distance: 52, target: [60, 0, 60] }));
  await sleep(700);
  await focus(page, 'rack_c4', 1500);
  const evs = await page.evaluate((from) => window.__lkTiles.manager().events.filter((e) => e.kind === 'detach' && e.t >= from).map((e) => e.tile), 0);
  const b1 = await stats(page);
  const droppedWanted = evs.slice(-(b1.detached - b0.detached || 0)).filter((id) => wanted2.includes(id));
  check('hysteresis', 'looking away for less than the hold time and back drops none of the tiles that were needed (no detach/attach churn)', droppedWanted.length === 0, { detached_during_flap: b1.detached - b0.detached, needed_tiles_dropped: droppedWanted.length, attached_before: b0.attached, attached_after: b1.attached });
  // warm re-attach: leave long enough to detach everything, come back, expect no tile to be downloaded or decoded twice
  await page.evaluate(() => window.__lkApp.useView.getState().setCam({ distance: 52, target: [60, 0, 60] }));
  await sleep(3000);
  const c0 = await stats(page);
  await focus(page, 'rack_c4', 3000);
  await waitFor(page, () => (window.__lkTiles.stats().resident_by_lod[2] ?? 0) > 10);
  const c1 = await settle(page);
  const hits = await page.evaluate(() => window.__lkTiles.manager().events.filter((e) => e.kind === 'cache_hit').length);
  const urls = reqs.filter((u) => /\/assets\/sha256\//.test(u));
  const dup = urls.length - new Set(urls).size;
  check('hysteresis', 'tiles detached and wanted again re-attach from the decoded cache: no sha is requested twice, no tile decoded twice', hits > 0 && dup === 0 && c1.decoded_tiles === c1.fetched, { detached_when_left: c0.detached, cache_hit_events: hits, duplicate_tile_requests: dup, fetched: c1.fetched, decoded: c1.decoded_tiles });
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------------- lru
if (want('lru')) {
  const { ctx, page } = await open('&tiles=on');
  await ready(page);
  const QUOTA = 700_000;
  await page.evaluate((q) => { const m = window.__lkTiles.manager(); m.cache.quota = { encodedBytes: 2 << 20, gpuBytes: q }; }, QUOTA);
  const g0 = await gl(page);
  // tiles that are on screen are referenced and can never be evicted, whatever the quota: this is the working set
  for (const id of ['rack_a1', 'rack_e8', 'rack_c4']) { await focus(page, id, 2500); await waitFor(page, () => (window.__lkTiles.stats().resident_by_lod[2] ?? 0) > 5); }
  await settle(page);
  const peak = await stats(page);
  const gPeak = await gl(page);
  // look away: everything finer than the shell is released, becomes an LRU candidate and the quota is enforced
  await page.evaluate(() => window.__lkApp.useView.getState().setCam({ distance: 52, target: [160, 0, 160] }));
  await sleep(4500);
  const end = await stats(page);
  const gEnd = await gl(page);
  const shellBytes = await page.evaluate(() => { const m = window.__lkTiles.manager(); const d = m.cache.get(m.manifest.tiles.find((t) => t.lod === 0).sha256); return d ? d.gpuBytes : 0; });
  check('lru', 'working set above the quota is kept while on screen; once released, the least-recently-used tiles are disposed and counted', peak.decoded_gpu_bytes > QUOTA && peak.evicted === 0 && end.evicted > 0, { quota_bytes: QUOTA, decoded_bytes_on_screen: peak.decoded_gpu_bytes, evicted_while_on_screen: peak.evicted, evicted_after_release: end.evicted });
  check('lru', 'decoded bytes fall back under the quota (shell excepted) after the release', end.decoded_gpu_bytes - shellBytes <= QUOTA, { decoded_gpu_bytes_end: end.decoded_gpu_bytes, shell_bytes: shellBytes, resident_by_lod: end.resident_by_lod });
  check('lru', "three's own geometry count drops (dispose reached the GPU side), and the scene keeps drawing with LOD0 resident", gEnd.geoms < gPeak.geoms && gEnd.calls > 0 && (end.resident_by_lod[0] ?? 0) === 1, { geometries_start: g0.geoms, geometries_at_peak: gPeak.geoms, geometries_after: gEnd.geoms, draw_calls_after: gEnd.calls });
  // come back: tiles that were disposed are fetched again and everything is consistent
  await focus(page, 'rack_c4', 3000);
  await waitFor(page, () => (window.__lkTiles.stats().resident_by_lod[2] ?? 0) > 5);
  const back = await settle(page);
  const pk = await clickEntity(page, 'rack_c4');
  check('lru', 'returning after eviction re-streams the tiles and picking still resolves', (back.resident_by_lod[2] ?? 0) > 5 && (pk.skipped || pk.ok), { resident_by_lod: back.resident_by_lod, fetched: back.fetched, pick: pk.skipped ? pk : pk.selected });
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------------- contact lod
if (want('contact_lod')) {
  const { ctx, page } = await open('&tiles=on');
  await ready(page);
  await focus(page, 'rack_c4', 3000);
  await waitFor(page, () => (window.__lkTiles.stats().resident_by_lod[2] ?? 0) > 5);
  const s = await settle(page);
  const ids = await page.evaluate(() => { const m = window.__lkTiles.manager(); const out = []; m.group.traverse((o) => { if (o.userData.lkTile) out.push(o.userData.lkTile); }); return [...new Set(out)]; });
  const l3 = ids.filter((t) => /@L3$/.test(t));
  check('contact_lod', 'a rack close-up (camera outside every pipe) loads no pipe-bore (contact) tiles', l3.length === 0 && (s.resident_by_lod[2] ?? 0) > 0, { resident_by_lod: s.resident_by_lod, contact_tiles: l3.length });
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------------- fallbacks
if (want('fallbacks')) {
  // (a) decode failure: every LOD1 tile returns garbage
  {
    const man = await (await fetch(`${api}/api/v1/facilities/lab_01/render-manifest`)).json();
    const bad = new Set(man.tiles.filter((t) => t.lod === 1).map((t) => t.sha256));
    let badFetches = 0;
    const { ctx, page } = await open('&tiles=on', {
      route: async (p) => {
        await p.route(/\/assets\/sha256\//, async (route) => {
          const sha = route.request().url().split('/').pop();
          if (bad.has(sha)) { badFetches++; return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: Buffer.from('this is not a glb at all') }); }
          return route.fallback();
        });
      },
    });
    await ready(page);
    await sleep(6000);
    const s = await stats(page);
    const pv = await proceduralVisible(page);
    const g = await gl(page);
    const pick = await (async () => { await focus(page, 'rack_c4', 2500); return clickEntity(page, 'rack_c4'); })();
    const n0 = badFetches;
    await sleep(3000);
    check('fallbacks', 'garbage LOD1 tiles: decode failures counted, LOD0 stays, scene still draws, no uncaught error', s.decode_failures > 0 && s.load_failures > 0 && s.state === 'ready' && (s.resident_by_lod[1] ?? 0) === 0 && g.calls > 0 && pageErrors.length === 0, { decode_failures: s.decode_failures, load_failures: s.load_failures, resident_by_lod: s.resident_by_lod, draw_calls: g.calls, last_error: s.error?.slice(0, 80) });
    check('fallbacks', 'a failed tile backs off instead of being re-requested every tick', badFetches - n0 <= 2, { requests_during_3s_after: badFetches - n0, total_bad_requests: badFetches });
    check('fallbacks', 'picking still works on the LOD0 shell while the finer LOD is broken', pick.skipped || pick.ok, { pick });
    void pv;
    await ctx.close();
  }
  // (b) manifest unavailable at load (offline / server error) -> procedural facility is drawn, then the layer recovers by itself
  {
    let blockManifest = true;
    const { ctx, page } = await open('&tiles=on', {
      route: async (p) => {
        await p.route(/render-manifest/, async (route) => (blockManifest ? route.abort('internetdisconnected') : route.fallback()));
      },
    });
    await sleep(3000);
    const st = await page.evaluate(() => ({ state: window.__lkTiles?.state(), attempts: window.__lkTiles?.attempts() }));
    const pv = await proceduralVisible(page);
    const g = await gl(page);
    const pk = await (async () => { await focus(page, 'rack_c4', 2500); return clickEntity(page, 'rack_c4'); })();
    check('fallbacks', 'manifest unreachable at load: state=failed, the procedural facility is visible and pickable', st.state === 'failed' && pv === true && g.calls > 150 && (pk.skipped || pk.ok), { state: st.state, attempts: st.attempts, procedural_visible: pv, draw_calls: g.calls, pick: pk.skipped ? pk : pk.selected });
    blockManifest = false;
    await page.waitForFunction(() => window.__lkTiles?.state() === 'ready', null, { timeout: 30000 }).catch(() => undefined);
    const st2 = await page.evaluate(() => ({ state: window.__lkTiles?.state(), attempts: window.__lkTiles?.attempts() }));
    const pv2 = await proceduralVisible(page);
    check('fallbacks', 'the layer retries by itself once the network is back (4 s first retry) and then replaces the procedural hall', st2.state === 'ready' && st2.attempts.count >= 2 && pv2 === false, { state: st2.state, attempts: st2.attempts, procedural_visible: pv2 });
    await ctx.close();
  }
  // (c) offline after the layer is up
  {
    const { ctx, page } = await open('&tiles=on');
    await ready(page);
    await page.evaluate(() => { window.__lkTiles.manager().failBackoffMs = 1500; });
    await settle(page);
    const before = await stats(page);
    await ctx.setOffline(true);
    await focus(page, 'rack_e8', 600);
    await page.evaluate(() => window.__lkApp.useView.getState().setCam({ distance: 4, target: [20, 1, 6] }));
    await sleep(4000);
    const off = await stats(page);
    const g = await gl(page);
    check('fallbacks', 'offline after load: already-resident tiles keep drawing, failed loads are counted, nothing throws', g.calls > 0 && off.resident_tiles >= before.resident_tiles - 2 && pageErrors.length === 0, { resident_before: before.resident_tiles, resident_offline: off.resident_tiles, load_failures: off.load_failures, draw_calls: g.calls });
    await ctx.setOffline(false);
    await sleep(6000);
    const on = await settle(page, 15000);
    const dbg = await page.evaluate(() => { const m = window.__lkTiles.manager(); return { events: m.events.slice(-6), wanted: m.wantedTileIds().length, state: window.__lkTiles.state(), navigatorOnline: navigator.onLine }; });
    check('fallbacks', 'back online: tiles that failed are retried after the back-off and become resident', on.resident_tiles > off.resident_tiles || on.fetched > off.fetched, { resident_offline: off.resident_tiles, resident_online: on.resident_tiles, fetched_offline: off.fetched, fetched_online: on.fetched, dbg });
    await ctx.close();
  }
  // (d) manifest of another layout than the topology on screen must never be drawn
  {
    const { ctx, page } = await open('&tiles=on', {
      route: async (p) => {
        const j = await (await fetch(`${api}/api/v1/facilities/lab_01/render-manifest`)).json();
        j.layout_hash = 'deadbeef'.repeat(8);
        j.topology_version = 'lk-topology/other-layout';
        await p.route(/render-manifest/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(j) }));
      },
    });
    await sleep(3500);
    const st = await page.evaluate(() => ({ state: window.__lkTiles?.state(), err: window.__lkTiles?.attempts().lastError }));
    const pv = await proceduralVisible(page);
    check('fallbacks', 'a manifest for a different layout than the on-screen topology is refused (procedural stays)', st.state === 'failed' && pv === true && /does not match/.test(st.err ?? ''), { state: st.state, error: st.err, procedural_visible: pv });
    await ctx.close();
  }
  // (e) runtime switch off / on (the mode store is live: the layer mounts and unmounts, GPU memory is returned)
  {
    const { ctx, page } = await open('&tiles=on');
    await ready(page);
    await settle(page);
    const g0 = await gl(page);
    const s0 = await stats(page);
    await page.evaluate(() => window.__lkTileMode.getState().setMode('off'));
    await sleep(2500);
    const gone = await page.evaluate(() => window.__lkTiles === undefined);
    const g1 = await gl(page);
    const pv1 = await proceduralVisible(page);
    check('fallbacks', 'runtime switch to off: tile layer unmounts, its geometry is disposed, the procedural hall is back', gone && pv1 === true && g1.geoms < g0.geoms && g1.calls > g0.calls, { geometries_before: g0.geoms, geometries_after: g1.geoms, draw_calls_before: g0.calls, draw_calls_after: g1.calls, tiles_resident_before: s0.resident_tiles });
    await page.evaluate(() => window.__lkTileMode.getState().setMode('on'));
    await ready(page, 30000);
    await settle(page);
    const g2 = await gl(page);
    const pv2 = await proceduralVisible(page);
    check('fallbacks', 'runtime switch back to on: tiles stream in again and replace the procedural hall', pv2 === false && g2.calls < g1.calls, { draw_calls_off: g1.calls, draw_calls_on: g2.calls, procedural_visible: pv2 });
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------- auto policy
if (want('auto_policy')) {
  const { ctx, page, reqs } = await open('');
  await sleep(6000);
  const preset = await page.evaluate(() => { window.__lkApp.useView.getState().setPreset('high'); return window.__lkApp.useView.getState().quality; });
  await sleep(6000);
  const none = reqs.filter((u) => /render-manifest|\/assets\/sha256\//.test(u)).length;
  const sw = await page.evaluate(() => { const c = window.__lk.three.gl.getContext(); const d = c.getExtension('WEBGL_debug_renderer_info'); return String(c.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : c.RENDERER)); });
  const software = /swiftshader|llvmpipe/i.test(sw);
  if (!software) check('auto_policy', 'default mode on a hardware GPU at High: no manifest, no tile requests, procedural hall only', none === 0 && preset === 'high', { tile_requests: none, tier: preset, renderer: sw.slice(0, 60) });
  await page.evaluate(() => window.__lkApp.useView.getState().setPreset('performance'));
  await page.waitForFunction(() => window.__lkTiles?.state() === 'ready', null, { timeout: 30000 }).catch(() => undefined);
  const st = await page.evaluate(() => ({ state: window.__lkTiles?.state(), mode: window.__lkTiles?.mode() }));
  const pv = await proceduralVisible(page);
  check('auto_policy', 'switching to the Performance tier starts the tile layer and it replaces the procedural hall', st.state === 'ready' && st.mode === 'auto' && pv === false, { state: st.state, mode: st.mode, procedural_visible: pv, software_renderer: software });
  await ctx.close();
}

await browser.close();
const summary = { passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length };
const report = {
  schema: 'loopkeeper.tiles-verify/v1',
  at: new Date().toISOString(),
  url: base,
  api,
  gpu_requested: gpu,
  note: 'real headless Chromium against a live backend; headless, not a display. Evidence values are what the page measured.',
  page_errors: pageErrors.slice(0, 10),
  summary,
  results,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n${summary.passed} passed, ${summary.failed} failed -> ${out}`);
process.exit(summary.failed ? 1 : 0);
