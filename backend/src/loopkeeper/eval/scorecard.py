"""Assemble the V11 scorecard v2: keeps the frozen baseline arms (no_action / static / single_pass: 270 real runs, replay determinism, unsafe probe) from the existing
scorecard.json untouched and adds the RECURSIVE arm (runtime with real Crusoe via the gateway), the same runtime with NO model (deterministic fallback; free), the
memory ON/OFF ablation, paired comparisons and clustered intervals. Writes artifacts/v11/scorecard.json and a git-visible copy docs/engineering/V11_SCORECARD.json.

    cd backend && uv run python -m loopkeeper.eval.scorecard
"""
from __future__ import annotations

import json
import random
import time
from pathlib import Path
from typing import Any, Callable

from . import fixtures as F
from .recursive_runner import ABLATION_SCENARIOS, OUT, load_rows, total_spend
from .runner import ART, aggregate, wilson

Json = dict[str, Any]
DOCS = F.ROOT / "docs" / "engineering" / "V11_SCORECARD.json"
BOOT = 5000
KEEP = ("scenario_id", "seed", "arm", "onset_s", "claim_success", "safe_at_claim", "false_success", "false_success_final", "recovered", "recover_after_onset_s", "contained_after_onset_s",
        "was_harmed", "final", "cost_usd", "tokens", "actions_traced", "actions_total", "unsafe_proposed", "unsafe_blocked", "unsafe_executed", "commands_submitted", "n_incidents", "incidents",
        "detect_latency_s", "replan", "tasks", "model_calls", "undetected", "claim_t", "memory_stats", "decision", "sim_end_s", "run_error", "error", "use_model", "memory", "outcome_hash", "wall_s")


def _verified(r: Json) -> int:
    return int(bool(r.get("claim_success") and r.get("recovered") and not r.get("false_success")))


def _rng() -> random.Random:
    return random.Random(11)


def cluster_ci(clusters: dict[str, list[float]], boot: int = BOOT) -> list[float | None]:
    """Percentile bootstrap over SCENARIOS (the unit that actually varies; seeds barely change model output). Mean of per-cluster means."""
    ks = [k for k, v in clusters.items() if v]
    if len(ks) < 2:
        return [None, None]
    means = {k: sum(clusters[k]) / len(clusters[k]) for k in ks}
    rng, out = _rng(), []
    for _ in range(boot):
        out.append(sum(means[rng.choice(ks)] for _ in ks) / len(ks))
    out.sort()
    return [round(out[int(0.025 * boot)], 3), round(out[int(0.975 * boot) - 1], 3)]


def rate(rows: list[Json], f: Callable[[Json], float]) -> Json:
    rs = [r for r in rows if "error" not in r]
    n = len(rs)
    k = sum(f(r) for r in rs)
    cl: dict[str, list[float]] = {}
    for r in rs:
        cl.setdefault(r["scenario_id"], []).append(f(r))
    return {"k": int(k), "n": n, "rate": round(k / n, 3) if n else None, "wilson95_n_runs": wilson(int(k), n), "cluster_bootstrap95_over_scenarios": cluster_ci(cl),
            "per_scenario": {s: round(sum(v) / len(v), 2) for s, v in sorted(cl.items())}}


def seed_variation(rows: list[Json]) -> Json:
    """How many scenario cells have identical (claim, recovered, false_success) across all their seeds = evidence that seeds barely vary the outcome."""
    cells: dict[str, set] = {}
    for r in rows:
        if "error" in r:
            continue
        cells.setdefault(r["scenario_id"], set()).add((bool(r.get("claim_success")), bool(r.get("recovered")), bool(r.get("false_success"))))
    ident = sum(1 for v in cells.values() if len(v) == 1)
    return {"scenarios": len(cells), "scenarios_with_identical_outcome_across_seeds": ident, "effective_sample_note": "effective n is closer to the number of scenarios than to the number of runs" if ident >= len(cells) * 0.6 else "seeds do change outcomes in several scenarios"}


