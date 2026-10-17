import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine';
import { RunRegistry } from '../src/runs/registry';
import { buildEngine, captureFrame, configFromOptions, frameHash } from '../src/runs/recorder';
import { projectWorld } from '../src/runs/project';
import { validateScenario, validateScenarioText, defaultScenario, SCENARIO_LIMITS } from '../src/runs/scenario';
import { ApiError } from '../src/runs/errors';
import { buildTimeline } from '../src/runs/timeline';
import { compareRuns } from '../src/runs/compare';
import { selectRunWorld, showProjected, useRunWorld } from '../src/runs/worldStore';
import { getLiveWorldState, useWorld } from '../src/store';

const OPTS = { seed: 8, speed: 6 };
function make(opts = OPTS) {
  const engine = new Engine(opts);
  const reg = new RunRegistry({ baseline: { engine, options: opts }, autoDrive: false });
  return { engine, reg };
}
const run = (e: Engine, ticks: number) => {
  for (let i = 0; i < ticks; i++) e.step();
};

describe('recording + seek', () => {
  it('seek is deterministic: same tick => same state and hash, equal to a fresh engine at that tick', () => {
    const { engine, reg } = make();
    run(engine, 1200);
    const w = reg.replay('run_baseline');
    const a = projectWorld(w.frames, w.events, 1000)!;
    const b = projectWorld(w.frames, w.events, 1000)!;
    expect(a.hash).toBe(b.hash);
    expect(a.exact).toBe(true);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    const fresh = buildEngine(configFromOptions(OPTS));
    run(fresh, 1000);
    expect(a.hash).toBe(frameHash(captureFrame(fresh).frame));
    // seeking backwards and forwards again lands on identical hashes
    const order = [400, 1196, 40, 1000, 400];
    const hashes = order.map((t) => projectWorld(w.frames, w.events, t)!.hash);
    expect(hashes[0]).toBe(hashes[4]);
    expect(hashes[3]).toBe(a.hash);
  });

  it('between samples the state is the last sample plus recorded events, and says it is not exact', () => {
    const { engine, reg } = make();
    run(engine, 600);
    const w = reg.replay('run_baseline');
    const p = projectWorld(w.frames, w.events, 403)!;
    expect(p.exact).toBe(false);
    expect(p.base_tick).toBe(400);
  });

  it('returns null (cannot reconstruct) before the first recorded sample', () => {
    const { engine, reg } = make();
    run(engine, 100);
    const w = reg.replay('run_baseline', { start_tick: 40 });
    expect(projectWorld(w.frames, w.events, 8)).toBeNull();
  });

  it('timeline collapses repeated records into ranges and builds incident sequences', () => {
    const { engine, reg } = make();
    run(engine, 2400);
    const w = reg.replay('run_baseline');
    const tl = buildTimeline(w.frames, w.events, w.commands);
    expect(tl.incidents.length).toBeGreaterThan(0);
    expect(tl.incidents[0].sequence.length).toBeGreaterThan(1);
    expect(tl.markers.some((m) => m.lane === 'agents' && m.count >= 1)).toBe(true);
    expect(tl.markers.some((m) => m.lane === 'physics' && m.to > m.from)).toBe(true);
  });
});

