#!/usr/bin/env node
// LOOPKEEPER V11 full-flow browser verification against the LIVE stack (web :5173 -> API :8787 -> Crusoe). Agent H.
//   PHASES=A,B VP=1440x900 node scripts/e2e/full_flow.mjs        A = load + prompt (injects ONE fault into run_live), B = panels/map/replay
// Evidence goes to artifacts/e2e/<tag>/ (screenshots, results.json). Never destroys data; the only mutation is one prompt-driven
// fault (phase A) plus a short robot drive lease on an OUTRIG (phase B).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
const pw = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? '/tmp/claude-1989081997/shots/node_modules/playwright');
const WEB = process.env.WEB ?? 'http://localhost:5173';
const API = process.env.API ?? 'http://localhost:8787/api/v1';
const VP = (process.env.VP ?? '1440x900').split('x').map(Number);
const MOBILE = VP[0] < 600;
const TAG = process.env.TAG ?? (MOBILE ? 'mobile' : 'desktop');
const PHASES = (process.env.PHASES ?? 'A,B').split(',');
const PROMPT = process.env.PROMPT ?? 'a GPU row is getting hot and the water feels wrong; sort it out';
const OUT = new URL(`../../artifacts/e2e/${TAG}/`, import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const STATE_FILE = OUT + 'state.json';
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
const results = existsSync(OUT + 'results.json') ? JSON.parse(readFileSync(OUT + 'results.json', 'utf8')) : [];
const saveResults = () => writeFileSync(OUT + 'results.json', JSON.stringify(results, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (path, init) => { const t = Date.now(); const r = await fetch(API + path, init); let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j, ms: Date.now() - t }; };

const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: VP[0], height: VP[1] }, hasTouch: MOBILE, isMobile: MOBILE, deviceScaleFactor: MOBILE ? 2 : 1 });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + e.message.slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
const failedReq = [];
page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) failedReq.push(`${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); });
const reqLog = [];
page.on('response', async (r) => { if (r.url().includes('/scenario-requests') && r.request().method() === 'POST') { try { reqLog.push({ t: Date.now(), body: await r.json() }); } catch {} } });

let stepN = Number(process.env.STEP_OFFSET ?? 0);
const snap = async (name) => { const f = `${String(++stepN).padStart(2, '0')}_${name}.png`; await page.screenshot({ path: OUT + f }); return f; };
const ONLY = process.env.STEPS ? process.env.STEPS.split(',') : null;
const step = async (id, title, fn) => {
  if (ONLY && !ONLY.includes(id)) return null;
  const t0 = Date.now(); let r;
  try { const ev = (await fn()) ?? {}; r = { id, title, status: ev.status ?? 'PASS', ms: Date.now() - t0, ...ev }; }
  catch (e) { let shot = null; try { shot = await snap(`${id}_FAIL`); } catch {} r = { id, title, status: 'FAIL', ms: Date.now() - t0, error: String(e.message).slice(0, 400), shot }; }
  try { const t = await bodyText(); r.ui_after = { stale_banner: /STALE/.test(t), model_chip: /NEMOTRON LIVE/.test(t) ? 'NEMOTRON LIVE' : /AUTONOMOUS POLICY/.test(t) ? 'AUTONOMOUS POLICY' : 'other' }; } catch {}
  const i = results.findIndex((x) => x.id === id); if (i >= 0) results[i] = r; else results.push(r);
  saveResults(); console.log(r.status, id, title, JSON.stringify(r).slice(0, 500));
  return r;
};
const ok = (c, m) => { if (!c) throw new Error(m); };
const bodyText = () => page.evaluate(() => document.body.innerText);
const keyTab = async (n) => { await page.keyboard.press(String(n)); await sleep(1500); };
const tabBtn = (name) => page.locator('button.seg__item', { hasText: name }).first();
const goTab = async (name, n) => { if (MOBILE) { await tabBtn(name).click().catch(async () => keyTab(n)); } else await keyTab(n); await sleep(1500); };
const chip = (name) => page.locator('button.chip, button.cm-launcher', { hasText: new RegExp('^\\s*' + name) }).first();

await page.goto(WEB);
await sleep(6000);

// ---------------------------------------------------------------- phase A
if (PHASES.includes('A')) {
  await step('S1', 'App loads, four tabs render, no console errors, LIVE badge, model status truthful', async () => {
    const before = await api('/models/status');
    const ready = await api('/health/ready');
    const txt = await bodyText();
    ok(/LIVE/.test(txt), 'no LIVE badge text');
    const tabs = {};
    for (const [n, name] of [[1, 'Dashboard'], [2, 'Map'], [3, 'Agents'], [4, 'Execution']]) {
      await goTab(name, n);
      const shot = await snap(`tab_${name}`);
      tabs[name] = { shot, active: await page.locator('button.seg__item[aria-selected=true], button.seg__item.is-active, button.seg__item--active').count() >= 0 };
    }
    await goTab('Dashboard', 1);
    // system popover = model id
    let popover = null;
    try { await page.locator('button.brand').click(); await sleep(1200); popover = (await page.locator('[role=dialog], .popover, .sys-pop').first().innerText().catch(() => null)); await snap('system_popover'); await page.keyboard.press('Escape'); } catch {}
    const chipTxt = await page.locator('text=/NEMOTRON/i').first().innerText().catch(() => null);
    ok(before.json.status === 'live' && before.json.online === true && before.json.fallback_active === false, 'models/status not live: ' + JSON.stringify(before.json));
    ok(/NEMOTRON LIVE/i.test(chipTxt ?? ''), 'top-bar chip is "' + chipTxt + '" while API says live');
    return { tabs, models_status: before.json, health_intel: ready.json?.health?.intelligence, chip: chipTxt, popover: popover?.slice(0, 600), api_ms: before.ms, console_errors_so_far: [...consoleErrors] };
  });
  await step('S1b', 'No console errors after load + tab tour', async () => {
    const real = consoleErrors.filter((e) => !/WebGL|GPU stall|favicon|swiftshader/i.test(e));
    return { status: real.length ? 'FAIL' : 'PASS', console_errors: real.slice(0, 20), ignored_webgl: consoleErrors.length - real.length, failed_api_requests: [...new Set(failedReq)].slice(0, 20) };
  });

  const pre = await api('/runs/run_live/contracts'); state.contracts_before = pre.json?.contracts?.length ?? null;
  const incBefore = (await api('/incidents')).json ?? []; state.incidents_before = incBefore.map((i) => i.id);
  const mBefore = (await api('/health/ready')).json?.health?.intelligence ?? {}; state.intel_before = mBefore;
  saveState();

  await step('S2', 'Prompt: composer -> received/classified/interpreted/scenario_validated/running with latencies, spec preview, incident link', async () => {
    await goTab('Dashboard', 1);
    await page.getByRole('button', { name: /Simulate an incident/ }).click();
    const ta = page.locator('textarea').first();
    await ta.waitFor({ timeout: 8000 });
    await ta.fill(PROMPT);
    await snap('composer_filled');
    const submitBtn = page.getByRole('button', { name: /Run Simulation/ }).first();
    const t0 = Date.now(); state.submit_ms = t0;
    await submitBtn.click();
    const seen = []; let last = ''; let shots = 0; let closedAt = null;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      const t = await page.evaluate(() => { const d = document.querySelector('[role=dialog], .scenario-composer, .launcher'); return d ? d.innerText : null; });
      if (t === null) { closedAt = closedAt ?? Date.now() - t0; if (Date.now() - t0 > closedAt + 8000) break; }
      else if (t !== last) { last = t; seen.push({ t_ms: Date.now() - t0, text: t.replace(/\s+/g, ' ').slice(0, 900) }); if (shots < 6) { shots++; await snap('prompt_status_' + shots); } }
      if (/Failed at/i.test(last)) break;
      await sleep(250);
    }
    const rid = reqLog[0]?.body?.request_id; state.request_id = rid; saveState();
    ok(rid, 'no POST /scenario-requests response observed');
    let rec = null; const until = Date.now() + 120000;
    while (Date.now() < until) { rec = (await api(`/scenario-requests/${rid}`)).json; if (rec && ['READY', 'FAILED', 'CANCELED', 'RUNNING', 'COMPLETED'].includes(rec.status) && (rec.live || rec.status === 'FAILED')) break; await sleep(1500); }
    state.request_record = rec; saveState();
    writeFileSync(OUT + 'scenario_request_record.json', JSON.stringify(rec, null, 1));
    return { request_id: rid, closed_modal_after_ms: closedAt, strip_transitions: seen.length, strip_first: seen[0], strip_last: seen[seen.length - 1], status: rec?.status === 'FAILED' ? 'FAIL' : 'PASS', record_status: rec?.status, phase: rec?.phase, latencies_ms: rec?.interpretation?.latencies_ms, tokens_used: rec?.interpretation?.tokens_used, laya: rec?.interpretation?.laya?.result, crusoe_model: rec?.interpretation?.crusoe?.model, resolved_assets: rec?.interpretation?.compiler?.resolved_assets, live: rec?.live, run_id: rec?.run_id, error: rec?.error_message };
  });
  await sleep(3000); await snap('after_prompt_exec_tab');
}
// ---------------------------------------------------------------- phase B
if (PHASES.includes('B')) {
  const panelText = async () => (await bodyText());
  const hideAll = async () => { const c = page.locator('button.chip', { hasText: /^Hide All/ }); if (await c.count()) await c.first().click(); await sleep(600); };
  const openChip = async (n) => { const c = chip(n); await c.click(); await sleep(1800); };
  const closeChip = async (n) => { const c = chip(n); await c.click().catch(() => {}); await sleep(500); };
  const commsOpen = async () => (await page.locator('#lk-comms-panel').count()) > 0;
  const openComms = async () => { if (!(await commsOpen())) { await page.locator('button.cm-launcher').first().click(); await page.locator('#lk-comms-panel').waitFor({ timeout: 8000 }); await sleep(800); } };
  const closeComms = async () => { if (await commsOpen()) { await page.locator('button.cm-x, button[aria-label="Close communications"]').first().click(); await page.locator('#lk-comms-panel').waitFor({ state: 'detached', timeout: 5000 }); } };
  const count = () => page.locator('.cm-count').first().innerText().catch(() => '');
  const rowLabels = () => page.locator('.cm-row').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.innerText.replace(/\n/g, ' ')));
  const secs = (l) => { const m = /^(\d+):(\d\d):(\d\d)/.exec(l); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };

  await goTab('Execution', 4);
  await hideAll();
  await snap('exec_hidden_all');

  await step('S3', 'Communications panel: real rows in order, filters, close/reopen x3, detail, jump-to-tick', async () => {
    await openComms();
    await page.waitForFunction(() => document.querySelectorAll('.cm-row').length > 0, null, { timeout: 15000 });
    const apiPage = (await api('/runs/run_live/communications?limit=200')).json;
    const seqs = (apiPage.events ?? []).map((e) => e.seq);
    const apiAsc = seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
    const labels = await rowLabels();
    const ts = labels.map(secs).filter((x) => x !== null);
    const domMonotonic = ts.every((v, i) => i === 0 || v >= ts[i - 1]);
    await snap('comms_all');
    const kindsApi = {}; { let after = 0; for (let pg = 0; pg < 40; pg++) { const r = (await api(`/runs/run_live/communications?limit=200&after_seq=${after}`)).json; for (const e of r?.events ?? []) kindsApi[e.kind] = (kindsApi[e.kind] ?? 0) + 1; if (!r?.has_more) break; after = r.next_after_seq; } }
    const kinds = {};
    for (const [q, key] of [['assign', 'assign'], ['accepted', 'ack/tool-accepted'], ['called', 'tool'], ['verif', 'verify']]) {
      await page.locator('.cm-search input').fill(q); await sleep(700);
      kinds[key] = await count();
    }
    await page.locator('.cm-search input').fill(''); await sleep(400);
    const filters = {};
    for (const f of ['SENTINEL', 'INPIPE', 'OUTRIG', 'Tools', 'Failures', 'Operator', 'All']) {
      await page.locator('.cm-chip', { hasText: new RegExp('^' + f) }).click(); const tF = Date.now();
      let ls = []; while (Date.now() - tF < 8000) { ls = await rowLabels(); if (ls.length > 0 || /^0\s*\//.test(await count())) break; await sleep(150); }
      filters[f] = { ms_to_rows: Date.now() - tF, rows_in_dom: ls.length, count: await count(), sample: (ls[ls.length - 1] ?? '').slice(0, 110) };
      if (f === 'OUTRIG' || f === 'Tools') await snap('comms_filter_' + f);
    }
    // close and reopen 3 times
    await page.locator('.cm-chip', { hasText: /^Tools/ }).click(); await sleep(400);
    const reopen = [];
    for (let i = 0; i < 3; i++) {
      const c0 = await count();
      await closeComms(); const closedOk = !(await commsOpen());
      await sleep(1500);
      await openComms();
      const tOpen = Date.now(); const rows800 = (await rowLabels()).length;
      let rowsMs = null; while (Date.now() - tOpen < 8000) { if ((await rowLabels()).length > 0) { rowsMs = Date.now() - tOpen; break; } await sleep(100); }
      reopen.push({ i: i + 1, closedOk, reopened: await commsOpen(), rows_right_after_open: rows800, ms_until_rows_visible: rowsMs, rows: (await rowLabels()).length, count_before: c0, count_after: await count(), filter_pressed: await page.locator('.cm-chip[aria-pressed=true]').first().innerText() });
    }
    await page.locator('.cm-chip', { hasText: /^All/ }).click(); await sleep(500);
    await snap('comms_after_reopen3');
    const reopenOk = reopen.every((r) => r.closedOk && r.reopened && r.rows > 0 && r.ms_until_rows_visible !== null);
    ok(reopenOk, 'reopen cycle failed ' + JSON.stringify(reopen));
    // detail + jump-to-tick
    await page.locator('.cm-row').last().click(); await page.locator('.cm-detail').waitFor({ timeout: 5000 });
    const detail = (await page.locator('.cm-detail').innerText()).replace(/\n/g, ' | ').slice(0, 500);
    await snap('comms_detail');
    const seekBtn = page.locator('.cm-detail button', { hasText: /Seek timeline/ });
    ok(await seekBtn.count() === 1, 'no seek-to-tick button');
    const seekLabel = await seekBtn.innerText();
    await seekBtn.click(); await sleep(2500);
    await snap('comms_after_jump_to_tick');
    const afterJump = (await bodyText());
    const replayNow = /REPLAY/.test(afterJump);
    state.jump_label = seekLabel; saveState();
    return { api_events_page: seqs.length, api_seq_ascending: apiAsc, dom_rows: labels.length, dom_times_monotonic: domMonotonic, kind_counts_ui_search: kinds, kind_counts_api: kindsApi, filters, reopen, detail, jump_label: seekLabel, replay_after_jump: replayNow, status: apiAsc && domMonotonic ? 'PASS' : 'FAIL' };
  });
  // return to live if the jump moved the cursor
  await page.reload(); await sleep(6000); await goTab('Execution', 4); await hideAll();

  await step('S4', 'DOD panel: FROZEN contract, checks, hold timers, PASS/FAIL/UNKNOWN, terminal state, why-not-done', async () => {
    await closeComms();
    await openChip('Done');
    const shot = await snap('done_panel');
    const t = await panelText();
    const i = t.indexOf('Definition of Done');
    const sect = t.slice(i, i + 1800);
    const contracts = (await api('/runs/run_live/contracts')).json?.contracts ?? [];
    const full = [];
    for (const c of contracts) { const r = (await api(`/runs/run_live/incidents/${c.incident_id}/contract`)).json?.contract; if (r) full.push({ incident: c.incident_id, state: r.state, terminal: r.terminal_state, version: r.version, frozen_hash: r.frozen_hash, drafted_by: r.drafted_by, checks: (r.checks ?? []).map((k) => ({ id: k.id, type: k.type, threshold: k.threshold, hold_sim_s: k.hold_sim_s })), revisions: (r.revisions ?? []).length, attempts: (r.history ?? []).length, layer_b: r.evaluation?.layer_b ?? (r.history ?? []).slice(-1)[0]?.layer_b }); }
    ok(i >= 0, 'panel did not render "Definition of Done"');
    const hasStates = /PASS|FAIL|UNKNOWN/.test(sect), hasHold = /hold/i.test(sect), hasLife = /FROZEN/.test(sect), hasTerm = /VERIFIED|ESCALATED|FAILED|PARTIAL|CONTAINED|TIMED_OUT|Terminal/i.test(sect);
    await closeChip('Done');
    return { panel_text: sect.replace(/\n/g, ' | '), has_check_states: hasStates, has_hold_timers: hasHold, lifecycle_shows_FROZEN: hasLife, has_terminal: hasTerm, api_contracts: full, why_not_done_seen: /why|not done|waiting|needs/i.test(sect), status: hasStates && hasHold && hasLife && hasTerm ? 'PASS' : 'FAIL' };
  });

  await step('S5', 'Team panel: five SEN seats + INPIPE/OUTRIG tasks', async () => {
    await openChip('Team');
    await snap('team_panel');
    const t = await panelText(); const i = t.indexOf('Team\n'); const sect = t.slice(i, i + 3000);
    const seats = ['SEN-01', 'SEN-02', 'SEN-03', 'SEN-04', 'SEN-05'].filter((s) => sect.includes(s));
    const graph = (await api('/runs/run_live/agents/graph')).json;
    const tasks = (graph?.nodes ?? []).filter((n) => n.kind === 'task');
    const robots = (graph?.nodes ?? []).filter((n) => n.kind === 'robot');
    await closeChip('Team');
    ok(seats.length === 5, 'seats seen: ' + seats);
    return { seats_in_panel: seats, panel_text: sect.replace(/\n/g, ' | ').slice(0, 1500), api_nodes: (graph?.nodes ?? []).length, api_edges: (graph?.edges ?? []).length, api_task_nodes: tasks.length, api_robot_nodes: robots.length, sample_tasks: tasks.slice(0, 8).map((n) => n.id + ':' + (n.title ?? n.label ?? '') + ':' + (n.status ?? '')), has_inpipe_task: /IR-\d\d|INPIPE/.test(sect), has_outrig_task: /OR-\d\d|OUTRIG/.test(sect) };
  });

  await step('S9', 'Scorecard chip shows the evaluation', async () => {
    await openChip('Scorecard');
    await snap('scorecard');
    const t = await panelText(); const i = t.search(/Scorecard/i);
    const sc = (await api('/eval/scorecard')).json;
    const arms = Object.keys(sc?.arms ?? {});
    await closeChip('Scorecard');
    return { panel_text: t.slice(t.lastIndexOf('Hide All'), t.lastIndexOf('Hide All') + 1800).replace(/\n/g, ' | '), api_manifest_sha: sc?.manifest_sha256?.slice(0, 16), api_arms: arms, api_n_scenarios: sc?.n_scenarios, api_n_seeds: sc?.n_seeds, shows_manifest: t.includes(sc?.manifest_sha256?.slice(0, 8) ?? '@@'), status: /scorecard|verified|false success|baseline/i.test(t) ? 'PASS' : 'FAIL' };
  });

  await step('S7', 'Agents tab delegation graph', async () => {
    await goTab('Agents', 3);
    await sleep(2500);
    await snap('agents_tab');
    const t = await bodyText();
    const seats = ['SEN-01', 'SEN-02', 'SEN-03', 'SEN-04', 'SEN-05'].filter((s) => t.includes(s));
    const graph = (await api('/runs/run_live/agents/graph')).json;
    const svgNodes = await page.locator('svg g, [data-node-id], .agent-node, .node').count();
    ok(seats.length >= 3, 'seats in Agents tab: ' + seats);
    return { seats_visible: seats, api_nodes: (graph?.nodes ?? []).length, api_edges: (graph?.edges ?? []).length, dom_graph_elements: svgNodes, text_excerpt: t.slice(0, 700).replace(/\n/g, ' | ') };
  });

  await step('S6', 'Map: select OUTRIG, ghost Preview Drive (preview-only), Take Control lease, drive, server pose changed, release', async () => {
    await goTab('Map', 2);
    const RID = 'OR-01';
    const get = async () => (await api(`/robots/${RID}`)).json;
    const r0 = await get();
    ok(r0?.class === 'outrig', 'OR-01 not outrig');
    await page.getByPlaceholder(/Search \d+ robots/).fill(RID); await sleep(800);
    await page.getByText(RID, { exact: false }).first().click(); await sleep(2500);
    await snap('map_selected_OR-01');
    // ghost preview: must NOT move the server pose
    await page.getByRole('button', { name: /Preview Drive/ }).click(); await sleep(1200);
    const previewTxt = (await bodyText());
    await snap('map_preview_drive');
    await page.keyboard.down('ArrowUp'); await sleep(2500); await page.keyboard.up('ArrowUp'); await sleep(800);
    const rPrev = await get();
    const dist = (a, b) => Math.hypot(a.pose.position_xyz_m[0] - b.pose.position_xyz_m[0], a.pose.position_xyz_m[2] - b.pose.position_xyz_m[2]);
    const previewMoved = dist(r0, rPrev);
    const previewLabelled = /preview/i.test(previewTxt) && /(preview[- ]only|ghost|not (sent|applied)|no effect|simulat)/i.test(previewTxt);
    await snap('map_preview_after_keys');
    // leave preview mode (Escape or toggle), then take live control
    const exitBtn = page.getByRole('button', { name: /Exit Ghost Preview/ });
    if (await exitBtn.count()) await exitBtn.first().click(); await sleep(800);
    const ghostStillOn = /GHOST PREVIEW MODE/.test(await bodyText());
    const take = page.getByRole('button', { name: /Take LIVE Control/ });
    let attempts = 0, refused = 0; const tTake = Date.now();
    while (Date.now() - tTake < 90000) {
      attempts++; await take.first().click().catch(() => {}); await sleep(1500);
      if (/live stream is not connected/.test(await bodyText())) refused++;
      const c = (await get())?.control; if (c?.lease_id) break; await sleep(1500);
    }
    state.take_control = { attempts, refused_stream_not_connected: refused, ms: Date.now() - tTake }; saveState(); await sleep(1500);
    const rLease = await get();
    await snap('map_live_control');
    const leaseTxt = await bodyText();
    const lease = rLease?.control;
    ok(lease?.lease_id || /LIVE CONTROL|MANUAL/i.test(leaseTxt), 'no lease visible: ' + JSON.stringify(lease));
    const p0 = rLease.pose.position_xyz_m;
    await page.mouse.move(700, 450);
    await page.keyboard.down('ArrowUp'); await sleep(4000); await page.keyboard.up('ArrowUp'); await sleep(1000);
    await page.keyboard.down('ArrowRight'); await sleep(1500); await page.keyboard.up('ArrowRight'); await sleep(800);
    const rDrive = await get();
    await snap('map_after_drive');
    const moved = dist(rLease, rDrive); const yawDelta = rDrive.pose.yaw_rad - rLease.pose.yaw_rad;
    const rel = page.getByRole('button', { name: /Release|Return to autonomy|Release control/i }).first();
    const relCount = await rel.count();
    if (relCount) await rel.click(); await sleep(2000);
    const rEnd = await get();
    await snap('map_released');
    return { robot: RID, pose_before: r0.pose.position_xyz_m, pose_after_preview_keys: rPrev.pose.position_xyz_m, preview_moved_server_m: +previewMoved.toFixed(3), preview_label_text_found: previewLabelled, ghost_exited: !ghostStillOn, take_control_attempts: attempts, take_control_refused_stream_not_connected: refused, take_control_ms: Date.now() - tTake, lease_during: { authority: lease?.authority, state: lease?.controller_state, lease_id: lease?.lease_id, epoch: lease?.lease_epoch, holder: lease?.holder }, pose_at_lease: p0, pose_after_drive: rDrive.pose.position_xyz_m, moved_m_server_authoritative: +moved.toFixed(3), yaw_delta_rad: +yawDelta.toFixed(3), release_clicked: !!relCount, after_release: { authority: rEnd?.control?.authority, state: rEnd?.control?.controller_state, lease_id: rEnd?.control?.lease_id, mode: rEnd?.mode }, status: previewMoved < 0.05 && moved > 0.2 && (!relCount || !rEnd?.control?.lease_id) ? 'PASS' : 'FAIL' };
  });

  await step('S6b', 'Drive path at API level (same lease/drive endpoints the UI uses): lease OR-02, drive, server pose changes, release', async () => {
    const RID = process.env.S6B_ROBOT ?? 'OR-02', run = 'run_live';
    const get = async () => (await api(`/robots/${RID}`)).json;
    const post = async (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const uuid = () => crypto.randomUUID();
    const world = (await api('/world')).json; const topo = (await api('/topology')).json;
    const rev = topo.facility.topology_hash, ver = world.version ?? 0;
    const r0 = await get();
    const lease = await post(`/runs/${run}/robots/${RID}/control/lease`, { expected_world_version: ver, idempotency_key: uuid(), client_id: 'e2e-agent-h', topology_revision: rev });
    ok(lease.status === 200 && lease.json?.lease_id, 'lease refused: ' + lease.status + ' ' + JSON.stringify(lease.json).slice(0, 300));
    const L = lease.json; let seq = 1; const acks = [];
    const t0 = Date.now(); let lastHb = Date.now();
    while (Date.now() - t0 < 6000) {
      const d = await post(`/runs/${run}/robots/${RID}/drive`, { lease_id: L.lease_id, lease_epoch: L.lease_epoch, command_seq: seq++, idempotency_key: uuid(), topology_revision: rev, throttle: Number(process.env.S6B_THROTTLE ?? 0.8), steer: 0, brake: false, duration_ms: 200 });
      acks.push({ status: d.status, accepted: d.json?.accepted, speed: d.json?.pose?.speed_m_s, reason: d.json?.reason ?? d.json?.code });
      if (Date.now() - lastHb > (L.heartbeat_interval_ms ?? 1000)) { await post(`/runs/${run}/robots/${RID}/control/heartbeat`, { lease_id: L.lease_id, lease_epoch: L.lease_epoch }); lastHb = Date.now(); }
      await sleep(150);
    }
    const during = await get();
    const rel = await post(`/runs/${run}/robots/${RID}/control/release`, { lease_id: L.lease_id, lease_epoch: L.lease_epoch, idempotency_key: uuid(), reason: 'operator_release' });
    await sleep(1500);
    const rEnd = await get();
    const dist = (a, b) => Math.hypot(a.pose.position_xyz_m[0] - b.pose.position_xyz_m[0], a.pose.position_xyz_m[2] - b.pose.position_xyz_m[2]);
    const moved = dist(r0, during);
    return { robot: RID, lease: { lease_id: L.lease_id?.slice(0, 8), epoch: L.lease_epoch, heartbeat_interval_ms: L.heartbeat_interval_ms, deadman_ms: L.deadman_ms }, control_during: { authority: during.control.authority, state: during.control.controller_state, holder: during.control.holder }, drive_intents: acks.length, accepted: acks.filter((a) => a.accepted).length, first_acks: acks.slice(0, 3), pose_before: r0.pose.position_xyz_m, pose_during: during.pose.position_xyz_m, moved_m_server_authoritative: +moved.toFixed(3), release_status: rel.status, after_release: { authority: rEnd.control.authority, lease_id: rEnd.control.lease_id, state: rEnd.control.controller_state, mode: rEnd.mode }, status: moved > 0.2 && !rEnd.control.lease_id ? 'PASS' : 'FAIL' };
  });

  await step('S8b', 'Fork from Playhead on the live run (parent keeps running, child is a read-only branch)', async () => {
    await page.reload(); await sleep(6000); await goTab('Execution', 4); await hideAll(); await closeComms();
    const before = (await api('/runs')).json ?? [];
    const liveB = before.find((r) => r.run_id === 'run_live');
    await openChip('Details'); await sleep(1000); await snap('live_details');
    const fork = page.getByRole('button', { name: /Fork from Playhead/ });
    ok(await fork.count(), 'no fork button');
    await fork.click();
    let kids = []; const t0 = Date.now();
    while (Date.now() - t0 < 60000) { await sleep(2000); const now = (await api('/runs')).json ?? []; kids = now.filter((r) => r.parent_run_id === 'run_live' && !before.find((b) => b.run_id === r.run_id)); if (kids.length) break; }
    await snap('live_after_fork');
    const toast = (await bodyText()).match(/(Warning|Notice|Error)[^\n]*\n[^\n]*/)?.[0];
    const after = (await api('/runs')).json ?? [];
    const liveA = after.find((r) => r.run_id === 'run_live');
    let childCmd = null;
    if (kids[0]) childCmd = (await api(`/runs/${kids[0].run_id}/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command_id: 'e2e-readonly-probe-' + Date.now(), kind: 'test.inject_fault', args: {} }) })).status;
    return { forks: kids.map((k) => ({ run_id: k.run_id, mode: k.mode, state: k.state, parent: k.parent_run_id, fork_tick: k.fork_tick, snapshot: k.fork_snapshot_id })), ms_to_child: kids.length ? Date.now() - t0 : null, ui_message: toast, parent_before: { state: liveB?.state, tick: liveB?.current_tick }, parent_after: { state: liveA?.state, tick: liveA?.current_tick, still_running: liveA?.state === 'running' && liveA.current_tick > liveB.current_tick }, child_fault_command_http: childCmd, status: kids.length === 1 && liveA?.state === 'running' ? 'PASS' : 'FAIL' };
  });

  await step('S8', 'Replay scrub + fork from playhead on a stored run (parent unchanged, 0 model calls in replay)', async () => {
    await page.reload(); await sleep(6000); await goTab('Execution', 4); await hideAll(); await closeComms();
    const runsBefore = (await api('/runs')).json ?? [];
    const parent = runsBefore.find((r) => r.run_id !== 'run_live' && r.state !== 'running' && !r.parent_run_id && (r.recording?.frames ?? 0) > 0);
    ok(parent, 'no stored run to replay');
    const liveBefore = runsBefore.find((r) => r.run_id === 'run_live');
    await openChip('Runs'); await snap('runs_panel');
    await page.locator('button.ex-run', { hasText: parent.label || parent.run_id }).first().click(); await sleep(3500);
    await closeChip('Runs');
    await openChip('Timeline'); await sleep(2000);
    await snap('replay_timeline');
    const trk = page.locator('.ex-tl [class*=track], .ex-tl__track, .ex-tl').first();
    const box = await page.locator('text=Physics').first().boundingBox();
    const x0 = 120, x1 = 1415, y = box.y + box.height / 2;
    const ticks = [];
    for (const f of [0.25, 0.6, 0.4]) {
      await page.mouse.click(x0 + (x1 - x0) * f, y); await sleep(2500);
      const t = await bodyText(); const m = /Tick\s+([\d,]+)/.exec(t); ticks.push(m ? +m[1].replace(/,/g, '') : null);
      if (f === 0.6) await snap('replay_scrubbed_60pct');
    }
    const t1 = await bodyText();
    const replayBadge = /REPLAY/.test(t1);
    const scrub = ticks[ticks.length - 1];
    const rc = (await api(`/runs/${parent.run_id}/replay/communications?cursor_tick=${scrub ?? 0}&limit=200`)).json;
    const maxSimTick = Math.max(...((rc?.events ?? []).map((e) => e.sim_tick ?? 0)), 0);
    const intel0 = (await api('/health/ready')).json?.health?.intelligence?.calls;
    const headBefore = (await api(`/runs/${parent.run_id}`)).json;
    // comms rows of the stored run + jump-to-tick (works only while the run is open in replay)
    let jump = null;
    try {
      await openComms(); await sleep(2500);
      const nrows = (await rowLabels()).length;
      if (nrows) {
        await page.locator('.cm-row').first().click(); await page.locator('.cm-detail').waitFor({ timeout: 5000 });
        const btn = page.locator('.cm-detail button', { hasText: /Seek timeline/ });
        const label = await btn.innerText(); const want = +/tick (\d+)/.exec(label)?.[1];
        const tk0 = +(/Tick\s+([\d,]+)/.exec(await bodyText())?.[1] ?? '0').replace(/,/g, '');
        await btn.click(); await sleep(2500);
        const tk1 = +(/Tick\s+([\d,]+)/.exec(await bodyText())?.[1] ?? '0').replace(/,/g, '');
        jump = { rows: nrows, label, want_tick: want, tick_before: tk0, tick_after: tk1, jumped: tk1 === want };
        await snap('replay_comms_jump');
      } else jump = { rows: 0 };
      await closeComms().catch(() => {});
    } catch (e) { jump = { error: String(e.message).slice(0, 200) }; }
    await openChip('Details'); await sleep(800); await snap('replay_details');
    const fork = page.getByRole('button', { name: /Fork from Playhead/ });
    ok(await fork.count(), 'no fork button');
    await fork.click(); await sleep(8000);
    await snap('after_fork');
    const runsAfter = (await api('/runs')).json ?? [];
    const kids = runsAfter.filter((r) => r.parent_run_id === parent.run_id && !runsBefore.find((b) => b.run_id === r.run_id));
    const headAfter = (await api(`/runs/${parent.run_id}`)).json;
    const liveAfter = runsAfter.find((r) => r.run_id === 'run_live');
    return { parent_run: parent.run_id, parent_label: parent.label, scrub_ticks_clicked: ticks, replay_badge_shown: replayBadge, comms_jump_to_tick: jump, replay_comms: { count: rc?.count, model_calls: rc?.model_calls, max_sim_tick: maxSimTick, cursor_tick: scrub, no_future_leak: maxSimTick <= (scrub ?? 0) }, parent_head_hash_before: headBefore?.head_hash?.slice(0, 16), parent_head_hash_after: headAfter?.head_hash?.slice(0, 16), parent_unchanged: headBefore?.head_hash === headAfter?.head_hash && headBefore?.recording?.events === headAfter?.recording?.events, forks_created: kids.map((k) => ({ run_id: k.run_id, mode: k.mode, state: k.state, parent: k.parent_run_id, fork_tick: k.fork_tick })), live_run_unaffected: liveAfter?.state === liveBefore?.state && liveAfter?.mode === 'LIVE', status: replayBadge && rc?.model_calls === 0 && kids.length === 1 && headBefore?.head_hash === headAfter?.head_hash ? 'PASS' : 'FAIL' };
  });
}
// ---------------------------------------------------------------- phase M (mobile / any viewport read-only pass, no mutations)
if (PHASES.includes('M')) {
  await step('M1', `Viewport ${VP.join('x')}: tabs render, no horizontal overflow, composer opens, panels reachable`, async () => {
    const info = {};
    for (const [n, name] of [[1, 'Dashboard'], [2, 'Map'], [3, 'Agents'], [4, 'Execution']]) {
      await goTab(name, n); await sleep(1500);
      info[name] = { shot: await snap('m_' + name), h_overflow_px: await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) };
    }
    await goTab('Dashboard', 1);
    let composer = false;
    try { await page.getByRole('button', { name: /Simulate an incident/ }).click({ timeout: 5000 }); await page.locator('textarea').first().waitFor({ timeout: 5000 }); composer = true; await snap('m_composer'); await page.keyboard.press('Escape'); } catch {}
    await goTab('Execution', 4);
    const opened = {};
    for (const n of ['Done', 'Team', 'Scorecard']) { try { await chip(n).click({ timeout: 4000 }); await sleep(1500); opened[n] = await snap('m_panel_' + n); await chip(n).click({ timeout: 3000 }).catch(() => {}); } catch (e) { opened[n] = 'not reachable: ' + String(e.message).slice(0, 80); } }
    const real = consoleErrors.filter((e) => !/WebGL|GPU stall|favicon|swiftshader/i.test(e));
    const over = Object.values(info).filter((v) => v.h_overflow_px > 2).length;
    return { tabs: info, composer_opens: composer, panels: opened, console_errors: real.slice(0, 10), status: over === 0 && composer && real.length === 0 ? 'PASS' : 'FAIL' };
  });
}
const out = { tag: TAG, viewport: VP, at: new Date().toISOString(), results, console_errors: consoleErrors.slice(0, 40), failed_api_requests: [...new Set(failedReq)].slice(0, 40) };
writeFileSync(OUT + 'results.json', JSON.stringify(results, null, 1));
writeFileSync(OUT + 'run_summary.json', JSON.stringify(out, null, 1));
await browser.close();
