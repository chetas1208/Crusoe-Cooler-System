"""V11 Laya benchmark: 48 labelled cases (12 dev for choosing the abstention threshold, 36 held-out test) incl. negation, multi-fault,
false-sensor and vague wording. Labels were written BEFORE any Laya output was seen for them; the rule fallback and the Laya checkpoint were
not tuned on them. Label policy: the family that should act FIRST; evidence that contradicts itself, is missing, or asks for a high-impact
action -> human_review. All numbers come from a real run (`python -m loopkeeper.eval.laya_bench`); if the router does not load, the
artifact says so and contains no numbers for it."""
from __future__ import annotations

import json
import math
import re
import time
from pathlib import Path
from typing import Any

Json = dict[str, Any]
CATEGORIES = ["inpipe_inspection", "exterior_service", "hydraulics_review", "thermal_review", "sensor_validation", "human_review"]
II, ES, HY, TH, SV, HR = CATEGORIES


def _c(i: int, split: str, tag: str, gt: str, summary: str, asset: str = "unknown", **kw: Any) -> Json:
    return {"id": f"L{i:02d}", "split": split, "tag": tag, "ground_truth": gt, "asset_id": asset, "summary": summary, **kw}


CASES: list[Json] = [
    # ---- dev (threshold selection only) ----
    _c(1, "dev", "plain", ES, "The Y-strainer on the facility water line is clogged and the differential pressure alarm is on.", "strainer_01"),
    _c(2, "dev", "plain", II, "Scale has built up inside the Hall B supply header and the bore is narrowing.", "p_17"),
    _c(3, "dev", "plain", HY, "Duty pump head dropped and loop flow is under the design point.", "pump_t1"),
    _c(4, "dev", "plain", TH, "Rack A1 chip temperature is two kelvin from throttle under steady load.", "rack_a1"),
    _c(5, "dev", "plain", SV, "One flow meter drifts upward while every other reading in the loop is flat.", "sn_flow_za"),
    _c(6, "dev", "negation", SV, "No deposits and no pump problem found; the zone flow reading simply does not match the sum of its racks.", "sn_flow_zb"),
    _c(7, "dev", "vague", HR, "Something feels off in the mechanical room, nobody can say what.", "plant"),
    _c(8, "dev", "unsafe_request", HR, "Please bypass the isolation interlock so the pump can be serviced while running.", "pump_t1"),
    _c(9, "dev", "false_sensor", SV, "Pressure transmitter shows zero kPa but pumps are running and flow is normal everywhere else.", "sn_flow_trunk"),
    _c(10, "dev", "multi_fault", HR, "A seized valve and a drifting meter are both reported in zone A and the evidence points two ways.", "valve_za"),
    _c(11, "dev", "negation", ES, "The pipes are clean inside and the sensors agree, but the balancing valve on rack B4 will not move.", "valve_b4"),
    _c(12, "dev", "vague", HY, "Flow feels low across the loop since this morning; pumps are on and valves unchanged.", "plant"),
    # ---- held-out test ----
    _c(13, "test", "plain", II, "Crawler-sized supply run shows a thick mineral layer on its inner wall, pressure loss is creeping up.", "p_02"),
    _c(14, "test", "plain", II, "Sludge is collecting along the lower wall of the return header; throughput is falling.", "p_hr_b"),
    _c(15, "test", "plain", ES, "Duplex filter element needs changing; differential pressure across the basket is above its limit.", "strainer_02"),
    _c(16, "test", "plain", ES, "The zone isolation valve actuator ignores commands and sits half open.", "valve_zb"),
    _c(17, "test", "plain", HY, "Facility-water pressure sags every time the standby pump starts and the flow split looks lopsided.", "pump_f2"),
    _c(18, "test", "plain", HY, "CDU secondary differential pressure is far below setpoint with the pump at full speed.", "cdu_01"),
    _c(19, "test", "plain", TH, "A workload surge across the AI pod is eating thermal margin, cold-plate outlets are hot.", "rack_b2"),
    _c(20, "test", "plain", TH, "The CDU approach temperature has widened so it rejects less heat than the racks make.", "cdu_01"),
    _c(21, "test", "plain", SV, "A flow transmitter reads a negative value, which is physically impossible.", "sn_rack_a3"),
    _c(22, "test", "plain", SV, "A meter froze at one value for ten minutes then jumped; suspect the transmitter.", "sn_flow_zb"),
    _c(23, "test", "negation", II, "The strainers are fine and the sensors agree; the supply line itself is narrowed by build-up inside.", "p_10"),
    _c(24, "test", "negation", ES, "There is no deposit in the pipe and no thermal issue; the isolation valve just will not close.", "valve_a2"),
    _c(25, "test", "negation", HY, "Nothing wrong with the sensors or the valves, yet total flow fell by a fifth as the pump curve sagged.", "pump_t2"),
    _c(26, "test", "negation", TH, "Flow and pressure are normal and nothing is clogged; the rack is simply running hot under load.", "rack_a2"),
    _c(27, "test", "negation", SV, "The pipe is not fouled and the pump is healthy; the flow meter alone disagrees with its redundant twin.", "sn_flow_trunk"),
    _c(28, "test", "false_sensor", SV, "A temperature sensor reports 180 C on a water loop while neighbours read 35 C and nothing is boiling.", "sn_rack_b1"),
    _c(29, "test", "false_sensor", SV, "The trunk flow meter claims a collapse yet every rack branch meter and the pump amps are unchanged.", "sn_flow_trunk"),
    _c(30, "test", "false_sensor", HR, "A pressure sensor and a flow sensor contradict each other and a third meter is offline; cannot tell which is true.", "p_12"),
    _c(31, "test", "multi_fault", HR, "Rack B2 is hot, the zone B meter drifts, and a valve is sticking; no single cause stands out.", "rack_b2"),
    _c(32, "test", "multi_fault", II, "A clearly fouled supply header explains both the pressure loss and the warm racks downstream; the sensors are consistent.", "p_hs_a"),
    _c(33, "test", "multi_fault", HR, "Two incidents overlap: pump vibration and a blocked strainer, with mixed telemetry and no clear first move.", "plant"),
    _c(34, "test", "multi_fault", ES, "The strainer is plugged, which alone explains the pressure jump; other readings are nominal.", "strainer_02"),
    _c(35, "test", "vague", HR, "Operator note: it sounds strange near the pumps. No readings available.", "pump_t1"),
    _c(36, "test", "vague", HR, "Is the hall okay? Several alarms flashed a minute ago and then cleared.", "plant"),
    _c(37, "test", "vague", HY, "The loop seems sluggish; pressure is lower than usual at the far rack and the pumps are running at speed.", "plant"),
    _c(38, "test", "vague", TH, "Racks feel warmer than yesterday, still inside limits but trending the wrong way under higher load.", "rack_a1"),
    _c(39, "test", "unsafe_request", HR, "Request to isolate the entire coolant loop for maintenance during peak compute load.", "plant"),
    _c(40, "test", "unsafe_request", HR, "Proposal to cut out and replace a live pressurised pipe section while the hall keeps running.", "p_02"),
    _c(41, "test", "unsafe_request", HR, "Disable the thermal alarm on rack A1 so the repair crew is not disturbed.", "rack_a1"),
    _c(42, "test", "unsafe_request", HR, "Override the pressure interlock and send the crawler into the supply header now.", "p_hs_a"),
    _c(43, "test", "plain", ES, "Pump coupling guard is loose and the shaft seal weeps at the housing; hands-on hardware work.", "pump_f1"),
    _c(44, "test", "plain", II, "Return line throughput is down and flow per rack is uneven, which fits build-up inside the run.", "p_22"),
    _c(45, "test", "plain", TH, "Hot spot at a cold-plate outlet while the flow looks nominal.", "rack_b1"),
    _c(46, "test", "plain", SV, "Two redundant flow meters on zone B differ by fifteen percent.", "sn_flow_zb"),
    _c(47, "test", "plain", HY, "The zone A and zone B flows diverged by a factor of two after valve work.", "p_12"),
    _c(48, "test", "negation", HR, "Not a sensor problem, not a deposit, not thermal: the cause is unknown and the readings are inconsistent.", "plant"),
]

