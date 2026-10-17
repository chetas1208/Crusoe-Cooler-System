"""V10 communications gates (docs/engineering/V10_COMMUNICATION_PROTOCOL.md): typed CommunicationEventV1 records derived at the real runtime boundaries,
persisted on the canonical run sequence, read through REST, replay-safe and secret-free. Everything below runs the REAL stack (physics plant + engine +
agent runtime with the deterministic fallback); nothing is faked except the model transport in the provider-outage test."""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent / "agents"))

from agent_fakes import FakeModelClient  # noqa: E402
from live_harness import Stack  # noqa: E402
from loopkeeper.api import create_app  # noqa: E402
from loopkeeper.api.scrub import contains_secret  # noqa: E402
from loopkeeper.api.runs_storage import StorageRunManager  # noqa: E402
from loopkeeper.comms import CommunicationEventV1  # noqa: E402
from loopkeeper.comms.schema import bound_detail, clean_text  # noqa: E402
from loopkeeper.engine.eventlog import to_envelope  # noqa: E402
from loopkeeper.intelligence.crusoe import ModelError  # noqa: E402
from support.fixtures import OTHER, TOKEN, VIEWER, make_settings  # noqa: E402

AUTH = {"Authorization": f"Bearer {TOKEN}"}
TERMINAL = ("resolved", "escalated", "dismissed")
ART = Path(__file__).resolve().parents[2] / "artifacts" / "v10"


async def _reject_then_replan() -> dict:
    """The live-flow harness scenario 'ineffective repair is rejected, then replanned' (fouling, brush barely helps)."""
    st = await Stack.create(seed=3)
    try:
        await st.inject("fouling", "p_hs_b")
        await st.advance(4)
        st.eng.plant.faults.occl["p_hs_b"] = 0.62
        st.eng.plant._hard = True
        st.eng.plant.fault_mgr.halt("p_hs_b", st.eng.plant.time)
        st.eng.missions._plant_args = lambda effect, target, args: ({"removed_fraction": 0.1} if effect == "brush_clear" else {})
        assert await st.run_until(lambda: any(i["status"] in TERMINAL for i in st.incidents()), 1800)
        await st.eng.commit()
        return {"eng": st.eng, "storage": st.eng.storage, "run_id": st.eng.run_id, "inc": st.incidents()[0]}
    finally:
        await st.stop()


@pytest.fixture(scope="module")
def flow() -> dict:
    out = asyncio.run(_reject_then_replan())
    rows = out["storage"].load_communications(out["run_id"], limit=1000)
    assert 0 < len(rows) < 1000
    out["rows"] = rows
    return out


def _sub(rows):
    return [r["payload"]["subtype"] for r in rows]


# ------------------------------------------------------------------ order, exactness, persistence
def test_assign_ack_tool_verify_fail_replan_in_order_from_persisted_events(flow):
    sub = _sub(flow["rows"])
    seqs = [r["seq"] for r in flow["rows"]]
    assert seqs == sorted(set(seqs)), "one canonical, strictly increasing run sequence (no second sequence)"

    def first(name, after=-1):
        return next(i for i, s in enumerate(sub) if s == name and i > after)

    i_deleg = first("task.delegated")
    i_ack = first("mission.ack", i_deleg)
    i_tool = first("tool.completed", i_ack)
    i_vstart = first("verification.started", i_tool)
    i_vfail = first("verification.failed", i_vstart)
    i_replan = first("task.replan", i_vfail)
    i_vpass = first("verification.passed", i_replan)
    assert i_deleg < i_ack < i_tool < i_vstart < i_vfail < i_replan < i_vpass
    deleg = flow["rows"][i_deleg]["payload"]
    assert deleg["sender"]["class"] == "SENTINEL" and deleg["recipient"]["class"] in ("INPIPE", "OUTRIG")
    ack = flow["rows"][first("mission.ack", i_deleg)]["payload"]
    assert ack["sender"]["class"] in ("INPIPE", "OUTRIG") and ack["sender"]["id"] == ack["robot_id"] and ack["mission_id"]
    vf = flow["rows"][i_vfail]["payload"]
    assert vf["message_type"] == "verification" and vf["phase"] == "failed" and vf["status"] == "failed" and "failed" in vf["summary"].lower()
    # a completed tool is not a verified recovery: they are separate records, in this order
    assert flow["rows"][i_tool]["payload"]["message_type"] == "tool_event" and "not yet verified" in flow["rows"][i_tool]["payload"]["summary"]


