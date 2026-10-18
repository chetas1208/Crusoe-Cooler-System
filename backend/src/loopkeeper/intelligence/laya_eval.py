"""Held-out evaluation benchmark for Laya cooling incident classifier.
Produces precision, recall, confusion matrix, calibration, abstention rate,
and p50/p95 latency metrics per Section 8 of LOOPKEEPER V5.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
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


if __name__ == "__main__" and len(__import__("sys").argv) == 1:
    rep = run_evaluation()
    for name, e in rep["engines"].items():
        if not e.get("available"):
            print(name, "UNAVAILABLE:", e.get("reason"))
            continue
        print(f"{name}: acc {e['accuracy']*100:.1f}% (answerable {e['accuracy_answerable_only']*100:.1f}%), abstain {e['abstention_rate']*100:.1f}%, "
              f"p50 {e['latency_p50_ms']} ms p95 {e['latency_p95_ms']} ms")


# =====================================================================================================================================
# V12 (agent X): honest advisory-quality evaluation on the frozen 151-case set (train / dev / held-out), Laya vs rules vs Crusoe-Nano.
#   python -m loopkeeper.intelligence.laya_eval collect     # real Laya forward passes -> artifacts/v11/laya_v12_raw.jsonl (resumable)
#   python -m loopkeeper.intelligence.laya_eval nano        # real Crusoe-Nano calls (held-out + legacy), spend-capped -> artifacts/v11/laya_v12_nano.jsonl
#   python -m loopkeeper.intelligence.laya_eval run         # fit on train, choose on dev, report held-out once -> artifacts/v11/laya_eval.json (+ docs copy)
# =====================================================================================================================================
import asyncio                                                    # noqa: E402
import math                                                       # noqa: E402
import re as _re                                                  # noqa: E402

from loopkeeper.intelligence import laya_classifier as _L        # noqa: E402
from loopkeeper.intelligence import laya_cases as _C             # noqa: E402

_REPO = Path(__file__).resolve().parents[4]
ART_V11 = _REPO / "artifacts" / "v11"
RAW_PATH = ART_V11 / "laya_v12_raw.jsonl"
RAW_PATH_B = ART_V11 / "laya_v12_raw_b.jsonl"          # second collector process (v11 wording + legacy cases), merged on read
NANO_PATH = ART_V11 / "laya_v12_nano.jsonl"
V12_PATH = ART_V11 / "laya_eval.json"
DOC_COPY = _REPO / "docs" / "engineering" / "laya_eval_v12.json"
FAM = _L.FAMILIES
HR = "human_review"
UTILITY = {"correct_answer": 1.0, "wrong_answer": -2.0, "abstain_on_human_review_truth": 1.0, "abstain_otherwise": 0.0}
CANDIDATES = [(c, e, b) for c in ("v11", "v12") for e in ("single", "orders3", "orders3x2") for b in (False, True) if not (c == "v11" and e == "orders3x2")]   # declared before any result (v11 x reworded text dropped for CPU time)
ENS_SLICE = {"single": (0, 1), "orders3": (0, 3), "orders3x2": (0, 6)}


def case_text(c: Dict[str, Any], legacy: bool = False) -> str:
    if legacy:
        return LayaIncidentClassifier(use_router=False)._text(c)   # production text form (summary + asset / numeric hints), as the V11 benchmark fed it
    return c["summary"]


def legacy_cases() -> List[Dict[str, Any]]:
    """Agent C's 36 held-out V11 cases, kept as a second never-tuned test set (I read them while writing the new wording: disclosed in the artifact)."""
    try:
        from loopkeeper.eval.laya_bench import CASES as V11
    except Exception:                                              # noqa: BLE001
        return []
    out = []
    for c in V11:
        if c["split"] == "test":
            d = dict(c)
            d["id"] = "V11-" + c["id"]
            d["legacy"] = True
            out.append(d)
    return out


# ---------------- raw collection (the only place the Laya weights run) ----------------
def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(x) for x in path.read_text().splitlines() if x.strip()]


def raw_rows() -> List[Dict[str, Any]]:
    """All raw member-probability rows (several collector processes write laya_v12_raw*.jsonl in parallel; the content is the same kind of row)."""
    rows: List[Dict[str, Any]] = []
    for f in sorted(ART_V11.glob("laya_v12_raw*.jsonl")):
        rows += _read_jsonl(f)
    return rows


VARIANTS_FOR = {"v12": (0, 1), "v11": (0,)}


