"""V12: the honest terminal states are produced END TO END (real physics plant + engine + agent runtime, deterministic stepping, no network):
CONTAINED_NOT_REPAIRED, PARTIAL, TIMED_OUT, ESCALATED (forbidden L3 + human approval request), UNKNOWN - plus the V12-review regressions for the
verifier / Definition of Done (fallback never verifies, restart keeps the frozen contract, absolute thresholds, pinned goal, hold floor, ...).

Each live case reads the same surfaces an operator does: the incident, the frozen contract, /incidents/{id}/contract|verifications, and the
Communications events (plain wording, no codes)."""
from __future__ import annotations

import asyncio
import copy
import inspect
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
from loopkeeper.orchestration import Limits, dod  # noqa: E402
from support.fixtures import TOKEN, make_settings  # noqa: E402

AUTH = {"Authorization": f"Bearer {TOKEN}"}
DONE = ("resolved", "escalated", "dismissed")
RAW = re.compile(r"CONTAINED_NOT_REPAIRED|TIMED_OUT|\bUNKNOWN\b|invalid args|traceback|pydantic|_kpa|kg_s|\bNone\b|\{'|\['", re.I)


async def inject(st: Stack, kind: str, target: str, **params) -> dict:
    st.n_cmd += 1
    return await st.eng.submit({"command_id": f"inj-{st.n_cmd}", "kind": "test.inject_fault", "args": {"kind": kind, "target": target, "params": params},
                                "actor_type": "operator"}, principal="test", actor_type="operator")


def surfaces(st: Stack) -> dict:
    """Everything an operator can see for the first incident, read through the public API and the Communications log."""
    inc = st.incidents()[0]
    app = TestClient(create_app(st.eng, settings=make_settings()))
    rid, iid = st.eng.run_id, inc["id"]
    body = app.get(f"/api/v1/runs/{rid}/incidents/{iid}/contract", headers=AUTH).json()
    vers = app.get(f"/api/v1/runs/{rid}/incidents/{iid}/verifications", headers=AUTH).json()["verifications"]
    summaries = app.get(f"/api/v1/runs/{rid}/contracts", headers=AUTH).json()["contracts"]
    rows = st.eng.storage.load_communications(rid, limit=1000)
    term = [r for r in rows if r["payload"]["subtype"] == "contract.terminal"]
    return {"inc": inc, "contract": body["contract"], "verifications": vers, "summaries": summaries, "terminal_events": term,
            "world_inc": next(i for i in st.eng.world()["incidents"] if i["id"] == iid), "open_keys": dict(st.rt.ctx.open_keys), "reopen_after": dict(st.rt._reopen_after)}


def assert_plain(out: dict, state: str) -> None:
    c = out["contract"]
    assert c["terminal_state"] == state and c["state"] in ("ESCALATED", "EVALUATING")
    text = c["outcome_text"]
    assert text and not RAW.search(text) and "operator" in text.lower(), text
    assert out["inc"]["summary"] == text or "operator" in out["inc"]["summary"].lower()
    assert not RAW.search(out["inc"]["summary"]), out["inc"]["summary"]
    assert [s["terminal_state"] for s in out["summaries"]] == [state]
    ev = out["terminal_events"]
    assert ev and text.startswith(ev[-1]["payload"]["summary"].rstrip("…")) and not RAW.search(ev[-1]["payload"]["summary"])
    fin = out["verifications"][-1]                                  # the final reading is a verification record (numbers only, never a pass)
    assert fin["status"] == "rejected" and fin["dod"]["terminal_state"] == state and fin["failed_reason"] == text
    assert all(isinstance(k["before"], (int, float)) and isinstance(k["after"], (int, float)) for k in fin["checks"])


# ───────────────────────────── CONTAINED_NOT_REPAIRED ─────────────────────────────
async def _contained() -> dict:
    """Both TCS pumps degrade: the standby is not healthy, so the pump cannot be swapped and no available tool repairs the loop. Racks stay inside limits."""
    st = await Stack.create(seed=3)
    try:
        await inject(st, "pump_degradation", "pump_t2", health_end=0.7, duration_s=5)        # the spare is unavailable (health < 0.9)
        await st.advance(20)
        await inject(st, "pump_degradation", "pump_t1", health_end=0.5, duration_s=60)
        assert await st.run_until(lambda: any(i["status"] in DONE for i in st.incidents()), 2400)
        await st.eng.commit()
        out = surfaces(st)
        out["tasks"] = st.tasks(out["inc"]["id"])
        out["margins"] = {r: st.eng.world()["assets"][r]["readings"]["margin_k"] for r in ("rack_a1", "rack_b1")}
        out["warn_k"] = st.rt.ctx.fac.warn_k
        return out
    finally:
        await st.stop()


