-- facility_layout_v6: topologies are versioned and never overwritten. `facilities` keeps the CURRENT topology (upserted at boot);
-- every topology that was ever registered also lives here, keyed by its hash, so a run recorded on layout X can be replayed / forked on
-- layout X after the facility has moved to layout Y. Backfill = the one copy that existed before this migration (the row in `facilities`).
CREATE TABLE IF NOT EXISTS facility_topologies (
  facility_id      text NOT NULL REFERENCES facilities(id),
  topology_hash    text NOT NULL,
  config_version   text NOT NULL,
  topology_version text NOT NULL,
  topology         jsonb NOT NULL,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (facility_id, topology_hash)
);

INSERT INTO facility_topologies (facility_id, topology_hash, config_version, topology_version, topology)
  SELECT id, topology_hash, config_version, config_version || '#' || topology_hash, topology FROM facilities
  ON CONFLICT DO NOTHING;

ALTER TABLE simulation_runs ADD COLUMN IF NOT EXISTS topology_version text;
UPDATE simulation_runs SET topology_version = config_version || '#' || topology_hash WHERE topology_version IS NULL;
