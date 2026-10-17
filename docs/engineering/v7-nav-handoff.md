# V7 navigation handoff (Agent A, backend)

Deterministic, LLM-free routing. Code: `backend/src/loopkeeper/nav/` (graphs, table, navigator, manual, reasons), API `api/routes_nav.py`,
engine commands `robot.route.commit|cancel`, `nav.closure.set`. Migration `0004_navigation.sql`. Tests `backend/tests/test_v7_navigation.py`
(23), artifacts `artifacts/v7/*.json`.

## Graphs
- G_ext (roads, cross-aisles, junction/yield/service/dock/parking/passing nodes; edge attrs: width, speed, one-way/lane, closed). G_in = passable pipe
  segments only (bore, clearance), recovery ports per component. Start-up validation (`NavValidationError(constraint, detail)`) fails naming the
  constraint (reachability gate, fillet radius, clear height, recovery port per component).
- Graph revision = hash of nodes + edges + closure set. Mid cross-aisle does not exist in facility_layout_v6: graph reports `mid_cross_aisle: null`;
  closing an end aisle reroutes via the other end or refuses NO_ACCESS.

## HTTP
- GET `/runs/{id}/navigation/graphs?kind=exterior|interior`, `/navigation/reachability?robot_id&target_id`, `/navigation/traffic`
- POST `/runs/{id}/robots/{rid}/route/plan` (preview, no lease, nothing reserved), `/route/commit` (drive scope, lease; optimistic on
  `graph_revision` + `traffic_revision`, never on tick), `/route/cancel`; POST `/navigation/closures` (command scope).
- Refusal body: `{accepted:false, reason, detail, graph_revision, traffic_revision, blocked_by?}`; reasons NO_ACCESS, TURN_RADIUS, EQUIPMENT_BLOCK,
  RESERVATION_CONFLICT, PRESSURE_UNSAFE, BATTERY, PIPE_CLEARANCE (+ UNKNOWN_*, LEASE_REQUIRED, STALE_*). HTTP 404/403/409.

## Events (all carry run_id, seq, sim_tick, graph_revision)
`robot.route_planned|committed|replanned|cancelled|paused`, `robot.arrived` (eta_s, actual_s, eta_error_s, mission/incident), `traffic.reservation`
(active/released/expired), `traffic.yield`, `traffic.blocked` (reason DEADLOCK / DEADLOCK_UNRESOLVED + cycle + action), `nav.graph_changed`.

## Manual control
`DriveIntent` has optional `branch` (left|right|straight|edge id) and `graph_revision` (stale -> refused `stale_graph_revision`). W/S follow the route
tube (swept collision, legal branch only at a decision point one connector radius before a node), A/D choose branch / lateral inside the tube.
Destination mode: plan -> follow -> pause on override -> reroute. Blur / expiry / heartbeat loss -> zero velocity + SAFE_HOLD.

## Traffic
Time-aware reservations (node, directed edge lane, parking, pipe segment) with bounded `valid_until`, single scheduler (engine leader epoch fences),
hot state in memory, Neon rows only on state change (`robot_routes`, `traffic_reservations`, `nav_nodes`, `nav_edges`; `simulation_runs.nav_graph_revision`).
Deadlock ladder: reroute -> back off -> retreat/preempt parking -> expire (safe stop with exact reason). Manual priority bounded to 30 s.

## Stress results after the aging fix (artifacts/v7/stress.json seed 5, stress_seed_11.json, stress_seed_23.json)
Dispatcher = FIFO jobs scored by `Navigator.score` (ETA + busy + battery - aging bonus). Right of way (traffic guard, back-off, deadlock victim) uses
mission priority + aging (`Navigator.priority/outranks`, +1 per minute since last served, capped 2.5, quantised 0.5). Crawlers parked in their port
are treated as a niche (never block the through-bore); idle/blocked crawlers that block a higher-priority crawler retreat to their port.
- seed 5: 28 done, Jain 0.942, no robot with 0 completions, recovery 38 s; seed 11: 32 done, Jain 0.999; seed 23: 31 done, Jain 0.969; 0 physical OR overlaps.
- Fairness = Jain over completions per available second (OR-08 holds its bay until t=220 s). Harness oversubscribes OR work (1 job / 8 s).

## Follow-up (Agent E): hold reduction, docks, mid cross-aisle (artifacts/v7/stress_summary.json)
- Three seeds (5, 11, 23): Jain 0.942 / 0.999 / 0.969, every robot >= 1 completion, 0 overlaps. Holds seed 5: ~1600 (original) -> 134 -> 110; back-offs 72 -> 11.
- Reservations are released behind the robot and the slot under a held robot is extended; yield commitment (`Navigator.grants`) + doubling yield window per repeating pair.
- Docks stay on the road; dock-adjacent road edges are single-lane slots (`ExtGraph.single_lane`). Residual holds are mostly the physical guard against a robot docked on its pad.
- Mid cross-aisle: infeasible on this layout (0.8 m rack gaps < 0.9 m envelope); `mid_cross_aisle_probe` carries the reason; a variant-topology test shows the builder and the end-aisle reroute.
- Not verified: browser manual driving against this API, live :8787 restart, Neon run of migration 0004, full backend suite after the V7 changes (never completed).
