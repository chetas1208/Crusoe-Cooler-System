"""Graph-side steps of the Definition of Done: SEN-01 drafts + the compiler freezes (before any repair), SEN-01 revises after a rejected repair
(never looser), the loop / drift guard, and SEN-05's isolated Layer-B review. All thresholds come from ``dod.compile_contract``; the models only choose
among allowlisted checks."""
from __future__ import annotations

import copy
from typing import Any

from ...engine.util import chash
from .. import dod
from ..analysis import compute_metrics, healthy_reference, other_affected, rnd
from ..context import AgentContext
from ..world import Json
from .common import S

MAX_PLAN_REVISIONS = 2


def window_for(ctx: AgentContext, det: Json) -> float:
    return float(ctx.limits.verify_window_s * dod.WINDOW_SCALE.get(det["cause"], 1.0))


def emit(ctx: AgentContext, c: Json) -> None:
    ctx.emit("dod.contract", c["incident_id"], {"contract": copy.deepcopy(c)})


def _facts(ctx: AgentContext, det: Json, before: Json, after0: Json, window: float, extra: Json | None = None) -> Json:
    mand = dod.mandatory_checks(ctx, det, before, after0)
    return {"incident": {"cause": det["cause"], "target": det["target_id"], "title": det.get("title", ""), "summary": det.get("summary", "")},
            "valid_asset_ids": sorted(dod.scope_assets(ctx, det))[:40],
            "mandatory_checks": [{"id": c["id"], "type": dod.TYPE_OF_ID[c["id"]], "label": c["label"], "unit": c["unit"], "direction": c["direction"],
                                  "threshold": c["target"]} for c in mand],
            "allowed_check_types": [t for t, causes in dod.APPLICABLE.items() if det["cause"] in causes],
            "hold_sim_seconds_bounds": [dod.MIN_HOLD_S, min(dod.MAX_HOLD_S, window)], "window_s": window, **(extra or {})}


def _source(t: Json) -> Json:
    m = t.get("model") or {}
    fb = bool(m.get("fallback", True))
    return {"role": "SEN-01", "source": "fallback" if fb else "model", "provider": m.get("provider"), "model_id": m.get("model_id"),
            "latency_ms": m.get("latency_ms"), "reason": m.get("fallback_reason")}


async def ensure_contract(ctx: AgentContext, s: Any, state: Json, det: Json, root: Json) -> Json | None:
    """SEN-01 drafts -> compiler validates -> FROZEN, strictly before the first repair is chosen. Returns the contract (also stored in the graph state)."""
    c = state.get("dod")
    if c or det["cause"] == "workload_spike":
        return c
    inc = s.id
    before = state.get("baseline") or {}
    window = window_for(ctx, det)
    racks = ctx.fac.scope_racks(det["cause"], det["target_id"])
    after0 = compute_metrics(ctx, det, inc, healthy_reference(ctx, racks, other_affected(ctx, inc)), before.get("_clean"))
    t = s.task("sentinel", "dod", "Define 'done'", "What must be measurably true, and for how long, before this incident counts as repaired?", parent=root,
               asset_ids=[det["target_id"]])
    fb = dod.draft_fallback(ctx, det)
    facts = _facts(ctx, det, before, after0, window)

    def validate(d: Any) -> list[str]:
        try:
            dod.compile_contract(ctx, det, inc, d.model_dump(), before, after0, window_s=window, source={})
            return []
        except dod.ContractError as e:
            return e.reasons

    dec = await s.decide(t, "dod_draft", facts, lambda: fb, validate,
                         instruction="You are SEN-01. Draft the Definition of Done: a goal sentence, the asset ids it concerns (only from valid_asset_ids), a hold time in "
                                     "simulated seconds, and extra allowlisted checks if useful. Never state thresholds or units: the compiler sets them from the configuration.",
                         max_tokens=500)
    src = _source(t)
    ctx.emit("dod.contract", inc, {"contract": {"id": f"dod_{inc}", "incident_id": inc, "version": 1, "state": "PROPOSED", "draft": dec, "drafted_by": src,
                                                "checks": [], "terminal_state": None, "frozen_hash": None, "frozen_tick": None, "revisions": [], "history": []}})
    try:
        c = dod.compile_contract(ctx, det, inc, dec, before, after0, window_s=window, source=src)
    except dod.ContractError:
        src = {**src, "source": "fallback", "reason": "the compiler refused the model draft"}
        c = dod.compile_contract(ctx, det, inc, fb, before, after0, window_s=window, source=src)
    c["before"] = {k: v for k, v in before.items() if not k.startswith("_") and isinstance(v, (int, float))}
    emit(ctx, c)
    dod.freeze(ctx, c)
    emit(ctx, c)
    s.ev("verification", f"Definition of Done frozen (v{c['version']}, {len(c['checks'])} checks, hold {c['checks'][0]['hold_sim_s']:g}s): "
                     + "; ".join(f"{k['label']} {'>=' if k['direction'] == 'min' else '<='} {k['threshold']} {k['unit']}" for k in c["checks"][:4]),
         asset_id=det["target_id"])
    s.finish(t, "completed", f"Contract frozen before any repair: {c['goal']}", ("Contract frozen", True))
    return c


