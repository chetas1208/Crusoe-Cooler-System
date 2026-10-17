"""V4 topology v2 (facility-large): connectivity validation, honest capacity, and negative tests proving each
validation gate can fail (spec s2.3: 'print a readable graph connectivity report and fail tests for missing endpoints')."""
import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from loopkeeper.physics.config import load_config
from loopkeeper.physics.plant import FacilityPlant
from loopkeeper.physics.topology import build_topology
from loopkeeper.physics.validation import render_text, solver_conservation, validate_topology
from support.artifacts import write_artifact

LARGE = Path(__file__).resolve().parents[2] / "configs" / "facility-large.yaml"


@pytest.fixture(scope="module")
def cfg():
    return load_config(LARGE, overrides={"physics": {"faults": {"enabled": False}}})


@pytest.fixture(scope="module")
def topo(cfg):
    return build_topology(cfg)


@pytest.fixture(scope="module")
def plant(cfg):
    return FacilityPlant(8, config=cfg)


def failed(topo_, plant_=None):
    return {c["id"] for c in validate_topology(topo_, plant_)["checks"] if not c["passed"]}


def test_default_config_is_v6_and_legacy_halls_still_load():
    assert load_config()["facility"]["config_version"].startswith("facility_layout_v6")        # V6 supersedes the V4 two-hall default
    assert load_config(str(Path(__file__).resolve().parents[2] / "configs" / "facility-large.yaml"))["facility"]["config_version"].startswith("facility-large")


def test_report_ok_and_readable(topo, plant):
    rep = validate_topology(topo, plant)
    text = render_text(rep)
    assert rep["ok"], text
    assert "RESULT: OK" in text and "[PASS] endpoints" in text and "[PASS] solver_conservation" in text
    write_artifact("topology_v2_validation", {"test": "FAC-02/FAC-03", "report": rep})


def test_footprint_and_rooms(topo):
    f = topo["facility"]
    w = f["interior_max"][0] - f["interior_min"][0]
    d = f["interior_max"][2] - f["interior_min"][2]
    assert (w, d) == (60.0, 42.0)
    rooms = {r["id"]: r for r in topo["site"]["rooms"]}
    assert {"hall_a", "hall_b", "room_mech", "room_cdu", "corridor", "yard"} <= set(rooms)
    assert len(topo["site"]["doors"]) == 8 and all(dr["width_m"] >= 2.0 for dr in topo["site"]["doors"])
    assert f["bounds_min"][0] < f["interior_min"][0] and f["bounds_min"][2] < f["interior_min"][2]   # yard outside shell


def test_capacity_is_honest(topo):
    racks = [a for a in topo["assets"] if a["type"] == "rack"]
    ctx = topo["context_cabinets"]
    assert len(racks) == 16 and sum(1 for r in racks if r["telemetry"] == "instrumented") == 4
    assert len(ctx) == 80 and topo["capacity"]["cabinet_instances_total"] == 96
    assert all(c["fidelity"] == "architectural_context" and not c["solver_backed"] and c["telemetry"] == "none" for c in ctx)
    assert all(r["solver_backed"] and r["fidelity"] == "solver" for r in racks)
    assert not ({c["id"] for c in ctx} & {a["id"] for a in topo["assets"]})


def test_edge_schema_additions(topo):
    required = ("circuit_id", "bore_m", "wall_thickness_mm", "floor_id", "hydraulic_solver_mapping", "service_access",
                "repair_allowed_classes", "schematic_neighbors", "room_ids", "length_m", "centerline_xyz_m")
    for e in topo["edges"]:
        assert all(k in e for k in required), e["id"]
        assert e["hydraulic_solver_mapping"]["network"] == e["loop"]
    hdr = next(e for e in topo["edges"] if e["id"] == "p_12")
    assert len(hdr["taps"]) == 8 and hdr["circuit_id"] == "tcs_zone_a"
    assert {t["drop_edge_id"] for t in hdr["taps"]} <= set(hdr["schematic_neighbors"])
    assert {f["type"] for f in topo["fittings"]} == {"elbow", "tee"}
    assert sum(1 for f in topo["fittings"] if f["type"] == "tee" and f["branch"] == "junction") == 2   # n_js, n_jr


def test_crawler_ports_and_docks(topo):
    ports = [a for a in topo["assets"] if a["type"] == "port"]
    docks = [a for a in topo["assets"] if a["type"] == "dock"]
    assert len(docks) == 6 and len(ports) >= 10
    edges = {e["id"]: e for e in topo["edges"]}
    assert all(edges[p["edge_id"]]["robot_passable"] for p in ports)
    assert topo["nav"]["dock_ids"][:6] == [d["id"] for d in docks]


def test_topology_hash_covers_geometry(cfg):
    moved = copy.deepcopy(cfg)
    moved["facility"]["pumps"][0][4] = [-19.0, 0, 6.3]
    assert build_topology(moved)["facility"]["topology_hash"] != build_topology(cfg)["facility"]["topology_hash"]


def test_solver_matches_small_facility_physics(plant):
    small = FacilityPlant(8, config=load_config(LARGE.with_name("facility-small.yaml"), overrides={"physics": {"faults": {"enabled": False}}}))
    for r in ("a1", "b2", "a8"):
        a, b = plant.hyd.rack_q[r], small.hyd.rack_q[r]
        assert abs(a - b) / b < 0.03, (r, a, b)
    assert solver_conservation(plant)["passed"]


