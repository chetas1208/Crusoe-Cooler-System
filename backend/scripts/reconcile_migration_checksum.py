#!/usr/bin/env python3
"""One-off reconciliation for databases whose `0001_init` was applied from an earlier revision of the file (the live Neon DB: the schema was
created at 08:48 UTC on 2026-10-16 before the file was committed, then relaxed by hand). It compares the live public schema with the schema a
fresh 0001 creates (in a rolled-back scratch schema), prints the differences and, ONLY with --apply and only if the differences are limited to
the known nullability relaxations (codified in 0003), rewrites the recorded checksum. Nothing else is touched."""
import argparse, hashlib, os, sys
from pathlib import Path
import psycopg

ROOT = Path(__file__).resolve().parents[1]
SQL = ROOT / "src/loopkeeper/storage/migrations/0001_init.sql"
Q = ("select table_name, column_name, data_type from information_schema.columns where table_schema=%s and table_name not in "
     "('schema_migrations','checkpoints','checkpoint_blobs','checkpoint_writes','checkpoint_migrations','mock_world_state','facility_topologies') order by 1,2")

def main() -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("--apply", action="store_true"); a = ap.parse_args()
    for line in (ROOT.parent / ".env").read_text().splitlines():
        if line.startswith("DATABASE_URL_UNPOOLED="):
            url = line.split("=", 1)[1].strip().strip('"')
    sql = SQL.read_text(); want = hashlib.sha256(sql.encode()).hexdigest()
    with psycopg.connect(url) as c:
        have = c.execute("select checksum from schema_migrations where version='0001_init'").fetchone()
        print("recorded:", have and have[0][:12], "file:", want[:12])
        c.execute("create schema lk_probe"); c.execute("set search_path=lk_probe"); c.execute(sql)
        fresh, live = set(c.execute(Q, ("lk_probe",)).fetchall()), set(c.execute(Q, ("public",)).fetchall())
        c.rollback()
    print("columns only in a fresh 0001:", sorted(fresh - live)); print("columns only in the live schema:", sorted(live - fresh))
    if fresh != live:
        print("DIFFERENT (column set/type): refusing to touch the checksum"); return 1
    if a.apply and have and have[0] != want:
        with psycopg.connect(url) as c:
            c.execute("update schema_migrations set checksum=%s where version='0001_init'", (want,)); c.commit()
        print("checksum updated")
    return 0

if __name__ == "__main__":
    sys.exit(main())
