# V6 handoff: Agent A (backend) -> Agent B (frontend)

Spec: `docs/engineering/v6-layout.md`. This file supersedes the layout parts of `v4-handoff.md` (the robot pose fields and
the run-id notes there still apply). Status block at the end says what is live and what is still landing.

## 1. Run a v6 API on a spare port (in-memory, no model spend)

```bash
cd backend
DATABASE_URL= DATABASE_URL_UNPOOLED= API_HOST=127.0.0.1 API_PORT=8801 API_AUTH_DISABLED=true LOOPKEEPER_AUTH_DISABLED=1 \
  LOOPKEEPER_LAYA_ROUTER=0 uv run python -m loopkeeper.api
curl -s localhost:8801/api/v1/topology | jq '.facility.topology_version, .facility_layout_v6.layout_version, (.edges|length)'
```
`facility-v6.yaml` is the default config. `EXTERNAL_ROBOTS_PER_CORRIDOR=1|2` (default 2; anything else is rejected at start) sets the
OUTRIG count per road. The legacy two-hall `facility-large.yaml` / `facility-small.yaml` still load (`LOOPKEEPER_FACILITY_CONFIG=...`)
but are not the product. Python is canonical; the TS mock stays small.

## 2. One manifest: `topology.facility_layout_v6` (backend-generated, version-stamped)

Everything the scene needs is derived from `/topology` (no frontend-only geometry). `topology.facility.topology_version` =
`facility_layout_v6@1#<hash>`; the hash covers centerlines, asset positions, walls and robots' homes, so **cache by it**.
Frame `facility_world`: x east, y up, z south, metres, quaternions `[x,y,z,w]`, floor y = 0.

`facility_layout_v6`:
* `hall {x_min_m, x_max_m, z_min_m, z_max_m, height_m}` : x in [-14.5, 20.0], z in [-11, 11], 6 m high (derived; see `derived`).
* `rows[5]`: `{row_id:'ROW-01'..'ROW-05', letter:'a'..'e', zone_id:'zone_a'.., z_m, x_min_m, x_max_m, rack_ids[8], supply_header_edge, return_header_edge, supply_z_m, return_z_m, service_road, service_z_m, heroes[]}`; rows lie at z = -8, -4, 0, 4, 8.
* `roads[4]`: `{road_id:'ROAD-01'..'ROAD-04', z_m, x_min_m, x_max_m, clear_width_m (2.7), between_rows[2], sectors{west,east}, dock_ids[2], service_target_ids[], approach_pose_xz}`. Roads are between adjacent rows (z = -6, -2, 2, 6).
* `cross_aisles[2]`: `XA-W` (x 3.5..6.5) and `XA-E` (x 16.5..20.0), full depth, connecting all four roads. The mechanical / CDU bay is x < 3.5 (door gaps in the partition wall at z -9.6..-7.2 and 7.2..9.6).
* `robots {outrig[8] (id, road_id, sector, dock_id, start_pose{position_xyz_m,yaw_rad}), inpipe[10] (id, port_id), sentinel[5]}`; `circuits` (edge ids per circuit); `robot_envelope`; `hydraulic_notes`; `rack_count: 40`.

`/topology` also keeps the V4 additions (`site` rooms/walls/doors/columns/penetrations, `fittings`, `supports`, edge extras `circuit_id`, `taps`, `hydraulic_solver_mapping`, ...). `context_cabinets` is now `[]` (all 40 racks are solver-backed).
Rooms: `room_mech`, `xa_w`, `xa_e`, `rack_hall`, `road_1..4`, `yard` (exterior). Docks: `dock_or1..dock_or8` (road k has `dock_or{2k-1}` west and `dock_or{2k}` east) and two tool/charging stations `dock_tool1/2` in the bay.

## 3. Ids (all stable; read everything from data)

