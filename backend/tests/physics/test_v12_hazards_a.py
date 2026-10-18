"""V12 hazards A (agent L1): CR-01 CDU circulation + backup-pump failure, CR-03 facility heat-rejection loss.

Truth-only assertions on the real plant (pandapipes hydraulics + CompOpt/eps-NTU thermal): solver converges or reports
degraded honestly, mass/energy balance, margin trend, failed repair does not heal, determinism, state roundtrip."""
import pytest

from conftest import make_plant, run
from loopkeeper.physics.faults import FaultState, HAZARD_KINDS_A

CR01 = {"kind": "test.inject_fault", "args": {"kind": "cdu_pump_backup_failure", "params": {}}}
CR03 = {"kind": "test.inject_fault", "args": {"kind": "facility_heat_rejection_loss", "params": {}}}


def margin(p):
    return min(p.truth()["margin_k"].values())


def settled(**kw):
    p = make_plant(**kw)
    run(p, 120)
    return p


# ------------------------------------------------------------------ catalog / validation
def test_kinds_are_in_the_catalog_and_reachable_through_the_command_bus():
    assert set(HAZARD_KINDS_A) == {"cdu_pump_backup_failure", "facility_heat_rejection_loss"}
    for cmd in (CR01, CR03):
        p = settled()
        r = p.apply(cmd)
        assert r["ok"], r
        assert r["effects"]["fault"] == cmd["args"]["kind"]
    p = settled()
    assert p.apply({"kind": "inject_fault", "args": dict(CR01["args"])})["ok"]          # alias without the test. prefix


@pytest.mark.parametrize("args", [
    {"kind": "cdu_pump_backup_failure", "target": "pump_f1"},                                   # FWS pump is not a CDU TCS pump
    {"kind": "cdu_pump_backup_failure", "params": {"standby": "pump_t1"}},                      # standby == primary
    {"kind": "cdu_pump_backup_failure", "params": {"standby_mode": "explode"}},
    {"kind": "cdu_pump_backup_failure", "params": {"primary_health_end": 1.5}},
    {"kind": "cdu_pump_backup_failure", "params": {"repair_failures": 1.5}},
    {"kind": "cdu_pump_backup_failure", "params": {"duration_s": float("nan")}},
    {"kind": "facility_heat_rejection_loss", "target": "pump_t1"},
    {"kind": "facility_heat_rejection_loss", "params": {"capacity_frac_end": -0.1}},
    {"kind": "facility_heat_rejection_loss", "params": {"flow_health_end": 0.0}},               # 0 would be a pump trip, not a derate
])
def test_bad_params_rejected_and_state_untouched(args):
    p = settled()
    h = p.state_hash()
    r = p.apply({"kind": "test.inject_fault", "args": args})
    assert r["ok"] is False and r["reason"]
    assert p.state_hash() == h


# ------------------------------------------------------------------ CR-01
def test_cr01_flow_collapse_then_thermal_rise_and_honest_solver_state():
    p = settled()
    base = p.truth()
    assert p.apply(CR01)["ok"]
    margins, flows = [], []
    for _ in range(12):
        run(p, 30)
        margins.append(margin(p))
        flows.append(p.truth()["tcs_flow_kg_s"])
    # progressive primary degradation first (flow falls), then total circulation loss (no head from either pump)
    assert flows[0] < base["tcs_flow_kg_s"] and flows[-1] == 0.0
    assert all(a >= b - 1e-6 for a, b in zip(flows, flows[1:]))
    # thermal margin only gets worse and crosses the limit
    assert all(a >= b - 0.05 for a, b in zip(margins, margins[1:])) and margins[-1] < 0 < margins[0] + 20
    t = p.truth()
    assert all(v == 0.0 for v in t["rack_flow_kg_s"].values())
    # zero flow is a legitimate hydraulic state (converged); the thermal guard reports the runaway as degraded, never silent
    sh = p.solver_health()
    assert sh["converged"] is True and sh["degraded"] is True and "thermal guard" in sh["reason"]
    assert p.world()["sim_status"] == "degraded"
    # mass balance: nothing leaves through the pressure reference, FWS loop is untouched and balanced
    assert all(abs(v) < 1e-9 for v in t["ext_grid_kg_s"].values())
    assert t["mass_balance"]["fws"] < 1e-9 and t["fws_flow_kg_s"] == pytest.approx(base["fws_flow_kg_s"], rel=0.05)
    assert t["hx_duty_kw"] < 0.01 * base["hx_duty_kw"]            # CDU rejects ~nothing with no TCS flow (eps-NTU, floor flow)


