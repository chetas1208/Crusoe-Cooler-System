"""Held-out evaluation benchmark for Laya cooling incident classifier.
Produces precision, recall, confusion matrix, calibration, abstention rate,
and p50/p95 latency metrics per Section 8 of LOOPKEEPER V5.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List
import numpy as np

from loopkeeper.intelligence.laya_classifier import LayaIncidentClassifier

# 30 evaluation cases (5 per class). They were written once, independently of the rule fallback's keywords and BEFORE any
# Laya result was seen; nothing (rules, thresholds, questions) was tuned on them afterwards. Wording deliberately avoids the
# rule keywords where possible. Note it is a small synthetic set: treat accuracy as indicative only.
def _c(i, gt, asset, summary, **kw):
    return {"id": f"H-{i:02d}", "asset_id": asset, "summary": summary, "ground_truth": gt, **kw}

BENCHMARK_CASES = [
    # exterior_service: accessible external hardware (strainer / valve / fitting / pump housing)
    _c(1, "exterior_service", "strainer_02", "Basket on the TCS inlet filter is plugged with debris; pressure across it jumped sharply.", delta_kpa=61.0),
    _c(2, "exterior_service", "valve_za", "Hall A isolation valve actuator does not follow its command and sits partly open."),
    _c(3, "exterior_service", "valve_b4", "Rack B4 balancing valve handwheel seized; position feedback stuck at 40 percent."),
    _c(4, "exterior_service", "strainer_01", "Duplex filter element on the facility-water skid needs a swap, differential pressure above limit.", delta_kpa=47.0),
    _c(5, "exterior_service", "pump_f2", "Standby facility pump coupling guard loose and shaft seal weeping at the housing."),
    # inpipe_inspection: reachable internal deposits / lumen obstruction
    _c(6, "inpipe_inspection", "p_17", "Hall B supply header shows a growing scale layer on the inner wall; pressure loss climbing slowly.", delta_kpa=14.0),
    _c(7, "inpipe_inspection", "p_22", "Return header throughput is down and flow per rack is uneven, consistent with build-up inside the run."),
    _c(8, "inpipe_inspection", "p_02", "Mineral crust suspected inside the DN200 supply line between the pump skid and the CDU."),
    _c(9, "inpipe_inspection", "p_10", "Bore narrowing on the TCS trunk reduces flow; the section is large enough for a crawler to enter."),
    _c(10, "inpipe_inspection", "p_27", "Sludge accumulation along the lower wall of the Hall B return line."),
    # hydraulics_review: loop pressure / flow / pump head
    _c(11, "hydraulics_review", "pump_t1", "Duty circulation pump head is falling and vibration rose; loop flow is below the design point."),
    _c(12, "hydraulics_review", "pump_f1", "Facility water loop pressure sags when the second pump starts; flow split looks imbalanced."),
    _c(13, "hydraulics_review", "sn_flow_trunk", "Total TCS flow dropped 18 percent while valve positions are unchanged; check the pump curve and loop resistance."),
    _c(14, "hydraulics_review", "p_12", "Zone A and zone B flows diverged by a factor of two after a valve maintenance window."),
    _c(15, "hydraulics_review", "cdu_01", "CDU secondary loop differential pressure is well under the setpoint with the pump at full speed."),
    # thermal_review: rack load / thermal margin / CDU heat exchange
    _c(16, "thermal_review", "rack_a1", "GPU training rack chip temperature is within 4 K of the throttle limit under sustained load.", thermal_margin_c=4.0),
    _c(17, "thermal_review", "rack_b2", "Return coolant temperature from the rack rose 6 degrees; heat load is above its usual profile.", thermal_margin_c=7.0),
    _c(18, "thermal_review", "cdu_01", "CDU approach temperature widened, so the heat exchanger is rejecting less power than the racks produce."),
    _c(19, "thermal_review", "rack_a2", "Thermal margin shrinking after a workload surge across the AI pod.", thermal_margin_c=3.2),
    _c(20, "thermal_review", "rack_b1", "Hot spot reported at the cold plate outlet while flow looks nominal.", thermal_margin_c=5.1),
    # sensor_validation: drifting / conflicting / impossible telemetry
    _c(21, "sensor_validation", "sn_flow_za", "Zone A flow meter reads 1.2 kg/s above the sum of the rack meters while pressures are steady."),
    _c(22, "sensor_validation", "sn_flow_trunk", "Trunk flow transmitter has crept upward over an hour with no change anywhere else in the loop."),
    _c(23, "sensor_validation", "sn_rack_a3", "Rack A3 branch meter shows a negative flow value which is physically impossible."),
    _c(24, "sensor_validation", "sn_flow_zb", "Two redundant meters on zone B disagree by 15 percent; which one is lying?"),
    _c(25, "sensor_validation", "sn_flow_zb", "Reading froze at an identical value for ten minutes then jumped; suspect transmitter fault."),
    # human_review: ambiguous / insufficient / high-impact
    _c(26, "human_review", "unknown", "Several alarms at once with no clear pattern; operator input needed before any action."),
    _c(27, "human_review", "plant", "Request to isolate the whole CDU loop for maintenance during peak load."),
    _c(28, "human_review", "p_12", "Pressure drop and a drifting meter appear together; the evidence contradicts itself."),
    _c(29, "human_review", "misc", "Operator note: something sounds odd near the mechanical room. No readings available."),
    _c(30, "human_review", "plant", "Proposal to cut and replace a live high pressure pipe section while the hall is running."),
]

CATEGORIES = ["inpipe_inspection", "exterior_service", "hydraulics_review", "thermal_review", "sensor_validation", "human_review"]


def _evaluate(engine: str) -> Dict[str, Any]:
    clf = LayaIncidentClassifier(use_router=(engine == "laya_router"))
    if engine == "laya_router":
        if clf._get_router() is None:
            return {"engine": engine, "available": False, "reason": clf._router_error or "Laya SDK not importable"}
        clf.classify_incident({"summary": "warm-up"})            # first call loads the weights: exclude it from latency
        clf.total_queries = clf.total_abstentions = clf.router_calls = clf.fallback_calls = 0
    idx = {c: i for i, c in enumerate(CATEGORIES)}
    matrix = np.zeros((len(CATEGORIES), len(CATEGORIES)), dtype=int)
    lat, results, abst = [], [], 0
    for case in BENCHMARK_CASES:
        dec = clf.classify_incident(case)
        lat.append(dec.latency_ms)
        abst += int(dec.abstained)
        matrix[idx[case["ground_truth"]], idx[dec.task_family]] += 1
        results.append({"case_id": case["id"], "ground_truth": case["ground_truth"], "predicted": dec.task_family, "engine": dec.engine,
                        "confidence": dec.confidence, "urgency": dec.urgency, "abstained": dec.abstained, "latency_ms": dec.latency_ms})
    correct = int(np.trace(matrix))
    per = {}
    for i, cat in enumerate(CATEGORIES):
        tp = int(matrix[i, i]); fp = int(matrix[:, i].sum()) - tp; fn = int(matrix[i, :].sum()) - tp
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        per[cat] = {"precision": round(prec, 3), "recall": round(rec, 3), "f1": round(2 * prec * rec / (prec + rec), 3) if prec + rec else 0.0,
                    "support": int(matrix[i, :].sum())}
    # abstention is correct when the ground truth is human_review; wrong when it swallows an answerable case
    answerable = [r for r in results if r["ground_truth"] != "human_review"]
    return {
        "engine": engine, "available": True, "total_cases": len(BENCHMARK_CASES), "accuracy": round(correct / len(BENCHMARK_CASES), 4),
        "accuracy_answerable_only": round(sum(r["predicted"] == r["ground_truth"] for r in answerable) / len(answerable), 4),
        "abstention_rate": round(abst / len(BENCHMARK_CASES), 4),
        "selective_accuracy_non_abstained": (round(sum(r["predicted"] == r["ground_truth"] for r in results if not r["abstained"]) /
                                                   max(1, sum(not r["abstained"] for r in results)), 4)),
        "n_non_abstained": sum(not r["abstained"] for r in results),
        "abstained_on_answerable": sum(r["abstained"] for r in answerable),
        "latency_p50_ms": round(float(np.percentile(lat, 50)), 2), "latency_p95_ms": round(float(np.percentile(lat, 95)), 2),
        "categories": CATEGORIES, "confusion_matrix_rows_truth_cols_pred": matrix.tolist(), "per_category_metrics": per, "case_details": results,
    }


def run_evaluation(write: bool = True) -> Dict[str, Any]:
    """Evaluate the real Laya router (if it loads here) and the rule fallback on the same 30 cases; report both, labelled."""
    out = {
        "benchmark_name": "Laya cooling-incident triage, 30 synthetic cases (5/class)",
        "caveats": ["small synthetic set written by the integrator; indicative only, no confidence intervals",
                    "Laya is evaluated zero-shot on the criteria in COOLING_QUESTIONS (no fine-tuning)",
                    "no rule, threshold or question was tuned on these cases after seeing results",
                    "the rule fallback is NOT Laya; its numbers must never be reported as Laya's"],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "hardware": "CPU (torch %s)" % (__import__("torch").__version__ if _has("torch") else "n/a"),
        "laya_sdk_commit": "4ac226d5ee88ed6df8db288a05c766d7a34ee682", "laya_checkpoint_revision": "convaiinnovations/laya@7b928d828b7b",
        "engines": {e: _evaluate(e) for e in ("laya_router", "rule_fallback")},
    }
    out["laya_router_ran"] = bool(out["engines"]["laya_router"].get("available"))
    if write:
        out_dir = Path(__file__).resolve().parents[4] / "artifacts" / "v5"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "laya_eval.json").write_text(json.dumps(out, indent=2))
    return out


def _has(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


if __name__ == "__main__":
    rep = run_evaluation()
    for name, e in rep["engines"].items():
        if not e.get("available"):
            print(name, "UNAVAILABLE:", e.get("reason"))
            continue
        print(f"{name}: acc {e['accuracy']*100:.1f}% (answerable {e['accuracy_answerable_only']*100:.1f}%), abstain {e['abstention_rate']*100:.1f}%, "
              f"p50 {e['latency_p50_ms']} ms p95 {e['latency_p95_ms']} ms")
