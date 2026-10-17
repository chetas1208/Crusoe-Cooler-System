-- V10 communications (idempotent, additive). A communication event IS a canonical world_events row of kind 'comm.<message_type>' (same run
-- sequence, same commit transaction as the runtime event it was derived from, delivered on the existing stream). This migration only adds
-- the typed projection: partial indexes for the REST filters and a read view with the CommunicationEventV1 columns. No second sequence,
-- no second table to keep in sync.
CREATE INDEX IF NOT EXISTS world_events_comm_seq_idx    ON world_events (run_id, seq DESC)                         WHERE kind LIKE 'comm.%';
CREATE INDEX IF NOT EXISTS world_events_comm_tick_idx   ON world_events (run_id, tick, seq)                        WHERE kind LIKE 'comm.%';
CREATE INDEX IF NOT EXISTS world_events_comm_thread_idx ON world_events (run_id, (payload->>'thread_id'), seq DESC) WHERE kind LIKE 'comm.%';
CREATE INDEX IF NOT EXISTS world_events_comm_class_idx  ON world_events (run_id, (payload->'sender'->>'class'), seq DESC) WHERE kind LIKE 'comm.%';

CREATE OR REPLACE VIEW agent_communications AS
SELECT run_id,
       seq,
       event_id,
       tick                                   AS sim_tick,
       (payload->>'sim_time_ms')::bigint      AS sim_time_ms,
       ts                                     AS wall_time_utc,
       substr(kind, 6)                        AS message_type,
       payload->>'subtype'                    AS subtype,
       payload->>'phase'                      AS phase,
       payload->>'status'                     AS status,
       payload->'sender'                      AS sender,
       payload->'recipient'                   AS recipient,
       payload->>'thread_id'                  AS thread_id,
       payload->>'task_id'                    AS task_id,
       payload->>'mission_id'                 AS mission_id,
       payload->>'incident_id'                AS incident_id,
       payload->>'asset_id'                   AS asset_id,
       payload->>'robot_id'                   AS robot_id,
       payload->>'summary'                    AS summary,
       payload->'evidence_ids'                AS evidence_ids,
       payload->>'model_provider'             AS model_provider,
       payload->>'model_id'                   AS model_id,
       payload->>'visibility'                 AS visibility,
       payload->>'schema_version'             AS schema_version,
       payload->'detail'                      AS detail,
       payload                                AS doc
FROM world_events
WHERE kind LIKE 'comm.%';
