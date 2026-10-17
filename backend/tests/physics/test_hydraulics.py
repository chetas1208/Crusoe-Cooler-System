"""Mass conservation, causal hydraulics (diameter, valve, pump)."""
import pytest

from conftest import make_plant, run
from loopkeeper.physics.adapters.hydraulics_pandapipes import PipeNetwork

SV = {"max_iter": 100, "tol": 1e-5, "alpha_sequence": [1.0, 0.6, 0.35]}


def test_design_point_matches_reference_simulator(plant):
    t = plant.truth()
    assert t["tcs_flow_kg_s"] == pytest.approx(8.1, rel=0.03)      # TS reference (16-rack hall): 8.1 kg/s
    assert t["fws_flow_kg_s"] == pytest.approx(13.0, rel=0.03)     # TS reference: 13.0 kg/s
    assert all(1.4 < v < 1.6 for v in t["rack_flow_kg_s"].values())      # instrumented GPU racks
    assert all(0.08 < v < 0.3 for v in t["aux_flow_kg_s"].values())      # lighter network / storage / CPU racks


def test_mass_conservation_per_loop(plant):
    run(plant, 60)
    t = plant.truth()
    h = plant.hyd
    # closed loops: nothing leaves through the pressure reference, splits sum to trunk
    assert all(abs(v) < 1e-9 for v in t["ext_grid_kg_s"].values())
    assert t["mass_balance"]["tcs"] < 1e-9 and t["mass_balance"]["fws"] < 1e-9
    assert sum(t["rack_flow_kg_s"].values()) + sum(t["aux_flow_kg_s"].values()) == pytest.approx(t["tcs_flow_kg_s"], rel=1e-6)
    assert h.zone_q["a"] + h.zone_q["b"] == pytest.approx(h.q["tcs"], rel=1e-6)
    # also with an asymmetric network state (stuck valve + isolated rack)
    plant.apply({"kind": "set_valve", "target_id": "valve_a1", "args": {"opening": 0.3}})
    plant.apply({"kind": "isolate_valve", "target_id": "valve_b2"})
    run(plant, 5)
    t = plant.truth()
    assert t["rack_flow_kg_s"]["b2"] == 0.0
    assert t["mass_balance"]["tcs"] < 1e-9 and abs(t["ext_grid_kg_s"]["tcs"]) < 1e-9


def test_reduced_pipe_diameter_lowers_flow_adapter_level():
    def flow(d_mm):
        n = PipeNetwork("t", 997., 8e-4, 4180., SV, 0.045)
        n.add_pump("p", "j0", "j1", 2.5e5)
        n.add_pipe("a", "j1", "j2", 10, 100, 40.0)
        n.add_pipe("b", "j2", "j0", 10, d_mm, 0.0)
        n.set_ext_grid("j0")
        r = n.solve()
        assert r.converged
        return r.mdot["b"]
    assert flow(60) < flow(100)


def test_valve_close_reduces_branch_flow(plant):
    base = plant.truth()["rack_flow_kg_s"]
    plant.apply({"kind": "set_valve", "target_id": "valve_a1", "args": {"opening": 0.25}})
    run(plant, 2)
    after = plant.truth()["rack_flow_kg_s"]
    assert after["a1"] < 0.75 * base["a1"]
    assert after["b1"] > base["b1"]                       # flow redistributes to the other branches
    plant.apply({"kind": "isolate_valve", "target_id": "valve_za"})
    run(plant, 2)
    z = plant.truth()["rack_flow_kg_s"]
    assert z["a1"] == 0.0 and z["a2"] == 0.0 and z["b1"] > base["b1"]


def test_stuck_valve_ignores_command(plant):
    plant.apply({"kind": "inject_fault", "args": {"kind": "valve_stuck", "target": "valve_b1", "params": {"opening": 0.15}}})
    run(plant, 2)
    plant.apply({"kind": "set_valve", "target_id": "valve_b1", "args": {"opening": 1.0}})
    run(plant, 2)
    f = plant.truth()["rack_flow_kg_s"]
    assert f["b1"] < 0.7 * f["b2"]
    a = plant.assets()["valve_b1"]
    assert a["fault"]["opening"] == pytest.approx(0.15) and a["fault"]["commanded_opening"] == pytest.approx(1.0)
    assert plant.apply({"kind": "service_valve", "target_id": "valve_b1"})["ok"]
    run(plant, 2)
    assert plant.truth()["rack_flow_kg_s"]["b1"] > 1.4


def test_hydraulics_resolved_only_on_change(plant):
    n0 = plant.solve_count
    run(plant, 120)
    assert plant.solve_count == n0                       # nothing changed -> no re-solve
    plant.apply({"kind": "set_pump_speed", "target_id": "pump_t1", "args": {"speed": 0.8}})
    run(plant, 1)
    assert plant.solve_count == n0 + 1