def test_cr01_energy_balance_while_degraded_and_after_recovery():
    p = settled()
    p.apply(CR01)
    run(p, 60)
    e = p.energy_balance()                    # primary at ~half head: rack heat still equals what the CDU hands to the FWS (+ transient)
    assert e["cdu_w"] <= 1.05 * e["it_w"]
    run(p, 300)
    e = p.energy_balance()
    assert e["it_w"] > 0 and e["rack_coolant_w"] < 0.05 * e["it_w"] and e["cdu_w"] < 0.05 * e["it_w"]   # heat is stored in the dies, not rejected
    for _ in range(2):
        r = p.apply({"kind": "replace_pump", "target_id": "pump_t2"})
    assert r["effects"].get("health_after") == 1.0
    p.apply({"kind": "switch_duty", "target_id": "pump_t2"})
    run(p, 1500)
    e = p.energy_balance()
    assert e["rack_coolant_w"] == pytest.approx(e["it_w"], rel=0.02) and e["cdu_w"] == pytest.approx(e["it_w"], rel=0.02)


def test_cr01_failover_to_dead_standby_does_not_help_and_repair_fails_first_then_succeeds():
    p = settled()
    base_flow = p.truth()["tcs_flow_kg_s"]
    p.apply(CR01)
    run(p, 200)
    m0 = margin(p)
    assert p.apply({"kind": "switch_duty", "target_id": "pump_t2"})["ok"]          # command accepted, but the standby is dead
    run(p, 60)
    assert p.truth()["tcs_flow_kg_s"] == 0.0 and margin(p) < m0
    h_before = p.state_hash()
    r1 = p.apply({"kind": "replace_pump", "target_id": "pump_t2"})
    assert r1["ok"] and r1["effects"]["repair_outcome"] == "failed" and r1["effects"]["attempt"] == 1
    assert p.faults.pump_health["pump_t2"] == 0.0 and p.truth()["tcs_flow_kg_s"] == 0.0     # a failed repair does not heal
    assert p.state_hash() != h_before                                                       # (attempt counter is recorded truth)
    run(p, 60)
    assert p.truth()["tcs_flow_kg_s"] == 0.0
    r2 = p.apply({"kind": "replace_pump", "target_id": "pump_t2"})
    assert r2["ok"] and r2["effects"].get("repair_outcome") is None and r2["effects"]["health_after"] == 1.0
    run(p, 60)
    assert p.truth()["tcs_flow_kg_s"] == pytest.approx(base_flow, rel=0.03)
    ms = []
    for _ in range(8):
        run(p, 100)
        ms.append(margin(p))
    assert all(b >= a - 0.05 for a, b in zip(ms, ms[1:])) and ms[-1] > 5.0                  # margin recovers monotonically


def test_cr01_primary_repair_can_also_fail_first():
    p = settled()
    p.apply({"kind": "test.inject_fault", "args": {"kind": "cdu_pump_backup_failure",
                                                    "params": {"repair_failures": 2, "primary_health_end": 0.0, "duration_s": 5}}})
    run(p, 30)
    assert p.truth()["tcs_flow_kg_s"] == 0.0
    for n in (1, 2):
        r = p.apply({"kind": "replace_pump", "target_id": "pump_t1"})
        assert r["effects"]["repair_outcome"] == "failed" and r["effects"]["attempt"] == n
    assert p.apply({"kind": "replace_pump", "target_id": "pump_t1"})["effects"]["health_after"] == 1.0
    run(p, 30)
    assert p.truth()["tcs_flow_kg_s"] > 5.0


def test_cr01_zero_repair_failures_heals_on_first_attempt():
    p = settled()
    p.apply({"kind": "test.inject_fault", "args": {"kind": "cdu_pump_backup_failure", "params": {"repair_failures": 0, "duration_s": 5}}})
    run(p, 30)
    r = p.apply({"kind": "replace_pump", "target_id": "pump_t2"})
    assert r["effects"]["health_after"] == 1.0


def test_cr01_degraded_standby_gives_partial_flow():
    p = settled()
    base = p.truth()["tcs_flow_kg_s"]
    p.apply({"kind": "test.inject_fault", "args": {"kind": "cdu_pump_backup_failure",
                                                    "params": {"standby_mode": "degraded", "standby_health": 0.3, "duration_s": 5}}})
    run(p, 30)
    assert p.truth()["tcs_flow_kg_s"] == 0.0
    p.apply({"kind": "switch_duty", "target_id": "pump_t2"})
    run(p, 30)
    f = p.truth()["tcs_flow_kg_s"]
    assert 0.5 * base < f < 0.95 * base                 # weak standby: reduced head curve, real pandapipes flow


