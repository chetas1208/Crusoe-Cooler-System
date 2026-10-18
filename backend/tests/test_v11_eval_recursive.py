"""V11 recursive arm + memory ablation + scorecard v2: statistics helpers, runtime harness on the real plant (no model, no network), memory preload/export,
artifact integrity. The real-Crusoe runs themselves are produced offline by `python -m loopkeeper.eval.recursive_runner` (spend logged in the scorecard)."""
from __future__ import annotations

import asyncio
import json

import pytest

from loopkeeper.eval import fixtures as F
from loopkeeper.eval import scorecard as SC
from loopkeeper.eval.recursive import export_brain, preload_brain, run_recursive
from loopkeeper.eval.runner import aggregate
from loopkeeper.memory.ablation import make_brain, record_episode
from loopkeeper.memory.store import store_for
from loopkeeper.storage.memory import MemoryStorage


def run(c):
    return asyncio.run(c)


def row(s, seed, claim=True, rec=True, fs=False, **kw):
    return {"scenario_id": s, "seed": seed, "arm": "recursive", "claim_success": claim, "recovered": rec, "false_success": fs, "false_success_final": False, "safe_at_claim": not fs, "was_harmed": True,
            "recover_after_onset_s": 700.0 if rec else None, "contained_after_onset_s": 0.0, "final": {}, "decision": {"claim": "resolved"}, "cost_usd": 0.003, "tokens": 5000, "actions_traced": 1, "actions_total": 1,
            "unsafe_proposed": 0, "unsafe_blocked": 0, "call_ids": [], **kw}


# ---------------------------------------------------------------- statistics
def test_cluster_ci_is_wide_when_scenarios_disagree_and_degenerate_when_they_agree():
    same = {f"S{i}": [1.0] * 10 for i in range(9)}
    assert SC.cluster_ci(same) == [1.0, 1.0]
    mixed = {f"S{i}": [float(i % 2)] * 10 for i in range(9)}                   # 9 scenarios, rates 0/1: seeds identical inside, scenarios differ
    lo, hi = SC.cluster_ci(mixed)
    assert lo < 0.45 < 0.55 < hi and hi - lo > 0.3                          # n_runs=90 Wilson would claim a far narrower interval
    w = SC.wilson(40, 90)
    assert (w[1] - w[0]) < (hi - lo)
    assert SC.cluster_ci({"only": [1.0]}) == [None, None]


def test_rate_reports_both_intervals_and_per_scenario_counts():
    rows = [row("A", i) for i in range(10)] + [row("B", i, claim=False, rec=False) for i in range(10)]
    r = SC.rate(rows, SC._verified)
    assert (r["k"], r["n"], r["rate"]) == (10, 20, 0.5) and r["per_scenario"] == {"A": 1.0, "B": 0.0}
    assert r["wilson95_n_runs"][0] < 0.5 < r["wilson95_n_runs"][1]


def test_seed_variation_detects_identical_cells():
    rows = [row("A", i) for i in range(10)] + [row("B", i, claim=bool(i % 2)) for i in range(10)]
    v = SC.seed_variation(rows)
    assert v["scenarios"] == 2 and v["scenarios_with_identical_outcome_across_seeds"] == 1


def test_paired_delta_counts_wins_losses_ties_and_drops_missing_metrics():
    a = [row("A", i, rec=False, claim=False) for i in range(4)] + [row("B", i) for i in range(4)]
    b = [row("A", i) for i in range(4)] + [row("B", i) for i in range(3)]       # B seed 3 missing from b
    p = SC.paired(a, b, SC._verified, "verified")
    assert p["n_pairs"] == 7 and p["wins_b"] == 4 and p["losses_b"] == 0 and p["ties"] == 3 and p["dropped"] == 1
    t = SC.paired([row("A", 0, rec=False)], [row("A", 0)], lambda r: r.get("recover_after_onset_s"), "rec")
    assert t["n_pairs"] == 0 and t["mean_delta_b_minus_a"] is None            # a metric missing on one side is dropped, never imputed


def test_memory_verdict_says_no_difference_when_it_is_not_measurable():
    off = [row(s, i) for s in SC.ABLATION_SCENARIOS for i in range(5)]
    on = [dict(r) for r in off]
    me = SC.mem_effect(off, [dict(r) for r in off], on)
    assert SC.verdict(me).startswith("NO MEASURABLE DIFFERENCE") and me["n"] == {"off": 20, "off2": 20, "on": 20}
    on2 = [row(s, i, claim=(s != SC.ABLATION_SCENARIOS[0] or i % 2 == 0)) for s in SC.ABLATION_SCENARIOS for i in range(5)]
    assert SC.verdict(SC.mem_effect(off, off, on2)).startswith(("NO MEASURABLE", "MEASURABLE"))      # never claims more than the CI supports


