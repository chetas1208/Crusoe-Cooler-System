"""Batch driver for the recursive arm and the memory ablation. Results go to artifacts/v11/recursive/*.jsonl (one row per run, appended as runs finish,
resumable: finished (arm, scenario, seed) keys are skipped). A spend guard stops submitting work once the logged real spend would pass the cap.

    cd backend && set -a && . ../.env && set +a
    uv run python -m loopkeeper.eval.recursive_runner det                 # runtime WITHOUT a model (deterministic fallback), free
    uv run python -m loopkeeper.eval.recursive_runner model               # arm 3: runtime + real Crusoe via the gateway
    uv run python -m loopkeeper.eval.recursive_runner train               # memory training episodes on DEV seeds only (writes brain.pkl)
    uv run python -m loopkeeper.eval.recursive_runner ablate              # memory ON (pretrained brain) + OFF replicate on the held-out subset
"""
from __future__ import annotations

import asyncio
import json
import os
import pickle
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from . import fixtures as F
from .recursive import export_brain, run_recursive

Json = dict[str, Any]
ART = F.ROOT / "artifacts" / "v11"
OUT = ART / "recursive"
SPEND_CAP_USD = float(os.environ.get("EVAL_RECURSIVE_SPEND_CAP_USD", "5.0"))
ABLATION_SCENARIOS = tuple(os.environ.get("EVAL_ABLATION_SCENARIOS", "CR-01,CR-06,CR-07,MD-01").split(","))


def _file(arm: str) -> Path:
    return OUT / f"{arm}.jsonl"


def load_rows(arm: str) -> list[Json]:
    p = _file(arm)
    return [json.loads(x) for x in p.read_text().splitlines() if x.strip()] if p.exists() else []


def total_spend() -> float:
    return round(sum(r.get("cost_usd") or 0.0 for p in OUT.glob("*.jsonl") for r in (json.loads(x) for x in p.read_text().splitlines() if x.strip())), 6) if OUT.exists() else 0.0


def _job(job: Json) -> Json:
    try:
        r = asyncio.run(run_recursive(job["scenario"], job["seed"], use_model=job["use_model"], calls_dir=str(OUT / "calls" / job["arm"]), memory=job.get("memory", False),
                                      brain_rows=job.get("brain_rows"), tag=job["tag"], run_id=job.get("run_id")))
    except Exception as e:  # noqa: BLE001
        r = {"scenario_id": job["scenario"], "seed": job["seed"], "arm": job["tag"], "error": f"{type(e).__name__}: {str(e)[:200]}"}
    r["phase_arm"] = job["arm"]
    return r


def run_jobs(arm: str, jobs: list[Json], workers: int) -> list[Json]:
    OUT.mkdir(parents=True, exist_ok=True)
    done = {(r["scenario_id"], r["seed"]) for r in load_rows(arm) if "error" not in r}
    todo = [j for j in jobs if (j["scenario"], j["seed"]) not in done]
    print(f"[{arm}] {len(jobs)} jobs, {len(done)} done, {len(todo)} to run, spend so far ${total_spend():.4f} cap ${SPEND_CAP_USD}", flush=True)
    spent0 = total_spend()
    t0 = time.time()
    n = 0
    with ProcessPoolExecutor(workers) as ex, _file(arm).open("a") as fh:
        futs = [ex.submit(_job, j) for j in todo]
        for f in as_completed(futs):
            r = f.result()
            fh.write(json.dumps(r, default=str) + "\n")
            fh.flush()
            n += 1
            spent = total_spend()
            print(f"  {n}/{len(todo)} {r.get('scenario_id')} {r.get('seed')} claim={r.get('claim_success')} rec={r.get('recovered')} fs={r.get('false_success')} err={r.get('error') or r.get('run_error')} cost=${r.get('cost_usd')} total=${spent:.4f} {round(time.time()-t0)}s", flush=True)
            if spent >= SPEND_CAP_USD * 0.9:
                print("SPEND GUARD: stopping, cap nearly reached", flush=True)
                for g in futs:
                    g.cancel()
                break
    return load_rows(arm)


def _jobs(arm: str, tag: str, use_model: bool, scenarios: list[str], seeds: list[int], **kw: Any) -> list[Json]:
    return [{"arm": arm, "tag": tag, "scenario": s, "seed": sd, "use_model": use_model, **kw} for s in scenarios for sd in seeds]


