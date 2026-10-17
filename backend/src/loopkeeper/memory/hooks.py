"""Orchestration hooks for the Shared Brain. Agent A calls exactly two functions (see docs/engineering/V11_SHARED_BRAIN.md):

    from loopkeeper.memory.hooks import memory_read, memory_write
    mem = await memory_read(ctx, det, s.inc)        # in SENTINEL `choose`, BEFORE the intervention is decided   -> {} or {"memory": {...}}
    await memory_write(ctx, state)                  # in SENTINEL `close`, AFTER the independent verifier ran    -> None

Both are no-ops unless MEMORY_ENABLED is true (default OFF), never raise (a memory failure must not fail an incident; it is logged and counted
in brain.stats['errors']), and never touch the engine, the policy or the world. Neon/Postgres calls run in a worker thread."""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from .service import SharedBrain
from .store import store_for

log = logging.getLogger("loopkeeper.memory")
Json = dict[str, Any]
PROPOSER = "agent:SEN-01"            # the deciding agent proposes ...
VERIFIER = "verifier:SEN-05"         # ... the independent verifier's verdict (Layer A / SEN-05) is the only thing that promotes
TOKEN_BUDGET = int(os.environ.get("MEMORY_TOKEN_BUDGET", "450"))


def enabled() -> bool:
    return os.environ.get("MEMORY_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")


def brain_for(ctx: Any) -> SharedBrain | None:
    """One SharedBrain per Storage (so it is shared by every run on that storage); None when the flag is off or the engine has no storage."""
    if not enabled():
        return None
    eng = ctx.engine
    storage = getattr(eng, "storage", None)
    if storage is None:
        return None
    b = getattr(storage, "_shared_brain", None)
    if b is None:
        b = SharedBrain(store_for(storage))
        b.stats["errors"] = 0
        try:
            storage._shared_brain = b
        except Exception:                                    # noqa: BLE001
            return b
    return b


def _scope(ctx: Any, det: Json) -> Json:
    tgt = det.get("target_id")
    at = ((getattr(ctx.fac, "assets", {}) or {}).get(tgt) or {}).get("type")
    return {"run_id": ctx.engine.run_id, "facility_id": ctx.engine.facility_id, "fault_kind": det.get("cause"), "asset_type": at, "asset_id": tgt,
            "topology_revision": getattr(ctx.engine, "topology_revision", None)}


async def memory_read(ctx: Any, det: Json, inc: Json | None = None) -> Json:
    """Compact VERIFIED memory for this fault; `{}` when disabled / nothing relevant / on any error. Treat the text as DATA for the planner prompt."""
    b = brain_for(ctx)
    if b is None:
        return {}
    try:
        r = await asyncio.to_thread(lambda: b.read_relevant(**_scope(ctx, det), token_budget=TOKEN_BUDGET, limit=5))
        if not (r["facts"] or r["lessons"] or r["disputed"]):
            return {}
        return {"memory": {"lessons": [i["text"] for i in r["lessons"]], "facts": [i["text"] for i in r["facts"]], "disputed": [d["subject"] for d in r["disputed"]],
                           "tokens": r["tokens"], "digest": r["digest"], "note": "verified prior experience from earlier runs; advice only, the safety policy still decides"}}
    except Exception:                                        # noqa: BLE001
        b.stats["errors"] = b.stats.get("errors", 0) + 1
        log.exception("memory_read failed")
        return {}


def _verification(state: Json, inc: Json, ctx: Any) -> Json:
    v = state.get("verify") or {}
    raw = inc.get("verification") or {}
    status = "verified" if v.get("ok") else ("unknown" if v.get("unknown") else "rejected")
    attempt = int(state.get("attempt") or inc.get("attempts") or 0)
    return {"verification_id": str(raw.get("id") or f"ver_{inc.get('id')}_a{attempt}"), "verifier": VERIFIER, "status": status, "run_id": ctx.engine.run_id,
            "incident_id": inc.get("id"), "checks": [c.get("id") for c in raw.get("checks", [])][:8], "contract_hash": (state.get("dod") or {}).get("frozen_hash"),
            "tick": getattr(ctx, "tick", None)}


async def memory_write(ctx: Any, state: Json) -> None:
    """Propose this attempt's lesson + cause fact (with provenance) and settle them with the verifier's outcome in one go. Verified -> promoted;
    rejected -> the lesson is REJECTED (never learned); unknown -> stays PROPOSED."""
    b = brain_for(ctx)
    if b is None:
        return
    try:
        inc, det, plan = state.get("incident") or {}, state.get("det") or {}, state.get("plan") or {}
        if not inc or not det or not plan or plan.get("action") in (None, "escalate") or not state.get("verify"):
            return
        sc = _scope(ctx, det)
        run_id, fac, cause, tgt = sc["run_id"], sc["facility_id"], det.get("cause"), det.get("target_id")
        ev = [e["id"] for e in inc.get("evidence", []) if e.get("id")][:12]
        ver = _verification(state, inc, ctx)
        ev = ev or [ver["verification_id"]]
        pre: Json = {"attempt": int(state.get("attempt") or 0)}
        if plan.get("occ") is not None and cause == "fouling":
            pre["deposit"] = "heavy" if float(plan["occ"]) > 0.68 else "light"
        label = (ctx.fac.label(tgt) if hasattr(ctx.fac, "label") else tgt)

        def work() -> Json:
            prop = [
                b.propose_fact(run_id=run_id, facility_id=fac, subject_key=f"asset:{tgt}:cause", statement=f"{label}: confirmed cause {cause}", value={"cause": cause}, evidence_ids=ev,
                               proposed_by=PROPOSER, incident_id=inc["id"], fault_kind=cause, asset_type=sc["asset_type"], asset_id=tgt, topology_revision=sc["topology_revision"],
                               fact_kind="sensor" if cause == "sensor_drift" else "observation", confidence=0.6),
                b.propose_lesson(run_id=run_id, facility_id=fac, fault_kind=cause, steps=[{"action": plan["action"], "target_role": sc["asset_type"] or "target"}], evidence_ids=ev,
                                 proposed_by=PROPOSER, asset_type=sc["asset_type"], preconditions=pre, incident_id=inc["id"], topology_revision=sc["topology_revision"], confidence=0.6,
                                 expected_outcome="verified recovery" if ver["status"] == "verified" else "did not verify"),
            ]
            res = b.settle(run_id=run_id, incident_id=inc["id"], verification=ver, items=[{"kind": "fact" if "fact_id" in p else "lesson", "id": p.get("fact_id") or p.get("lesson_id"), "revision": p["revision"]} for p in prop])
            b.expire_sweep()
            return res

        await asyncio.to_thread(work)
    except Exception:                                        # noqa: BLE001
        b.stats["errors"] = b.stats.get("errors", 0) + 1
        log.exception("memory_write failed")
