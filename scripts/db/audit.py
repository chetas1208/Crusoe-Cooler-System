#!/usr/bin/env python3
"""Read-only audit of the LOOPKEEPER Neon databases (primary control plane + telemetry plane).

    backend/.venv/bin/python scripts/db/audit.py [--env .env] [--json out.json] [--only primary|telemetry]

SELECT only: every session is opened with default_transaction_read_only=on and a statement_timeout, so DDL/DML is rejected by the server.
Connection strings are read from the environment or .env and are never printed (only host-less labels: primary / telemetry).
Re-runnable; exits 0 even when a check finds problems (findings are printed as WARN lines and counted in the summary).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "backend" / "src" / "loopkeeper" / "storage" / "migrations"
LIMIT_BYTES = 1 << 30   # Neon free-plan project size cap (1 GiB)
HOT = ["world_events", "world_snapshots", "sensor_samples", "agent_communications", "model_calls",
       "agent_decisions", "commands", "traffic_reservations", "robot_routes"]
WARN: list[str] = []


def load_env(path: Path) -> dict[str, str]:
    env = dict(os.environ)
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return env


def pretty(n: int | None) -> str:
    if n is None:
        return "-"
    f = float(n)
    for u in ("B", "kB", "MB", "GB"):
        if abs(f) < 1024 or u == "GB":
            return f"{f:.0f} {u}" if u == "B" else f"{f:.1f} {u}"
        f /= 1024
    return str(n)


def warn(msg: str) -> None:
    WARN.append(msg)
    print(f"  WARN: {msg}")


def q(c, sql, params=None):
    return c.execute(sql, params).fetchall()


def audit_db(label: str, url: str, peer_runs: set[str] | None = None) -> dict:
    import psycopg
    from psycopg.rows import dict_row
    out: dict = {"label": label}
    with psycopg.connect(url, row_factory=dict_row, autocommit=True, connect_timeout=15,
                         options="-c default_transaction_read_only=on -c statement_timeout=20000 -c application_name=loopkeeper_audit") as c:
        print(f"\n===== {label} =====")
        v = q(c, "SELECT version() v, current_setting('server_version_num') n")[0]
        print("server:", v["v"].split(",")[0])
        ro = q(c, "SHOW default_transaction_read_only")[0]
        assert list(ro.values())[0] == "on", "session is not read-only"

        # --- size
        dbsz = q(c, "SELECT pg_database_size(current_database()) b")[0]["b"]
        out["db_bytes"] = dbsz
        print(f"database size: {pretty(dbsz)} ({100*dbsz/LIMIT_BYTES:.1f}% of 1 GiB project cap; the cap is per PROJECT, i.e. all databases/branches summed)")
        if dbsz > 0.8 * LIMIT_BYTES:
            warn(f"{label} database is {100*dbsz/LIMIT_BYTES:.0f}% of the 1 GiB cap")

        # --- migrations
        files = {f.stem: hashlib.sha256(f.read_text().encode()).hexdigest() for f in sorted(MIGRATIONS.glob("*.sql"))}
        try:
            applied = {r["version"]: r for r in q(c, "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version")}
        except Exception as e:  # noqa: BLE001
            applied = {}
            warn(f"schema_migrations unreadable ({type(e).__name__})")
        print("\n-- schema_migrations")
        for ver, cs in files.items():
            a = applied.get(ver)
            st = "MISSING" if a is None else ("APPLIED" if a["checksum"] == cs else "CHECKSUM-DRIFT")
            print(f"  {ver:36s} {st:15s} {a['applied_at'].isoformat(timespec='seconds') if a else ''}")
            if st != "APPLIED":
                warn(f"{label}: migration {ver} {st}")
        for ver in applied.keys() - files.keys():
            warn(f"{label}: applied migration {ver} has no file")
        out["migrations"] = {k: ("ok" if k in applied and applied[k]["checksum"] == files[k] else "bad") for k in files}

        # --- tables
        print("\n-- tables (total incl. indexes/toast, heap, indexes, rows[exact if cheap else estimate], dead tuples)")
        tabs = q(c, """SELECT c.relname t, pg_total_relation_size(c.oid) tot, pg_relation_size(c.oid) heap,
                              pg_indexes_size(c.oid) idx, c.reltuples::bigint est,
                              COALESCE(s.n_dead_tup,0) dead, s.last_autovacuum, s.last_autoanalyze
                       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                       LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
                       WHERE c.relkind='r' AND n.nspname='public' ORDER BY tot DESC""")
        counts = {}
        for t in tabs:
            n = None
            if t["tot"] < 200 * 1024 * 1024:
                try:
                    n = q(c, f'SELECT count(*) n FROM "{t["t"]}"')[0]["n"]
                except Exception:  # noqa: BLE001
                    n = None
            counts[t["t"]] = n if n is not None else t["est"]
            tag = "" if n is not None else "~"
            print(f"  {t['t']:28s} {pretty(t['tot']):>10s} heap {pretty(t['heap']):>9s} idx {pretty(t['idx']):>9s} rows {tag}{counts[t['t']]:>10} dead {t['dead']:>8}")
        out["tables"] = {t["t"]: {"total": t["tot"], "rows": counts[t["t"]]} for t in tabs}
        names = {t["t"] for t in tabs}

        # --- hot spots / retention
        print("\n-- growth hot spots")
        for t in HOT:
            if t in names:
                row = next(x for x in tabs if x["t"] == t)
                print(f"  {t:24s} {pretty(row['tot']):>10s}  {100*row['tot']/max(dbsz,1):5.1f}% of db")
        if "world_snapshots" in names:
            print("  world_snapshots per run (count, interval, size):")
            for r in q(c, """SELECT run_id, count(*) n, count(*) FILTER (WHERE reason='interval') iv,
                                    sum(pg_column_size(state)+pg_column_size(world))::bigint sz, min(tick) t0, max(tick) t1
                             FROM world_snapshots GROUP BY 1 ORDER BY sz DESC NULLS LAST LIMIT 12"""):
                print(f"    {r['run_id']:16s} n={r['n']:6d} interval={r['iv']:6d} {pretty(r['sz']):>9s} ticks {r['t0']}..{r['t1']}")
        if "world_events" in names:
            print("  world_events per run (top 8):")
            for r in q(c, """SELECT run_id, count(*) n, sum(pg_column_size(payload))::bigint sz, min(ts) a, max(ts) b
                             FROM world_events GROUP BY 1 ORDER BY n DESC LIMIT 8"""):
                print(f"    {r['run_id']:16s} n={r['n']:8d} payload {pretty(r['sz']):>9s} {str(r['a'])[:19]} .. {str(r['b'])[:19]}")
        if "sensor_samples" in names:
            cols = {r["column_name"] for r in q(c, "SELECT column_name FROM information_schema.columns WHERE table_name='sensor_samples'")}
            tcol = "ts" if "ts" in cols else ("tick" if "tick" in cols else None)
            if tcol:
                r = q(c, f"SELECT count(*) n, count(DISTINCT run_id) runs, min({tcol}) a, max({tcol}) b FROM sensor_samples")[0]
                print(f"  sensor_samples: {r['n']} rows, {r['runs']} runs, {tcol} {r['a']} .. {r['b']}")
        for t, col in (("agent_communications", "created_at"), ("model_calls", "created_at")):
            if t in names:
                cols = {r["column_name"] for r in q(c, "SELECT column_name FROM information_schema.columns WHERE table_name=%s", (t,))}
                col = col if col in cols else next((x for x in ("ts", "at", "created_ts", "started_at") if x in cols), None)
                if col:
                    r = q(c, f'SELECT count(*) n, min("{col}") a, max("{col}") b FROM "{t}"')[0]
                    print(f"  {t}: {r['n']} rows, {col} {str(r['a'])[:19]} .. {str(r['b'])[:19]}")

        # --- FK constraints
        print("\n-- foreign keys (child.cols -> parent.cols, on-delete, validated)")
        fks = q(c, """SELECT con.conname, cl.relname child, pl.relname parent, con.confdeltype d, con.convalidated ok,
                             (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum,ord)
                                JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.attnum) ccols,
                             (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum,ord)
                                JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.attnum) pcols
                      FROM pg_constraint con JOIN pg_class cl ON cl.oid=con.conrelid JOIN pg_class pl ON pl.oid=con.confrelid
                      JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE con.contype='f' AND n.nspname='public' ORDER BY parent, child""")
        dmap = {"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}
        by_parent: dict[str, list[str]] = {}
        for f in fks:
            by_parent.setdefault(f["parent"], []).append(f["child"])
            print(f"  {f['child']}({','.join(f['ccols'])}) -> {f['parent']}({','.join(f['pcols'])}) {dmap[f['d']]}{'' if f['ok'] else ' NOT VALID'}   [{f['conname']}]")
        print("  referenced-by summary:")
        for p, kids in by_parent.items():
            print(f"    {p} <- {', '.join(sorted(set(kids)))}")
        out["fks"] = [(f["child"], f["parent"]) for f in fks]

        # --- orphans (generic over every FK: child rows with no parent)
        print("\n-- orphan rows per FK (child rows whose parent row is missing; expect 0)")
        for f in fks:
            if len(f["ccols"]) != 1:
                continue
            cc, pc = f["ccols"][0], f["pcols"][0]
            r = q(c, f'SELECT count(*) n FROM "{f["child"]}" ch WHERE ch."{cc}" IS NOT NULL AND NOT EXISTS '
                     f'(SELECT 1 FROM "{f["parent"]}" p WHERE p."{pc}"=ch."{cc}")')[0]["n"]
            if r:
                warn(f"{label}: {r} orphan {f['child']}.{cc} -> {f['parent']}")
        # soft references (no FK) that point at runs
        print("-- soft run references with no FK (rows referencing a run absent from THIS database's simulation_runs)")
        runs_here = {r["run_id"] for r in q(c, "SELECT run_id FROM simulation_runs")}
        out["runs"] = len(runs_here)
        out["run_ids"] = sorted(runs_here)
        fk_children = {f["child"] for f in fks if "run_id" in f["ccols"]}
        for t in sorted(names - fk_children - {"simulation_runs"}):
            has = q(c, "SELECT 1 FROM information_schema.columns WHERE table_name=%s AND column_name='run_id'", (t,))
            if has:
                r = q(c, f'SELECT count(*) n, count(DISTINCT run_id) d FROM "{t}" x WHERE run_id IS NOT NULL AND NOT EXISTS '
                         f'(SELECT 1 FROM simulation_runs s WHERE s.run_id=x.run_id)')[0]
                print(f"  {t:28s} dangling rows {r['n']} (runs {r['d']})")
        if "scenario_requests" in names:
            r = q(c, "SELECT count(*) n FROM scenario_requests r WHERE run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM simulation_runs s WHERE s.run_id=r.run_id)")[0]["n"]
            if r:
                warn(f"{label}: {r} scenario_requests reference missing runs")

        # --- cross-database run consistency
        if peer_runs is not None:
            miss = sorted(peer_runs - runs_here)
            print(f"\n-- cross-db: runs in the other plane missing here: {len(miss)} {miss[:5]}")
            out["missing_vs_peer"] = miss
        if label == "telemetry":
            for t in ("world_events", "world_snapshots", "sensor_samples"):
                if t in names:
                    r = q(c, f"SELECT count(DISTINCT run_id) d FROM {t}")[0]["d"]
                    print(f"  {t}: {r} distinct runs")

        # --- indexes
        print("\n-- indexes vs migrations")
        live_idx = {r["indexname"]: r for r in q(c, "SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname='public'")}
        want = set()
        for f in sorted(MIGRATIONS.glob("*.sql")):
            for m in re.finditer(r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", f.read_text(), re.I):
                want.add(m.group(1))
        missing = sorted(want - live_idx.keys())
        print(f"  migrations declare {len(want)} named indexes; live public indexes {len(live_idx)}; missing {len(missing)} {missing}")
        for m in missing:
            warn(f"{label}: index {m} declared in migrations but absent")
        invalid = q(c, "SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE NOT i.indisvalid")
        if invalid:
            warn(f"{label}: invalid indexes {[r['relname'] for r in invalid]}")
        unused = q(c, """SELECT s.relname t, s.indexrelname i, pg_relation_size(s.indexrelid) b, s.idx_scan FROM pg_stat_user_indexes s
                         JOIN pg_index x ON x.indexrelid=s.indexrelid WHERE s.idx_scan=0 AND NOT x.indisunique AND NOT x.indisprimary
                         ORDER BY b DESC LIMIT 8""")
        print("  never-scanned non-unique indexes (since stats reset; largest 8):")
        for u in unused:
            print(f"    {u['t']}.{u['i']} {pretty(u['b'])}")
        # FK columns without a supporting index (slow cascades / parent deletes)
        nofk = q(c, """SELECT cl.relname child, con.conname FROM pg_constraint con JOIN pg_class cl ON cl.oid=con.conrelid
                       WHERE con.contype='f' AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=con.conrelid AND i.indkey[0]=con.conkey[1])""")
        for r in nofk:
            print(f"  FK without leading index: {r['child']} [{r['conname']}]")

        # --- connections
        print("\n-- connections (this database)")
        for r in q(c, """SELECT COALESCE(NULLIF(application_name,''),'(none)') app, state, count(*) n FROM pg_stat_activity
                         WHERE datname=current_database() GROUP BY 1,2 ORDER BY n DESC"""):
            print(f"  {r['app'][:30]:30s} {str(r['state']):22s} {r['n']}")
        mc = q(c, "SELECT current_setting('max_connections') m, (SELECT count(*) FROM pg_stat_activity) t")[0]
        print(f"  total sessions {mc['t']} / max_connections {mc['m']}")
        for r in q(c, """SELECT pid, now()-xact_start age, state, left(regexp_replace(query,'\\s+',' ','g'),80) qy FROM pg_stat_activity
                         WHERE datname=current_database() AND xact_start IS NOT NULL AND now()-xact_start > interval '30 seconds'
                         AND pid<>pg_backend_pid()"""):
            warn(f"{label}: long transaction pid {r['pid']} age {r['age']} state {r['state']}: {r['qy']}")

        # --- slow queries
        print("\n-- slow-query candidates (pg_stat_statements)")
        try:
            rows = q(c, """SELECT calls, round(mean_exec_time::numeric,1) mean_ms, round(total_exec_time::numeric/1000,1) total_s,
                                  left(regexp_replace(query,'\\s+',' ','g'),110) qy FROM pg_stat_statements
                           WHERE query NOT ILIKE '%%pg_stat%%' ORDER BY total_exec_time DESC LIMIT 8""")
            for r in rows:
                print(f"  {r['total_s']:>8}s total {r['mean_ms']:>8}ms mean {r['calls']:>8} calls  {r['qy']}")
        except Exception as e:  # noqa: BLE001
            print(f"  pg_stat_statements unavailable ({type(e).__name__}); use Neon console / MCP list_slow_queries")
        seq = q(c, """SELECT relname, seq_scan, seq_tup_read, COALESCE(idx_scan,0) idx_scan, n_live_tup FROM pg_stat_user_tables
                      WHERE seq_scan>50 AND n_live_tup>5000 ORDER BY seq_tup_read DESC LIMIT 6""")
        print("  seq-scan heavy tables:")
        for r in seq:
            print(f"    {r['relname']:26s} seq_scan {r['seq_scan']:>8} seq_tup_read {r['seq_tup_read']:>12} idx_scan {r['idx_scan']:>8} rows~{r['n_live_tup']}")
        return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--env", default=str(ROOT / ".env"))
    ap.add_argument("--json", default=None)
    ap.add_argument("--only", choices=["primary", "telemetry"], default=None)
    a = ap.parse_args()
    env = load_env(Path(a.env))
    prim = env.get("DATABASE_URL_UNPOOLED") or env.get("DATABASE_URL")
    tele = env.get("TELEMETRY_DATABASE_URL_UNPOOLED") or env.get("TELEMETRY_DATABASE_URL")
    if not prim:
        print("no DATABASE_URL in env/.env")
        return 2
    res = {}
    try:
        import psycopg  # noqa: F401
    except ImportError:
        print("run with backend/.venv/bin/python")
        return 2
    if not a.only or a.only == "primary":
        res["primary"] = audit_db("primary", prim)
    if tele and tele != prim and (not a.only or a.only == "telemetry"):
        res["telemetry"] = audit_db("telemetry", tele)
    elif not tele or tele == prim:
        print("\n(telemetry db not configured separately: telemetry tables live in primary)")
    if "primary" in res and "telemetry" in res:
        total = res["primary"]["db_bytes"] + res["telemetry"]["db_bytes"]
        miss = sorted(set(res["primary"]["run_ids"]) - set(res["telemetry"]["run_ids"]))
        extra = sorted(set(res["telemetry"]["run_ids"]) - set(res["primary"]["run_ids"]))
        print(f"\n===== cross-plane runs =====\nin primary but missing in telemetry (first telemetry commit would raise ForeignKeyViolation): {miss}\nin telemetry only: {extra}")
        if miss:
            warn(f"telemetry plane lacks {len(miss)} primary run(s): {miss}")
        if extra:
            warn(f"telemetry plane has {len(extra)} run(s) absent from primary: {extra}")
        hp = re.search(r"@([^/:?]+)", prim); ht = re.search(r"@([^/:?]+)", tele)
        ep = lambda h: (h.group(1).split(".")[0].replace("-pooler", "") if h else "?")
        print(f"primary and telemetry on {'the SAME' if ep(hp) == ep(ht) else 'DIFFERENT'} compute endpoint "
              f"(project-size cap is per project; check via Neon console whether both endpoints belong to one project)")
        print(f"\n===== summary =====\nprimary {pretty(res['primary']['db_bytes'])} + telemetry {pretty(res['telemetry']['db_bytes'])} = {pretty(total)} "
              f"({100*total/LIMIT_BYTES:.1f}% of 1 GiB, if both are on one project)")
    print(f"findings: {len(WARN)}")
    for w in WARN:
        print("  -", w)
    if a.json:
        Path(a.json).write_text(json.dumps(res, default=str, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
