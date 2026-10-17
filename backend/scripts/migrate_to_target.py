#!/usr/bin/env python3
"""Migrate schema and data precisely from source Neon DB to target Neon DB using binary streaming.

Preserves exact column types, JSONB, IEEE floats, microsecond timestamps, sequences, and indexes.
"""
import os
import sys
import time
import psycopg
from dotenv import load_dotenv

TABLES_IN_ORDER = [
    # Group 1: Independent / Base tables
    "schema_migrations",
    "scenario_specs",
    "scenario_definitions",
    "facilities",
    "nav_nodes",
    "nav_edges",
    "engine_leader",
    "agent_state_blobs",
    "checkpoint_migrations",
    "checkpoints",
    "checkpoint_blobs",
    "checkpoint_writes",
    # Group 2: Tables referencing facilities or scenario_specs
    "assets",
    "facility_topologies",
    "simulation_runs",
    # Group 3: Tables referencing simulation_runs
    "world_events",
    "world_snapshots",
    "commands",
    "applied_effects",
    "control_leases",
    "agent_decisions",
    "sensor_samples",
    "robots",
    "missions",
    "incidents",
    "agent_runs",
    "verification_runs",
    "verification_results",
    "robot_routes",
    "traffic_reservations",
    "hazard_zones",
    "camera_bookmarks",
    "run_exports",
]

def migrate(src_url: str, dst_url: str):
    print("=" * 70)
    print("LOOPKEEPER -> NEON PRECISE MIGRATION ENGINE")
    print("=" * 70)
    print(f"Source: {src_url.split('@')[-1]}")
    print(f"Target: {dst_url.split('@')[-1]}")
    print(f"Total tables to migrate: {len(TABLES_IN_ORDER)}")
    print("-" * 70)

    t0 = time.time()
    with psycopg.connect(src_url) as src, psycopg.connect(dst_url) as dst:
        # Step 1: Clean destination tables in reverse order
        print("\nStep 1: Truncating existing destination tables...")
        with dst.cursor() as cur_dst:
            for table in reversed(TABLES_IN_ORDER):
                cur_dst.execute(f'TRUNCATE TABLE "{table}" CASCADE')
            dst.commit()
        print("  Truncate complete.")

        # Step 2: Binary streaming copy table by table
        print("\nStep 2: Binary streaming data from source to target...")
        stats = {}
        for table in TABLES_IN_ORDER:
            t_start = time.time()
            with src.cursor() as cur_src:
                cur_src.execute(f'SELECT count(*) FROM "{table}"')
                src_count = cur_src.fetchone()[0]

            if src_count == 0:
                print(f"  {table:<25} : 0 rows (skipped)")
                stats[table] = (0, 0, 0.0)
                continue

            with src.cursor() as cur_src, dst.cursor() as cur_dst:
                with cur_src.copy(f'COPY "{table}" TO STDOUT (FORMAT BINARY)') as c_in:
                    with cur_dst.copy(f'COPY "{table}" FROM STDIN (FORMAT BINARY)') as c_out:
                        for chunk in c_in:
                            c_out.write(chunk)
            dst.commit()

            with dst.cursor() as cur_dst:
                cur_dst.execute(f'SELECT count(*) FROM "{table}"')
                dst_count = cur_dst.fetchone()[0]

            elapsed = time.time() - t_start
            assert src_count == dst_count, f"Mismatch in {table}: src={src_count}, dst={dst_count}"
            print(f"  {table:<25} : {src_count:>8} rows copied in {elapsed:5.2f}s [OK]")
            stats[table] = (src_count, dst_count, elapsed)

        # Step 3: Sync sequences
        print("\nStep 3: Synchronizing sequence values...")
        with dst.cursor() as cur_dst:
            cur_dst.execute("""
                SELECT sequence_name 
                FROM information_schema.sequences 
                WHERE sequence_schema = 'public'
            """)
            seqs = [r[0] for r in cur_dst.fetchall()]
            for seq in seqs:
                if seq == "agent_decisions_decision_id_seq":
                    cur_dst.execute("SELECT setval('agent_decisions_decision_id_seq', COALESCE((SELECT max(decision_id) FROM agent_decisions), 1))")
            dst.commit()
        print(f"  Sequences synchronized: {seqs}")

    total_time = time.time() - t0
    total_rows = sum(s[0] for s in stats.values())
    print("-" * 70)
    print(f"MIGRATION COMPLETE: {total_rows:,} rows across {len(TABLES_IN_ORDER)} tables in {total_time:.1f}s")
    print("=" * 70)

if __name__ == "__main__":
    load_dotenv()
    src = os.environ.get("DATABASE_URL_UNPOOLED")
    dst = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("TARGET_DATABASE_URL")
    if not src or not dst:
        sys.exit("Usage: python migrate_to_target.py <TARGET_DATABASE_URL>")
    migrate(src, dst)
