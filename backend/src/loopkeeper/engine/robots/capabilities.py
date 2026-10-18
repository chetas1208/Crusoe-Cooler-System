"""Live "what can this robot do right now" evaluation (V12, agent DRV-E).

One catalog per robot class (identical for every robot of the class) is evaluated against the robot's REAL live view
(``engine.world()["robots"][id]``: battery, mode, mission, control lease, fitted tools, arm state when the engine publishes it) and the
engine's own limits (EngineConfig / ACTIONS registry). Availability is never hard-coded: every capability is a function of live state and
says, in plain language, why it is blocked. Pure functions, no I/O, no wall clock, deterministic for a given input.

Shape of one capability::

    {id, label, category: drive|arm|tool|sensing|mission|safety, available, reason_if_blocked, params, how_to_trigger, command}
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from ..config import EngineConfig
from ..control import MIN_MANUAL_BATTERY
from .actions import ACTIONS

CATEGORIES = ("drive", "arm", "tool", "sensing", "mission", "safety")
Json = dict[str, Any]

# Arm envelope of the 6-DOF manipulator (robotics/mujoco_runtime.py jog_joint limits and the 0..0.07 m gripper). Used only when the live robot
# view carries no per-robot ``manipulator`` block; a published block always wins.
DEFAULT_JOINTS: tuple[tuple[str, float, float], ...] = (
    ("joint_1", -3.14, 3.14), ("joint_2", -2.0, 2.0), ("joint_3", -2.5, 2.5),
    ("joint_4", -3.14, 3.14), ("joint_5", -1.8, 1.8), ("joint_6", -3.14, 3.14),
)
DEFAULT_GRIPPER_MAX_M = 0.07

# Tool fit slots on the OUTRIG rover. The same slots appear for every OUTRIG; a rover that is not fitted shows the slot as blocked.
OUTRIG_TOOL_SLOTS: tuple[tuple[str, str, str], ...] = (
    ("valve_actuate", "Valve actuator", "valve actuator"),
    ("basket", "Strainer basket exchange", "basket"),
    ("pressure_kit", "Pressure test kit", "pressure kit"),
    ("calibration_kit", "Sensor calibration kit", "calibration kit"),
    ("pipe_clamp", "Pipe clamp", "pipe clamp"),
    ("pump_kit", "Pump service kit", "pump kit"),
)
_TOOL_ACTIONS = {"calibration kit": ("recalibrate_sensor",), "basket": ("replace_strainer",), "pump kit": ("service_pump",)}


# ───────────────────────────────────────────────────────────── context
@dataclass
class Ctx:
    robot_id: str
    klass: str
    battery: float
    mode: str
    mission_id: Optional[str]
    state: str                       # controller state: AUTONOMOUS | LEASE_PENDING | MANUAL | SAFE_HOLD
    holder: Optional[str]
    viewer: Optional[str]            # principal asking (None = anonymous fleet view)
    segment_id: Optional[str]
    tools: tuple[str, ...]
    min_bore_mm: Optional[float]
    reach_m: Optional[float]
    sim_status: str
    limits: Json
    view: Json = field(default_factory=dict)
    manip: Optional[Json] = None

    @property
    def docked(self) -> bool:
        return self.mode == "DOCKED"

    @property
    def leased(self) -> bool:
        return self.state in ("LEASE_PENDING", "MANUAL")

    @property
    def mine(self) -> bool:
        return self.leased and self.viewer is not None and self.holder == self.viewer

    def fitted(self, keyword: str) -> bool:
        return any(keyword in t.lower() for t in self.tools)


def engine_limits(engine: Any = None) -> Json:
    """The engine's real manual-drive / lease limits (live EngineConfig when reachable, else the shipped defaults)."""
    cfg = None
    for probe in (engine, getattr(engine, "_e", None)):
        cfg = getattr(probe, "cfg", None)
        if cfg is not None and hasattr(cfg, "manual_max_speed_m_s"):
            break
        cfg = None
    cfg = cfg or EngineConfig()
    return {"manual_max_speed_m_s": float(cfg.manual_max_speed_m_s), "manual_max_speed_outrig_m_s": float(cfg.manual_max_speed_outrig_m_s),
            "battery_reserve_pct": float(cfg.battery_reserve_pct), "lease_ttl_s": float(cfg.lease_ttl_s), "deadman_s": float(cfg.deadman_s)}


