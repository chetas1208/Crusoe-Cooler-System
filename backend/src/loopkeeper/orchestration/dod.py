"""Executable Definition of Done (V11 Gate 1).

SEN-01 (the deep model) only DRAFTS which allowlisted checks matter and for which assets; this deterministic compiler validates the draft
(asset ids exist and belong to the incident scope, check types are allowlisted and applicable, hold times are bounded), takes every threshold and
unit from the facility configuration / the existing verifier checks (never from the model), adds any mandatory check the draft left out, and FREEZES
the result before any repair is dispatched. A frozen contract is only ever changed by a version bump with a reason, and the compiler refuses a bump
that would move the goalposts (drop a check, relax a threshold, shorten a hold).

Layer A (``step``/``verdict_a``) is deterministic: every sample re-evaluates each check from fresh world data; a check only counts as HELD after it has
passed continuously for its ``hold_sim_s``; missing data or a non-converged solver makes a check UNKNOWN, never a pass. Layer B (SEN-05) is a
separate model call in an isolated context that sees the frozen contract, the Layer-A table and a handful of relevant events; it can ask for more
tests or a replan, it cannot turn a Layer-A failure into a pass.

Lifecycle: PROPOSED -> VALIDATED -> FROZEN -> EVALUATING -> VERIFIED | FAILED | ESCALATED. Terminal outcome: VERIFIED | PARTIAL |
CONTAINED_NOT_REPAIRED | ESCALATED | FAILED | TIMED_OUT | UNKNOWN."""
from __future__ import annotations

import math
from typing import Any

from ..engine.util import chash
from .analysis import checks_for, compute_metrics, rnd
from .context import AgentContext
from .world import Json

WINDOW_SCALE = {"pump_degradation": 45.0 / 55.0, "sensor_drift": 35.0 / 55.0}     # stabilisation window per cause (fraction of Limits.verify_window_s)
STATES = ("PROPOSED", "VALIDATED", "FROZEN", "EVALUATING", "VERIFIED", "FAILED", "ESCALATED")
TERMINAL = ("VERIFIED", "PARTIAL", "CONTAINED_NOT_REPAIRED", "ESCALATED", "FAILED", "TIMED_OUT", "UNKNOWN")
MIN_HOLD_S, MAX_HOLD_S = 20.0, 180.0
# allowlisted check types -> the id the existing verifier uses for the same physical check (reuse, not a second verifier)
TYPE_OF_ID = {"flow": "sustained_flow_fraction", "dp": "segment_dp_ratio_max", "margin": "temperature_within_configured_limit",
              "collateral": "collateral_flow_deviation_max", "head": "pump_head_fraction_min", "vib": "bearing_vibration_max",
              "residual": "independent_sensor_agreement", "leak": "no_active_uncontained_leak"}
ID_OF_TYPE = {v: k for k, v in TYPE_OF_ID.items()}
APPLICABLE = {  # which causes a check type can be evaluated for with the data the plant exposes
    "sustained_flow_fraction": ("fouling", "strainer_blockage", "valve_stuck", "pump_degradation"),
    "segment_dp_ratio_max": ("fouling", "strainer_blockage"),
    "temperature_within_configured_limit": ("fouling", "strainer_blockage", "valve_stuck", "pump_degradation", "sensor_drift", "leak", "workload_spike"),
    "collateral_flow_deviation_max": ("fouling", "strainer_blockage", "valve_stuck", "sensor_drift"),
    "pump_head_fraction_min": ("pump_degradation",),
    "bearing_vibration_max": ("pump_degradation",),
    "independent_sensor_agreement": ("sensor_drift",),
    "no_active_uncontained_leak": ("fouling", "strainer_blockage", "valve_stuck", "pump_degradation", "sensor_drift", "leak"),
}
UNITS = {"flow": "kg/s", "dp": "x", "margin": "K", "collateral": "%", "head": "%", "vib": "mm/s", "residual": "kg/s", "leak": "zones"}


