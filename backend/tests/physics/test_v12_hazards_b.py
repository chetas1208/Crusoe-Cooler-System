"""V12 hazards B: CR-02 manifold leak, CR-04 power failure / load shedding, CR-05 rack thermal runaway / smoke containment.

Real solver consequences (pandapipes leak boundary, CompOpt heat), converge-or-degraded honesty, containment/repair
semantics, determinism and state round-trip. Runs on the legacy two-zone hall (zones a/b, headers p_12/p_17).
"""
import json
import math

import pytest

from conftest import make_plant, run
from loopkeeper.physics.hazards import HAZARD_KINDS
from loopkeeper.physics.hydraulics import LEAK_CD, P_ATM_BAR

HDR, ZV = "p_17", "valve_zb"            # zone b supply header and its zone valve
B_RACKS = ("b1", "b2")


def inject(p, kind, target=None, **params):
    return p.apply({"kind": "test.inject_fault", "args": {"kind": kind, "target": target, "params": params}})


def leak_plant(orifice=1e-4, **kw):
    p = make_plant(**kw)
    run(p, 20, 1.0)
    base = {r: p.hyd.rack_q[r] for r in p.all_racks}
    res = inject(p, "manifold_leak", HDR, orifice_m2=orifice)
    assert res["ok"], res
    run(p, 20, 1.0)
    return p, base


# ----------------------------------------------------------------------------------------------- registration
def test_kinds_registered_in_engine_schema():
    from loopkeeper.engine.schemas import InjectFault
    ok = {"manifold_leak": {"orifice_m2": 1e-4, "reserve_kg": 5}, "power_failure": {"racks": 1, "pumps": 0, "ups_runtime_s": 60, "restore_after_s": 10},
          "rack_thermal_runaway": {"initial_kw": 5, "growth_tau_s": 60, "max_kw": 100}}
    for k in HAZARD_KINDS:
        assert InjectFault(kind=k, params=ok[k]).kind == k
    assert set(HAZARD_KINDS) == {"manifold_leak", "power_failure", "rack_thermal_runaway"}


def test_bad_inputs_rejected_without_mutation():
    p = make_plant()
    h0 = p.state_hash()
    for kind, tgt, prm in [("manifold_leak", "p_22", {}), ("manifold_leak", HDR, {"orifice_m2": 1.0}), ("manifold_leak", HDR, {"orifice_m2": float("nan")}),
                           ("power_failure", "zone_q", {}), ("power_failure", "zone_a", {"racks": 0, "pumps": 0}),
                           ("power_failure", "zone_a", {"ups_runtime_s": -1}), ("rack_thermal_runaway", "rack_zz", {}),
                           ("rack_thermal_runaway", "rack_a1", {"initial_kw": 500})]:
        r = inject(p, kind, tgt, **prm)
        assert r["ok"] is False and r["reason"], (kind, tgt, prm, r)
    assert p.state_hash() == h0


def test_idle_plant_exposes_nothing_new():
    p = make_plant()
    run(p, 10, 1.0)
    a = p.world()["assets"]
    assert "leak_kg_s" not in a[HDR]["readings"] and "power_available" not in a["rack_a1"]["readings"]
    assert p.world()["hazard_zones"] == [] and set(p.world()["power_state"]) == set(p.power_sim.state.to_dict())


# ----------------------------------------------------------------------------------------------- CR-02 leak
def test_leak_real_solver_consequences_and_mass_balance():
    p, base = leak_plant(1e-4)
    h, t = p.hyd, p.truth()
    leak = h.leak_kg_s[HDR]
    assert leak > 0.5
    # orifice equation closes against the solved manifold pressure
    rho = p.hydraulics.nets["tcs"].rho
    expect = LEAK_CD * 1e-4 * math.sqrt(2 * rho * (h.leak_p_pa[HDR] - P_ATM_BAR * 1e5))
    assert leak == pytest.approx(expect, rel=0.02)
    # mass balance INCLUDING the leak: trunk = racks + leak; the expansion tank makes up exactly the leak; residual tiny
    assert h.mass_balance["tcs"] < 1e-6 and p.solver_health()["converged"]
    assert h.makeup_kg_s == pytest.approx(leak, rel=1e-6)
    rho_t = p.rho_loc("tcs")
    racks = sum(h.rack_q[r] for r in p.all_racks) * rho_t
    assert h.edge_q["p_10"] * rho_t == pytest.approx(racks + leak, rel=1e-3)
    # starvation in the leaking row, spared row less affected
    for r in B_RACKS:
        assert h.rack_q[r] < 0.97 * base[r]
    assert h.rack_q["a1"] > h.rack_q["b1"]
    assert t["leak_kg_s"][HDR] == pytest.approx(leak) and t["hazards"]["leaks"][HDR]["lost_kg"] > 0
    # measured consequences: leak fault on the edge, header meter disagrees with the rack meters beneath it
    a = p.world()["assets"]
    assert a[HDR]["fault"]["leak_kg_s"] == pytest.approx(leak, rel=0.05) and a[HDR]["status"] in ("warning", "critical")
    z = p.world()["hazard_zones"]
    assert z and z[0]["kind"] == "leak" and z[0]["status"] == "active" and z[0]["total_lost_kg"] > 0


