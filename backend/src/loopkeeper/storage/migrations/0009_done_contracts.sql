-- V11 executable Definition of Done (idempotent, additive). One row per (run, incident): the latest contract document (checks, thresholds frozen at
-- freeze time, hold timers, Layer-A/B evaluation, revision history). Every state change of a contract is also a canonical world event
-- ('dod.contract'), so the full history is in world_events; this table is the queryable current state.
CREATE TABLE IF NOT EXISTS done_contracts (
  run_id          text   NOT NULL REFERENCES simulation_runs(run_id),
  contract_id     text   NOT NULL,
  incident_id     text   NOT NULL,
  version         integer NOT NULL,
  state           text   NOT NULL CHECK (state IN ('PROPOSED','VALIDATED','FROZEN','EVALUATING','VERIFIED','FAILED','ESCALATED')),
  terminal_state  text   CHECK (terminal_state IS NULL OR terminal_state IN ('VERIFIED','PARTIAL','CONTAINED_NOT_REPAIRED','ESCALATED','FAILED','TIMED_OUT','UNKNOWN')),
  frozen_hash     text,
  frozen_tick     bigint,
  updated_tick    bigint NOT NULL,
  doc             jsonb  NOT NULL,
  PRIMARY KEY (run_id, contract_id)
);
CREATE INDEX IF NOT EXISTS done_contracts_incident_idx ON done_contracts (run_id, incident_id);