def _ctx(robot: Json, viewer: Optional[str], sim_status: str, limits: Json) -> Ctx:
    ctl = robot.get("control") or {}
    caps = robot.get("capabilities") or {}
    pose = robot.get("pose") or {}
    manip = robot.get("manipulator") if isinstance(robot.get("manipulator"), dict) else None
    return Ctx(robot_id=robot["id"], klass=robot.get("class") or "", battery=float(robot.get("battery_pct") or 0.0), mode=str(robot.get("mode") or ""),
               mission_id=robot.get("mission_id"), state=str(ctl.get("controller_state") or "AUTONOMOUS"), holder=ctl.get("holder"), viewer=viewer,
               segment_id=pose.get("segment_id"), tools=tuple(str(t) for t in (caps.get("tools") or ())), min_bore_mm=caps.get("min_bore_mm"),
               reach_m=caps.get("reach_m"), sim_status=sim_status, limits=limits, view=robot, manip=manip)


# ───────────────────────────────────────────────────────────── gates (None = clear, str = plain reason)
def _pct(b: float) -> str:
    return f"{b:.0f}%"


def gate_power(c: Ctx, need: float = MIN_MANUAL_BATTERY) -> Optional[str]:
    if c.battery < need:
        if c.docked:
            return f"The battery is flat ({_pct(c.battery)}) and it is charging at its dock. Try again in a minute."
        return f"The battery is flat ({_pct(c.battery)}). It cannot move or work until it has recharged on its dock."
    return None


def gate_drive(c: Ctx) -> Optional[str]:
    if c.sim_status == "paused":
        return "The simulation is paused. Press play to move robots."
    p = gate_power(c)
    if p:
        return p
    if c.state == "SAFE_HOLD":
        return "Control was just released and the robot is settling. It will be ready again in a few seconds."
    if c.leased and not c.mine:
        return f"Another operator ({c.holder}) is driving it right now." if c.holder else "It is under manual control by another operator."
    if c.mode == "WORKING":
        return "It is in the middle of a repair action."
    if c.mode == "VERIFYING":
        return "A repair it just made is being verified."
    if c.mode == "FAILED":
        return "The robot has failed and needs service before it can move."
    if c.klass == "inpipe" and not c.segment_id:
        return "No position signal. The crawler is not inside the pipe network."
    return None


def gate_autonomous(c: Ctx) -> Optional[str]:
    """Work the robot does on its own (a mission step). Needs power above the reserve, no operator at the sticks, no other mission."""
    if c.sim_status == "paused":
        return "The simulation is paused. Press play to let robots work."
    if c.battery < 1.0:
        return gate_power(c, 1.0)
    reserve = float(c.limits.get("battery_reserve_pct", 12.0))
    if c.battery < reserve:
        return f"The battery is low ({_pct(c.battery)}). It needs more than {reserve:.0f}% to start work, so send it to charge first."
    if c.leased or c.state == "SAFE_HOLD":
        return f"Under manual control by {c.holder}." if c.holder else "It is under manual control right now."
    if c.mission_id:
        return "It is already on a mission. Wait for it to finish or cancel the mission."
    if c.mode == "FAILED":
        return "The robot has failed and needs service."
    if c.mode == "NEEDS_CHARGE":
        return "It stopped to recharge and must charge before more work."
    return None


def _not_fitted(c: Ctx, what: str) -> str:
    if c.klass == "inpipe":
        return f"This crawler has no {what} fitted (inspection-only model)."
    return f"This rover is not fitted with a {what}."


# ───────────────────────────────────────────────────────────── catalog entries
@dataclass(frozen=True)
class Spec:
    id: str
    label: str
    category: str
    how_to_trigger: str
    command: str
    evaluate: Callable[[Ctx], tuple[Optional[str], Json]]      # -> (blocked reason | None, params)


def _drive_speed(c: Ctx) -> float:
    return c.limits["manual_max_speed_outrig_m_s"] if c.klass == "outrig" else c.limits["manual_max_speed_m_s"]