class ContractError(ValueError):
    def __init__(self, reasons: list[str]) -> None:
        super().__init__("; ".join(reasons))
        self.reasons = reasons


# ── helpers ──────────────────────────────────────────────────────────────────────────────────
def scope_assets(ctx: AgentContext, det: Json) -> set[str]:
    fac = ctx.fac
    out = {det["target_id"], det.get("anchor_id") or det["target_id"], *det.get("affected", [])}
    out |= set(fac.scope_racks(det["cause"], det["target_id"]))
    e = fac.edge_of(det["target_id"])
    if e:
        out.add(e)
        z = fac.edge_zone(e)
        if z:
            out |= set(fac.zone_all_racks(z)) | {fac.zone_valve(z) or ""}
    out |= {a for a in fac.assets if a.startswith(("valve_", "strainer", "pump_", "sn_")) and det["cause"] in ("pump_degradation", "strainer_blockage", "fouling")}
    out.discard("")
    return out


def _leak_status(world: Json) -> tuple[bool, int]:
    zones = [z for z in (world.get("hazard_zones") or []) if str(z.get("kind")) == "leak"]
    active = [z for z in zones if str(z.get("status")) == "active"]
    return (len(active) == 0), len(active)


def freeze_hash(c: Json) -> str:
    core = {"version": c["version"], "goal": c["goal"], "scope": c["scope"], "window_s": c["window_s"],
            "checks": [{k: ch[k] for k in ("id", "type", "unit", "direction", "threshold", "hold_sim_s", "subject")} for ch in c["checks"]]}
    return chash(core)[:24]


def _mk_check(base: Json, hold: float, source: str, subject: list[str]) -> Json:
    cid = base["id"]
    return {"id": cid, "type": TYPE_OF_ID[cid], "label": base["label"], "unit": base["unit"], "direction": base["direction"],
            "threshold": base["target"], "hold_sim_s": hold, "subject": subject, "source": source}


def _leak_check(hold: float, source: str, subject: list[str]) -> Json:
    return {"id": "leak", "type": "no_active_uncontained_leak", "label": "No active uncontained leak", "unit": "zones", "direction": "max", "threshold": 0.0,
            "hold_sim_s": hold, "subject": subject, "source": source}


# ── compile (PROPOSED -> VALIDATED) and freeze ───────────────────────────────────────────────
def mandatory_checks(ctx: AgentContext, det: Json, before: Json, after0: Json) -> list[Json]:
    """The checks every contract must contain. The thermal-margin check is ALWAYS there: while a fault is active the hydraulics are not recovered and the
    legacy verifier would exclude it, which would leave the contract blind to the hazard it exists to contain."""
    return checks_for(ctx, det, before, {**after0, "margin_excl": 0})


def draft_fallback(ctx: AgentContext, det: Json) -> Json:
    """The deterministic draft used when no model answered: goal from the fault, the cause's standard checks, default hold."""
    fac = ctx.fac
    label = " ".join(str(fac.label(det["target_id"])).split())[:60]                  # asset names are untrusted text: bounded before they enter the (240-char) goal
    return {"goal": f"{label} is genuinely recovered: measured hydraulics and thermal margin hold at their configured limits for a sustained window, without collateral damage."[:240],
            "subject_asset_ids": [det["target_id"]], "hold_sim_seconds": 0, "checks": [], "reason": ""}