@pytest.fixture(scope="module")
def contained() -> dict:
    return asyncio.run(_contained())


def test_contained_not_repaired_with_containment_evidence(contained):
    out = contained
    assert out["inc"]["status"] == "escalated" and out["inc"]["cause"] == "pump_degradation"
    assert_plain(out, "CONTAINED_NOT_REPAIRED")
    a = out["contract"]["assessment"]
    assert any("margin" in x.lower() for x in a["safe"]) and any("head" in x.lower() for x in a["unrepaired"])    # evidence: racks safe, the pump is not repaired
    ev = {e["check"]: e for e in a["evidence"]}
    assert ev["margin"]["status"] == "held" and ev["margin"]["measured"] >= ev["margin"]["target"] and ev["head"]["status"] == "failing"
    assert all(m >= out["warn_k"] for m in out["margins"].values())                  # the plant itself agrees: thermal margin is above the warning limit
    assert "safe for now" in out["contract"]["outcome_text"] and "still there" in out["contract"]["outcome_text"]
    assert out["contract"]["frozen_hash"] and out["contract"]["history"][-1]["final_reading"] is True
    assert any(t["kind"] == "assess" and t["agent_id"] == "SEN-05" for t in out["tasks"])


def test_contained_incident_frees_its_detector_anchor_with_a_cooldown(contained):
    assert contained["open_keys"] == {} and contained["reopen_after"]                # K-review: an escalated anchor is not silenced forever


# ───────────────────────────── PARTIAL ─────────────────────────────
async def _partial() -> dict:
    """Strainer replaced (flow and dP recover) while the facility supply temperature is too high for the racks to regain their margin."""
    st = await Stack.create(seed=3)
    try:
        r = st.eng.plant.apply({"kind": "set_chiller_setpoint", "args": {"supply_c": st.eng.plant.ctl["chiller_supply_c"] + 8.0}})
        assert r["ok"]
        await inject(st, "strainer_blockage", "strainer_02")
        assert await st.run_until(lambda: any(i["status"] in DONE for i in st.incidents()), 2400)
        await st.eng.commit()
        return surfaces(st)
    finally:
        await st.stop()


@pytest.fixture(scope="module")
def partial() -> dict:
    return asyncio.run(_partial())


def test_partial_recovery_flow_restored_margin_not(partial):
    out = partial
    assert out["inc"]["status"] == "escalated"
    assert_plain(out, "PARTIAL")
    ev = {e["check"]: e for e in out["contract"]["assessment"]["evidence"]}
    assert ev["flow"]["status"] == "held" and ev["margin"]["status"] == "failing"
    assert "partly recovered" in out["contract"]["outcome_text"].lower()
    attempts = [v for v in out["verifications"] if not v["dod"].get("terminal_state")]
    assert attempts and attempts[0]["status"] == "rejected"                            # the real repair was judged and rejected on margin before the final reading


# ───────────────────────────── TIMED_OUT ─────────────────────────────
async def _timed_out() -> dict:
    """Supervised plant: the brush-clear needs an operator approval; nobody answers inside the allowed time."""
    st = await Stack.create(seed=3, mode="supervised", limits=Limits(approval_mode="supervised", hold_timeout_s=90.0, stuck_stage_s=100000.0))
    try:
        await inject(st, "fouling", "p_hs_b")
        assert await st.run_until(lambda: any(i["status"] in DONE for i in st.incidents()), 2400)
        await st.eng.commit()
        return surfaces(st)
    finally:
        await st.stop()


@pytest.fixture(scope="module")
def timed_out() -> dict:
    return asyncio.run(_timed_out())


def test_timed_out_when_the_approval_deadline_passes(timed_out):
    out = timed_out
    assert out["inc"]["status"] == "escalated" and out["world_inc"]["approval"]["status"] == "expired"
    assert_plain(out, "TIMED_OUT")
    assert "approval" in out["contract"]["outcome_text"].lower() and out["contract"]["escalation_reason"]