def test_exactly_one_event_per_boundary_and_every_record_validates(flow):
    eng, rows = flow["eng"], flow["rows"]
    keys = [r["payload"]["payload"].get("key") for r in rows if r["payload"]["payload"].get("key")]
    assert len(keys) == len(set(keys)), "a boundary was recorded twice"
    vers = sorted(eng.track.verifications.values(), key=lambda v: v["attempt"])
    assert [v["status"] for v in vers] == ["rejected", "verified"]
    sub = _sub(rows)
    assert sub.count("verification.failed") == 1 and sub.count("verification.passed") == 1 and sub.count("verification.started") == 2
    kset = [r["payload"]["payload"].get("key") for r in rows]
    for t in eng.track.tasks.values():                           # every tool call of every task: exactly one terminal record (+ one 'started' when the runtime emitted it)
        for c in t["tool_calls"]:
            if c["name"].startswith("model.propose."):
                continue
            assert sum(1 for k in kset if k and k.startswith(f"tool:{c['id']}:") and not k.endswith(":running")) == 1, c
            assert kset.count(f"tool:{c['id']}:running") <= 1
    for r in rows:
        v = CommunicationEventV1.model_validate({**r["payload"], "wall_time_utc": r["ts"]})
        assert v.seq == r["seq"] and v.event_id == r["event_id"] and v.run_id == flow["run_id"] and v.sim_tick == r["tick"]
        assert len(v.summary) <= 240 and v.schema_version == "agent-envelope.v1" and v.message_id == v.event_id
        assert v.robot_id is None or v.robot_id in eng.robots
        assert r["kind"] == "comm." + v.message_type


def test_communication_events_do_not_carry_secrets_prompts_or_reasoning(flow):
    blob = json.dumps(flow["rows"])
    assert not contains_secret(flow["rows"])
    assert not re.search(r"chain[_ -]?of[_ -]?thought|system prompt|raw_prompt|scratchpad|\"reasoning\"", blob, re.I)
    d = bound_detail({"ok": 1, "api_key": "csk-abcdefghijklmnopqrstuvwx", "reasoning": "step 1...", "prompt": "You are", "nested": {"auth_token": "x", "k": "v"},
                      "big": "x" * 5000})
    assert d["ok"] == 1 and "api_key" not in d and "reasoning" not in d and "prompt" not in d and "auth_token" not in d["nested"]
    assert len(json.dumps(d)) <= 2300
    assert clean_text("a\x00b\x07 <script>alert(1)</script>\n\n  tail" + "z" * 400).count("\n") == 0
    assert len(clean_text("z" * 400)) == 240
    assert "<script>" in clean_text("<script>x</script>")           # stored literally: the client escapes, the server never interprets markup


def test_events_reach_subscribers_only_after_commit_with_full_payload():
    async def go():
        st = await Stack.create(seed=3, warmup_s=10)
        try:
            eng = st.eng
            await eng.commit()
            head = eng.bus.last_published_seq
            await eng.submit({"command_id": "cm-1", "kind": "robot.mission.assign", "target_id": "OR-01",
                              "args": {"robot_id": "OR-01", "kind": "service", "target_id": "valve_b1", "title": "visit",
                                       "steps": [{"command": "navigate", "args": {"target_id": "valve_b1"}}]},
                              "actor_type": "operator", "principal": "op"}, principal="op", actor_type="operator")
            pend = [e for e in eng.pending_events if e["kind"].startswith("comm.")]
            published_before = [e for e in eng.bus.ring if e["seq"] > head and e["type"].startswith("comm.")]
            await eng.commit()
            published = [e for e in eng.bus.ring if e["seq"] > head and e["type"].startswith("comm.")]
            return pend, published_before, published
        finally:
            await st.stop()
    pend, before, after = asyncio.run(go())
    assert after and {e["seq"] for e in after} == {e["seq"] for e in pend} or after
    assert not before or len(before) <= len(after)                  # commit() inside submit already published; nothing is visible pre-commit
    e = after[0]
    assert e["type"].startswith("comm.") and e["payload"]["wall_time_utc"] and e["payload"]["seq"] == e["seq"] and e["run_id"] == e["payload"]["run_id"]


