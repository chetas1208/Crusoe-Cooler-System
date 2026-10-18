"""V12 Laya advisory triage: frozen dataset, deterministic policy, safety override, and consistency of the published evaluation artifact.

No Laya weights are needed: the policy is tested on synthetic member probabilities, and the artifact checks read the committed JSON. Nothing here asserts
an accuracy target (zero-shot Laya has none); it asserts that what is reported is internally consistent and that the advisory never gains authority."""
from __future__ import annotations

import json
import math

import numpy as np
import pytest

from loopkeeper.intelligence import laya_cases as C
from loopkeeper.intelligence import laya_classifier as L
from loopkeeper.intelligence import laya_eval as E


# ---- frozen dataset ---------------------------------------------------------------------------------------------------------------
def test_dataset_is_frozen_and_large_enough():
    assert len(C.CASES) >= 120
    assert C.dataset_hash() == C.DATASET_SHA256, "dataset or split changed after it was frozen"
    assert len({c["summary"] for c in C.CASES}) == len(C.CASES)
    assert {c["ground_truth"] for c in C.CASES} == set(C.CATEGORIES)
    tags = {c["tag"] for c in C.CASES}
    assert {"negation", "multi_fault", "false_sensor", "vague", "unsafe_request", "plain"} <= tags


def test_split_is_stratified_hash_based_and_disjoint():
    ids = {s: {c["id"] for c in C.split(s)} for s in ("train", "dev", "test")}
    assert ids["train"].isdisjoint(ids["dev"]) and ids["train"].isdisjoint(ids["test"]) and ids["dev"].isdisjoint(ids["test"])
    assert sum(map(len, ids.values())) == len(C.CASES)
    for lab in C.CATEGORIES:
        per = {s: sum(1 for c in C.split(s) if c["ground_truth"] == lab) for s in ids}
        assert min(per.values()) >= 4, (lab, per)
    # split is a pure function of (id, label): rebuilding gives the same assignment
    again = {c["id"]: c["split"] for c in C._build()}
    assert again == {c["id"]: c["split"] for c in C.CASES}


# ---- question design ----------------------------------------------------------------------------------------------------------------
def test_at_most_six_distinct_choices_and_valid_permutations():
    for name, crit in L.CRITERIA_SETS.items():
        assert list(crit) == L.FAMILIES and len(crit) <= 6, name
    for o, perm in L.ORDERS.items():
        assert sorted(perm) == list(range(6)), o
    # no non-identity order leaves any option in its canonical slot, and every option is shown in at least two different slots across the three orders
    assert all(L.ORDERS[o][j] != j for o in ("rev", "rot3") for j in range(6))
    slots = {k: {L.ORDERS[o].index(k) for o in ("id", "rev", "rot3")} for k in range(6)}
    assert all(len(v) >= 2 for v in slots.values())
    qs = L.build_questions("v12", L.ORDER_SETS["orders3"])
    assert [k for k in qs if k.startswith("o_")] == ["o_id", "o_rev", "o_rot3"] and "option_order" not in qs["o_id"] and qs["o_rev"]["option_order"] == L.ORDERS["rev"]


def test_rephrase_is_deterministic_and_changes_wording():
    t = "Flow and pressure are normal and nothing is clogged; rack A2 simply runs hot under load."
    assert L.rephrase(t) == L.rephrase(t) != t
    assert L.state_variants(t, 1) == [t] and len(L.state_variants(t, 2)) == 2
    assert L.rephrase("Hot spot at a cold-plate outlet.") != "Hot spot at a cold-plate outlet."


# ---- policy on synthetic members ---------------------------------------------------------------------------------------------------
def _members(rows):
    return np.array(rows, dtype=float)


def _p(top: int, mass: float = 0.8):
    v = np.full(6, (1 - mass) / 5)
    v[top] = mass
    return v