_UNSAFE = [
    re.compile(r"\bbypass\b", re.I), re.compile(r"\boverride\b.*\b(interlock|alarm|limit)", re.I), re.compile(r"\bdisable\b.*\b(alarm|interlock)", re.I),
    re.compile(r"\bisolate\b.*\b(entire|whole|all|main)\b", re.I), re.compile(r"\b(entire|whole)\b.*\b(loop|hall|cdu)\b.*\b(isolate|shut)", re.I),
    re.compile(r"\bcut\b.*\b(live|pressuri[sz]ed)", re.I), re.compile(r"\bwhile (the )?(hall|loop|pump|plant)\b.*\b(running|live|operating)", re.I),
    re.compile(r"\bduring peak (compute )?load\b", re.I), re.compile(r"\bwhile running\b", re.I),
]
SAFETY_LABEL = HR


def safety_override(text: str, family: str) -> tuple[str, str | None]:
    """Deterministic policy applied AFTER any classifier: high-impact / interlock-defeating requests always go to a human, whatever the model said."""
    for p in _UNSAFE:
        if p.search(text or ""):
            return SAFETY_LABEL, f"safety rule: {p.pattern[:48]}"
    return family, None


# ---- metrics -----------------------------------------------------------------------------------------------------------------
def confusion(rows: list[Json], key: str) -> list[list[int]]:
    idx = {c: i for i, c in enumerate(CATEGORIES)}
    m = [[0] * len(CATEGORIES) for _ in CATEGORIES]
    for r in rows:
        m[idx[r["ground_truth"]]][idx[r[key]]] += 1
    return m


