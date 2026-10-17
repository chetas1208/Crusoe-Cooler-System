# V4 handoff: Agent A (backend) -> Agent B (frontend)

Status of this file: written after milestone 1 (topology v2). Sections marked **[M2]..[M5]** are the field names/ids Agent A
commits to; they are additive to what `/topology`, `/world`, `/robots` and `/stream` already return today, and are filled in as the
milestones land (see "What works today" at the bottom for the live status).

## 1. Run a v2 API on a spare port (no DB, no model spend)

```bash
cd backend
DATABASE_URL= DATABASE_URL_UNPOOLED= API_HOST=127.0.0.1 API_PORT=8801 \
  API_AUTH_DISABLED=true LOOPKEEPER_AUTH_DISABLED=1 INTELLIGENCE_PROVIDER=deterministic \
  uv run python -m loopkeeper.api            # engine ticks at 2 Hz; in-memory store; Crusoe probe fails -> labelled fallback
curl -s localhost:8801/api/v1/topology | jq '.facility.topology_hash, (.edges|length), (.context_cabinets|length)'
```

`facility-large.yaml` is now the default config (`LOOPKEEPER_FACILITY_CONFIG=backend/configs/facility-small.yaml` selects the legacy
small hall, which is only kept for TS-mock parity tests). Facility id is still `lab_01`; the **topology hash changes** with any
geometry change (it now covers centerlines, asset positions, walls and context cabinets) so cache by hash.
Validation report (human readable + JSON): `uv run python -m loopkeeper.physics.validation --solve --json /tmp/v.json`.

## 2. Coordinate frame (one for everything)

Right-handed metric frame `facility_world`: **x east, y up, z south**, origin at the plan centre, floor at y = 0 (single level `L0`).
Quaternions are `[x, y, z, w]`. Interior shell is x in [-30, 30], z in [-21, 21] (60 x 42 m); wall/ceiling height 6.0 m.
`facility.bounds_min/max` additionally include the outdoor heat-rejection yard (z down to -30): fit the camera to
`interior_min/max` (the operational bounds), draw the yard as an exterior extra. Do not parse ids; read everything from data.

## 3. `/topology` additions (all additive; legacy keys unchanged)

New top-level keys: `site`, `fittings`, `supports`, `context_cabinets`, `context_equipment`, `capacity`. `expansion_bays` is now `[]`.

* `site.rooms[]`: `{id, name, kind: hall|mechanical|cdu|corridor|yard, rect:[x0,z0,x1,z1], floor_y_m, height_m, zone_id?}`.
  Rooms: `hall_a` (zone_a), `hall_b` (zone_b), `room_mech`, `room_cdu`, `corridor`, `yard` (exterior).
* `site.walls[]`: `{id, axis:'x'|'z', at, from, to, thickness_m, height_m, exterior, rect_segments:[[x0,z0,x1,z1]...], door_ids}`.
  `rect_segments` are the solid wall pieces *between* door gaps (already cut) - extrude them. `axis:'x'` runs along x at z=`at`.
* `site.doors[]`: `{id, wall_id, from, to, width_m, height_m, position_xyz_m, connects:[room,room]}` (8 doors, 2.0-2.5 m wide).
* `site.columns[]`: `{id, position_xyz_m, size_m}` embedded in wall lines (never in aisles).
* `site.penetrations[]`: `{id, wall_id, edge_id, position_xyz_m, sleeve:true}` where a pipe crosses a wall (draw a sleeve/escutcheon).
* `site.bounds_min/max`, `site.floor_id:'L0'`, `site.axes` (text).
* `context_cabinets[]` (80): `{id, type:'cabinet', row_id, hall_id, zone_id, slot, position_xyz_m, size_m, yaw_rad, fidelity:'architectural_context',
  solver_backed:false, telemetry:'none', cooling:'air / not modeled'}`. **Not assets, no telemetry, never selectable as a fault target**;
  render them instanced and badge them "context" in the inspector. Rows: `row_a1,row_a2` (Hall A), `row_b1,row_b2` (Hall B), 24 slots
  each at pitch 1.1 m; the solver-backed racks occupy slots 1-8 of `row_a1` / `row_b1`.
* `context_equipment[]` (3): expansion vessel, dosing skid, MV switchgear (mechanical room, context only).
* `capacity`: `{solver_backed_racks:16, instrumented_racks:4, architectural_context_cabinets:80, cabinet_instances_total:96, note}`.
* `fittings[]`: `{id, type:'elbow'|'tee', edge_id|node_id, position_xyz_m, turn_deg|edge_ids, branch:'junction'|'rack_tap'}`.
* `supports[]`: `{id, edge_id, s_m, position_xyz_m, type:'trapeze_hanger'|'floor_saddle'}` (~3 m spacing on passable runs).
* `nav.obstacles[]` now also contains the wall segments (`obs_wall_*`), cabinet rows (`obs_row_*`) and context equipment; `nav.dock_ids` =
  6 OUTRIG docks + the crawler ports.