# ───────────────────────────── ESCALATED (forbidden L3) ─────────────────────────────
async def _l3() -> dict:
    """Policy forbids autonomous L3 work: the zone-isolating valve service becomes a human approval request, the agent does not act."""
    st = await Stack.create(seed=3, limits=Limits(approval_mode="autonomous"))        # l3_requires_human defaults to True (never auto-approved, in any mode)
    try:
        await inject(st, "valve_stuck", "valve_b1")
        assert await st.run_until(lambda: any(i["status"] in DONE for i in st.incidents()), 1800)
        await st.eng.commit()
        out = surfaces(st)
        out["missions"] = [m for m in st.eng.missions.missions.values() if m["kind"] in ("clear", "service")]
        out["isolated"] = st.eng.world()["assets"]["valve_zb"]["status"]
        return out
    finally:
        await st.stop()


@pytest.fixture(scope="module")
def l3() -> dict:
    return asyncio.run(_l3())


def test_forbidden_l3_escalates_with_a_human_approval_request(l3):
    out = l3
    assert out["inc"]["status"] == "escalated"
    assert_plain(out, "ESCALATED")
    ap = out["world_inc"]["approval"]
    assert ap["status"] == "pending" and ap["auto_approve_at_s"] is None and "L3" in ap["action"]          # waiting for a person, never auto-approved
    assert out["missions"] == [] and out["isolated"] != "isolated"                                          # nothing was executed
    assert "high impact" in out["contract"]["outcome_text"].lower()


# ───────────────────────────── UNKNOWN ─────────────────────────────
async def _unknown() -> dict:
    """The repair keeps failing; when the agent takes its final reading the plant solver reports non-convergence: nothing can be confirmed."""
    st = await Stack.create(seed=3)
    try:
        real = st.eng.missions.create
        st.eng.missions.create = lambda args, issuer, cid: (False, "invalid args - steps.0.id: Extra inputs are not permitted", None) if args.get("kind") == "service" else real(args, issuer, cid)
        real_health = st.eng.plant.solver_health

        def bad_health() -> dict:
            if any(i["attempts"] >= 2 for i in st.incidents()):
                return {"converged": False, "degraded": True, "residual": 1.0, "reason": "test: solver did not converge"}
            return real_health()
        st.eng.plant.solver_health = bad_health
        await inject(st, "strainer_blockage", "strainer_02")
        assert await st.run_until(lambda: any(i["status"] in DONE for i in st.incidents()), 3000)
        await st.eng.commit()
        return surfaces(st)
    finally:
        await st.stop()


@pytest.fixture(scope="module")
def unknown() -> dict:
    return asyncio.run(_unknown())


def test_unknown_when_the_solver_gives_no_trustworthy_reading(unknown):
    out = unknown
    assert out["inc"]["status"] == "escalated"
    assert_plain(out, "UNKNOWN")
    a = out["contract"]["assessment"]
    assert a["unknown"] and not a["safe"] and "neither confirmed nor ruled out" in out["contract"]["outcome_text"]
    assert all(e["status"] == "unknown" for e in a["evidence"])


# ───────────────────────────── terminal_of precedence + wording (unit) ─────────────────────────────
def _c(layer_a: str, checks: dict, lb: dict | None = None) -> dict:
    return {"evaluation": {"layer_a": layer_a, "layer_b": lb, "checks": {k: {"status": v} for k, v in checks.items()}},
            "checks": [{"id": k, "type": k, "label": k.capitalize(), "unit": "x", "direction": "min", "threshold": 1.0, "hold_sim_s": 20.0} for k in checks]}


def test_terminal_precedence_and_plain_wording():
    held_flow = {"flow": "held", "margin": "failing"}
    assert dod.terminal_of(_c("FAIL", held_flow), escalated=True, timed_out=True) == "TIMED_OUT"
    assert dod.terminal_of(_c("FAIL", held_flow), escalated=True, human_required=True) == "ESCALATED"
    assert dod.terminal_of(_c("FAIL", {"margin": "held", "head": "failing"}), escalated=True) == "CONTAINED_NOT_REPAIRED"
    assert dod.terminal_of(_c("FAIL", held_flow), escalated=True) == "PARTIAL"
    assert dod.terminal_of(_c("UNKNOWN", {"margin": "unknown"}), escalated=True) == "UNKNOWN"
    assert dod.terminal_of(_c("FAIL", {"flow": "failing"}), escalated=True) == "ESCALATED"
    for state in dod.TERMINAL:
        text = dod.outcome_text(_c("FAIL", {"margin": "held", "head": "failing"}), state, "the approval window ended without an approval")
        assert text and not RAW.search(text) and "_" not in text, (state, text)