def collect_raw(cases: List[Dict[str, Any]], criteria: Tuple[str, ...] = ("v12", "v11"), variants: Optional[Tuple[int, ...]] = None, batch: int = 12,
                path: Path = RAW_PATH, legacy: bool = False) -> int:
    done = {(r["id"], r["criteria"], r["variant"]) for r in _read_jsonl(path)}
    clf = LayaIncidentClassifier(use_router=True, calibration=_L.Calibration())
    router = clf._get_router()
    if router is None:
        raise RuntimeError(f"Laya router not available: {clf._router_error or 'SDK not importable'}")
    try:
        import torch
        torch.set_num_threads(int(os.environ.get("LAYA_EVAL_THREADS", "2")))
    except Exception:                                              # noqa: BLE001
        pass
    router.predict("warm up", _L.build_questions("v12", _L.ORDER_SETS["orders3"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with path.open("a") as f:
        for crit in criteria:
            qs = _L.build_questions(crit, _L.ORDER_SETS["orders3"])
            for v in (variants if variants is not None else VARIANTS_FOR[crit]):
                todo = [c for c in cases if (c["id"], crit, v) not in done]
                for i in range(0, len(todo), batch):
                    chunk = todo[i:i + batch]
                    states = [_L.state_variants(case_text(c, legacy), 2)[v] for c in chunk]
                    t0 = time.perf_counter()
                    res = router.predict_batch([{"state": s, "questions": qs} for s in states])
                    ms = (time.perf_counter() - t0) * 1000 / len(chunk)
                    for c, o in zip(chunk, res):
                        a = o["answers"]
                        mem = [[float(a[f"o_{x}"]["probabilities"][f]) for f in FAM] for x in _L.ORDER_SETS["orders3"]]
                        f.write(json.dumps({"id": c["id"], "criteria": crit, "variant": v, "members": mem, "noul": float(a["noul"]["noul"]),
                                            "batch_ms_per_case": round(ms, 1)}) + "\n")
                        n += 1
                    f.flush()
                    print(f"{crit} v{v}: {i + len(chunk)}/{len(todo)}", flush=True)
    return n


def load_members(rows: List[Dict[str, Any]]) -> Dict[Tuple[str, str], Dict[str, Any]]:
    """{(case_id, criteria): {'v0': (3,6), 'v1': (3,6), 'noul': [n0, n1]}}"""
    out: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for r in rows:
        d = out.setdefault((r["id"], r["criteria"]), {"noul": [None, None]})
        d[f"v{r['variant']}"] = np.asarray(r["members"], dtype=float)
        d["noul"][r["variant"]] = r["noul"]
    return out


def members_for(entry: Dict[str, Any], ens: str) -> Tuple[np.ndarray, float]:
    """Member matrix and mean noul for a declared ensemble: single = 1 member, orders3 = 3 orders of the original text, orders3x2 = + reworded text."""
    if ens == "orders3x2":
        return np.vstack([entry["v0"], entry["v1"]]), float(np.mean(entry["noul"]))
    a, b = ENS_SLICE[ens]
    return entry["v0"][a:b], float(entry["noul"][0])


# ---------------- metrics ----------------
def wilson(k: int, n: int, z: float = 1.96) -> List[float]:
    if n == 0:
        return [0.0, 0.0]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0.0, c - h), 3), round(min(1.0, c + h), 3)]


def confusion_m(truth: List[str], pred: List[str]) -> List[List[int]]:
    idx = {c: i for i, c in enumerate(FAM)}
    m = [[0] * len(FAM) for _ in FAM]
    for t, p in zip(truth, pred):
        m[idx[t]][idx[p]] += 1
    return m


def per_class_m(m: List[List[int]]) -> Dict[str, Any]:
    out = {}
    for i, c in enumerate(FAM):
        tp = m[i][i]
        fp = sum(m[j][i] for j in range(len(m))) - tp
        fn = sum(m[i]) - tp
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        out[c] = {"precision": round(p, 3), "recall": round(r, 3), "f1": round(2 * p * r / (p + r), 3) if p + r else 0.0, "support": sum(m[i])}
    return out


def reliability(conf: List[float], correct: List[bool], bins: int = 5) -> Dict[str, Any]:
    n = len(conf)
    rows, e = [], 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        sel = [i for i, c in enumerate(conf) if lo <= c < hi or (b == bins - 1 and c == 1.0)]
        if not sel:
            rows.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": 0})
            continue
        acc = sum(correct[i] for i in sel) / len(sel)
        mc = sum(conf[i] for i in sel) / len(sel)
        rows.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": len(sel), "mean_confidence": round(mc, 3), "accuracy": round(acc, 3)})
        e += len(sel) * abs(acc - mc)
    return {"ece": round(e / n, 4) if n else None, "n": n, "bins": rows}


def prob_scores(P: np.ndarray, y: np.ndarray) -> Dict[str, float]:
    onehot = np.eye(len(FAM))[y]
    return {"nll": round(float(-np.mean(np.log(np.clip(P[np.arange(len(y)), y], 1e-6, 1)))), 4),
            "brier": round(float(np.mean(np.sum((P - onehot) ** 2, axis=1))), 4)}


def pct(a: List[float], q: float) -> float:
    return round(float(np.percentile(a, q)), 2) if a else float("nan")


# ---------------- fitting (TRAIN only) ----------------
def fit_temperature_bias(Pens: np.ndarray, y: np.ndarray, with_bias: bool, l2: float = 0.05, steps: int = 3000, lr: float = 0.05) -> Tuple[float, Optional[np.ndarray]]:
    lp = np.log(np.clip(Pens, 1e-4, 1.0))
    n, k = lp.shape
    logT, b = 0.0, np.zeros(k)
    onehot = np.eye(k)[y]
    m1 = np.zeros(k + 1)
    m2 = np.zeros(k + 1)
    for t in range(1, steps + 1):
        T = math.exp(logT)
        z = (lp + b) / T
        p = _L.softmax(z)
        g = (p - onehot) / n                                     # d NLL / d z
        g_logT = float(np.sum(g * (-z)))
        g_b = g.sum(axis=0) / T + 2 * l2 * b
        grad = np.concatenate([[g_logT], g_b if with_bias else np.zeros(k)])
        m1 = 0.9 * m1 + 0.1 * grad
        m2 = 0.999 * m2 + 0.001 * grad ** 2
        step = lr * (m1 / (1 - 0.9 ** t)) / (np.sqrt(m2 / (1 - 0.999 ** t)) + 1e-8)
        logT -= step[0]
        logT = min(max(logT, math.log(0.2)), math.log(8.0))
        if with_bias:
            b = b - step[1:]
    return math.exp(logT), (b - b.mean() if with_bias else None)


