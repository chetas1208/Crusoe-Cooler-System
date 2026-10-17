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

## Known limits (honest)
- Stress (`artifacts/v7/stress.json`, seed 5, 500 s, random targets on all 8 ORs + 5 crawlers at a time): 18 missions done, 0 failed, 91 deadlock cycles
  all resolved by yielding, 0 physical OR overlaps, recovery 36 s against the undisturbed queue baseline; BUT OR-07 starves (0 completions), 6 of 10
  crawlers complete none (tree-shaped pipe network: one crawler blocks the only route), and yield ping-pong makes the west cross-aisle slow
  (72 back-offs, ~1600 holds). Docks sit in the road lanes, so a parked OR forces the detour into the opposing lane; reservations are per lane
  direction and do not see that wrong-lane use.
- Not verified: browser manual driving against this API (Agent B), live :8787 restart, Postgres/Neon run of migration 0004 beyond the embedded pg test.