def test_leak_scales_with_orifice():
    rates = []
    for a in (3e-5, 1e-4, 2.5e-4):
        p, _ = leak_plant(a)
        assert p.solver_health()["converged"] and p.hyd.mass_balance["tcs"] < 1e-6
        rates.append(p.hyd.leak_kg_s[HDR])
    assert rates[0] < rates[1] < rates[2]


@pytest.mark.parametrize("orifice,speed", [(1e-6, 1.0), (3e-4, 1.0), (3e-4, 0.5), (1.5e-4, 0.4)])
def test_converge_or_degraded_never_silent(orifice, speed):
    p = make_plant()
    p.apply({"kind": "set_pump_speed", "target_id": "pump_t1", "args": {"speed": speed}})
    assert inject(p, "manifold_leak", HDR, orifice_m2=orifice)["ok"]
    run(p, 30, 1.0)
    sh = p.solver_health()
    if sh["converged"]:
        assert sh["mass_balance"]["tcs"] < 1e-5 and sh["residual"] < 1e-3
        assert p.hyd.makeup_kg_s == pytest.approx(p.hyd.leak_kg_s[HDR], rel=1e-5)
    else:
        assert sh["degraded"] and "hydraulic solve failed" in sh["reason"]
        assert p.world()["sim_status"] == "degraded" and p.world()["health"]["solver"]["status"] == "failed"


def test_containment_after_isolation_and_never_self_repairs():
    p, _ = leak_plant(1e-4)
    live_lost = p.truth()["hazards"]["leaks"][HDR]["lost_kg"]
    assert p.apply({"kind": "isolate_valve", "target_id": ZV})["ok"]
    run(p, 5, 1.0)
    lost0 = p.truth()["hazards"]["leaks"][HDR]["lost_kg"]
    run(p, 600, 1.0)
    t = p.truth()
    assert t["leak_kg_s"][HDR] == 0.0 and t["tcs_makeup_kg_s"] == pytest.approx(0.0, abs=1e-9)
    assert t["hazards"]["leaks"][HDR]["lost_kg"] == pytest.approx(lost0)          # no further loss
    assert lost0 > live_lost * 0.99
    lk = t["hazards"]["leaks"][HDR]
    assert lk["contained"] is True and lk["repaired"] is False                    # contained is NOT repaired, ever, by itself
    z = p.world()["hazard_zones"]
    assert z[0]["status"] == "contained" and z[0]["rate_kg_s"] == 0.0
    assert p.solver_health()["converged"] and p.hyd.mass_balance["tcs"] < 1e-6


def test_repair_needs_isolation_and_brushing_never_fixes():
    p, _ = leak_plant(1e-4)
    before = p.hyd.leak_kg_s[HDR]
    for cmd in ({"kind": "brush_clear", "target_id": HDR, "args": {"removed_fraction": 1.0}},
                {"kind": "replace_section", "target_id": HDR}):
        r = p.apply(cmd)
        assert r["ok"] is False and ("isolate" in r["reason"] or "brushing" in r["reason"]), r
    run(p, 10, 1.0)
    assert p.hyd.leak_kg_s[HDR] == pytest.approx(before, rel=0.05) and p.truth()["hazards"]["leaks"][HDR]["repaired"] is False
    assert p.apply({"kind": "isolate_valve", "target_id": ZV})["ok"]
    assert p.apply({"kind": "brush_clear", "target_id": HDR, "args": {"removed_fraction": 1.0}})["ok"] is False   # still not a repair
    # reopening before the repair re-pressurises the leak (truthful, not a fix)
    p.apply({"kind": "reopen_valve", "target_id": ZV})
    run(p, 10, 1.0)
    assert p.hyd.leak_kg_s[HDR] > 0.5
    p.apply({"kind": "isolate_valve", "target_id": ZV})
    run(p, 5, 1.0)
    r = p.apply({"kind": "replace_section", "target_id": HDR})
    assert r["ok"] and r["effects"]["leak_repaired"] == f"mleak_{HDR}"
    p.apply({"kind": "reopen_valve", "target_id": ZV})
    run(p, 30, 1.0)
    t = p.truth()
    assert t["leak_kg_s"][HDR] == 0.0 and t["hazards"]["leaks"][HDR]["repaired"] is True
    assert p.world()["hazard_zones"] == [] and p.solver_health()["converged"]
    assert p.hyd.rack_q["b1"] == pytest.approx(p.ref.rack_q["b1"], rel=0.02)     # flow recovered


