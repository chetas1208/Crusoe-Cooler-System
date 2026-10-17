# V12 Neon audit (agent N)

Read-only. Taken 2026-10-17 ~23:10-23:25 UTC with `scripts/db/audit.py` (SELECT only, sessions forced `default_transaction_read_only=on`, no secrets printed). Re-run: `backend/.venv/bin/python scripts/db/audit.py [--json out.json]`. Nothing was changed in either database.

## 1. Headline findings

1. **Size emergency.** primary 187 MB + telemetry 729 MB (and growing) = ~916 MB = ~89 % of the 1 GiB cap (if both endpoints are one Neon project; they are different compute endpoints, confirm in the console). Telemetry grows ~100 MB/h (see 4). At this rate the cap is hit in well under 1 h: expect DiskFull again and physics halt.
2. **FK culprit for `commit failed (ForeignKeyViolation)` at 22:30:22Z found** (sec. 3). Fix is already in K's uncommitted `_mirror_run`; two runs are still missing in telemetry and need a backfill.
3. Migrations 0001-0010 applied on both databases, checksums match the files. No drift.
4. No orphan rows in either database for any FK.

## 2. Migrations / schema

| | primary | telemetry |
|---|---|---|
| 0001..0010 | all APPLIED, checksum = file | all APPLIED, checksum = file |
| applied-at | 0010 at 21:33:57Z | 0010 at 21:33:58Z |
| named indexes declared in migrations (33) | 0 missing | 0 missing |
| invalid indexes | none | none |

Both planes carry the full schema (the telemetry DB is a complete copy; only some tables are used there). Live public indexes: 80 each (includes PK/unique and the LangGraph checkpoint tables `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`, which are not in loopkeeper migrations).

## 3. The ForeignKeyViolation

FK constraints (identical in both DBs, 27): everything run-scoped references `simulation_runs(run_id)` (agent_decisions, agent_runs, applied_effects, camera_bookmarks, commands, control_leases, done_contracts, hazard_zones, incidents, missions, robot_routes, robots, run_exports, scenario_requests, sensor_samples, traffic_reservations, verification_results, verification_runs, world_events, world_snapshots; plus `simulation_runs.parent_run_id`). `simulation_runs.facility_id -> facilities`, `simulation_runs.scenario_id -> scenario_specs`, `assets`/`facility_topologies -> facilities`, `scenario_interpretations`/`scenario_jobs -> scenario_requests` (CASCADE). **Nothing references `incidents` or `world_events`.** All are NO ACTION and validated. V11 tables `model_calls`, `shared_facts`, `procedural_lessons`, `memory_conflicts`, `playbook_versions` deliberately have no FK; `done_contracts` has only the run FK.

Culprit (evidence, live data):
- Telemetry `scenario_specs` = {CR-01, CR-02}; primary = {CR-01, CR-02, CR-03, MD-02}.
- Primary has 7 runs, telemetry 5. Missing in telemetry: `run_v8_cr_03_d66a3c87e6` (created 09:01Z) and `run_v8_md_02_7aa38abe24` (created **22:30:16.9Z**, 5 s before the failure). These are exactly the runs whose `scenario_id` has no spec row in telemetry.
- Old `create_run` mirrored `simulation_runs` into telemetry inside `try/except: pass`. The insert violated `simulation_runs_scenario_id_fkey` (spec absent) and was swallowed; the first `_commit_telemetry` then inserted `world_events` with a run_id that telemetry did not have -> `world_events_run_id_fkey` -> ForeignKeyViolation -> engine halted.
- Neither run has any world_events/snapshots in either DB (no history persisted).
- Not the cause: no orphans anywhere; done_contracts/scenario_requests parents all exist (primary plane); the V11 write paths only touch the primary plane for contracts.
- Fix (K): `_mirror_run` copies facility + scenario spec + parent first, and `commit()` retries once after healing. Still to do: a one-off backfill (`_mirror_run` for the two missing runs; the audit prints them under "cross-plane runs").
- Side note: telemetry `simulation_runs.last_tick/last_seq` for run_live are stale (22572/13279 vs 1115487/123526 in primary) because run_update goes to primary only. Harmless, but do not read run progress from telemetry.

## 4. Sizes, growth, retention

Primary (187 MB): sensor_samples 90.7 MB (327k rows, ticks 24901-28891, **legacy pre-split data**), world_snapshots 43.3 MB (351), checkpoint_blobs 14.2, checkpoint_writes 12.4, world_events 8.2 MB (5.3k, legacy), checkpoints 3.4. Everything else < 1.3 MB. About 140 MB of the primary is stale telemetry from before the split (primary run_live events stop at 08:10Z, seq 28900).