async def revise_for_replan(ctx: AgentContext, s: Any, state: Json, det: Json, c: Json, failing: list[str], root: Json) -> Json:
    """After a rejected repair SEN-01 may tighten the contract (never loosen it). Refused / unchanged -> the frozen version stays."""
    before = c.get("before") or {}
    window = c["window_s"]
    racks = ctx.fac.scope_racks(det["cause"], det["target_id"])
    after0 = compute_metrics(ctx, det, s.id, healthy_reference(ctx, racks, other_affected(ctx, s.id)), before.get("_clean"))
    t = s.task("sentinel", "dod_revise", "Revisit 'done'", "Does the failed attempt show the contract missed something that must also hold?", parent=root,
               asset_ids=[det["target_id"]])
    facts = _facts(ctx, det, before, after0, window, {"frozen": {"version": c["version"], "checks": [{k: x[k] for k in ("id", "type", "threshold", "hold_sim_s")} for x in c["checks"]]},
                                                      "failed_checks": failing, "rule": "a revision may only ADD checks or lengthen holds; it can never remove or relax"})
    keep = {"goal": c["goal"], "subject_asset_ids": [], "hold_sim_seconds": 0, "checks": [], "reason": ""}

    def validate(d: Any) -> list[str]:
        try:
            p = dod.compile_contract(ctx, det, s.id, d.model_dump(), before, after0, window_s=window, source={})
            return dod.not_looser(c, p)
        except dod.ContractError as e:
            return e.reasons

    dec = await s.decide(t, "dod_revise", facts, lambda: keep, validate, instruction="You are SEN-01. Propose extra allowlisted checks or a longer hold only if the failure shows a gap; otherwise return an empty checks list.",
                         max_tokens=400)
    new = None
    try:
        draft = {**dec, "goal": c["goal"], "subject_asset_ids": list((c.get("scope") or {}).get("subjects") or []),     # the goal and subjects are pinned: a revision only adds checks / lengthens holds
                 "hold_sim_seconds": max(int(dec.get("hold_sim_seconds") or 0), int(c["checks"][0]["hold_sim_s"]))}
        prop = dod.compile_contract(ctx, det, s.id, draft, before, after0, window_s=window, source=c["drafted_by"])
        prop["before"] = c.get("before")
        extra = [k for k in prop["checks"] if k["id"] not in {x["id"] for x in c["checks"]}]
        longer = any(prop_k["hold_sim_s"] > x["hold_sim_s"] for prop_k in prop["checks"] for x in c["checks"] if x["id"] == prop_k["id"])
        if extra or longer:
            new = dod.revise(ctx, c, prop, (dec.get("reason") or f"verification attempt {s.inc['attempts']} failed on {', '.join(failing) or 'the checks'}")[:280])
    except dod.ContractError as e:
        c.setdefault("refused_revisions", []).append({"tick": ctx.tick, "reasons": e.reasons[:4]})
        c["refused_revisions"] = c["refused_revisions"][-5:]
        emit(ctx, c)
    if new is not None:
        new["before"] = c.get("before")
        new["evaluation"] = c.get("evaluation")
        c = new
        emit(ctx, c)
    s.finish(t, "completed", (f"Contract revised to v{c['version']}: {c['revisions'][-1]['reason']}" if c["version"] > 1 and c["revisions"] and c["revisions"][-1]["tick"] == ctx.tick
                              else f"Contract v{c['version']} stands; goalposts unchanged."), ("Revised" if new is not None else "Unchanged", True))
    return c


def plan_hash(plan: Json) -> str:
    return chash({"action": plan.get("action"), "target": plan.get("target_id")})[:12]