# ───────────────────────────── review regressions ─────────────────────────────
def test_fallback_concur_is_never_verified_but_a_model_concur_is():
    """Z1 #1: unreviewed != concur. VERIFIED needs layer_b.source == 'model' and verdict == 'concur'."""
    fb = _c("PASS", {"flow": "held"}, {"verdict": "unreviewed", "source": "fallback"})
    assert dod.terminal_of(fb, escalated=False) == "PARTIAL" and "no independent review" in dod.outcome_text(fb, "PARTIAL")
    fb["evaluation"]["layer_b"] = {"verdict": "concur", "source": "fallback"}              # even a (legacy) concur from the fallback does not count
    assert dod.terminal_of(fb, escalated=False) == "PARTIAL"
    fb["evaluation"]["layer_b"] = {"verdict": "concur", "source": "model"}
    assert dod.terminal_of(fb, escalated=False) == "VERIFIED"

    async def go(client):
        st = await Stack.create(seed=3, model_client=client)
        try:
            await inject(st, "strainer_blockage", "strainer_02")
            assert await st.run_until(lambda: any(i["status"] in DONE for i in st.incidents()), 1800)
            await st.eng.commit()
            return surfaces(st)
        finally:
            await st.stop()
    no_model = asyncio.run(go(None))
    assert no_model["inc"]["status"] == "resolved"                                         # the plant really recovered ...
    c = no_model["contract"]
    assert c["terminal_state"] == "PARTIAL" and c["needs_review"] is True and c["terminal_state"] != "VERIFIED"      # ... but nobody independent confirmed it
    assert c["evaluation"]["layer_b"]["verdict"] == "unreviewed" and c["evaluation"]["layer_b"]["source"] == "fallback"
    assert no_model["verifications"][-1]["dod"]["independently_reviewed"] is False
    assert [s["terminal_state"] for s in no_model["summaries"]] == ["PARTIAL"]
    with_model = asyncio.run(go(FakeModelClient()))
    assert with_model["inc"]["status"] == "resolved" and with_model["contract"]["terminal_state"] == "VERIFIED"
    assert with_model["contract"]["evaluation"]["layer_b"]["source"] == "model"


def test_restart_keeps_the_frozen_contract_and_escalates_when_it_is_gone():
    """Z1 #2: a graph relaunched without a checkpoint carries the FROZEN contract; attempts > 0 with no contract escalates instead of bypassing the DoD."""
    async def go():
        st = await Stack.create(seed=3)
        try:
            await inject(st, "strainer_blockage", "strainer_02")
            assert await st.run_until(lambda: bool(st.eng.track.contracts), 900)
            inc = copy.deepcopy(st.incidents()[0])
            frozen = st.eng.track.contracts[inc["id"]]["frozen_hash"]
            st.rt._tasks[inc["id"]].cancel()
            await asyncio.gather(st.rt._tasks[inc["id"]], return_exceptions=True)
            launched: list = []
            st.rt._launch = lambda iid, init: launched.append((iid, init))
            st.rt.ctx.decisions.run_id = "fresh-run"                                          # no checkpoint under this thread id
            await st.rt.resume([inc])
            return frozen, launched
        finally:
            await st.stop()
    frozen, launched = asyncio.run(go())
    assert launched and launched[0][1]["dod"]["frozen_hash"] == frozen

    async def lost():
        st = await Stack.create(seed=3)
        try:
            await inject(st, "strainer_blockage", "strainer_02")
            assert await st.run_until(lambda: bool(st.eng.track.contracts), 900)
            inc = copy.deepcopy(st.incidents()[0])
            st.rt._tasks[inc["id"]].cancel()
            await asyncio.gather(st.rt._tasks[inc["id"]], return_exceptions=True)
            st.eng.track.contracts.pop(inc["id"])
            st.eng.track.dirty_contracts.discard(inc["id"])
            inc["attempts"] = 1
            st.rt.ctx.decisions.run_id = "fresh-run-2"
            await st.rt.resume([inc])
            assert await st.run_until(lambda: any(i["status"] == "escalated" for i in st.incidents()), 900)
            return st.incidents()[0]["summary"]
        finally:
            await st.stop()
    assert "lost" in asyncio.run(lost()).lower()


