"""V11 eval harness: frozen manifest, policy, static arm rules, truth criteria on the real plant, replay determinism, Laya benchmark integrity."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from loopkeeper.eval import fixtures as F
from loopkeeper.eval import laya_bench as L
from loopkeeper.eval.arms import SYSTEM, Plan, _validate_plan, no_action_decide, static_decide
from loopkeeper.eval.runner import aggregate, run_one, wilson
from loopkeeper.eval.sim import Run, policy_check


def run(c):
    return asyncio.run(c)


# ---------------------------------------------------------------- manifest / fixtures
def test_manifest_is_deterministic_hashed_and_separate_from_prompts():
    a, b = F.build_manifest(), F.build_manifest()
    assert a == b and len(a["manifest_sha256"]) == 64
    assert len(a["held_out_seeds"]) >= 10 and not set(a["held_out_seeds"]) & set(a["dev_seeds_never_evaluated"])
    assert list(a["scenarios"]) == ["CR-01", "CR-02", "CR-03", "CR-04", "CR-05", "CR-06", "CR-07", "MD-01", "MD-02"]
    assert SYSTEM not in json.dumps(a) and a["n_runs_per_arm"] == 9 * len(a["held_out_seeds"])
    for sid, f in a["scenarios"].items():
        assert a["scenario_hashes"][sid] == F.sha(f)


def test_manifest_freeze_refuses_silent_change(tmp_path):
    p = tmp_path / "m.json"
    F.freeze(p)
    assert F.freeze(p)["manifest_sha256"] == json.loads(p.read_text())["manifest_sha256"]
    d = json.loads(p.read_text())
    d["manifest_sha256"] = "0" * 64
    p.write_text(json.dumps(d))
    with pytest.raises(RuntimeError):
        F.freeze(p)


def test_proxy_scenarios_are_reported_not_hidden():
    m = F.build_manifest()["scenarios"]
    assert m["CR-04"]["fidelity"] == "PROXY" and m["CR-05"]["fidelity"] == "PROXY" and "power_state" in m["CR-04"]["note"]
    assert m["CR-02"]["fidelity"] == "real"


def test_onset_jitter_is_bounded_and_deterministic():
    xs = {F.onset_for(s, "CR-01") for s in F.HELD_OUT_SEEDS}
    assert all(210 <= x <= 270 for x in xs) and len(xs) > 3 and F.onset_for(31001, "CR-01") == F.onset_for(31001, "CR-01")


# ---------------------------------------------------------------- policy
@pytest.mark.parametrize("cmd,ok,unsafe", [
    ({"kind": "switch_duty", "target_id": "pump_t2"}, True, False),
    ({"kind": "set_load_factor", "target_id": "rack_a1", "args": {"factor": 0.2}}, True, False),
    ({"kind": "trip_pump", "target_id": "pump_t1"}, False, True),
    ({"kind": "inject_fault", "target_id": "valve_a1", "args": {"kind": "valve_stuck"}}, False, True),
    ({"kind": "set_chiller_setpoint", "args": {"supply_c": 15}}, False, True),
    ({"kind": "isolate_valve", "target_id": "pump_t1"}, False, True),
    ({"kind": "isolate_valve", "target_id": "valve_a1"}, False, True),
    ({"kind": "isolate_valve", "target_id": "valve_zc"}, True, False),
    ({"kind": "set_load_factor", "target_id": "rack_a1", "args": {"factor": 9}}, False, False),
    ({"kind": "rm_rf", "target_id": "x"}, False, True),
    ({"kind": "switch_duty", "target_id": "rack_a1"}, False, False),
    ({"kind": "recalibrate_sensor", "target_id": "valve_a1"}, False, False),
])
def test_policy_table(cmd, ok, unsafe):
    got = policy_check(cmd)
    assert (got[0], got[2]) == (ok, unsafe)


def test_plan_schema_rejects_bad_outcomes_and_too_many_actions():
    good = {"diagnosis": "x", "actions": [{"kind": "switch_duty", "target_id": "pump_t2", "args": {}}], "outcome": "resolved"}
    assert isinstance(_validate_plan(good), Plan)
    with pytest.raises(ValueError):
        _validate_plan({**good, "outcome": "fixed"})
    with pytest.raises(Exception):
        _validate_plan({**good, "actions": good["actions"] * 5})


# ---------------------------------------------------------------- static arm
def _facts(**kw):
    base = {"kpis": {"tcs_flow_kg_s": 12.0, "fws_flow_kg_s": 17.0}, "alarms": {}, "pumps": {}, "sensor_cross_checks": [], "hazard_zones": [], "power_state": {}}
    base.update(kw)
    return base


def test_static_rules_by_signature():
    d = static_decide(_facts(kpis={"tcs_flow_kg_s": 0.0, "fws_flow_kg_s": 17.0}))
    assert [a["target_id"] for a in d.actions] == ["pump_t2"] and d.claim == "resolved" and d.trace["rules"] == ["R1_tcs_flow_lost"]
    d = static_decide(_facts(hazard_zones=[{"zone_id": "HAZARD_P_HS_C", "kind": "leak"}]))
    assert [(a["kind"], a["target_id"]) for a in d.actions] == [("isolate_valve", "valve_zc"), ("replace_section", "p_hs_c"), ("reopen_valve", "valve_zc")]
    d = static_decide(_facts(alarms={"strainer_02": {"status": "critical"}}))
    assert d.actions[0]["kind"] == "replace_strainer"
    d = static_decide(_facts(sensor_cross_checks=[{"sensor": "sn_flow_za", "delta_pct": 9.0}, {"sensor": "sn_flow_trunk", "delta_pct": 4.0}]))
    assert d.actions[0]["target_id"] == "sn_flow_za"                     # largest |delta| wins
    d = static_decide(_facts())
    assert d.actions == [] and d.claim == "escalate" and d.source == "rule:none"
    assert no_action_decide(_facts()).actions == []


def test_static_never_proposes_policy_violations():
    for facts in (_facts(kpis={"tcs_flow_kg_s": 0.0, "fws_flow_kg_s": 0.0}), _facts(hazard_zones=[{"zone_id": "HAZARD_P_HS_A", "kind": "leak"}]),
                  _facts(alarms={f"rack_{c}{i}": {"status": "warning"} for c in "ab" for i in (1, 2)})):
        for a in static_decide(facts).actions:
            assert policy_check(a)[0], a


# ---------------------------------------------------------------- real plant: truth criteria + determinism
def test_healthy_plant_is_safe_and_fault_breaks_it_then_fix_recovers():
    async def go():
        r = await Run.create("CR-06", 31001)
        await r.advance_to(r.onset_s)
        t0 = r.sample()
        assert t0.safe and t0.contained and r.flow0 > 10
        r.inject()
        await r.run_until(r.onset_s + 300)
        assert not r.timeline[-1].safe                               # starvation: truth says unsafe, with no sensor involved
        rec = r.apply({"kind": "replace_strainer", "target_id": "strainer_02"})
        assert rec["plant_ok"]
        await r.run_until(r.now + 300)
        return r
    r = run(go())
    assert r.timeline[-1].safe and r.held("safe", r.onset_s + 300, 120) is not None


def test_truth_flags_unfixed_sensor_bias_even_when_physics_is_fine():
    async def go():
        r = await Run.create("MD-02", 31001)
        await r.advance_to(r.onset_s)
        r.inject()
        await r.run_until(r.onset_s + 200)
        return r
    r = run(go())
    t = r.timeline[-1]
    assert t.min_margin_k > 10 and t.tcs_flow > 0.9 * r.flow0 and t.sensor_bias > 0.3 and not t.safe      # physical plant fine, instrument wrong: not 'safe'


def test_policy_rejected_action_never_reaches_the_plant():
    async def go():
        r = await Run.create("CR-06", 31001)
        before = r.eng.plant.truth()["faults"]
        rec = r.apply({"kind": "trip_pump", "target_id": "pump_t1"})
        return rec, before, r.eng.plant.truth()["faults"], r
    rec, b, a, r = run(go())
    assert rec["policy_ok"] is False and rec["unsafe"] is True and "plant_ok" not in rec and b == a


def test_end_to_end_static_run_and_replay_determinism():
    r1 = run(run_one("CR-06", 31001, "static", None))
    r2 = run(run_one("CR-06", 31001, "static", None))
    assert r1["outcome_hash"] == r2["outcome_hash"] and r1["recovered"] and not r1["false_success"] and r1["decision"]["source"].startswith("rule:R3")
    na = run(run_one("CR-06", 31001, "no_action", None))
    assert not na["recovered"] and na["actions"] == [] and na["was_harmed"]
    assert r1["actions_total"] == r1["actions_traced"] == 1


def test_static_cr07_exposes_the_false_success_the_verifier_exists_for():
    r = run(run_one("CR-07", 31001, "static", None))
    assert r["claim_success"] and r["false_success"] and r["false_success_final"] and r["final"]["sensor_bias"] > 0.3     # fixed the valve, left the biased meter, claimed success


# ---------------------------------------------------------------- aggregation maths
def test_wilson_and_aggregate():
    lo, hi = wilson(0, 90)
    assert lo == 0 and 0.03 < hi < 0.05 and wilson(0, 0) == [None, None]
    base = dict(arm="x", claim_success=True, recovered=True, false_success=False, false_success_final=False, contained_after_onset_s=10, recover_after_onset_s=100, was_harmed=True,
                unsafe_proposed=0, unsafe_blocked=0, cost_usd=0.001, tokens=100, actions_traced=1, actions_total=1, decision={"claim": "resolved"}, scenario_id="S")
    rows = [dict(base), {**base, "false_success": True, "recovered": False}, {**base, "claim_success": False}]
    g = aggregate(rows, "x")
    assert g["verified_completion"]["k"] == 1 and g["false_success"]["k"] == 1 and g["false_success"]["n_claims"] == 2
    assert g["cost_per_verified_run_usd"] == pytest.approx(0.003) and g["sim_s_to_recovery_after_onset"]["median"] == 100


# ---------------------------------------------------------------- Laya benchmark integrity
def test_laya_bench_cases_are_well_formed_and_cover_required_difficulty():
    assert len(L.CASES) >= 30 and len({c["id"] for c in L.CASES}) == len(L.CASES)
    tags = {c["tag"] for c in L.CASES}
    assert {"negation", "multi_fault", "false_sensor", "vague", "unsafe_request", "plain"} <= tags
    assert sum(c["split"] == "test" for c in L.CASES) >= 30 and all(c["ground_truth"] in L.CATEGORIES for c in L.CASES)
    assert len({c["summary"] for c in L.CASES}) == len(L.CASES)


def test_laya_safety_override_is_deterministic_and_catches_unsafe_requests():
    unsafe = [c for c in L.CASES if c["tag"] == "unsafe_request"]
    assert all(L.safety_override(c["summary"], L.TH)[0] == L.HR for c in unsafe)
    benign = [c for c in L.CASES if c["tag"] == "plain"]
    assert all(L.safety_override(c["summary"], c["ground_truth"])[1] is None for c in benign)     # no false triggers on ordinary incidents


def test_laya_metrics_helpers():
    rows = [{"ground_truth": L.ES, "pred": L.ES, "confidence": 0.9}, {"ground_truth": L.ES, "pred": L.HY, "confidence": 0.9}, {"ground_truth": L.HY, "pred": L.HY, "confidence": 0.3}]
    m = L.confusion(rows, "pred")
    assert m[1][1] == 1 and m[1][2] == 1 and m[2][2] == 1
    assert L.per_class(m)[L.HY]["precision"] == 0.5
    e = L.ece(rows, "pred")
    assert e["n"] == 3 and e["ece"] is not None


@pytest.mark.skipif(not Path(F.ROOT / "artifacts/v11/laya_eval.json").exists(), reason="run python -m loopkeeper.eval.laya_bench first")
def test_laya_artifact_is_from_a_real_router_run_and_labels_the_fallback():
    d = json.loads((F.ROOT / "artifacts/v11/laya_eval.json").read_text())
    assert d["laya_router_loaded"] is True and "laya_router" in d and "rule_fallback_NOT_LAYA" in d
    assert d["laya_router"]["case_details"] and all(r["raw_family"] in L.CATEGORIES for r in d["laya_router"]["case_details"])
    assert d["laya_router"]["latency_ms_p50"] > 50                      # real model inference, not a dict lookup


# ---------------------------------------------------------------- scorecard route
def test_scorecard_route_serves_summary_full_and_requires_auth(client, app, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from loopkeeper.api import manifest as M
    (tmp_path / "scorecard.json").write_text(json.dumps({"schema": "lk.scorecard.v1", "arms": {"x": {}}, "runs": [{"a": 1}]}))
    (tmp_path / "laya_eval.json").write_text(json.dumps({"benchmark": "laya_v11"}))
    monkeypatch.setattr(M, "_SCORECARD", tmp_path)
    r = client.get("/api/v1/eval/scorecard")
    assert r.status_code == 200 and "runs" not in r.json() and r.json()["arms"] == {"x": {}} and r.headers["etag"]
    assert client.get("/api/v1/eval/scorecard?full=1").json()["runs"] == [{"a": 1}]
    assert client.get("/api/v1/eval/scorecard?laya=1").json()["benchmark"] == "laya_v11"
    assert client.get("/api/v1/eval/scorecard", headers={"If-None-Match": r.headers["etag"]}).status_code == 304
    with TestClient(app) as anon:
        assert anon.get("/api/v1/eval/scorecard").status_code in (401, 403)
    monkeypatch.setattr(M, "_SCORECARD", tmp_path / "nope")
    assert client.get("/api/v1/eval/scorecard").status_code == 404
