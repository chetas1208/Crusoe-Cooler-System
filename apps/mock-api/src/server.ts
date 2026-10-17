/**
 * LOOPKEEPER mock API — a development stand-in for the real backend.
 *
 * It runs the deterministic mock engine from @loopkeeper/core and serves the same
 * REST (/api/v1/*) and WebSocket (/api/v1/stream) contract described in backend.md §9,
 * so the web and mobile apps can be developed against a *real network boundary* and the
 * real backend can replace this process without frontend changes.
 *
 * State survives restarts the honest way: the engine is deterministic from its seed, so
 * we persist {seed, sim time} and fast-forward on boot ("the world keeps operating after
 * the browser closes").
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { Engine, EngineRunner } from '@loopkeeper/core/engine';
import { createRunsRouter } from './runs';
import { initNeonDb, persistToNeon, getNeonHealth, queryNeonTest } from './db.js';
import type { CommandRequest, StreamEvent } from '@loopkeeper/core/contracts';
import { HTTP_STATUS_FOR_CODE, type ControlRefusal } from '@loopkeeper/core/control';

const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const HOST = env.HOST ?? '0.0.0.0';
const SEED = Number(env.WORLD_SEED ?? 8);
const SPEED = Number(env.SIM_SPEED_MULTIPLIER ?? 6);
const APPROVAL_MODE = (env.SAFE_AUTOMATION_MODE === 'supervised' ? 'supervised' : 'autonomous') as 'autonomous' | 'supervised';
const APPROVAL_WINDOW_S = Number(env.APPROVAL_WINDOW_S ?? 24);
const FAULTS = env.FAULTS !== '0';

const here = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(here, '..', '.state', 'world.json');

const engine = new Engine({ seed: SEED, speed: SPEED, approvalMode: APPROVAL_MODE, approvalWindowS: APPROVAL_WINDOW_S, faultsEnabled: FAULTS });

// Connect to Neon Postgres and restore state if available
const neonInit = await initNeonDb(engine, SEED);

// restore: fast-forward the deterministic world to where it was (fallback to file if not restored from Neon)
if (!neonInit.restored) {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { seed: number; sim_time_s: number };
    if (saved.seed === SEED && saved.sim_time_s > 0) {
      const t0 = Date.now();
      engine.fastForward(saved.sim_time_s);
      console.log(`↺ restored world (seed ${SEED}) to sim t=${saved.sim_time_s.toFixed(0)} s in ${Date.now() - t0} ms`);
    }
  } catch {
    /* first boot */
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ seed: SEED, sim_time_s: engine.plant.time }));
  } catch {
    /* non-fatal */
  }
  // Persist snapshot to Neon Postgres asynchronously
  void persistToNeon('lab_01', SEED, engine.plant.time, engine.snapshot());
}
setInterval(persist, 5000);
process.on('SIGINT', () => (persist(), process.exit(0)));
process.on('SIGTERM', () => (persist(), process.exit(0)));

const runner = new EngineRunner(engine);
runner.start();
// Execution tab: run ledger, recorder, replay, fork, scenario validation (MOCK) — see ./runs.ts
const runsRoute = createRunsRouter(engine, { seed: SEED, speed: SPEED, approvalMode: APPROVAL_MODE, approvalWindowS: APPROVAL_WINDOW_S, faultsEnabled: FAULTS });