def test_thresholds_are_absolute_not_derived_from_the_faulted_baseline():
    """Z1 #3: worse damage must not loosen the pass bar."""
    from loopkeeper.orchestration.analysis import COLLATERAL_MAX_PCT, DRIFT_COLLATERAL_MAX_PCT, checks_for

    async def go():
        st = await Stack.create(seed=3)
        try:
            ctx = st.rt.ctx
            after = {"flow": 10.0, "flow_ref": 10.0, "dp_ratio": 1.0, "margin": 20.0, "margin_excl": 0, "collateral": 0.01, "collateral_skipped": 0, "residual_kg_s": 0.0,
                     "tol_kg_s": 0.1}
            out = {}
            for before_collat in (0.0, 0.30):
                b = {"flow": 1.0, "dp_ratio": 3.0, "margin": 1.0, "collateral": before_collat}
                for cause, tgt in (("fouling", "p_hs_b"), ("sensor_drift", "sn_flow_zb")):
                    ck = {c["id"]: c for c in checks_for(ctx, {"cause": cause, "target_id": tgt, "affected": []}, b, after)}
                    out[(cause, before_collat)] = ck["collateral"]["target"]
            return out
        finally:
            await st.stop()
    out = asyncio.run(go())
    assert out[("fouling", 0.0)] == out[("fouling", 0.30)] == COLLATERAL_MAX_PCT
    assert out[("sensor_drift", 0.0)] == out[("sensor_drift", 0.30)] == DRIFT_COLLATERAL_MAX_PCT


def test_goal_scope_subjects_hold_floor_before_and_scope_check():
    """Z1 important M items: a revision cannot rewrite the goal / scope / subjects, the initial hold has a floor, `before` is carried, out-of-scope subjects are refused."""
    async def go():
        st = await Stack.create(seed=3)
        try:
            await inject(st, "strainer_blockage", "strainer_02")
            assert await st.run_until(lambda: bool(st.eng.track.contracts), 900)
            ctx = st.rt.ctx
            c = copy.deepcopy(next(iter(st.eng.track.contracts.values())))
            det = {"cause": "strainer_blockage", "target_id": "strainer_02", "affected": [], "anchor_id": "strainer_02"}
            from loopkeeper.orchestration.analysis import compute_metrics, healthy_reference, other_affected
            racks = ctx.fac.scope_racks(det["cause"], det["target_id"])
            after0 = compute_metrics(ctx, det, c["incident_id"], healthy_reference(ctx, racks, other_affected(ctx, c["incident_id"])), None)
            res = {}
            for name, draft in {"short_hold": {"goal": "g", "subject_asset_ids": ["strainer_02"], "hold_sim_seconds": 21, "checks": []},
                                "out_of_scope": {"goal": "g", "subject_asset_ids": [next(a for a in ctx.fac.assets if a.startswith("dock_"))], "checks": []},
                                "ok": {"goal": "g", "subject_asset_ids": ["strainer_02"], "hold_sim_seconds": 40, "checks": []}}.items():
                try:
                    dod.compile_contract(ctx, det, c["incident_id"], draft, {}, after0, window_s=55.0, source={})
                    res[name] = "ok"
                except dod.ContractError as e:
                    res[name] = "; ".join(e.reasons)
            return c, ctx, res
        finally:
            await st.stop()
    c, ctx, res = asyncio.run(go())
    assert res["ok"] == "ok" and "outside the allowed" in res["short_hold"] and "outside the incident scope" in res["out_of_scope"]
    assert c["scope"]["subjects"] and c["before"]
    new = copy.deepcopy(c)
    new["goal"] = "something much easier"
    assert any("goal" in e for e in dod.not_looser(c, new))
    new = copy.deepcopy(c)
    new["scope"]["target_id"] = "strainer_01"
    assert any("scope" in e for e in dod.not_looser(c, new))
    new = copy.deepcopy(c)
    new["scope"]["subjects"] = []
    new["checks"][0]["subject"] = []
    assert any("subject" in e for e in dod.not_looser(c, new))

    class Ctx:
        tick = 3
    tighter = copy.deepcopy(c)
    tighter["checks"][0]["hold_sim_s"] += 10
    tighter["before"] = None                                                         # a proposal that lost its baseline ...
    rev = dod.revise(Ctx(), c, tighter, "longer hold")
    assert rev["before"] == c["before"] and rev["goal"] == c["goal"]                 # ... still carries the frozen one and the pinned goal


