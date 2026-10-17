"""Evaluation arms. Equal budgets: same observation, same decision time, same <= 4 actions through the same policy and service latency,
same sim horizon; LLM arms additionally share the gateway's call/spend ceilings.
  static        deterministic playbook keyed on alarm signatures (no model, no scenario id), claims success after a fixed dwell
  single_pass   ONE reasoner call (diagnosis + <= 4 actions + outcome claim), no replan, no independent verification
  recursive     DOD contract + delegation + independent verifier (Agent A's runtime): NOT built here, reported as unavailable until integrated"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, Field

from ..inference import GatewayError, ModelGateway
from .sim import MAX_ACTIONS, PUMPS, VOCAB, Run

Json = dict[str, Any]
STATIC_RULES = "static_playbook.v1"

SYSTEM = (
    "You are the on-call controller of a SIMULATED liquid-cooled data-center cooling plant (TCS = technology cooling loop to the racks, FWS = facility water). "
    "You receive ONE operator-console snapshot taken after an alarm and must decide the response now; you will not see later data. "
    "Use ONLY the facts given. Choose at most 4 actions from this vocabulary (anything else is rejected by a deterministic safety policy): " + VOCAB +
    " Prefer the least invasive action that addresses the cause shown by the facts; do not touch healthy equipment; if the evidence is insufficient or the action would be high-impact, escalate instead. "
    'Reply with ONE JSON object: {"diagnosis": "<one sentence>", "actions": [{"kind": "...", "target_id": "...", "args": {}}], "outcome": "resolved"|"contained"|"escalate"}. '
    "outcome says what you expect after the actions land: resolved = plant back in a safe state, contained = damage stopped but not repaired, escalate = hand to a human."
)


class Action(BaseModel):
    kind: str = Field(max_length=40)
    target_id: str = Field(max_length=60)
    args: dict[str, Any] = Field(default_factory=dict)


class Plan(BaseModel):
    diagnosis: str = Field(max_length=400)
    actions: list[Action] = Field(default_factory=list, max_length=MAX_ACTIONS)
    outcome: str


def _validate_plan(o: Any) -> Plan:
    p = Plan.model_validate(o)
    if p.outcome not in ("resolved", "contained", "escalate"):
        raise ValueError("outcome must be resolved|contained|escalate")
    return p


import hashlib
PROMPT_HASHES = {"single_pass.system": hashlib.sha256(SYSTEM.encode()).hexdigest(), "static_rules": STATIC_RULES}


@dataclass
class Decision:
    arm: str
    actions: list[Json] = field(default_factory=list)
    claim: str = "none"                 # resolved | contained | escalate | none
    diagnosis: str = ""
    source: str = ""                    # rule:<id> | model | fallback:<reason>
    trace: Json = field(default_factory=dict)
    call_ids: list[str] = field(default_factory=list)
    cost_usd: float = 0.0
    tokens: int = 0
    model_error: str | None = None


# ------------------------------------------------------------------------------------------------ static
def static_decide(facts: Json) -> Decision:
    """Rules fire from alarm SIGNATURES only. Order = priority. Returns the plan or an explicit escalation."""
    k, al, pumps = facts["kpis"], facts["alarms"], facts["pumps"]
    acts: list[Json] = []
    rules: list[str] = []

    def add(rule: str, kind: str, target: str, args: Json | None = None) -> None:
        if len(acts) < MAX_ACTIONS:
            acts.append({"kind": kind, "target_id": target, "args": args or {}})
            rules.append(rule)

    tcs0 = k.get("tcs_flow_kg_s", 99.0) < 1.0
    fws0 = k.get("fws_flow_kg_s", 99.0) < 1.0
    if tcs0:
        add("R1_tcs_flow_lost", "switch_duty", "pump_t2")
    if fws0:
        add("R1_fws_flow_lost", "switch_duty", "pump_f2")
    if not (tcs0 or fws0):
        for hz in facts["hazard_zones"]:
            if hz["kind"] == "leak" and hz["zone_id"].startswith("HAZARD_P_HS_"):
                z = hz["zone_id"][-1].lower()
                add("R2_leak", "isolate_valve", f"valve_z{z}")
                add("R2_leak", "replace_section", f"p_hs_{z}")
                add("R2_leak", "reopen_valve", f"valve_z{z}")
        for a, v in al.items():
            if a.startswith("strainer_") and v["status"] in ("warning", "critical"):
                add("R3_strainer", "replace_strainer", a)
        racks = {a: v for a, v in al.items() if a.startswith("rack_")}
        for a, v in racks.items():
            if v["status"] == "critical" and v.get("power_kw", 0) > 160:
                add("R4_rack_overload", "set_load_factor", a, {"factor": 0.2})
        for a, v in racks.items():
            if v["status"] == "critical" and 0.1 < v.get("flow_kg_s", 9) < 0.8 and not any(r.startswith("R3") for r in rules):
                add("R5_rack_low_flow", "service_valve", "valve_" + a[5:])
        if facts["sensor_cross_checks"] and not acts:
            worst = max(facts["sensor_cross_checks"], key=lambda c: abs(c["delta_pct"]))
            add("R6_sensor_xcheck", "recalibrate_sensor", worst["sensor"])
        if not acts:
            warm = [a for a, v in racks.items() if v["status"] == "warning"]
            if len(warm) >= 2 and not any(a.startswith("strainer_") for a in al):
                for a in warm[:MAX_ACTIONS]:
                    add("R7_thermal_shed", "set_load_factor", a, {"factor": 0.5})
    if not acts:
        return Decision("static", [], "escalate", "no playbook rule matches this alarm signature", "rule:none", {"rules": []})
    return Decision("static", acts, "resolved", "playbook: " + ",".join(sorted(set(rules))), "rule:" + "+".join(sorted(set(rules))), {"rules": rules})


def no_action_decide(facts: Json) -> Decision:
    return Decision("no_action", [], "none", "control arm: nothing is done", "control", {})


# ------------------------------------------------------------------------------------------------ single pass
async def single_pass_decide(facts: Json, gw: ModelGateway, run: Run, *, tag: str = "decide") -> Decision:
    user = json.dumps({"console_snapshot": facts}, separators=(",", ":"), default=str)
    idem = f"{run.eng.run_id}:single:{tag}"
    t0_calls = len(gw.mem.rows)
    try:
        r = await gw.complete_structured(system=SYSTEM, user=user, kind="replan", validate=_validate_plan, schema_version="eval.single_pass.v1", max_tokens=900, idem_key=idem,
                                         task_id=f"eval:{run.scenario_id}:{run.seed}", incident_id=f"eval-{run.scenario_id}-{run.seed}")
    except GatewayError as e:
        rows = gw.mem.rows[t0_calls:]
        return Decision("single_pass", [], "escalate", "", f"fallback:{e.code}", {}, [x.call_id for x in rows], sum(x.est_cost_usd or 0 for x in rows),
                        sum((x.tokens_in or 0) + (x.tokens_out or 0) for x in rows), e.code)
    p: Plan = r.parsed
    rows = gw.mem.rows[t0_calls:]
    return Decision("single_pass", [a.model_dump() for a in p.actions], p.outcome, p.diagnosis, "model" if r.source == "network" else "frozen",
                    {"repaired": r.repaired, "model": r.model}, [x.call_id for x in rows], sum(x.est_cost_usd or 0 for x in rows),
                    sum((x.tokens_in or 0) + (x.tokens_out or 0) for x in rows))
