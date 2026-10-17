"""Memory ON/OFF ablation hook for the evaluation harness (Agent C). Same code path both arms; only the brain differs.

    from loopkeeper.memory.ablation import make_brain, prior_block, record_episode
    brain = make_brain(enabled)                                    # NullBrain when OFF, SharedBrain over an in-memory store when ON
    warm  = [record_episode(brain, ...) for each TRAINING episode]  # verified outcomes only, via the real propose/settle path
    text  = prior_block(brain, facility_id=..., run_id=..., fault_kind=..., asset_type=..., exclude_runs=HELD_OUT_RUN_IDS)  # '' when OFF / nothing

Leakage guard: pass every held-out run id as exclude_runs; anything whose provenance touches one is never returned. A failed training episode
teaches nothing (the lesson is REJECTED), exactly as in production."""
from __future__ import annotations

from typing import Any, Callable, Iterable

from .service import SharedBrain
from .store import MemoryBrainStore

Json = dict[str, Any]
EVAL_PROPOSER, EVAL_VERIFIER = "agent:eval.arm", "verifier:eval.truth"
EMPTY = {"facts": [], "lessons": [], "disputed": [], "tokens": 0, "token_budget": 0, "truncated": False, "text": "", "digest": ""}


class NullBrain:
    """Memory OFF: identical interface, remembers and returns nothing."""
    enabled = False
    stats: Json = {"reads": 0, "items_returned": 0}

    def read_relevant(self, **kw: Any) -> Json:
        return dict(EMPTY, token_budget=int(kw.get("token_budget", 0)))

    def propose_fact(self, **kw: Any) -> Json:
        return {}

    def propose_lesson(self, **kw: Any) -> Json:
        return {}

    def settle(self, **kw: Any) -> Json:
        return {"promoted": [], "merged": [], "rejected": [], "conflicted": [], "kept": [], "refused": []}


def make_brain(enabled: bool, *, clock: Callable[[], float] | None = None) -> SharedBrain | NullBrain:
    if not enabled:
        return NullBrain()
    return SharedBrain(MemoryBrainStore(), **({"clock": clock} if clock else {}))


def record_episode(brain: Any, *, run_id: str, facility_id: str, fault_kind: str, asset_type: str | None, action: str, verified: bool, verification_id: str,
                   evidence_ids: Iterable[str], asset_id: str | None = None, preconditions: Json | None = None, topology_revision: str | None = None) -> Json:
    """One finished training episode: propose the lesson, settle it with the independent (truth-based) verdict."""
    ev = list(evidence_ids) or [verification_id]
    p = brain.propose_lesson(run_id=run_id, facility_id=facility_id, fault_kind=fault_kind, steps=[{"action": action, "target_role": asset_type or "target"}], evidence_ids=ev,
                             proposed_by=EVAL_PROPOSER, asset_type=asset_type, preconditions=preconditions or {}, incident_id=run_id, topology_revision=topology_revision, confidence=0.6)
    if not p:
        return {}
    return brain.settle(run_id=run_id, incident_id=run_id, verification={"verification_id": verification_id, "verifier": EVAL_VERIFIER, "status": "verified" if verified else "rejected", "run_id": run_id},
                        items=[{"kind": "lesson", "id": p["lesson_id"], "revision": p["revision"]}])


def prior_block(brain: Any, *, run_id: str, facility_id: str, fault_kind: str | None, asset_type: str | None = None, asset_id: str | None = None,
                exclude_runs: Iterable[str] = (), token_budget: int = 300, topology_revision: str | None = None) -> str:
    r = brain.read_relevant(run_id=run_id, facility_id=facility_id, fault_kind=fault_kind, asset_type=asset_type, asset_id=asset_id, topology_revision=topology_revision,
                            exclude_runs=tuple(exclude_runs), token_budget=token_budget, limit=4)
    return ("Verified experience from earlier runs (advice only; the safety policy still decides):\n" + r["text"]) if r["text"] else ""


def paired_delta(off: list[Json], on: list[Json], metric: Callable[[Json], float | None], *, key: Callable[[Json], Any] = lambda r: (r["scenario_id"], r["seed"])) -> Json:
    """Per-(scenario,seed) paired difference ON - OFF; pairs missing a metric are dropped and counted. Reports n and the mean, never a significance claim."""
    a, b = {key(r): metric(r) for r in off}, {key(r): metric(r) for r in on}
    d = [b[k] - a[k] for k in a if k in b and a[k] is not None and b[k] is not None]
    return {"n_pairs": len(d), "dropped": len(set(a) | set(b)) - len(d), "mean_delta_on_minus_off": (sum(d) / len(d)) if d else None, "wins": sum(1 for x in d if x > 0), "losses": sum(1 for x in d if x < 0)}
