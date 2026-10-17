"""Command admissibility whitelist + safety gates (backend.md §13) + model-proposal validators.

The LLM can only propose. Nothing reaches `engine.submit` unless `Policy.check_command`
passes; the engine validates again at commit time (single writer). Real plant actuation
is not representable here: anything flagged real/non-simulated is rejected.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .facility import Facility
from .world import Json, rd

ADMISSIBLE_KINDS = {
    "robot.mission.assign", "robot.mission.cancel", "pump.switch_duty", "workload.set_load", "twin.counterfactual",
}
INPIPE_STEPS = {"launch", "move_to", "inspect", "sample", "brush_clear", "return_to_port", "dock"}
OUTRIG_STEPS = {"navigate", "scan", "fetch_tool", "isolate_valve", "replace_strainer", "service_valve",
                "service_pump", "replace_section", "recalibrate_sensor", "clamp_accessible_leak",
                "pressure_test", "reopen_valve", "return_to_dock"}
OUTRIG_SERVICE_ACTIONS = {"replace_section", "replace_strainer", "service_valve", "service_pump", "recalibrate_sensor"}
DISASSEMBLY_ACTIONS = {"replace_section", "service_valve"}      # require zone isolation (engine default plan isolates first)
MISSION_KINDS = {"inpipe": {"inspect", "clear", "return"}, "outrig": {"service", "return"}}
HIGH_IMPACT_STEPS = {"isolate_valve", "brush_clear", "replace_section", "service_valve", "clamp_accessible_leak"}
BAD_ROBOT_MODES = {"FAILED", "ABORTED", "NEEDS_CHARGE", "SAFE_HOLD", "BLOCKED"}
BATTERY_RESERVE_PCT = 25.0
CORDON_MAX_FRACTION = 0.25
MAX_STEPS = 16

ACTIONS: dict[str, dict[str, Any]] = {
    "brush_clear": {"robot": "inpipe", "causes": {"fouling"}, "approval": True, "isolate": False},
    "replace_section": {"robot": "outrig", "causes": {"fouling"}, "approval": True, "isolate": True},
    "replace_strainer": {"robot": "outrig", "causes": {"strainer_blockage"}, "approval": False, "isolate": False},
    "service_valve": {"robot": "outrig", "causes": {"valve_stuck"}, "approval": True, "isolate": True},
    "service_pump": {"robot": "outrig", "causes": {"pump_degradation"}, "approval": False, "isolate": False},
    "recalibrate_sensor": {"robot": "outrig", "causes": {"sensor_drift"}, "approval": False, "isolate": False},
    "monitor_only": {"robot": None, "causes": {"workload_spike"}, "approval": False, "isolate": False},
    "escalate": {"robot": None, "causes": None, "approval": False, "isolate": False},
}
LADDERS: dict[str, list[str]] = {
    "fouling": ["brush_clear", "replace_section"],
    "strainer_blockage": ["replace_strainer"],
    "valve_stuck": ["service_valve"],
    "pump_degradation": ["service_pump"],
    "sensor_drift": ["recalibrate_sensor"],
    "workload_spike": ["monitor_only"],
}
GAUGES = {"fouling": {"deposit"}, "valve_stuck": {"bore"}, "sensor_drift": {"bore"}}
PROBE_TOOLS = {"read_telemetry", "query_topology", "check_mass_balance", "check_flow_normality"}


@dataclass
class Verdict:
    ok: bool = True
    gates: list[dict] = field(default_factory=list)

    def gate(self, name: str, ok: bool, detail: str = "") -> bool:
        self.gates.append({"gate": name, "ok": ok, "detail": detail})
        if not ok:
            self.ok = False
        return ok

    @property
    def reasons(self) -> list[str]:
        return [f"{g['gate']}: {g['detail']}" for g in self.gates if not g["ok"]]

    def summary(self) -> Json:
        return {"ok": self.ok, "gates": self.gates}


class ResourceLocks:
    """Cross-incident reservations (robots, zone isolation). Re-acquirable by the same owner (idempotent resume)."""

    def __init__(self) -> None:
        self.robot_owner: dict[str, str | None] = {}
        self.isolation_owner: str | None = None

    def try_robot(self, robot: str, inc: str) -> bool:
        o = self.robot_owner.get(robot)
        if o in (None, inc):
            self.robot_owner[robot] = inc
            return True
        return False

    def release_robot(self, robot: str, inc: str) -> None:
        if self.robot_owner.get(robot) == inc:
            self.robot_owner[robot] = None

    def try_isolation(self, inc: str) -> bool:
        if self.isolation_owner in (None, inc):
            self.isolation_owner = inc
            return True
        return False

    def release_isolation(self, inc: str) -> None:
        if self.isolation_owner == inc:
            self.isolation_owner = None

    def release_all(self, inc: str) -> None:
        for r, o in list(self.robot_owner.items()):
            if o == inc:
                self.robot_owner[r] = None
        self.release_isolation(inc)


class Policy:
    def __init__(self, fac: Facility, *, approval_mode: str = "autonomous", approval_window_s: float = 20.0,
                 locks: ResourceLocks | None = None) -> None:
        self.fac, self.mode, self.window = fac, approval_mode, approval_window_s
        self.locks = locks or ResourceLocks()

    # ── approvals ──
    def approval_required(self, action: str) -> bool:
        return bool(ACTIONS.get(action, {}).get("approval"))

    def approval_style(self) -> str:
        return "explicit" if self.mode == "supervised" else "veto-window"

    # ── command gate ──
    def check_command(self, cmd: Json, world: Json, incident_id: str | None = None) -> Verdict:
        v = Verdict()
        kind = cmd.get("kind")
        v.gate("whitelist", kind in ADMISSIBLE_KINDS, f"kind={kind}")
        if not v.ok:
            return v
        args = cmd.get("args") or {}
        v.gate("simulation_only", not args.get("real") and cmd.get("simulated", True) is not False,
               "real plant actuation is disabled")
        v.gate("idempotency_key", bool(cmd.get("command_id")), "command_id required")
        if kind == "robot.mission.assign":
            self._mission(cmd, args, world, incident_id, v)
        elif kind == "pump.switch_duty":
            to = cmd.get("target_id")
            v.gate("target_exists", to in self.fac.tcs_pumps, f"{to}")
            a = (world.get("assets") or {}).get(to) or {}
            h = (a.get("fault") or {}).get("health", 1.0)
            v.gate("standby_healthy", a.get("status") not in ("critical", "offline", "service") and h >= 0.9, f"standby status={a.get('status')}")
        elif kind == "workload.set_load":
            tgt = cmd.get("target_id")
            v.gate("target_exists", tgt in self.fac.racks, str(tgt))
            lf = args.get("load_factor", 1.0)
            v.gate("load_bounds", isinstance(lf, (int, float)) and 0.05 <= lf <= 1.0, f"load_factor={lf}")
        elif kind == "twin.counterfactual":
            v.gate("read_only", True, "")
        return v

    def _mission(self, cmd: Json, a: Json, world: Json, inc: str | None, v: Verdict) -> None:
        fac = self.fac
        rid = a.get("robot_id")
        alias = {"c_01": "IR-01", "c_02": "IR-02", "o_01": "OR-01", "o_02": "OR-02"}
        canonical_rid = alias.get(rid, rid)
        robot = (world.get("robots") or {}).get(rid) or (world.get("robots") or {}).get(canonical_rid)
        if not v.gate("robot_exists", robot is not None, f"robot={rid}"):
            return
        cls, kind = robot.get("class"), a.get("kind")
        v.gate("mission_kind", kind in MISSION_KINDS.get(cls, set()), f"{cls} cannot run '{kind}'")
        tgt, params = a.get("target_id"), a.get("params") or {}
        v.gate("target_exists", bool(tgt) and fac.exists(tgt), f"target={tgt}")
        if kind != "return":
            v.gate("battery_reserve", float(robot.get("battery_pct", 0)) >= BATTERY_RESERVE_PCT, f"battery={robot.get('battery_pct')}%")
        v.gate("robot_health", robot.get("mode") not in BAD_ROBOT_MODES, f"mode={robot.get('mode')}")
        if inc:
            owner = self.locks.robot_owner.get(canonical_rid) or self.locks.robot_owner.get(rid)
            v.gate("no_robot_conflict", owner in (None, inc), f"reserved by {owner}")
        if not v.ok:
            return
        if cls == "inpipe" and kind in ("inspect", "clear"):
            edge = tgt if tgt in fac.edges else (fac.assets.get(tgt) or {}).get("edge_id")
            e = fac.edges.get(edge or "")
            v.gate("segment_serviceable", bool(e and e.get("robot_passable")), f"{edge}: {(e or {}).get('not_passable_reason', 'not passable')}")
            pose = robot.get("pose") or {}
            if e and e.get("robot_passable") and pose.get("segment_id"):
                v.gate("route_exists", fac.route((pose["segment_id"], float(pose.get("s_m") or 0.0)), (edge, float(e["length_m"]) / 2)) is not None,
                       f"{pose['segment_id']}->{edge}")
            if kind == "clear":
                v.gate("approval_policy", bool(a.get("approval_id")), "brush clearing needs an approved request")
        elif cls == "outrig" and kind == "service":
            act = params.get("action")
            v.gate("service_whitelist", act in OUTRIG_SERVICE_ACTIONS, f"action={act}")
            if act in DISASSEMBLY_ACTIONS:
                valve = params.get("isolate_valve")
                zone = (fac.assets.get(valve or "") or {}).get("zone_id")
                v.gate("isolation_before_disassembly", bool(valve and zone and fac.zone_valve(zone) == valve), "a zone isolation valve must be closed before disassembly")
                if zone:
                    self._isolation_gates(zone, world, inc, v)
                v.gate("approval_policy", bool(a.get("approval_id")), "isolating a zone needs an approved request")
            if act == "service_pump":
                duty = max(fac.tcs_pumps, key=lambda p: rd(world, p, "speed_pct", 0.0) or 0.0, default=None)
                v.gate("pump_off_duty", tgt != duty or (rd(world, tgt, "speed_pct", 0.0) or 0.0) <= 0.0, f"{tgt} must be off duty before service")

    def _isolation_gates(self, zone: str, world: Json, inc: str | None, v: Verdict) -> None:
        fac = self.fac
        v.gate("isolation_target", zone in fac.zones and bool(fac.zone_valve(zone)), f"zone={zone}")
        if not v.ok:
            return
        if inc:
            v.gate("isolation_lock", self.locks.isolation_owner in (None, inc), f"held by {self.locks.isolation_owner}")
        racks = fac.zone_racks(zone)
        hot = [r for r in racks if (rd(world, r, "power_kw", 0.0) or 0.0) > CORDON_MAX_FRACTION * fac.nominal_rack_kw]
        v.gate("racks_cordoned", not hot, f"still loaded: {hot}")
        edges = fac.zone_edges(zone)
        inside = [rid for rid, r in (world.get("robots") or {}).items()
                  if r.get("class") == "inpipe" and (r.get("pose") or {}).get("segment_id") in edges and r.get("mode") != "DOCKED"]
        v.gate("crawler_out_of_segment", not inside, f"inside: {inside}")

    # ── model-proposal validators (return error strings; empty = admissible) ──
    def validate_hypotheses(self, dec: Any, det_cause: str) -> list[str]:
        errs: list[str] = []
        for h in dec.hypotheses:
            if not self.fac.exists(h.target_id):
                errs.append(f"unknown target {h.target_id}")
        return errs

    def validate_followups(self, fups: list[Any]) -> list[str]:
        errs = []
        for f in fups:
            if f.tool not in PROBE_TOOLS:
                errs.append(f"probe tool {f.tool} not whitelisted")
            if not self.fac.exists(f.target_id):
                errs.append(f"unknown probe target {f.target_id}")
        return errs

    def validate_intervention(self, dec: Any, cause: str, options: list[str], target_for: dict[str, str]) -> list[str]:
        errs: list[str] = []
        if dec.action not in options:
            errs.append(f"action {dec.action} not admissible for cause {cause} (options: {options})")
            return errs
        want = target_for.get(dec.action)
        if want and dec.target_id != want:
            errs.append(f"target {dec.target_id} does not match required target {want}")
        return errs

    def validate_inspection(self, dec: Any, cause: str) -> list[str]:
        if dec.inspect:
            if dec.gauge not in GAUGES.get(cause, set()):
                return [f"gauge {dec.gauge} not valid for {cause}"]
        return []

    def options_for(self, cause: str, attempt: int, brush_ok: bool) -> list[str]:
        ladder = LADDERS.get(cause, [])
        if cause == "fouling":
            # least-invasive first: the ladder is brush_clear then replace_section
            return ["brush_clear"] if (attempt == 0 and brush_ok) else ["replace_section"]
        return list(ladder)