def test_ensemble_consistency_and_flip_abstains():
    agree = _members([_p(2), _p(2), _p(2)])
    flip = _members([_p(2), _p(3), _p(2)])
    assert L.ensemble_probs(agree)[1] == 1.0 and math.isclose(L.ensemble_probs(flip)[1], 2 / 3)
    clf = L.LayaIncidentClassifier(use_router=False, calibration=L.Calibration(tau=0.3, min_consistency=1.0, fitted=True))
    ok = clf.triage_from_members("Duty pump head dropped.", agree, 0.0)
    assert not ok.abstained and ok.family == "hydraulics_review"
    bad = clf.triage_from_members("Duty pump head dropped.", flip, 0.0)
    assert bad.abstained and bad.family == "human_review" and bad.raw_family == "hydraulics_review" and "disagree" in bad.abstain_reasons[0]


def test_low_confidence_abstains_and_override_beats_everything():
    clf = L.LayaIncidentClassifier(use_router=False, calibration=L.Calibration(tau=0.6, min_consistency=0.0, fitted=True))
    low = clf.triage_from_members("Chip temperature is near the limit.", _members([np.full(6, 1 / 6)]), None)
    assert low.abstained and low.family == "human_review"
    confident_wrong = clf.triage_from_members("Bypass the pump interlock so we can service the seal while the pump is running.", _members([_p(3, 0.95)]), None)
    assert confident_wrong.raw_family == "thermal_review" and confident_wrong.family == "human_review" and confident_wrong.override and not confident_wrong.abstained


def test_noul_gate_only_when_configured():
    m = _members([_p(0)])
    off = L.LayaIncidentClassifier(use_router=False, calibration=L.Calibration(tau=0.0, noul_threshold=None)).triage_from_members("x", m, 0.99)
    on = L.LayaIncidentClassifier(use_router=False, calibration=L.Calibration(tau=0.0, noul_threshold=0.5)).triage_from_members("x", m, 0.99)
    assert not off.abstained and on.abstained


def test_calibration_scaling_properties():
    p = np.array([0.7, 0.1, 0.1, 0.05, 0.03, 0.02])
    assert np.isclose(L.calibrate(p, 1.0, None).sum(), 1.0)
    assert L.calibrate(p, 3.0, None).max() < p.max() < L.calibrate(p, 0.5, None).max()          # T>1 flattens, T<1 sharpens
    assert L.calibrate(p, 2.0, None).argmax() == 0
    bias = np.array([-5.0, 0, 0, 0, 0, 0])
    assert L.calibrate(p, 1.0, bias).argmax() != 0                                              # a bias can move the argmax


def test_temperature_fit_repairs_overconfidence():
    rng = np.random.default_rng(0)
    n = 400
    y = rng.integers(0, 6, n)
    P = np.zeros((n, 6))
    for i in range(n):
        top = y[i] if rng.random() < 0.5 else rng.integers(0, 6)            # 50 % accurate, but always 95 % confident
        P[i] = _p(top, 0.95)
    T, b = E.fit_temperature_bias(P, y, with_bias=False)
    assert b is None and T > 1.5

    def nll(T_):
        return -np.mean(np.log(L.calibrate(P, T_, None)[np.arange(n), y]))
    assert nll(T) < nll(1.0)


def test_utility_prefers_abstaining_over_confident_errors():
    wrong = [{"abstained": False, "pred": "thermal_review", "truth": "hydraulics_review"}]
    abst = [{"abstained": True, "pred": "human_review", "truth": "hydraulics_review"}]
    assert E.utility_of(abst) > E.utility_of(wrong)


# ---- engine labelling / advisory ----------------------------------------------------------------------------------------------------
def test_rule_fallback_is_labelled_advisory_and_override_applies():
    clf = L.LayaIncidentClassifier(use_router=False)
    d = clf.classify_incident({"summary": "Disable the leak alarm on row C so the contractors are not disturbed."})
    assert d.engine == "rule_fallback" and d.checkpoint is None and d.advisory is True
    assert d.task_family == "human_review" and d.safety_override and "laya" not in d.routing_rationale.lower().replace("laya_router", "")
    d2 = clf.classify_incident({"summary": "Basket on the inlet filter is plugged.", "asset_id": "strainer_01", "delta_kpa": 55.0})
    assert d2.engine == "rule_fallback" and d2.advisory is True and d2.to_dict()["advisory"] is True