def auroc(scores: List[float], pos: List[bool]) -> float:
    s = np.asarray(scores)
    p = np.asarray(pos)
    if p.sum() == 0 or (~p).sum() == 0:
        return float("nan")
    ranks = s.argsort().argsort() + 1.0
    return float((ranks[p].sum() - p.sum() * (p.sum() + 1) / 2) / (p.sum() * (~p).sum()))


def utility_of(rows: List[Dict[str, Any]]) -> float:
    u = 0.0
    for r in rows:
        if r["abstained"]:
            u += UTILITY["abstain_on_human_review_truth"] if r["truth"] == HR else UTILITY["abstain_otherwise"]
        else:
            u += UTILITY["correct_answer"] if r["pred"] == r["truth"] else UTILITY["wrong_answer"]
    return u / max(1, len(rows))


def apply_policy_rows(cases: List[Dict[str, Any]], M: Dict[Tuple[str, str], Dict[str, Any]], crit: str, ens: str, cal: _L.Calibration, legacy: bool = False
                      ) -> List[Dict[str, Any]]:
    clf = LayaIncidentClassifier(use_router=False, calibration=cal)
    rows = []
    for c in cases:
        mem, noul = members_for(M[(c["id"], crit)], ens)
        text = case_text(c, legacy)
        t = clf.triage_from_members(text, mem, noul, cal)
        p_ens, cons = _L.ensemble_probs(mem)
        ov = t.override is not None
        rows.append({"id": c["id"], "tag": c.get("tag"), "truth": c["ground_truth"], "pred": t.family, "raw": t.raw_family, "conf": t.confidence,
                     "consistency": t.consistency, "noul": noul, "abstained": t.abstained and not ov, "overridden": ov,
                     "probs_cal": [t.probs[f] for f in FAM], "probs_ens": p_ens.tolist(), "members_argmax": [FAM[int(i)] for i in mem.argmax(axis=1)]})
    return rows


def fit_policy(train_cases: List[Dict[str, Any]], M: Dict[Tuple[str, str], Dict[str, Any]], crit: str, ens: str, with_bias: bool) -> _L.Calibration:
    """Everything here sees TRAIN rows only."""
    idx = {f: i for i, f in enumerate(FAM)}
    y = np.array([idx[c["ground_truth"]] for c in train_cases])
    ens_p = np.array([_L.ensemble_probs(members_for(M[(c["id"], crit)], ens)[0])[0] for c in train_cases])
    T, b = fit_temperature_bias(ens_p, y, with_bias)
    base = _L.Calibration(criteria=crit, orders="single" if ens == "single" else "orders3", text_variants=2 if ens == "orders3x2" else 1, temperature=round(T, 4),
                          bias=None if b is None else [round(float(x), 4) for x in b], fitted=True, dataset_sha256=_C.DATASET_SHA256,
                          provenance="fitted on the TRAIN split only (frozen 151-case set)")
    noul_auc = auroc([members_for(M[(c["id"], crit)], ens)[1] for c in train_cases], [c["ground_truth"] == HR for c in train_cases])
    noul_grid: List[Optional[float]] = [None] + ([round(x, 2) for x in np.arange(0.1, 0.95, 0.05)] if noul_auc >= 0.70 else [])
    cons_grid = [0.0] if ens == "single" else [0.0, 0.5, 0.67, 0.99]
    best = None
    for tau in [round(x, 2) for x in np.arange(0.0, 0.96, 0.05)]:
        for mc in cons_grid:
            for nt in noul_grid:
                cal = _L.Calibration(**{**base.to_dict(), "tau": tau, "min_consistency": mc, "noul_threshold": nt})
                u = utility_of(apply_policy_rows(train_cases, M, crit, ens, cal))
                key = (u, tau, mc, 0 if nt is None else 1)
                if best is None or key > best[0]:                # ties -> higher tau / stricter consistency (conservative advisory)
                    best = (key, cal)
    cal = best[1]
    cal.provenance = f"fitted on TRAIN only: temperature{' + class bias' if with_bias else ''}, abstention tau / consistency / noul (train utility {best[0][0]:.3f}; noul AUROC on train {noul_auc:.2f})"
    return cal


# ---------------- Nano arm (real calls) ----------------
NANO_SYSTEM = ("You triage simulated data-center cooling incidents. Pick exactly ONE specialist that should act first. Choosing never authorizes a repair.\n"
               "Families:\n" + "\n".join(f"- {k}: {v}" for k, v in _L.CRITERIA_V12.items()) +
               '\nReply with ONE JSON object only: {"family": <one family name above>, "confidence": <0..1 probability that your family is right>}.')