describe('fork', () => {
  it('creates a child from a verified checkpoint; the parent is unchanged and the branches diverge', async () => {
    const { engine, reg } = make();
    run(engine, 1200);
    const parentBefore = reg.replay('run_baseline');
    const cp = parentBefore.checkpoints.filter((c) => c.tick <= 1000).pop()!;
    const f1000 = parentBefore.frames.find((f) => f.tick === 1000)!;
    const hash = f1000.hash ?? frameHash(f1000);
    const res = await reg.fork('run_baseline', { fork_tick: 1000, expected_parent_hash: hash, chosen_snapshot_id: cp.snapshot_id });
    expect(res.run.mode).toBe('FORK');
    expect(res.run.parent_run_id).toBe('run_baseline');
    expect(res.run.fork_tick).toBe(1000);
    expect(res.restored_hash).toBe(hash);
    expect(res.parent_hash_before).toBe(res.parent_hash_after);
    expect(res.rng.stream).toBe('new');

    // child continues independently; parent keeps its own course
    const child = reg.get(res.run.run_id);
    expect(child.current_tick).toBe(1000);
    // operator intervenes in the child only
    reg.command(res.run.run_id, { command_id: 'x1', kind: 'test.inject_fault', args: { kind: 'strainer_blockage', target: 'strainer_02' } });
    reg.driveAll(2000); // child advances ~ 24 ticks at ×6
    run(engine, 400); // parent advances too
    const after = reg.replay('run_baseline');
    expect(frameHash(after.frames.find((f) => f.tick === 1000)!)).toBe(hash);
    // parent's recorded frames before the fork are bit-identical to what they were
    for (const f of parentBefore.frames) expect(frameHash(after.frames.find((x) => x.tick === f.tick)!)).toBe(frameHash(f));
    // the child's own ledger holds the operator command, the parent's does not
    expect(reg.replay(res.run.run_id).commands.some((c) => c.command_id === 'x1')).toBe(true);
    expect(after.commands.some((c) => c.command_id === 'x1')).toBe(false);
    // child history before the fork is inherited and read-only
    const cw = reg.replay(res.run.run_id, { start_tick: 0, end_tick: 1000 });
    expect(cw.frames.filter((f) => f.inherited).length).toBeGreaterThan(100);
    // no lease/control state carried: child registry entry has no lease concept; mode is FORK
    expect(reg.list().find((r) => r.run_id === res.run.run_id)!.mode).toBe('FORK');
  });

  it('refuses a stale parent hash, a missing checkpoint, and an unsampled tick', async () => {
    const { engine, reg } = make();
    run(engine, 800);
    const w = reg.replay('run_baseline');
    const cp = w.checkpoints[2];
    const f = w.frames.find((x) => x.tick === 400)!;
    await expect(reg.fork('run_baseline', { fork_tick: 400, expected_parent_hash: 'deadbeef', chosen_snapshot_id: cp.snapshot_id })).rejects.toMatchObject({ code: 'hash_mismatch' });
    await expect(reg.fork('run_baseline', { fork_tick: 400, expected_parent_hash: frameHash(f), chosen_snapshot_id: 'nope' })).rejects.toMatchObject({ code: 'checkpoint_missing' });
    await expect(reg.fork('run_baseline', { fork_tick: 401, expected_parent_hash: 'x', chosen_snapshot_id: cp.snapshot_id })).rejects.toBeInstanceOf(ApiError);
    expect(reg.list().length).toBe(1);
  });

  it('a fork of a scenario run rebuilds the scenario state exactly (operator commands included)', async () => {
    const { reg } = make();
    const spec = { ...defaultScenario(), seed: 5, title: 't', faults: [{ kind: 'fouling', target_id: 'p_17', onset_tick: 60, severity: 0.7, progression_s: 100 }] };
    const r = reg.createScenarioRun(spec);
    reg.driveAll(200_000 / 6); // cap: advance() clamps to 600 steps per call
    for (let i = 0; i < 8; i++) reg.driveAll(10_000);
    const w = reg.replay(r.run_id);
    expect(w.commands.some((c) => c.source === 'scenario' && c.kind === 'test.inject_fault')).toBe(true);
    reg.command(r.run_id, { command_id: 'op', kind: 'pause' });
    reg.command(r.run_id, { command_id: 'op2', kind: 'resume' });
    const cp = w.checkpoints.filter((c) => c.tick > 100).pop()!;
    const f = w.frames.find((x) => x.tick === cp.tick)!;
    const res = await reg.fork(r.run_id, { fork_tick: cp.tick, expected_parent_hash: frameHash(f), chosen_snapshot_id: cp.snapshot_id });
    expect(res.restored_hash).toBe(frameHash(f));
  });

  it('compare reports observed divergence only', async () => {
    const { engine, reg } = make();
    run(engine, 1000);
    const w = reg.replay('run_baseline');
    const cp = w.checkpoints.filter((c) => c.tick <= 800).pop()!;
    const f = w.frames.find((x) => x.tick === 800)!;
    const res = await reg.fork('run_baseline', { fork_tick: 800, expected_parent_hash: f.hash ?? frameHash(f), chosen_snapshot_id: cp.snapshot_id });
    reg.command(res.run.run_id, { command_id: 'h', kind: 'test.inject_fault', args: { kind: 'fouling', target: 'p_12' } });
    for (let i = 0; i < 12; i++) reg.driveAll(10_000);
    run(engine, 800);
    const a = reg.replay('run_baseline', { start_tick: 800 });
    const b = reg.replay(res.run.run_id, { start_tick: 800 });
    const c = compareRuns(reg.get('run_baseline'), a, reg.get(res.run.run_id), b)!;
    expect(c.fromTick).toBe(800);
    expect(c.samples).toBeGreaterThan(10);
    expect(c.paths.length).toBeGreaterThan(0);
  });
});