def compile_contract(ctx: AgentContext, det: Json, inc_id: str, draft: Json, before: Json, after0: Json, *, window_s: float, source: dict, version: int = 1) -> Json:
    """Draft (model or fallback) -> VALIDATED contract, or ContractError naming every violated rule."""
    fac, cause = ctx.fac, det["cause"]
    errs: list[str] = []
    scope = scope_assets(ctx, det)
    subj = [str(a) for a in (draft.get("subject_asset_ids") or [])]
    for a in subj:
        if not fac.exists(a):
            errs.append(f"unknown asset id '{a}'")
        elif a not in scope:
            errs.append(f"asset '{a}' is outside the incident scope")
    if subj and not any(a in scope for a in subj if fac.exists(a)) and not errs:
        errs.append("none of the subject assets belongs to this incident's scope")
    hold = float(draft.get("hold_sim_seconds") or 0)
    max_hold = min(MAX_HOLD_S, window_s)
    default_hold = min(max(MIN_HOLD_S, round(window_s * 0.5)), max_hold)         # the floor: a draft may only lengthen the sustained-hold window
    if hold and not (default_hold <= hold <= max_hold):
        errs.append(f"hold {hold:g}s outside the allowed {default_hold:g}-{max_hold:g}s")
    hold = hold or default_hold
    mandatory = mandatory_checks(ctx, det, before, after0)
    by_id = {c["id"]: c for c in mandatory}
    checks: list[Json] = []
    seen: set[str] = set()
    default_subject = subj or [det["target_id"]]
    for c in mandatory:
        checks.append(_mk_check(c, hold, "mandatory", default_subject))
        seen.add(c["id"])
    for dc in draft.get("checks") or []:
        t = dc["type"] if isinstance(dc, dict) else dc.type
        sub = (dc.get("subject_asset_id") if isinstance(dc, dict) else dc.subject_asset_id) or ""
        if t not in TYPE_OF_ID.values():
            errs.append(f"check type '{t}' is not allowlisted")
            continue
        if cause not in APPLICABLE[t]:
            errs.append(f"check '{t}' cannot be evaluated for a {cause} incident with the data the plant exposes")
            continue
        if sub and not fac.exists(sub):
            errs.append(f"unknown asset id '{sub}' on check '{t}'")
            continue
        cid = ID_OF_TYPE[t]
        if cid in seen:
            continue
        if cid == "leak":
            checks.append(_leak_check(hold, "model", [sub] if sub else default_subject))
            seen.add(cid)
        elif cid in by_id:
            checks.append(_mk_check(by_id[cid], hold, "model", [sub] if sub else default_subject))
            seen.add(cid)
        else:
            errs.append(f"check '{t}' is not computable for this incident right now")
    if errs:
        raise ContractError(errs)
    return {
        "id": f"dod_{inc_id}", "incident_id": inc_id, "version": version, "state": "VALIDATED", "terminal_state": None,
        "goal": str(draft.get("goal") or "")[:240], "scope": {"cause": cause, "target_id": det["target_id"], "racks": fac.scope_racks(cause, det["target_id"]),
                                                              "assets": sorted(scope)[:24], "subjects": sorted(default_subject)},
        "drafted_by": source, "checks": checks, "window_s": window_s, "created_tick": ctx.tick, "validated_tick": ctx.tick, "frozen_tick": None,
        "frozen_hash": None, "revisions": [], "evaluation": None, "history": [],
    }


def freeze(ctx: AgentContext, c: Json) -> Json:
    c["state"] = "FROZEN"
    c["frozen_tick"] = ctx.tick
    c["frozen_hash"] = freeze_hash(c)
    return c


