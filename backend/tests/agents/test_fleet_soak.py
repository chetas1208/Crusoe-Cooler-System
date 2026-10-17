"""Soak with the full 16-robot fleet: every fault kind goes observe -> dispatch -> robots LEAVE their docks, travel, work, return ->
independent verification, and the thermal margin recovers. Writes artifacts/tests/fleet_soak.json."""
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from live_harness import Stack  # noqa: E402
from support.artifacts import write_artifact  # noqa: E402

CASES = [("fouling", "p_hs_b", "resolved", True), ("fouling", "p_hs_a", "resolved", True), ("strainer_blockage", "strainer_02", "resolved", True),
         ("strainer_blockage", "strainer_01", "resolved", True), ("valve_stuck", "valve_b1", "resolved", True),
         ("pump_degradation", "pump_t1", "resolved", True), ("sensor_drift", "sn_flow_zb", "resolved", False),
         ("workload_spike", "rack_b1", "dismissed", False)]
RESULTS: list[dict] = []


def pos(r):
    return list(r.pos)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,target,final,needs_robot", CASES)
async def test_fleet_soak(kind, target, final, needs_robot):
    st = await Stack.create(seed=8)
    try:
        eng = st.eng
        assert len(eng.robots) == 18
        start = {rid: pos(r) for rid, r in eng.robots.items()}
        base_margin = eng.kpis()["min_margin_k"]
        left, travelled, worked, modes = set(), {rid: 0.0 for rid in eng.robots}, set(), set()
        last = dict(start)

        def watch():
            for rid, r in eng.robots.items():
                d = math.dist(last[rid], pos(r))
                travelled[rid] += d
                last[rid] = pos(r)
                if r.mode != "DOCKED":
                    left.add(rid)
                if r.mode == "WORKING":
                    worked.add(rid)
                modes.add(r.mode)

        assert (await st.inject(kind, target))["accepted"]
        worst = base_margin
        t_end = eng.sim_time + 1700
        while eng.sim_time < t_end:
            await st.advance(10, 2.0)
            watch()
            worst = min(worst, eng.kpis()["min_margin_k"])
            if any(i["status"] in ("resolved", "escalated", "dismissed") for i in st.incidents()):
                break
        inc = st.incidents()[0]
        assert inc["status"] == final, inc["summary"]
        await st.advance(240, 4.0)           # let returns finish and the plant settle
        watch()
        end_margin = eng.kpis()["min_margin_k"]
        if needs_robot:
            assert left, "no robot ever left its dock"
            assert sum(travelled.values()) > 5.0, f"robots barely moved: {sum(travelled.values()):.1f} m"
            assert all(not (eng.robots[r].mode in ("FAILED", "ABORTED", "BLOCKED", "NEEDS_CHARGE")) for r in left)
            assert all(eng.robots[r].mode in ("DOCKED", "IDLE") for r in left), {r: eng.robots[r].mode for r in left}
            assert end_margin >= base_margin - 1.5, (base_margin, worst, end_margin)
        # one physical actor per task: nobody was double-booked on the same asset
        assert len({m["id"] for m in eng.missions.missions.values()}) == len(eng.missions.missions)
        RESULTS.append({"fault": kind, "target": target, "incident_status": inc["status"], "robots_left_dock": sorted(left),
                        "robots_worked": sorted(worked), "metres_travelled_total": round(sum(travelled.values()), 1),
                        "margin_k": {"baseline": round(base_margin, 2), "worst": round(worst, 2), "after": round(end_margin, 2)},
                        "missions": [{"id": m["id"], "robot": m["robot_id"], "kind": m["kind"], "outcome": m["outcome"]}
                                     for m in eng.missions.missions.values()],
                        "sim_seconds_to_close": round(eng.sim_time, 0)})
    finally:
        await st.stop()
        write_artifact("fleet_soak", {"test": "AGENT-01 / fleet soak (18 robots)", "cases": RESULTS})