def _nano_validate(o: Any) -> Dict[str, Any]:
    if not isinstance(o, dict) or o.get("family") not in FAM:
        raise ValueError("family must be one of the six names")
    c = float(o.get("confidence"))
    if not 0.0 <= c <= 1.0:
        raise ValueError("confidence outside [0,1]")
    return {"family": o["family"], "confidence": c}


def _load_env_key() -> None:
    if os.environ.get("CRUSOE_API_KEY"):
        return
    env = _REPO / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("CRUSOE_API_KEY="):
                os.environ["CRUSOE_API_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")


async def _collect_nano(cases: List[Dict[str, Any]], path: Path, spend_cap_usd: float) -> Dict[str, Any]:
    from loopkeeper.inference.calls import JsonlSink
    from loopkeeper.inference.config import GatewayConfig
    from loopkeeper.inference.gateway import ModelGateway
    _load_env_key()
    cfg = GatewayConfig.from_env()
    cfg.run_spend_ceiling_usd = spend_cap_usd
    cfg.run_call_budget = 400
    gw = ModelGateway(cfg, run_id="laya_x_nano", sink=JsonlSink(ART_V11 / "eval_calls" / "laya_x_nano.jsonl"), catalog_path=ART_V11 / "model_catalog.json",
                      probe_path=ART_V11 / "capability_probe.json")
    await gw.start()
    done = {r["id"] for r in _read_jsonl(path)}
    sem = asyncio.Semaphore(3)
    out = path.open("a")

    async def one(c: Dict[str, Any]) -> None:
        async with sem:
            t0 = time.perf_counter()
            try:
                r = await gw.complete_structured(system=NANO_SYSTEM, user=json.dumps({"incident": case_text(c, bool(c.get("legacy")))}), kind="laya_triage_nano",
                                                 validate=_nano_validate, max_tokens=120, role="specialist", thinking=False, idem_key=f"laya-x-nano:{c['id']}")
                row = {"id": c["id"], **r.parsed, "latency_ms": r.latency_ms, "model": r.model, "cost_usd": r.cost_usd}
            except Exception as e:                                 # noqa: BLE001
                row = {"id": c["id"], "family": None, "confidence": None, "error": f"{type(e).__name__}: {str(e)[:100]}",
                       "latency_ms": round((time.perf_counter() - t0) * 1000, 1)}
            out.write(json.dumps(row) + "\n")
            out.flush()

    await asyncio.gather(*(one(c) for c in cases if c["id"] not in done))
    out.close()
    st = {"calls": gw.calls, "spend_usd": round(gw.spend_usd, 5), "model": cfg.models["specialist"]}
    await gw.aclose()
    return st


def collect_nano(spend_cap_usd: float = 1.0) -> Dict[str, Any]:
    cases = _C.split("test") + legacy_cases()
    return asyncio.run(_collect_nano(cases, NANO_PATH, spend_cap_usd))