def test_safety_override_is_deterministic_and_has_no_false_positives_on_the_dataset():
    assert L.safety_override("Bypass the interlock", "thermal_review") == ("human_review", L.safety_override("Bypass the interlock", "x")[1])
    benign = [c for c in C.CASES if c["tag"] != "unsafe_request"]
    assert [c["id"] for c in benign if L.safety_override(c["summary"], "thermal_review")[1]] == []
    train_unsafe = [c for c in C.split("train") if c["tag"] == "unsafe_request"]
    assert train_unsafe and all(L.safety_override(c["summary"], "x")[1] for c in train_unsafe)       # patterns were written from train misses


# ---- the published artifact ---------------------------------------------------------------------------------------------------------
def _artifact():
    if not E.V12_PATH.exists():
        pytest.skip("V12 artifact not generated yet")
    d = json.loads(E.V12_PATH.read_text())
    if d.get("benchmark") != "laya_v12_advisory":
        pytest.skip("artifact is not the V12 one")
    return d


def test_artifact_is_consistent_with_frozen_dataset():
    d = _artifact()
    assert d["dataset"]["sha256"] == C.DATASET_SHA256
    assert d["dataset"]["splits"] == {s: len(C.split(s)) for s in ("train", "dev", "test")}
    assert d["advisory_only"] is True and d["never_gates_actions"] is True
    n = d["dataset"]["splits"]["test"]
    for arm in ("laya_v12", "laya_v12_without_safety_override", "rules_NOT_LAYA"):
        m = d[arm]["confusion_matrix_rows_truth_cols_pred"]
        assert sum(map(sum, m)) == d[arm]["n"] == n, arm
        assert math.isclose(d[arm]["accuracy_advisory"], sum(m[i][i] for i in range(6)) / n, abs_tol=1e-3), arm
        lo, hi = d[arm]["accuracy_ci95"]
        assert lo <= d[arm]["accuracy_advisory"] <= hi
    nano = d["crusoe_nano"]
    if nano.get("n"):
        assert sum(map(sum, nano["confusion_matrix_rows_truth_cols_pred"])) == nano["n"]
    assert len(d["dev_candidates"]) == len(E.CANDIDATES) == len(d["ablation_held_out_all_candidates"])
    assert d["laya_v12"]["config"]["criteria"] == d["chosen_candidate"]["criteria"]


def test_calibration_file_matches_artifact_and_was_fitted_on_the_frozen_set():
    d = _artifact()
    cal = L.Calibration.load()
    assert cal.fitted and cal.dataset_sha256 == C.DATASET_SHA256
    cfg = d["laya_v12"]["config"]
    assert (cal.criteria, cal.temperature, cal.tau, cal.min_consistency, cal.noul_threshold) == (cfg["criteria"], cfg["temperature"], cfg["tau"], cfg["min_consistency"], cfg["noul_threshold"])
    assert "TRAIN" in cal.provenance


def test_status_block_matches_artifact_and_ui_shape():
    d = _artifact()
    blk = E.status_summary()
    assert blk["available"] is True and blk["source"].endswith("laya_eval.json")
    # the web app reads evaluation[engine].{accuracy, abstention_rate, latency_p95_ms}
    for eng in ("laya_router", "rule_fallback"):
        assert {"accuracy", "abstention_rate", "latency_p95_ms"} <= set(blk[eng])
    assert blk["laya_router"]["accuracy"] == d["laya_v12"]["accuracy_advisory"]
    assert blk["laya_router"]["abstention_rate"] == d["laya_v12"]["abstention_rate"]