def not_looser(old: Json, new: Json) -> list[str]:
    """Goalpost guard: a revision may add checks and tighten thresholds / lengthen holds; anything else is refused."""
    errs = []
    if new.get("goal") != old.get("goal"):
        errs.append("the goal text cannot be rewritten by a revision")
    os_, ns_ = old.get("scope") or {}, new.get("scope") or {}
    if (os_.get("cause"), os_.get("target_id")) != (ns_.get("cause"), ns_.get("target_id")):
        errs.append("the incident scope (cause / target) cannot change in a revision")
    if os_.get("subjects") and not set(os_["subjects"]) <= set(ns_.get("subjects") or []):
        errs.append("a revision cannot drop a subject asset")
    nb = {c["id"]: c for c in new["checks"]}
    for c in old["checks"]:
        n = nb.get(c["id"])
        if n is None:
            errs.append(f"check '{c['id']}' was removed")
            continue
        if n["direction"] != c["direction"]:
            errs.append(f"check '{c['id']}' changed direction")
        looser = n["threshold"] < c["threshold"] if c["direction"] == "min" else n["threshold"] > c["threshold"]
        if looser:
            errs.append(f"check '{c['id']}' threshold relaxed {c['threshold']} -> {n['threshold']}")
        if n["hold_sim_s"] < c["hold_sim_s"]:
            errs.append(f"check '{c['id']}' hold shortened {c['hold_sim_s']}s -> {n['hold_sim_s']}s")
        if not set(c.get("subject") or []) <= set(n.get("subject") or []):
            errs.append(f"check '{c['id']}' subject narrowed")
    if new["window_s"] < old["window_s"]:
        errs.append("evaluation window shortened")
    return errs


def revise(ctx: AgentContext, old: Json, proposed: Json, reason: str) -> Json:
    """Version bump with a reason; raises ContractError when the new version would loosen the frozen one."""
    if not reason.strip():
        raise ContractError(["a revision needs a reason"])
    errs = not_looser(old, proposed)
    if errs:
        raise ContractError(errs)
    new = {**proposed, "version": old["version"] + 1, "revisions": [*old["revisions"], {"version": old["version"] + 1, "reason": reason[:300], "tick": ctx.tick,
                                                                                      "from_hash": old["frozen_hash"]}],
           "history": old["history"], "drafted_by": old["drafted_by"], "created_tick": old["created_tick"], "id": old["id"],
           "before": old.get("before"), "goal": old.get("goal")}
    new["state"] = "VALIDATED"
    return freeze(ctx, new)


# ── Layer A: deterministic evaluator with hold timers ────────────────────────────────────────
def begin(ctx: AgentContext, c: Json, attempt: int) -> None:
    c["state"] = "EVALUATING"
    c["evaluation"] = {"attempt": attempt, "started_s": rnd(ctx.now, 1), "started_tick": ctx.tick, "updated_tick": ctx.tick, "samples": 0, "layer_a": "PENDING",
                       "layer_b": None, "checks": {ch["id"]: {"status": "pending", "measured": None, "target": ch["threshold"], "held_s": 0.0, "best_held_s": 0.0,
                                                              "streak_since_s": None, "last_pass": None} for ch in c["checks"]}}


def _solver_ok(world: Json) -> bool:
    s = ((world.get("health") or {}).get("solver") or {}).get("status")
    return s in (None, "converged")


def step(ctx: AgentContext, c: Json, det: Json, before: Json, cf: Json, clean: list[str] | None) -> Json:
    """One fresh sample of every check. Returns the evaluation block (mutated in place)."""
    ev = c["evaluation"]
    now = ctx.now
    unknown_all = not _solver_ok(ctx.world)
    results: dict[str, tuple[bool | None, float | None]] = {}
    if not unknown_all:
        try:
            after = compute_metrics(ctx, det, c["incident_id"], cf, clean)
            for k in after:
                v = after[k]
                if isinstance(v, float) and not math.isfinite(v):
                    raise ValueError(k)
            for ch in checks_for(ctx, det, before, after):
                results[ch["id"]] = (bool(ch["pass"]), float(ch["after"]))
            if "margin" not in results and any(k["id"] == "margin" for k in c["checks"]):
                mg = float(after["margin_all"])                               # hydraulics not recovered: still judge the racks' real thermal margin (containment)
                results["margin"] = (mg >= ctx.fac.warn_k, mg)
        except Exception:                                                    # noqa: BLE001  missing/NaN data is UNKNOWN, never a pass
            results = {}
    ok, n_active = _leak_status(ctx.world)
    if not unknown_all:
        results["leak"] = (ok, float(n_active))
    for ch in c["checks"]:
        st = ev["checks"][ch["id"]]
        res = results.get(ch["id"])
        if res is None:
            st.update(status="unknown", measured=None, streak_since_s=None, held_s=0.0)
            continue
        passed, measured = res
        st["measured"] = rnd(measured, 3)
        if passed:
            if st["streak_since_s"] is None:
                st["streak_since_s"] = rnd(now, 1)
            st["held_s"] = rnd(now - st["streak_since_s"], 1)
            st["best_held_s"] = max(st["best_held_s"], st["held_s"])
            st["status"] = "held" if st["held_s"] >= ch["hold_sim_s"] else "passing"
            st["last_pass"] = True
        else:
            st.update(status="failing", streak_since_s=None, held_s=0.0, last_pass=False)
    ev["samples"] += 1
    ev["updated_tick"] = ctx.tick
    return ev