def test_transient_fallbacks_are_not_frozen_and_budgets_are_evicted():
    from loopkeeper.intelligence.crusoe import IntelligenceConfig, ModelError, ModelStatus
    from loopkeeper.intelligence.decisions import DecisionRequest, DecisionService, MemoryDecisionStore

    async def go():
        store = MemoryDecisionStore()
        status = ModelStatus("mock", "fake-model", "live", "")
        svc = DecisionService(FakeModelClient(fail=ModelError("provider down", 503)), status, store, run_id="r")
        req = DecisionRequest(kind="escalate", key="INC-1:t1:escalate", payload={"reason": "x"}, fallback=lambda: {"summary": "fb"}, incident_id="INC-1", task_id="t1")
        res = await svc.decide(req)
        assert res.source == "fallback"
        assert await store.get("r:INC-1:t1:escalate") is None                         # an outage is not replayed forever after a restart
        # a deterministic runtime without any model client still records its (permanent) fallback
        svc2 = DecisionService(None, ModelStatus("deterministic", "d", "fallback", "no key"), store, run_id="r2")
        await svc2.decide(DecisionRequest(kind="escalate", key="INC-2:t1:escalate", payload={}, fallback=lambda: {"summary": "fb"}, incident_id="INC-2", task_id="t1"))
        assert await store.get("r2:INC-2:t1:escalate") is not None
        svc.budget("INC-1")
        assert "INC-1" in svc._budgets and "INC-1" in svc._inc_sem
        svc.release("INC-1")
        assert "INC-1" not in svc._budgets and "INC-1" not in svc._inc_sem
    asyncio.run(go())


def test_memory_promotion_needs_a_reviewed_recovery_and_expiry_sweep_is_throttled():
    from loopkeeper.memory.hooks import _verification
    from loopkeeper.memory.ablation import make_brain

    class C:
        tick = 1

        class engine:
            run_id = "r"
    inc = {"id": "INC-1", "verification": {"id": "v1", "checks": []}}
    assert _verification({"verify": {"ok": True, "reviewed": True}}, inc, C)["status"] == "verified"
    assert _verification({"verify": {"ok": True, "reviewed": False}}, inc, C)["status"] == "unknown"      # fallback-concur: stays proposed
    assert _verification({"verify": {"ok": False}}, inc, C)["status"] == "rejected"
    t = [1000.0]
    scans = []
    brain = make_brain(True, clock=lambda: t[0])
    real = brain.store.select
    brain.store.select = lambda *a, **k: (scans.append(1), real(*a, **k))[1]
    brain.expire_sweep(min_interval_s=60.0)
    first = len(scans)
    brain.expire_sweep(min_interval_s=60.0)
    assert len(scans) == first                                                       # throttled: no second full scan within the interval
    t[0] += 61
    brain.expire_sweep(min_interval_s=60.0)
    assert len(scans) > first and brain.expire_sweep() == 0                           # the unthrottled call still scans


def test_nav_route_preview_runs_on_the_engine_loop():
    from loopkeeper.api import routes_nav
    assert inspect.iscoroutinefunction(routes_nav.route_plan)                        # was a threadpool `def` mutating shared navigator state off the loop


# ───────────────────────────── real Crusoe model, once, capped at $1 (opt-in: LIVE_CRUSOE=1) ─────────────────────────────
def _env_file_model_vars() -> dict:
    import os
    env = {k: v for k, v in os.environ.items() if k.startswith(("CRUSOE_", "MODEL_", "INTELLIGENCE_"))}
    p = Path(__file__).resolve().parents[2] / ".env"
    if p.exists() and not env.get("CRUSOE_API_KEY"):
        for line in p.read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip().startswith(("CRUSOE_", "MODEL_", "INTELLIGENCE_")) and v.strip():
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