def _e_drive(c: Ctx):
    why = gate_drive(c)
    params: Json = {"max_speed_m_s": _drive_speed(c), "takes_over_mission": bool(c.mission_id and not c.leased)}
    if c.klass == "inpipe":
        params["min_bore_mm"] = c.min_bore_mm
        params["motion"] = "forward / reverse along the pipe centerline"
    else:
        params["motion"] = "throttle + steer on the hall floor"
        params["max_turn_rad_s"] = 1.6
    return why, params


def _e_steer_junction(c: Ctx):
    why = gate_drive(c)
    return why, {"selects": "exit pipe at a junction (steer past 50%)", "min_bore_mm": c.min_bore_mm}


def _e_hold(c: Ctx):
    why = gate_drive(c)
    return why, {"brake_decel": "immediate", "deadman_s": c.limits["deadman_s"], "auto_hold": "robot holds if the operator link drops"}


def _e_camera(c: Ctx):
    if not c.fitted("camera"):
        return _not_fitted(c, "camera"), {}
    if c.battery < 1.0:
        return "The battery is flat, so the camera is off.", {}
    return None, {"view": "forward pipe camera"}


def _spec_params(command: str) -> Json:
    s = ACTIONS.get(command)
    if not s:
        return {}
    return {"duration_s": s.duration_s, "authority": s.authority_level, "needs_approval": bool(s.requires_approval)}


def _e_gauge(c: Ctx):
    if not c.fitted("ultrasonic"):
        return _not_fitted(c, "ultrasonic gauge"), {}
    return gate_autonomous(c), {"measures": "deposit thickness, bore, flow", "min_bore_mm": c.min_bore_mm, **_spec_params("inspect")}


def _e_brush(c: Ctx):
    if not c.fitted("brush"):
        return _not_fitted(c, "brush"), {}
    return gate_autonomous(c), {"min_bore_mm": c.min_bore_mm, **_spec_params("brush_clear")}


def _dock_gate(c: Ctx) -> Optional[str]:
    if c.docked:
        return "It is already at its dock."
    if c.sim_status == "paused":
        return "The simulation is paused. Press play to move robots."
    if c.leased and not c.mine:
        return f"Another operator ({c.holder}) is driving it right now." if c.holder else "It is under manual control by another operator."
    if c.mode in ("FAILED", "WORKING", "VERIFYING"):
        return {"WORKING": "It is in the middle of a repair action.", "VERIFYING": "A repair it just made is being verified."}.get(
            c.mode, "The robot has failed and needs service before it can move.")
    return None


def _e_return(c: Ctx):
    p: Json = {"dock_id": c.view.get("home_id"), "plans": "a collision-checked route to its dock"}
    if c.battery < MIN_MANUAL_BATTERY:
        p["note"] = "the pack is empty, so it cannot drive: a recovery crew brings it in"
    return _dock_gate(c), p


def _e_charge(c: Ctx):
    if not c.docked:
        return "It must be at its dock to charge. Send it home first.", {"dock_id": c.view.get("home_id")}
    if c.battery >= 99.9:
        return "The battery is already full.", {"battery_pct": round(c.battery, 1)}
    return None, {"battery_pct": round(c.battery, 1), "charge_rate_pct_per_s": 0.05}


def _e_mission(c: Ctx):
    return gate_autonomous(c), {"battery_reserve_pct": c.limits["battery_reserve_pct"]}


def _joint_limits(c: Ctx, i: int) -> tuple[str, float, float]:
    m = c.manip or {}
    joints = m.get("joints")
    if isinstance(joints, list) and i < len(joints) and isinstance(joints[i], dict):
        j = joints[i]
        lo, hi = j.get("min_rad", j.get("min")), j.get("max_rad", j.get("max"))
        if lo is not None and hi is not None:
            return str(j.get("name") or DEFAULT_JOINTS[i][0]), float(lo), float(hi)
    n, lo, hi = DEFAULT_JOINTS[i]
    return n, lo, hi


def _arm_gate(c: Ctx) -> Optional[str]:
    if c.klass != "outrig":
        return "Only OUTRIG rovers carry the 6-axis arm."
    m = c.manip
    if m is not None and m.get("available") is False:
        return str(m.get("reason") or "The arm is not available right now.")
    return gate_drive(c)