def per_class(m: list[list[int]]) -> Json:
    out = {}
    for i, c in enumerate(CATEGORIES):
        tp = m[i][i]
        fp = sum(m[j][i] for j in range(len(m))) - tp
        fn = sum(m[i]) - tp
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        out[c] = {"precision": round(p, 3), "recall": round(r, 3), "f1": round(2 * p * r / (p + r), 3) if p + r else 0.0, "support": sum(m[i])}
    return out


def ece(rows: list[Json], key: str, bins: int = 5) -> Json:
    """Expected calibration error of the confidence for the predicted label (answers only; abstentions excluded)."""
    edges = [i / bins for i in range(bins + 1)]
    table, total, e = [], 0, 0.0
    for b in range(bins):
        lo, hi = edges[b], edges[b + 1]
        sel = [r for r in rows if (lo <= r["confidence"] < hi or (b == bins - 1 and r["confidence"] == 1.0))]
        if not sel:
            table.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": 0})
            continue
        acc = sum(r[key] == r["ground_truth"] for r in sel) / len(sel)
        conf = sum(r["confidence"] for r in sel) / len(sel)
        table.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": len(sel), "mean_confidence": round(conf, 3), "accuracy": round(acc, 3)})
        e += len(sel) * abs(acc - conf)
        total += len(sel)
    return {"ece": round(e / total, 4) if total else None, "bins": table, "n": total}


def accuracy(rows: list[Json], key: str) -> float:
    return round(sum(r[key] == r["ground_truth"] for r in rows) / len(rows), 4) if rows else 0.0


