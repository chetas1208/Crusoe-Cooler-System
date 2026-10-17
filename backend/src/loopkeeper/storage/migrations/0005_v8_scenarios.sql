-- Migration 0005: LOOPKEEPER V8 Crisis Scenarios & Physics Hazards (idempotent, additive)

CREATE TABLE IF NOT EXISTS scenario_definitions (
  scenario_id   text PRIMARY KEY,
  version       text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('SEVERE', 'MODERATE')),
  label         text NOT NULL,
  spec          jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hazard_zones (
  run_id        text NOT NULL REFERENCES simulation_runs(run_id),
  zone_id       text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('leak', 'smoke', 'fire', 'electrical', 'hotspot')),
  severity      text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status        text NOT NULL CHECK (status IN ('active', 'expanding', 'contained', 'cleared')),
  polygon       jsonb NOT NULL, -- list of [x, y, z] or 2D [x, z] bounds
  radius_m      double precision NOT NULL DEFAULT 1.0,
  t0_s          double precision NOT NULL,
  t1_s          double precision,
  doc           jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, zone_id)
);
CREATE INDEX IF NOT EXISTS hazard_zones_run_idx ON hazard_zones (run_id, status);

CREATE TABLE IF NOT EXISTS verification_results (
  run_id        text NOT NULL REFERENCES simulation_runs(run_id),
  scenario_id   text NOT NULL,
  verdict       text NOT NULL, -- VERIFIED_RECOVERY, CONTAINED, SAFE_SHUTDOWN, ESCALATED, FAILED, TIMED_OUT
  passed        boolean NOT NULL,
  sim_s         double precision NOT NULL,
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, scenario_id, sim_s)
);
CREATE INDEX IF NOT EXISTS verification_run_idx ON verification_results (run_id);

CREATE TABLE IF NOT EXISTS camera_bookmarks (
  run_id        text NOT NULL REFERENCES simulation_runs(run_id),
  bookmark_id   text NOT NULL,
  sim_s         double precision NOT NULL,
  camera_preset text NOT NULL,
  label         text NOT NULL,
  doc           jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, bookmark_id)
);

CREATE TABLE IF NOT EXISTS run_exports (
  export_id     text PRIMARY KEY,
  run_id        text NOT NULL REFERENCES simulation_runs(run_id),
  format        text NOT NULL CHECK (format IN ('json', 'csv', 'mp4', 'webm')),
  status        text NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'not_supported')),
  file_uri      text,
  doc           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE simulation_runs ADD COLUMN IF NOT EXISTS duration_sim_s bigint DEFAULT 1800;
ALTER TABLE simulation_runs ADD COLUMN IF NOT EXISTS verdict text;
ALTER TABLE simulation_runs ADD COLUMN IF NOT EXISTS final_outcome jsonb DEFAULT '{}'::jsonb;