def verdict_a(c: Json) -> str:
    """PASS only when every check is HELD now; UNKNOWN when any check lacks data; otherwise FAIL (still pending counts as FAIL at the window end)."""
    cs = c["evaluation"]["checks"]
    if any(s["status"] == "unknown" for s in cs.values()):
        return "UNKNOWN"
    if all(s["status"] == "held" for s in cs.values()):
        return "PASS"
    return "FAIL"


def eval_table(c: Json) -> list[Json]:
    """Per-check table in the shape of the existing verification checks (so the UI, the diagnose tool and replan keep working)."""
    out = []
    ev = (c.get("evaluation") or {}).get("checks", {})
    for ch in c["checks"]:
        s = ev.get(ch["id"]) or {}
        out.append({"id": ch["id"], "type": ch["type"], "label": ch["label"], "unit": ch["unit"], "direction": ch["direction"], "target": ch["threshold"],
                    "before": 0.0, "after": s.get("measured") if isinstance(s.get("measured"), (int, float)) else 0.0, "hold_sim_s": ch["hold_sim_s"], "held_s": s.get("held_s", 0.0), "status": s.get("status", "pending"),
                    "pass": s.get("status") == "held"})
    return out


def independently_reviewed(c: Json) -> bool:
    """VERIFIED needs an independent concurrence from a real model review (SEN-05). The deterministic fallback is NOT a review."""
    lb = (c.get("evaluation") or {}).get("layer_b") or {}
    return lb.get("verdict") == "concur" and lb.get("source") == "model"


def terminal_of(c: Json, *, escalated: bool, timed_out: bool = False, human_required: bool = False) -> str:
    """Honest end state after the last attempt. VERIFIED only through Layer A PASS + an independent model concurrence; a partial, contained-only or
    unreviewed outcome is never called verified. Precedence: TIMED_OUT > ESCALATED (a person must decide) > UNKNOWN > CONTAINED_NOT_REPAIRED > PARTIAL > FAILED."""
    ev = c.get("evaluation") or {}
    cs = ev.get("checks", {})
    # defence in depth: the Layer-A verdict is RECOMPUTED from the per-check statuses; a `layer_a` flag handed in from outside is never trusted
    la = "UNKNOWN" if any(x["status"] == "unknown" for x in cs.values()) else ("PASS" if cs and all(x["status"] == "held" for x in cs.values()) else "FAIL")
    flag = ev.get("layer_a")                                     # the stored flag may only VETO (a flag that disagrees with the statuses is never a pass)
    ev = {**ev, "layer_a": la if flag in (None, la) or la != "PASS" else "FAIL"}
    la = ev["layer_a"]
    if flag == "PASS" and la == "PASS" and independently_reviewed(c) and not escalated:
        return "VERIFIED"
    if timed_out:
        return "TIMED_OUT"
    if human_required:
        return "ESCALATED"
    if ev.get("layer_a") == "UNKNOWN" or any(s["status"] == "unknown" for s in cs.values()):
        return "UNKNOWN"
    held = {k for k, s in cs.items() if s["status"] == "held"}
    if "margin" in held and held != set(cs) and not ({"flow", "dp", "head", "vib", "residual"} & held):
        return "CONTAINED_NOT_REPAIRED"                      # the hazard (thermal margin) is safe, the cause is not repaired
    if ev.get("layer_a") == "PASS" and held == set(cs) and cs:
        return "PARTIAL"                                     # every measured check held, but nobody independent confirmed it: needs a review
    if held and held != set(cs):
        return "PARTIAL"
    return "ESCALATED" if escalated else "FAILED"