describe('replay is read-only', () => {
  it('seeking, projecting and showing a replay world never touches the live engine, its recording, or the live store', () => {
    const { engine, reg } = make();
    run(engine, 600);
    const w = reg.replay('run_baseline');
    const tick = engine.tick;
    const nFrames = w.frames.length;
    const live = getLiveWorldState();
    const liveRef = useWorld.getState();
    selectRunWorld(true);
    const p = projectWorld(w.frames, w.events, 200)!;
    showProjected(p.state);
    expect(useRunWorld.getState().simTick).toBe(200);
    expect(useWorld.getState().simTick).toBe(200); // facade follows the selected world...
    expect(getLiveWorldState()).toBe(live); // ...while the live store object is untouched
    selectRunWorld(false);
    expect(useWorld.getState()).toBe(liveRef);
    expect(engine.tick).toBe(tick);
    expect(reg.replay('run_baseline').frames.length).toBe(nFrames);
  });

  it('a stopped run refuses commands: fork to interact', () => {
    const { reg } = make();
    const r = reg.createScenarioRun({ ...defaultScenario() });
    reg.setState(r.run_id, 'stopped');
    expect(() => reg.command(r.run_id, { command_id: 'c', kind: 'pause' })).toThrowError(/Fork it to interact/);
    expect(() => reg.setState('run_baseline', 'stopped')).toThrowError(ApiError);
  });
});

describe('scenario validation', () => {
  const { reg } = make();
  const topo = reg.topology;
  const good = { ...defaultScenario(), title: 'ok' };
  it('accepts a good spec and gives it a stable id', () => {
    const a = validateScenario(good, topo);
    const b = validateScenario({ ...good, title: 'other title' }, topo);
    expect(a.valid).toBe(true);
    expect(a.spec!.scenario_id).toBe(b.spec!.scenario_id);
  });
  it('rejects out-of-range values with units and a fix', () => {
    const v = validateScenario({ ...good, sim_speed: 500, workload_factor: 3, seed: 0, faults: [{ ...good.faults[0], onset_tick: 5, severity: 2, progression_s: -1 }] }, topo);
    expect(v.valid).toBe(false);
    const paths = v.issues.map((i) => i.path);
    for (const p of ['sim_speed', 'workload_factor', 'seed', 'faults[0].onset_tick', 'faults[0].severity', 'faults[0].progression_s']) expect(paths).toContain(p);
    expect(v.issues.every((i) => i.severity !== 'error' || i.message.length > 0)).toBe(true);
  });
  it('rejects unknown targets, wrong target class, planned kinds and too many faults', () => {
    const f = good.faults[0];
    expect(validateScenario({ ...good, faults: [{ ...f, target_id: 'nope_99' }] }, topo).issues[0].message).toMatch(/Unknown target/);
    expect(validateScenario({ ...good, faults: [{ ...f, target_id: 'rack_a1' }] }, topo).valid).toBe(false);
    const leak = validateScenario({ ...good, faults: [{ ...f, kind: 'leak' }] }, topo);
    expect(leak.valid).toBe(false);
    expect(leak.issues[0].message).toMatch(/planned/);
    const many = Array.from({ length: SCENARIO_LIMITS.maxFaults + 1 }, (_, i) => ({ ...f, target_id: i % 2 ? 'p_12' : 'p_17', onset_tick: 100 + i }));
    expect(validateScenario({ ...good, faults: many }, topo).valid).toBe(false);
    expect(validateScenario({ ...good, faults: 'x' }, topo).valid).toBe(false);
    expect(validateScenario(null, topo).valid).toBe(false);
    expect(validateScenario({ ...good, faults: [] }, topo).valid).toBe(false);
  });
  it('text interpretation produces the same typed spec, reports what it could not map, and never invents', () => {
    const v = validateScenarioText('Fouling on P-17 at tick 600, severe. seed 7', topo);
    expect(v.valid).toBe(true);
    expect(v.spec!.faults[0]).toMatchObject({ kind: 'fouling', target_id: 'p_17', onset_tick: 600 });
    expect(v.spec!.seed).toBe(7);
    expect(v.interpreter).toMatchObject({ kind: 'rules', provider: 'mock' });
    const bad = validateScenarioText('make everything explode', topo);
    expect(bad.valid).toBe(false);
    expect(bad.interpreter!.unresolved.length).toBeGreaterThan(0);
    expect(validateScenarioText('x'.repeat(SCENARIO_LIMITS.textMax + 1), topo).valid).toBe(false);
  });
  it('creating a run from an invalid spec is refused and never starts an engine', () => {
    const { reg: r } = make();
    expect(() => r.createScenarioRun({ ...good, sim_speed: 999 })).toThrowError(/validation/);
    expect(r.list().length).toBe(1);
  });
  it('enforces the live-run quota', () => {
    const { reg: r } = make();
    for (let i = 0; i < r.maxLive; i++) r.createScenarioRun({ ...good, seed: i + 1 });
    expect(() => r.createScenarioRun({ ...good, seed: 99 })).toThrowError(/At most/);
    r.dispose();
  });
});