def test_cr01_standby_that_trips_on_start():
    p = settled()
    base = p.truth()["tcs_flow_kg_s"]
    p.apply({"kind": "test.inject_fault", "args": {"kind": "cdu_pump_backup_failure",
                                                    "params": {"standby_mode": "fails_on_start", "start_fail_s": 40, "duration_s": 5}}})
    run(p, 30)
    assert p.faults.pump_health["pump_t2"] == 1.0       # looks healthy while idle
    p.apply({"kind": "switch_duty", "target_id": "pump_t2"})
    run(p, 5)
    assert p.truth()["tcs_flow_kg_s"] > 0.8 * base      # it starts ...
    run(p, 60)
    assert p.truth()["tcs_flow_kg_s"] == 0.0            # ... and trips
    assert p.apply({"kind": "replace_pump", "target_id": "pump_t2"})["effects"]["repair_outcome"] == "failed"
    assert p.apply({"kind": "replace_pump", "target_id": "pump_t2"})["effects"]["health_after"] == 1.0
    run(p, 120)
    assert p.truth()["tcs_flow_kg_s"] == pytest.approx(base, rel=0.03)      # latent record cleared: it stays healthy


# ------------------------------------------------------------------ CR-03
def test_cr03_heat_rejection_loss_raises_fws_temperature_and_erodes_margin():
    p = settled()
    base = p.truth()
    assert p.apply(CR03)["ok"]
    margins, fin, dt_f = [], [], []
    for _ in range(12):
        run(p, 60)
        t = p.truth()
        margins.append(margin(p))
        fin.append(t["fws_in_c"])
        dt_f.append(t["fws_out_c"] - t["fws_in_c"])
    t = p.truth()
    assert fin[-1] > base["fws_in_c"] + 8                       # supply to the CDU rises well above the 27 C setpoint
    assert all(b >= a - 0.7 for a, b in zip(fin, fin[1:]))      # (chiller wobble is +-0.6 K)
    assert all(a >= b - 0.05 for a, b in zip(margins, margins[1:])) and margins[-1] < margins[0] - 8      # monotone thermal-margin loss
    assert t["tcs_return_c"] > base["tcs_return_c"] + 5 and t["tcs_supply_c"] > base["tcs_supply_c"] + 5
    assert t["fws_flow_kg_s"] < 0.92 * base["fws_flow_kg_s"]    # primary-side flow loss is real pandapipes head loss
    assert t["tcs_flow_kg_s"] == pytest.approx(base["tcs_flow_kg_s"], rel=0.02)    # TCS circulation untouched: not a pump problem
    # hydraulics stay healthy and balanced: this is a thermal boundary failure
    sh = p.solver_health()
    assert sh["converged"] is True and sh["mass_balance"]["fws"] < 1e-9 and sh["mass_balance"]["tcs"] < 1e-9
    # energy: the CDU rejects no more than the (derated) plant can take plus transient, the rest is stored -> temperatures rise
    cap = p.thermal.facility_cap_w
    assert cap is not None and cap < 0.6 * p.thermal.q_design_w * 1.1
    e = p.energy_balance()
    assert e["cdu_w"] == pytest.approx(e["fws_w"], rel=0.08) and e["rack_coolant_w"] > e["cdu_w"]


def test_cr03_local_robot_repairs_do_not_fix_it():
    p = settled()
    p.apply(CR03)
    run(p, 360)
    m0, fin0 = margin(p), p.truth()["fws_in_c"]
    outcomes = [p.apply({"kind": "replace_pump", "target_id": pid}) for pid in ("pump_f1", "pump_f2")]
    assert all(o["ok"] and o["effects"]["repair_outcome"] == "not_applicable" for o in outcomes)
    p.apply({"kind": "replace_strainer", "target_id": "strainer_01"})
    p.apply({"kind": "replace_strainer", "target_id": "strainer_02"})
    for pid in ("pump_t1", "pump_t2"):
        p.apply({"kind": "replace_pump", "target_id": pid})
    p.apply({"kind": "switch_duty", "target_id": "pump_t2"})
    p.apply({"kind": "switch_duty", "target_id": "pump_f2"})
    for e in ("p_01", "p_02", "p_03"):
        p.apply({"kind": "brush_clear", "target_id": e, "args": {"removed_fraction": 1.0}})
    assert p.faults.pump_health["pump_f1"] < 0.7 and p.faults.facility["active"] is True
    ms = []
    for _ in range(5):
        run(p, 60)
        ms.append(margin(p))
    assert ms[-1] < m0 - 2 and p.truth()["fws_in_c"] > fin0 + 2          # still deteriorating after every local repair