Telemetry (729 MB): world_snapshots 534 -> 560 MB (803 rows; 99 % is TOAST: state 123 MB + world 64 MB + rng 4 MB compressed live data, the rest is vacuum-reusable space that the file does not give back), sensor_samples 105 MB (312k rows, rolling 3600-tick window, 42 MB of it indexes), world_events 23 MB (19.4k), checkpoints* ~19 MB. model_calls / agent_communications: **0 rows in `model_calls`; there is no `agent_communications` table** (communications are `world_events` with kind `comm.*`, 168 kB / 144 kB of partial indexes).

Growth: run_live writes 6-7 interval snapshots per wall-minute (snapshot every 60 sim-s at ~420x) at ~270 kB each = ~100 MB/h (hour 22:00: 418 snapshots, 115 MB; 23:00: 130 snapshots in 20 min). Snapshot "reason" mix last 90 min: interval 517, incident 43, shutdown 1.

Retention effectiveness: `apply_retention` thins only STOPPED runs (every 10th interval snapshot), never the active run; so the live run is unbounded. `compact_telemetry` rewrites sensor_samples only at engine start. `sensor_samples` prune runs in-commit every 60 s (works: window held at 3600 ticks) but there is no index usable for `DELETE ... WHERE run_id AND tick < X` except `sensor_samples_idx (run_id, sensor_id, metric, tick)`, whose tick is 4th, so the prune scans the run; the table shows 944 seq scans / 362 M tuples read (needs a (run_id,tick) check, see recs). Autovacuum works (toast table 115 autovacuums, 0 dead).

## 5. Orphans, indexes, connections, slow queries

- Orphans per FK: 0 in both DBs. Soft refs (model_calls, shared_facts, procedural_lessons): 0 dangling. scenario_requests -> runs fine.
- Cross-plane: 2 primary runs absent from telemetry (above); none the other way.
- Indexes never scanned yet (stats since last reset, low value): world_events comm_class/comm_thread, traffic_res_resource/owner, robot_routes_graph/robot_routes_robot, agent_decisions_run_tick, playbook_versions_fault_idx (all < 170 kB: ignore). FK columns with no leading index: scenario_requests.run_id, run_exports.run_id, simulation_runs.scenario_id / parent_run_id (all tiny tables).
- Connections: primary 14-16 sessions of max 112, mostly pgbouncer idle; one "idle in transaction" pgbouncer session seen once; no long transactions.
- Slow queries: `pg_stat_statements` extension is not installed (UndefinedTable); the Neon console/MCP `list_slow_queries` is the source. Only table-level signal: sensor_samples seq scans.

## 6. Recommendations (not applied)

1. **Size guard (urgent):** (a) thin the ACTIVE run's interval snapshots online (keep last N=60 interval + all incident/fault/shutdown; or rolling 2 h window) in the engine, not just at stop; (b) raise `snapshot_interval_s` at high sim speed (snapshot every >= 5 wall-s is plenty; replay shows 240 frames); (c) drop `world_snapshots.world` for interval rows (state blob already has it) or compress/delta; (d) alert/auto-throttle when `pg_database_size` of primary+telemetry > 80 % of 1 GiB (the audit script exposes the numbers; add to /health/detail).
2. **Reclaim now (owner action):** run `python -m loopkeeper.storage.maintenance --apply` equivalent for run_live is impossible while live; instead TRUNCATE-style clean of primary legacy telemetry (sensor_samples 91 MB, legacy world_events/snapshots ~50 MB; `compact_telemetry` already does this for sensor_samples at next engine start) and the old checkpoint_* rows (LangGraph threads, ~30 MB primary / ~18 MB telemetry; keep newest thread only). Deletes need VACUUM FULL / rewrite to return space to Neon.
3. **Retention windows:** sensor_samples 1 h rolling (current), world_snapshots stopped runs every 10th (current), active run <= 2 h interval window, checkpoint_* 24 h, world_events kinds `comm.*` / `agent.*` keep, high-frequency kinds already not persisted.
4. **Indexes:** none required for correctness. Optional: `CREATE INDEX ... ON sensor_samples (run_id, tick)` (~10 MB) so the 60 s prune DELETE and the chart window read stop seq-scanning (944 seq scans / 362 M tuples read); indexes on the 4 tiny FK columns are not worth it.
5. **Integrity:** backfill telemetry runs for the 2 missing run ids; add the audit's cross-plane check to the startup sequence (`_mirror_run` for all primary runs with phase running/paused); stop swallowing mirror errors silently (K's version logs a warning).
6. Install `pg_stat_statements` on the Neon project for real slow-query data.
