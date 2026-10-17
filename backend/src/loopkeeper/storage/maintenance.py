"""Opt-in storage maintenance for the Neon project size budget (1 GB): `python -m loopkeeper.storage.maintenance [--apply]  (the same thinning also runs automatically at engine start, LOOPKEEPER_RETENTION=off disables it)`.

Dry-run by default: prints, per STOPPED run, the snapshot / event volume and what thinning would reclaim. With --apply it thins the INTERVAL
snapshots of stopped runs to every Nth one (first, last and every incident / fork-origin / shutdown snapshot are always kept, so checkpoints that
forks and incident replays depend on survive) and nothing else: events and commands are never touched, the live run is never touched.
Space is only returned to the project by TRUNCATE-style rewrite, so this prints the numbers instead of promising a size."""
from __future__ import annotations

import argparse
import os
import sys


def _url() -> str:
    u = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not u:
        env = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", ".env")
        for line in open(os.path.abspath(env)):
            if line.startswith("DATABASE_URL_UNPOOLED="):
                u = line.split("=", 1)[1].strip().strip('"')
    if not u:
        sys.exit("no DATABASE_URL")
    return u


def main(argv: list[str] | None = None) -> int:
    import psycopg
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--keep-every", type=int, default=10, help="keep every Nth interval snapshot of a stopped run")
    ap.add_argument("--min-snapshots", type=int, default=400, help="only thin runs with more interval snapshots than this")
    a = ap.parse_args(argv)
    with psycopg.connect(_url(), autocommit=True) as c:
        live = {r[0] for r in c.execute("SELECT run_id FROM simulation_runs WHERE phase IN ('running','paused') AND kind <> 'fork'").fetchall()}
        print("project size:", c.execute("SELECT pg_size_pretty(pg_database_size(current_database()))").fetchone()[0])
        for rid, n, sz in c.execute("SELECT run_id, count(*), pg_size_pretty(sum(pg_column_size(state) + pg_column_size(world))::bigint) FROM world_snapshots "
                                     "GROUP BY 1 ORDER BY 1").fetchall():
            ev = c.execute("SELECT count(*), pg_size_pretty(sum(pg_column_size(payload))::bigint) FROM world_events WHERE run_id=%s", (rid,)).fetchone()
            interval = c.execute("SELECT count(*) FROM world_snapshots WHERE run_id=%s AND reason='interval'", (rid,)).fetchone()[0]
            tag = "ACTIVE (never touched)" if rid in live else ("thinnable" if interval > a.min_snapshots else "small")
            print(f"{rid:14s} snapshots {n:5d} ({sz}), interval {interval:5d}; events {ev[0]} ({ev[1]}) -> {tag}")
            if a.apply and rid not in live and interval > a.min_snapshots:
                cur = c.execute(
                    "WITH ranked AS (SELECT snapshot_id, row_number() OVER (ORDER BY tick, last_seq) rn, count(*) OVER () total FROM world_snapshots "
                    "WHERE run_id=%s AND reason='interval') DELETE FROM world_snapshots s USING ranked r WHERE s.snapshot_id=r.snapshot_id "
                    "AND r.rn % %s <> 0 AND r.rn <> 1 AND r.rn <> r.total", (rid, a.keep_every))
                print(f"   thinned: deleted {cur.rowcount} interval snapshots (kept every {a.keep_every}th, first and last, and all non-interval ones)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
