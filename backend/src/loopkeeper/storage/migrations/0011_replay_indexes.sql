-- V12 replay speed (idempotent, additive). A replay window reads world_events by (run_id, tick range) and ordering (tick, seq):
-- the partial index below covers exactly the persisted, replayable kinds (stream-only telemetry is excluded, as in the query) so the
-- window is an index range scan whatever the run length. Operator commands are filtered by their applied tick the same way.
-- The predicates are repeated literally in the queries (storage/postgres.py replay_* methods): keep both in sync.
CREATE INDEX IF NOT EXISTS world_events_replay_idx ON world_events (run_id, tick, seq)
  WHERE kind NOT IN ('world.diff', 'heartbeat', 'engine.health');
CREATE INDEX IF NOT EXISTS commands_operator_tick_idx ON commands (run_id, (COALESCE(applied_tick, issued_tick)))
  WHERE actor_type = 'operator';
