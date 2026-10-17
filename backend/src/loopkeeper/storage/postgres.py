"""PostgreSQL storage (psycopg3 + plain SQL migrations). All SQL is parameterised; identifiers are static.

Single-writer enforcement: a dedicated autocommit connection holds a session-level advisory lock per
facility (the leader lease). Every commit re-checks the leader epoch row so a deposed writer cannot write."""
from __future__ import annotations

import hashlib
import threading
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .base import (RUN_UPDATE_FIELDS, CommitBatch, LeaderLease, LeadershipLost, Storage, StorageError)

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
LOCK_NS = 0x4C4B5052  # 'LKPR' advisory-lock namespace


def _iso(v: Any) -> Any:
    if isinstance(v, datetime):
        return v.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{v.microsecond // 1000:03d}Z"
    return v


def _key32(s: str) -> int:
    n = int.from_bytes(hashlib.sha256(s.encode()).digest()[:4], "big")
    return n - (1 << 32) if n >= (1 << 31) else n


def _j(x: Any) -> Jsonb:
    return Jsonb(x)


class _PgLease(LeaderLease):
    def __init__(self, conn: psycopg.Connection, facility_id: str, holder: str, epoch: int):
        self._conn, self.facility_id, self.holder, self.epoch = conn, facility_id, holder, epoch
        self._lock = threading.Lock()
        self._ok = True

    def held(self) -> bool:
        if not self._ok:
            return False
        with self._lock:
            try:
                self._conn.execute("SELECT 1")
                return True
            except Exception:
                self._ok = False
                return False

    def heartbeat(self) -> bool:
        if not self.held():
            return False
        with self._lock:
            try:
                cur = self._conn.execute(
                    "UPDATE engine_leader SET heartbeat_at = now() WHERE facility_id = %s AND epoch = %s",
                    (self.facility_id, self.epoch))
                if cur.rowcount != 1:  # someone bumped the epoch: we were deposed
                    self._ok = False
                return self._ok
            except Exception:
                self._ok = False
                return False

    def release(self) -> None:
        with self._lock:
            self._ok = False
            try:
                self._conn.execute("SELECT pg_advisory_unlock(%s, %s)", (LOCK_NS, _key32(self.facility_id)))
            except Exception:
                pass
            try:
                self._conn.close()
            except Exception:
                pass


class PostgresStorage(Storage):
    kind = "postgres"

    def __init__(self, url: str, *, telemetry_url: str | None = None, min_size: int = 1, max_size: int = 8, connect_timeout: float = 5.0):
        self._url = url
        self._telemetry_url = telemetry_url
        self._last_sample_prune: dict[str, float] = {}
        try:
            self.pool = ConnectionPool(url, min_size=min_size, max_size=max_size, open=False,
                                       kwargs={"row_factory": dict_row, "connect_timeout": int(connect_timeout),
                                               "options": "-c timezone=UTC"})
            self.pool.open(wait=True, timeout=connect_timeout * 2)
        except Exception as e:  # never leak the DSN (may hold a password)
            raise StorageError(f"database unavailable ({type(e).__name__})") from None

        self.telemetry_pool = self.pool
        if telemetry_url and telemetry_url != url:
            try:
                t_pool = ConnectionPool(telemetry_url, min_size=min_size, max_size=max_size, open=False,
                                        kwargs={"row_factory": dict_row, "connect_timeout": int(connect_timeout),
                                                "options": "-c timezone=UTC"})
                t_pool.open(wait=True, timeout=connect_timeout * 2)
                self.telemetry_pool = t_pool
            except Exception as e:
                import logging
                logging.getLogger("loopkeeper.storage").warning("telemetry database unavailable (%s); falling back to primary", type(e).__name__)
                self.telemetry_pool = self.pool

    # ---- lifecycle -----------------------------------------------------
    def close(self) -> None:
        try:
            self.pool.close()
        except Exception:
            pass
        if self.telemetry_pool is not self.pool:
            try:
                self.telemetry_pool.close()
            except Exception:
                pass

    def ping(self) -> bool:
        try:
            with self.pool.connection(timeout=2.0) as c:
                c.execute("SELECT 1")
            if self.telemetry_pool is not self.pool:
                with self.telemetry_pool.connection(timeout=2.0) as c:
                    c.execute("SELECT 1")
            return True
        except Exception:
            return False

    def _run_migrations(self, pool: ConnectionPool) -> None:
        with pool.connection() as conn:
            with conn.transaction():
                conn.execute("SELECT pg_advisory_xact_lock(%s, %s)", (LOCK_NS, 1))
                conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, "
                             "checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())")
                done = {r["version"]: r["checksum"] for r in conn.execute("SELECT version, checksum FROM schema_migrations")}
                for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
                    sql = f.read_text()
                    cs = hashlib.sha256(sql.encode()).hexdigest()
                    if f.stem in done:
                        if done[f.stem] != cs:
                            raise StorageError(f"migration {f.stem} was modified after being applied")
                        continue
                    conn.execute(sql)
                    conn.execute("INSERT INTO schema_migrations (version, checksum) VALUES (%s, %s)", (f.stem, cs))

    def migrate(self) -> None:
        try:
            self._run_migrations(self.pool)
            if self.telemetry_pool is not self.pool:
                self._run_migrations(self.telemetry_pool)
        except StorageError:
            raise
        except Exception as e:
            raise StorageError(f"migration failed ({type(e).__name__})") from None

    # ---- facility / leader / scenarios --------------------------------
    def _register_facility_pool(self, pool: ConnectionPool, facility_id, config_version, topology_hash, dims, topology) -> None:
        with pool.connection() as conn, conn.transaction():
            conn.execute(
                "INSERT INTO facilities (id, config_version, topology_hash, dimensions, topology) VALUES (%s,%s,%s,%s,%s) "
                "ON CONFLICT (id) DO UPDATE SET config_version=EXCLUDED.config_version, topology_hash=EXCLUDED.topology_hash, "
                "dimensions=EXCLUDED.dimensions, topology=EXCLUDED.topology",
                (facility_id, config_version, topology_hash, _j(dims), _j(topology)))
            conn.execute(
                "INSERT INTO facility_topologies (facility_id, topology_hash, config_version, topology_version, topology) VALUES (%s,%s,%s,%s,%s) "
                "ON CONFLICT (facility_id, topology_hash) DO NOTHING",              # never overwritten: old runs keep their layout
                (facility_id, topology_hash, config_version,
                 topology.get("facility", {}).get("topology_version") or f"{config_version}#{topology_hash}", _j(topology)))
            rows = [(facility_id, config_version, a["id"], a["type"], a.get("loop"),
                     _j({"position_xyz_m": a.get("position_xyz_m"), "edge_id": a.get("edge_id"), "s_m": a.get("s_m"),
                         "service_xyz_m": a.get("service_xyz_m")}), _j(a.get("accessible_by", [])))
                    for a in topology.get("assets", [])]
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO assets (facility_id, config_version, asset_id, type, loop_id, geometry, access_mode) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING", rows)

    def register_facility(self, facility_id, config_version, topology_hash, topology) -> None:
        fac = topology.get("facility", {})
        dims = {k: fac.get(k) for k in ("bounds_min", "bounds_max", "interior_min", "interior_max", "wall_height_m")}
        self._register_facility_pool(self.pool, facility_id, config_version, topology_hash, dims, topology)
        if self.telemetry_pool is not self.pool:
            try:
                self._register_facility_pool(self.telemetry_pool, facility_id, config_version, topology_hash, dims, topology)
            except Exception:
                pass

    def get_topology(self, facility_id, topology_hash):
        with self.pool.connection() as c:
            r = c.execute("SELECT topology FROM facility_topologies WHERE facility_id=%s AND topology_hash=%s", (facility_id, topology_hash)).fetchone()
        return r["topology"] if r else None

    def compact_telemetry(self, keep_run_id: str) -> dict:
        """Startup maintenance: `sensor_samples` is a rolling chart window of the ACTIVE run only (replay uses snapshots + the event ledger), but
        the rows of every earlier run used to stay forever and filled Neon's project size limit (DiskFull halted physics). Keep the active run's
        rows, drop the rest and give the space back: DELETE alone does not shrink the project, so copy-out / TRUNCATE / copy-in (autocommit, before
        the engine writes)."""
        import io
        out = {"kept_rows": 0, "dropped_rows": 0}
        t_url = self._telemetry_url or self._url
        try:
            with psycopg.connect(t_url, autocommit=True, connect_timeout=10) as c:
                total = c.execute("SELECT count(*) AS n FROM sensor_samples").fetchone()[0]
                keep = c.execute("SELECT count(*) AS n FROM sensor_samples WHERE run_id = %s", (keep_run_id,)).fetchone()[0]
                if total - keep < 50_000:                      # nothing worth reclaiming
                    return {"kept_rows": keep, "dropped_rows": 0}
                buf = io.BytesIO()
                with c.cursor().copy("COPY (SELECT * FROM sensor_samples WHERE run_id = %s) TO STDOUT", (keep_run_id,)) as cp:
                    for d in cp:
                        buf.write(bytes(d))
                buf.seek(0)
                c.execute("TRUNCATE sensor_samples")
                with c.cursor().copy("COPY sensor_samples FROM STDIN") as cp:
                    while chunk := buf.read(1 << 20):
                        cp.write(chunk)
                out = {"kept_rows": keep, "dropped_rows": total - keep}
        except Exception as e:                               # noqa: BLE001
            return {"error": type(e).__name__, **out}
        return out

    def apply_retention(self, active_run_id: str, keep_every: int = 10, min_interval: int = 400) -> dict:
        """Automatic retention for STOPPED runs (never the active run, never a fork's own checkpoint): thin their INTERVAL snapshots to every
        `keep_every`-th (the first, the last and every incident / fork-origin / shutdown snapshot always survive, so forks and incident replays keep
        working; replay shows at most 240 frames anyway). Events are an append-only ledger (a DB trigger rejects DELETE), so they are untouched; instead stream-only `world.diff` events are no longer persisted per tick. After a big thinning the table is rewritten
        (VACUUM FULL) because DELETE alone never returns space to a Neon project."""
        out = {"runs": {}, "deleted": 0}
        t_url = self._telemetry_url or self._url
        try:
            with psycopg.connect(t_url, autocommit=True, connect_timeout=10) as c:
                runs = [r[0] for r in c.execute(
                    "SELECT run_id FROM world_snapshots WHERE reason='interval' AND run_id <> %s GROUP BY run_id HAVING count(*) > %s", (active_run_id, min_interval)).fetchall()]
                for rid in runs:
                    cur = c.execute(
                        "WITH ranked AS (SELECT snapshot_id, row_number() OVER (ORDER BY tick, last_seq) rn, count(*) OVER () total FROM world_snapshots "
                        "WHERE run_id=%s AND reason='interval') DELETE FROM world_snapshots s USING ranked r WHERE s.snapshot_id=r.snapshot_id "
                        "AND r.rn %% %s <> 0 AND r.rn <> 1 AND r.rn <> r.total", (rid, keep_every))
                    out["runs"][rid] = cur.rowcount
                    out["deleted"] += cur.rowcount
                # the active run: keep the newest 150 interval snapshots dense, thin the older ones (it grows ~10 MB/hour otherwise)
                cur = c.execute(
                    "WITH ranked AS (SELECT snapshot_id, row_number() OVER (ORDER BY tick DESC, last_seq DESC) rn, count(*) OVER () total, "
                    "row_number() OVER (ORDER BY tick, last_seq) fwd FROM world_snapshots WHERE run_id=%s AND reason='interval') "
                    "DELETE FROM world_snapshots s USING ranked r WHERE s.snapshot_id=r.snapshot_id AND r.rn > 150 AND r.total > 150 "
                    "AND r.fwd %% %s <> 0 AND r.fwd <> 1", (active_run_id, keep_every))
                if cur.rowcount:
                    out["runs"][active_run_id] = cur.rowcount
                    out["deleted"] += cur.rowcount
                if out["deleted"] > 2000:
                    c.execute("VACUUM FULL world_snapshots")
            # LangGraph agent checkpoints: run on control DB
            with psycopg.connect(self._url, autocommit=True, connect_timeout=10) as c_ctrl:
                try:
                    cur = c_ctrl.execute(
                        "WITH old AS (SELECT thread_id, checkpoint_ns, checkpoint_id FROM (SELECT thread_id, checkpoint_ns, checkpoint_id, "
                        "row_number() OVER (PARTITION BY thread_id, checkpoint_ns ORDER BY checkpoint_id DESC) rn FROM checkpoints) q WHERE rn > 20), "
                        "w AS (DELETE FROM checkpoint_writes cw USING old WHERE cw.thread_id=old.thread_id AND cw.checkpoint_ns=old.checkpoint_ns "
                        "AND cw.checkpoint_id=old.checkpoint_id RETURNING 1) SELECT count(*) FROM w")
                    out["checkpoint_writes_deleted"] = cur.fetchone()[0]
                    cur = c_ctrl.execute(
                        "DELETE FROM checkpoints c USING (SELECT thread_id, checkpoint_ns, checkpoint_id FROM (SELECT thread_id, checkpoint_ns, checkpoint_id, "
                        "row_number() OVER (PARTITION BY thread_id, checkpoint_ns ORDER BY checkpoint_id DESC) rn FROM checkpoints) q WHERE rn > 20) old "
                        "WHERE c.thread_id=old.thread_id AND c.checkpoint_ns=old.checkpoint_ns AND c.checkpoint_id=old.checkpoint_id")
                    out["checkpoints_deleted"] = cur.rowcount
                    if out["checkpoints_deleted"] > 500:
                        c_ctrl.execute("VACUUM FULL checkpoint_writes")
                        c_ctrl.execute("VACUUM FULL checkpoints")
                except psycopg.errors.UndefinedTable:
                    pass                                    # no agent runtime tables in this database
        except Exception as e:                               # noqa: BLE001
            out["error"] = type(e).__name__
        return out

    def put_topology(self, facility_id, config_version, topology_hash, topology):
        with self.pool.connection() as c, c.transaction():
            cur = c.execute(
                "INSERT INTO facility_topologies (facility_id, topology_hash, config_version, topology_version, topology) VALUES (%s,%s,%s,%s,%s) "
                "ON CONFLICT (facility_id, topology_hash) DO NOTHING RETURNING 1",
                (facility_id, topology_hash, config_version,
                 topology.get("facility", {}).get("topology_version") or f"{config_version}#{topology_hash}", _j(topology)))
            return cur.fetchone() is not None

    def fork_run(self, child, snapshot):
        with self.pool.connection() as c, c.transaction():
            try:
                c.execute(
                    "INSERT INTO simulation_runs (run_id, parent_run_id, fork_tick, facility_id, config_version, topology_hash, topology_version, "
                    "scenario_id, seed, rng_stream, kind, label, phase, owner_id, engine_version, schema_version, sim_speed, dt_s, "
                    "last_tick, last_seq, last_apply_order, meta) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (child["run_id"], child["parent_run_id"], child["fork_tick"], child["facility_id"], child["config_version"],
                     child["topology_hash"], child.get("topology_version"), child.get("scenario_id"), child["seed"], child["rng_stream"],
                     "fork", child.get("label", ""), child["phase"], child.get("owner_id"), child["engine_version"], child["schema_version"],
                     child["sim_speed"], child["dt_s"], snapshot["tick"], snapshot["last_seq"], child.get("last_apply_order", 0),
                     _j(child.get("meta", {}))))
            except psycopg.errors.UniqueViolation:
                raise StorageError("run exists") from None
        if self.telemetry_pool is not self.pool:
            try:
                with self.telemetry_pool.connection() as c_t, c_t.transaction():
                    c_t.execute(
                        "INSERT INTO simulation_runs (run_id, parent_run_id, fork_tick, facility_id, config_version, topology_hash, topology_version, "
                        "scenario_id, seed, rng_stream, kind, label, phase, owner_id, engine_version, schema_version, sim_speed, dt_s, "
                        "last_tick, last_seq, last_apply_order, meta) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                        "ON CONFLICT (run_id) DO NOTHING",
                        (child["run_id"], child["parent_run_id"], child["fork_tick"], child["facility_id"], child["config_version"],
                         child["topology_hash"], child.get("topology_version"), child.get("scenario_id"), child["seed"], child["rng_stream"],
                         "fork", child.get("label", ""), child["phase"], child.get("owner_id"), child["engine_version"], child["schema_version"],
                         child["sim_speed"], child["dt_s"], snapshot["tick"], snapshot["last_seq"], child.get("last_apply_order", 0),
                         _j(child.get("meta", {}))))
            except Exception:
                pass
        with self.telemetry_pool.connection() as c_t, c_t.transaction():
            c_t.execute(
                "INSERT INTO world_snapshots (snapshot_id, run_id, facility_id, tick, last_seq, reason, state, world, rng_state, schema_version, "
                "engine_version, content_hash, world_hash, state_hash) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT DO NOTHING",
                (snapshot["snapshot_id"], child["run_id"], child["facility_id"], snapshot["tick"], snapshot["last_seq"], "fork_origin",
                 snapshot["state"], _j(snapshot["world"]), _j(snapshot["rng_state"]), snapshot["schema_version"], snapshot["engine_version"],
                 snapshot["content_hash"], snapshot["world_hash"], snapshot["state_hash"]))

    def get_facility(self, facility_id):
        with self.pool.connection() as c:
            r = c.execute("SELECT id, config_version, topology_hash, topology FROM facilities WHERE id=%s", (facility_id,)).fetchone()
        return r

    def acquire_leader(self, facility_id, holder):
        try:
            conn = psycopg.connect(self._url, autocommit=True, row_factory=dict_row, connect_timeout=5)
        except Exception:
            return None
        try:
            got = conn.execute("SELECT pg_try_advisory_lock(%s, %s) AS ok", (LOCK_NS, _key32(facility_id))).fetchone()["ok"]
            if not got:
                conn.close()
                return None
            row = conn.execute(
                "INSERT INTO engine_leader (facility_id, holder, epoch) VALUES (%s,%s,1) "
                "ON CONFLICT (facility_id) DO UPDATE SET holder=EXCLUDED.holder, epoch=engine_leader.epoch+1, "
                "acquired_at=now(), heartbeat_at=now() RETURNING epoch", (facility_id, holder)).fetchone()
            return _PgLease(conn, facility_id, holder, int(row["epoch"]))
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            return None

    def save_scenario(self, row) -> None:
        with self.pool.connection() as c, c.transaction():
            c.execute(
                "INSERT INTO scenario_specs (scenario_id, spec, creator, safety_policy, provenance) VALUES (%s,%s,%s,%s,%s) "
                "ON CONFLICT (scenario_id) DO NOTHING",
                (row["scenario_id"], _j(row["spec"]), row.get("creator"), _j(row.get("safety_policy", {})), _j(row.get("provenance", {}))))

    def get_scenario(self, scenario_id):
        with self.pool.connection() as c:
            return c.execute("SELECT scenario_id, spec, creator, safety_policy, provenance FROM scenario_specs WHERE scenario_id=%s",
                             (scenario_id,)).fetchone()

    # ---- runs ------------------------------------------------------------
    _RUN_COLS = ("run_id, parent_run_id, fork_tick, facility_id, config_version, topology_hash, topology_version, scenario_id, seed, rng_stream, "
                 "kind, label, phase, owner_id, engine_version, schema_version, sim_speed, dt_s, last_tick, last_seq, "
                 "last_apply_order, meta, created_at, updated_at")

    @staticmethod
    def _run(r: dict | None) -> dict | None:
        if r is None:
            return None
        r = dict(r)
        r["created_at"] = _iso(r["created_at"])
        r["updated_at"] = _iso(r["updated_at"])
        return r

    def create_run(self, row) -> None:
        with self.pool.connection() as c, c.transaction():
            try:
                c.execute(
                    "INSERT INTO simulation_runs (run_id, parent_run_id, fork_tick, facility_id, config_version, topology_hash, topology_version, "
                    "scenario_id, seed, rng_stream, kind, label, phase, owner_id, engine_version, schema_version, sim_speed, dt_s, "
                    "last_tick, last_seq, last_apply_order, meta) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (row["run_id"], row.get("parent_run_id"), row.get("fork_tick"), row["facility_id"], row["config_version"],
                     row["topology_hash"], row.get("topology_version") or f"{row['config_version']}#{row['topology_hash']}", row.get("scenario_id"), row["seed"], row["rng_stream"], row["kind"], row.get("label", ""),
                     row["phase"], row.get("owner_id"), row["engine_version"], row["schema_version"], row["sim_speed"], row["dt_s"],
                     row.get("last_tick", 0), row.get("last_seq", 0), row.get("last_apply_order", 0), _j(row.get("meta", {}))))
            except psycopg.errors.UniqueViolation:
                raise StorageError("run exists") from None
        if self.telemetry_pool is not self.pool:
            try:
                with self.telemetry_pool.connection() as c_t, c_t.transaction():
                    c_t.execute(
                        "INSERT INTO simulation_runs (run_id, parent_run_id, fork_tick, facility_id, config_version, topology_hash, topology_version, "
                        "scenario_id, seed, rng_stream, kind, label, phase, owner_id, engine_version, schema_version, sim_speed, dt_s, "
                        "last_tick, last_seq, last_apply_order, meta) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                        "ON CONFLICT (run_id) DO NOTHING",
                        (row["run_id"], row.get("parent_run_id"), row.get("fork_tick"), row["facility_id"], row["config_version"],
                         row["topology_hash"], row.get("topology_version") or f"{row['config_version']}#{row['topology_hash']}", row.get("scenario_id"), row["seed"], row["rng_stream"], row["kind"], row.get("label", ""),
                         row["phase"], row.get("owner_id"), row["engine_version"], row["schema_version"], row["sim_speed"], row["dt_s"],
                         row.get("last_tick", 0), row.get("last_seq", 0), row.get("last_apply_order", 0), _j(row.get("meta", {}))))
            except Exception:
                pass

    def get_run(self, run_id):
        with self.pool.connection() as c:
            return self._run(c.execute(f"SELECT {self._RUN_COLS} FROM simulation_runs WHERE run_id=%s", (run_id,)).fetchone())

    def list_runs(self, facility_id=None, phases=None, limit=200):
        with self.pool.connection() as c:
            rows = c.execute(
                f"SELECT {self._RUN_COLS} FROM simulation_runs WHERE (%s::text IS NULL OR facility_id=%s) "
                "AND (%s::text[] IS NULL OR phase = ANY(%s)) ORDER BY created_at DESC, run_id LIMIT %s",
                (facility_id, facility_id, phases, phases, int(limit))).fetchall()
        return [self._run(r) for r in rows]

    # whitelisted column -> static SQL fragment (no dynamic identifiers)
    _UPD = {
        "last_tick": "last_tick = %s", "last_seq": "last_seq = %s", "last_apply_order": "last_apply_order = %s",
        "phase": "phase = %s", "sim_speed": "sim_speed = %s", "label": "label = %s", "meta": "meta = %s",
        "nav_graph_revision": "nav_graph_revision = %s",
    }

    def update_run(self, run_id, **fields) -> None:
        bad = set(fields) - set(RUN_UPDATE_FIELDS)
        if bad:
            raise StorageError(f"field not updatable: {sorted(bad)}")
        with self.pool.connection() as c, c.transaction():
            self._update_run(c, run_id, fields)
        if self.telemetry_pool is not self.pool:
            try:
                with self.telemetry_pool.connection() as c_t, c_t.transaction():
                    self._update_run(c_t, run_id, fields)
            except Exception:
                pass

    def _update_run(self, c, run_id, fields):
        if not fields:
            return
        sets = [self._UPD[k] for k in fields]
        vals = [_j(v) if k == "meta" else v for k, v in fields.items()]
        c.execute("UPDATE simulation_runs SET " + ", ".join(sets) + ", updated_at = now() WHERE run_id = %s", (*vals, run_id))

    # ---- V7 navigation ---------------------------------------------------
    def register_nav_graph(self, kind, revision, nodes, edges) -> None:
        with self.pool.connection() as c, c.transaction():
            with c.cursor() as cur:
                cur.executemany("INSERT INTO nav_nodes (graph_revision, kind, node_id, doc) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                                [(revision, kind, n["id"], _j(n)) for n in nodes])
                cur.executemany("INSERT INTO nav_edges (graph_revision, kind, edge_id, node_a, node_b, length_m, doc) VALUES (%s,%s,%s,%s,%s,%s,%s) "
                                "ON CONFLICT DO NOTHING",
                                [(revision, kind, e["id"], e["a"], e["b"], float(e["length_m"]), _j(e)) for e in edges])

    def load_nav_graph(self, kind, revision):
        with self.pool.connection() as c:
            nodes = [r["doc"] for r in c.execute("SELECT doc FROM nav_nodes WHERE graph_revision=%s AND kind=%s ORDER BY node_id", (revision, kind)).fetchall()]
            edges = [r["doc"] for r in c.execute("SELECT doc FROM nav_edges WHERE graph_revision=%s AND kind=%s ORDER BY edge_id", (revision, kind)).fetchall()]
        return {"nodes": nodes, "edges": edges} if nodes else None

    def load_routes(self, run_id):
        with self.pool.connection() as c:
            return [r["doc"] for r in c.execute("SELECT doc FROM robot_routes WHERE run_id=%s ORDER BY created_tick NULLS FIRST, plan_id", (run_id,)).fetchall()]

    def load_reservations(self, run_id, state=None):
        with self.pool.connection() as c:
            return c.execute("SELECT plan_id, resource, owner, t0, t1, state, graph_revision FROM traffic_reservations WHERE run_id=%s "
                             "AND (%s::text IS NULL OR state=%s) ORDER BY resource, t0", (run_id, state, state)).fetchall()

    # ---- atomic commit -------------------------------------------------
    def commit(self, b: CommitBatch) -> None:
        try:
            # 1. Control & Mission plane commit on self.pool
            with self.pool.connection() as conn, conn.transaction():
                if b.leader_epoch is not None:
                    r = conn.execute("SELECT epoch FROM engine_leader WHERE facility_id=%s FOR SHARE", (b.facility_id,)).fetchone()
                    if not r or int(r["epoch"]) != b.leader_epoch:
                        raise LeadershipLost("stale leader epoch")
                with conn.cursor() as cur:
                    if b.commands:
                        cur.executemany(
                            "INSERT INTO commands (run_id, command_id, kind, target_id, issuer, actor_type, issued_tick, applied_tick, apply_order, "
                            "seq_at_apply, expected_world_version, args, preconditions, status, reason, outcome) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (run_id, command_id) DO UPDATE SET "
                            "applied_tick=EXCLUDED.applied_tick, apply_order=EXCLUDED.apply_order, seq_at_apply=EXCLUDED.seq_at_apply, "
                            "status=EXCLUDED.status, reason=EXCLUDED.reason, outcome=EXCLUDED.outcome",
                            [(b.run_id, c["command_id"], c["kind"], c.get("target_id"), c.get("issuer"), c["actor_type"], c["issued_tick"],
                              c.get("applied_tick"), c.get("apply_order"), c.get("seq_at_apply"), c.get("expected_world_version"),
                              _j(c.get("args", {})), _j(c.get("preconditions", {})), c["status"], c.get("reason"), _j(c.get("outcome", {})))
                             for c in b.commands])
                    if b.missions:
                        cur.executemany(
                            "INSERT INTO missions (run_id, mission_id, incident_id, robot_id, target, status, progress, outcome, opened_tick, closed_tick, doc) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (run_id, mission_id) DO UPDATE SET status=EXCLUDED.status, "
                            "progress=EXCLUDED.progress, outcome=EXCLUDED.outcome, closed_tick=EXCLUDED.closed_tick, doc=EXCLUDED.doc",
                            [(b.run_id, m["mission_id"], m.get("incident_id"), m["robot_id"], m["target_id"], m["status"], m["progress"],
                              m.get("outcome"), m["opened_tick"], m.get("closed_tick"), _j(m["doc"])) for m in b.missions])
                    if b.robots:
                        cur.executemany(
                            "INSERT INTO robots (run_id, robot_id, robot_class, location, health, battery_pct, mode, mission_id, control, doc, updated_tick) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (run_id, robot_id) DO UPDATE SET location=EXCLUDED.location, "
                            "health=EXCLUDED.health, battery_pct=EXCLUDED.battery_pct, mode=EXCLUDED.mode, mission_id=EXCLUDED.mission_id, "
                            "control=EXCLUDED.control, doc=EXCLUDED.doc, updated_tick=EXCLUDED.updated_tick",
                            [(b.run_id, r["robot_id"], r["robot_class"], _j(r["location"]), _j(r.get("health", {})), r["battery_pct"], r["mode"],
                              r.get("mission_id"), _j(r.get("control", {})), _j(r["doc"]), r["updated_tick"]) for r in b.robots])
                    if b.incidents:
                        cur.executemany(
                            "INSERT INTO incidents (run_id, incident_id, opened_tick, updated_tick, severity, status, closed_tick, close_reason, doc) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (run_id, incident_id) DO UPDATE SET updated_tick=EXCLUDED.updated_tick, "
                            "severity=EXCLUDED.severity, status=EXCLUDED.status, closed_tick=EXCLUDED.closed_tick, close_reason=EXCLUDED.close_reason, doc=EXCLUDED.doc",
                            [(b.run_id, i["incident_id"], i["opened_tick"], i["updated_tick"], i["severity"], i["status"], i.get("closed_tick"),
                              i.get("close_reason"), _j(i["doc"])) for i in b.incidents])
                    if b.agent_runs:
                        cur.executemany(
                            "INSERT INTO agent_runs (run_id, task_id, thread_id, parent_task_id, incident_id, role, provider, model, started_tick, ended_tick, state) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (run_id, task_id) DO UPDATE SET ended_tick=EXCLUDED.ended_tick, "
                            "provider=EXCLUDED.provider, model=EXCLUDED.model, state=EXCLUDED.state",
                            [(b.run_id, a["task_id"], a.get("thread_id"), a.get("parent_task_id"), a.get("incident_id"), a["role"], a.get("provider"),
                              a.get("model"), a.get("started_tick"), a.get("ended_tick"), _j(a["state"])) for a in b.agent_runs])
                    if b.verification_runs:
                        cur.executemany(
                            "INSERT INTO verification_runs (run_id, verification_id, incident_id, attempt, status, confidence, failed_reason, checks, doc) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (run_id, verification_id) DO UPDATE SET status=EXCLUDED.status, "
                            "confidence=EXCLUDED.confidence, failed_reason=EXCLUDED.failed_reason, checks=EXCLUDED.checks, doc=EXCLUDED.doc",
                            [(b.run_id, v["verification_id"], v["incident_id"], v["attempt"], v["status"], v.get("confidence"), v.get("failed_reason"),
                              _j(v.get("checks", [])), _j(v["doc"])) for v in b.verification_runs])
                    if getattr(b, "contracts", None):
                        cur.executemany(
                            "INSERT INTO done_contracts (run_id, contract_id, incident_id, version, state, terminal_state, frozen_hash, frozen_tick, updated_tick, doc) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (run_id, contract_id) DO UPDATE SET version=EXCLUDED.version, state=EXCLUDED.state, "
                            "terminal_state=EXCLUDED.terminal_state, frozen_hash=EXCLUDED.frozen_hash, frozen_tick=EXCLUDED.frozen_tick, "
                            "updated_tick=EXCLUDED.updated_tick, doc=EXCLUDED.doc",
                            [(b.run_id, k["contract_id"], k["incident_id"], k["version"], k["state"], k.get("terminal_state"), k.get("frozen_hash"),
                              k.get("frozen_tick"), k["updated_tick"], _j(k["doc"])) for k in b.contracts])
                    if b.routes:
                        cur.executemany(
                            "INSERT INTO robot_routes (run_id, plan_id, robot_id, kind, status, source, graph_revision, traffic_revision, created_tick, "
                            "depart_t, arrive_t, actual_arrival_t, eta_s, length_m, doc) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                            "ON CONFLICT (run_id, plan_id) DO UPDATE SET status=EXCLUDED.status, actual_arrival_t=EXCLUDED.actual_arrival_t, "
                            "arrive_t=EXCLUDED.arrive_t, doc=EXCLUDED.doc",
                            [(b.run_id, r["plan_id"], r["robot_id"], r["kind"], r["status"], r.get("source"), r["graph_revision"], int(r["traffic_revision"]),
                              r.get("created_tick"), r.get("depart_t"), r.get("arrive_t"), r.get("actual_arrival_t"), r.get("eta_s"), r.get("length_m"),
                              _j(r["doc"])) for r in b.routes])
                    if b.reservations:
                        cur.executemany(
                            "INSERT INTO traffic_reservations (run_id, plan_id, resource, owner, t0, t1, state, graph_revision, updated_tick) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (run_id, plan_id, resource, t0) DO UPDATE SET state=EXCLUDED.state, "
                            "t1=EXCLUDED.t1, updated_tick=EXCLUDED.updated_tick",
                            [(b.run_id, r["plan_id"], r["resource"], r["owner"], r["t0"], max(r["t1"], r["t0"] + 0.001), r["state"], r["graph_revision"],
                              r.get("updated_tick")) for r in b.reservations])
                    if b.leases:
                        cur.executemany(
                            "INSERT INTO control_leases (lease_id, run_id, robot_id, principal_id, connection_id, epoch, status, granted_tick, granted_at, "
                            "expires_at, last_heartbeat, last_command_seq, ended_reason, doc) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,to_timestamp(%s),"
                            "to_timestamp(%s),to_timestamp(%s),%s,%s,%s) ON CONFLICT (lease_id) DO UPDATE SET status=EXCLUDED.status, expires_at=EXCLUDED.expires_at, "
                            "last_heartbeat=EXCLUDED.last_heartbeat, last_command_seq=EXCLUDED.last_command_seq, ended_reason=EXCLUDED.ended_reason, doc=EXCLUDED.doc",
                            [(l["lease_id"], b.run_id, l["robot_id"], l["principal_id"], l.get("connection_id"), l["epoch"], l["status"], l.get("granted_tick"),
                              l.get("granted_at"), l.get("expires_at"), l.get("last_heartbeat"), l.get("last_command_seq", 0), l.get("ended_reason"),
                              _j(l)) for l in b.leases])
                    if b.applied_effects:
                        cur.executemany("INSERT INTO applied_effects (run_id, effect_key) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                                        [(b.run_id, k) for k in b.applied_effects])
                if b.run_update:
                    bad = set(b.run_update) - set(RUN_UPDATE_FIELDS)
                    if bad:
                        raise StorageError("field not updatable")
                    self._update_run(conn, b.run_id, b.run_update)

            # 2. Telemetry & Historian plane commit on self.telemetry_pool
            with self.telemetry_pool.connection() as conn_t, conn_t.transaction():
                with conn_t.cursor() as cur_t:
                    if b.events:
                        cur_t.executemany(
                            "INSERT INTO world_events (run_id, seq, event_id, facility_id, tick, sim_time_s, world_version, kind, entity_id, "
                            "actor_type, actor_id, payload, causal_parent_id, command_id, ts, schema_version, event_hash) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::timestamptz,%s,%s) ON CONFLICT (run_id, seq) DO NOTHING",
                            [(b.run_id, e["seq"], e["event_id"], e["facility_id"], e["tick"], e["sim_time_s"], e["world_version"], e["kind"],
                              e["entity_id"], e.get("actor_type", "system"), e.get("actor_id"), _j(e["payload"]), e.get("causal_parent_id"),
                              e.get("command_id"), e["ts"], e["schema_version"], e["event_hash"]) for e in b.events])
                    if b.snapshots:
                        cur_t.executemany(
                            "INSERT INTO world_snapshots (snapshot_id, run_id, facility_id, tick, last_seq, reason, state, world, rng_state, schema_version, "
                            "engine_version, content_hash, world_hash, state_hash) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                            [(s["snapshot_id"], b.run_id, b.facility_id, s["tick"], s["last_seq"], s["reason"], s["state"], _j(s["world"]), _j(s["rng_state"]),
                              s["schema_version"], s["engine_version"], s["content_hash"], s["world_hash"], s["state_hash"]) for s in b.snapshots])
                    if b.sensor_samples:
                        cur_t.executemany(
                            "INSERT INTO sensor_samples (run_id, tick, sim_time_s, sensor_id, metric, value, units, source, quality) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                            [(b.run_id, s["tick"], s["sim_time_s"], s["sensor_id"], s["metric"], s["value"], s.get("units", ""),
                              s.get("source", "plant.readings"), s.get("quality", "good")) for s in b.sensor_samples])
                        max_tick = b.sensor_samples[-1]["tick"]
                        now = time.monotonic()
                        if max_tick > 3600 and now - self._last_sample_prune.get(b.run_id, 0.0) > 60.0:
                            self._last_sample_prune[b.run_id] = now
                            cur_t.execute("DELETE FROM sensor_samples WHERE run_id = %s AND tick < %s", (b.run_id, max_tick - 3600))
        except (LeadershipLost, StorageError):
            raise
        except Exception as e:
            raise StorageError(f"commit failed ({type(e).__name__})") from None

    # ---- snapshots -----------------------------------------------------
    _SNAP_META = ("snapshot_id, run_id, tick, last_seq, reason, schema_version, engine_version, content_hash, world_hash, state_hash, created_at")

    def list_snapshots(self, run_id, to_tick=None):
        with self.telemetry_pool.connection() as c:
            rows = c.execute(f"SELECT {self._SNAP_META} FROM world_snapshots WHERE run_id=%s AND (%s::bigint IS NULL OR tick <= %s) "
                             "ORDER BY tick, last_seq", (run_id, to_tick, to_tick)).fetchall()
        return [{**r, "created_at": _iso(r["created_at"])} for r in rows]

    @staticmethod
    def _snap(r):
        if r is None:
            return None
        r = dict(r)
        r["state"] = bytes(r["state"])
        r["created_at"] = _iso(r["created_at"])
        return r

    def get_snapshot(self, run_id, snapshot_id):
        with self.telemetry_pool.connection() as c:
            r = c.execute("SELECT * FROM world_snapshots WHERE run_id=%s AND snapshot_id=%s", (run_id, snapshot_id)).fetchone()
        if not r and self.telemetry_pool is not self.pool:
            with self.pool.connection() as c_p:
                r = c_p.execute("SELECT * FROM world_snapshots WHERE run_id=%s AND snapshot_id=%s", (run_id, snapshot_id)).fetchone()
        return self._snap(r)

    def get_snapshot_worlds(self, run_id, snapshot_ids):
        """{snapshot_id: world doc} in ONE round trip (the replay window used one query per frame: 240 x ~35 ms on Neon = 8 s)."""
        if not snapshot_ids:
            return {}
        with self.telemetry_pool.connection() as c:
            rows = c.execute("SELECT snapshot_id, world FROM world_snapshots WHERE run_id=%s AND snapshot_id = ANY(%s)", (run_id, list(snapshot_ids))).fetchall()
        if not rows and self.telemetry_pool is not self.pool:
            with self.pool.connection() as c_p:
                rows = c_p.execute("SELECT snapshot_id, world FROM world_snapshots WHERE run_id=%s AND snapshot_id = ANY(%s)", (run_id, list(snapshot_ids))).fetchall()
        return {r["snapshot_id"]: r["world"] for r in rows}

    def latest_snapshot(self, run_id, max_tick=None, max_seq=None):
        with self.telemetry_pool.connection() as c:
            r = c.execute(
                "SELECT * FROM world_snapshots WHERE run_id=%s AND (%s::bigint IS NULL OR tick <= %s) AND (%s::bigint IS NULL OR last_seq <= %s) "
                "ORDER BY tick DESC, last_seq DESC LIMIT 1", (run_id, max_tick, max_tick, max_seq, max_seq)).fetchone()
        if not r and self.telemetry_pool is not self.pool:
            with self.pool.connection() as c_p:
                r = c_p.execute(
                    "SELECT * FROM world_snapshots WHERE run_id=%s AND (%s::bigint IS NULL OR tick <= %s) AND (%s::bigint IS NULL OR last_seq <= %s) "
                    "ORDER BY tick DESC, last_seq DESC LIMIT 1", (run_id, max_tick, max_tick, max_seq, max_seq)).fetchone()
        return self._snap(r)

    # ---- events --------------------------------------------------------
    def load_events(self, run_id, after_seq=0, until_seq=None, until_tick=None, limit=None, kinds=None, exclude_kinds=None):
        with self.telemetry_pool.connection() as c:
            rows = c.execute(
                "SELECT seq, event_id, facility_id, tick, sim_time_s, world_version, kind, entity_id, actor_type, actor_id, payload, "
                "causal_parent_id, command_id, ts, schema_version, event_hash FROM world_events WHERE run_id=%s AND seq > %s "
                "AND (%s::bigint IS NULL OR seq <= %s) AND (%s::bigint IS NULL OR tick <= %s) AND (%s::text[] IS NULL OR kind = ANY(%s)) "
                "AND (%s::text[] IS NULL OR NOT (kind = ANY(%s))) ORDER BY seq LIMIT %s",
                (run_id, after_seq, until_seq, until_seq, until_tick, until_tick, kinds, kinds, exclude_kinds, exclude_kinds, limit)).fetchall()
        for r in rows:
            r["ts"] = _iso(r["ts"])
        return rows

    def load_communications(self, run_id, *, after_seq=0, before_seq=None, until_tick=None, limit=100, message_type=None, agent_class=None,
                            thread_id=None, newest_first=False, event_id=None):
        limit = max(1, min(int(limit), 1000))
        order = "DESC" if newest_first else "ASC"
        with self.telemetry_pool.connection() as c:
            rows = c.execute(
                "SELECT seq, event_id, facility_id, tick, sim_time_s, world_version, kind, entity_id, actor_type, actor_id, payload, "
                "causal_parent_id, command_id, ts, schema_version, event_hash FROM world_events WHERE run_id=%s AND kind LIKE 'comm.%%' AND seq > %s "
                "AND (%s::bigint IS NULL OR seq < %s) AND (%s::bigint IS NULL OR tick <= %s) AND (%s::text IS NULL OR kind = 'comm.' || %s) "
                "AND (%s::text IS NULL OR payload->>'thread_id' = %s) AND (%s::text IS NULL OR event_id = %s) "
                "AND (%s::text IS NULL OR payload->'sender'->>'class' = %s OR payload->'recipient'->>'class' = %s) "
                f"ORDER BY seq {order} LIMIT %s",
                (run_id, after_seq, before_seq, before_seq, until_tick, until_tick, message_type, message_type, thread_id, thread_id, event_id, event_id,
                 agent_class, agent_class, agent_class, limit)).fetchall()
        for r in rows:
            r["ts"] = _iso(r["ts"])
        return rows

    def last_event_seq(self, run_id):
        with self.telemetry_pool.connection() as c:
            return int(c.execute("SELECT COALESCE(MAX(seq),0) AS m FROM world_events WHERE run_id=%s", (run_id,)).fetchone()["m"])

    def events_digest(self, run_id, upto_seq=None):
        h = hashlib.sha256()
        with self.telemetry_pool.connection() as c, c.cursor(name="digest") as cur:
            cur.execute("SELECT event_hash FROM world_events WHERE run_id=%s AND (%s::bigint IS NULL OR seq <= %s) ORDER BY seq",
                        (run_id, upto_seq, upto_seq))
            for r in cur:
                h.update(r["event_hash"].encode())
        return h.hexdigest()

    # ---- commands ------------------------------------------------------
    _CMD_COLS = ("command_id, kind, target_id, issuer, actor_type, issued_tick, applied_tick, apply_order, seq_at_apply, "
                 "expected_world_version, args, preconditions, status, reason, outcome")

    def get_command(self, run_id, command_id):
        with self.pool.connection() as c:
            return c.execute(f"SELECT {self._CMD_COLS} FROM commands WHERE run_id=%s AND command_id=%s", (run_id, command_id)).fetchone()

    def load_commands(self, run_id, after_apply_order=0, accepted_only=True, limit=None):
        with self.pool.connection() as c:
            return c.execute(
                f"SELECT {self._CMD_COLS} FROM commands WHERE run_id=%s AND COALESCE(apply_order,0) > %s AND (NOT %s OR status <> 'rejected') "
                "ORDER BY apply_order NULLS LAST LIMIT %s", (run_id, after_apply_order, accepted_only, limit)).fetchall()

    # ---- projections ---------------------------------------------------
    def _docs(self, sql: str, params: tuple) -> list:
        with self.pool.connection() as c:
            return [r["doc"] for r in c.execute(sql, params).fetchall()]

    def load_missions(self, run_id): return self._docs("SELECT doc FROM missions WHERE run_id=%s ORDER BY opened_tick, mission_id", (run_id,))
    def load_robots(self, run_id): return self._docs("SELECT doc FROM robots WHERE run_id=%s ORDER BY robot_id", (run_id,))

    def load_incidents(self, run_id, open_only=False):
        return self._docs("SELECT doc FROM incidents WHERE run_id=%s AND (NOT %s OR closed_tick IS NULL) ORDER BY opened_tick, incident_id",
                          (run_id, open_only))

    def load_contracts(self, run_id, incident_id=None):
        with self.pool.connection() as c:
            rows = c.execute("SELECT contract_id, incident_id, version, state, terminal_state, frozen_hash, frozen_tick, updated_tick, doc FROM done_contracts "
                             "WHERE run_id=%s AND (%s::text IS NULL OR incident_id=%s) ORDER BY contract_id", (run_id, incident_id, incident_id)).fetchall()
        return rows

    def load_leases(self, run_id, active_only=False):
        return self._docs("SELECT doc FROM control_leases WHERE run_id=%s AND (NOT %s OR status IN ('pending','active')) ORDER BY lease_id",
                          (run_id, active_only))

    def record_agent_decision(self, row) -> None:
        with self.pool.connection() as c, c.transaction():
            c.execute("INSERT INTO agent_decisions (run_id, tick, task_id, decision, model, evidence_ids) VALUES (%s,%s,%s,%s,%s,%s)",
                      (row["run_id"], row["tick"], row["task_id"], _j(row["decision"]), _j(row.get("model", {})), _j(row.get("evidence_ids", []))))

    def load_agent_decisions(self, run_id, from_tick=0, to_tick=None):
        with self.pool.connection() as c:
            return c.execute("SELECT run_id, tick, task_id, decision, model, evidence_ids FROM agent_decisions WHERE run_id=%s AND tick >= %s "
                             "AND (%s::bigint IS NULL OR tick <= %s) ORDER BY decision_id", (run_id, from_tick, to_tick, to_tick)).fetchall()

    def load_sensor_samples(self, run_id, asset_id, metric, since_sim_time_s=0.0, limit=5000):
        with self.telemetry_pool.connection() as c:
            rows = c.execute("SELECT tick, sim_time_s, sensor_id, metric, value, units, source, quality FROM sensor_samples WHERE run_id=%s "
                             "AND sensor_id=%s AND metric=%s AND sim_time_s >= %s ORDER BY tick DESC LIMIT %s",
                             (run_id, asset_id, metric, since_sim_time_s, int(limit))).fetchall()
        if not rows and self.telemetry_pool is not self.pool:
            with self.pool.connection() as c_p:
                rows = c_p.execute("SELECT tick, sim_time_s, sensor_id, metric, value, units, source, quality FROM sensor_samples WHERE run_id=%s "
                                  "AND sensor_id=%s AND metric=%s AND sim_time_s >= %s ORDER BY tick DESC LIMIT %s",
                                  (run_id, asset_id, metric, since_sim_time_s, int(limit))).fetchall()
        return list(reversed(rows))

    def has_applied_effect(self, run_id, effect_key):
        with self.pool.connection() as c:
            return c.execute("SELECT 1 FROM applied_effects WHERE run_id=%s AND effect_key=%s", (run_id, effect_key)).fetchone() is not None

    def create_scenario_request(self, request_id: str, principal_id: str, original_text: str,
                                idempotency_key: str | None = None, facility_id: str = "lab_01",
                                source_run_id: str | None = None) -> dict:
        with self.pool.connection() as c:
            row = c.execute(
                "INSERT INTO scenario_requests (request_id, principal_id, original_text, status, phase, "
                "idempotency_key, facility_id, source_run_id) "
                "VALUES (%s, %s, %s, 'QUEUED', 'RECEIVED', %s, %s, %s) "
                "ON CONFLICT (idempotency_key) DO UPDATE SET updated_at=now() "
                "RETURNING request_id, principal_id, original_text, status, phase, idempotency_key, facility_id, source_run_id, run_id, error_code, error_message, created_at, updated_at",
                (request_id, principal_id, original_text, idempotency_key, facility_id, source_run_id)
            ).fetchone()
            return dict(row) if row else {}

    def get_scenario_request(self, request_id: str) -> dict | None:
        with self.pool.connection() as c:
            row = c.execute(
                "SELECT r.request_id, r.principal_id, r.original_text, r.status, r.phase, r.idempotency_key, "
                "r.facility_id, r.source_run_id, r.run_id, r.error_code, r.error_message, r.created_at, r.updated_at, "
                "i.laya_result, i.laya_engine, i.crusoe_proposal, i.crusoe_model, i.assumptions, i.resolved_assets, "
                "i.definition_of_done, i.validation_report, i.latencies_ms, i.tokens_used "
                "FROM scenario_requests r "
                "LEFT JOIN scenario_interpretations i ON r.request_id = i.request_id "
                "WHERE r.request_id = %s",
                (request_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_scenario_request_by_idempotency(self, idempotency_key: str) -> dict | None:
        with self.pool.connection() as c:
            row = c.execute(
                "SELECT request_id, principal_id, original_text, status, phase, idempotency_key, facility_id, source_run_id, run_id, created_at "
                "FROM scenario_requests WHERE idempotency_key = %s",
                (idempotency_key,)
            ).fetchone()
            return dict(row) if row else None

    def update_scenario_request(self, request_id: str, **fields) -> None:
        if not fields:
            return
        sets, vals = [], []
        for k, v in fields.items():
            sets.append(f"{k} = %s")
            vals.append(v)
        vals.append(request_id)
        with self.pool.connection() as c:
            c.execute(f"UPDATE scenario_requests SET {', '.join(sets)}, updated_at = now() WHERE request_id = %s", tuple(vals))

    def save_scenario_interpretation(self, request_id: str, *,
                                     laya_result: dict | None = None, laya_engine: str | None = None,
                                     crusoe_proposal: dict | None = None, crusoe_model: str | None = None,
                                     assumptions: list | None = None, resolved_assets: list | None = None,
                                     definition_of_done: list | None = None, validation_report: dict | None = None,
                                     latencies_ms: dict | None = None, tokens_used: dict | None = None) -> None:
        with self.pool.connection() as c:
            c.execute(
                "INSERT INTO scenario_interpretations (request_id, laya_result, laya_engine, crusoe_proposal, "
                "crusoe_model, assumptions, resolved_assets, definition_of_done, validation_report, latencies_ms, tokens_used) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (request_id) DO UPDATE SET "
                "laya_result = EXCLUDED.laya_result, laya_engine = EXCLUDED.laya_engine, "
                "crusoe_proposal = EXCLUDED.crusoe_proposal, crusoe_model = EXCLUDED.crusoe_model, "
                "assumptions = EXCLUDED.assumptions, resolved_assets = EXCLUDED.resolved_assets, "
                "definition_of_done = EXCLUDED.definition_of_done, validation_report = EXCLUDED.validation_report, "
                "latencies_ms = EXCLUDED.latencies_ms, tokens_used = EXCLUDED.tokens_used",
                (request_id, _j(laya_result) if laya_result else None, laya_engine,
                 _j(crusoe_proposal) if crusoe_proposal else None, crusoe_model,
                 _j(assumptions or []), _j(resolved_assets or []), _j(definition_of_done or []),
                 _j(validation_report or {}), _j(latencies_ms or {}), _j(tokens_used or {}))
            )

    def enqueue_scenario_job(self, job_id: str, request_id: str, phase: str = "RECEIVED") -> None:
        with self.pool.connection() as c:
            c.execute(
                "INSERT INTO scenario_jobs (job_id, request_id, phase, attempts, heartbeat_at) "
                "VALUES (%s, %s, %s, 0, now()) ON CONFLICT (job_id) DO NOTHING",
                (job_id, request_id, phase)
            )

    def claim_scenario_job(self) -> dict | None:
        with self.pool.connection() as c:
            row = c.execute(
                "SELECT j.job_id, j.request_id, j.phase, j.attempts, r.original_text, r.facility_id, r.source_run_id, r.principal_id "
                "FROM scenario_jobs j "
                "JOIN scenario_requests r ON j.request_id = r.request_id "
                "WHERE r.status IN ('QUEUED', 'PROCESSING') "
                "ORDER BY j.created_at ASC "
                "LIMIT 1 FOR UPDATE SKIP LOCKED"
            ).fetchone()
            if row:
                c.execute("UPDATE scenario_jobs SET attempts = attempts + 1, heartbeat_at = now() WHERE job_id = %s", (row["job_id"],))
                c.execute("UPDATE scenario_requests SET status = 'PROCESSING', updated_at = now() WHERE request_id = %s", (row["request_id"],))
                return dict(row)
            return None

    def finish_scenario_job(self, job_id: str) -> None:
        with self.pool.connection() as c:
            c.execute("DELETE FROM scenario_jobs WHERE job_id = %s", (job_id,))