# ── plain wording (what the operator reads; no codes, no field names) ───────────────────────────
STATE_TITLE = {"VERIFIED": "Verified", "PARTIAL": "Partly recovered", "CONTAINED_NOT_REPAIRED": "Contained, not repaired", "ESCALATED": "Needs a person",
               "FAILED": "Not recovered", "TIMED_OUT": "Timed out", "UNKNOWN": "Could not confirm"}


def assessment(c: Json) -> Json:
    """What the last measurements say: which checks held (safe), which did not (unrepaired), which had no trustworthy reading."""
    cs = (c.get("evaluation") or {}).get("checks", {})
    label = {k["id"]: k["label"] for k in c.get("checks", [])}
    tab = eval_table(c)
    return {"safe": [label.get(k, k) for k, x in cs.items() if x["status"] == "held"],
            "unrepaired": [label.get(k, k) for k, x in cs.items() if x["status"] in ("failing", "passing", "pending")],
            "unknown": [label.get(k, k) for k, x in cs.items() if x["status"] == "unknown"],
            "evidence": [{"check": t["id"], "label": t["label"], "status": t["status"], "measured": t["after"], "target": t["target"], "unit": t["unit"],
                          "held_s": t["held_s"], "hold_needed_s": t["hold_sim_s"]} for t in tab]}


def _join(xs: list[str]) -> str:
    xs = [x[:1].lower() + x[1:] for x in xs]
    return xs[0] if len(xs) == 1 else ", ".join(xs[:-1]) + " and " + xs[-1]


def outcome_text(c: Json, state: str, reason: str = "") -> str:
    """One plain paragraph for the operator for a terminal state."""
    a = assessment(c)
    safe, bad, unk = a["safe"], a["unrepaired"], a["unknown"]
    tail = " An operator should review the incident; monitoring continues."
    if state == "VERIFIED":
        return "Verified: every measured check held for the full window and an independent review agreed."
    if state == "CONTAINED_NOT_REPAIRED":
        return (f"Contained, not repaired: {_join(safe)} stayed within limits, so the racks are safe for now, but the fault itself is still there"
                + (f" ({_join(bad)} not back to normal)" if bad else "") + "." + tail)
    if state == "PARTIAL":
        if not bad and safe:
            return "Partly confirmed: every measured check held, but no independent review was available, so this is not counted as verified." + tail
        return (f"Partly recovered: {_join(safe)} held" + (f", but {_join(bad)} did not" if bad else "") + "." + tail)
    if state == "TIMED_OUT":
        return "Timed out: " + (reason.rstrip(".") + "." if reason else "the incident did not finish within the allowed time.") + tail
    if state == "UNKNOWN":
        return "Could not confirm: the plant simulation did not give a trustworthy reading" + (f" for {_join(unk)}" if unk else "") + ", so recovery is neither confirmed nor ruled out." + tail
    if state == "ESCALATED":
        return "Needs a person: " + (reason.rstrip(".") + "." if reason else "the automatic options are exhausted.") + tail
    return "Not recovered: " + (reason.rstrip(".") + "." if reason else "the checks did not pass.") + tail


def public(c: Json | None) -> Json | None:
    return None if c is None else {k: v for k, v in c.items()}