def _qpos(c: Ctx, i: int) -> Optional[float]:
    q = (c.manip or {}).get("qpos_rad") or c.view.get("arm_qpos_rad")
    return round(float(q[i]), 3) if isinstance(q, list) and i < len(q) else None


def _joint(i: int):
    def ev(c: Ctx):
        name, lo, hi = _joint_limits(c, i)
        return _arm_gate(c), {"joint": name, "min_rad": lo, "max_rad": hi, "position_rad": _qpos(c, i), "max_rate_rad_s": 1.8}
    return ev


def _gripper_max(c: Ctx) -> float:
    g = (c.manip or {}).get("gripper") or {}
    v = g.get("max_aperture_m") if isinstance(g, dict) else None
    return float(v) if v is not None else DEFAULT_GRIPPER_MAX_M


def _held(c: Ctx) -> tuple[bool, Optional[str]]:
    """(arm state known, held object id)."""
    if c.manip is not None and "held_object_id" in c.manip:
        return True, c.manip["held_object_id"]
    if "arm_qpos_rad" in c.view:
        return True, c.view.get("held_object_id")
    return False, None


def _e_gripper(c: Ctx):
    ap = (c.manip or {}).get("gripper_aperture_m", c.view.get("gripper_aperture_m"))
    return _arm_gate(c), {"min_aperture_m": 0.0, "max_aperture_m": _gripper_max(c), "aperture_m": ap}


def _e_pick(c: Ctx):
    why = _arm_gate(c)
    known, held = _held(c)
    if not why and known and held:
        why = "The gripper is already holding something. Place it first."
    return why, {"payload": "strainer cartridge", "reach_m": c.reach_m, "held_object_id": held}


def _e_place(c: Ctx):
    why = _arm_gate(c)
    known, held = _held(c)
    if not why and known and not held:
        why = "The gripper is empty. Pick something up first."
    return why, {"reach_m": c.reach_m, "held_object_id": held}


def _preset(name: str, label_for_reason: str):
    def ev(c: Ctx):
        why = _arm_gate(c)
        m = c.manip or {}
        presets = m.get("presets") or m.get("poses") or m.get("commands") or m.get("actions")
        offered = isinstance(presets, (list, tuple, set)) and name in presets
        if not why and not offered:
            why = f"The arm controller does not offer a {label_for_reason} move yet. Jog the joints instead."
        return why, {"reach_m": c.reach_m}
    return ev


def _e_tool_slot(keyword: str):
    def ev(c: Ctx):
        acts = [a.command for a in ACTIONS.values() if a.klass == c.klass and keyword in a.tools]
        params: Json = {"mission_steps": acts}
        if acts:
            hi = max((ACTIONS[a] for a in acts), key=lambda s: s.authority_level)
            params.update(authority=hi.authority_level, needs_approval=any(ACTIONS[a].requires_approval for a in acts))
        if not c.fitted(keyword):
            return _not_fitted(c, keyword), params
        return gate_autonomous(c), params
    return ev


