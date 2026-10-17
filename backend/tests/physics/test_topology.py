import json
from pathlib import Path

from loopkeeper.physics.config import load_config
from loopkeeper.physics.topology import build_topology

GOLDEN = Path(__file__).parent / "fixtures" / "topology_ts_golden.json"


SMALL = Path(__file__).resolve().parents[2] / "configs" / "facility-small.yaml"
V2_TOP = ("fittings", "supports", "context_cabinets", "context_equipment", "capacity", "site")
V2_EDGE = ("served_zones", "circuit_id", "bore_m", "wall_thickness_mm", "floor_id", "room_ids", "hydraulic_solver_mapping", "service_access",
           "repair_allowed_classes", "taps", "schematic_neighbors")
V2_ASSET = ("fidelity", "telemetry", "solver_backed", "room_id", "row_id", "slot", "supply_manifold_node_id", "return_manifold_node_id",
            "supply_drop_edge_id", "return_drop_edge_id", "thermal_asset_id")      # V6 RackUnit fields (additive)


def _strip_v2(t):
    """V4 topology v2 only ADDS fields; the legacy (TS-contract) subset must be unchanged."""
    for k in V2_TOP:
        t.pop(k, None)
    for e in t["edges"]:
        for k in V2_EDGE:
            e.pop(k, None)
    for a in t["assets"]:
        for k in V2_ASSET:
            a.pop(k, None)
    for n in t["nodes"]:
        n.pop("terminal", None)
    return t


def test_topology_identical_to_frontend_reference():
    """Golden file = packages/core/src/engine/facility.ts buildTopology() output (dumped with tsx) for the legacy
    small facility (the TS mock). The V4 default is facility-large.yaml (see test_topology_v2.py)."""
    got = _strip_v2(json.loads(json.dumps(build_topology(load_config(SMALL)))))
    want = json.loads(GOLDEN.read_text())
    assert got == want
    assert got["facility"]["topology_hash"] == want["facility"]["topology_hash"]


def test_plant_topology_has_ids_used_by_assets(plant):
    topo = plant.topology()
    ids = {a["id"] for a in topo["assets"]} | {e["id"] for e in topo["edges"]}
    assert set(plant.assets()) <= ids
    assert {"rack_a1", "cdu_01", "pump_t1", "valve_zb", "strainer_02", "sn_flow_zb", "p_17"} <= ids
    topo["edges"].clear()                       # returned copy must not alias plant state
    assert plant.topology()["edges"]
