"""V12 size emergency (agent AA): online thinning of the ACTIVE run, snapshot cadence budget, size guard (80 % warn / 90 % critical / DiskFull),
(run_id, tick) index, versioned snapshot codec and the `--dry-run` CLI. Real PostgreSQL (embedded pgserver, no network, never production): the
split-database topology (primary + telemetry) with >= 2k snapshots of REAL engine payload."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import sys
import zlib
from contextlib import redirect_stdout
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from loopkeeper.storage import maintenance as M  # noqa: E402
from loopkeeper.storage import snapshot_codec as codec  # noqa: E402
from loopkeeper.storage.base import CommitBatch  # noqa: E402

TOPO = json.loads((Path(__file__).parent / "fixtures" / "topology.json").read_text())
DT = 0.5
STEP_TICKS = 120                     # 60 sim-s between interval snapshots (the engine default)
N_REAL = 2200


# ============================================================================================ pure logic
def _rows(n: int, step: int = STEP_TICKS, nbytes: int = 270_000) -> list[M.SnapRow]:
    return [M.SnapRow(f"s{i:05d}", i * step, i * 7, nbytes) for i in range(n)]


def test_select_deletions_bounds_and_idempotence():
    p = M.ThinParams()
    rows = _rows(2500)
    dele, width = M.select_deletions(rows, p, DT)
    gone = {r.snapshot_id for r in dele}
    kept = [r for r in rows if r.snapshot_id not in gone]
    assert [r.snapshot_id for r in kept[-p.keep_newest:]] == [r.snapshot_id for r in rows[-p.keep_newest:]]   # newest N dense and untouched
    assert kept[0] == rows[0]                                                                                   # first always kept
    assert len(kept) <= p.keep_newest + p.max_coarse + 1                                                        # survivors bounded however long the run
    base = round(p.coarse_s / DT)
    assert width % base == 0 and (width // base) & (width // base - 1) == 0                                      # base x 2^k
    again, _ = M.select_deletions(kept, p, DT)
    assert again == []                                                                                          # idempotent


def test_bucket_doubles_with_span_and_survivors_stay_bounded():
    p = M.ThinParams()
    base = round(p.coarse_s / DT)
    assert M.bucket_width(100, DT, p) == base
    for n in (300, 3000, 30000):
        rows = _rows(n)
        dele, _ = M.select_deletions(rows, p, DT)
        assert n - len(dele) <= p.keep_newest + p.max_coarse + 1
    # a 10-sim-minute coarse tier at normal speed: ~1 survivor per 10 sim-min
    rows = _rows(400)
    dele, w = M.select_deletions(rows, M.ThinParams(keep_newest=20, max_coarse=10_000), DT)
    assert w == base == 1200 and (400 - 20 - len(dele)) <= 400 * STEP_TICKS // 1200 + 1


def test_protected_ids_and_ticks_survive_and_neighbours_too():
    p = M.ThinParams()
    rows = _rows(1000)
    base_del, _ = M.select_deletions(rows, p, DT)
    victims = [r for r in base_del][:50]
    pid = victims[0].snapshot_id
    ptick = victims[20].tick + 1                      # between two snapshots: both neighbours must survive
    dele, _ = M.select_deletions(rows, p, DT, protected_ids=[pid], protected_ticks=[ptick])
    gone = {r.snapshot_id for r in dele}
    assert pid not in gone
    lo = max(r for r in rows if r.tick <= ptick)
    hi = min(r for r in rows if r.tick >= ptick)
    assert lo.snapshot_id not in gone and hi.snapshot_id not in gone
    again, _ = M.select_deletions([r for r in rows if r.snapshot_id not in gone], p, DT, protected_ids=[pid], protected_ticks=[ptick])
    assert again == []


def test_snapshot_cadence_policy_byte_budget():
    pol = M.SnapshotPolicy(budget_bytes_per_min=200_000, est_bytes=270_000, guard=None)
    assert pol.wall_gap_s() == pytest.approx(81.0)
    for speed in (1, 6, 60, 420):
        iv = pol.interval_s(60.0, speed)
        snaps_per_wall_min = speed * 60.0 / iv
        assert iv >= 60.0
        assert snaps_per_wall_min * pol.est <= 200_000 * 1.0001 or iv == 60.0
    # old behaviour at 6x: one snapshot per 10 wall s = 6/min * 270 kB = 1.6 MB/min; now <= 200 kB/min
    assert 6 * 60.0 / pol.interval_s(60.0, 6) * 270_000 <= 200_000 * 1.0001
    pol.observe(540_000)
    assert pol.est > 270_000                         # adapts to measured size
    g = M.SizeGuard("postgresql://x/a", size_fn=lambda u: 0, maintain_fn=lambda *a: {})
    pol2 = M.SnapshotPolicy(budget_bytes_per_min=200_000, est_bytes=270_000, guard=g)
    base = pol2.interval_s(60.0, 6)
    g.level = g.CRITICAL
    assert pol2.interval_s(60.0, 6) == pytest.approx(4 * base)
    g.emergency = True
    assert pol2.interval_s(60.0, 6) == pytest.approx(8 * base)


def test_snapshot_codec_versioned_roundtrip():
    canon = json.dumps({"tick": 5, "plant": "x" * 5000}, sort_keys=True).encode()
    legacy = codec.encode_state(canon, "zlib")
    assert legacy == zlib.compress(canon, 3)                       # byte-identical to what core.py writes today (old readers keep working)
    new = codec.encode_state(canon, "lzma")
    assert new[:3] == b"LKS" and codec.decode_state(new) == canon and codec.decode_state(legacy) == canon
    assert codec.decode_state(memoryview(new)) == canon
    assert hashlib.sha256(codec.decode_state(new)).hexdigest() == hashlib.sha256(canon).hexdigest()   # content_hash unaffected by the codec
    with pytest.raises(ValueError):
        codec.decode_state(b"LKS\x09junk")


# ============================================================================================ guard thresholds / write shaping (fake sizes)
def _guard(sizes: dict[str, int], **kw) -> M.SizeGuard:
    calls: list[str] = []
    g = M.SizeGuard("postgresql://p/p", "postgresql://t/t", cap_bytes=1000, size_fn=lambda u: sizes["p" if u.endswith("/p") else "t"],
                    maintain_fn=lambda p, t, lvl: calls.append(lvl) or {"level": lvl, "deleted_snapshots": 0}, **kw)
    g.calls = calls                                                # type: ignore[attr-defined]
    return g


def test_size_guard_thresholds_hysteresis_and_logging(caplog):
    sizes = {"p": 200, "t": 589}                                   # 78.9 % of the cap, both databases summed
    g = _guard(sizes)
    caplog.set_level(logging.INFO, logger="loopkeeper.storage.maintenance")
    assert g.check()["level"] == "ok" and g.sample_stride() == 1
    sizes["t"] = 600                                               # 80.0 %: warn, logged, visible in status (/health/detail)
    st = g.check()
    assert st["level"] == "warn" and st["used_pct"] == 80.0 and st["sizes_bytes"] == {"primary": 200, "telemetry": 600}
    assert any(r.levelno == logging.WARNING and "80.0%" in r.getMessage() for r in caplog.records)
    assert g.sample_stride() == 1 and g.interval_multiplier() == 2.0
    sizes["t"] = 699                                               # 89.9 %: still warn
    assert g.check()["level"] == "warn"
    sizes["t"] = 700                                               # 90.0 %: critical -> decimation + aggressive maintenance
    st = g.check()
    assert st["level"] == "critical" and g.sample_stride() == 4 and g.interval_multiplier() == 4.0
    assert g.calls[-1] == "critical" and any(r.levelno == logging.ERROR and "CRITICAL" in r.getMessage() for r in caplog.records)
    sizes["t"] = 690                                               # 89.0 %: hysteresis keeps critical (no flapping) ...
    assert g.check()["level"] == "critical"
    sizes["t"] = 679                                               # ... until 2 points below the threshold
    assert g.check()["level"] == "warn"
    sizes["t"] = 400
    assert g.check()["level"] == "ok" and g.sample_stride() == 1
    assert g.calls[-1] == "ok"                                     # normal thinning keeps running at every level, including ok


def test_size_guard_each_scope_and_single_database():
    g = _guard({"p": 850, "t": 100}, cap_scope="each")
    assert g.check()["level"] == "warn"                            # per-database scope: only the biggest counts
    g2 = M.SizeGuard("postgresql://same/x", "postgresql://same/x", cap_bytes=1000, size_fn=lambda u: 450, maintain_fn=lambda *a: {})
    st = g2.check()
    assert st["sizes_bytes"] == {"primary": 450} and st["level"] == "ok"      # one URL is counted once
    g3 = M.SizeGuard("postgresql://a/a", size_fn=lambda u: (_ for _ in ()).throw(OSError("down")), maintain_fn=lambda *a: {})
    assert g3.check()["last_error"].startswith("size read failed")          # a failing read never raises into the engine


def _batch(n_samples=40, ticks=10, reasons=("interval",), events=3) -> CommitBatch:
    samples = [{"tick": 10 * (i % ticks), "sim_time_s": 5.0 * (i % ticks), "sensor_id": f"a{i}", "metric": "t", "value": 1.0} for i in range(n_samples)]
    snaps = [{"snapshot_id": f"x{i}", "tick": i, "last_seq": i, "reason": r} for i, r in enumerate(reasons)]
    evs = [{"seq": i + 1, "kind": "x"} for i in range(events)]
    return CommitBatch(run_id="r", facility_id="f", events=evs, sensor_samples=samples, snapshots=snaps)


def test_shape_decimates_samples_and_sheds_interval_snapshots_only_when_critical():
    g = _guard({"p": 0, "t": 0})
    b = _batch(40, reasons=("interval", "incident", "interval"))
    assert g.shape(b).sensor_samples == b.sensor_samples and len(g.shape(b).snapshots) == 3     # ok: untouched
    g.level = g.CRITICAL
    out = g.shape(_batch(400, ticks=100, reasons=("interval",) * 8 + ("incident",)))
    assert 80 <= len(out.sensor_samples) <= 120                    # ~1 group in 4 kept
    assert len(out.events) == 3                                    # events (the ledger) are never decimated
    reasons = [s["reason"] for s in out.snapshots]
    assert "incident" in reasons and reasons.count("interval") == 2                      # 8 interval -> 2 (1 in 4); the incident checkpoint kept
    g.emergency = True
    out = g.shape(_batch(40, reasons=("interval", "shutdown")))
    assert out.sensor_samples == [] and [s["reason"] for s in out.snapshots] == ["shutdown"]


def _disk_full():
    import psycopg
    return psycopg.errors.DiskFull("could not extend file")


def test_disk_full_never_raises_parks_essential_rows_and_replays_them():
    g = _guard({"p": 0, "t": 0}, retry_hold_s=0.0)
    seen: list[CommitBatch] = []
    state = {"full": True}

    def do_commit(b):
        seen.append(b)
        if state["full"]:
            raise _disk_full()

    b1 = _batch(20, reasons=("interval", "incident"))
    g.commit_telemetry(b1, do_commit)                              # full DB: no exception -> physics goes on
    assert g.emergency and g.counters["disk_full"] >= 1
    assert len(seen) == 2 and seen[0].sensor_samples is not None
    assert seen[1].sensor_samples == [] and [s["reason"] for s in seen[1].snapshots] == ["incident"]    # retried with the ESSENTIAL rows only
    st = g.status()
    assert st["level"] == "emergency" and st["spool_events"] == 3 and st["sample_stride"] == 0

    seen.clear()
    b2 = CommitBatch(run_id="r", facility_id="f", events=[{"seq": 10, "kind": "y"}], sensor_samples=[{"tick": 1, "sim_time_s": 1.0, "sensor_id": "a", "metric": "m", "value": 1.0}])
    g._emergency_until = 0.0                                       # (the 60 s emergency window elapses)
    state["full"] = False
    g.commit_telemetry(b2, do_commit)                              # space is back: the parked events ride along (ON CONFLICT DO NOTHING makes replay safe)
    assert [e["seq"] for e in seen[-1].events] == [1, 2, 3, 10] and seen[-1].sensor_samples == []   # still decimated: emergency shaping applied this call
    assert not g.emergency and g.status()["spool_events"] == 0
    g.commit_telemetry(b2, do_commit)
    assert len(seen[-1].sensor_samples) == 1                      # normal operation resumed


def test_disk_full_hold_does_not_hammer_database_and_other_errors_propagate_without_losing_spool():
    g = _guard({"p": 0, "t": 0}, retry_hold_s=60.0)
    calls = {"n": 0}

    def full(b):
        calls["n"] += 1
        raise _disk_full()

    g.commit_telemetry(_batch(5), full)
    first = calls["n"]
    for _ in range(5):
        g.commit_telemetry(_batch(5, events=1), full)              # inside the hold window: parked without touching the database
    assert calls["n"] == first and g.status()["spool_events"] >= 3

    g2 = _guard({"p": 0, "t": 0})
    g2._park(_batch(5))
    n_before = g2.status()["spool_events"]

    def boom(b):
        raise RuntimeError("fk")

    with pytest.raises(RuntimeError):
        g2.commit_telemetry(_batch(5, events=1), boom)             # a non-DiskFull failure (K's FK heal path) propagates unchanged ...
    assert g2.status()["spool_events"] == n_before                 # ... and the parked rows are put back

    g3 = _guard({"p": 0, "t": 0}, spool_max_events=5, retry_hold_s=0.0)
    for _ in range(4):
        g3.commit_telemetry(_batch(0, events=3), full)
    st = g3.status()
    assert st["spool_events"] <= 5 and st["counters"]["events_dropped"] > 0     # bounded memory, drops are counted (honest ledger-gap signal)


def test_is_disk_full_detection():
    import psycopg
    assert M.is_disk_full(psycopg.errors.DiskFull("x"))
    assert M.is_disk_full(RuntimeError("could not extend file because project size limit (1 GB) has been exceeded"))
    assert not M.is_disk_full(psycopg.errors.ForeignKeyViolation("x"))


# ============================================================================================ embedded Postgres
@pytest.fixture(scope="module")
def pg(tmp_path_factory):
    pgserver = pytest.importorskip("pgserver")
    import psycopg
    try:
        srv = pgserver.get_server(str(tmp_path_factory.mktemp("ret_pg")))
    except Exception as e:                                         # noqa: BLE001
        pytest.skip(f"embedded postgres unavailable: {type(e).__name__}")
    base = srv.get_uri()
    with psycopg.connect(base, autocommit=True) as c:
        c.execute("CREATE DATABASE telem")
    telem = base.replace("/postgres?", "/telem?") if "/postgres?" in base else base.rsplit("/", 1)[0] + "/telem"
    assert telem != base
    from loopkeeper.storage.postgres import PostgresStorage
    st = PostgresStorage(base, telemetry_url=telem)
    st.migrate()
    st.register_facility("lab_01", "c1", "th1", TOPO)
    yield {"st": st, "primary": base, "telemetry": telem}
    st.close()


def _run_row(run_id: str, **kw) -> dict:
    return {"run_id": run_id, "facility_id": "lab_01", "config_version": "c1", "topology_hash": "th1", "seed": 1, "rng_stream": "main", "kind": "scenario",
            "phase": "running", "engine_version": "1.0", "schema_version": 1, "sim_speed": 6, "dt_s": DT, **kw}


@pytest.fixture(scope="module")
def real_payload():
    """ONE real snapshot payload (state blob + world + rng) from a live in-process engine; every seeded row carries it (volume realism)."""
    sys.path[:0] = [str(Path(__file__).parent / "agents"), str(Path(__file__).parents[1])]
    from loopkeeper.engine import create_engine
    from loopkeeper.physics import FacilityPlant
    from loopkeeper.physics.config import load_config
    from loopkeeper.storage.memory import MemoryStorage

    async def go():
        e = create_engine(plant=FacilityPlant(3, config=load_config(overrides={"physics": {"faults": {"enabled": False}}})), run_id="m", seed=3, storage=MemoryStorage())
        await e.step_ticks(200)
        return e.take_snapshot("interval")

    row = asyncio.run(go())
    assert len(row["state"]) > 10_000 and len(json.dumps(row["world"])) > 20_000
    return row


def _small_payload():
    canon = json.dumps({"tick": 1, "x": "y" * 400}, sort_keys=True).encode()
    return {"state": zlib.compress(canon, 3), "world": {"sim_time_s": 1.0, "assets": {}, "robots": {}, "kpis": {}, "incidents": [], "missions": []},
            "rng_state": {"engine": [3, [1, 2], None]}, "content_hash": hashlib.sha256(canon).hexdigest()}


def _seed(pg, run_id: str, n: int, payload: dict, *, extra: dict[int, str] | None = None, run_kw: dict | None = None) -> None:
    """n interval snapshots 120 ticks apart (+ `extra` index->reason rows at the same index, e.g. incident checkpoints)."""
    import psycopg
    from psycopg.types.json import Jsonb
    pg["st"].create_run(_run_row(run_id, **(run_kw or {})))
    rows = []
    for i in range(n):
        reason = (extra or {}).get(i, "interval")
        rows.append((f"{run_id}-s{i:05d}", run_id, "lab_01", i * STEP_TICKS, i * 7 + (1 if reason != "interval" else 0), reason, payload["state"],
                     Jsonb(payload["world"]), Jsonb(payload["rng_state"]), 1, "1.0", payload["content_hash"],
                     "w", "s"))
    with psycopg.connect(pg["telemetry"], autocommit=True) as c:
        with c.cursor() as cur:
            cur.executemany("INSERT INTO world_snapshots (snapshot_id, run_id, facility_id, tick, last_seq, reason, state, world, rng_state, schema_version, "
                            "engine_version, content_hash, world_hash, state_hash) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)", rows)
        c.execute("ANALYZE world_snapshots")


def _conns(pg):
    import psycopg
    return psycopg.connect(pg["primary"], autocommit=True), psycopg.connect(pg["telemetry"], autocommit=True)


def _count(tc, run_id, where="TRUE", *a):
    return tc.execute(f"SELECT count(*) FROM world_snapshots WHERE run_id=%s AND {where}", (run_id, *a)).fetchone()[0]


@pytest.fixture(scope="module")
def live(pg, real_payload):
    """run_live-like: 2200 interval snapshots of real payload + incident / fault / shutdown checkpoints + a fork + a verified contract + events."""
    run = "run_live_t"
    extra = {300: "incident", 301: "incident", 900: "fault", 1500: "incident", N_REAL - 1: "shutdown"}
    _seed(pg, run, N_REAL, real_payload, extra=extra)
    st = pg["st"]
    pc, tc = _conns(pg)
    # fork child whose source snapshot is an interval snapshot that thinning would delete otherwise
    plan0 = M.plan_all(tc, pc, M.ThinParams.normal(), [run])[0]
    victims = [r for r in plan0.delete]
    fork_src = victims[10]
    st.fork_run({"run_id": "fork_a", "parent_run_id": run, "fork_tick": fork_src.tick, "facility_id": "lab_01", "config_version": "c1", "topology_hash": "th1",
                 "scenario_id": None, "seed": 1, "rng_stream": "fork", "label": "t", "phase": "paused", "engine_version": "1.0", "schema_version": 1,
                 "sim_speed": 6, "dt_s": DT, "meta": {"fork_snapshot_id": fork_src.snapshot_id}},
                {"snapshot_id": "fork_a-origin", "tick": fork_src.tick, "last_seq": 1, "state": real_payload["state"], "world": real_payload["world"],
                 "rng_state": real_payload["rng_state"], "schema_version": 1, "engine_version": "1.0", "content_hash": "c", "world_hash": "w", "state_hash": "s"})
    # verified contract frozen between two snapshots, both of which would be deleted
    frozen = victims[40].tick + 7
    with pc.transaction():
        pc.execute("INSERT INTO incidents (run_id, incident_id, opened_tick, updated_tick, severity, status, doc) VALUES (%s,'INC-1',1,1,'high','resolved','{}')", (run,))
        pc.execute("INSERT INTO done_contracts (run_id, contract_id, incident_id, version, state, terminal_state, frozen_hash, frozen_tick, updated_tick, doc) "
                   "VALUES (%s,'dc1','INC-1',1,'VERIFIED','VERIFIED','h',%s,%s,'{}')", (run, frozen, frozen + 50))
    # events (append-only ledger) for replay
    evs = [{"seq": i + 1, "event_id": f"e{i}", "facility_id": "lab_01", "tick": i * 12, "sim_time_s": i * 6.0, "world_version": i, "kind": "incident.updated",
            "entity_id": "x", "actor_type": "system", "actor_id": None, "payload": {"i": i}, "causal_parent_id": None, "command_id": None,
            "ts": "2026-10-17T00:00:00.000Z", "schema_version": 1, "event_hash": f"h{i}"} for i in range(0, 4000, 5)]
    st.commit(CommitBatch(run_id=run, facility_id="lab_01", events=evs))
    pc.close()
    tc.close()
    return {"run": run, "fork_src": fork_src, "frozen": frozen, "n_events": len(evs), "victims": victims}


def test_volume_and_reason_mix(pg, live):
    pc, tc = _conns(pg)
    assert _count(tc, live["run"]) == N_REAL
    assert _count(tc, live["run"], "reason <> 'interval'") == 5
    sz = tc.execute("SELECT sum(pg_column_size(state) + pg_column_size(world) + pg_column_size(rng_state)) FROM world_snapshots WHERE run_id=%s", (live["run"],)).fetchone()[0]
    assert sz > 40_000 * N_REAL * 0.5                              # tens of MB of real payload, not toy rows


def test_dry_run_plan_changes_nothing_and_estimates_bytes(pg, live):
    pc, tc = _conns(pg)
    before = _count(tc, live["run"])
    plan = M.plan_all(tc, pc, M.ThinParams.normal(), [live["run"]])[0]
    assert plan.error is None and len(plan.delete) > 1500 and plan.delete_bytes > 1500 * 20_000
    assert _count(tc, live["run"]) == before
    assert plan.kept <= 60 + 120 + 1 + 2 + 4                       # newest 60 + <=120 coarse + first + protected extras
    assert plan.protected_forks == 1 and plan.protected_ticks >= 2


def test_thinning_keeps_checkpoints_forks_contracts_and_is_idempotent(pg, live):
    run = live["run"]
    pc, tc = _conns(pg)
    non_int = sorted(r[0] for r in tc.execute("SELECT snapshot_id FROM world_snapshots WHERE run_id=%s AND reason <> 'interval'", (run,)).fetchall())
    newest = [r[0] for r in tc.execute("SELECT snapshot_id FROM world_snapshots WHERE run_id=%s AND reason='interval' ORDER BY tick DESC LIMIT 60", (run,)).fetchall()]
    ev_before = tc.execute("SELECT count(*) FROM world_events WHERE run_id=%s", (run,)).fetchone()[0]
    assert ev_before == live["n_events"]

    out = M.run_maintenance(pg["primary"], pg["telemetry"], "ok")
    assert out["deleted_snapshots"] > 1500 and out["deleted_bytes_est"] > 0 and "error" not in out

    assert sorted(r[0] for r in tc.execute("SELECT snapshot_id FROM world_snapshots WHERE run_id=%s AND reason <> 'interval'", (run,)).fetchall()) == non_int   # incident / fault / shutdown
    assert _count(tc, "fork_a", "reason='fork_origin'") == 1
    left = {r[0] for r in tc.execute("SELECT snapshot_id FROM world_snapshots WHERE run_id=%s", (run,)).fetchall()}
    assert set(newest) <= left                                                                                       # dense window intact
    assert live["fork_src"].snapshot_id in left                                                                      # fork source (meta.fork_snapshot_id) kept
    frozen = live["frozen"]
    ticks = sorted(r[0] for r in tc.execute("SELECT tick FROM world_snapshots WHERE run_id=%s", (run,)).fetchall())
    assert any(t <= frozen for t in ticks) and any(t >= frozen for t in ticks)
    assert max(t for t in ticks if t <= frozen) > frozen - STEP_TICKS and min(t for t in ticks if t >= frozen) < frozen + STEP_TICKS   # both neighbours of the verified tick
    assert len(ticks) <= 60 + 120 + 1 + 5 + 4
    assert tc.execute("SELECT count(*) FROM world_events WHERE run_id=%s", (run,)).fetchone()[0] == ev_before          # append-only ledger untouched

    again = M.run_maintenance(pg["primary"], pg["telemetry"], "ok")
    assert again["deleted_snapshots"] == 0                                                                           # idempotent
    # the live run keeps writing: new interval snapshots slide the window, the next cycle thins only the ones that left it
    import psycopg
    from psycopg.types.json import Jsonb
    p = _small_payload()
    with tc.cursor() as cur:
        cur.executemany("INSERT INTO world_snapshots (snapshot_id, run_id, facility_id, tick, last_seq, reason, state, world, rng_state, schema_version, "
                        "engine_version, content_hash, world_hash, state_hash) VALUES (%s,%s,'lab_01',%s,%s,'interval',%s,%s,%s,1,'1.0','c','w','s')",
                        [(f"new{i}", run, (N_REAL + i) * STEP_TICKS, (N_REAL + i) * 7, p["state"], Jsonb(p["world"]), Jsonb(p["rng_state"])) for i in range(30)])
    slide = M.run_maintenance(pg["primary"], pg["telemetry"], "ok")
    assert 0 < slide["deleted_snapshots"] <= 30
    assert M.run_maintenance(pg["primary"], pg["telemetry"], "ok")["deleted_snapshots"] == 0
    # cleanup for the replay test below: remove the 30 synthetic rows (they are tiny and out of the replayed range)
    tc.execute("DELETE FROM world_snapshots WHERE snapshot_id LIKE 'new%'")


def test_replay_seek_and_restore_still_work_after_thinning(pg, live, real_payload):
    """Existing replay code paths (PostgresStorage.replay_snapshot_window / latest_snapshot / get_snapshot_replay_worlds / replay_events)."""
    st, run = pg["st"], live["run"]
    hi_tick = (N_REAL - 1) * STEP_TICKS
    win = st.replay_snapshot_window(run, 0, hi_tick, 240)
    assert 0 < len(win["frames"]) <= 240 and win["first_tick"] == 0
    assert win["frames"][0]["tick"] == 0 and win["frames"][-1]["tick"] <= hi_tick
    # seek into the middle: the base is the newest snapshot before the window, no further away than the coarse bucket (events fill the gap)
    lo = 1_000 * STEP_TICKS + 17
    mid = st.replay_snapshot_window(run, lo, lo + 5_000, 240)
    assert mid["base"] is not None and mid["base"]["tick"] < lo
    assert lo - mid["base"]["tick"] <= 4 * 1200 * 2                                                 # <= a few coarse buckets (1200 ticks = 10 sim-min each)
    for t in (50, 123_456, 200_000, hi_tick - 1):
        s = st.latest_snapshot(run, max_tick=t)
        assert s is not None and s["tick"] <= t
    ids = [f["snapshot_id"] for f in win["frames"]][:40]
    worlds = st.get_snapshot_replay_worlds(run, ids)
    assert set(worlds) == set(ids) and all("assets" in w or "kpis" in w or "robots" in w for w in worlds.values())
    ev = st.replay_events(run, 0, 4000 * 12, limit=5000)
    assert len(ev) == live["n_events"]
    # a surviving snapshot restores: container decodes, hash matches, JSON parses (what core.py / runs_storage.fork do)
    full = st.get_snapshot(run, live["fork_src"].snapshot_id)
    assert full is not None
    raw = codec.decode_state(full["state"])
    assert hashlib.sha256(raw).hexdigest() == full["content_hash"]
    assert json.loads(raw)["tick"] == json.loads(codec.decode_state(real_payload["state"]))["tick"]


def test_critical_guard_end_to_end_aggressive_thinning(pg, real_payload):
    run = "run_crit_t"
    _seed(pg, run, 2100, _small_payload(), extra={500: "incident"})
    pc, tc = _conns(pg)
    sizes = {k: M.read_size(pg[k]) for k in ("primary", "telemetry")}
    cap = int((sum(sizes.values())) / 0.93)                        # real sizes read from the embedded databases -> 93 % of this cap
    g = M.SizeGuard(pg["primary"], pg["telemetry"], cap_bytes=cap)
    st = g.check()
    assert st["level"] == "critical" and st["used_pct"] == pytest.approx(93.0, abs=0.2)
    assert st["last_maintenance"]["deleted_snapshots"] > 1900
    left = _count(tc, run)
    assert left <= 12 + 40 + 1 + 1 + 4 and _count(tc, run, "reason='incident'") == 1
    assert g.check()["last_maintenance"]["deleted_snapshots"] == 0  # idempotent under critical as well
    # status is JSON-safe and carries no connection string
    blob = json.dumps(st)
    assert "postgresql://" not in blob


def test_guard_commit_telemetry_through_real_storage(pg):
    st = pg["st"]
    run = "run_shape_t"
    st.create_run(_run_row(run))
    g = M.SizeGuard(pg["primary"], pg["telemetry"], cap_bytes=10**12, size_fn=lambda u: 0, maintain_fn=lambda *a: {})
    g.level = g.CRITICAL
    samples = [{"tick": 10 * (i // 5), "sim_time_s": 5.0 * (i // 5), "sensor_id": f"a{i % 5}", "metric": "t", "value": float(i)} for i in range(400)]
    b = CommitBatch(run_id=run, facility_id="lab_01", sensor_samples=samples)
    g.commit_telemetry(b, st._commit_telemetry)
    with st.telemetry_pool.connection() as c:
        n = c.execute("SELECT count(*) AS n FROM sensor_samples WHERE run_id=%s", (run,)).fetchone()["n"]
    assert 70 <= n <= 130                                          # ~1 in 4 of 400 written, the rest never reached the database
    g.level = g.OK
    g.commit_telemetry(CommitBatch(run_id=run, facility_id="lab_01", sensor_samples=samples[:10]), st._commit_telemetry)
    with st.telemetry_pool.connection() as c:
        assert c.execute("SELECT count(*) AS n FROM sensor_samples WHERE run_id=%s", (run,)).fetchone()["n"] == n + 10


def test_prune_index_migration_and_range_scan(pg):
    import psycopg
    pc, tc = _conns(pg)
    for c in (pc, tc):
        assert c.execute("SELECT 1 FROM pg_indexes WHERE indexname=%s", (M.PRUNE_INDEX,)).fetchone()          # migration 0012 applied on both planes
    run = "run_samples_t"
    pg["st"].create_run(_run_row(run))
    pg["st"].create_run(_run_row(run + "2"))
    with tc.cursor() as cur:
        cur.executemany("INSERT INTO sensor_samples (run_id, tick, sim_time_s, sensor_id, metric, value) VALUES (%s,%s,%s,%s,'t',1.0)",
                        [(r, t, t * 0.5, f"s{k}") for r in (run, run + "2") for t in range(0, 6000, 2) for k in range(8)])
    tc.execute("ANALYZE sensor_samples")
    plan = "\n".join(r[0] for r in tc.execute("EXPLAIN DELETE FROM sensor_samples WHERE run_id=%s AND tick < 100", (run,)).fetchall())
    assert M.PRUNE_INDEX in plan or "sensor_samples_idx" in plan and "Seq Scan" not in plan, plan
    # ensure_prune_index recreates it (what the guard does when the migration skipped it near the cap) and is a no-op afterwards
    tc.execute(f"DROP INDEX {M.PRUNE_INDEX}")
    assert M.ensure_prune_index(tc) is True and M.ensure_prune_index(tc) is False
    est = M.sensor_estimate(tc, run, 3600)
    assert est["old_rows"] == len([1 for t in range(0, 6000, 2) for k in range(8) if t < 5998 - 3600]) and est["est_bytes"] > 0
    assert M.sensor_prune(tc, run, 3600) == est["old_rows"] and M.sensor_prune(tc, run, 3600) == 0


def _run_cli(argv, monkeypatch, pg):
    for k, v in (("DATABASE_URL", pg["primary"]), ("DATABASE_URL_UNPOOLED", pg["primary"]),          # every variant points at the scratch DBs: never production
                 ("TELEMETRY_DATABASE_URL", pg["telemetry"]), ("TELEMETRY_DATABASE_URL_UNPOOLED", pg["telemetry"])):
        monkeypatch.setenv(k, v)
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = M.main(argv + ["--env", "/nonexistent/.env"])
    assert rc == 0
    return buf.getvalue()


def test_cli_dry_run_prints_plan_with_bytes_and_changes_nothing(pg, monkeypatch):
    run = "run_cli_t"
    _seed(pg, run, 800, _small_payload(), extra={100: "incident"})
    pc, tc = _conns(pg)
    before = _count(tc, run)
    out = _run_cli(["--dry-run", "--run", run], monkeypatch, pg)
    assert "DRY-RUN" in out and "nothing is changed" in out
    assert f"{run}: 800 snapshots" in out and "would delete" in out and "APPEND-ONLY" in out and "of the 1 GiB cap" in out
    assert "sensor_samples" in out and "world_events" in out and "VACUUM FULL" in out
    assert pg["primary"] not in out and pg["telemetry"] not in out and "postgresql://" not in out         # no connection strings
    assert _count(tc, run) == before                                                                     # dry-run is read-only
    default = _run_cli(["--run", run], monkeypatch, pg)                                                  # no flag at all == dry-run
    assert "DRY-RUN" in default and _count(tc, run) == before
    out = _run_cli(["--apply", "--run", run], monkeypatch, pg)
    assert "applied: deleted" in out and _count(tc, run) < before and _count(tc, run, "reason='incident'") == 1
    assert _count(tc, run) <= 60 + 120 + 1 + 1
    again = _run_cli(["--dry-run", "--run", run], monkeypatch, pg)
    assert "would delete 0 interval snapshots" in again                                                  # idempotent


def test_cli_survives_unreachable_database_and_falls_back_to_next_url(pg, monkeypatch):
    bad = "postgresql://nobody:password@127.0.0.1:1/none?connect_timeout=2"
    # direct URL dead, pooled alive: dry-run prefers pooled and works
    for k, v in (("DATABASE_URL", pg["primary"]), ("DATABASE_URL_UNPOOLED", bad), ("TELEMETRY_DATABASE_URL", pg["telemetry"]), ("TELEMETRY_DATABASE_URL_UNPOOLED", bad)):
        monkeypatch.setenv(k, v)
    buf = io.StringIO()
    with redirect_stdout(buf):
        assert M.main(["--dry-run", "--run", "run_live_t", "--env", "/nonexistent/.env"]) == 0
    assert "cannot connect" not in buf.getvalue() and "run_live_t:" in buf.getvalue()
    # telemetry completely unreachable: one clean line, primary figures still printed, rc 0, no secrets
    for k, v in (("TELEMETRY_DATABASE_URL", bad), ("TELEMETRY_DATABASE_URL_UNPOOLED", bad)):
        monkeypatch.setenv(k, v)
    buf = io.StringIO()
    with redirect_stdout(buf):
        assert M.main(["--dry-run", "--env", "/nonexistent/.env"]) == 0
    out = buf.getvalue()
    assert out.count("telemetry: cannot connect") == 1 and "telemetry unreachable" in out and "primary:" in out and "PARTIAL" in out
    assert "secret-pw" not in out and "postgresql://" not in out and "LangGraph checkpoints" in out