| Thing | Ids |
|---|---|
| Racks (40) | `rack_a1..rack_a8` (ROW-01) ... `rack_e1..rack_e8` (ROW-05); each has `row_id`, `slot`; `a1,a2,b1,b2` are instrumented GPU racks (CompOpt chip model), the other 36 use a lumped per-rack thermal model driven by their own solved flow |
| Rack branch parts | `valve_<rack>`, `sn_rack_<rack>`, supply drop `p_sd_<rack>`, return drop `p_rd_<rack>`, taps `n_<rack>_s/_r`, coolant in/out nodes `n_<rack>_in/_out` |
| FWS | `p_01` plant->pump skid, `p_02` skid->CDU primary (`strainer_01`), `p_03` CDU->plant; plant boundary nodes `n_fws_chiller_s/_r` (asset `chiller_01` in the yard) |
| TCS supply | `p_10` CDU->row C tee (`strainer_02`), `p_11` C->B, `p_14` B->A, `p_15` C->D, `p_16` D->E, row supply headers `p_hs_a..e` (each with `valve_z<row>` and `sn_flow_z<row>`) |
| TCS return | row return headers `p_hr_a..e`, `p_21` B->C, `p_22` A->B, `p_23` D->C, `p_24` E->D, `p_20` C->CDU |
| Equipment | `cdu_01`, `pump_t1/t2` (TCS), `pump_f1/f2` (FWS) |
| Crawler ports | `port_sa..port_se` (row supply headers), `port_rb`, `port_rd` (return headers), `port_a2` (trunk at CDU), `port_a1` (FWS), `port_res` (reserve), plus service-only `port_ra`, `port_s1`, `port_fr1` |

Every edge: `from`/`to` nodes, `loop` (`fws|tcs`), `role`, `centerline_xyz_m`, `length_m` (= centerline length), `diameter_mm`, `robot_passable`, `circuit_id`, `service_access`, `taps[]` on the ten row headers (`{node_id, s_m, drop_edge_id, rack_id}`: the 8 rack taps on each header), `hydraulic_solver_mapping`. Header taps are hydraulically lumped at the header end node (documented simplification); per-segment display flow = sum of downstream rack flows (mass-exact).
Pipe heights: trunks/headers 2.8 to 3.2 m above floor (nothing hangs in a road; roads are 2.7 m clear); rack drops end on the rack top (y 2.3).

## 4. Robots (18 physical + 5 virtual)

`GET /robots`, `world.robots{}`, `robot.pose` events: **`IR-01..IR-10`** (class `inpipe`), **`OR-01..OR-08`** (class `outrig`; `fleet.road_id`, `fleet.sector`), SEN-01..05 are never robots (Agents graph only).
Pose fields: `pose.position_xyz_m`, `pose.quaternion_xyzw` (crawlers: from the pipe tangent with no roll, includes pitch on risers; rovers: yaw about +y), `pose.heading_xyz`, `pose.linear_velocity_mps_xyz`, `pose.frame_id`, `pose.covariance_or_quality:'simulated_truth'`, `nav {graph_id, segment_id, s_m, route_id, floor_id}`, `dims_m`, `fleet {group, state, dock_id, road_id?, sector?}` (state: working|idle|repairing|manual|charging|blocked|safe_hold|failed). `robot.pose` payload also carries `robot_class`, `nav`, `sim_tick`.
Start poses: crawlers sit in their port on the pipe centerline (IR-01..05 in the row supply headers, IR-06/07 in the b/d return headers, IR-08 on the trunk at the CDU, IR-09 on the FWS line, IR-10 on the return trunk); OUTRIG start on their road hold bays (west bay x = 7.4, east bay x = 15.6), facing along the road.

## 5. Runs, restart, Execution

Run ids: live run is `run_live`, or `run_live_2`, `_3`... when a restart cannot resume (see DECISIONS 47); `run_live` is accepted as an alias in paths. `/runs/{id}/checkpoints` and `/replay` return stored snapshots/frames (<=240) and ledger events. A run stores the `topology_version` it was created with (migration below); replay/fork must use the stored version, not the current one: `/runs/{id}` returns `topology_version`, and `GET /runs/{id}/topology` returns that run's recorded topology.

## 6. Status (update log)

* [done] generator + topology v6 + validator gates for layout/circuits (`physics/layout_v6.py`, `physics/validation.py`), plant solves 40 racks (pandapipes) with CompOpt on the 4 hero racks, 18-robot registry with poses, API serves it on :8801.
* [landing next, same field names] OUTRIG road navigation with sector/aisle reservations, capability- and distance-aware dispatch (agents), `topology_version` columns + per-run recorded topology, replay/fork by recorded topology, repairs on the new layout.
