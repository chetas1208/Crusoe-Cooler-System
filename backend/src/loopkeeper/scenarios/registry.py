"""V8 crisis scenario registry.

The registry is deliberately data-only: it describes the nine requested cases and
whether this repository can drive the current authoritative plant model for each
fault family.  Rendering, agents and UI consume this; they do not invent cases.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Json = dict[str, Any]
Severity = Literal["SEVERE", "MODERATE"]
Readiness = Literal["READY", "PARTIAL", "BLOCKED", "NOT_IMPLEMENTED"]

ORDER = ("CR-01", "CR-02", "CR-03", "CR-04", "CR-05", "CR-06", "CR-07", "MD-01", "MD-02")
DURATION_SIM_S = 1800


@dataclass(frozen=True)
class FaultOp:
    operator: str
    asset_id: str
    tick: int
    params: Json = field(default_factory=dict)
    capability: Literal["real", "proxy", "unsupported"] = "real"


@dataclass(frozen=True)
class ScenarioDefinition:
    scenario_id: str
    version: str
    severity: Severity
    label: str
    learning_goal: str
    seed: int
    duration_sim_s: int
    world_layout_id: str
    graph_revision: str
    required_assets: tuple[str, ...]
    required_robot_tools: tuple[str, ...]
    fault_injections: tuple[FaultOp, ...]
    physical_preconditions: tuple[str, ...]
    observed_signals: tuple[str, ...]
    hidden_actual_state: tuple[str, ...]
    uncertainty: Json
    escalation_policy: str
    allowed_interventions: tuple[str, ...]
    disallowed_interventions: tuple[str, ...]
    initial_agent_tasks: tuple[str, ...]
    verification_metrics: tuple[str, ...]
    termination_policy: str
    camera_preset: str
    timeline_markers: tuple[Json, ...]
    artifact_requirements: tuple[str, ...]
    failure_injection_switches: tuple[str, ...]
    supported_status: Readiness
    implementation_notes: tuple[str, ...] = ()

    def to_wire(self, topology: Json | None = None) -> Json:
        d = asdict(self)
        d["fault_injections"] = [asdict(f) for f in self.fault_injections]
        d["readiness"] = validate_definition(self, topology)
        return d


def _markers() -> tuple[Json, ...]:
    return (
        {"sim_s": 0, "label": "baseline snapshot"},
        {"sim_s": 120, "label": "fault onset"},
        {"sim_s": 300, "label": "evidence correlation"},
        {"sim_s": 600, "label": "robot / safety action window"},
        {"sim_s": 1080, "label": "verification dwell"},
        {"sim_s": 1800, "label": "final verdict"},
    )


def _base(*, sid: str, severity: Severity, label: str, goal: str, seed: int, required: tuple[str, ...],
          tools: tuple[str, ...], faults: tuple[FaultOp, ...], status: Readiness, notes: tuple[str, ...] = (),
          allowed: tuple[str, ...] = ("inspect", "mission.create", "workload.set_load"),
          disallowed: tuple[str, ...] = ("unsafe energized repair", "teleport robot", "LLM motor control")) -> ScenarioDefinition:
    return ScenarioDefinition(
        scenario_id=sid,
        version="v8.0",
        severity=severity,
        label=label,
        learning_goal=goal,
        seed=seed,
        duration_sim_s=DURATION_SIM_S,
        world_layout_id="facility_layout_v6",
        graph_revision="current",
        required_assets=required,
        required_robot_tools=tools,
        fault_injections=faults,
        physical_preconditions=("five rack rows", "four roads", "TCS/FWS separated at CDU", "single world writer"),
        observed_signals=("solver health", "flow kg/s", "pressure kPa", "temperature C", "robot poses", "verification events"),
        hidden_actual_state=("fault process state", "true rack thermal state", "sensor bias terms"),
        uncertainty={"noise_model": "existing plant measurement noise", "agent_oracle": False},
        escalation_policy="Escalate or safe-hold when deterministic preconditions fail; do not fabricate repair success.",
        allowed_interventions=allowed,
        disallowed_interventions=disallowed,
        initial_agent_tasks=("detect/triage", "fleet feasibility", "safety approval", "independent verification"),
        verification_metrics=("safe_state_rules_passed", "solver_converged", "affected_flow_or_temperature_response", "no_unapproved_high_risk_actions"),
        termination_policy="Continue monitoring until exactly 1800 simulated seconds, then freeze final snapshot and verdict.",
        camera_preset="incident_follow",
        timeline_markers=_markers(),
        artifact_requirements=("world_events", "world_snapshots", "verifier_result", "clock_beacons"),
        failure_injection_switches=tuple(f.operator for f in faults),
        supported_status=status,
        implementation_notes=notes,
    )


SCENARIOS: dict[str, ScenarioDefinition] = {
    "CR-01": _base(
        sid="CR-01", severity="SEVERE", label="CDU circulation collapse",
        goal="Distinguish TCS circulation loss from thermal-only alarms and avoid impossible flow after a pump collapse.",
        seed=12001, required=("pump_t1", "pump_t2", "cdu_01"), tools=("pump kit", "camera"),
        faults=(FaultOp("pump_degradation", "pump_t1", 240, {"health_end": 0.02, "duration_s": 2}),),
        status="READY", allowed=("inspect", "pump.switch_duty", "workload.set_load", "service_pump"),
    ),
    "CR-02": _base(
        sid="CR-02", severity="SEVERE", label="Manifold rupture and aisle flood",
        goal="Isolate ruptured cooling manifold segment, clear road hazard, and verify pressure recovery without unsafe entry.",
        seed=12002, required=("p_hs_c", "valve_zc"), tools=("pipe clamp", "pressure kit"),
        faults=(FaultOp("leak", "p_hs_c", 240, {"orifice_m2": 2.8e-5}, "real"),),
        status="READY",
        notes=("Torricelli orifice discharge coupled to loop pressure derating and spatial puddle hazard expansion.",),
        allowed=("inspect", "isolate_valve", "replace_section", "reopen_valve"),
    ),
    "CR-03": _base(
        sid="CR-03", severity="SEVERE", label="Heat rejection collapse",
        goal="Separate FWS/chiller temperature boundary failure from TCS pressure loss.",
        seed=12003, required=("chiller_01", "cdu_01", "pump_t1"), tools=("camera",),
        faults=(FaultOp("set_chiller_setpoint", "chiller_01", 240, {"supply_c": 36.0}),),
        status="READY", allowed=("inspect", "workload.set_load"),
    ),
    "CR-04": _base(
        sid="CR-04", severity="SEVERE", label="Power and cooling double contingency",
        goal="Constrain actions by available power, prioritize survivability, and coordinate compute load shedding.",
        seed=12004, required=("pump_t1", "pump_f1", "rack_a1"), tools=("camera",),
        faults=(FaultOp("trip_pump", "pump_t1", 240, {}, "real"), FaultOp("trip_pump", "pump_f1", 260, {}, "real")),
        status="READY",
        notes=("Common-mode power contingency with 15-minute UPS domain, pump loss, and automated load curtailment.",),
        allowed=("workload.set_load", "safe_hold", "return_home"),
    ),
    "CR-05": _base(
        sid="CR-05", severity="SEVERE", label="Electrical rack smoke/fire",
        goal="Emergency containment with prohibited autonomous rack repair inside an energized/smoke hazard.",
        seed=12005, required=("rack_a1",), tools=("camera",),
        faults=(FaultOp("workload_spike", "rack_a1", 240, {"extra": 0.8, "duration_s": 900}, "real"),),
        status="READY",
        notes=("Electrical thermal overload with smoke exclusion perimeter, automated alarm, and emergency rack trip.",),
        allowed=("emergency_isolation_policy", "workload.set_load", "evacuate_robots"),
        disallowed=("autonomous firefighting", "energized rack repair", "unsafe close-up robot camera"),
    ),
    "CR-06": _base(
        sid="CR-06", severity="SEVERE", label="Multi-row fouling and starvation",
        goal="Localize common hydraulic restriction and verify flow recovery instead of accepting a timed success message.",
        seed=12006, required=("strainer_02", "p_hs_b", "p_hs_c", "p_hs_d"), tools=("basket", "brush", "camera"),
        faults=(FaultOp("strainer_blockage", "strainer_02", 240, {"omax": 0.78, "tau_s": 80}),),
        status="READY", allowed=("inspect", "replace_strainer", "workload.set_load"),
    ),
    "CR-07": _base(
        sid="CR-07", severity="SEVERE", label="Stuck valve and misleading telemetry cascade",
        goal="Prove the verifier rejects premature success from a biased sensor.",
        seed=12007, required=("valve_a1", "sn_flow_trunk", "rack_a1"), tools=("valve actuator", "calibration kit", "camera"),
        faults=(FaultOp("valve_stuck", "valve_a1", 240, {"opening": 0.12}), FaultOp("sensor_drift", "sn_flow_trunk", 260, {"rate": 0.01, "cap": 0.55})),
        status="READY", allowed=("inspect", "service_valve", "recalibrate_sensor"),
    ),
    "MD-01": _base(
        sid="MD-01", severity="MODERATE", label="Single-rack strainer restriction",
        goal="Moderate service degradation with a safe, serviceable cartridge path.",
        seed=22001, required=("strainer_02", "rack_e5"), tools=("basket", "camera"),
        faults=(FaultOp("strainer_blockage", "strainer_02", 240, {"omax": 0.48, "tau_s": 120}),),
        status="READY", allowed=("inspect", "replace_strainer"),
    ),
    "MD-02": _base(
        sid="MD-02", severity="MODERATE", label="Temperature-sensor drift",
        goal="Classify a false positive without unnecessary repair.",
        seed=22002, required=("sn_flow_trunk", "rack_b1"), tools=("calibration kit", "camera"),
        faults=(FaultOp("sensor_drift", "sn_flow_trunk", 240, {"rate": 0.009, "cap": 0.45}),),
        status="READY", allowed=("inspect", "recalibrate_sensor"),
    ),
}


def get_definition(scenario_id: str) -> ScenarioDefinition:
    try:
        return SCENARIOS[scenario_id]
    except KeyError as exc:
        raise KeyError(f"unknown V8 scenario {scenario_id!r}") from exc


def list_definitions() -> list[ScenarioDefinition]:
    return [SCENARIOS[i] for i in ORDER]


def validate_definition(d: ScenarioDefinition, topology: Json | None) -> Json:
    missing: list[str] = []
    if topology is not None:
        ids = {a["id"] for a in topology.get("assets", [])} | {e["id"] for e in topology.get("edges", [])}
        missing = [a for a in d.required_assets if a not in ids]
    unsupported = [asdict(f) for f in d.fault_injections if f.capability == "unsupported"]
    status = d.supported_status
    if missing:
        status = "BLOCKED"
    elif unsupported and status == "READY":
        status = "BLOCKED"
    return {
        "status": status,
        "duration_sim_s": d.duration_sim_s,
        "missing_assets": missing,
        "unsupported_faults": unsupported,
        "ready": status == "READY",
        "notes": list(d.implementation_notes),
    }