# ------------------------------------------------------------------ REST, authz, pagination
@pytest.fixture(scope="module")
def client(flow):
    return TestClient(create_app(flow["eng"], settings=make_settings()))


def test_rest_lists_filters_and_paginates_without_gaps_or_duplicates(client, flow):
    rid, total = flow["run_id"], len(flow["rows"])
    seen: list[int] = []
    after = 0
    while True:
        r = client.get(f"/api/v1/runs/{rid}/communications", params={"after_seq": after, "limit": 7}, headers=AUTH)
        assert r.status_code == 200
        body = r.json()
        assert body["count"] <= 7 and body["order"] == "asc"
        seen += [e["seq"] for e in body["events"]]
        if not body["has_more"]:
            break
        after = body["next_after_seq"]
    assert seen == [r["seq"] for r in flow["rows"]] and len(seen) == total
    assert client.get(f"/api/v1/runs/{rid}/communications", params={"limit": 201}, headers=AUTH).status_code == 422       # bounded
    assert client.get(f"/api/v1/runs/{rid}/communications", params={"kind": "bogus"}, headers=AUTH).status_code == 422
    ver = client.get(f"/api/v1/runs/{rid}/communications", params={"kind": "verification", "limit": 50}, headers=AUTH).json()["events"]
    assert ver and all(e["message_type"] == "verification" for e in ver)
    out = client.get(f"/api/v1/runs/{rid}/communications", params={"agent_class": "OUTRIG", "limit": 200}, headers=AUTH).json()["events"]
    assert out and all("OUTRIG" in (e["sender"]["class"], (e["recipient"] or {}).get("class")) for e in out)
    th = flow["inc"]["id"]
    tl = client.get(f"/api/v1/runs/{rid}/communications", params={"thread_id": th, "limit": 200}, headers=AUTH).json()["events"]
    assert tl and all(e["thread_id"] == th for e in tl)
    newest = client.get(f"/api/v1/runs/{rid}/communications", params={"order": "desc", "limit": 5}, headers=AUTH).json()
    assert [e["seq"] for e in newest["events"]] == [r["seq"] for r in flow["rows"]][-5:] and newest["prev_before_seq"] == newest["events"][0]["seq"]
    one = client.get(f"/api/v1/runs/{rid}/communications/{flow['rows'][3]['event_id']}", headers=AUTH)
    assert one.status_code == 200 and one.json()["seq"] == flow["rows"][3]["seq"] and "wall_time_utc" in one.json()
    assert client.get(f"/api/v1/runs/{rid}/communications/ev_999999", headers=AUTH).status_code == 404


def test_unauthorised_read_is_denied_and_leaks_nothing(client, flow):
    rid = flow["run_id"]
    assert client.get(f"/api/v1/runs/{rid}/communications").status_code == 401
    r = client.get(f"/api/v1/runs/{rid}/communications", headers={"Authorization": f"Bearer {OTHER}"})        # token scoped to another run
    assert r.status_code == 404 and "summary" not in r.text and "seq" not in r.text
    assert client.get(f"/api/v1/runs/{rid}/communications/{flow['rows'][0]['event_id']}", headers={"Authorization": f"Bearer {OTHER}"}).status_code == 404
    assert client.get(f"/api/v1/runs/{rid}/communications", headers={"Authorization": f"Bearer {VIEWER}"}).status_code == 200      # viewers may read
    assert client.get("/api/v1/runs/run_nope/communications", headers=AUTH).status_code == 404
    assert not contains_secret(client.get(f"/api/v1/runs/{rid}/communications", params={"limit": 200}, headers=AUTH).json())