# ─────────────────────────── negative tests: each gate can fail ───────────────────────────
def mut(topo, fn):
    t = copy.deepcopy(topo)
    fn(t)
    return t


def test_fail_missing_endpoint_node(topo):
    t = mut(topo, lambda t: t["nodes"].remove(next(n for n in t["nodes"] if n["id"] == "n_js")))
    assert "endpoints" in failed(t)


def test_fail_pipe_end_off_node(topo):
    def f(t):
        next(e for e in t["edges"] if e["id"] == "p_10")["centerline_xyz_m"][-1][0] += 0.05
    assert "endpoints" in failed(mut(topo, f))


def test_fail_orphan_pipe(topo):
    def f(t):
        t["nodes"] += [{"id": "n_x1", "label": "x", "loop": "tcs", "position_xyz_m": [0.0, 3.1, 0.0]},
                       {"id": "n_x2", "label": "x", "loop": "tcs", "position_xyz_m": [2.0, 3.1, 0.0]}]
        e = copy.deepcopy(next(e for e in t["edges"] if e["id"] == "p_10"))
        e.update({"id": "p_99", "from": "n_x1", "to": "n_x2", "centerline_xyz_m": [[0.0, 3.1, 0.0], [2.0, 3.1, 0.0]], "length_m": 2.0})
        t["edges"].append(e)
    assert "no_orphans" in failed(mut(topo, f))


def test_fail_mixing_across_cdu(topo):
    def f(t):
        next(e for e in t["edges"] if e["id"] == "p_02")["to"] = "n_cdu_ts"       # FWS pipe plumbed into the TCS port
    assert "loop_separation" in failed(mut(topo, f))


def test_fail_rack_without_return(topo):
    def f(t):
        t["edges"][:] = [e for e in t["edges"] if e["id"] != "p_66"]
    bad = failed(mut(topo, f))
    assert "rack_branches" in bad


def test_fail_tap_not_on_header(topo):
    def f(t):
        next(n for n in t["nodes"] if n["id"] == "n_a1_s")["position_xyz_m"][2] += 0.3
    assert "taps_on_headers" in failed(mut(topo, f))


def test_fail_loop_not_closed(topo):
    def f(t):
        e = next(e for e in t["edges"] if e["id"] == "p_20")
        e["from"], e["to"] = e["to"], e["from"]                                   # return trunk reversed: no path back to the CDU
    assert "loops_closed" in failed(mut(topo, f))


def test_fail_passable_run_without_port(topo):
    def f(t):
        for e in t["edges"]:
            if e["id"] == "p_03":
                e["access_port_ids"] = []
        t["assets"][:] = [a for a in t["assets"] if a["id"] != "port_fr1"]
    assert "passable_components" in failed(mut(topo, f))


def test_fail_crawler_in_small_bore(topo):
    def f(t):
        next(e for e in t["edges"] if e["id"] == "p_13")["robot_passable"] = True
    assert "passable_components" in failed(mut(topo, f)) or "ports" in failed(mut(topo, f))


def test_fail_port_off_pipe(topo):
    def f(t):
        next(a for a in t["assets"] if a["id"] == "port_as1")["position_xyz_m"][1] += 0.5
    assert "assets_on_edges" in failed(mut(topo, f))


def test_fail_cabinet_overlap_and_pipe_through_rack(topo):
    def f(t):
        t["context_cabinets"][0]["position_xyz_m"] = list(next(a for a in t["assets"] if a["id"] == "rack_a1")["position_xyz_m"])
    assert "geometry" in failed(mut(topo, f)) and "capacity_honesty" in failed(mut(topo, f))

    def g(t):
        e = next(e for e in t["edges"] if e["id"] == "p_12")
        e["centerline_xyz_m"] = [[-10.0, 3.1, -0.45], [-10.0, 1.0, -16.2], [4.3, 1.0, -16.2]]
        e["length_m"] = 40.0
    assert "geometry" in failed(mut(topo, g))


def test_fail_unreachable_dock(topo):
    def f(t):
        t["nav"]["obstacles"].append({"id": "obs_block", "rect": [-8.0, -3.6, -5.4, -2.4], "label": "block door"})
        t["nav"]["obstacles"].append({"id": "obs_block2", "rect": [14.0, -3.6, 16.6, -2.4], "label": "block door"})
        t["nav"]["obstacles"].append({"id": "obs_block3", "rect": [-12.6, -12.5, -11.4, -9.5], "label": "block door"})
    assert "nav_reachability" in failed(mut(topo, f))


def test_fail_context_cabinet_masquerading_as_instrumented(topo):
    def f(t):
        t["context_cabinets"][0]["telemetry"] = "instrumented"
        t["context_cabinets"][0]["solver_backed"] = True
    assert "capacity_honesty" in failed(mut(topo, f))


def test_fail_duplicate_ids(topo):
    def f(t):
        t["assets"].append(copy.deepcopy(t["assets"][0]))
    assert "unique_ids" in failed(mut(topo, f))


def test_json_roundtrip_stable(topo):
    assert json.loads(json.dumps(topo))["facility"]["topology_hash"] == topo["facility"]["topology_hash"]