def guard_progress(ctx: AgentContext, s: Any, c: Json | None, plan: Json) -> str | None:
    """Loop / drift detection before a replanned action is dispatched. Returns an escalation reason or None; emits loop.detected / drift.detected events."""
    if c is None:
        return None
    h = plan_hash(plan)
    hist = c.get("history") or []
    reason = None
    if hist and hist[-1].get("plan_hash") == h and hist[-1].get("layer_a") != "PASS":
        ctx.emit("loop.detected", s.id, {"incident_id": s.id, "kind": "repeat_plan_hash", "plan_hash": h, "action": plan.get("action"), "attempt": len(hist)})
        reason = f"The same plan ({plan.get('action')} on {plan.get('target_id')}) was chosen again after it failed verification: stopping instead of repeating it."
    elif len(hist) >= 2 and all(abs((x.get("primary_delta") or 0.0)) < 0.01 for x in hist[-2:]):
        ctx.emit("drift.detected", s.id, {"incident_id": s.id, "kind": "no_physical_progress", "attempts": len(hist), "primary_deltas": [x.get("primary_delta") for x in hist[-2:]]})
        reason = "Two repair attempts produced no measurable physical improvement: escalating instead of trying again."
    elif ctx.decisions.budget(s.id).exhausted:
        ctx.emit("drift.detected", s.id, {"incident_id": s.id, "kind": "budget_exhausted", "tokens_used": ctx.decisions.budget(s.id).used})
        reason = "The model budget for this incident is exhausted: escalating."
    elif len(hist) > MAX_PLAN_REVISIONS:
        ctx.emit("loop.detected", s.id, {"incident_id": s.id, "kind": "revision_cap", "attempts": len(hist)})
        reason = f"More than {MAX_PLAN_REVISIONS} plan revisions were needed: escalating."
    return reason


def review_payload(ctx: AgentContext, c: Json, det: Json, s: Any) -> Json:
    """Everything SEN-05 may see: the FROZEN contract, the Layer-A table and a few relevant facts. No chat history, no SEN-01 reasoning."""
    inc = s.inc
    return {"contract": {"version": c["version"], "hash": c["frozen_hash"], "goal": c["goal"],
                         "checks": [{k: x[k] for k in ("id", "type", "label", "unit", "direction", "threshold", "hold_sim_s")} for x in c["checks"]]},
            "layer_a": {"verdict": c["evaluation"]["layer_a"], "table": [{k: r[k] for k in ("id", "status", "after", "target", "held_s", "hold_sim_s")} for r in dod.eval_table(c)]},
            "attempt": c["evaluation"]["attempt"], "history": [{k: h.get(k) for k in ("attempt", "layer_a", "failed", "plan_hash")} for h in (c.get("history") or [])][-3:],
            "events": [{"kind": e.get("kind"), "summary": str(e.get("summary"))[:160]} for e in inc.get("evidence", [])[-6:]],
            "missions": [{"kind": m.get("kind"), "outcome": m.get("outcome"), "status": m.get("status")} for m in (ctx.world.get("missions") or {}).values()
                         if m.get("incident_id") == inc.get("id")][-4:]}


async def layer_b(ctx: AgentContext, s: Any, c: Json, det: Json, t: Json) -> Json:
    """SEN-05 (isolated context). Returns {verdict, reasons, source}; it can request more tests / a replan but its output is never read as a pass by itself."""
    a = c["evaluation"]["layer_a"]
    payload = review_payload(ctx, c, det, s)

    def fb() -> Json:
        return {"verdict": "concur" if a == "PASS" else "request_replan", "reasons": ["Layer A is the only evidence available; no independent model review was possible."],
                "extra_checks": [], "extra_hold_sim_seconds": 0}

    def validate(d: Any) -> list[str]:
        errs = []
        for k in d.extra_checks:
            if det["cause"] not in dod.APPLICABLE[k.type]:
                errs.append(f"check {k.type} is not applicable to a {det['cause']} incident")
        if d.verdict == "concur" and a != "PASS":
            errs.append("Layer A did not pass; a concurrence cannot be accepted")
        return errs

    dec = await s.decide(t, "dod_review", payload, fb, validate, suffix=f":a{c['evaluation']['attempt']}:{a}",
                         instruction="You are SEN-05, an independent reviewer. You see only the frozen contract and measured results. Decide: concur (only if Layer A PASS), "
                                     "request_more_tests (list extra allowlisted checks / a longer hold) or request_replan (explain). You cannot pass a failed contract.",
                         max_tokens=400)
    m = t.get("model") or {}
    source = "fallback" if m.get("fallback", True) else "model"
    verdict = dec["verdict"]
    if source != "model" and verdict == "concur":
        verdict = "unreviewed"                    # the deterministic fallback is not an independent review: it can never count as a concurrence
        dec = {**dec, "reasons": ["Layer A passed, but no independent model review was available - not counted as a concurrence."]}
    return {"verdict": verdict, "reasons": dec.get("reasons", []), "extra_checks": dec.get("extra_checks", []),
            "extra_hold_sim_seconds": dec.get("extra_hold_sim_seconds", 0), "source": source,
            "model_id": m.get("model_id"), "provider": m.get("provider")}


