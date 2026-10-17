# LOOPKEEPER V4 — Fleet Architecture & 3D Spatial Layout

**Revision:** 2026-10-16  
**Status:** Deployed & Verified in Engine + 3D Scene

---

## 1. Fleet Composition & Topology

LOOPKEEPER V4 expands the robotic work system to **16 concurrent physical virtual actors** and **5 virtual supervisory intelligence workers**, strictly adhering to the three core agent categories: `SENTINEL`, `INPIPE`, and `OUTRIG`.

| Entity Group | Identifiers | Count | Physical Mesh? | Spatial Domain | Primary Accountability |
|---|---|:---:|:---:|---|---|
| **INPIPE Crawlers** | `IR-01` .. `IR-10` | 10 | Yes (Cartridge Mesh) | Internal passable cooling pipes (`DN80..DN200`) | Internal pipe inspection, ultrasonic wall gauging, deposit brushing (L1), leak detection |
| **OUTRIG External Units** | `OR-01` .. `OR-06` | 4–6 (Default: 6) | Yes (Mobile Base + Mast) | Facility floor aisles, mechanical room, corridor | External isolation, strainer basket servicing (L2), valve actuation, physical repairs |
| **SENTINEL Supervisors** | `SEN-01` .. `SEN-05` | 5 | **No** (Virtual Only) | Agent hierarchy / task graph | Concurrent supervisory intelligence (facility health, fleet dispatch, safety guardian, recovery audit) |

> [!IMPORTANT]
> `SEN-01` through `SEN-05` are **virtual supervisors** within the `SENTINEL` category. They are never assigned 3D meshes, never rendered as vehicles in the spatial view, and never hallucinate physical movements.

---

## 2. Facility layout (generated from `backend/configs/facility-large.yaml`; checked by `physics/validation.py`)

Frame `facility_world`: x east, y up, z south, origin at the plan centre, floor y = 0, single level `L0`. Interior shell x in [-30, 30], z in [-21, 21] (60 x 42 m), height 6.0 m; the outdoor heat-rejection yard (chiller `chiller_01`, the plant boundary) lies north of the shell down to z = -30.

| Room (`site.rooms`) | Rect [x0, z0, x1, z1] | Contents |
|---|---|---|
| `hall_a` (zone_a) | [-12, -21, 30, -3] | rows `row_a1`/`row_a2` (24 cabinet slots each), Hall A headers `p_12`/`p_22`, ports `port_as1/as2/ar1/ar2`, dock `dock_or4` |
| `hall_b` (zone_b) | [-12, 3, 30, 21] | rows `row_b1`/`row_b2`, headers `p_17`/`p_27`, ports `port_b1/br1`, dock `dock_or5` |
| `room_mech` | [-30, -21, -12, -3] | FWS pump skid (`pump_f1/f2`), `strainer_01`, context expansion vessel / dosing skid / MV switchgear, docks `dock_or1/or2`, ports `port_a1`, `port_s1` |
| `room_cdu` | [-30, 3, -12, 21] | `cdu_01`, `pump_t1/t2`, `strainer_02`, dock `dock_or3`, port `port_a2` |
| `corridor` | [-30, -3, 30, 3] | robot lane between all rooms, dock `dock_or6` (repair/charging) |
| `yard` (exterior) | [-30, -30, -14, -21] | chiller / heat-rejection boundary |

Eight doors (2.0 to 2.5 m wide) connect the rooms (`site.doors`); 12 wall penetrations are listed with sleeves. Rack capacity is explicit: **16 solver-backed racks** (4 instrumented hero GPU racks + 12 aux) occupy slots 1-8 of `row_a1`/`row_b1`; the other **80 cabinets are architectural context** (`context_cabinets`, `fidelity: architectural_context`, no telemetry, no coolant connection, never a fault target).

---

## 3. Initial non-overlapping robot staging (from `engine/robots/fleet.py`, positions computed from the topology)

INPIPE crawlers start inside their launch port, on the pipe centerline (`pose.position` = centerline point at `s`):

| Robot | Port | Edge, s (m) | Min bore |
|---|---|---|---|
| `IR-01` | `port_as1` | `p_12`, 7.0 (Hall A supply) | 80 mm |
| `IR-02` | `port_as2` | `p_12`, 24.0 | 80 mm |
| `IR-03` | `port_ar1` | `p_22`, 6.0 (Hall A return) | 100 mm |
| `IR-04` | `port_ar2` | `p_22`, 22.0 | 100 mm |
| `IR-05` | `port_b1` | `p_17`, 8.0 (Hall B supply) | 80 mm |
| `IR-06` | `port_br1` | `p_27`, 8.0 (Hall B return) | 100 mm |
| `IR-07` | `port_a1` | `p_01`, 12.0 (FWS, mechanical room) | 120 mm |
| `IR-08` | `port_a2` | `p_10`, 1.5 (TCS trunk at the CDU) | 120 mm |
| `IR-09` | `port_s1` | `p_02`, 2.8 (strainer inspection spool) | 80 mm |
| `IR-10` | `port_res` | `p_20`, 8.0 (reserve staging) | 80 mm |

`port_fr1` (`p_03`, FWS return) is a service port with no resident crawler: nothing can reach `p_03` except through it (the heat exchanger separates it from the other FWS runs).

OUTRIG units start parked on their charging pads (y = 0), in this order (`EXTERNAL_ROBOT_COUNT=4|5|6` keeps the first N, ids stable):
`OR-01` `dock_or1` (-28, -6), `OR-02` `dock_or2` (-28, -9.5), `OR-03` `dock_or3` (-17.5, 12.5), `OR-04` `dock_or4` (-2, -6), `OR-05` `dock_or5` (-2, 6), `OR-06` `dock_or6` (6, 0).

Navigation: a 0.25 m grid with 0.55 m robot-radius inflation over wall segments (door gaps open), cabinet rows, CDU/pump/skid footprints and context equipment; every dock and every OUTRIG service pose is verified free and reachable by the `nav_reachability` check. Known limits: crawlers share edges without reservations yet (segment reservations are milestone work), and the dispatcher currently picks the first capable OUTRIG by id (`OR-01`) rather than the nearest.

---

## 4. Authoritative 3D Metric Coordinates

All poses adhere to a single unified reference frame:

```json
{
  "frame_id": "facility_world",
  "position_m_xyz": [x, y, z],
  "quaternion_xyzw": [qx, qy, qz, qw],
  "linear_velocity_mps_xyz": [vx, vy, vz],
  "angular_velocity_radps_xyz": [wx, wy, wz],
  "covariance_or_quality": "simulated_truth"
}
```

- **Convention:** Right-handed metric coordinate frame (X = East, Y = Up, Z = South).
- **Inpipe Centerline Mapping:** Position is derived from spline parameter $s \in [0, L]$ along edge segment centerline; orientation quaternion is calculated via tangent parallel transport, eliminating gimbal flips along 90° pipe elbows.
- **Outrig Floor Navigation:** Y coordinate clamped to $y = 0.0$ m; heading orientation derived from yaw angle with raycast obstacle avoidance against walls, doors, and cabinet rows.