def test_unisolated_leak_drains_make_up_tank_and_pumps_lose_suction():
    p = make_plant()
    assert inject(p, "manifold_leak", HDR, orifice_m2=2.5e-4, reserve_kg=40.0)["ok"]
    run(p, 120, 1.0)
    t = p.truth()
    assert t["hazards"]["leaks"][HDR]["tank_empty"] is True
    assert t["tcs_flow_kg_s"] == 0.0 and not p.pump_running("pump_t1")
    assert p.solver_health()["converged"]                                            # zero flow is solved honestly, not faked
    chip0 = t["chip_c"]["a1"]
    run(p, 120, 1.0)
    assert p.truth()["chip_c"]["a1"] > chip0 + 20                                  # cooling lost -> real thermal consequence
    assert p.apply({"kind": "isolate_valve", "target_id": ZV})["ok"] and p.apply({"kind": "replace_section", "target_id": HDR})["ok"]
    p.apply({"kind": "reopen_valve", "target_id": ZV})
    run(p, 20, 1.0)
    assert p.pump_running("pump_t1") and p.truth()["tcs_flow_kg_s"] > 1.0


# ----------------------------------------------------------------------------------------------- CR-04 power
def test_row_power_failure_ups_trip_and_load_shedding_extends_runtime():
    def trip_time(shed: bool) -> float:
        p = make_plant()
        run(p, 10, 1.0)
        t0 = p.time
        assert inject(p, "power_failure", "zone_a", ups_runtime_s=60.0, restore_after_s=10000.0)["ok"]
        run(p, 5, 1.0)
        if shed:                         # operator sheds the GPU racks after the failure; UPS energy was sized at the injection load
            for r in ("a1", "a2"):
                assert p.apply({"kind": "set_load_factor", "target_id": f"rack_{r}", "args": {"factor": 0.1}})["ok"]
        a = p.world()["assets"]["rack_a1"]
        assert a["readings"]["power_available"] == 1.0 and a["readings"]["power_kw"] > 0 and a["status"] in ("warning", "nominal", "watch", "critical", "isolated")
        d = p.hazards.power["row_a"]
        while not d["tripped"] and p.time - t0 < 3000:
            p.step(1.0)
        assert d["tripped"]
        assert p.load_w("a1") == 0.0 and p.load_w("a3") == 0.0 and p.load_w("b1") > 0                  # row lost power, other row did not
        run(p, 2, 1.0)
        assert p.world()["assets"]["rack_a1"]["status"] == "offline" and p.world()["assets"]["rack_a1"]["readings"]["power_available"] == 0.0
        return p.time - t0
    plain, shed = trip_time(False), trip_time(True)
    assert 40 < plain < 90          # ~ups_runtime_s at the injection load, drained by the actual IT power
    assert shed > plain * 1.2       # shedding load buys time on the UPS


def test_power_restore_is_explicit_gated_and_never_automatic():
    p = make_plant()
    run(p, 10, 1.0)
    assert inject(p, "power_failure", "zone_a", ups_runtime_s=20.0, restore_after_s=120.0)["ok"]
    assert inject(p, "power_failure", "zone_a")["ok"] is False                           # already failed
    run(p, 60, 1.0)
    r = p.apply({"kind": "restore_power", "target_id": "zone_a"})
    assert r["ok"] is False and "ETA" in r["reason"]
    run(p, 3000, 1.0)                                                                       # supply long available: still down until commanded
    assert p.hazards.power["row_a"]["restored"] is False and p.load_w("a1") == 0.0
    assert p.world()["power_state"]["row_feeds"]["a"]["supply_available"] is True
    assert p.apply({"kind": "restore_power", "target_id": "zone_a"})["ok"]
    run(p, 20, 1.0)
    assert 0.0 < p.load_w("a1") < p._load_w_raw("a1")                                      # soft start
    run(p, 120, 1.0)
    assert p.load_w("a1") == pytest.approx(p._load_w_raw("a1"))
    assert p.apply({"kind": "restore_power", "target_id": "zone_a"})["ok"] is False        # nothing left to restore


