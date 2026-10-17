-- V11 model gateway audit: one row per provider call (network or frozen replay hit). No secrets, no reasoning text.
-- output_text is the assistant `content` frozen so replay/restart never re-calls the model.
CREATE TABLE IF NOT EXISTS model_calls (
    call_id          text PRIMARY KEY,
    run_id           text NOT NULL,
    provider         text NOT NULL,
    model            text NOT NULL,
    role             text NOT NULL,
    kind             text NOT NULL,
    schema_version   text NOT NULL,
    ts               timestamptz NOT NULL DEFAULT now(),
    idempotency_key  text,
    task_id          text,
    incident_id      text,
    parent_call_id   text,
    prompt_hash      text NOT NULL DEFAULT '',
    output_hash      text,
    latency_ms       integer NOT NULL DEFAULT 0,
    attempts         integer NOT NULL DEFAULT 0,
    http_status      integer,
    tokens_in        integer,
    tokens_out       integer,
    est_cost_usd     double precision,
    price_basis      text,
    source           text NOT NULL DEFAULT 'network',
    repair           boolean NOT NULL DEFAULT false,
    error            text,
    fallback_reason  text,
    output_text      text
);
CREATE INDEX IF NOT EXISTS model_calls_run_ts_idx ON model_calls (run_id, ts);
CREATE UNIQUE INDEX IF NOT EXISTS model_calls_run_idem_idx ON model_calls (run_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND source = 'network' AND error IS NULL;
