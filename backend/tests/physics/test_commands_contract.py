"""apply() validation (fail closed, no mass assignment) and WorldSnapshot/AssetState shapes."""
import json

import pytest

from conftest import make_plant, run
from loopkeeper.physics import COMMAND_KINDS

STATUSES = {"nominal", "watch", "warning", "critical", "offline", "isolated", "service"}


@pytest.mark.parametrize("cmd", [
    None, [], "x", {}, {"kind": 5}, {"kind": "rm -rf"}, {"kind": "set_valve"},
    {"kind": "set_valve", "target_id": "valve_zz", "args": {"opening": 0.5}},
    {"kind": "set_valve", "target_id": "valve_a1", "args": {"opening": 5}},
    {"kind": "set_valve", "target_id": "valve_a1", "args": {"opening": True}},
    {"kind": "set_valve", "target_id": "valve_a1", "args": {"opening": float("nan")}},
    {"kind": "set_valve", "target_id": "valve_a1", "args": {"opening": 0.5, "health": 0}},          # mass assignment
    {"kind": "set_valve", "target_id": "x" * 500, "args": {"opening": 0.5}},
    {"kind": "set_pump_speed", "target_id": "pump_t1", "args": {"speed": 0.0}},
    {"kind": "set_load_factor", "target_id": "rack_a1", "args": {"factor": -1}},
    {"kind": "inject_fault", "args": {"kind": "fouling", "target": "p_13"}},                       # DN40 not serviceable
    {"kind": "inject_fault", "args": {"kind": "nonsense"}},
    {"kind": "inject_fault", "args": {"kind": "fouling", "target": "p_12", "params": {"omax": 7}}},
    {"kind": "brush_clear", "target_id": "valve_a1", "args": {"removed_fraction": 0.5}},
    {"kind": "trip_pump", "target_id": "pump_t1", "args": "oops"},
])
def test_bad_commands_rejected_without_state_change(cmd):
    p = make_plant()
    h = p.state_hash()
    r = p.apply(cmd)
    assert r["ok"] is False and isinstance(r["reason"], str) and r["effects"] == {}
    assert "Traceback" not in r["reason"] and "/home" not in r["reason"]
    assert p.state_hash() == h


def test_all_documented_kinds_registered():
    assert {"set_valve", "isolate_valve", "reopen_valve", "set_pump_speed", "switch_duty", "trip_pump", "brush_clear",
            "replace_section", "replace_strainer", "service_valve", "replace_pump", "recalibrate_sensor",
            "set_load_factor", "inject_fault", "test.inject_fault", "halt_fault", "set_chiller_setpoint"} <= set(COMMAND_KINDS)


def test_isolate_pump_marks_service_and_stops_flow():
    p = make_plant()
    assert p.apply({"kind": "isolate_valve", "target_id": "pump_t1"})["ok"]
    run(p, 3)
    assert p.assets()["pump_t1"]["status"] == "service" and p.truth()["tcs_flow_kg_s"] == 0.0
    assert p.apply({"kind": "reopen_valve", "target_id": "pump_t1"})["ok"]
    run(p, 3)
    assert p.truth()["tcs_flow_kg_s"] > 5


def test_world_and_assets_json_and_contract_shapes():
    p = make_plant()
    run(p, 10)
    w = p.world()
    json.dumps(w)                                                  # JSON-able
    assert {"facility_id", "sim_tick", "sim_time_s", "assets", "kpis", "health"} <= set(w)
    assert {"min_margin_k", "total_heat_kw", "tcs_flow_kg_s", "fws_flow_kg_s", "tcs_supply_c", "tcs_return_c"} <= set(w["kpis"])
    topo = p.topology()
    assert set(p.assets()) <= {a["id"] for a in topo["assets"]} | {e["id"] for e in topo["edges"]}
    for aid, a in p.assets().items():
        assert a["status"] in STATUSES, aid
        assert all(isinstance(v, (int, float)) for v in a["readings"].values())
    assert set(p.assets()) >= {a["id"] for a in topo["assets"] if a["type"] in ("rack", "pump", "valve", "strainer", "sensor", "cdu", "chiller")}
    sh = p.solver_health()
    assert sh["converged"] and not sh["degraded"] and sh["residual"] < 1e-6


def test_work_lock_via_isolation_marks_zone_isolated():
    p = make_plant()
    p.apply({"kind": "set_load_factor", "target_id": "rack_b1", "args": {"factor": 0.0}})
    p.apply({"kind": "set_load_factor", "target_id": "rack_b2", "args": {"factor": 0.0}})
    p.apply({"kind": "isolate_valve", "target_id": "valve_zb"})
    run(p, 30)
    a = p.assets()
    assert a["valve_zb"]["status"] == "isolated" and a["p_17"]["status"] == "isolated" and a["rack_b1"]["status"] == "isolated"


def test_step_rejects_bad_dt():
    p = make_plant()
    for bad in (0, -1, float("nan"), float("inf"), 1e9, "1"):
        with pytest.raises(ValueError):
            p.step(bad)
