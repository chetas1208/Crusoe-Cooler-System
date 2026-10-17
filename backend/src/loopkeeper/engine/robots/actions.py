"""Whitelisted robot actions (backend.md section 6 + 13). Every step a mission may execute is declared here with
its duration, tooling, preconditions and modelled plant effect. Anything else is rejected `not_whitelisted`."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from ..geometry import Vec3  # noqa: F401


def _str(x: Any) -> bool: return isinstance(x, str) and 0 < len(x) <= 128
def _num(x: Any) -> bool: return isinstance(x, (int, float)) and not isinstance(x, bool) and x == x and abs(x) < 1e7
def _pos(x: Any) -> bool: return isinstance(x, (list, tuple)) and len(x) == 3 and all(_num(v) for v in x)
def _gauge(x: Any) -> bool: return x in ("deposit", "bore", "flow", "general")


@dataclass(frozen=True)
class ActionSpec:
    command: str
    klass: str                       # inpipe | outrig
    kind: str                        # move | action | instant
    mode: str                        # robot mode while executing
    duration_s: float = 0.0
    authority_level: str = "L0"      # L0 (observe) | L1 (minor restore) | L2 (isolated service) | L3 (high impact)
    tools: tuple = ()                # keywords; robot.tool must contain one (outrig) / robot hw tools (inpipe)
    effect: str | None = None        # key into PLANT_COMMANDS; applied ONLY on completion
    high_impact: bool = False        # held when physics is degraded
    requires_approval: bool = False  # needs an approved ApprovalRequest on the mission
    needs_isolation: bool = False    # disassembly/clamp: target must be isolated + depressurised
    proximity: str | None = None     # 'asset' | 'segment'
    repair: bool = False             # emits repair.started / repair.completed
    args: dict = field(default_factory=dict)  # allowed arg name -> validator


ACTIONS: dict[str, ActionSpec] = {a.command: a for a in [
    # --- INPIPE ---
    ActionSpec("launch", "inpipe", "action", "ASSIGNED", 6.0, authority_level="L0"),
    ActionSpec("move_to", "inpipe", "move", "TRAVELING", authority_level="L0", args={"segment_id": _str, "s_m": _num}),
    ActionSpec("inspect", "inpipe", "action", "INSPECTING", 12.0, authority_level="L0", args={"gauge": _gauge, "segment_id": _str, "s_m": _num}),
    ActionSpec("sample", "inpipe", "action", "INSPECTING", 8.0, authority_level="L0", args={"kind": _str}),
    ActionSpec("brush_clear", "inpipe", "action", "WORKING", 55.0, authority_level="L1", tools=("brush",), effect="brush_clear",
               high_impact=False, requires_approval=False, proximity="segment", repair=True,
               args={"segment_id": _str, "s_m": _num, "max_torque_pct": _num}),
    ActionSpec("return_to_port", "inpipe", "move", "RETURNING", authority_level="L0"),
    ActionSpec("dock", "inpipe", "instant", "DOCKED", authority_level="L0"),
    # --- OUTRIG ---
    ActionSpec("navigate", "outrig", "move", "TRAVELING", authority_level="L0", args={"target_id": _str, "position_xyz_m": _pos}),
    ActionSpec("scan", "outrig", "action", "INSPECTING", 8.0, authority_level="L0", args={"target_id": _str}),
    ActionSpec("fetch_tool", "outrig", "action", "WORKING", 10.0, authority_level="L0", args={"tool": _str}),
    ActionSpec("isolate_valve", "outrig", "action", "WORKING", 15.0, authority_level="L3", tools=("valve actuator",), effect="isolate_valve",
               high_impact=True, requires_approval=True, proximity="asset", repair=False, args={"valve_id": _str}),
    # duplex changeover: the standby basket is swapped in without interrupting flow, so no zone isolation is required
    ActionSpec("replace_strainer", "outrig", "action", "WORKING", 60.0, authority_level="L2", tools=("basket",), effect="replace_strainer",
               high_impact=False, needs_isolation=False, proximity="asset", repair=True, args={"target_id": _str}),
    # pump service happens on the OFF-duty pump (agents swap duty first via pump.switch_duty); sensors are recalibrated in place
    ActionSpec("service_pump", "outrig", "action", "WORKING", 70.0, authority_level="L2", tools=("pump kit",), effect="replace_pump",
               high_impact=False, proximity="asset", repair=True, args={"target_id": _str}),
    ActionSpec("recalibrate_sensor", "outrig", "action", "WORKING", 30.0, authority_level="L1", tools=("calibration kit",), effect="recalibrate_sensor",
               proximity="asset", repair=True, args={"target_id": _str}),
    ActionSpec("service_valve", "outrig", "action", "WORKING", 40.0, authority_level="L2", tools=("valve actuator",), effect="service_valve",
               high_impact=False, proximity="asset", repair=True, args={"target_id": _str}),
    ActionSpec("replace_section", "outrig", "action", "WORKING", 90.0, authority_level="L3", tools=("pipe clamp",), effect="replace_section",
               high_impact=True, requires_approval=True, needs_isolation=True, proximity="asset", repair=True,
               args={"segment_id": _str}),
    ActionSpec("clamp_accessible_leak", "outrig", "action", "WORKING", 45.0, authority_level="L2", tools=("pipe clamp",), effect="clamp_leak",
               high_impact=False, requires_approval=False, needs_isolation=True, proximity="asset", repair=True,
               args={"target_id": _str}),
    ActionSpec("pressure_test", "outrig", "action", "INSPECTING", 20.0, authority_level="L0", tools=("pressure kit",), proximity="asset",
               args={"target_id": _str, "hold_s": _num, "kpa": _num}),
    ActionSpec("reopen_valve", "outrig", "action", "WORKING", 10.0, authority_level="L2", tools=("valve actuator",), effect="reopen_valve",
               high_impact=False, proximity="asset", args={"valve_id": _str}),
    ActionSpec("return_to_dock", "outrig", "move", "RETURNING", authority_level="L0"),
]}

# engine action -> plant command kind (override via EngineConfig.plant_command_map). Package A implements these.
PLANT_COMMANDS: dict[str, str] = {
    "isolate_valve": "isolate_valve",
    "reopen_valve": "reopen_valve",
    "service_valve": "service_valve",
    "brush_clear": "brush_clear",
    "replace_section": "replace_section",
    "replace_strainer": "replace_strainer",
    "replace_pump": "replace_pump",
    "recalibrate_sensor": "recalibrate_sensor",
    "switch_duty": "switch_duty",
    "clamp_leak": "clamp_leak",
    "set_load": "set_load_factor",
    "inject_fault": "inject_fault",
}

TOOL_KEYWORDS = ("valve actuator", "basket", "pipe clamp", "pressure kit", "brush", "camera")


def tool_matches(tool: str | None, keywords: tuple) -> bool:
    if not keywords:
        return True
    t = (tool or "").lower()
    return any(k in t for k in keywords)


def validate_step_args(spec: ActionSpec, args: dict) -> str | None:
    if not isinstance(args, dict):
        return "args must be an object"
    for k, v in args.items():
        chk = spec.args.get(k)
        if chk is None:
            return f"unexpected arg '{k}' for {spec.command}"
        if not chk(v):
            return f"invalid arg '{k}' for {spec.command}"
    return None
