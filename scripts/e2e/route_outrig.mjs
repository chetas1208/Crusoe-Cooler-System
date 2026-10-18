// V12 R: drive an OUTRIG to a service point on another road end to end, against a real (in-memory) API.
//   API=http://127.0.0.1:8818 node scripts/e2e/route_outrig.mjs [OR-03] [SV:ROAD-04:15.30] [lease|auto]
// Asserts the pose via GET /robots/<id> (authoritative) and prints every step; exits non-zero on any failed assertion.
const API = (process.env.API ?? 'http://127.0.0.1:8818') + '/api/v1';
const [robot = 'OR-03', targetId = 'SV:ROAD-04:15.30', mode = 'lease'] = process.argv.slice(2);
const j = async (path, init) => {
  const r = await fetch(API + path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = (path, body) => j(path, { method: 'POST', body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error('FAIL', m); process.exit(1); };
const ok = (c, m) => (c ? console.log('ok  ', m) : fail(m));
const R = '/runs/current';

const graph = (await j(`${R}/navigation/graphs?kind=exterior`)).body;
const node = graph.nodes.find((n) => n.id === targetId) ?? fail(`unknown target ${targetId}`);
const start = (await j(`/robots/${robot}`)).body;
const p0 = start.pose.position_xyz_m;
console.log(`start ${robot} at (${p0[0]}, ${p0[2]}) mode=${start.mode}; target ${targetId} (${node.x}, ${node.z}) road ${node.road_id}`);
ok(Math.abs(p0[2] - node.z) > 2, 'target is on another road than the start pose');

const plan = (await post(`${R}/robots/${robot}/route/plan`, { target: targetId })).body;
ok(plan.accepted === true, `plan accepted: eta ${plan.eta_s}s, length ${plan.length_m}m, ${plan.waypoints?.length} waypoints, rev ${plan.graph_revision}`);
const topo = (await j('/topology')).body;
let lease = null;
let seq = 0;
if (mode === 'lease') {
  const world = (await j('/world')).body;
  const l = (await post(`${R}/robots/${robot}/control/lease`, { expected_world_version: world.version, idempotency_key: crypto.randomUUID(), client_id: 'e2e_r', topology_revision: topo.facility.topology_hash })).body;
  ok(l.accepted === true, `lease granted ${l.lease_id}`);
  lease = l;
  // the controller stays LEASE_PENDING until the first intent arrives; destination mode needs MANUAL
  let first = {};
  for (let k = 0; k < 40 && first.accepted !== true; k++) {
    first = (await post(`${R}/robots/${robot}/drive`, { lease_id: l.lease_id, lease_epoch: l.lease_epoch, command_seq: ++seq, idempotency_key: crypto.randomUUID(), topology_revision: topo.facility.topology_hash, throttle: 0, steer: 0, brake: false, graph_revision: plan.graph_revision, duration_ms: 200 })).body;
    if (first.accepted !== true) await sleep(100);
  }
  if (first.accepted !== true) console.log('first body', JSON.stringify(first));
  ok(first.accepted === true, `first intent acked (controller_state ${first.controller_state})`);
}
const c = (await post(`${R}/robots/${robot}/route/commit`, { plan_id: plan.plan_id, graph_revision: plan.graph_revision, traffic_revision: plan.traffic_revision, ...(lease ? { lease_id: lease.lease_id } : {}), idempotency_key: crypto.randomUUID() })).body;
if (c.accepted !== true) console.log('commit body', JSON.stringify(c));
ok(c.accepted === true, `commit accepted ${JSON.stringify({ plan_id: c.plan_id, eta_s: c.eta_s })}`);

// hands-off intents at 20 Hz while the server follows the route (destination mode); heartbeat is implied by drive
let stopTimer = null;
if (lease) {
  let inflight = 0, acks = 0, rtts = [];
  stopTimer = setInterval(async () => {
    if (inflight > 1) return;
    inflight++;
    const t0 = performance.now();
    const r = (await post(`${R}/robots/${robot}/drive`, { lease_id: lease.lease_id, lease_epoch: lease.lease_epoch, command_seq: ++seq, idempotency_key: crypto.randomUUID(), topology_revision: topo.facility.topology_hash, throttle: 0, steer: 0, brake: false, graph_revision: plan.graph_revision, duration_ms: 200 })).body;
    inflight--;
    if (r.accepted) { acks++; rtts.push(performance.now() - t0); } else console.log('drive refused', r.code, r.reason);
  }, 50);
  globalThis.__acks = () => ({ acks, rtt_ms_p50: rtts.sort((a, b) => a - b)[Math.floor(rtts.length / 2)] });
}

const t0 = Date.now();
let pose = p0, mind = Infinity;
while (Date.now() - t0 < 120000) {
  await sleep(500);
  const r = (await j(`/robots/${robot}`)).body;
  pose = r.pose.position_xyz_m;
  const d = Math.hypot(pose[0] - node.x, pose[2] - node.z);
  mind = Math.min(mind, d);
  if (d < 0.7 && r.mode !== 'TRAVELING') break;
  if (d < 0.7 && (r.pose.speed_m_s ?? 0) < 0.01) break;
}
if (stopTimer) clearInterval(stopTimer);
const end = (await j(`/robots/${robot}`)).body;
pose = end.pose.position_xyz_m;
const dEnd = Math.hypot(pose[0] - node.x, pose[2] - node.z);
console.log(`end pose (${pose[0].toFixed(2)}, ${pose[2].toFixed(2)}) mode=${end.mode}, distance to target ${dEnd.toFixed(2)} m, wall ${(Date.now() - t0) / 1000}s`, lease ? JSON.stringify(globalThis.__acks()) : '');
ok(dEnd < 0.7, 'authoritative pose (GET /robots/<id>) is at the service point');
ok(Math.abs(pose[2] - p0[2]) > 2, 'robot ended on a different road');
if (lease) {
  const rel = (await post(`${R}/robots/${robot}/control/release`, { lease_id: lease.lease_id, lease_epoch: lease.lease_epoch, idempotency_key: crypto.randomUUID(), reason: 'operator_release' })).body;
  ok(rel.accepted === true, `lease released (${rel.controller_state}, resumed=${rel.resumed})`);
}
console.log('PASS');