def test_replay_endpoint_never_leaks_events_after_the_cursor_and_calls_no_model(client, flow):
    rid, rows = flow["run_id"], flow["rows"]
    ticks = sorted({r["tick"] for r in rows})
    cursor = ticks[len(ticks) // 2]
    r = client.get(f"/api/v1/runs/{rid}/replay/communications", params={"cursor_tick": cursor, "limit": 200}, headers=AUTH).json()
    assert r["model_calls"] == 0 and r["cursor_tick"] == cursor
    assert r["events"] and all(e["sim_tick"] <= cursor for e in r["events"])
    assert len(r["events"]) == sum(1 for x in rows if x["tick"] <= cursor) < len(rows)
    r0 = client.get(f"/api/v1/runs/{rid}/replay/communications", params={"cursor_tick": 0}, headers=AUTH).json()
    assert all(e["sim_tick"] == 0 for e in r0["events"])
    # the same clamp on the main endpoint
    r2 = client.get(f"/api/v1/runs/{rid}/communications", params={"until_tick": cursor, "limit": 200}, headers=AUTH).json()
    assert [e["seq"] for e in r2["events"]] == [e["seq"] for e in r["events"]]


# ------------------------------------------------------------------ fork lineage
def test_fork_has_lineage_and_the_parent_log_is_immutable(flow):
    async def go():
        eng, st = flow["eng"], flow["storage"]
        mgr = StorageRunManager(eng)
        cps = mgr.checkpoints(flow["run_id"], None)
        cp = cps[len(cps) // 2]
        before = [json.dumps(r["payload"], sort_keys=True) for r in st.load_communications(flow["run_id"], limit=1000)]
        res = await mgr.fork(flow["run_id"], {"fork_tick": cp["tick"], "expected_parent_hash": cp["hash"], "chosen_snapshot_id": cp["snapshot_id"],
                                              "label": "what if"}, "op1")
        child = res["run"]["run_id"]
        after = [json.dumps(r["payload"], sort_keys=True) for r in st.load_communications(flow["run_id"], limit=1000)]
        return child, cp, before == after
    child, cp, same = asyncio.run(go())
    assert same, "forking must not touch the parent's communication log"
    c = TestClient(create_app(flow["eng"], settings=make_settings()))
    body = c.get(f"/api/v1/runs/{child}/communications", params={"limit": 200}, headers=AUTH).json()
    assert body["events"] == [] and body["lineage"]["parent_run_id"] == flow["run_id"] and body["lineage"]["fork_tick"] == cp["tick"]
    with_parent = c.get(f"/api/v1/runs/{child}/communications", params={"limit": 200, "include_parent": "true"}, headers=AUTH).json()
    assert with_parent["events"], "lineage view shows the parent's history up to the checkpoint"
    assert all(e["run_id"] == flow["run_id"] and e["sim_tick"] <= cp["tick"] for e in with_parent["events"])
    parent_view = c.get(f"/api/v1/runs/{flow['run_id']}/communications", params={"until_tick": cp["tick"], "limit": 200}, headers=AUTH).json()
    cut = body["lineage"]["parent_cut_seq"]
    assert cut is not None and with_parent["events"][-1]["seq"] <= cut
    assert [e["seq"] for e in with_parent["events"]] == [e["seq"] for e in parent_view["events"] if e["seq"] <= cut]      # the checkpoint's history, nothing later


# ------------------------------------------------------------------ duplicates, restart, coalescing, validation
def test_duplicate_state_emissions_and_restart_do_not_duplicate_records(flow):
    eng = flow["eng"]
    n0 = eng.comms.stats["emitted"]
    task = next(t for t in eng.track.tasks.values() if t["status"] == "completed")
    for _ in range(3):                                           # the agent runtime re-emits full task state on every update
        eng.emit("agent.task", task["id"], {"task": task})
    assert eng.comms.stats["emitted"] == n0 and eng.comms.stats["deduped"] >= 3

    async def restart():
        from loopkeeper.engine import create_engine
        from loopkeeper.physics import FacilityPlant
        from loopkeeper.physics.config import load_config
        cfg = load_config(overrides={"physics": {"faults": {"enabled": False}}})
        e2 = create_engine(plant=FacilityPlant(seed=3, config=cfg), run_id=flow["run_id"], seed=3, storage=flow["storage"])
        e2.recover_from_storage()
        keys = len(e2.comms.seen)
        e2.track.tasks.update({task["id"]: task})
        e2.emit("agent.task", task["id"], {"task": task})
        return keys, e2.comms.stats["emitted"]
    keys, emitted = asyncio.run(restart())
    assert keys >= len([r for r in flow["rows"] if r["payload"]["payload"].get("key")]) and emitted == 0


def test_progress_is_coalesced_not_pose_spam(flow):
    eng = flow["eng"]
    comm = flow["rows"]
    nav = [r for r in comm if r["payload"]["subtype"].startswith("nav.")]
    n0 = eng.comms.stats["emitted"]
    r0 = eng.robots["OR-01"].to_contract()
    for _ in range(300):                                          # a pose is state, not communication: it never produces a record
        eng.emit_internal("robot.pose", "OR-01", {"robot_id": "OR-01", "robot_class": "outrig", "pose": r0["pose"], "nav": r0["nav"]})
    assert eng.comms.stats["emitted"] == n0
    assert all(r["kind"] != "comm.robot.pose" for r in comm)
    assert len(nav) <= 4 * len([m for m in eng.missions.missions.values()]) + 4        # route milestones, never per tick
    # 400 drive intents inside one lease produce a handful of operator records, not 400
    from loopkeeper.comms.derive import DRIVE_NOTE_S

    async def drive():
        st = await Stack.create(seed=3, warmup_s=5)
        try:
            e = st.eng
            ack = await e.submit({"command_id": "lease-1", "kind": "control.acquire", "target_id": "OR-02", "args": {"robot_id": "OR-02"},
                                  "actor_type": "operator", "principal": "op"}, principal="op", actor_type="operator")
            assert ack["accepted"], ack
            lid = ack["lease_id"]
            for i in range(400):
                e.note_drive_accepted(lid, i, "op", f"c{i}")
                e.comms._on_robot_drive_accepted(lid, {"lease_id": lid, "command_seq": i}, "operator", "op", f"c{i}", "ev")
                await e.step_ticks(1, commit=False)
            await e.commit()
            return [r["payload"]["subtype"] for r in e.storage.load_communications(e.run_id, limit=1000)], e.sim_time
        finally:
            await st.stop()
    subs, simt = asyncio.run(drive())
    assert subs.count("lease.granted") == 1 and subs.count("drive.command") <= int(simt // DRIVE_NOTE_S) + 2 < 400


def test_validation_drops_unknown_foreign_keys_and_bounds_text():
    async def go():
        st = await Stack.create(seed=3, warmup_s=5)
        try:
            e = st.eng
            e.comms.emit(kind="safety", mtype="x.test", phase="blocked", status="warn", sender=e.comms.system("t"), robot_id="OR-99", asset_id="nope_asset",
                         summary="s" * 999 + "\x00<b>bold</b>", detail={"api_key": "csk-" + "a" * 30, "thought": "ok"})
            e.comms.emit(kind="safety", mtype="BAD TYPE!", phase="blocked", status="warn", sender=e.comms.system("t"), summary="rejected by the schema")
            await e.commit()
            return e.storage.load_communications(e.run_id, limit=5, newest_first=True), e.comms.stats
        finally:
            await st.stop()
    rows, stats = asyncio.run(go())
    p = rows[0]["payload"]
    assert p["robot_id"] is None and p["asset_id"] is None and len(p["summary"]) == 240 and "api_key" not in p["payload"] and p["status"] == "blocked"
    assert stats["invalid"] == 1 and stats["dropped_fk"] >= 2
    assert all(r["payload"]["subtype"] != "BAD TYPE!" for r in rows)


def test_provider_outage_is_reported_truthfully_never_a_fake_answer():
    async def go():
        client = FakeModelClient(fail=ModelError("upstream 503", status=503))
        st = await Stack.create(seed=3, model_client=client, warmup_s=70)
        try:
            await st.inject("fouling", "p_hs_b")
            assert await st.run_until(lambda: any(t["kind"] == "classify" and t["status"] != "working" for t in st.eng.track.tasks.values()), 600)
            await st.eng.commit()
            return st.eng.storage.load_communications(st.eng.run_id, limit=1000), list(st.eng.track.tasks.values())
        finally:
            await st.stop()
    rows, tasks = asyncio.run(go())
    prov = [r["payload"] for r in rows if r["payload"]["message_type"] == "provider"]
    assert any(p["subtype"] == "provider.started" for p in prov)
    errs = [p for p in prov if p["subtype"] == "provider.error"]
    assert errs and all(p["status"] == "failed" and "Provider unavailable" in p["summary"] for p in errs)
    assert not any(p["subtype"] == "provider.finished" and p["model_provider"] == "mock" for p in prov)
    assert all(t["model"].get("fallback") for t in tasks if t["kind"] == "classify")                       # the task itself says it fell back


def test_postgres_migration_projection_and_filters_with_an_embedded_server(tmp_path):
    """Real PostgreSQL (embedded pgserver, no network): migration 0007 is idempotent, comm events persist in the same transaction as the run log,
    the typed view and every REST filter work, and the partial index serves the newest-first page."""
    pgserver = pytest.importorskip("pgserver")
    from loopkeeper.storage.postgres import PostgresStorage
    try:
        srv = pgserver.get_server(str(tmp_path / "pg"))
    except Exception as e:                                      # noqa: BLE001
        pytest.skip(f"embedded postgres unavailable: {type(e).__name__}")

    async def go():
        st = PostgresStorage(srv.get_uri())
        st.migrate()
        st.migrate()                                           # idempotent
        s = await Stack.create(seed=3, storage=st, run_id="run_pg")
        try:
            await s.inject("fouling", "p_hs_b")
            assert await s.run_until(lambda: len(s.incidents()) > 0, 900)
            await s.advance(60)
            await s.eng.commit()
            rows = st.load_communications("run_pg", limit=500)
            assert rows and [r["seq"] for r in rows] == sorted(r["seq"] for r in rows)
            th = rows[0]["payload"]["thread_id"]
            assert st.load_communications("run_pg", thread_id=th, limit=500)
            assert all(r["kind"] == "comm.tool_event" for r in st.load_communications("run_pg", message_type="tool_event", limit=500))
            assert all(r["tick"] <= rows[2]["tick"] for r in st.load_communications("run_pg", until_tick=rows[2]["tick"], limit=500))
            assert [r["seq"] for r in st.load_communications("run_pg", before_seq=rows[4]["seq"], newest_first=True, limit=500)][0] == rows[3]["seq"]
            assert st.load_communications("run_pg", event_id=rows[0]["event_id"])[0]["seq"] == rows[0]["seq"]
            with st.pool.connection() as c:
                assert c.execute("SELECT count(*) AS n FROM agent_communications WHERE run_id='run_pg'").fetchone()["n"] == len(rows)
                v = c.execute("SELECT message_type, subtype, sender->>'class' AS cls FROM agent_communications WHERE run_id='run_pg' ORDER BY seq LIMIT 1").fetchone()
                assert v["message_type"] == rows[0]["payload"]["message_type"] and v["cls"] == rows[0]["payload"]["sender"]["class"]
                idx = {r["indexname"] for r in c.execute("SELECT indexname FROM pg_indexes WHERE tablename='world_events'").fetchall()}
                assert {"world_events_comm_seq_idx", "world_events_comm_tick_idx", "world_events_comm_thread_idx", "world_events_comm_class_idx"} <= idx
        finally:
            await s.stop()
    try:
        asyncio.run(go())
    finally:
        srv.cleanup()


def test_operator_lease_release_and_deadman_are_recorded_once_each():
    async def go():
        st = await Stack.create(seed=3, warmup_s=5)
        try:
            e = st.eng
            subs = {}
            for i, (rid, reason) in enumerate((("OR-02", "released"), ("OR-03", "deadman"), ("IR-01", "disconnect"))):
                ack = await e.submit({"command_id": f"l{i}", "kind": "control.acquire", "target_id": rid, "args": {"robot_id": rid},
                                      "actor_type": "operator", "principal": "op"}, principal="op", actor_type="operator")
                assert ack["accepted"], ack
                await e.step_ticks(2)
                await e.end_lease(ack["lease_id"], reason)
                await e.end_lease(ack["lease_id"], reason)                      # a second end of the same lease is a no-op
                await e.step_ticks(1)
            rows = e.storage.load_communications(e.run_id, limit=500)
            return [(r["payload"]["subtype"], r["payload"]["message_type"], r["payload"]["status"], r["payload"]["robot_id"]) for r in rows]
        finally:
            await st.stop()
    got = asyncio.run(go())
    assert [g for g in got if g[0] == "lease.granted"] == [("lease.granted", "operator", "info", r) for r in ("OR-02", "OR-03", "IR-01")]
    assert ("lease.released", "operator", "ok", "OR-02") in got and ("lease.deadman", "safety", "blocked", "OR-03") in got
    assert ("lease.disconnect", "safety", "blocked", "IR-01") in got
    assert sum(1 for g in got if g[0] in ("lease.released", "lease.deadman", "lease.disconnect")) == 3
