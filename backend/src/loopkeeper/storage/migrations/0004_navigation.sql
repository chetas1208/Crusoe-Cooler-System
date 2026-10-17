-- V7 navigation (idempotent, additive). Graph versions are immutable and shared by every run that pins them; routes and reservations are
-- per run. No per-frame writes: a route row is written on commit / arrival / cancel, a reservation row on reserve / release / expiry.
-- (No btree_gist exclusion constraint on purpose: the single world worker (fenced by the leader epoch) owns non-overlap; the tests
--  verify it with a query, and CHECKs below keep the rows sane.)
CREATE TABLE IF NOT EXISTS nav_nodes (
  graph_revision text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('exterior','interior')),
  node_id        text NOT NULL,
  doc            jsonb NOT NULL,
  PRIMARY KEY (graph_revision, kind, node_id)
);
CREATE TABLE IF NOT EXISTS nav_edges (
  graph_revision text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('exterior','interior')),
  edge_id        text NOT NULL,
  node_a         text NOT NULL,
  node_b         text NOT NULL,
  length_m       double precision NOT NULL CHECK (length_m >= 0),
  doc            jsonb NOT NULL,
  PRIMARY KEY (graph_revision, kind, edge_id)
);
CREATE TABLE IF NOT EXISTS robot_routes (
  run_id           text NOT NULL REFERENCES simulation_runs(run_id),
  plan_id          text NOT NULL,
  robot_id         text NOT NULL,
  kind             text NOT NULL,
  status           text NOT NULL,
  source           text,
  graph_revision   text NOT NULL,
  traffic_revision bigint NOT NULL,
  created_tick     bigint,
  depart_t         double precision,
  arrive_t         double precision,
  actual_arrival_t double precision,
  eta_s            double precision,
  length_m         double precision,
  doc              jsonb NOT NULL,
  PRIMARY KEY (run_id, plan_id)
);
CREATE INDEX IF NOT EXISTS robot_routes_robot ON robot_routes (run_id, robot_id, created_tick);
CREATE INDEX IF NOT EXISTS robot_routes_graph ON robot_routes (run_id, graph_revision);
CREATE TABLE IF NOT EXISTS traffic_reservations (
  run_id         text NOT NULL REFERENCES simulation_runs(run_id),
  plan_id        text NOT NULL,
  resource       text NOT NULL,
  owner          text NOT NULL,
  t0             double precision NOT NULL,
  t1             double precision NOT NULL,
  state          text NOT NULL CHECK (state IN ('active','released','expired')),
  graph_revision text NOT NULL,
  updated_tick   bigint,
  PRIMARY KEY (run_id, plan_id, resource, t0),
  CHECK (t1 > t0)
);
CREATE INDEX IF NOT EXISTS traffic_res_resource ON traffic_reservations (run_id, resource, t0);
CREATE INDEX IF NOT EXISTS traffic_res_owner ON traffic_reservations (run_id, owner, state);
ALTER TABLE simulation_runs ADD COLUMN IF NOT EXISTS nav_graph_revision text;
