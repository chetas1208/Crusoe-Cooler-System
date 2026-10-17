"""Robot fleet construction from the generated facility layout manifest (`topology["facility_layout_v6"]`):
10 INPIPE crawlers (IR-01..IR-10) staged in service ports, and OUTRIG units (OR-01..OR-08, two per road by default;
EXTERNAL_ROBOTS_PER_CORRIDOR=1|2) parked on their road hold bays. The registry is the only source of robot ids.
Positions/orientations are derived from the topology (port centerline point, dock pad), never typed here."""
from __future__ import annotations

from .actor import RobotActor
from .graphs import PipeGraph

TOOLS_INSPECTOR = ["camera", "ultrasonic gauge"]
TOOLS_SERVICE = ["camera", "ultrasonic gauge", "brush"]
TOOLS_OR_WEST = ["valve actuator", "basket", "pressure kit", "calibration kit"]            # roads 1-2: valve/strainer/sensor work
TOOLS_OR_EAST = ["valve actuator", "basket", "pipe clamp", "pressure kit", "pump kit"]    # roads 3-4: pump/pipe work
TOOLS_OUTRIG = sorted(set(TOOLS_OR_WEST) | set(TOOLS_OR_EAST))                              # kept for importers

# (id, port, min bore mm, brush?) - body diameter follows the bore class
CRAWLERS = [
    ("IR-01", "port_sa", 80, True), ("IR-02", "port_sb", 80, False), ("IR-03", "port_sc", 80, True), ("IR-04", "port_sd", 80, False),
    ("IR-05", "port_se", 80, True), ("IR-06", "port_rb", 80, True), ("IR-07", "port_rd", 80, False), ("IR-08", "port_a2", 100, True),
    ("IR-09", "port_a1", 120, True), ("IR-10", "port_res", 100, True),
]
BODY_MM = {80: 65, 100: 85, 120: 105}
ENDURANCE = {80: "2.4 h", 100: "2.6 h", 120: "2.8 h"}


def build_fleet(topo: dict, graph: PipeGraph) -> list[RobotActor]:
    assets = {a["id"]: a for a in topo["assets"]}
    lay = topo.get("facility_layout_v6") or {}
    out: list[RobotActor] = []

    ports = {c["id"]: c["port_id"] for c in lay.get("robots", {}).get("inpipe", [])} or {rid: port for rid, port, _, _ in CRAWLERS}
    for idx, (rid, port_id, bore, brush) in enumerate(CRAWLERS):
        port = assets.get(ports.get(rid, port_id))
        if not port or not port.get("edge_id"):
            continue
        pos = graph.position(port["edge_id"], float(port["s_m"]))
        tools = TOOLS_SERVICE if brush else TOOLS_INSPECTOR
        spec = {"Body": f"Ø{BODY_MM[bore]} mm tracked cartridge", "Min bore": f"{bore} mm",
                "Tooling": "Camera · ultrasonic gauge" + (" · retractable brush" if brush else " (inspection only)"),
                "Endurance": ENDURANCE[bore]}
        r = RobotActor(rid, "inpipe", f"CRAWLER {rid}", port["id"], pos, 0.0, spec, {"min_bore_mm": bore, "tools": tools},
                       {"edge_id": port["edge_id"], "s": float(port["s_m"])})
        r.dims_m = [0.28, BODY_MM[bore] / 1000.0, BODY_MM[bore] / 1000.0]
        r.tangent = [float(c) for c in graph.tangent(port["edge_id"], float(port["s_m"]))]
        out.append(r)

    for o in lay.get("robots", {}).get("outrig", []):
        dock = assets.get(o["dock_id"])
        if not dock:
            continue
        n = int(o["id"].split("-")[1])
        tools = TOOLS_OR_WEST if o["road_id"] in ("ROAD-01", "ROAD-02") else TOOLS_OR_EAST
        spec = {"Platform": "Wheeled industrial base", "Reach": "3.0 m mast manipulator",
                "Tooling": " · ".join(t.capitalize() for t in tools), "Endurance": "6.0 h", "Road": o["road_id"], "Sector": o["sector"]}
        pos = o["start_pose"]["position_xyz_m"]
        r = RobotActor(o["id"], "outrig", f"OUTRIG {o['id']}", dock["id"], [float(pos[0]), 0.0, float(pos[2])],
                       float(o["start_pose"]["yaw_rad"]), spec, {"reach_m": 3.0, "tools": tools})
        r.dims_m = [0.95, 2.0, 0.62]                   # length (heading), height, width: body envelope (arm stowed)
        r.road_id, r.sector = o["road_id"], o["sector"]
        out.append(r)
    return out
