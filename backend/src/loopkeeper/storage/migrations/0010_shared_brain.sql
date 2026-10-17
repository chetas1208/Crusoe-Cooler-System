-- V11 Shared Brain (memory) - idempotent, additive. Cross-run knowledge with run-scoped provenance.
-- No FK to simulation_runs on purpose: memory outlives the run that taught it; run ids are provenance references, and every row links to
-- immutable world_events through event_refs / evidence_ids, so a summarised or pruned row can always be re-derived from the event log.
-- Timestamps are unix seconds (double precision) so TTL is testable and independent of the simulation clock.
-- Rows are append-by-revision: a conflicting claim is a NEW revision, never an UPDATE of the old content (status changes only).

CREATE TABLE IF NOT EXISTS shared_facts (
  fact_id          text    NOT NULL,
  revision         integer NOT NULL CHECK (revision >= 1),
  facility_id      text    NOT NULL,
  run_id           text    NOT NULL,                 -- origin run (provenance)
  incident_id      text,
  subject_key      text    NOT NULL,                 -- identity of the claim subject, e.g. 'asset:strainer_02:cause'
  fact_kind        text    NOT NULL DEFAULT 'observation',
  fault_kind       text,
  asset_type       text,
  asset_id         text,
  topology_revision text,
  statement        text    NOT NULL,
  value            jsonb   NOT NULL DEFAULT '{}'::jsonb,
  value_hash       text    NOT NULL,
  evidence_ids     jsonb   NOT NULL DEFAULT '[]'::jsonb,
  source_run_ids   jsonb   NOT NULL DEFAULT '[]'::jsonb,
  event_refs       jsonb   NOT NULL DEFAULT '[]'::jsonb,
  preconditions    jsonb   NOT NULL DEFAULT '{}'::jsonb,
  confidence       double precision NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  status           text    NOT NULL CHECK (status IN ('PROPOSED','VERIFIED','CONFLICTED','REJECTED','EXPIRED','ARCHIVED')),
  status_reason    text    NOT NULL DEFAULT '',
  visibility       text    NOT NULL DEFAULT 'run' CHECK (visibility IN ('run','shared')),
  proposed_by      text    NOT NULL DEFAULT '',
  verified_by      text,
  verification_ref jsonb,
  conflict_id      text,
  created_ts       double precision NOT NULL,
  updated_ts       double precision NOT NULL,
  expires_ts       double precision,
  PRIMARY KEY (fact_id, revision)
);
CREATE INDEX IF NOT EXISTS shared_facts_scope_idx   ON shared_facts (facility_id, fault_kind, asset_type, status);
CREATE INDEX IF NOT EXISTS shared_facts_subject_idx ON shared_facts (facility_id, subject_key, status);
CREATE INDEX IF NOT EXISTS shared_facts_run_idx     ON shared_facts (run_id, incident_id, status);
CREATE INDEX IF NOT EXISTS shared_facts_expiry_idx  ON shared_facts (expires_ts) WHERE expires_ts IS NOT NULL;

CREATE TABLE IF NOT EXISTS procedural_lessons (
  lesson_id        text    NOT NULL,
  revision         integer NOT NULL CHECK (revision >= 1),
  facility_id      text    NOT NULL,
  run_id           text    NOT NULL,
  incident_id      text,
  fault_kind       text    NOT NULL,
  asset_type       text,
  topology_revision text,
  subject_key      text    NOT NULL,                 -- situation key: fault_kind|asset_type|precondition hash
  title            text    NOT NULL,
  steps            jsonb   NOT NULL DEFAULT '[]'::jsonb,
  steps_hash       text    NOT NULL,
  expected_outcome text    NOT NULL DEFAULT '',
  preconditions    jsonb   NOT NULL DEFAULT '{}'::jsonb,
  evidence_ids     jsonb   NOT NULL DEFAULT '[]'::jsonb,
  source_run_ids   jsonb   NOT NULL DEFAULT '[]'::jsonb,
  event_refs       jsonb   NOT NULL DEFAULT '[]'::jsonb,
  confidence       double precision NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  success_count    integer NOT NULL DEFAULT 0,
  failure_count    integer NOT NULL DEFAULT 0,
  status           text    NOT NULL CHECK (status IN ('PROPOSED','VERIFIED','CONFLICTED','REJECTED','EXPIRED','ARCHIVED')),
  status_reason    text    NOT NULL DEFAULT '',
  visibility       text    NOT NULL DEFAULT 'run' CHECK (visibility IN ('run','shared')),
  proposed_by      text    NOT NULL DEFAULT '',
  verified_by      text,
  verification_ref jsonb,
  conflict_id      text,
  created_ts       double precision NOT NULL,
  updated_ts       double precision NOT NULL,
  expires_ts       double precision,
  PRIMARY KEY (lesson_id, revision)
);
CREATE INDEX IF NOT EXISTS procedural_lessons_scope_idx ON procedural_lessons (facility_id, fault_kind, asset_type, status);
CREATE INDEX IF NOT EXISTS procedural_lessons_run_idx   ON procedural_lessons (run_id, incident_id, status);
CREATE INDEX IF NOT EXISTS procedural_lessons_expiry_idx ON procedural_lessons (expires_ts) WHERE expires_ts IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_conflicts (
  conflict_id      text PRIMARY KEY,
  facility_id      text NOT NULL,
  item_kind        text NOT NULL CHECK (item_kind IN ('fact','lesson')),
  subject_key      text NOT NULL,
  items            jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{id, revision, run_id, value_hash}] - every side is kept
  status           text NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
  detected_run_id  text,
  detected_ts      double precision NOT NULL,
  resolved_ts      double precision,
  resolved_by      text,
  resolution       jsonb
);
CREATE INDEX IF NOT EXISTS memory_conflicts_subject_idx ON memory_conflicts (facility_id, subject_key, status);

CREATE TABLE IF NOT EXISTS playbook_versions (
  playbook_id      text    NOT NULL,
  version          integer NOT NULL CHECK (version >= 1),
  parent_version   integer,
  facility_id      text    NOT NULL,
  fault_kind       text    NOT NULL,
  doc              jsonb   NOT NULL,                     -- candidate playbook (steps/preconditions) distilled from verified lessons
  lesson_refs      jsonb   NOT NULL DEFAULT '[]'::jsonb,
  status           text    NOT NULL CHECK (status IN ('CANDIDATE','ACCEPTED','REJECTED')),
  evaluation       jsonb,                                -- held-out evaluation record (accepted OR honestly rejected)
  created_ts       double precision NOT NULL,
  updated_ts       double precision NOT NULL,
  PRIMARY KEY (playbook_id, version)
);
CREATE INDEX IF NOT EXISTS playbook_versions_fault_idx ON playbook_versions (facility_id, fault_kind, status);
