"""V11 Gate 1: executable Definition of Done. SEN-01 drafts, a deterministic compiler validates + FREEZES before any repair, Layer A evaluates with hold
timers (UNKNOWN on missing data), Layer B (SEN-05) can never force a pass, honest terminal states, loop / drift guards, liveness guard, read APIs."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent / "agents"))

from agent_fakes import FakeModelClient  # noqa: E402
from live_harness import Stack  # noqa: E402
from loopkeeper.api import create_app  # noqa: E402
from loopkeeper.orchestration import dod  # noqa: E402
from support.fixtures import TOKEN, make_settings  # noqa: E402

AUTH = {"Authorization": f"Bearer {TOKEN}"}
TERMINAL = ("resolved", "escalated", "dismissed")
ART = Path(__file__).resolve().parents[2] / "artifacts" / "v11"


async def _signature(model_client=None) -> dict:
    """First repair (brush) is insufficient -> verifier rejects -> SEN-01 replans -> second action restores -> sustained checks pass."""
    st = await Stack.create(seed=3, model_client=model_client)
    try:
        await st.inject("fouling", "p_hs_b")
        await st.advance(4)
        st.eng.plant.faults.occl["p_hs_b"] = 0.62
        st.eng.plant._hard = True
        st.eng.plant.fault_mgr.halt("p_hs_b", st.eng.plant.time)
        st.eng.missions._plant_args = lambda effect, target, args: ({"removed_fraction": 0.1} if effect == "brush_clear" else {})
        assert await st.run_until(lambda: any(i["status"] in TERMINAL for i in st.incidents()), 1800)
        await st.eng.commit()
        inc = st.incidents()[0]
        return {"eng": st.eng, "inc": inc, "contract": st.eng.track.contracts[inc["id"]], "storage": st.eng.storage, "run_id": st.eng.run_id,
                "occl": st.eng.plant.faults.occl.get("p_hs_b", 0.0), "tasks": st.tasks(inc["id"]), "client": model_client}
    finally:
        await st.stop()


@pytest.fixture(scope="module")
def flow() -> dict:
    return asyncio.run(_signature())


def test_signature_flow_reject_replan_restore_sustained_pass(flow):
    inc, c = flow["inc"], flow["contract"]
    assert inc["status"] == "resolved" and inc["attempts"] == 1
    assert flow["occl"] < 0.05                                           # the physics really recovered
    h = c["history"]
    assert [x["layer_a"] for x in h] == ["FAIL", "PASS"] and h[1]["layer_b"] == "concur"
    assert c["state"] == "VERIFIED" and c["terminal_state"] == "VERIFIED"
    ev = c["evaluation"]
    assert all(x["status"] == "held" and x["held_s"] >= next(k for k in c["checks"] if k["id"] == i)["hold_sim_s"] for i, x in ev["checks"].items())
    vers = sorted(flow["eng"].track.verifications.values(), key=lambda v: v["attempt"])
    assert [v["status"] for v in vers] == ["rejected", "verified"] and vers[0]["dod"]["layer_a"] == "FAIL" and vers[1]["dod"]["frozen_hash"] == c["frozen_hash"]


def test_contract_was_frozen_before_any_repair_was_dispatched(flow):
    rows = flow["storage"].load_communications(flow["run_id"], limit=1000)
    seq_of = lambda sub: next(r["seq"] for r in rows if r["payload"]["subtype"] == sub)       # noqa: E731
    frozen = seq_of("contract.frozen")
    first_dispatch = next(r["seq"] for r in rows if r["payload"]["subtype"] == "mission.ack" and r["payload"]["payload"].get("kind") in ("clear", "service"))      # repairs; inspection / return are not repairs
    assert seq_of("contract.proposed") < frozen < first_dispatch < seq_of("verification.started")
    c = flow["contract"]
    assert c["frozen_hash"] and c["frozen_tick"] <= min(m["opened_tick"] for m in flow["eng"].missions.missions.values() if m["kind"] in ("clear", "service"))
    # thresholds come from the plant configuration / verifier checks, never from the model draft
    assert all(k["source"] in ("mandatory", "model") and isinstance(k["threshold"], float) for k in c["checks"])
    assert dod.freeze_hash(c) == c["frozen_hash"] or c["version"] > 1


def test_goalposts_cannot_move_revisions_are_versioned_and_never_looser(flow):
    c = flow["contract"]
    base = json.loads(json.dumps(c))
    base["version"] = 1
    looser = json.loads(json.dumps(base))
    k = looser["checks"][0]
    k["threshold"] = k["threshold"] * (0.5 if k["direction"] == "min" else 2.0)
    assert any("relaxed" in e for e in dod.not_looser(base, looser))
    dropped = json.loads(json.dumps(base))
    dropped["checks"] = dropped["checks"][1:]
    assert any("removed" in e for e in dod.not_looser(base, dropped))
    shorter = json.loads(json.dumps(base))
    shorter["checks"][0]["hold_sim_s"] -= 5
    assert any("hold shortened" in e for e in dod.not_looser(base, shorter))
    tighter = json.loads(json.dumps(base))
    tighter["checks"][0]["hold_sim_s"] += 10
    assert dod.not_looser(base, tighter) == []

    class Ctx:                                                          # revise() only needs a tick
        tick = 9
    with pytest.raises(dod.ContractError):
        dod.revise(Ctx(), base, base, "")                                # a reason is mandatory
    with pytest.raises(dod.ContractError):
        dod.revise(Ctx(), base, looser, "because")
    new = dod.revise(Ctx(), base, tighter, "longer hold after a partial result")
    assert new["version"] == 2 and new["revisions"][-1]["reason"] and new["frozen_hash"] != base["frozen_hash"]


def test_compiler_refuses_unknown_assets_unallowlisted_and_inapplicable_checks():
    async def go():
        st = await Stack.create(seed=3, warmup_s=70)
        try:
            await st.inject("strainer_blockage", "strainer_02")
            assert await st.run_until(lambda: any(i["status"] != "" for i in st.incidents()), 400)
            ctx = st.rt.ctx
            det = next(iter(ctx.ledger.incidents.values()))
            from loopkeeper.orchestration.analysis import compute_metrics, healthy_reference, other_affected
            d = {"cause": "strainer_blockage", "target_id": "strainer_02", "affected": [], "anchor_id": "strainer_02"}
            racks = ctx.fac.scope_racks(d["cause"], d["target_id"])
            after0 = compute_metrics(ctx, d, det["id"], healthy_reference(ctx, racks, other_affected(ctx, det["id"])), None)
            before = dict(after0)
            out = {}
            for name, draft in {
                "unknown": {"goal": "g", "subject_asset_ids": ["warp_core_9"], "checks": []},
                "inapplicable": {"goal": "g", "subject_asset_ids": ["strainer_02"], "checks": [{"type": "bearing_vibration_max", "subject_asset_id": ""}]},
                "hold": {"goal": "g", "subject_asset_ids": ["strainer_02"], "hold_sim_seconds": 5, "checks": []},
                "ok": {"goal": "g", "subject_asset_ids": ["strainer_02"], "hold_sim_seconds": 40, "checks": [{"type": "no_active_uncontained_leak", "subject_asset_id": ""}]},
            }.items():
                try:
                    c = dod.compile_contract(ctx, d, det["id"], draft, before, after0, window_s=55.0, source={"source": "test"})
                    out[name] = ("ok", [k["id"] for k in c["checks"]], c["checks"][0]["hold_sim_s"])
                except dod.ContractError as e:
                    out[name] = ("refused", e.reasons)
            return out
        finally:
            await st.stop()
    out = asyncio.run(go())
    assert out["unknown"][0] == "refused" and "unknown asset id 'warp_core_9'" in out["unknown"][1][0]
    assert out["inapplicable"][0] == "refused" and "cannot be evaluated" in out["inapplicable"][1][0]
    assert out["hold"][0] == "refused" and "hold" in out["hold"][1][0]
    assert out["ok"][0] == "ok" and "leak" in out["ok"][1] and out["ok"][2] == 40.0


def test_layer_a_hold_timers_and_unknown_never_a_pass():
    ev = {"checks": {"flow": {"status": "passing", "held_s": 10}, "dp": {"status": "held", "held_s": 40}}}
    assert dod.verdict_a({"evaluation": ev}) == "FAIL"                                  # a check that has not held long enough is not a pass
    ev["checks"]["flow"]["status"] = "held"
    assert dod.verdict_a({"evaluation": ev}) == "PASS"
    ev["checks"]["dp"]["status"] = "unknown"
    assert dod.verdict_a({"evaluation": ev}) == "UNKNOWN"
    c = {"evaluation": {"layer_a": "UNKNOWN", "checks": ev["checks"]}}
    assert dod.terminal_of(c, escalated=False) == "UNKNOWN"
    c = {"evaluation": {"layer_a": "FAIL", "checks": {"margin": {"status": "held"}, "flow": {"status": "failing"}}}}
    assert dod.terminal_of(c, escalated=True) == "CONTAINED_NOT_REPAIRED"
    c = {"evaluation": {"layer_a": "FAIL", "checks": {"margin": {"status": "held"}, "flow": {"status": "held"}, "dp": {"status": "failing"}}}}
    assert dod.terminal_of(c, escalated=True) == "PARTIAL"
    assert dod.terminal_of({"evaluation": {"layer_a": "FAIL", "checks": {"flow": {"status": "failing"}}}}, escalated=True) == "ESCALATED"
    assert dod.terminal_of({"evaluation": {"layer_a": "FAIL", "checks": {"flow": {"status": "failing"}}}}, escalated=False, timed_out=True) == "TIMED_OUT"
    assert dod.terminal_of({"evaluation": {"layer_a": "PASS", "layer_b": {"verdict": "request_replan"}, "checks": {}}}, escalated=False) != "VERIFIED"


def test_solver_non_convergence_makes_checks_unknown():
    async def go():
        st = await Stack.create(seed=3, warmup_s=70)
        try:
            await st.inject("strainer_blockage", "strainer_02")
            assert await st.run_until(lambda: bool(st.eng.track.contracts), 900)
            ctx = st.rt.ctx
            c = next(iter(st.eng.track.contracts.values()))
            c = json.loads(json.dumps(c))
            dod.begin(ctx, c, 1)
            w = dict(ctx.world)
            w["health"] = {"solver": {"status": "failed"}}
            ctx.set_world(w)
            d = {"cause": c["scope"]["cause"], "target_id": c["scope"]["target_id"], "affected": [], "anchor_id": c["scope"]["target_id"]}
            dod.step(ctx, c, d, c.get("before") or {}, {"rack_flow_kg_s": {}, "tcs_flow_kg_s": 0, "fws_flow_kg_s": 0, "source": "t"}, None)
            return dod.verdict_a(c), {k: v["status"] for k, v in c["evaluation"]["checks"].items()}
        finally:
            await st.stop()
    verdict, statuses = asyncio.run(go())
    assert verdict == "UNKNOWN" and set(statuses.values()) == {"unknown"}


def test_layer_b_cannot_force_a_pass_and_model_drafts_are_compiled():
    """A reviewer that says 'concur' while Layer A FAILED is rejected by the validator (fallback request_replan); a model draft with an unknown asset is
    refused by the compiler and the labelled deterministic draft is used."""
    bad_draft = {"goal": "ship it", "subject_asset_ids": ["warp_core_9"], "hold_sim_seconds": 30, "checks": [], "reason": ""}
    cl = FakeModelClient(scripts={"dod_draft": [bad_draft], "dod_review": [{"verdict": "concur", "reasons": ["looks fine"], "extra_checks": []}]})

    async def go():
        out = await _signature(cl)
        return out
    out = asyncio.run(go())
    c = out["contract"]
    assert c["drafted_by"]["source"] == "fallback"
    rej = [tc for t in out["tasks"] if t["kind"] == "dod" for tc in t["tool_calls"] if tc["name"] == "model.propose.dod_draft"]
    assert rej and rej[0]["status"] == "rejected" and "unknown asset id 'warp_core_9'" in json.dumps(rej[0]["output"])
    assert c["history"][0]["layer_a"] == "FAIL" and c["history"][0]["layer_b"] != "concur"          # concur on a failed Layer A was not accepted
    assert out["inc"]["status"] == "resolved"                                                       # still honest: it closed only after a real recovery
    calls = [k for k, _ in cl.calls]
    assert "dod_draft" in calls and "dod_review" in calls


def test_loop_guard_repeat_plan_and_budget_escalate_with_visible_events():
    from loopkeeper.orchestration.graphs import dod_nodes as dn

    class B:
        exhausted = False
        used = 0

    class D:
        def budget(self, _i):
            return B()

    emitted = []

    class Ctx:
        decisions = D()

        def emit(self, t, e, p):
            emitted.append((t, p.get("kind")))

    class S:
        id = "INC-1"
    plan = {"action": "brush_clear", "target_id": "p_hs_b"}
    c = {"history": [{"plan_hash": dn.plan_hash(plan), "layer_a": "FAIL", "primary_delta": 0.3}]}
    assert "same plan" in dn.guard_progress(Ctx(), S(), c, plan)
    c = {"history": [{"plan_hash": "a", "layer_a": "FAIL", "primary_delta": 0.0}, {"plan_hash": "b", "layer_a": "FAIL", "primary_delta": 0.001}]}
    assert "no measurable physical improvement" in dn.guard_progress(Ctx(), S(), c, {"action": "replace_section", "target_id": "p_hs_b"})
    c = {"history": [{"plan_hash": str(i), "layer_a": "FAIL", "primary_delta": 0.2} for i in range(3)]}
    assert "plan revisions" in dn.guard_progress(Ctx(), S(), c, {"action": "x", "target_id": "y"})
    assert dn.guard_progress(Ctx(), S(), {"history": [{"plan_hash": "z", "layer_a": "FAIL", "primary_delta": 0.3}]}, plan) is None
    assert ("loop.detected", "repeat_plan_hash") in emitted and ("drift.detected", "no_physical_progress") in emitted


def test_task_dag_cycle_is_refused_and_seats_are_assigned(flow):
    from loopkeeper.orchestration.session import IncidentSession, PolicyReject
    seats = {t["kind"]: t["agent_id"] for t in flow["tasks"]}
    assert seats["classify"] == "SEN-01" and seats["verify"] == "SEN-05" and seats["safety"] == "SEN-04" and seats["dod"] == "SEN-01"
    assert any(t["agent_id"] == "SEN-02" for t in flow["tasks"]) or any(t["agent_id"] == "SEN-03" for t in flow["tasks"])
    s = object.__new__(IncidentSession)
    root = {"id": "t_1", "parent_id": None}
    mid = {"id": "t_2", "parent_id": "t_1"}
    leaf = {"id": "t_3", "parent_id": "t_2"}
    s.changed, s.known = {"t_1": root, "t_2": mid, "t_3": leaf}, {}
    assert s._cycle("t_1", leaf) is True and s._cycle("t_4", leaf) is False


def test_liveness_guard_escalates_a_stuck_incident_with_a_reason():
    async def go():
        st = await Stack.create(seed=3, warmup_s=70)
        try:
            st.rt.limits.stuck_stage_s = 60.0
            await st.inject("strainer_blockage", "strainer_02")
            assert await st.run_until(lambda: bool(st.incidents()), 600)
            iid = st.incidents()[0]["id"]
            task = st.rt._tasks[iid]
            task.cancel()                                                   # the graph dies silently (what a lost worker looks like)
            await asyncio.gather(task, return_exceptions=True)
            assert await st.run_until(lambda: st.incidents()[0]["status"] == "escalated", 600)
            await st.eng.commit()
            inc = st.incidents()[0]
            rows = st.eng.storage.load_communications(st.eng.run_id, limit=1000)
            return inc, [r["payload"]["subtype"] for r in rows]
        finally:
            await st.stop()
    inc, subs = asyncio.run(go())
    assert "Liveness guard" in inc["summary"] and "no agent graph is running" in inc["summary"]
    assert "drift.detected" in subs


def test_read_apis_contract_verifications_team(flow):
    c = TestClient(create_app(flow["eng"], settings=make_settings()))
    iid, rid = flow["inc"]["id"], flow["run_id"]
    body = c.get(f"/api/v1/runs/{rid}/incidents/{iid}/contract", headers=AUTH).json()
    assert body["contract"]["frozen_hash"] == flow["contract"]["frozen_hash"] and body["contract"]["terminal_state"] == "VERIFIED"
    assert c.get(f"/api/v1/runs/{rid}/incidents/INC-999/contract", headers=AUTH).status_code == 404
    v = c.get(f"/api/v1/runs/{rid}/incidents/{iid}/verifications", headers=AUTH).json()["verifications"]
    assert [x["status"] for x in v] == ["rejected", "verified"]
    t = c.get(f"/api/v1/runs/{rid}/incidents/{iid}/team", headers=AUTH).json()
    assert [s["seat"] for s in t["seats"]] == ["SEN-01", "SEN-02", "SEN-03", "SEN-04", "SEN-05"] and t["edges"] and t["budgets"]["max_depth_seen"] <= 3
    assert c.get("/api/v1/world", headers=AUTH).status_code == 200        # incident evidence kinds must stay inside the public contract (regression: 'contract' -> 500)
    assert c.get("/api/v1/world", headers=AUTH).status_code == 200        # again after the FULL cycle (verification checks must be plain numbers)
    assert all(isinstance(k["before"], (int, float)) and isinstance(k["after"], (int, float)) for vv in flow["eng"].track.verifications.values() for k in vv["checks"])
    assert c.get(f"/api/v1/runs/{rid}/contracts", headers=AUTH).json()["contracts"][0]["terminal_state"] == "VERIFIED"
    assert c.get(f"/api/v1/runs/{rid}/incidents/{iid}/contract").status_code == 401
    # persisted too (storage is the source for stored runs)
    rows = flow["storage"].load_contracts(rid, iid)
    assert rows and rows[0]["terminal_state"] == "VERIFIED" and rows[0]["doc"]["frozen_hash"] == flow["contract"]["frozen_hash"]
    ART.mkdir(parents=True, exist_ok=True)
    (ART / "dod_signature_flow.json").write_text(json.dumps({"contract": flow["contract"], "verifications": v, "team": t,
                                                              "note": "live-flow harness, seed 3, deterministic fallback (no model); fouling p_hs_b, brush insufficient then replan"},
                                                             indent=1, sort_keys=True, default=str))


def test_eval_table_is_numbers_only_even_for_unknown_and_leak_checks():
    c = {"checks": [{"id": "leak", "type": "no_active_uncontained_leak", "label": "L", "unit": "zones", "direction": "max", "threshold": 0.0, "hold_sim_s": 30}],
         "evaluation": {"checks": {"leak": {"status": "unknown", "measured": None, "held_s": 0.0}}}}
    r = dod.eval_table(c)[0]
    assert r["before"] == 0.0 and r["after"] == 0.0 and r["status"] == "unknown" and r["pass"] is False