def paired(a: list[Json], b: list[Json], metric: Callable[[Json], float | None], name: str) -> Json:
    """b - a over (scenario, seed) pairs where both have the metric. CI = bootstrap over scenarios of per-scenario mean differences."""
    ka = {(r["scenario_id"], r["seed"]): metric(r) for r in a if "error" not in r}
    kb = {(r["scenario_id"], r["seed"]): metric(r) for r in b if "error" not in r}
    pairs = [(k, kb[k] - ka[k]) for k in ka if k in kb and ka[k] is not None and kb[k] is not None]
    cl: dict[str, list[float]] = {}
    for (s, _), d in pairs:
        cl.setdefault(s, []).append(d)
    d = [x for _, x in pairs]
    n = len(d)
    return {"metric": name, "n_pairs": n, "dropped": len(set(ka) | set(kb)) - n, "mean_delta_b_minus_a": round(sum(d) / n, 4) if n else None, "wins_b": sum(1 for x in d if x > 0), "losses_b": sum(1 for x in d if x < 0),
            "ties": sum(1 for x in d if x == 0), "cluster_bootstrap95_over_scenarios": cluster_ci(cl), "per_scenario_mean_delta": {s: round(sum(v) / len(v), 3) for s, v in sorted(cl.items())}}


def _rec_scenarios(rows: list[Json]) -> Json:
    out: Json = {}
    for s in sorted({r["scenario_id"] for r in rows}):
        rs = [r for r in rows if r["scenario_id"] == s and "error" not in r]
        causes: dict[str, int] = {}
        for r in rs:
            for i in r.get("incidents", []):
                causes[i["cause"]] = causes.get(i["cause"], 0) + 1
        out[s] = {"n": len(rs), "fidelity": F.FIDELITY[s]["fidelity"], "incident_opened": sum(1 for r in rs if r.get("n_incidents", 0) > 0), "no_incident_undetected": sum(1 for r in rs if not r.get("n_incidents")),
                  "escalated": sum(1 for r in rs if any(i["status"] == "escalated" for i in r.get("incidents", []))), "dismissed_monitor_only": sum(1 for r in rs if r.get("incidents") and all(i["status"] == "dismissed" for i in r["incidents"])),
                  "claims_success": sum(1 for r in rs if r.get("claim_success")), "verified": sum(_verified(r) for r in rs), "false_success": sum(1 for r in rs if r.get("false_success")),
                  "plant_recovered_at_end": sum(1 for r in rs if r.get("recovered")), "incident_causes_seen": causes,
                  "runtime_status": ("SUPPORTED" if sum(1 for r in rs if r.get("n_incidents", 0) > 0) == len(rs) and sum(_verified(r) for r in rs) > 0 else
                                     "UNSUPPORTED: runtime opened no incident (no detector / handler for this fault class)" if all(not r.get("n_incidents") for r in rs) else "PARTIAL")}
    return out


def agg_recursive(rows: list[Json], arm: str) -> Json:
    a = aggregate(rows, arm)
    rs = [r for r in rows if "error" not in r]
    cases = sum(r.get("replan", {}).get("cases", 0) for r in rs)
    ok = sum(r.get("replan", {}).get("recovered", 0) for r in rs)
    a["replan_recovery"] = {"incidents_with_a_rejected_first_attempt": cases, "of_those_later_verified_and_resolved": ok, "definition": "incident whose independent verifier rejected an attempt, then replanned and closed VERIFIED"}
    a["verified_completion"].update(cluster_bootstrap95_over_scenarios=rate(rs, _verified)["cluster_bootstrap95_over_scenarios"])
    a["false_success"]["definition"] = "the runtime closed its incident(s) VERIFIED (claim) while truth was not safe at that instant; no claim = escalated / no incident / dismissed"
    a["escalations"] = sum(1 for r in rs if any(i["status"] == "escalated" for i in r.get("incidents", [])))
    a["no_incident_undetected_runs"] = sum(1 for r in rs if not r.get("n_incidents"))
    a["detect_latency_s_median"] = _median([r["detect_latency_s"] for r in rs if r.get("detect_latency_s") is not None])
    a["policy_gate"] = {"commands_submitted": sum(r.get("commands_submitted", 0) for r in rs), "policy_blocked": sum(r.get("unsafe_blocked", 0) for r in rs), "unsafe_executed_on_plant": sum(r.get("unsafe_executed", 0) for r in rs)}
    a["model_calls"] = {"network": sum(r.get("model_calls", {}).get("network", 0) for r in rs), "error_rows": sum(len(r.get("model_calls", {}).get("errors", [])) for r in rs),
                        "decision_tasks_not_labelled_fallback": sum(r.get("tasks", {}).get("model", 0) for r in rs), "decision_tasks_labelled_fallback": sum(r.get("tasks", {}).get("fallback", 0) for r in rs)}
    a["per_scenario_runtime"] = _rec_scenarios(rs)
    a["seed_variation"] = seed_variation(rs)
    a["by_rate_with_clusters"] = {"verified": rate(rs, _verified), "false_success_per_run": rate(rs, lambda r: float(bool(r.get("false_success")))),
                                  "plant_recovered": rate(rs, lambda r: float(bool(r.get("recovered"))))}
    return a


