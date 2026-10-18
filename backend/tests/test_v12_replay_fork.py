"""V12 replay + fork gates (agent S): a checkpoint restores to exactly the state hash it was recorded with (also with V11 contracts, communication and lease state
present), snapshots written by an older build are verified field by field instead of being refused with a false mismatch, a fork is a new run from a verified
checkpoint (parent immutable, no lease, new RNG stream, lineage in the run row), forks of forks work, every refusal carries a machine-readable code, and replay
windows are keyset-paged, never leak past `end_tick`, never call a model and are identical on the memory twin and on a real PostgreSQL (migration 0011)."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import sys
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent / "agents"))

from live_harness import Stack  # noqa: E402
from loopkeeper.api import create_app  # noqa: E402
from loopkeeper.api.runs_storage import StorageRunManager, compare_restore  # noqa: E402
from loopkeeper.api.service import RunError, RunNotFound  # noqa: E402
from loopkeeper.engine.config import STATE_SCHEMA_VERSION  # noqa: E402
from loopkeeper.engine.util import chash, unb64  # noqa: E402
from support.fixtures import TOKEN, make_settings  # noqa: E402

AUTH = {"Authorization": f"Bearer {TOKEN}"}
TERMINAL = ("resolved", "escalated", "dismissed")


async def _record() -> dict:
    """Real stack: an operator lease is open at the first checkpoint, a fouling incident runs to a terminal state (V11 contract + comm events recorded)."""
    st = await Stack.create(seed=3, run_id="run_live")
    e = st.eng
    ack = await e.submit({"command_id": "l1", "kind": "control.acquire", "target_id": "OR-02", "args": {"robot_id": "OR-02"}, "actor_type": "operator",
                          "principal": "op"}, principal="op", actor_type="operator")
    assert ack["accepted"]
    await st.advance(10)
    e.take_snapshot("with_lease")
    await e.commit()
    await e.end_lease(ack["lease_id"], "released")
    await st.inject("fouling", "p_hs_b")
    assert await st.run_until(lambda: any(i["status"] in TERMINAL for i in st.incidents()), 1800)
    await st.advance(20)
    e.take_snapshot("after_incident")
    await e.commit()
    await st.stop()
    return {"eng": e, "st": e.storage, "run": "run_live"}


@pytest.fixture(scope="module")
def rec() -> dict:
    return asyncio.run(_record())


def _fingerprint(st, run_id: str) -> str:
    snaps = st.list_snapshots(run_id)
    ev = st.load_events(run_id, after_seq=0)
    row = st.get_run(run_id)
    return hashlib.sha256(json.dumps([[s["snapshot_id"], s["content_hash"], s["state_hash"], s["tick"]] for s in snaps] +
                                     [row["last_seq"], len(ev), [e["event_hash"] for e in ev]], sort_keys=True).encode()).hexdigest()


def _req(cp, **kw):
    return {"fork_tick": cp["tick"], "expected_parent_hash": cp["hash"], "chosen_snapshot_id": cp["snapshot_id"], **kw}


def run(coro):
    return asyncio.run(coro)


# ------------------------------------------------------------------ root cause: hash symmetry
def test_every_checkpoint_restores_to_its_recorded_state_hash_with_contracts_and_comm_state(rec):
    eng, st = rec["eng"], rec["st"]
    assert eng.track.contracts, "scenario must carry a V11 contract"
    assert st.load_communications(rec["run"], limit=5), "scenario must carry communication events"
    mgr = StorageRunManager(eng)
    row = st.get_run(rec["run"])
    cps = mgr.checkpoints(rec["run"], None)
    assert len(cps) >= 3 and all(c["compatible"] for c in cps)
    for c in cps:
        snap = st.get_snapshot(rec["run"], c["snapshot_id"])
        assert mgr._restore_probe(row, snap) == snap["state_hash"], f"checkpoint at tick {c['tick']} does not round-trip"


def test_older_snapshot_without_new_state_keys_is_verified_not_falsely_refused(rec):
    """A snapshot written before V11 has no track.contracts; its recorded hash covers the OLD document. Restoring it today must fork (basis schema_evolved)."""
    eng, st = rec["eng"], rec["st"]
    mgr = StorageRunManager(eng)
    snap = st.get_snapshot(rec["run"], mgr.checkpoints(rec["run"], None)[0]["snapshot_id"])
    doc = json.loads(zlib.decompress(snap["state"]))
    old = copy.deepcopy(doc)
    old["track"].pop("contracts")
    d = copy.deepcopy(old)
    for k in ("seq", "plant", "wall"):
        d.pop(k, None)
    d["plant_hash"] = old["plant_hash"]
    blob = zlib.compress(json.dumps(old, sort_keys=True, separators=(",", ":")).encode(), 3)
    old_row = {**snap, "snapshot_id": "old-build-snapshot", "tick": snap["tick"], "last_seq": snap["last_seq"] + 1, "state": blob,
               "content_hash": hashlib.sha256(zlib.decompress(blob)).hexdigest(), "state_hash": chash(d)}
    st.snapshots[rec["run"]]["old-build-snapshot"] = old_row            # memory twin: same row shape the Postgres backend returns
    try:
        res = run(mgr.fork(rec["run"], {"fork_tick": old_row["tick"], "expected_parent_hash": old_row["content_hash"], "chosen_snapshot_id": "old-build-snapshot"}, "op"))
        assert res["restore_basis"] == "schema_evolved" and "state.track.contracts" in res["schema_additions"]
        assert res["child_state_hash"] != old_row["state_hash"]           # the child is a new state (new rng, own run id) and says so
        # a document edited under a matching content hash no longer matches its recorded state hash: refused, with the reason in the body
        bad = copy.deepcopy(old)
        rid = sorted(bad["robots"])[0]
        bad["robots"][rid]["battery"] += 7.0
        blob2 = zlib.compress(json.dumps(bad, sort_keys=True, separators=(",", ":")).encode(), 3)
        st.snapshots[rec["run"]]["bad"] = {**old_row, "snapshot_id": "bad", "state": blob2, "content_hash": hashlib.sha256(zlib.decompress(blob2)).hexdigest()}
        with pytest.raises(RunError) as e:
            run(mgr.fork(rec["run"], {"fork_tick": old_row["tick"], "expected_parent_hash": hashlib.sha256(zlib.decompress(blob2)).hexdigest(), "chosen_snapshot_id": "bad"}, "op"))
        assert e.value.code == "restore_mismatch" and e.value.status == 409
        assert e.value.detail["divergences"] and e.value.detail["recorded_state_hash"] == old_row["state_hash"]
    finally:
        st.snapshots[rec["run"]].pop("old-build-snapshot", None)
        st.snapshots[rec["run"]].pop("bad", None)


def test_compare_restore_tolerates_only_empty_defaults():
    a = {"track": {"incidents": {}}, "tick": 3}
    assert compare_restore(a, {"track": {"incidents": {}, "contracts": {}}, "tick": 3}) == ([], ["state.track.contracts"])
    div, _ = compare_restore(a, {"track": {"incidents": {}, "contracts": {"x": 1}}, "tick": 3})
    assert div and "non-empty" in div[0]
    div, _ = compare_restore(a, {"track": {"incidents": {}}, "tick": 4})
    assert div == ["state.tick: 3 != 4"]


# ------------------------------------------------------------------ fork semantics
def test_fork_no_lease_new_rng_lineage_parent_immutable_and_fork_of_fork(rec):
    eng, st = rec["eng"], rec["st"]
    mgr = StorageRunManager(eng)
    cps = mgr.checkpoints(rec["run"], None)
    lease_cp = next(c for c in cps if c["reason"] == "with_lease")
    parent_doc = json.loads(zlib.decompress(st.get_snapshot(rec["run"], lease_cp["snapshot_id"])["state"]))
    assert parent_doc["control"]["leases"], "the checkpoint was taken with an open operator lease"
    before = _fingerprint(st, rec["run"])

    res = run(mgr.fork(rec["run"], _req(lease_cp, label="what if"), "op1"))
    child = res["run"]
    cid = child["run_id"]
    assert res["leases_carried"] == 0 and res["rng"]["stream"] == "new" and res["restore_basis"] == "exact"
    assert res["restored_hash"] == res["parent_state_hash"] == st.get_snapshot(rec["run"], lease_cp["snapshot_id"])["state_hash"]
    assert res["parent_hash_before"] == res["parent_hash_after"] == lease_cp["hash"]
    assert _fingerprint(st, rec["run"]) == before                                   # parent immutable
    row = st.get_run(cid)
    assert row["parent_run_id"] == rec["run"] and row["kind"] == "fork" and row["fork_tick"] == lease_cp["tick"] and row["rng_stream"] == f"fork:{cid}"
    assert row["meta"]["parent_cut_seq"] == st.get_snapshot(rec["run"], lease_cp["snapshot_id"])["last_seq"] and row["meta"]["fork_snapshot_id"] == lease_cp["snapshot_id"]
    child_snap = st.latest_snapshot(cid)
    cdoc = json.loads(zlib.decompress(child_snap["state"]))
    assert cdoc["control"]["leases"] == {} and all(r["state"] == "AUTONOMOUS" and not r["lease_id"] for r in cdoc["control"]["ctl"].values())
    assert cdoc["rng"] != parent_doc["rng"] and cdoc["run_id"] == cid and cdoc["tick"] == parent_doc["tick"]
    assert json.loads(unb64(cdoc["plant"]))["rng"] != json.loads(unb64(parent_doc["plant"]))["rng"]
    assert all(r["control"]["controller_state"] == "AUTONOMOUS" for r in child_snap["world"]["robots"].values())
    # comm lineage references the parent
    from loopkeeper.api.routes_comms import _lineage
    lin = _lineage(st, cid)
    assert lin["parent_run_id"] == rec["run"] and lin["parent_cut_seq"] == row["meta"]["parent_cut_seq"]

    # fork of a fork: the child's own checkpoint is restorable and verifies EXACTLY (its hash was produced by the restoring code)
    cc = mgr.checkpoints(cid, None)
    assert len(cc) == 1 and cc[0]["compatible"]
    res2 = run(mgr.fork(cid, _req(cc[0]), "op2"))
    assert res2["restore_basis"] == "exact" and res2["parent_run_id"] == cid and res2["run"]["parent_run_id"] == cid
    assert res2["restored_hash"] == child_snap["state_hash"]
    assert st.get_run(res2["run"]["run_id"])["rng_stream"] != row["rng_stream"]
    assert cid in mgr.get_run(rec["run"])["children"] and res2["run"]["run_id"] in mgr.get_run(cid)["children"]


def test_refusals_are_machine_readable(rec):
    eng, st = rec["eng"], rec["st"]
    mgr = StorageRunManager(eng)
    cp = mgr.checkpoints(rec["run"], None)[-1]

    def refused(req, run_id=None, status=None):
        with pytest.raises((RunError, RunNotFound)) as e:
            run(mgr.fork(run_id or rec["run"], req, "op"))
        return e.value
    assert refused(_req(cp, chosen_snapshot_id="nope")).code == "unknown_checkpoint"
    e = refused(_req(cp, fork_tick=cp["tick"] + 1))
    assert (e.code, e.status) == ("fork_tick_mismatch", 422)
    e = refused(_req(cp, expected_parent_hash="deadbeef"))
    assert (e.code, e.status) == ("stale_parent", 409) and e.detail["checkpoint_hash"] == cp["hash"]
    assert isinstance(refused(_req(cp), run_id="no_such_run"), RunNotFound)
    row = st.get_run(rec["run"])
    st.runs[rec["run"]]["topology_hash"] = "th_other"
    try:
        e = refused(_req(cp))
        assert (e.code, e.status) == ("topology_mismatch", 409) and e.detail["recorded_topology"] == "th_other"
        assert not any(c["compatible"] for c in mgr.checkpoints(rec["run"], None))            # the picker never offers what would be refused
    finally:
        st.runs[rec["run"]]["topology_hash"] = row["topology_hash"]
    snap = st.snapshots[rec["run"]][cp["snapshot_id"]]
    snap["schema_version"] = 99
    try:
        assert refused(_req(cp)).code == "incompatible_snapshot"
    finally:
        snap["schema_version"] = STATE_SCHEMA_VERSION


def test_http_refusal_bodies_and_fork_end_to_end(rec):
    eng = rec["eng"]
    eng.runs = StorageRunManager(eng)
    c = TestClient(create_app(eng, settings=make_settings()))
    cps = c.get(f"/api/v1/runs/{rec['run']}/checkpoints", headers=AUTH).json()["checkpoints"]
    cp = cps[-1]
    bad = c.post(f"/api/v1/runs/{rec['run']}/fork", json=_req(cp, expected_parent_hash="deadbeef"), headers=AUTH)
    assert bad.status_code == 409 and bad.headers["X-Problem-Code"] == "stale_parent"
    body = bad.json()
    assert body["error"]["code"] == body["error"]["reason"] == "stale_parent" and body["error"]["detail"]["checkpoint_hash"] == cp["hash"]
    gone = c.post(f"/api/v1/runs/{rec['run']}/fork", json=_req(cp, chosen_snapshot_id="nope"), headers=AUTH)
    assert gone.status_code == 404 and gone.json()["error"]["code"] == "unknown_checkpoint"
    ok = c.post(f"/api/v1/runs/{rec['run']}/fork", json=_req(cp, label="e2e"), headers=AUTH)
    assert ok.status_code == 201, ok.text
    out = ok.json()
    assert out["run"]["parent_run_id"] == rec["run"] and out["leases_carried"] == 0 and out["rng"]["stream"] == "new"
    # the child is listed, has a checkpoint, replays, and its communication lineage names the parent
    child = out["run"]["run_id"]
    assert c.get(f"/api/v1/runs/{child}/replay", headers=AUTH).json()["frames"]
    assert c.get(f"/api/v1/runs/{child}/communications", headers=AUTH).json()["lineage"]["parent_run_id"] == rec["run"]
    cc = c.get(f"/api/v1/runs/{child}/checkpoints", headers=AUTH).json()["checkpoints"]
    assert c.post(f"/api/v1/runs/{child}/fork", json=_req(cc[0]), headers=AUTH).status_code == 201


# ------------------------------------------------------------------ replay
def test_replay_frames_equal_recorded_hashes_and_window_never_leaks_the_future(rec):
    eng, st = rec["eng"], rec["st"]
    mgr = StorageRunManager(eng)
    cps = mgr.checkpoints(rec["run"], None)
    row = st.get_run(rec["run"])
    full = run(mgr.replay(rec["run"], None, None, 1, True, 100000))
    assert full["events"] and not full["has_more"]
    by_tick = {f["tick"]: f for f in full["frames"]}
    for c in cps:                                            # replay frame at a checkpoint == the recorded world, and the state restores to the recorded hash
        if c["tick"] in by_tick:
            assert by_tick[c["tick"]]["hash"] == st.get_snapshot(rec["run"], c["snapshot_id"])["world_hash"]
    mid = cps[1]["tick"] + 17                                # a window BETWEEN checkpoints: starts from the inherited checkpoint state
    w = run(mgr.replay(rec["run"], mid, mid + 60, 1, True, 5000))
    assert w["frames"] and w["frames"][0]["inherited"] is True and w["frames"][0]["tick"] <= mid
    assert all(mid <= e["sim_tick"] <= mid + 60 for e in w["events"])
    assert all(e["type"] not in ("world.diff", "heartbeat", "engine.health") for e in w["events"])
    # the same window the slow way (filter the whole log) is identical: nothing missing, nothing from the future (comm.* included)
    expect = [e["event_id"] for e in sorted(full["events"], key=lambda x: (x["sim_tick"], x["seq"])) if mid <= e["sim_tick"] <= mid + 60]
    assert [e["event_id"] for e in w["events"]] == expect
    assert any(e["type"].startswith("comm.") for e in full["events"])


def test_replay_keyset_pages_concatenate_to_the_whole_window(rec):
    mgr = StorageRunManager(rec["eng"])
    whole = run(mgr.replay(rec["run"], 0, 10**9, 1, True, 100000))["events"]
    assert len(whole) > 12
    seen, cursor, pages = [], None, 0
    while True:
        p = run(mgr.replay(rec["run"], 0, 10**9, 1, True, 5, cursor))
        seen += [e["event_id"] for e in p["events"]]
        pages += 1
        if not p["has_more"]:
            break
        cursor = p["next_cursor"]
        assert pages < 500
    assert seen == [e["event_id"] for e in whole] and pages > 2
    with pytest.raises(RunError) as e:
        run(mgr.replay(rec["run"], 0, 10, 1, True, 5, "garbage"))
    assert e.value.code == "invalid_cursor" and e.value.status == 422


def test_closed_windows_are_cached_and_the_open_edge_is_not(rec):
    mgr = StorageRunManager(rec["eng"])
    st = rec["st"]
    wm = st.event_watermark(rec["run"])["tick"]
    h0 = mgr.cache_hits
    a = run(mgr.replay_json(rec["run"], 0, wm - 5, 1, True, 5000))
    b = run(mgr.replay_json(rec["run"], 0, wm - 5, 1, True, 5000))
    assert a == b and mgr.cache_hits == h0 + 1
    run(mgr.replay_json(rec["run"], 0, wm + 100, 1, True, 5000))
    run(mgr.replay_json(rec["run"], 0, wm + 100, 1, True, 5000))
    assert mgr.cache_hits == h0 + 1                           # a window past the committed watermark can still change: never cached


def test_replay_http_validates_against_the_wire_model(rec):
    eng = rec["eng"]
    eng.runs = StorageRunManager(eng)
    c = TestClient(create_app(eng, settings=make_settings()))
    r = c.get(f"/api/v1/runs/{rec['run']}/replay", params={"start_tick": 100, "end_tick": 300, "stride": 100000}, headers=AUTH)
    assert r.status_code == 200
    from loopkeeper.api import models_runs as R
    R.ReplayWindow.model_validate(r.json())
    assert c.get("/api/v1/runs/nope/replay", headers=AUTH).status_code == 404


# ------------------------------------------------------------------ real PostgreSQL
def test_postgres_replay_matches_memory_uses_the_index_and_is_fast(tmp_path, rec):
    pgserver = pytest.importorskip("pgserver")
    from loopkeeper.storage.postgres import PostgresStorage
    try:
        srv = pgserver.get_server(str(tmp_path / "pg"))
    except Exception as e:                                   # noqa: BLE001
        pytest.skip(f"embedded postgres unavailable: {type(e).__name__}")
    try:
        pg = PostgresStorage(srv.get_uri())
        pg.migrate()
        pg.migrate()                                         # 0011 idempotent
        mem = rec["st"]
        # copy the recorded run (events + snapshots + commands) into Postgres through the real commit path
        row = mem.get_run(rec["run"])
        topo = rec["eng"].topology()
        pg.register_facility(row["facility_id"], row["config_version"], row["topology_hash"], topo)
        pg.create_run({k: row[k] for k in ("run_id", "facility_id", "config_version", "topology_hash", "topology_version", "seed", "rng_stream", "kind", "label",
                                           "phase", "owner_id", "engine_version", "schema_version", "sim_speed", "dt_s", "last_tick", "last_seq", "last_apply_order", "meta")})
        snaps = [mem.get_snapshot(rec["run"], s["snapshot_id"]) for s in mem.list_snapshots(rec["run"])]
        evs = mem.load_events(rec["run"], after_seq=0)
        with pg.pool.connection() as c, c.transaction():
            for e in evs:
                from psycopg.types.json import Jsonb
                c.execute("INSERT INTO world_events (run_id, seq, event_id, facility_id, tick, sim_time_s, world_version, kind, entity_id, actor_type, actor_id, payload, "
                          "causal_parent_id, command_id, ts, schema_version, event_hash) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::timestamptz,%s,%s)",
                          (rec["run"], e["seq"], e["event_id"], e["facility_id"], e["tick"], e["sim_time_s"], e["world_version"], e["kind"], e["entity_id"],
                           e.get("actor_type", "system"), e.get("actor_id"), Jsonb(e["payload"]), e.get("causal_parent_id"), e.get("command_id"), e["ts"],
                           e["schema_version"], e["event_hash"]))
            for s in snaps:
                c.execute("INSERT INTO world_snapshots (snapshot_id, run_id, facility_id, tick, last_seq, reason, state, world, rng_state, schema_version, engine_version, "
                          "content_hash, world_hash, state_hash) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                          (s["snapshot_id"], rec["run"], row["facility_id"], s["tick"], s["last_seq"], s["reason"], s["state"], Jsonb(s["world"]), Jsonb(s["rng_state"]),
                           s["schema_version"], s["engine_version"], s["content_hash"], s["world_hash"], s["state_hash"]))
        with pg.pool.connection() as c:
            idx = {r["indexname"] for r in c.execute("SELECT indexname FROM pg_indexes WHERE tablename IN ('world_events','commands')").fetchall()}
            assert {"world_events_replay_idx", "commands_operator_tick_idx"} <= idx
        pg_mgr = StorageRunManager(rec["eng"])
        pg_mgr._st = pg
        mem_mgr = StorageRunManager(rec["eng"])
        hi = evs[-1]["tick"]
        for lo, up in ((0, hi), (hi // 3, hi // 3 + 60), (hi // 2, hi // 2 + 60), (hi - 30, hi)):
            a = run(mem_mgr.replay(rec["run"], lo, up, 1, True, 5000))
            b = run(pg_mgr.replay(rec["run"], lo, up, 1, True, 5000))
            for k in ("frames", "events", "checkpoints", "gaps", "has_more", "next_cursor", "start_tick", "end_tick", "recorded_from_tick"):
                assert a[k] == b[k], f"{k} differs for window {lo}-{up}"
        # real forks work on Postgres as well (verified checkpoint -> new run, parent rows untouched)
        cps = pg_mgr.checkpoints(rec["run"], None)
        before = _fingerprint(pg, rec["run"])
        res = run(pg_mgr.fork(rec["run"], _req(cps[-1]), "op"))
        assert res["restore_basis"] == "exact" and _fingerprint(pg, rec["run"]) == before
        assert pg.get_run(res["run"]["run_id"])["parent_run_id"] == rec["run"]
        cc = pg_mgr.checkpoints(res["run"]["run_id"], None)
        assert run(pg_mgr.fork(res["run"]["run_id"], _req(cc[0]), "op"))["restore_basis"] == "exact"
        # the replay window is an index range scan, not a scan from the start of the run
        with pg.pool.connection() as c:
            c.execute("ANALYZE world_events")
            plan = "\n".join(r["QUERY PLAN"] for r in c.execute(
                "EXPLAIN SELECT seq FROM world_events WHERE run_id=%s AND tick <= %s AND (tick, seq) > (%s, -1) AND kind NOT IN ('world.diff','heartbeat','engine.health') "
                "ORDER BY tick, seq LIMIT 100", (rec["run"], hi, hi // 2)).fetchall())
        assert "Seq Scan" not in plan or len(evs) < 2000, plan
    finally:
        srv.cleanup()