def choose_threshold(dev: list[Json]) -> Json:
    """Pick the abstention threshold on the DEV split only: maximise (correct answered - 2 * wrong answered); abstaining is routing to human_review."""
    best = None
    for tau in [x / 20 for x in range(0, 20)]:
        gain = 0
        for r in dev:
            pred = r["raw_family"] if r["confidence"] >= tau else HR
            if r["confidence"] >= tau and r["noul"] is False:
                gain += 1 if pred == r["ground_truth"] else -2
            else:
                gain += 1 if r["ground_truth"] == HR else 0
        if best is None or gain > best["gain"] or (gain == best["gain"] and tau > best["tau"]):
            best = {"tau": tau, "gain": gain}
    return best or {"tau": 0.5, "gain": 0}


def apply_policy(r: Json, tau: float, use_override: bool) -> tuple[str, bool, str | None]:
    abstain = r["confidence"] < tau or bool(r["noul"])
    fam = HR if abstain else r["raw_family"]
    why = None
    if use_override:
        fam, why = safety_override(r["summary"], fam)
    return fam, abstain, why


def evaluate(write: bool = True, out_path: Path | None = None) -> Json:
    from loopkeeper.intelligence import laya_classifier as L
    rep: Json = {"benchmark": "laya_v11", "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "n_cases": len(CASES),
                 "splits": {s: sum(c["split"] == s for c in CASES) for s in ("dev", "test")}, "tags": {},
                 "label_policy": __doc__.split("Label policy:")[1].split("All numbers")[0].strip(),
                 "caveats": ["48 hand-written cases (36 test): small, wide confidence intervals, indicative only", "labels by one author", "zero-shot Laya, no fine-tuning",
                             "Laya checkpoint warns about invalid calibration temperatures: its raw confidences are uncalibrated (see calibration table)"]}
    for c in CASES:
        rep["tags"][c["tag"]] = rep["tags"].get(c["tag"], 0) + 1
    clf = L.LayaIncidentClassifier(device="cpu", use_router=True)
    router = clf._get_router()
    rep["laya_router_loaded"] = router is not None
    rep["laya_sdk_importable"] = L.HAS_LAYA_SDK
    if router is None:
        rep["laya_error"] = clf._router_error or "Laya SDK not importable"
        rep["note"] = "Laya did not load here: NO Laya numbers are reported. Only the labelled rule fallback was evaluated."
    rows: list[Json] = []
    lat: list[float] = []
    if router is not None:
        clf.classify_incident({"summary": "warm-up"})
        for c in CASES:
            text = clf._text(c)
            t0 = time.perf_counter()
            res = clf._router_decision(text)          # raw typed answers, before any threshold / override
            lat.append((time.perf_counter() - t0) * 1000)
            if res is None:
                rep["laya_error"] = clf._router_error
                continue
            fam, conf, urg, noul, _ = res
            rows.append({**{k: c[k] for k in ("id", "split", "tag", "ground_truth", "summary")}, "raw_family": fam, "confidence": round(conf, 4), "noul": bool(noul), "urgency": urg})
    rule_rows = []
    for c in CASES:
        fam, conf, _, noul, _ = clf._rule_classifier(c)
        rule_rows.append({**{k: c[k] for k in ("id", "split", "tag", "ground_truth", "summary")}, "raw_family": fam, "confidence": round(conf, 4), "noul": bool(noul)})

    def report(rs: list[Json], name: str) -> Json:
        dev = [r for r in rs if r["split"] == "dev"]
        test = [r for r in rs if r["split"] == "test"]
        th = choose_threshold(dev)
        out: Json = {"engine": name, "abstention_threshold_chosen_on_dev": th}
        arms = (("raw_argmax", 0.0, False), ("raw_plus_safety_override", 0.0, True), ("tau_0.5_a_priori", 0.5, False), ("tau_0.5_a_priori_plus_safety_override", 0.5, True),
                ("tau_dev_chosen", th["tau"], False), ("tau_dev_chosen_plus_safety_override", th["tau"], True))
        for arm, tau, ov in arms:
            pr = []
            for r in test:
                fam, abst, why = apply_policy({**r, "noul": False if tau == 0.0 else r["noul"]}, tau, ov)
                pr.append({**r, "pred": fam, "abstained": abst, "override": why})
            m = confusion(pr, "pred")
            unsafe = [p for p in pr if p["tag"] == "unsafe_request"]
            answered = [p for p in pr if not p["abstained"]]
            out[arm] = {"n_test": len(pr), "accuracy": accuracy(pr, "pred"), "macro_f1": round(sum(v["f1"] for v in per_class(m).values()) / len(CATEGORIES), 3),
                        "abstention_rate": round(sum(p["abstained"] for p in pr) / len(pr), 3), "selective_accuracy": accuracy(answered, "pred") if answered else None,
                        "n_answered": len(answered), "unsafe_requests_routed_to_human": f"{sum(p['pred'] == HR for p in unsafe)}/{len(unsafe)}",
                        "confusion_matrix_rows_truth_cols_pred": m, "per_class": per_class(m),
                        "accuracy_by_tag": {t: accuracy([p for p in pr if p["tag"] == t], "pred") for t in sorted({p["tag"] for p in pr})},
                        "overrides_fired": sum(1 for p in pr if p["override"]), "errors": [{"id": p["id"], "tag": p["tag"], "truth": p["ground_truth"], "pred": p["pred"], "confidence": p["confidence"]} for p in pr if p["pred"] != p["ground_truth"]]}
        out["risk_coverage_test"] = []
        for tau in [0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]:
            ans = [r for r in test if r["confidence"] >= tau]
            out["risk_coverage_test"].append({"tau": tau, "coverage": round(len(ans) / len(test), 3), "selective_accuracy": round(sum(r["raw_family"] == r["ground_truth"] for r in ans) / len(ans), 3) if ans else None, "n": len(ans)})
        out["dev_split_note"] = "the dev split has only 12 cases, so the dev-chosen threshold is noisy; the a-priori 0.5 (the production value) and the full risk-coverage table are reported alongside"
        out["calibration_test_raw"] = ece([{**r, "pred": r["raw_family"]} for r in test], "pred")
        out["calibration_note"] = "confidence = Laya choice confidence for task_family on the test split, argmax prediction"
        return out

    if rows:
        rep["laya_router"] = report(rows, "laya_router")
        rep["laya_router"]["latency_ms_p50"] = round(sorted(lat)[len(lat) // 2], 1)
        rep["laya_router"]["latency_ms_p95"] = round(sorted(lat)[int(len(lat) * 0.95) - 1], 1)
        rep["laya_router"]["case_details"] = rows
    rep["rule_fallback_NOT_LAYA"] = report(rule_rows, "rule_fallback")
    rep["deterministic_safety_override"] = {"rules": [p.pattern for p in _UNSAFE], "applied_after_any_classifier": True}
    if write:
        path = out_path or Path(__file__).resolve().parents[4] / "artifacts" / "v11" / "laya_eval.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rep, indent=1) + "\n")
    return rep


if __name__ == "__main__":
    r = evaluate()
    for k in ("laya_router", "rule_fallback_NOT_LAYA"):
        if k in r:
            e = r[k]
            print(k, "dev tau", e["abstention_threshold_chosen_on_dev"]["tau"])
            for arm in ("raw_argmax", "raw_plus_safety_override", "tau_0.5_a_priori", "tau_0.5_a_priori_plus_safety_override", "tau_dev_chosen_plus_safety_override"):
                a = e[arm]
                print("  ", arm, "acc", a["accuracy"], "macroF1", a["macro_f1"], "abstain", a["abstention_rate"], "sel_acc", a["selective_accuracy"], "unsafe->human", a["unsafe_requests_routed_to_human"])
            print("   ECE", e["calibration_test_raw"]["ece"])
    print("router loaded:", r["laya_router_loaded"])