/* ───────────────────────────── REST ───────────────────────────── */

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const p = url.pathname.replace(/\/$/, '');
  if (req.method === 'OPTIONS') return json(res, 204, {});
  try {
    if (await runsRoute(req, res, url, p)) return;
    if (p === '/api/v1/world') return json(res, 200, engine.snapshot());
    if (p === '/api/v1/topology') return json(res, 200, engine.topology);
    if (p === '/api/v1/robots') return json(res, 200, Object.values(engine.snapshot().robots));
    let m = p.match(/^\/api\/v1\/robots\/(.+)$/);
    if (m) {
      const r = engine.snapshot().robots[m[1]];
      return r ? json(res, 200, r) : json(res, 404, { error: 'unknown robot' });
    }
    m = p.match(/^\/api\/v1\/assets\/(.+)$/);
    if (m) {
      const a = engine.topology.assets.find((x) => x.id === m![1]);
      const e = engine.topology.edges.find((x) => x.id === m![1]);
      if (!a && !e) return json(res, 404, { error: 'unknown asset' });
      return json(res, 200, { asset: a ?? e, state: engine.snapshot().assets[m[1]] ?? null });
    }
    if (p === '/api/v1/incidents') return json(res, 200, engine.incidents(url.searchParams.get('status') === 'open' ? 'open' : undefined));
    m = p.match(/^\/api\/v1\/incidents\/([^/]+)\/trace$/);
    if (m) {
      if (!engine.orch.incidents.has(m[1])) return json(res, 404, { error: 'unknown incident' });
      return json(res, 200, { incident_id: m[1], tasks: engine.orch.traceFor(m[1]) });
    }
    if (p === '/api/v1/telemetry') {
      const s = engine.telemetry(url.searchParams.get('asset_id') ?? '', url.searchParams.get('metric') ?? '', Number(url.searchParams.get('window_s') ?? 600));
      return s ? json(res, 200, s) : json(res, 404, { error: 'no such series' });
    }
    if (p === '/api/v1/replay') return json(res, 200, engine.replay(Number(url.searchParams.get('from_seq') ?? 0), Number(url.searchParams.get('limit') ?? 500)));
    if (p === '/api/v1/commands' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as CommandRequest;
      return json(res, 200, engine.command(body));
    }
    /* manual control (backend.md §9/§10) — same ControlService the embedded transport uses; MOCK, no auth */
    m = p.match(/^\/api\/v1\/(?:runs\/[^/]+\/)?robots(?:\/([^/]+))?$/);
    if (m && req.method === 'GET') {
      const robots = engine.snapshot().robots;
      const rid = m[1];
      if (!rid) return json(res, 200, Object.values(robots));
      return robots[rid] ? json(res, 200, robots[rid]) : json(res, 404, { accepted: false, code: 'unknown_robot', reason: `No robot with id ${rid}.` });
    }
    m = p.match(/^\/api\/v1\/(?:runs\/[^/]+\/)?robots\/([^/]+)\/(control\/(?:lease|heartbeat|release)|drive)$/);
    if (m && req.method === 'POST') {
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 422, { accepted: false, code: 'bad_request', reason: 'Body is not valid JSON.' });
      }
      const id = decodeURIComponent(m[1]);
      const b = body as never;
      const action = m[2];
      const out =
        action === 'control/lease' ? engine.control.lease(id, b) : action === 'control/heartbeat' ? engine.control.heartbeat(id, b) : action === 'control/release' ? engine.control.release(id, b) : engine.control.drive(id, b);
      return json(res, out.accepted ? 200 : HTTP_STATUS_FOR_CODE[(out as ControlRefusal).code], out);
    }
    if (p === '/api/v1/health/live') return json(res, 200, { status: 'ok' });
    if (p === '/api/v1/health/ready') {
      const h = engine.health();
      const neon = getNeonHealth();
      h.database = neon.status === 'connected' ? 'ok' : neon.status === 'failed' ? 'unavailable' : 'n/a';
      return json(res, 200, { status: 'ready', backend: 'mock', health: h, neon });
    }
    if (p === '/api/v1/db/status') {
      const dbStatus = await queryNeonTest();
      return json(res, dbStatus.success ? 200 : 500, dbStatus);
    }
    if (p === '' || p === '/') return json(res, 200, { name: 'loopkeeper-mock-api', note: 'Development stand-in for the real backend. See /api/v1/world', seed: SEED });
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: String(err) });
  }
});

/* ───────────────────────────── WebSocket ───────────────────────────── */

const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname !== '/api/v1/stream') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  // first message is always a snapshot, then ordered typed events (backend.md §9)
  const snap = engine.snapshot();
  ws.send(
    JSON.stringify({
      event_id: `snap_${snap.last_seq}`,
      seq: snap.last_seq,
      sim_tick: snap.sim_tick,
      sim_time_s: snap.sim_time_s,
      world_version: snap.version,
      type: 'snapshot',
      entity_id: snap.facility_id,
      facility_id: snap.facility_id,
      ts: new Date().toISOString(),
      payload: snap,
    }),
  );
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

engine.subscribe((e: StreamEvent) => {
  if (!clients.size) return;
  const msg = JSON.stringify(e);
  for (const c of clients) if (c.readyState === 1) c.send(msg);
});

server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`\n  LOOPKEEPER mock API  (backend: "mock", seed ${SEED}, ×${SPEED}, ${APPROVAL_MODE})`);
  console.log(`  ➜ http://localhost:${PORT}/api/v1/world`);
  if (lan) console.log(`  ➜ http://${lan}:${PORT}   (use this on a physical phone)`);
  console.log(`  ➜ ws://localhost:${PORT}/api/v1/stream\n`);
});
