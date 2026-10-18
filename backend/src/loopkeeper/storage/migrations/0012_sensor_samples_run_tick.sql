-- V12 size emergency (agent AA): the 60 s rolling prune `DELETE FROM sensor_samples WHERE run_id=$1 AND tick < $2` and the chart-window read could only
-- use sensor_samples_idx (run_id, sensor_id, metric, tick), whose tick is the 4th column, so each prune scanned the whole run (944 seq scans /
-- 362 M tuples read on Neon). (run_id, tick) makes both an index range scan. Idempotent and additive.
-- The index costs ~10 MB: while the database is within 15 % of the 1 GiB cap the migration SKIPS it (the size guard in storage/maintenance.py
-- creates it later, CONCURRENTLY, once there is headroom) so a startup migration can never be the write that fills the project.
DO $$
BEGIN
  IF pg_database_size(current_database()) < 0.85 * 1073741824 THEN
    CREATE INDEX IF NOT EXISTS sensor_samples_run_tick_idx ON sensor_samples (run_id, tick);
  ELSE
    RAISE NOTICE 'sensor_samples_run_tick_idx skipped: database above 85 percent of the 1 GiB cap (storage.maintenance creates it later)';
  END IF;
END $$;