def test_aggregate_recursive_counts_runtime_support_and_replans():
    rows = [row("CR-06", i, n_incidents=1, incidents=[{"cause": "strainer_blockage", "status": "resolved"}], replan={"cases": 1, "recovered": 1}, tasks={"model": 5, "fallback": 1},
                model_calls={"network": 8, "errors": []}, commands_submitted=1, detect_latency_s=58.5) for i in range(3)]
    rows += [row("CR-02", i, claim=False, rec=False, n_incidents=0, incidents=[], replan={"cases": 0, "recovered": 0}, tasks={"model": 0, "fallback": 0}, model_calls={"network": 0, "errors": []}, undetected=True) for i in range(3)]
    a = SC.agg_recursive(rows, "recursive")
    assert a["replan_recovery"]["incidents_with_a_rejected_first_attempt"] == 3 and a["no_incident_undetected_runs"] == 3
    ps = a["per_scenario_runtime"]
    assert ps["CR-06"]["runtime_status"] == "SUPPORTED" and ps["CR-02"]["runtime_status"].startswith("UNSUPPORTED") and ps["CR-02"]["no_incident_undetected"] == 3
    assert a["verified_completion"]["k"] == 3 and a["verified_completion"]["n"] == 6 and a["false_success"]["k"] == 0


# ---------------------------------------------------------------- memory ablation plumbing
def test_brain_export_preload_roundtrip_is_isolated_per_run():
    brain = make_brain(True)
    record_episode(brain, run_id="train_1", facility_id="f1", fault_kind="strainer_blockage", asset_type="strainer", action="replace_strainer", verified=True, verification_id="v1", evidence_ids=["e1"])
    st = MemoryStorage()
    st2 = store_for(st)
    for kind, t in brain.store._t.items():
        for r in t.values():
            st2.insert(kind, dict(r))
    rows = export_brain(st)
    assert any(rows.values())
    a, b = MemoryStorage(), MemoryStorage()
    preload_brain(a, rows)
    preload_brain(b, rows)
    assert export_brain(a) == export_brain(b) == rows
    assert export_brain(MemoryStorage()) == {k: [] for k in rows}                 # a fresh storage has an empty brain: no leakage between runs
    from loopkeeper.eval.recursive_runner import ABLATION_SCENARIOS
    assert not set(F.DEV_SEEDS) & set(F.HELD_OUT_SEEDS) and ABLATION_SCENARIOS


# ---------------------------------------------------------------- the runtime on the real plant (no model, no network, no Neon)
def test_runtime_arm_reports_unsupported_scenarios_instead_of_faking_a_result(monkeypatch):
    monkeypatch.delenv("CRUSOE_API_KEY", raising=False)
    monkeypatch.setenv("DATABASE_URL", "postgresql://must-never-be-used.invalid/db")
    r = run(run_recursive("MD-02", F.HELD_OUT_SEEDS[0], use_model=False, horizon_s=600.0))
    assert "error" not in r and r["arm"] == "recursive" and r["use_model"] is False
    assert r["n_incidents"] == 0 and r["undetected"] is True and r["claim_success"] is False and r["false_success"] is False
    assert r["model_calls"]["network"] == 0 and r["cost_usd"] == 0 and r["recovered"] is False        # sensor bias is still active: truth is not safe, and nobody claimed otherwise
    assert r["decision"]["claim"] == "none" and r["memory"] is False


def test_runtime_arm_verifies_a_real_strainer_fault_with_truth_agreement(monkeypatch):
    monkeypatch.delenv("CRUSOE_API_KEY", raising=False)
    r = run(run_recursive("MD-01", F.HELD_OUT_SEEDS[0], use_model=False))
    assert r["n_incidents"] == 1 and r["incidents"][0]["terminal_state"] == "VERIFIED" and r["incidents"][0]["status"] == "resolved"
    assert r["claim_success"] and r["safe_at_claim"] is True and r["false_success"] is False and r["recovered"] and r["recover_after_onset_s"] > 120
    assert r["actions_total"] >= 1 and r["actions_traced"] == r["actions_total"] and r["unsafe_executed"] == 0
    assert r["detect_latency_s"] is not None and r["tasks"]["fallback"] > 0 and r["tasks"]["model"] == 0       # labelled deterministic fallback, never presented as a model
    agg = aggregate([r], "recursive")
    assert agg["verified_completion"]["k"] == 1 and agg["false_success"]["k"] == 0


# ---------------------------------------------------------------- artifact integrity (skipped until the artifacts exist)
SCORE = F.ROOT / "artifacts" / "v11" / "scorecard.json"
DOC = F.ROOT / "docs" / "engineering" / "V11_SCORECARD.json"


@pytest.mark.skipif(not DOC.exists(), reason="run python -m loopkeeper.eval.scorecard")
def test_git_visible_scorecard_copy_matches_the_artifact_and_keeps_the_baseline():
    d = json.loads(DOC.read_text())
    assert d["schema"] == "lk.scorecard.v2" and d["arms"]["recursive"]["n_runs"] >= 1
    if SCORE.exists():
        assert json.loads(SCORE.read_text())["manifest_sha256"] == d["manifest_sha256"]
    v1 = json.loads((F.ROOT / "artifacts/v11/scorecard_v1_baseline.json").read_text()) if (F.ROOT / "artifacts/v11/scorecard_v1_baseline.json").exists() else None
    if v1:
        for a in ("no_action", "static", "single_pass"):
            assert d["arms"][a]["verified_completion"] == v1["arms"][a]["verified_completion"]            # baseline arms were not re-run or rewritten
    s = d["spend"]
    assert s["total_this_work_usd"] <= s["cap_usd"] and d["arms"]["recursive"]["false_success"]["definition"]