def main() -> None:
    phase = sys.argv[1] if len(sys.argv) > 1 else "det"
    man = F.freeze()
    scenarios, seeds = list(man["scenarios"]), list(man["held_out_seeds"])
    if len(sys.argv) > 2:
        scenarios = [s for s in scenarios if s in sys.argv[2].split(",")]
    workers = int(os.environ.get("EVAL_WORKERS", "14"))
    os.environ.setdefault("CRUSOE_MAX_REQUESTS_PER_MIN", os.environ.get("EVAL_RPM_PER_WORKER", "20"))
    os.environ.setdefault("CRUSOE_SPEND_CEILING_USD", "0.25")            # per run (one gateway per run)
    os.environ.setdefault("CRUSOE_INCIDENT_SPEND_CEILING_USD", "0.10")
    os.environ.setdefault("INFERENCE_CATALOG_PATH", str(OUT / "catalog_cache.json"))
    os.environ.setdefault("INFERENCE_PROBE_PATH", str(ART / "capability_probe.json"))
    if phase in ("model", "model5", "train", "ablate"):
        _warm_catalog()
    if phase == "det":
        run_jobs("recursive_det", _jobs("recursive_det", "recursive_det", False, scenarios, seeds), workers)
    elif phase == "model":
        run_jobs("recursive", _jobs("recursive", "recursive", True, scenarios, seeds), workers)
    elif phase == "model5":                                   # same arm, run at low concurrency (set EVAL_WORKERS=5) to avoid provider 503 load shedding
        run_jobs("recursive_w5", _jobs("recursive_w5", "recursive", True, scenarios, seeds), workers)
    elif phase == "train":
        train(scenarios, workers)
    elif phase == "ablate":
        ablate(scenarios, seeds, workers)
    print("total real spend $", total_spend())


def _warm_catalog() -> None:
    from ..inference.default import build_default_gateway
    from ..intelligence.crusoe import IntelligenceConfig

    async def go() -> None:
        gw = await build_default_gateway(IntelligenceConfig.from_env(), "warm")
        await gw.aclose()
    OUT.mkdir(parents=True, exist_ok=True)
    asyncio.run(go())


def train(scenarios: list[str], workers: int) -> None:
    """Training episodes = DEV seeds only (never in the held-out set). Each episode runs with memory ON writing proposals that the independent verifier then settles;
    the resulting brain rows (VERIFIED lessons/facts only are readable) are collected in one pickle and handed to every held-out ON run as a private copy."""
    from ..memory.store import store_for
    from ..storage.memory import MemoryStorage
    sel = [s for s in scenarios if s in ABLATION_SCENARIOS]
    assert not set(F.DEV_SEEDS) & set(F.HELD_OUT_SEEDS)
    jobs = _jobs("train", "train", True, sel, list(F.DEV_SEEDS), memory=True)
    # sequential training so lessons accumulate: one storage per scenario, run in a single process each (3 dev seeds) - scenarios in parallel
    OUT.mkdir(parents=True, exist_ok=True)
    rows: dict[str, list[Json]] = {}
    results: list[Json] = []
    with ProcessPoolExecutor(min(workers, len(sel))) as ex:
        futs = {ex.submit(_train_scenario, s): s for s in sel}
        for f in as_completed(futs):
            br, res = f.result()
            results += res
            for k, v in br.items():
                rows.setdefault(k, []).extend(v)
    with (OUT / "brain.pkl").open("wb") as fh:
        pickle.dump(rows, fh)
    with _file("train").open("a") as fh:
        for r in results:
            fh.write(json.dumps(r, default=str) + "\n")
    (OUT / "brain_summary.json").write_text(json.dumps({k: [{c: r.get(c) for c in ("lesson_id", "fact_id", "fault_kind", "asset_type", "status", "confidence", "steps", "claim", "success_count", "source_run_ids") if c in r} for r in v] for k, v in rows.items()}, indent=1, default=str))
    print("brain rows", {k: len(v) for k, v in rows.items()}, flush=True)
    _ = (jobs, store_for, MemoryStorage)


def _train_scenario(s: str) -> tuple[dict, list[Json]]:
    from ..storage.memory import MemoryStorage
    storage = MemoryStorage()
    out = []
    for sd in F.DEV_SEEDS:
        r = asyncio.run(run_recursive(s, sd, use_model=True, calls_dir=str(OUT / "calls" / "train"), memory=True, storage=storage, tag="train"))
        r["phase_arm"] = "train"
        out.append(r)
    return export_brain(storage), out


def ablate(scenarios: list[str], seeds: list[int], workers: int) -> None:
    sel = [s for s in scenarios if s in ABLATION_SCENARIOS]
    with (OUT / "brain.pkl").open("rb") as fh:
        brain = pickle.load(fh)
    run_jobs("recursive_mem_on", _jobs("recursive_mem_on", "recursive_mem_on", True, sel, seeds, memory=True, brain_rows=brain), workers)
    run_jobs("recursive_mem_off2", _jobs("recursive_mem_off2", "recursive_mem_off2", True, sel, seeds, memory=False), workers)


if __name__ == "__main__":
    main()
