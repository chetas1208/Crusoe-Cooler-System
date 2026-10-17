-- LOOPKEEPER engine schema v1 (backend.md section 8). Plain SQL; every mutable/evidence row is scoped by run_id.

CREATE TABLE facilities (
  id              text PRIMARY KEY,
  config_version  text NOT NULL,
  topology_hash   text NOT NULL,
  dimensions      jsonb NOT NULL DEFAULT '{}'::jsonb,
  topology        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assets (
  facility_id     text NOT NULL REFERENCES facilities(id),
  config_version  text NOT NULL,
  asset_id        text NOT NULL,
  type            text NOT NULL,
  loop_id         text,
  geometry        jsonb NOT NULL,
  access_mode     jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (facility_id, config_version, asset_id)
);

CREATE TABLE scenario_specs (
  scenario_id     text PRIMARY KEY,
  spec            jsonb NOT NULL,
  creator         text,
  safety_policy   jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE simulation_runs (
  run_id           text PRIMARY KEY,
  parent_run_id    text REFERENCES simulation_runs(run_id),
  fork_tick        bigint,
  facility_id      text NOT NULL REFERENCES facilities(id),
  config_version   text NOT NULL,
  topology_hash    text NOT NULL,
  scenario_id      text REFERENCES scenario_specs(scenario_id),
  seed             bigint NOT NULL,
  rng_stream       text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('baseline','scenario','fork')),
  label            text NOT NULL DEFAULT '',
  phase            text NOT NULL CHECK (phase IN ('queued','running','paused','stopped','failed','completed')),
  owner_id         text,
  engine_version   text NOT NULL,
  schema_version   integer NOT NULL,
  sim_speed        double precision NOT NULL DEFAULT 1,
  dt_s             double precision NOT NULL,
  last_tick        bigint NOT NULL DEFAULT 0,
  last_seq         bigint NOT NULL DEFAULT 0,
  last_apply_order bigint NOT NULL DEFAULT 0,
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX simulation_runs_facility_idx ON simulation_runs (facility_id, created_at DESC);

CREATE TABLE engine_leader (
  facility_id   text PRIMARY KEY,
  holder        text NOT NULL,
  epoch         bigint NOT NULL,
  acquired_at   timestamptz NOT NULL DEFAULT now(),
  heartbeat_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE world_events (
  run_id            text   NOT NULL REFERENCES simulation_runs(run_id),
  seq               bigint NOT NULL,
  event_id          text   NOT NULL,
  facility_id       text   NOT NULL,
  tick              bigint NOT NULL,
  sim_time_s        double precision NOT NULL,
  world_version     bigint NOT NULL,
  kind              text   NOT NULL,
  entity_id         text   NOT NULL,
  actor_type        text   NOT NULL DEFAULT 'system',
  actor_id          text,
  payload           jsonb  NOT NULL,
  causal_parent_id  text,
  command_id        text,
  ts                timestamptz NOT NULL,
  schema_version    integer NOT NULL,
  event_hash        text   NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX world_events_tick_idx ON world_events (run_id, tick, seq);
CREATE INDEX world_events_kind_idx ON world_events (run_id, kind, seq);

-- append-only evidence
CREATE FUNCTION world_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'world_events is append-only';
END $$;
CREATE TRIGGER world_events_no_update BEFORE UPDATE OR DELETE ON world_events
  FOR EACH ROW EXECUTE FUNCTION world_events_immutable();

CREATE TABLE world_snapshots (
  snapshot_id     text PRIMARY KEY,
  run_id          text   NOT NULL REFERENCES simulation_runs(run_id),
  facility_id     text   NOT NULL,
  tick            bigint NOT NULL,
  last_seq        bigint NOT NULL,
  reason          text   NOT NULL,
  state           bytea  NOT NULL,
  world           jsonb  NOT NULL,
  rng_state       jsonb  NOT NULL,
  schema_version  integer NOT NULL,
  engine_version  text   NOT NULL,
  content_hash    text   NOT NULL,
  world_hash      text   NOT NULL,
  state_hash      text   NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, tick, last_seq)
);
CREATE INDEX world_snapshots_run_tick ON world_snapshots (run_id, tick);

CREATE TABLE commands (
  run_id                text NOT NULL REFERENCES simulation_runs(run_id),
  command_id            text NOT NULL,
  kind                  text NOT NULL,
  target_id             text,
  issuer                text,
  actor_type            text NOT NULL,
  issued_tick           bigint NOT NULL,
  applied_tick          bigint,
  apply_order           bigint,
  seq_at_apply          bigint,
  expected_world_version bigint,
  args                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  preconditions         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL CHECK (status IN ('accepted','rejected','completed','failed')),
  reason                text,
  outcome               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, command_id)
);
CREATE INDEX commands_order_idx ON commands (run_id, apply_order);

CREATE TABLE applied_effects (
  run_id      text NOT NULL REFERENCES simulation_runs(run_id),
  effect_key  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, effect_key)
);

CREATE TABLE control_leases (
  lease_id        text PRIMARY KEY,
  run_id          text NOT NULL REFERENCES simulation_runs(run_id),
  robot_id        text NOT NULL,
  principal_id    text NOT NULL,
  connection_id   text,
  epoch           bigint NOT NULL,
  status          text NOT NULL,
  granted_tick    bigint,
  granted_at      timestamptz,
  expires_at      timestamptz,
  last_heartbeat  timestamptz,
  last_command_seq bigint NOT NULL DEFAULT 0,
  ended_reason    text,
  doc             jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX control_leases_run_idx ON control_leases (run_id, robot_id, status);

CREATE TABLE agent_decisions (
  decision_id   bigserial PRIMARY KEY,
  key           text UNIQUE,
  run_id        text NOT NULL REFERENCES simulation_runs(run_id),
  tick          bigint NOT NULL,
  task_id       text,
  decision      jsonb NOT NULL DEFAULT '{}'::jsonb,
  record        jsonb,
  model         jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_decisions_run_tick ON agent_decisions (run_id, tick);

CREATE TABLE agent_state_blobs (
  key           text PRIMARY KEY,
  value         jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sensor_samples (
  run_id       text NOT NULL REFERENCES simulation_runs(run_id),
  tick         bigint NOT NULL,
  sim_time_s   double precision NOT NULL,
  sensor_id    text NOT NULL,
  metric       text NOT NULL,
  value        double precision NOT NULL,
  units        text NOT NULL DEFAULT '',
  source       text NOT NULL DEFAULT 'plant.readings',
  quality      text NOT NULL DEFAULT 'good'
);
CREATE INDEX sensor_samples_idx ON sensor_samples (run_id, sensor_id, metric, tick);

CREATE TABLE robots (
  run_id       text NOT NULL REFERENCES simulation_runs(run_id),
  robot_id     text NOT NULL,
  robot_class  text NOT NULL,
  location     jsonb NOT NULL,
  health       jsonb NOT NULL DEFAULT '{}'::jsonb,
  battery_pct  double precision NOT NULL,
  mode         text NOT NULL,
  mission_id   text,
  control      jsonb NOT NULL DEFAULT '{}'::jsonb,
  doc          jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_tick bigint NOT NULL,
  PRIMARY KEY (run_id, robot_id)
);

CREATE TABLE missions (
  run_id       text NOT NULL REFERENCES simulation_runs(run_id),
  mission_id   text NOT NULL,
  incident_id  text,
  robot_id     text NOT NULL,
  target       text NOT NULL,
  status       text NOT NULL,
  progress     double precision NOT NULL DEFAULT 0,
  outcome      text,
  opened_tick  bigint NOT NULL,
  closed_tick  bigint,
  doc          jsonb NOT NULL,
  PRIMARY KEY (run_id, mission_id)
);

CREATE TABLE incidents (
  run_id       text NOT NULL REFERENCES simulation_runs(run_id),
  incident_id  text NOT NULL,
  opened_tick  bigint NOT NULL,
  updated_tick bigint NOT NULL,
  severity     text NOT NULL,
  status       text NOT NULL,
  closed_tick  bigint,
  close_reason text,
  doc          jsonb NOT NULL,
  PRIMARY KEY (run_id, incident_id)
);

CREATE TABLE agent_runs (
  run_id          text NOT NULL REFERENCES simulation_runs(run_id),
  task_id         text NOT NULL,
  thread_id       text,
  parent_task_id  text,
  incident_id     text,
  role            text NOT NULL,
  provider        text,
  model           text,
  started_tick    bigint,
  ended_tick      bigint,
  state           jsonb NOT NULL,
  PRIMARY KEY (run_id, task_id)
);

CREATE TABLE verification_runs (
  run_id            text NOT NULL REFERENCES simulation_runs(run_id),
  verification_id   text NOT NULL,
  incident_id       text NOT NULL,
  attempt           integer NOT NULL,
  status            text NOT NULL,
  confidence        double precision,
  failed_reason     text,
  checks            jsonb NOT NULL DEFAULT '[]'::jsonb,
  doc               jsonb NOT NULL,
  PRIMARY KEY (run_id, verification_id)
);
