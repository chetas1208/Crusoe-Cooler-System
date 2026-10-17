-- Migration 0006: LOOPKEEPER V9 Natural-Language Scenario Requests & Outbox Jobs
-- Idempotent, additive migration for Control Plane database.

CREATE TABLE IF NOT EXISTS scenario_requests (
  request_id      text PRIMARY KEY,
  principal_id    text NOT NULL,
  original_text   text NOT NULL,
  status          text NOT NULL CHECK (status IN ('QUEUED', 'PROCESSING', 'READY', 'FAILED', 'REJECTED', 'CANCELED')),
  phase           text NOT NULL CHECK (phase IN ('RECEIVED', 'CLASSIFYING', 'INTERPRETING', 'VALIDATING', 'CREATING_RUN', 'RUNNING', 'FAILED', 'REJECTED', 'CANCELED')),
  idempotency_key text UNIQUE,
  facility_id     text NOT NULL DEFAULT 'lab_01',
  source_run_id   text,
  run_id          text REFERENCES simulation_runs(run_id),
  error_code      text,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scenario_requests_status_idx ON scenario_requests (status);
CREATE INDEX IF NOT EXISTS scenario_requests_created_idx ON scenario_requests (created_at DESC);

CREATE TABLE IF NOT EXISTS scenario_interpretations (
  request_id          text PRIMARY KEY REFERENCES scenario_requests(request_id) ON DELETE CASCADE,
  laya_result         jsonb,
  laya_engine         text,
  crusoe_proposal     jsonb,
  crusoe_model        text,
  assumptions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolved_assets     jsonb NOT NULL DEFAULT '[]'::jsonb,
  definition_of_done  jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_report   jsonb NOT NULL DEFAULT '{}'::jsonb,
  latencies_ms        jsonb NOT NULL DEFAULT '{}'::jsonb,
  tokens_used         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenario_jobs (
  job_id          text PRIMARY KEY,
  request_id      text NOT NULL REFERENCES scenario_requests(request_id) ON DELETE CASCADE,
  phase           text NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  heartbeat_at    timestamptz NOT NULL DEFAULT now(),
  owner_epoch     bigint NOT NULL DEFAULT 0,
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scenario_jobs_request_idx ON scenario_jobs (request_id);