def _median(xs: list[float]) -> float | None:
    xs = sorted(xs)
    return round(xs[len(xs) // 2], 1) if xs else None


def mem_effect(off1: list[Json], off2: list[Json], on: list[Json]) -> Json:
    sub = set(ABLATION_SCENARIOS)
    off1 = [r for r in off1 if r["scenario_id"] in sub]
    metrics = [("verified_completion", lambda r: float(_verified(r))), ("false_success", lambda r: float(bool(r.get("false_success")))),
               ("plant_recovered", lambda r: float(bool(r.get("recovered")))), ("recover_after_onset_s", lambda r: r.get("recover_after_onset_s")),
               ("cost_usd", lambda r: r.get("cost_usd")), ("replan_cases", lambda r: float(r.get("replan", {}).get("cases", 0)))]
    res: Json = {"scenarios": sorted(sub), "seeds": len({r["seed"] for r in off1}), "design": "OFF = recursive arm rows (MEMORY_ENABLED=0); OFF2 = an identical OFF replicate (noise floor); ON = brain pre-trained on DEV seeds only (3 seeds, verified outcomes only), "
                 "private copy per held-out run; same plant, scenarios, held-out seeds, gateway limits and budgets", "n": {"off": len(off1), "off2": len(off2), "on": len(on)}}
    res["on_minus_off"] = [paired(off1, on, f, n) for n, f in metrics]
    res["off2_minus_off_noise_floor"] = [paired(off1, off2, f, n) for n, f in metrics]
    mem_reads = [r.get("memory_stats") or {} for r in on]
    res["memory_activity_on_runs"] = {"runs_with_stats": sum(1 for m in mem_reads if m), "reads": sum(m.get("reads", 0) for m in mem_reads), "items_returned": sum(m.get("items_returned", 0) for m in mem_reads), "errors": sum(m.get("errors", 0) for m in mem_reads)}
    return res


def verdict(me: Json) -> str:
    v = next((m for m in me["on_minus_off"] if m["metric"] == "verified_completion"), None)
    if not v or not v["n_pairs"]:
        return "not measured"
    lo, hi = v["cluster_bootstrap95_over_scenarios"]
    noise = next(m for m in me["off2_minus_off_noise_floor"] if m["metric"] == "verified_completion")
    if v["mean_delta_b_minus_a"] == 0 and v["wins_b"] == 0 and v["losses_b"] == 0:
        return "NO MEASURABLE DIFFERENCE: every paired run has the identical verified-completion outcome with memory ON and OFF"
    if lo is not None and lo <= 0 <= hi:
        return f"NO MEASURABLE DIFFERENCE: mean paired delta {v['mean_delta_b_minus_a']:+.3f} verified completion, scenario-bootstrap 95% CI [{lo}, {hi}] includes 0 (wins {v['wins_b']}, losses {v['losses_b']}, ties {v['ties']}; noise floor wins {noise['wins_b']}/losses {noise['losses_b']})"
    return f"MEASURABLE: mean paired delta {v['mean_delta_b_minus_a']:+.3f}, CI [{lo}, {hi}] excludes 0 (check against the OFF-vs-OFF replicate: wins {noise['wins_b']}/losses {noise['losses_b']})"


def compact(rows: list[Json]) -> list[Json]:
    return [{k: r[k] for k in KEEP if k in r} for r in rows]


def main() -> None:
    v1 = ART / "scorecard_v1_baseline.json"
    if not v1.exists():                                              # the 270-run baseline (Agent C) is preserved byte-for-byte before the first v2 write
        v1.write_text((ART / "scorecard.json").read_text())
    card = json.loads(v1.read_text())
    base_arms = {a: card["arms"][a] for a in ("no_action", "static", "single_pass")}
    base_runs = [r for r in card["runs"] if r.get("arm") in base_arms and not r.get("replay")]
    w5, w14 = load_rows("recursive_w5"), load_rows("recursive_w14_layaon")
    rec, rep = (w5, w14) if w5 else (w14, [])                       # primary = the low-concurrency run on the CURRENT build; the earlier-build runs are kept as a before/after record
    rep2 = load_rows("recursive_w5_layaon")                           # first 5-worker run (Laya router ON, strict trace definition): second replicate
    det = load_rows("recursive_det")
    on = load_rows("recursive_mem_on")
    off2 = load_rows("recursive_mem_off2")
    rep2[:] = [r for r in rep2 if "error" not in r]
    for rs in (rec, rep, det, on, off2):
        rs[:] = [r for r in rs if "error" not in r]
    arms = dict(base_arms)
    for a in base_arms:                                              # add the scenario-cluster interval + seed-variation to the frozen baseline arms (numbers themselves untouched)
        rs = [r for r in base_runs if r["arm"] == a and "error" not in r]
        arms[a] = {**base_arms[a], "verified_completion": {**base_arms[a]["verified_completion"], "cluster_bootstrap95_over_scenarios": rate(rs, _verified)["cluster_bootstrap95_over_scenarios"]},
                   "seed_variation": seed_variation(rs)}
    if rec:
        arms["recursive"] = agg_recursive(rec, "recursive")
    legacy_trace = {"actions_traced": None, "actions_total": None, "rate": None, "note": "run on an EARLIER runtime build (high-impact L3 isolation was auto-approved by the veto window; Laya router ON; first, stricter trace definition) - kept as a before/after record, not as a replicate of the current build"}
    if rep:
        arms["recursive_prior_build_w14"] = {**agg_recursive([{**r, "arm": "recursive_prior_build_w14"} for r in rep], "recursive_prior_build_w14"), "trace_coverage": legacy_trace}
    if rep2:
        arms["recursive_prior_build_w5"] = {**agg_recursive([{**r, "arm": "recursive_prior_build_w5"} for r in rep2], "recursive_prior_build_w5"), "trace_coverage": legacy_trace}
    if det:
        arms["recursive_det_no_llm"] = agg_recursive([{**r, "arm": "recursive_det_no_llm"} for r in det], "recursive_det_no_llm")
    # ---- paired comparisons (scenario, seed) on verified completion
    cmp: Json = {}
    if rec:
        by = {a: [r for r in base_runs if r["arm"] == a] for a in base_arms}
        for other in ("static", "single_pass", "no_action"):
            cmp[f"recursive_minus_{other}_verified_completion"] = paired(by[other], rec, lambda r: float(_verified(r)), "verified_completion")
        cmp["recursive_minus_single_pass_false_success_per_run"] = paired(by["single_pass"], rec, lambda r: float(bool(r.get("false_success"))), "false_success_per_run")
        cmp["recursive_minus_static_false_success_per_run"] = paired(by["static"], rec, lambda r: float(bool(r.get("false_success"))), "false_success_per_run")
        if rep2:
            cmp["prior_build_w5_minus_primary_verified_completion"] = paired(rec, rep2, lambda r: float(_verified(r)), "verified_completion")
            cmp["prior_build_w5_minus_primary_recover_after_onset_s"] = paired(rec, rep2, lambda r: r.get("recover_after_onset_s"), "recover_after_onset_s")
        if rep:
            cmp["prior_build_w14_minus_primary_verified_completion"] = paired(rec, rep, lambda r: float(_verified(r)), "verified_completion")
            cmp["prior_build_w14_minus_primary_recover_after_onset_s"] = paired(rec, rep, lambda r: r.get("recover_after_onset_s"), "recover_after_onset_s")
        if det:
            cmp["recursive_llm_minus_runtime_no_llm_verified_completion"] = paired(det, rec, lambda r: float(_verified(r)), "verified_completion")
            cmp["recursive_llm_minus_runtime_no_llm_recover_after_onset_s"] = paired(det, rec, lambda r: r.get("recover_after_onset_s"), "recover_after_onset_s")
    abl = None
    if on and off2 and rec:
        abl = mem_effect(rec, off2, on)
        abl["verdict"] = verdict(abl)
        train = load_rows("train")
        abl["training"] = {"episodes": len(train), "scenarios": sorted({r["scenario_id"] for r in train}), "dev_seeds": list(F.DEV_SEEDS), "verified_episodes": sum(_verified(r) for r in train), "cost_usd": round(sum(r.get("cost_usd", 0) for r in train), 5)}
        bs = OUT / "brain_summary.json"
        abl["brain_rows_after_training"] = {k: len(v) for k, v in json.loads(bs.read_text()).items()} if bs.exists() else None
    arms_files = sorted(p.stem for p in OUT.glob("*.jsonl"))
    spend = {a: round(sum(r.get("cost_usd", 0.0) for r in load_rows(a)), 5) for a in arms_files}
    spend["runtime_probe"] = (json.loads((OUT / "runtime_probe.json").read_text()).get("cost_usd") if (OUT / "runtime_probe.json").exists() else 0.0)
    spend["total_this_work_usd"] = round(total_spend() + (spend.get("runtime_probe") or 0.0), 6)
    base_spend = card.get("baseline_spend") or card["spend"]
    spend["baseline_arms_usd"] = base_spend.get("est_cost_usd")
    spend["cap_usd"] = 5.0
    spend["model_calls_network"] = sum(r.get("model_calls", {}).get("network", 0) for a in arms_files for r in load_rows(a))
    spend["pricing_note"] = "est. from catalog pricing treated as USD per 1M tokens (unit not stated by the API)"
    probe_p = OUT / "runtime_probe.json"
    import subprocess
    from ..orchestration import Limits
    try:
        head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=F.ROOT, timeout=10).stdout.strip()
    except Exception:                                              # noqa: BLE001
        head = None
    build = {"git_head": head, "limits_l3_requires_human": Limits().l3_requires_human, "laya_router": "off (rule fallback; set LOOPKEEPER_LAYA_ROUTER=1 to run it)", "inference_gateway": "default client (INFERENCE_GATEWAY=1)",
             "note": "the runtime changed between the earliest and the final runs (V12 L3 policy: isolation / section replacement is never auto-approved); the earlier-build arms record that"}
    card2 = {**{k: card[k] for k in ("manifest_sha256", "prompt_hashes", "n_scenarios", "n_seeds", "replay_determinism", "unsafe_action_probe")}, "schema": "lk.scorecard.v2",
             "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "arms": arms,
             "baseline_spend": base_spend,
             "recursive": {"status": (f"RUN: {len(rec)} runs (9 scenarios x 10 held-out seeds) through the real runtime with real Crusoe via the gateway; a 14-worker replicate and a no-LLM runtime control were also run" if rec else "NOT RUN"), "definition": "real orchestration runtime (monitor, SENTINEL graph, delegated tasks, frozen DOD contract, robot missions, independent verifier Layer A + SEN-05 Layer B) with the real Crusoe client through the inference gateway; "
                           "in-process Stack, MemoryStorage/MemoryDecisionStore/InMemorySaver, never Neon",
                           "not_equalised": ["detection: runtime monitor persistence window (not the harness alarm scan + 60 s confirmation)", "actuation: robot missions with real dispatch/travel time (not a fixed 120 s service latency)",
                                             "the runtime replans and escalates by itself; it may also never open an incident for a fault class it has no detector for",
                                             "claim time = the instant the runtime closes its incident(s) VERIFIED (the verifier window holds checks 28-55 sim s); truth is sampled at that instant",
                                             "model latency is not simulated time (the sim waits for in-flight calls), same as the single-pass arm"]},
             "runtime_build": build, "comparisons_paired": cmp, "memory_ablation": abl, "runtime_unsafe_probe": json.loads(probe_p.read_text()) if probe_p.exists() else None, "spend": spend,
             "statistics_note": "wilson95_n_runs treats the runs as independent (too narrow: seeds change onset +-30 s and plant noise but barely change model output); cluster_bootstrap95_over_scenarios resamples the 9 scenarios (effective n ~9) and is the interval to quote",
             "wall_s": card.get("wall_s"), "runs": base_runs + compact(rec) + compact([{**r, "arm": "recursive_prior_build_w14"} for r in rep]) + compact([{**r, "arm": "recursive_prior_build_w5"} for r in rep2]) + compact(det) + compact(on) + compact(off2)}
    for p in (ART / "scorecard.json", DOCS):
        p.write_text(json.dumps(card2, indent=1, default=str) + "\n")
    for a, g in arms.items():
        print(a, "n", g["n_runs"], "verified", g["verified_completion"]["k"], g["verified_completion"].get("cluster_bootstrap95_over_scenarios"), "recovered", g["plant_recovered_at_end"]["k"],
              "false_success", g["false_success"]["k"], "/", g["false_success"]["n_claims"], "cost", g["cost_usd_total"])
    if abl:
        print("ablation:", abl["verdict"])
    print("spend", spend)


if __name__ == "__main__":
    main()