def test_pump_feed_loss_heats_racks_and_standby_pumps_recover():
    p = make_plant()
    run(p, 20, 1.0)
    chip0 = p.truth()["chip_c"]["a1"]
    assert inject(p, "power_failure", "feed_a", restore_after_s=10000.0)["ok"]
    run(p, 30, 1.0)
    t = p.truth()
    assert t["tcs_flow_kg_s"] == 0.0 and t["fws_flow_kg_s"] == 0.0
    assert not p.pump_running("pump_t1") and p.world()["assets"]["pump_t1"]["status"] == "offline"
    assert p.world()["power_state"]["primary_pumps_powered"] is False
    run(p, 60, 1.0)
    assert p.truth()["chip_c"]["a1"] > chip0 + 8                                            # racks still dissipate, no flow
    assert p.load_w("a1") > 0                                                                # racks themselves still powered
    for pid in ("pump_t2", "pump_f2"):
        assert p.apply({"kind": "switch_duty", "target_id": pid})["ok"]                  # feed B pumps are the mitigation
    run(p, 120, 1.0)
    assert p.pump_running("pump_t2") and p.truth()["tcs_flow_kg_s"] > 1.0
    assert p.truth()["chip_c"]["a1"] < chip0 + 8 + 40
    assert p.hazards.power["feed_a"]["restored"] is False                                  # mitigated, never auto-restored


# ----------------------------------------------------------------------------------------------- CR-05 runaway
def runaway_plant(**prm):
    p = make_plant()
    run(p, 20, 1.0)
    assert inject(p, "rack_thermal_runaway", "rack_a1", **prm)["ok"]
    return p


def test_runaway_detect_then_limit_exceeded_when_nobody_acts():
    p = runaway_plant()
    limit = p.topo["limits"]["chip_limit_c"]
    rn = p.hazards.runaways["a1"]
    t_limit = None
    for _ in range(600):
        p.step(1.0)
        if t_limit is None and p.truth()["chip_c"]["a1"] > limit:
            t_limit = p.time
            break
    assert t_limit is not None, "temperature must rise beyond the chip limit when the rack is left energised"
    assert rn["detected_at"] is not None and rn["detected_at"] < t_limit - 20          # smoke alarm gives a usable window
    z = [x for x in p.world()["hazard_zones"] if x["kind"] == "smoke"][0]
    assert z["status"] == "active" and z["alarm_sounding"] and z["prohibit_robot_entry"] is True
    assert z["autonomous_firefighting"] is False and z["supported_outcomes"] == ["detect", "depower", "contain", "escalate"]
    assert p.world()["assets"]["rack_a1"]["status"] == "critical"
    assert p.world()["assets"]["rack_a1"]["readings"]["smoke_obscuration_pct_m"] > 1.0
    esc = p.apply({"kind": "escalate_hazard", "target_id": "rack_a1"})
    assert esc["ok"] and "no suppression" in esc["effects"]["note"]
    assert p.hazards.runaways["a1"]["escalated_at"] is not None
    assert p.apply({"kind": "escalate_hazard", "target_id": "rack_b1"})["ok"] is False


def test_depower_stops_heat_contains_and_nothing_repairs_itself():
    p = runaway_plant()
    for _ in range(200):
        p.step(1.0)
    rn = p.hazards.runaways["a1"]
    kw_before = rn["kw"]
    assert kw_before > 30 and rn["contained_at"] is None
    q_before = p.energy_balance()["it_w"]
    r = p.apply({"kind": "depower_rack", "target_id": "rack_a1"})
    assert r["ok"] and r["effects"]["thermal_event"] is True
    p.step(1.0)
    assert p.load_w("a1") == 0.0 and p.energy_balance()["it_w"] < q_before - 100e3 * 0.9   # IT power gone immediately
    run(p, 600, 1.0)
    assert rn["kw"] < 1.0 and rn["contained_at"] is not None
    assert p.truth()["chip_c"]["a1"] < p.topo["limits"]["chip_limit_c"] - 20
    assert rn["serviced"] is False                                                           # contained is not repaired
    zone = [x for x in p.world()["hazard_zones"] if x["kind"] == "smoke"][0]
    assert zone["status"] == "contained" and zone["prohibit_robot_entry"] is True
    assert p.world()["assets"]["rack_a1"]["status"] == "offline"
    run(p, 3000, 1.0)
    assert rn["serviced"] is False and p.load_w("a1") == 0.0                                 # never serviced / re-energised by itself
    # re-energising an unserviced faulted rack is refused; service only when de-energised, cold and source gone
    assert p.apply({"kind": "restore_rack_power", "target_id": "rack_a1"})["ok"] is False
    assert p.apply({"kind": "service_rack_power", "target_id": "rack_a1"})["ok"]
    assert p.apply({"kind": "restore_rack_power", "target_id": "rack_a1"})["ok"]
    run(p, 120, 1.0)
    assert p.load_w("a1") > 50e3 and not [x for x in p.world()["hazard_zones"] if x["kind"] == "smoke"]