def test_cr03_containment_by_load_shedding_and_facility_restore():
    def run_to_trouble():
        p = settled()
        p.apply(CR03)
        run(p, 480)
        return p
    # (a) shedding load below the derated capacity stops the rise and the buffer recovers
    p = run_to_trouble()
    rise0, m0 = p.thermal.facility_rise_k, margin(p)
    assert rise0 > 5
    for r in p.racks:
        assert p.apply({"kind": "set_load_factor", "target_id": f"rack_{r}", "args": {"factor": 0.0}})["ok"]
    run(p, 900)
    assert p.thermal.facility_rise_k < rise0 and margin(p) > m0
    # (b) the facility operator restores the plant (engineering control): capacity, flow and supply temperature return
    q = run_to_trouble()
    assert q.apply({"kind": "halt_fault", "target_id": "chiller_01"})["ok"]
    run(q, 1500)
    t = q.truth()
    assert q.faults.facility == {} and q.faults.pump_health["pump_f1"] == 1.0
    assert t["fws_in_c"] == pytest.approx(q.ctl["chiller_supply_c"], abs=1.0) and margin(q) > 12


def test_cr03_lowering_the_setpoint_cannot_beat_the_capacity_limit():
    a, b = settled(), settled()
    for p in (a, b):
        p.apply(CR03)
    b.apply({"kind": "set_chiller_setpoint", "args": {"supply_c": 15.0}})
    run(a, 900)
    run(b, 900)
    # energy balance: the facility removes at most Q_cap, so a colder setpoint only delays the rise
    assert b.thermal.facility_rise_k > a.thermal.facility_rise_k
    assert b.truth()["fws_in_c"] < a.truth()["fws_in_c"] + 3
    assert margin(b) < margin(settled()) - 3


# ------------------------------------------------------------------ determinism / persistence
SCRIPT = [(10, CR01), (200, {"kind": "switch_duty", "target_id": "pump_t2"}),
          (260, {"kind": "replace_pump", "target_id": "pump_t2"}), (300, {"kind": "replace_pump", "target_id": "pump_t2"}),
          (330, CR03), (500, {"kind": "replace_pump", "target_id": "pump_f1"})]


def drive(p, until_s, start_s=0.0):
    for i in range(int(start_s / 0.5), int(until_s / 0.5)):
        t = i * 0.5
        for at, cmd in SCRIPT:
            if abs(t - at) < 1e-9:
                p.apply(cmd)
        p.step(0.5)


def test_determinism_same_seed_same_commands_same_hash():
    a, b, c = make_plant(7, steady_load=False), make_plant(7, steady_load=False), make_plant(8, steady_load=False)
    for p in (a, b, c):
        drive(p, 560)
    assert a.state_hash() == b.state_hash() and a.get_state() == b.get_state()
    assert a.state_hash() != c.state_hash()


def test_get_state_set_state_roundtrip_mid_hazard_continues_identically():
    a = make_plant(11, steady_load=False)
    drive(a, 320)                                   # inside CR-01 recovery, CR-03 about to start
    blob = a.get_state()
    b = make_plant(11, steady_load=False)
    b.set_state(blob)
    assert b.state_hash() == a.state_hash()
    drive(a, 560, 320)
    drive(b, 560, 320)
    assert a.state_hash() == b.state_hash()
    assert b.faults.facility.get("active") and "pump_t2" not in b.faults.repair_gate


def test_state_roundtrip_preserves_repair_gate_and_latent_records():
    a = settled()
    a.apply({"kind": "test.inject_fault", "args": {"kind": "cdu_pump_backup_failure", "params": {"standby_mode": "fails_on_start"}}})
    a.apply({"kind": "replace_pump", "target_id": "pump_t1"})                     # attempt 1 of 1 fails
    b = make_plant()
    b.set_state(a.get_state())
    assert b.faults.repair_gate == a.faults.repair_gate and b.faults.repair_gate["pump_t1"]["attempts"] == 1
    assert b.faults.latent == a.faults.latent
    assert b.apply({"kind": "replace_pump", "target_id": "pump_t1"})["effects"]["health_after"] == 1.0   # second attempt heals


def test_old_state_without_hazard_keys_still_loads():
    j = FaultState().to_json()
    for k in ("repair_gate", "latent", "facility"):
        j.pop(k)
    fs = FaultState.from_json(j)
    assert fs.repair_gate == {} and fs.latent == {} and fs.facility == {}


def test_numeric_standby_mode_and_engine_schema_accept_the_new_params():
    from loopkeeper.engine.schemas import InjectFault
    m = InjectFault(kind="cdu_pump_backup_failure", params={"standby_mode": 1.0, "standby_health": 0.3, "repair_failures": 1.0, "duration_s": 5.0})
    p = settled()
    assert p.apply({"kind": "test.inject_fault", "args": {"kind": m.kind, "params": m.params}})["ok"]
    assert p.faults.pump_health["pump_t2"] == 0.3
    InjectFault(kind="facility_heat_rejection_loss", params={"capacity_frac_end": 0.4, "buffer_mj_per_k": 8.0, "rise_max_k": 35.0})
    assert not p.apply({"kind": "test.inject_fault", "args": {"kind": "cdu_pump_backup_failure", "params": {"standby_mode": 7.0}}})["ok"]
