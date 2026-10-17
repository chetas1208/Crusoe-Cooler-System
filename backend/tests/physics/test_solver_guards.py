"""Solver nonconvergence is detected, flagged degraded, and never corrupts state."""
import math

import pandapipes as pp
import pytest
from pandapipes.pf.pipeflow_setup import PipeflowNotConverged

from conftest import make_plant, run
from loopkeeper.physics.adapters import hydraulics_pandapipes as hp


def test_real_pandapipes_nonconvergence_detected():
    p = make_plant()
    run(p, 5)
    good = p.truth()["rack_flow_kg_s"]
    for net in p.hydraulics.nets.values():       # starve the Newton iteration -> genuine pandapipes failure
        net.solver = {**net.solver, "max_iter": 1, "tol": 1e-25, "alpha_sequence": [1.0]}
    p.apply({"kind": "set_pump_speed", "target_id": "pump_t1", "args": {"speed": 0.6}})
    run(p, 2)
    sh = p.solver_health()
    assert sh["converged"] is False and sh["degraded"] is True and "hydraulic solve failed" in sh["reason"]
    assert p.world()["sim_status"] == "degraded"
    assert p.truth()["rack_flow_kg_s"] == pytest.approx(good, rel=1e-4)  # last valid state held, not garbage
    run(p, 30)                                               # thermal keeps stepping, finite
    assert all(math.isfinite(v) for v in p.truth()["chip_c"].values())
    for net in p.hydraulics.nets.values():                   # recovery once the solver is healthy again
        net.solver = {"max_iter": 100, "tol": 1e-5, "alpha_sequence": [1.0, 0.6, 0.35]}
    run(p, 10)
    assert p.solver_health()["converged"] is True and p.solver_health()["degraded"] is False
    assert p.truth()["rack_flow_kg_s"]["a1"] < good["a1"]


def test_injected_solver_exception_is_degraded_not_crash(monkeypatch):
    p = make_plant()
    run(p, 2)

    def boom(*a, **k):
        raise PipeflowNotConverged("forced")
    monkeypatch.setattr(hp.pp, "pipeflow", boom)
    p.apply({"kind": "set_valve", "target_id": "valve_b1", "args": {"opening": 0.4}})
    run(p, 1)
    sh = p.solver_health()
    assert sh["degraded"] and not sh["converged"] and sh["residual"] is None
    monkeypatch.undo()
    run(p, 6)
    assert p.solver_health()["converged"]


def test_thermal_guard_flags_runaway():
    p = make_plant()
    p.apply({"kind": "trip_pump", "target_id": "pump_t1"})
    p.apply({"kind": "set_load_factor", "target_id": "rack_a1", "args": {"factor": 1.5}})
    run(p, 2400)
    # stagnant coolant at full load runs away: guard clamps, plant stays finite and says so
    assert all(math.isfinite(v) for v in p.truth()["chip_c"].values())
    assert p.solver_health()["degraded"] is True and "thermal guard" in p.solver_health()["reason"]