def _build() -> dict[str, tuple[Spec, ...]]:
    inpipe = (
        Spec("drive_pipe", "Drive along the pipe", "drive", "Take control, then throttle forward or reverse", "drive.throttle", _e_drive),
        Spec("steer_junction", "Steer at a junction", "drive", "At a junction, steer left or right to pick the exit", "drive.exit", _e_steer_junction),
        Spec("camera", "Camera", "sensing", "Open the robot camera view", "view.camera", _e_camera),
        Spec("ultrasonic_gauge", "Ultrasonic wall gauge", "sensing", "Mission step: inspect", "mission.inspect", _e_gauge),
        Spec("brush_clean", "Brush clean deposits", "tool", "Mission step: brush clear", "mission.brush_clear", _e_brush),
        Spec("autonomous_mission", "Run an autonomous mission", "mission", "Launch a scenario or let the agents dispatch it", "mission.run", _e_mission),
        Spec("return_to_dock", "Return to dock", "mission", "Send it to its dock (releases manual control first)", "dock.send", _e_return),
        Spec("charge", "Charge battery", "mission", "Charges by itself while docked", "dock.charge", _e_charge),
        Spec("hold_stop", "Hold / stop", "safety", "Brake, or release control to hold in place", "drive.brake", _e_hold),
    )
    outrig = (
        Spec("base_drive", "Drive the base", "drive", "Take control, then throttle and steer", "drive.throttle", _e_drive),
        *(Spec(f"arm_joint_{i + 1}", f"Arm joint {i + 1}", "arm", "Jog the joint with the arm controls", "drive.joint_jog", _joint(i)) for i in range(6)),
        Spec("gripper", "Gripper", "arm", "Open or close the gripper", "drive.gripper", _e_gripper),
        Spec("pick", "Pick up", "arm", "Close the gripper on the cartridge", "drive.pick", _e_pick),
        Spec("place", "Place", "arm", "Release the held cartridge at the fixture", "drive.place", _e_place),
        Spec("arm_home", "Arm to home pose", "arm", "Send the arm to its home pose", "arm.home", _preset("home", "home")),
        Spec("arm_stow", "Stow the arm", "arm", "Fold the arm into travel position", "arm.stow", _preset("stow", "stow")),
        *(Spec(sid, label, "tool", "Mission step on the matching tool", f"mission.{sid}", _e_tool_slot(kw)) for sid, label, kw in OUTRIG_TOOL_SLOTS),
        Spec("autonomous_mission", "Run an autonomous mission", "mission", "Launch a scenario or let the agents dispatch it", "mission.run", _e_mission),
        Spec("return_to_dock", "Return to dock", "mission", "Send it to its dock (releases manual control first)", "dock.send", _e_return),
        Spec("charge", "Charge battery", "mission", "Charges by itself while docked", "dock.charge", _e_charge),
        Spec("hold_stop", "Hold / stop", "safety", "Brake, or release control to hold in place", "drive.brake", _e_hold),
    )
    return {"inpipe": inpipe, "outrig": outrig}


CATALOG: dict[str, tuple[Spec, ...]] = _build()


def catalog(klass: str) -> list[Json]:
    """The static, class-wide capability list (no live state)."""
    return [{"id": s.id, "label": s.label, "category": s.category, "how_to_trigger": s.how_to_trigger, "command": s.command}
            for s in CATALOG.get(klass, ())]


# ───────────────────────────────────────────────────────────── evaluation
def evaluate_robot(robot: Json, *, viewer: Optional[str] = None, sim_status: str = "running", limits: Optional[Json] = None,
                   compact: bool = False) -> Json:
    """Evaluate every capability of the robot's class against its live view. ``compact`` drops params / labels (fleet matrix)."""
    c = _ctx(robot, viewer, sim_status, limits or engine_limits())
    out: list[Json] = []
    for s in CATALOG.get(c.klass, ()):
        why, params = s.evaluate(c)
        row: Json = {"id": s.id, "category": s.category, "available": why is None, "reason_if_blocked": why}
        if not compact:
            row.update(label=s.label, params=params, how_to_trigger=s.how_to_trigger, command=s.command)
        out.append(row)
    drive_why = gate_drive(c)
    ready = sum(1 for r in out if r["available"])
    return {
        "robot_id": c.robot_id, "class": c.klass, "name": robot.get("name"), "battery_pct": round(c.battery, 1), "mode": c.mode,
        "controller_state": c.state, "holder": c.holder, "mission_id": c.mission_id,
        "drivable": drive_why is None, "drive_blocked_reason": drive_why,
        "counts": {"available": ready, "blocked": len(out) - ready},
        "capabilities": out,
    }


def evaluate_fleet(robots: dict[str, Json] | list[Json], *, viewer: Optional[str] = None, sim_status: str = "running",
                   limits: Optional[Json] = None) -> Json:
    rows = list(robots.values()) if isinstance(robots, dict) else list(robots)
    rows.sort(key=lambda r: (r.get("class") or "", r["id"]))
    lim = limits or engine_limits()
    classes = sorted({r.get("class") or "" for r in rows})
    return {
        "catalog": {k: catalog(k) for k in classes if k in CATALOG},
        "robots": [evaluate_robot(r, viewer=viewer, sim_status=sim_status, limits=lim, compact=True) for r in rows],
    }