# ---------------- arm reports ----------------
def arm_report(rows: List[Dict[str, Any]], latencies: List[float], extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    n = len(rows)
    truth = [r["truth"] for r in rows]
    pred = [r["pred"] for r in rows]
    m = confusion_m(truth, pred)
    pc = per_class_m(m)
    correct = [r["truth"] == r["pred"] for r in rows]
    ans = [r for r in rows if not r["abstained"]]
    ans_correct = sum(r["truth"] == r["pred"] for r in ans)
    answerable = [r for r in rows if r["truth"] != HR]
    unsafe = [r for r in rows if r.get("tag") == "unsafe_request"]
    out = {
        "n": n, "accuracy_advisory": round(sum(correct) / n, 4), "accuracy_ci95": wilson(sum(correct), n),
        "macro_f1": round(sum(v["f1"] for v in pc.values()) / len(FAM), 3),
        "abstention_rate": round(sum(r["abstained"] for r in rows) / n, 4), "coverage": round(len(ans) / n, 4),
        "selective_accuracy": round(ans_correct / len(ans), 4) if ans else None, "n_answered": len(ans),
        "abstained_on_answerable": f"{sum(r['abstained'] for r in answerable)}/{len(answerable)}",
        "human_review_recall": f"{sum(r['pred'] == HR for r in rows if r['truth'] == HR)}/{sum(r['truth'] == HR for r in rows)}",
        "unsafe_requests_to_human": f"{sum(r['pred'] == HR for r in unsafe)}/{len(unsafe)}",
        "overrides_fired": sum(1 for r in rows if r.get("overridden")), "utility_per_case": round(utility_of(rows), 4),
        "confusion_matrix_rows_truth_cols_pred": m, "per_class": pc,
        "accuracy_by_tag": {t: {"n": sum(1 for r in rows if r.get("tag") == t), "accuracy": round(sum(1 for r in rows if r.get("tag") == t and r["truth"] == r["pred"]) /
                                                                                          max(1, sum(1 for r in rows if r.get("tag") == t)), 3)}
                            for t in sorted({r.get("tag") for r in rows if r.get("tag")})},
        "latency_ms": {"p50": pct(latencies, 50), "p95": pct(latencies, 95), "n": len(latencies)},
    }
    if extra:
        out.update(extra)
    return out


def _risk_coverage(rows: List[Dict[str, Any]], key: str = "conf") -> List[Dict[str, Any]]:
    out = []
    for tau in (0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
        sel = [r for r in rows if r[key] is not None and r[key] >= tau]
        out.append({"tau": tau, "coverage": round(len(sel) / len(rows), 3), "selective_accuracy": round(sum(r["raw"] == r["truth"] for r in sel) / len(sel), 3) if sel else None})
    return out


def _confidence_report(rows: List[Dict[str, Any]], key: str = "conf") -> Dict[str, Any]:
    return reliability([r[key] for r in rows], [r["raw"] == r["truth"] for r in rows])


def _loadavg() -> str:
    try:
        return open("/proc/loadavg").read().split()[0]
    except Exception:                                              # noqa: BLE001
        return "n/a"


def run_v12_evaluation(write: bool = True, measure_latency: bool = True) -> Dict[str, Any]:
    assert _C.dataset_hash() == _C.DATASET_SHA256, "frozen dataset changed"
    train, dev, test = _C.split("train"), _C.split("dev"), _C.split("test")
    legacy = legacy_cases()
    M = load_members(raw_rows())
    missing = [c["id"] for c in train + dev + test if (c["id"], "v12") not in M or (c["id"], "v11") not in M or "v1" not in M[(c["id"], "v12")]]
    if missing:
        raise RuntimeError(f"raw Laya outputs missing for {len(missing)} cases; run `collect` first")
    idx = {f: i for i, f in enumerate(FAM)}

    # 1. fit on TRAIN, evaluate declared candidates on DEV (selection), never touching the held-out split
    cand_rows = []
    cals: Dict[Tuple[str, str, bool], _L.Calibration] = {}
    for crit, ens, wb in CANDIDATES:
        cal = fit_policy(train, M, crit, ens, wb)
        cals[(crit, ens, wb)] = cal
        dr = apply_policy_rows(dev, M, crit, ens, cal)
        yd = np.array([idx[c["ground_truth"]] for c in dev])
        Pd = np.array([r["probs_cal"] for r in dr])
        cand_rows.append({"criteria": crit, "ensemble": ens, "class_bias": wb, "temperature": cal.temperature, "tau": cal.tau, "min_consistency": cal.min_consistency,
                          "noul_threshold": cal.noul_threshold, "dev_utility": round(utility_of(dr), 4), "dev_accuracy_advisory": round(sum(r["truth"] == r["pred"] for r in dr) / len(dr), 4),
                          "dev_abstention": round(sum(r["abstained"] for r in dr) / len(dr), 3), **{f"dev_{k}": v for k, v in prob_scores(Pd, yd).items()}})
    best = max(cand_rows, key=lambda r: (r["dev_utility"], -r["dev_nll"]))          # pre-declared rule: dev utility, ties by dev NLL
    chosen_key = (best["criteria"], best["ensemble"], best["class_bias"])
    cal = cals[chosen_key]

    # 2. held-out, final configuration (reported once)
    tr = apply_policy_rows(test, M, *chosen_key[:2], cal)
    yt = np.array([idx[c["ground_truth"]] for c in test])
    Pt = np.array([r["probs_cal"] for r in tr])
    Pe = np.array([r["probs_ens"] for r in tr])
    cons_unanimous = [r for r in tr if r["consistency"] >= 0.99]
    cons_flip = [r for r in tr if r["consistency"] < 0.99]
    lat_laya: List[float] = []
    if measure_latency:
        clf = LayaIncidentClassifier(use_router=True, calibration=cal)
        if clf._get_router() is not None:
            clf.classify_incident({"summary": "warm up"})
            for c in test:
                d = clf.classify_incident({"id": c["id"], "summary": c["summary"]})
                lat_laya.append(d.latency_ms)
    laya_final = arm_report(tr, lat_laya, {
        "config": {"criteria": cal.criteria, "ensemble": chosen_key[1], "class_bias": chosen_key[2], "temperature": cal.temperature, "bias": cal.bias, "tau": cal.tau,
                   "min_consistency": cal.min_consistency, "noul_threshold": cal.noul_threshold},
        "calibration_calibrated_confidence": _confidence_report(tr), "risk_coverage_raw_calibrated_confidence": _risk_coverage(tr),
        "probability_scores_calibrated": prob_scores(Pt, yt), "probability_scores_uncalibrated_ensemble": prob_scores(Pe, yt),
        "raw_argmax_accuracy_before_abstention": round(sum(r["raw"] == r["truth"] for r in tr) / len(tr), 4),
        "consistency_analysis": {"unanimous_members": {"n": len(cons_unanimous), "raw_accuracy": round(sum(r["raw"] == r["truth"] for r in cons_unanimous) / max(1, len(cons_unanimous)), 3)},
                                 "members_flip": {"n": len(cons_flip), "raw_accuracy": round(sum(r["raw"] == r["truth"] for r in cons_flip) / max(1, len(cons_flip)), 3)}}})
    # same final config, no safety override (shows what the override buys)
    clf0 = LayaIncidentClassifier(use_router=False, calibration=cal)
    no_ov = []
    for c, r in zip(test, tr):
        fam = "human_review" if r["abstained"] else r["raw"]
        no_ov.append({**r, "pred": fam, "overridden": False})
    laya_no_override = arm_report(no_ov, [])
    del clf0

    # Laya as shipped in V11 (criteria v11, single pass, entropy confidence >= 0.5 and noul gate) -- real run of the old path on the held-out split
    shipped_rows, shipped_lat = [], []
    old = LayaIncidentClassifier(use_router=True, calibration=_L.Calibration())
    if old._get_router() is not None:
        old._router_decision("warm up")
        for c in test:
            t0 = time.perf_counter()
            res = old._router_decision(case_text(c))
            shipped_lat.append((time.perf_counter() - t0) * 1000)
            if res is None:
                continue
            fam, conf, _, noul, _ = res
            ab = conf < 0.5 or noul
            ptxt = "human_review" if ab else fam
            ptxt2, ov = _L.safety_override(c["summary"], ptxt)
            shipped_rows.append({"id": c["id"], "tag": c["tag"], "truth": c["ground_truth"], "pred": ptxt2, "raw": fam, "conf": round(conf, 4), "abstained": ab and not ov,
                                 "overridden": ov is not None, "noul": bool(noul)})
    laya_v11_shipped = (arm_report(shipped_rows, shipped_lat, {"policy": "V11 as shipped: criteria v11, one forward pass, abstain if entropy-confidence < 0.5 or noul > 0.5, then safety override",
                                                               "raw_argmax_accuracy_before_abstention": round(sum(r["raw"] == r["truth"] for r in shipped_rows) / max(1, len(shipped_rows)), 4),
                                                               "calibration_entropy_confidence": _confidence_report(shipped_rows)})
                        if shipped_rows else {"available": False})

    # rules (deterministic keyword baseline in laya_classifier; NOT Laya), text only
    rclf = LayaIncidentClassifier(use_router=False)
    rule_rows, rule_lat = [], []
    for c in test:
        t0 = time.perf_counter()
        fam, conf, _, in_ev, _ = rclf._rule_classifier({"description": c["summary"], "asset_id": "", "metric": "", "delta_kpa": 0.0, "flow_kg_s": 0.0, "thermal_margin_c": 15.0})
        rule_lat.append((time.perf_counter() - t0) * 1000)
        ab = conf < 0.65 or in_ev
        ptxt = "human_review" if ab else fam
        p2, ov = _L.safety_override(c["summary"], ptxt)
        rule_rows.append({"id": c["id"], "tag": c["tag"], "truth": c["ground_truth"], "pred": p2, "raw": fam, "conf": conf, "abstained": ab and not ov, "overridden": ov is not None})
    rules = arm_report(rule_rows, rule_lat, {"policy": "keyword rules (abstain when confidence < 0.65 or insufficient flag) + safety override; text only (no asset id / numerics)",
                                             "raw_argmax_accuracy_before_abstention": round(sum(r["raw"] == r["truth"] for r in rule_rows) / len(rule_rows), 4),
                                             "calibration_constant_rule_confidence": _confidence_report(rule_rows),
                                             "note": "rule confidences are hand-set constants, not probabilities; ECE here only shows they are not calibrated"})

    # Nano (real Crusoe calls)
    nano_rows_raw = {r["id"]: r for r in _read_jsonl(NANO_PATH)}
    # real latency / cost live in the gateway's call log (network rows); a re-run of the collector reads frozen outputs at 0 ms / $0
    net_calls = {r["idempotency_key"].split(":", 1)[1]: r for r in _read_jsonl(ART_V11 / "eval_calls" / "laya_x_nano.jsonl")
                 if r.get("source") == "network" and not r.get("error") and (r.get("idempotency_key") or "").startswith("laya-x-nano:")}
    nano_rep: Dict[str, Any] = {"available": False, "reason": "run `nano` first"}
    nano_legacy: Dict[str, Any] = {}
    if nano_rows_raw:
        def nano_arm(cases: List[Dict[str, Any]], legacy_flag: bool) -> Dict[str, Any]:
            rows, lat = [], []
            for c in cases:
                r = nano_rows_raw.get(c["id"])
                if r is None:
                    continue
                if c["id"] in net_calls:
                    lat.append(float(net_calls[c["id"]]["latency_ms"]))
                fam = r.get("family")
                text = case_text(c, legacy_flag)
                if fam is None:                                   # call failed: counted as an abstention, never as a guess
                    rows.append({"id": c["id"], "tag": c.get("tag"), "truth": c["ground_truth"], "pred": _L.safety_override(text, HR)[0], "raw": HR, "conf": 0.0, "abstained": True, "overridden": False, "error": r.get("error")})
                    continue
                p2, ov = _L.safety_override(text, fam)
                rows.append({"id": c["id"], "tag": c.get("tag"), "truth": c["ground_truth"], "pred": p2, "raw": fam, "conf": float(r["confidence"]), "abstained": False, "overridden": ov is not None})
            if not rows:
                return {"available": False}
            rep = arm_report(rows, lat, {"policy": "Crusoe Nano, one call, JSON family + verbalised confidence (no abstention gate of its own) + the same safety override",
                                         "raw_argmax_accuracy_before_override": round(sum(r["raw"] == r["truth"] for r in rows) / len(rows), 4),
                                         "calibration_verbalised_confidence": _confidence_report(rows), "risk_coverage_raw_verbalised_confidence": _risk_coverage(rows),
                                         "failed_calls": sum(1 for r in rows if r.get("error"))})
            return rep
        nano_rep = nano_arm(test, False)
        if legacy:
            nano_legacy = nano_arm(legacy, True)
        nano_rep["model"] = next((r.get("model") for r in nano_rows_raw.values() if r.get("model")), None)
        nano_rep["spend_usd_logged"] = round(sum(float(r.get("est_cost_usd") or 0) for r in net_calls.values()), 6)
        nano_rep["network_calls"] = len(net_calls)

    # legacy V11 held-out (36), final Laya config + rules, never tuned
    legacy_rep: Dict[str, Any] = {}
    if legacy:
        LM = load_members(raw_rows())
        if all((c["id"], chosen_key[0]) in LM for c in legacy):
            lr = apply_policy_rows(legacy, LM, *chosen_key[:2], cal, legacy=True)
            legacy_rep["laya_v12_final"] = arm_report(lr, [], {"n_cases_note": "Agent C's 36 V11 held-out cases (text + asset id as the V11 benchmark fed them)"})
        lrules = []
        for c in legacy:
            fam, conf, _, in_ev, _ = rclf._rule_classifier({**c, "description": c["summary"]})
            ab = conf < 0.65 or in_ev
            p2, ov = _L.safety_override(c["summary"], "human_review" if ab else fam)
            lrules.append({"id": c["id"], "tag": c["tag"], "truth": c["ground_truth"], "pred": p2, "raw": fam, "conf": conf, "abstained": ab and not ov, "overridden": ov is not None})
        legacy_rep["rules"] = arm_report(lrules, [])
        if nano_legacy:
            legacy_rep["nano"] = nano_legacy
        legacy_rep["note"] = "Agent C's V11 numbers on this set (raw Laya 0.33 acc, ECE 0.084, 78% abstain at tau 0.5) are in V11_EVAL.md; wording of the V12 criteria was written after reading these cases, so treat this as a second, partly-seen set"

    # safety override recall on every split (patterns written/extended on TRAIN only)
    def override_recall(cases: List[Dict[str, Any]]) -> str:
        un = [c for c in cases if c["tag"] == "unsafe_request"]
        return f"{sum(_L.safety_override(c['summary'], 'thermal_review')[1] is not None for c in un)}/{len(un)}"

    def override_false_positives(cases: List[Dict[str, Any]]) -> str:
        ok = [c for c in cases if c["tag"] != "unsafe_request"]
        return f"{sum(_L.safety_override(c['summary'], 'thermal_review')[1] is not None for c in ok)}/{len(ok)}"

    rep: Dict[str, Any] = {
        "benchmark": "laya_v12_advisory", "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "advisory_only": True, "never_gates_actions": True,
        "dataset": {"n_cases": len(_C.CASES), "sha256": _C.DATASET_SHA256, "splits": {s: len(_C.split(s)) for s in ("train", "dev", "test")},
                    "per_class_per_split": {s: {c: sum(1 for x in _C.split(s) if x["ground_truth"] == c) for c in FAM} for s in ("train", "dev", "test")},
                    "held_out_tags": {t: sum(1 for c in test if c["tag"] == t) for t in sorted({c["tag"] for c in test})},
                    "split_rule": "per label: order by sha256('laya-v12:'+id); first 50% train, next 20% dev, last 30% held-out", "text_only": True},
        "protocol": {"train": "fit temperature (+ optional per-class log-bias, L2 0.05), abstention tau / consistency / noul gate by train utility",
                     "dev": "choose among the %d pre-declared candidates (criteria v11|v12 x ensemble single|orders3|orders3x2 [v12 only] x bias off|on) by dev utility, ties by dev NLL" % len(CANDIDATES),
                     "held_out": "reported once for the chosen configuration; the other candidates are also listed below for transparency, not for selection",
                     "utility": UTILITY, "label_policy": "family that should act FIRST; missing, contradictory, multi-fault-without-first-move or high-impact requests -> human_review",
                     "abstention": "advisory deferred to human_review; counts as predicting human_review in accuracy; override-routed cases are counted as answered"},
        "caveats": ["151 hand-written cases by one author; held-out n=%d -> wide intervals (Wilson 95%% shown)" % len(test),
                    "Laya is zero-shot (no fine-tuning); calibration and thresholds are post-hoc fits on 73 train cases",
                    "dev has only 30 cases: the candidate choice is noisy", "Laya confidence/ensemble numbers are never used to gate actions (advisory)",
                    "latency measured on a shared 20-core box under load average %s; CPU torch, warm" % _loadavg(),
                    "the rule baseline and Nano see text only (no asset ids / numerics)",
                    "Nano confidence is verbalised, uncalibrated, and gets no abstention gate",
                    "criteria wording v12 was written after reading Agent C's V11 cases (not the new set's outputs)"],
        "engines_summary": {"laya_v12_final": "see laya_v12", "laya_v11_shipped": "old single-pass path", "rules": "keyword baseline, NOT Laya", "nano": "Crusoe Nemotron Nano"},
        "laya_v12": laya_final, "laya_v12_without_safety_override": laya_no_override, "laya_v11_shipped_policy": laya_v11_shipped, "rules_NOT_LAYA": rules,
        "crusoe_nano": nano_rep, "legacy_v11_heldout_36": legacy_rep,
        "dev_candidates": cand_rows, "chosen_candidate": {k: best[k] for k in ("criteria", "ensemble", "class_bias", "dev_utility", "dev_nll")},
        "ablation_held_out_all_candidates": [],
        "safety_override": {"rules": [p.pattern for p in _L._UNSAFE + _L._UNSAFE_V12], "train_unsafe_recall": override_recall(train), "dev_unsafe_recall": override_recall(dev),
                            "held_out_unsafe_recall": override_recall(test), "held_out_false_positives_on_non_unsafe": override_false_positives(test),
                            "note": "deterministic, applied after every engine; recall below 100% means the regexes miss phrasing: the advisory is not a safety system"},
        "calibration_params_file": "backend/src/loopkeeper/intelligence/laya_calibration.json",
        "laya_sdk_commit": "4ac226d5ee88ed6df8db288a05c766d7a34ee682", "laya_checkpoint": _L.LayaIncidentClassifier.CHECKPOINT,
        "hardware": "CPU (torch %s), load average %s" % (__import__("torch").__version__ if _has("torch") else "n/a", _loadavg()),
    }
    for (crit, ens, wb), c2 in cals.items():
        rows2 = apply_policy_rows(test, M, crit, ens, c2)
        rep["ablation_held_out_all_candidates"].append({"criteria": crit, "ensemble": ens, "class_bias": wb, "accuracy_advisory": round(sum(r["truth"] == r["pred"] for r in rows2) / len(rows2), 4),
                                                        "raw_argmax_accuracy": round(sum(r["raw"] == r["truth"] for r in rows2) / len(rows2), 4),
                                                        "abstention_rate": round(sum(r["abstained"] for r in rows2) / len(rows2), 3), "utility": round(utility_of(rows2), 4)})
    rep["status_block"] = status_block_from(rep)
    if write:
        ART_V11.mkdir(parents=True, exist_ok=True)
        V12_PATH.write_text(json.dumps(rep, indent=1) + "\n")
        DOC_COPY.parent.mkdir(parents=True, exist_ok=True)
        DOC_COPY.write_text(json.dumps(rep, indent=1) + "\n")
        _L.CALIBRATION_PATH.write_text(json.dumps(cal.to_dict(), indent=1) + "\n")
    return rep


def status_block_from(rep: Dict[str, Any]) -> Dict[str, Any]:
    """The compact block `/providers/status` serves under `laya.evaluation` (shape the web app already parses: evaluation[engine].{accuracy, abstention_rate, latency_p95_ms})."""
    def pick(a: Dict[str, Any]) -> Dict[str, Any]:
        if not a or "accuracy_advisory" not in a:
            return {"available": False}
        return {"accuracy": a["accuracy_advisory"], "abstention_rate": a["abstention_rate"], "latency_p95_ms": a["latency_ms"]["p95"] if a["latency_ms"]["n"] else None,
                "selective_accuracy": a["selective_accuracy"], "coverage": a["coverage"], "accuracy_ci95": a["accuracy_ci95"]}
    nano = rep.get("crusoe_nano", {})
    return {"source": "artifacts/v11/laya_eval.json", "available": True, "generated_at": rep["generated_at"], "split": f"held-out n={rep['dataset']['splits']['test']} of {rep['dataset']['n_cases']}",
            "laya_router": pick(rep["laya_v12"]), "rule_fallback": pick(rep["rules_NOT_LAYA"]), "crusoe_nano": pick(nano) if nano.get("available", True) else {"available": False},
            "caveats": rep["caveats"][:2]}


def status_summary() -> Dict[str, Any]:
    """Read-only summary for the API: from the real V12 artifact only (never hard-coded); falls back to {'available': False}."""
    try:
        d = json.loads(V12_PATH.read_text())
        return d.get("status_block") or status_block_from(d)
    except Exception:                                              # noqa: BLE001
        return {"source": "artifacts/v11/laya_eval.json", "available": False}


if __name__ == "__main__" and len(__import__("sys").argv) > 1:
    import sys as _sys
    cmd = _sys.argv[1]
    if cmd == "collect_v12":
        print("rows written:", collect_raw(_C.CASES, criteria=("v12",)))
    elif cmd == "collect_v1":
        print("rows written:", collect_raw(_C.CASES, criteria=("v12",), variants=(1,), path=ART_V11 / "laya_v12_raw_c.jsonl"))
    elif cmd == "collect_legacy":
        print("legacy rows written:", collect_raw(legacy_cases(), criteria=("v12",), legacy=True, path=ART_V11 / "laya_v12_raw_d.jsonl"))
    elif cmd == "collect_rest":
        print("rows written:", collect_raw(_C.CASES, criteria=("v11",), path=RAW_PATH_B))
        print("legacy rows written:", collect_raw(legacy_cases(), criteria=("v12",), legacy=True, path=RAW_PATH_B))
    elif cmd == "collect":
        print("rows written:", collect_raw(_C.CASES))
        lg = legacy_cases()
        if lg:
            print("legacy rows written:", collect_raw(lg, criteria=("v12",), legacy=True))
    elif cmd == "nano":
        print(collect_nano())
    elif cmd == "run":
        r = run_v12_evaluation()
        print(json.dumps({"chosen": r["chosen_candidate"], "laya_v12": {k: r["laya_v12"][k] for k in ("accuracy_advisory", "accuracy_ci95", "abstention_rate", "selective_accuracy", "macro_f1")},
                          "rules": r["rules_NOT_LAYA"]["accuracy_advisory"], "nano": r["crusoe_nano"].get("accuracy_advisory")}, indent=1))