@pytest.mark.skipif(not __import__("os").environ.get("LIVE_CRUSOE"), reason="opt-in: LIVE_CRUSOE=1 spends real model tokens (hard cap $1)")
def test_live_crusoe_contained_not_repaired_with_the_real_model():
    """The same CONTAINED_NOT_REPAIRED case with the real Crusoe client answering SEN-01..05. Spend is metered here and capped at $1: the wrapper stops calling
    (-> labelled deterministic fallback) once the catalog-priced estimate reaches the cap. The result is written to artifacts/v12/terminal_live_crusoe.json."""
    import httpx
    from loopkeeper.inference.catalog import parse_models
    from loopkeeper.intelligence.crusoe import CrusoeClient, IntelligenceConfig, ModelError

    cfg = IntelligenceConfig.from_env(_env_file_model_vars())
    assert cfg.configured, "CRUSOE_API_KEY missing"
    price = {}
    try:
        r = httpx.get(cfg.base_url.rstrip("/") + "/models", headers={"Authorization": f"Bearer {cfg.api_key}"}, timeout=20)
        price = parse_models(r.json())
    except Exception:                                                                                          # noqa: BLE001
        price = {}
    cap_usd, state = 1.0, {"usd": 0.0, "tok_in": 0, "tok_out": 0, "calls": 0, "blocked": 0}

    class Metered(CrusoeClient):
        async def complete_json(self, *, system, user, schema_name, max_tokens=700, timeout_s=None, **_gateway_only):      # the plain client has no gateway kwargs
            kw = dict(system=system, user=user, schema_name=schema_name, max_tokens=max_tokens, timeout_s=timeout_s)
            info = price.get(self.model_id)
            worst = (state["tok_in"] + state["tok_out"]) * 5e-6                                                # unknown price: assume a pessimistic $5/M
            if (state["usd"] if info and info.price_in_per_mtok is not None else worst) >= cap_usd:
                state["blocked"] += 1
                raise ModelError("spend cap reached", 429)
            resp = await super().complete_json(**kw)
            state["calls"] += 1
            state["tok_in"] += resp.tokens_in or 0
            state["tok_out"] += resp.tokens_out or 0
            c = info.cost_usd(resp.tokens_in, resp.tokens_out) if info else None
            state["usd"] += c if c is not None else ((resp.tokens_in or 0) + (resp.tokens_out or 0)) * 5e-6
            return resp

    async def go():
        st = await Stack.create(seed=3, model_client=Metered(cfg))
        try:
            await inject(st, "pump_degradation", "pump_t2", health_end=0.7, duration_s=5)
            await st.advance(20)
            await inject(st, "pump_degradation", "pump_t1", health_end=0.5, duration_s=60)
            assert await st.run_until(lambda: any(i["status"] in DONE for i in st.incidents()), 2400)
            await st.eng.commit()
            out = surfaces(st)
            out["model"] = {"provider": st.rt.status.provider, "model_id": st.rt.status.model_id, "status": st.rt.status.status}
            return out
        finally:
            await st.stop()
    out = asyncio.run(go())
    assert state["usd"] < cap_usd and out["model"]["provider"] == "crusoe"
    assert out["contract"]["terminal_state"] in ("CONTAINED_NOT_REPAIRED", "ESCALATED", "PARTIAL"), out["contract"]["terminal_state"]   # the model can phrase, never force a pass
    assert out["contract"]["terminal_state"] != "VERIFIED" and not RAW.search(out["inc"]["summary"])
    art = Path(__file__).resolve().parents[2] / "artifacts" / "v12"
    art.mkdir(parents=True, exist_ok=True)
    (art / "terminal_live_crusoe.json").write_text(json.dumps({"model": out["model"], "terminal_state": out["contract"]["terminal_state"], "outcome_text": out["contract"]["outcome_text"],
                                                               "assessment": out["contract"].get("assessment"), "spend": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in state.items()},
                                                               "note": "real Crusoe client, in-memory run, seed 3; usd is the catalog-priced estimate (pessimistic $5/M when unpriced)"}, indent=1, default=str))


def test_empty_rack_scope_does_not_crash_the_incident_graph():
    """SOAK-03: a fault on a header outside the facility's rack scope (p_hs_e) must not raise inside compute_metrics (empty `racks` in margin_all)."""
    async def go():
        st = await Stack.create(seed=5, model_client=FakeModelClient())
        try:
            await inject(st, "fouling", "p_hs_e")
            await st.advance(300, 2.0)
            return list(st.rt.errors), [i["id"] for i in st.incidents()]
        finally:
            await st.stop()
    errors, incs = asyncio.run(go())
    assert errors == [] and incs