def test_service_refused_while_energised_or_hot():
    p = runaway_plant()
    run(p, 60, 1.0)
    r = p.apply({"kind": "service_rack_power", "target_id": "rack_a1"})
    assert r["ok"] is False and "depower" in r["reason"]
    p.apply({"kind": "depower_rack", "target_id": "rack_a1"})
    run(p, 5, 1.0)
    r = p.apply({"kind": "service_rack_power", "target_id": "rack_a1"})
    assert r["ok"] is False and ("heat source" in r["reason"] or "hot" in r["reason"])


def test_row_power_loss_also_removes_runaway_source():
    p = runaway_plant()
    run(p, 100, 1.0)
    assert inject(p, "power_failure", "zone_a", ups_runtime_s=1.0, restore_after_s=10000.0)["ok"]
    run(p, 300, 1.0)
    assert p.hazards.runaways["a1"]["kw"] < 2.0 and p.hazards.runaways["a1"]["serviced"] is False


# ----------------------------------------------------------------------------------------------- determinism / state
def script_drive(p, until_s, start_s=0.0):
    script = [(10, {"kind": "test.inject_fault", "args": {"kind": "manifold_leak", "target": HDR, "params": {"orifice_m2": 8e-5}}}),
              (40, {"kind": "test.inject_fault", "args": {"kind": "rack_thermal_runaway", "target": "rack_a2"}}),
              (60, {"kind": "test.inject_fault", "args": {"kind": "power_failure", "target": "zone_b", "params": {"ups_runtime_s": 40, "pumps": 1}}}),
              (90, {"kind": "isolate_valve", "target_id": ZV}),
              (120, {"kind": "depower_rack", "target_id": "rack_a2"}),
              (150, {"kind": "switch_duty", "target_id": "pump_t2"}),
              (200, {"kind": "replace_section", "target_id": HDR})]
    for i in range(int(start_s), int(until_s)):
        for at, cmd in script:
            if at == i:
                p.apply(cmd)
        p.step(1.0)


def test_determinism_and_state_roundtrip_with_hazards():
    a, b = make_plant(7, steady_load=False), make_plant(7, steady_load=False)
    script_drive(a, 260)
    script_drive(b, 260)
    assert a.state_hash() == b.state_hash() and a.get_state() == b.get_state()
    st = json.loads(a.get_state())
    assert st["hazards"]["leaks"][HDR]["repaired"] is True and st["hazards"]["runaways"]["a2"]["depowered_at"] is not None
    assert st["hazards"]["power"]["row_b"]["tripped"] is True
    # snapshot mid-run (all three hazards live), restore into a fresh plant, both continue identically
    c = make_plant(7, steady_load=False)
    script_drive(c, 100)
    blob = c.get_state()
    d = make_plant(7, steady_load=False)
    d.set_state(blob)
    assert d.state_hash() == c.state_hash()
    script_drive(c, 260, start_s=100)
    script_drive(d, 260, start_s=100)
    assert c.state_hash() == d.state_hash() == a.state_hash()
    assert c.world()["hazard_zones"] == d.world()["hazard_zones"] and c.world()["power_state"] == d.world()["power_state"]


def test_old_state_blob_without_hazards_loads():
    a = make_plant(3)
    run(a, 5, 1.0)
    st = json.loads(a.get_state())
    st.pop("hazards")
    for k in ("leak_kg_s", "makeup_kg_s"):
        for hk in ("hyd", "ref"):
            st[hk].pop(k, None)
    for hk in ("leak_p_pa",):
        st["hyd"].pop(hk, None), st["ref"].pop(hk, None)
    b = make_plant(3)
    b.set_state(json.dumps(st).encode())
    run(b, 5, 1.0)
    assert not b.hazards.active