async def finish_escalated(ctx: AgentContext, s: Any, state: Json, dc: Json, det: Json, reason: str, *, human_required: bool = False, timed_out: bool = False) -> str:
    """The honest end of an escalated incident. Takes ONE final, real reading of every frozen check (Layer A, hold timers and all) so the terminal state is
    derived from measurements taken now - never from an earlier attempt's numbers - then sets VERIFIED-never terminal state, plain wording and the evidence
    (what is safe, what is still unrepaired). Also records the final reading as a verification so /verifications and Communications show it."""
    from ..analysis import twin_counterfactual
    from .common import sentinel_root
    attempt = int(s.inc["attempts"]) + 1
    racks = ctx.fac.scope_racks(det["cause"], det["target_id"])
    t = s.task("sentinel", "assess", "Final reading before handing over", "What is actually safe right now, and what is still not repaired?",
               parent=sentinel_root(state), asset_ids=[det["target_id"]])
    before = state.get("baseline") or {}
    need = max([float(k["hold_sim_s"]) for k in dc["checks"]] or [0.0])
    v: Json = {"id": f"ver_{s.id}_{attempt}", "incident_id": s.id, "attempt": attempt, "status": "pending", "window_s": need + 8.0, "elapsed_s": 0.0, "progress": 0.0,
               "checks": [], "confidence": 0.0, "started_tick": ctx.tick}
    s.inc["verification"] = v
    ctx.emit("verification.result", s.id, {"verification": v})

    async def reading() -> Json:
        dod.begin(ctx, dc, attempt)
        cf = await twin_counterfactual(ctx, det, f"{s.id}:{t['id']}:cfF", s.id, t["id"])
        if cf is None:
            cf = healthy_reference(ctx, racks, other_affected(ctx, s.id))
        t0 = ctx.now
        while True:
            dod.step(ctx, dc, det, before, cf, before.get("_clean"))
            cs = dc["evaluation"]["checks"]
            v["elapsed_s"] = rnd(min(ctx.now - t0, v["window_s"]), 1)
            v["progress"] = rnd(min(v["elapsed_s"] / max(v["window_s"], 1.0), 1.0), 3)
            ctx.emit("verification.result", s.id, {"verification": v})
            if any(x["status"] == "unknown" for x in cs.values()):        # no trustworthy reading: waiting cannot fix it
                break
            if not any(x["status"] == "passing" for x in cs.values()) or ctx.now - t0 >= v["window_s"]:
                break
            await ctx.sleep_sim(4.0)
        dc["evaluation"]["layer_a"] = dod.verdict_a(dc)
        return {"layer_a": dc["evaluation"]["layer_a"], "checks": {k: x["status"] for k, x in cs.items()}}

    await s.tool(t, "final_reading", {"window_s": v["window_s"], "checks": [k["id"] for k in dc["checks"]]}, reading)
    terminal = dod.terminal_of(dc, escalated=True, timed_out=timed_out, human_required=human_required)
    text = dod.outcome_text(dc, terminal, reason)
    dc.update(terminal_state=terminal, state="ESCALATED", escalation_reason=reason[:300], outcome_text=text, assessment=dod.assessment(dc))
    checks = dod.eval_table(dc)
    for c_ in checks:
        c_["before"] = float((dc.get("before") or {}).get(c_["id"], 0.0) or 0.0) if isinstance((dc.get("before") or {}).get(c_["id"], 0.0), (int, float)) else 0.0
        if not isinstance(c_.get("after"), (int, float)):
            c_["after"] = 0.0
    ev_ = dc["evaluation"]
    v.update(checks=checks, status="rejected", progress=1.0, confidence=0.3, completed_tick=ctx.tick, failed_reason=text,
             dod={"contract_id": dc["id"], "version": dc["version"], "frozen_hash": dc["frozen_hash"], "layer_a": ev_["layer_a"], "independently_reviewed": False,
                  "terminal_state": terminal, "layer_b": {"verdict": None, "source": None, "model_id": None, "reasons": []}})
    s.inc["verification"] = v
    ctx.emit("verification.result", s.id, {"verification": v})
    dc["history"] = [*dc["history"], {"attempt": attempt, "layer_a": ev_["layer_a"], "layer_b": None, "failed": [c_["id"] for c_ in checks if not c_["pass"]],
                                      "plan_hash": "", "primary": None, "primary_delta": None, "version": dc["version"], "tick": ctx.tick, "final_reading": True}]
    eid = s.ev("verification", f"Final reading: {text}", asset_id=det["target_id"])
    s.finish(t, "blocked", text, (dod.STATE_TITLE.get(terminal, terminal), terminal in ("CONTAINED_NOT_REPAIRED", "PARTIAL")), [eid])
    emit(ctx, dc)
    return terminal
