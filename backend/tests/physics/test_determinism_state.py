"""Same seed + commands => same hash; get_state/set_state continues identically."""
import json

import pytest

from conftest import make_plant, run

SCRIPT = [
    (20, {"kind": "inject_fault", "args": {"kind": "fouling", "target": "p_12", "params": {"omax": 0.7, "tau_s": 50}}}),
    (60, {"kind": "set_valve", "target_id": "valve_b1", "args": {"opening": 0.5}}),
    (100, {"kind": "inject_fault", "args": {"kind": "sensor_drift", "target": "sn_flow_za"}}),
    (140, {"kind": "brush_clear", "target_id": "p_12", "args": {"removed_fraction": 0.6}}),
]


def drive(p, until_s, start_s=0.0):
    for i in range(int(start_s / 0.5), int(until_s / 0.5)):
        t = i * 0.5
        for at, cmd in SCRIPT:
            if abs(t - at) < 1e-9:
                p.apply(cmd)
        p.step(0.5)


def test_same_seed_same_commands_same_hash():
    a, b, c = make_plant(5, steady_load=False, faults=True), make_plant(5, steady_load=False, faults=True), make_plant(6, steady_load=False, faults=True)
    for p in (a, b, c):
        drive(p, 200)
    assert a.state_hash() == b.state_hash()
    assert a.state_hash() != c.state_hash()
    assert a.get_state() == b.get_state()


def test_command_order_matters():
    a, b = make_plant(), make_plant()
    a.apply({"kind": "set_valve", "target_id": "valve_a1", "args": {"opening": 0.4}}); a.step(0.5)
    b.step(0.5); b.apply({"kind": "set_valve", "target_id": "valve_a1", "args": {"opening": 0.4}})
    run(a, 5); run(b, 5)
    assert a.state_hash() != b.state_hash()


def test_state_roundtrip_continues_identically():
    a = make_plant(11, steady_load=False, faults=True)
    drive(a, 90)
    blob = a.get_state()
    assert json.loads(blob)["rng"]["sensor"]["bit_generator"] == "PCG64"
    b = make_plant(11, steady_load=False, faults=True)
    b.set_state(blob)
    assert b.state_hash() == a.state_hash()
    drive(a, 250, start_s=90)
    drive(b, 250, start_s=90)
    assert a.state_hash() == b.state_hash()
    assert a.assets() == b.assets() and a.truth() == b.truth()


def test_set_state_rejects_foreign_or_garbage_blob():
    p = make_plant()
    with pytest.raises(ValueError):
        p.set_state(b"not json")
    bad = json.loads(p.get_state())
    bad["topology_hash"] = "deadbeef"
    with pytest.raises(ValueError):
        p.set_state(json.dumps(bad).encode())
    bad = json.loads(p.get_state())
    bad["schema"] = 999
    with pytest.raises(ValueError):
        p.set_state(json.dumps(bad).encode())


def test_reads_do_not_perturb_state():
    a, b = make_plant(), make_plant()
    run(a, 30); run(b, 30)
    for _ in range(5):
        a.assets(); a.world(); a.topology(); a.solver_health(); a.truth(); a.state_hash()
    run(a, 30); run(b, 30)
    assert a.state_hash() == b.state_hash()


def test_dt_chunking_invariance_of_substepping():
    a, b = make_plant(), make_plant()
    for _ in range(20): a.step(1.0)
    for _ in range(40): b.step(0.5)
    assert a.truth()["chip_c"] == b.truth()["chip_c"]
