"""Steady-state heat balance and the causal chain: smaller bore -> lower flow -> less thermal margin."""
import pytest

from conftest import make_plant, run


def test_steady_state_heat_balance():
    p = make_plant()
    run(p, 900)
    e = p.energy_balance()
    assert e["rack_coolant_w"] == pytest.approx(e["it_w"], rel=0.01)      # rack heat reaches the TCS coolant
    assert e["cdu_w"] == pytest.approx(e["it_w"], rel=0.01)               # ... crosses the CDU
    assert e["fws_w"] == pytest.approx(e["it_w"], rel=0.01)               # ... and leaves with the FWS
    # sensible-heat identity on the TCS side: Q = m cp dT
    t = p.truth()
    q = t["tcs_flow_kg_s"] * p.thermal.cp_t * (t["tcs_return_c"] - t["tcs_supply_c"])
    assert q == pytest.approx(e["it_w"], rel=0.02)
    # the return header is the flow-weighted mix of every rack outlet (instrumented + aux)
    m = {r: p.hyd.rack_q[r] for r in p.all_racks}
    mix = sum(m[r] * p.thermal.rack[r].t_out_c for r in p.all_racks) / sum(m.values())
    assert abs(mix - p.thermal.t_return) < 1.5


def test_reduced_bore_lowers_flow_and_thermal_margin():
    healthy = make_plant()
    fouled = make_plant()
    assert fouled.apply({"kind": "inject_fault", "args": {"kind": "fouling", "target": "p_17", "params": {"omax": 0.78, "tau_s": 40}}})["ok"]
    run(healthy, 900)
    run(fouled, 900)
    h, f = healthy.truth(), fouled.truth()
    assert f["rack_flow_kg_s"]["b1"] < 0.8 * h["rack_flow_kg_s"]["b1"]            # lower flow in the fouled zone
    assert f["margin_k"]["b1"] < h["margin_k"]["b1"] - 4.0                        # ... reduced thermal margin
    assert f["margin_k"]["a1"] >= h["margin_k"]["a1"] - 1.0                       # unaffected zone barely moves
    # status colours are physics-derived
    a = fouled.assets()
    assert a["p_17"]["status"] in ("warning", "critical") and a["p_17"]["fault"]["occlusion"] > 0.7
    assert healthy.assets()["p_17"]["status"] == "nominal"
    # restoring bore restores flow and margin (same physics, not a scripted number)
    fouled.apply({"kind": "replace_section", "target_id": "p_17"})
    run(fouled, 900)
    assert fouled.truth()["margin_k"]["b1"] == pytest.approx(h["margin_k"]["b1"], abs=1.0)


def test_no_temperature_drop_when_restriction_added():
    p = make_plant()
    run(p, 300)
    before = p.truth()["chip_c"]["b1"]
    p.apply({"kind": "inject_fault", "args": {"kind": "fouling", "target": "p_17", "params": {"omax": 0.7, "tau_s": 30}}})
    run(p, 600)
    assert p.truth()["chip_c"]["b1"] >= before - 0.2


def test_predict_steady_matches_dynamic_end_state():
    p = make_plant()
    run(p, 1200)
    pred = p.predict_steady(remove_faults=False)
    t = p.truth()
    for r in p.racks:
        assert pred["racks"][r]["chip_c"] == pytest.approx(t["chip_c"][r], abs=0.7)


def test_facility_wide_steady_design_point(plant):
    a = plant.assets()
    for r in ("a1", "a2", "b1", "b2"):
        chip = a[f"rack_{r}"]["readings"]["t_chip_c"]
        assert 68 < chip < 77 and a[f"rack_{r}"]["status"] == "nominal"
    assert 6.0 < a["cdu_01"]["readings"]["approach_k"] < 7.4
