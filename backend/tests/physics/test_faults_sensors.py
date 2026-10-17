"""Faults: pump failure response, sensor drift is measured-only, aging, clearing, unsupported leak, validation."""
import pytest

from conftest import make_plant, run

PUMP_OK = {"kind": "inject_fault", "args": {"kind": "pump_degradation", "target": "pump_t1", "params": {"health_end": 0.2, "duration_s": 30}}}


def test_pump_trip_response_and_failover():
    p = make_plant()
    run(p, 300)
    base = p.truth()
    assert p.apply({"kind": "trip_pump", "target_id": "pump_t1"})["ok"]
    run(p, 400)
    t = p.truth()
    assert t["tcs_flow_kg_s"] == 0.0 and all(v == 0.0 for v in t["rack_flow_kg_s"].values())   # no head, no circulation
    assert all(t["chip_c"][r] > base["chip_c"][r] + 10 for r in p.racks)                       # racks heat up
    a = p.assets()
    assert a["pump_t1"]["status"] == "critical" and a["pump_t1"]["fault"]["health"] == 0.0
    assert a["rack_a1"]["status"] in ("warning", "critical")
    assert p.solver_health()["converged"] is True             # zero flow is a legitimate state, not a solver failure
    # operator switches duty to the standby pump -> flow and temperatures recover
    assert p.apply({"kind": "switch_duty", "target_id": "pump_t2"})["ok"]
    run(p, 900)
    t2 = p.truth()
    assert t2["tcs_flow_kg_s"] == pytest.approx(base["tcs_flow_kg_s"], rel=0.03)
    assert max(t2["chip_c"].values()) < max(t["chip_c"].values()) - 10


def test_pump_aging_lowers_head_and_flow():
    p = make_plant()
    base = p.truth()
    base_head = p.assets()["pump_t1"]["readings"]["head_kpa"]
    assert p.apply(PUMP_OK)["ok"]
    run(p, 120)
    t = p.truth()
    assert t["tcs_flow_kg_s"] < 0.9 * base["tcs_flow_kg_s"]
    a = p.assets()
    assert a["pump_t1"]["fault"]["health"] < 0.5 and a["pump_t1"]["readings"]["vibration_mm_s"] > 3.0
    assert a["pump_t1"]["readings"]["head_kpa"] < 0.8 * base_head
    assert p.apply({"kind": "replace_pump", "target_id": "pump_t1"})["ok"]
    run(p, 30)
    assert p.truth()["tcs_flow_kg_s"] == pytest.approx(base["tcs_flow_kg_s"], rel=0.02)


def test_sensor_drift_changes_measurement_not_truth():
    clean, drift = make_plant(), make_plant()
    assert drift.apply({"kind": "inject_fault", "args": {"kind": "sensor_drift", "target": "sn_flow_zb",
                                                         "params": {"rate": 0.05, "cap": 0.7}}})["ok"]
    run(clean, 300)
    run(drift, 300)
    tc, td = clean.truth(), drift.truth()
    for k in ("rack_flow_kg_s", "chip_c", "margin_k"):
        assert td[k] == tc[k]                                    # truth bit-identical
    assert td["tcs_supply_c"] == tc["tcs_supply_c"] and td["fws_out_c"] == tc["fws_out_c"]
    mc = clean.assets()["sn_flow_zb"]["readings"]["flow_kg_s"]
    md = drift.assets()["sn_flow_zb"]["readings"]["flow_kg_s"]
    assert abs(md - mc) > 0.4                                     # measured value is wrong ...
    assert drift.assets()["sn_flow_zb"].get("suspect") == ["flow_kg_s"]   # ... and flagged suspect via mass balance
    assert drift.assets()["sn_flow_zb"]["status"] in ("watch", "warning")
    assert all(drift.assets()[f"rack_{r}"]["status"] == "nominal" for r in drift.racks)
    drift.apply({"kind": "recalibrate_sensor", "target_id": "sn_flow_zb"})
    run(drift, 10)
    assert abs(drift.assets()["sn_flow_zb"]["readings"]["flow_kg_s"] - clean.assets()["sn_flow_zb"]["readings"]["flow_kg_s"]) < 0.3


def test_sensor_noise_is_bounded_and_seeded():
    p = make_plant()
    vals = []
    for _ in range(80):
        run(p, 2.0)
        vals.append(p.assets()["rack_a1"]["readings"]["t_chip_c"])
    truth = p.truth()["chip_c"]["a1"]
    assert max(abs(v - truth) for v in vals) < 3 * 0.06 + 0.2        # <= 3 sigma + slow drift of truth
    assert len(set(vals)) > 10                                      # noise actually present


def test_strainer_blockage_and_replacement():
    p = make_plant()
    base = p.truth()["tcs_flow_kg_s"]
    p.apply({"kind": "inject_fault", "args": {"kind": "strainer_blockage", "target": "strainer_02", "params": {"omax": 0.8, "tau_s": 20}}})
    run(p, 200)
    assert p.truth()["tcs_flow_kg_s"] < 0.9 * base
    assert p.assets()["strainer_02"]["status"] in ("warning", "critical")
    p.apply({"kind": "replace_strainer", "target_id": "strainer_02"})
    run(p, 20)
    assert p.truth()["tcs_flow_kg_s"] == pytest.approx(base, rel=0.02)


def test_brush_clear_partial_then_hard_scale():
    p = make_plant()
    p.apply({"kind": "inject_fault", "args": {"kind": "fouling", "target": "p_12", "params": {"omax": 0.75, "tau_s": 20}}})
    run(p, 200)
    before = p.faults.occl["p_12"]
    r = p.apply({"kind": "brush_clear", "target_id": "p_12", "args": {"removed_fraction": 0.5}})
    assert r["ok"] and p.faults.occl["p_12"] == pytest.approx(before * 0.5)


def test_leak_is_supported_in_v8():
    p = make_plant()
    r = p.apply({"kind": "inject_fault", "args": {"kind": "leak", "target": "p_12"}})
    assert r["ok"] is True and r["effects"]["fault"] == "leak"
    leak_id = r["effects"]["leak_id"]
    assert p.leak_sim.leaks[leak_id].active is True


def test_seeded_random_fault_arrivals_reproducible():
    a, b = make_plant(7, faults=True), make_plant(7, faults=True)
    a.fault_mgr.next_at = b.fault_mgr.next_at = 20.0
    run(a, 400)
    run(b, 400)
    assert a.fault_mgr.onsets and a.fault_mgr.onsets == b.fault_mgr.onsets
    assert a.state_hash() == b.state_hash()