Edges (`edges[]`) gain: `circuit_id` (`fws_primary|tcs_trunk|tcs_zone_a|tcs_zone_b`), `bore_m`, `wall_thickness_mm`, `floor_id`, `room_ids[]`,
`hydraulic_solver_mapping` `{network, pipes[], series_device}`, `service_access` `{ports, valves, strainers, sensors, pumps, outrig_service_xyz_m}`,
`repair_allowed_classes` `{inpipe:[L0,L1], outrig:[L0,L1,L2]}` (advisory; the enforcing table arrives with [M4]), `schematic_neighbors[]`, and for the four zone headers
`taps[]` = `{node_id, s_m, drop_edge_id, rack_id}` (rack supply/return taps *on* the header, so the header->drop junction is a real graph tee).
Nodes ending a header carry `terminal:'capped_header_end'`.
Assets gain `fidelity` (`solver|boundary|infrastructure`), `room_id`, and for racks `solver_backed:true`, `telemetry:'instrumented'|'aux_lumped'`.

## 4. Layout cheat sheet (ids are stable; geometry comes from data)

| Thing | Ids |
|---|---|
| FWS (navy/slate) | `p_01` chiller->skid (DN200), `p_02` skid->CDU primary (strainer `strainer_01`), `p_03` CDU->chiller; chiller `chiller_01` is the plant boundary in the yard |
| TCS (cyan supply / amber return) | `p_10` supply trunk (`strainer_02`), `p_12`/`p_17` Hall A/B supply headers (`valve_za/zb`), `p_22`/`p_27` return headers, `p_20` return trunk, rack drops `p_13..p_66` |
| Equipment | `cdu_01`, `pump_t1/t2` (TCS), `pump_f1/f2` (FWS) |
| Solver racks | `rack_a1..a8` (Hall A pod), `rack_b1..b8` (Hall B pod); `a1,a2,b1,b2` are instrumented GPU racks |
| OUTRIG docks (6) | `dock_or1`,`dock_or2` plant gallery, `dock_or3` CDU, `dock_or4` Hall A, `dock_or5` Hall B, `dock_or6` repair/charge station |
| Crawler ports (11 on passable pipes) | Hall A supply `port_as1,port_as2`; Hall A return `port_ar1,port_ar2`; Hall B `port_b1,port_br1`; mech `port_a1`; CDU `port_a2`; strainer `port_s1`; reserve `port_res`; FWS return `port_fr1` |

## 5. Fleet and poses **[M2]** (field names are committed; values arrive with the milestone)

* Robot ids: `IR-01..IR-10` (inpipe), `OR-01..OR-06` (outrig; `EXTERNAL_ROBOT_COUNT` 4|5|6, default 6 -> OR-05/OR-06 absent at 4). Old `c_01/c_02/o_01` disappear from the
  Python backend (the TS mock keeps them: take ids from data, never parse them). SENTINEL `SEN-01..SEN-05` are **not** robots and never have a pose.
* `GET /robots`, `world.robots{}`: existing fields plus `pose.quaternion_xyzw`, `pose.frame_id:'facility_world'`, `pose.linear_velocity_mps_xyz`,
  `pose.angular_velocity_radps_xyz`, `pose.quality:'simulated_truth'`, `nav {graph_id, segment_id, s_m, route_id, floor_id}`,
  `fleet {group:'internal'|'external', slot, dock_id, state:'working|idle|repairing|manual|charging|blocked|safe_hold|failed', ...}`,
  `dims_m`, `clearance_m`, `sim_tick`.
* `robot.pose` stream event payload: `{robot_id, robot_class, pose{...above...}, nav, battery_pct, mode, mission_id, tool, agent_task_id, sim_tick}`; `seq` is the envelope seq.
  Cadence 5-10 Hz per moving robot (deduplicated on change), faster only for a manually driven robot.

## 6. SENTINEL / authority / endpoints **[M3-M5]**

`GET /runs/{run_id}/agents/graph` will list `SEN-01..05` (specialty, claims, delegates, state, last_result; no pose). Repair/approval endpoints and the L0-L3 policy table
land with [M4]; trajectory/replay endpoints (`/robots/{id}/trajectory`) with [M5]. Details are appended here when shipped.

## 7. What works today (update log)

* [M1, done] topology v2 + validation report + tests (`artifacts/tests/topology_v2_validation.json`). Fleet is still the legacy `c_01,c_02,o_01` until [M2].
