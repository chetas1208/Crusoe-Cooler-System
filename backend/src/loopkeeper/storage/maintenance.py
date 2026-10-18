"""Neon size budget (1 GiB project cap): online retention, snapshot cadence policy, size guard and the operator CLI (agent AA).

    python -m loopkeeper.storage.maintenance --dry-run            # default: prints exactly what would be thinned / deleted, with byte estimates
    python -m loopkeeper.storage.maintenance --apply [--aggressive] [--vacuum-full]   # the lead decides when

Why: run_live wrote 6-7 interval snapshots per wall minute (~270 kB each, ~100 MB/h) and retention only thinned STOPPED runs, so the live run was
unbounded and a full database halted physics once. Four layers, all in this file:

1. THINNING (`select_deletions`, `plan_run`, `apply_plan`): the newest `keep_newest` interval snapshots of a run stay dense; older interval snapshots are
   thinned to at most one per bucket, bucket = max(coarse_s, span / max_coarse) rounded up to a power-of-two multiple (so the survivor count is bounded
   by `max_coarse` however long / fast the run is, and re-running only ever thins nested buckets: idempotent). Only reason='interval' rows are
   candidates: incident / fault / shutdown / fork_origin checkpoints are never touched. Interval snapshots that a fork (meta.fork_snapshot_id,
   fork_tick) or a frozen / terminal done_contract (frozen_tick, updated_tick) points at, and both neighbours of those ticks (the replay seek base), are
   protected. If the protection lookup fails nothing is deleted for that run (fail closed).
2. CADENCE (`SnapshotPolicy`): sim seconds between interval snapshots = max(base, sim_speed * wall_gap) * guard multiplier, wall_gap = 60 * est_bytes /
   budget_bytes_per_min (default 200 kB/min = 12 MB/h: 270 kB -> one snapshot per 81 wall seconds instead of per 10). Engine wiring: one line in core.py.
3. SIZE GUARD (`SizeGuard`): `pg_database_size` of both databases on startup and every `interval_s`; >= 80 % warn (log + `status()` for /health/detail),
   >= 90 % critical: aggressive thinning, sensor_samples decimation and shorter prune window, checkpoint trim, interval snapshots shed 3 of 4. A DiskFull on the
   telemetry plane (`commit_telemetry`) retries with the essential rows only (events + non-interval snapshots) and, if the database is still full, parks
   them in a bounded in-memory spool that is replayed on the next successful commit: physics is never halted by a full TELEMETRY database.
4. Space accounting: DELETE returns pages to the table's free list (new rows reuse them, so growth stops) but the file only shrinks with VACUUM FULL,
   which needs free space equal to the live data and an ACCESS EXCLUSIVE lock: it runs only from the CLI with --vacuum-full, never automatically."""
from __future__ import annotations

import argparse
import bisect
import dataclasses
import logging
import math
import os
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, NamedTuple

log = logging.getLogger("loopkeeper.storage.maintenance")

LIMIT_BYTES = 1 << 30                       # Neon free-plan project cap
DISK_FULL_SQLSTATES = {"53100"}             # disk_full (also what Neon raises when the project size limit is hit)
PRUNE_INDEX = "sensor_samples_run_tick_idx"


def _envf(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _envi(name: str, default: int) -> int:
    return int(_envf(name, default))


def pretty(n: float | int | None) -> str:
    if n is None:
        return "-"
    f = float(n)
    for u in ("B", "kB", "MB", "GB"):
        if abs(f) < 1024 or u == "GB":
            return f"{f:.0f} {u}" if u == "B" else f"{f:.1f} {u}"
        f /= 1024
    return str(n)


# ================================================================================================ 1. thinning
@dataclass(frozen=True)
class ThinParams:
    keep_newest: int = 60            # newest interval snapshots kept at full density
    coarse_s: float = 600.0          # older ones: at most one per 10 sim-minutes ...
    max_coarse: int = 120            # ... and never more than this many survivors per run (the bucket doubles as the run grows)
    sensor_window_ticks: int = 3600  # sensor_samples rolling window (the engine's own prune uses 3600)
    checkpoints_keep: int = 20       # LangGraph checkpoints kept per thread

    @classmethod
    def normal(cls) -> "ThinParams":
        return cls(keep_newest=_envi("LOOPKEEPER_RETENTION_KEEP_NEWEST", 60), coarse_s=_envf("LOOPKEEPER_RETENTION_COARSE_SIM_S", 600.0),
                   max_coarse=_envi("LOOPKEEPER_RETENTION_MAX_COARSE", 120))

    @classmethod
    def aggressive(cls) -> "ThinParams":
        return cls(keep_newest=12, coarse_s=3600.0, max_coarse=40, sensor_window_ticks=900, checkpoints_keep=5)


class SnapRow(NamedTuple):
    snapshot_id: str
    tick: int
    last_seq: int
    nbytes: int


def bucket_width(span_ticks: int, dt_s: float, p: ThinParams) -> int:
    base = max(1, int(round(p.coarse_s / max(dt_s, 1e-9))))
    need = max(1, math.ceil(max(span_ticks, 0) / max(p.max_coarse, 1)))
    w = base
    while w < need:
        w *= 2
    return w


def select_deletions(rows: list[SnapRow], p: ThinParams, dt_s: float, protected_ids: Iterable[str] = (),
                     protected_ticks: Iterable[int] = ()) -> tuple[list[SnapRow], int]:
    """`rows`: ALL interval snapshots of one run ordered (tick, last_seq). Returns (rows to delete, bucket width in ticks). Pure function."""
    n = len(rows)
    if n <= p.keep_newest:
        return [], 0
    ticks = [r.tick for r in rows]
    prot = set(protected_ids)
    for t in protected_ticks:                                    # the snapshot at / before and at / after a referenced tick (replay seek base)
        i = bisect.bisect_right(ticks, t) - 1
        if i >= 0:
            prot.add(rows[i].snapshot_id)
        j = bisect.bisect_left(ticks, t)
        if j < n:
            prot.add(rows[j].snapshot_id)
    cand = rows[: n - p.keep_newest]
    width = bucket_width(cand[-1].tick - cand[0].tick, dt_s, p)
    seen: set[int] = set()
    out: list[SnapRow] = []
    for i, r in enumerate(cand):
        b = r.tick // width
        if i == 0 or r.snapshot_id in prot:
            seen.add(b)
        elif b in seen:
            out.append(r)
        else:
            seen.add(b)
    return out, width


@dataclass
class ThinPlan:
    run_id: str
    interval_total: int
    delete: list[SnapRow]
    width_ticks: int
    dt_s: float
    protected_forks: int = 0
    protected_ticks: int = 0
    error: str | None = None

    @property
    def delete_bytes(self) -> int:
        return sum(r.nbytes for r in self.delete)

    @property
    def kept(self) -> int:
        return self.interval_total - len(self.delete)


def _pg():
    import psycopg
    return psycopg


def connect(url: str, *, autocommit: bool = True, timeout: int = 10):
    c = _pg().connect(url, autocommit=autocommit, connect_timeout=timeout)
    try:
        c.execute("SET statement_timeout = '60s'")
        c.execute("SET lock_timeout = '5s'")
        c.execute("SET application_name = 'loopkeeper_maintenance'")
    except Exception:                                            # noqa: BLE001  (a pooler may refuse session settings)
        pass
    return c


def fetch_protection(pconn, run_id: str) -> tuple[set[str], list[int], int]:
    """(snapshot ids, ticks, fork count) of this run's snapshots that other rows point at. Reads the PRIMARY plane (forks, contracts live there)."""
    ids: set[str] = set()
    ticks: list[int] = []
    forks = 0
    for sid, ft in pconn.execute("SELECT meta->>'fork_snapshot_id', fork_tick FROM simulation_runs WHERE parent_run_id = %s", (run_id,)).fetchall():
        forks += 1
        if sid:
            ids.add(sid)
        if ft is not None:
            ticks.append(int(ft))
    for frozen, updated, terminal in pconn.execute(
            "SELECT frozen_tick, updated_tick, terminal_state FROM done_contracts WHERE run_id = %s AND (frozen_tick IS NOT NULL OR terminal_state IS NOT NULL)",
            (run_id,)).fetchall():
        if frozen is not None:
            ticks.append(int(frozen))
        if terminal is not None and updated is not None:         # VERIFIED / terminal: the evidence frame is the one at the verdict tick
            ticks.append(int(updated))
    return ids, sorted(set(ticks)), forks


def load_interval_rows(tconn, run_id: str) -> list[SnapRow]:
    return [SnapRow(r[0], int(r[1]), int(r[2]), int(r[3] or 0)) for r in tconn.execute(
        "SELECT snapshot_id, tick, last_seq, coalesce(pg_column_size(state),0) + coalesce(pg_column_size(world),0) + coalesce(pg_column_size(rng_state),0) "
        "FROM world_snapshots WHERE run_id = %s AND reason = 'interval' ORDER BY tick, last_seq", (run_id,)).fetchall()]


def plan_run(tconn, pconn, run_id: str, dt_s: float, p: ThinParams) -> ThinPlan:
    rows = load_interval_rows(tconn, run_id)
    try:
        ids, ticks, forks = fetch_protection(pconn, run_id)
    except Exception as e:                                       # noqa: BLE001  fail closed: no protection info, no deletion
        return ThinPlan(run_id, len(rows), [], 0, dt_s, error=f"protection lookup failed ({type(e).__name__})")
    dele, width = select_deletions(rows, p, dt_s, ids, ticks)
    return ThinPlan(run_id, len(rows), dele, width, dt_s, protected_forks=forks, protected_ticks=len(ticks))


def apply_plan(tconn, plan: ThinPlan, chunk: int = 100) -> int:
    """Delete the planned rows in short autocommit statements. The reason / fork-reference guards are repeated server-side."""
    deleted = 0
    for i in range(0, len(plan.delete), chunk):
        ids = [r.snapshot_id for r in plan.delete[i:i + chunk]]
        cur = tconn.execute(
            "DELETE FROM world_snapshots s WHERE s.run_id = %s AND s.reason = 'interval' AND s.snapshot_id = ANY(%s) "
            "AND NOT EXISTS (SELECT 1 FROM simulation_runs c WHERE c.parent_run_id = s.run_id AND c.meta->>'fork_snapshot_id' = s.snapshot_id)",
            (plan.run_id, ids))
        deleted += cur.rowcount
    return deleted


def run_dts(pconn, run_ids: Iterable[str]) -> dict[str, float]:
    ids = list(run_ids)
    if not ids:
        return {}
    return {r[0]: float(r[1] or 0.5) for r in pconn.execute("SELECT run_id, dt_s FROM simulation_runs WHERE run_id = ANY(%s)", (ids,)).fetchall()}


def plan_all(tconn, pconn, p: ThinParams, run_ids: list[str] | None = None) -> list[ThinPlan]:
    if run_ids is None:
        run_ids = [r[0] for r in tconn.execute("SELECT DISTINCT run_id FROM world_snapshots WHERE reason = 'interval' ORDER BY 1").fetchall()]
    dts = run_dts(pconn, run_ids)
    return [plan_run(tconn, pconn, rid, dts.get(rid, 0.5), p) for rid in run_ids]


# ---- other tables
def sensor_estimate(tconn, run_id: str, window_ticks: int) -> dict:
    n, mx = tconn.execute("SELECT count(*), max(tick) FROM sensor_samples WHERE run_id = %s", (run_id,)).fetchone()
    total, rel = tconn.execute("SELECT count(*), pg_total_relation_size('sensor_samples') FROM sensor_samples").fetchone()
    old = 0
    if mx is not None:
        old = tconn.execute("SELECT count(*) FROM sensor_samples WHERE run_id = %s AND tick < %s", (run_id, int(mx) - window_ticks)).fetchone()[0]
    per_row = rel / max(total, 1)
    return {"rows": n, "max_tick": mx, "window_ticks": window_ticks, "old_rows": old, "est_bytes": int(old * per_row), "bytes_per_row": per_row}


def sensor_prune(tconn, run_id: str, window_ticks: int) -> int:
    mx = tconn.execute("SELECT max(tick) FROM sensor_samples WHERE run_id = %s", (run_id,)).fetchone()[0]
    if mx is None or mx <= window_ticks:
        return 0
    return tconn.execute("DELETE FROM sensor_samples WHERE run_id = %s AND tick < %s", (run_id, int(mx) - window_ticks)).rowcount


_OLD_CKPT = ("SELECT thread_id, checkpoint_ns, checkpoint_id, pg_column_size(checkpoint) + coalesce(pg_column_size(metadata), 0) AS b FROM "
             "(SELECT thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata, row_number() OVER (PARTITION BY thread_id, checkpoint_ns "
             "ORDER BY checkpoint_id DESC) rn FROM checkpoints) q WHERE rn > %s")


def checkpoint_estimate(pconn, keep: int) -> dict | None:
    try:
        n, b = pconn.execute(f"WITH old AS ({_OLD_CKPT}) SELECT count(*), coalesce(sum(b), 0) FROM old", (keep,)).fetchone()
        wn, wb = pconn.execute(f"WITH old AS ({_OLD_CKPT}) SELECT count(*), coalesce(sum(pg_column_size(cw.blob)), 0) FROM checkpoint_writes cw "
                               "JOIN old USING (thread_id, checkpoint_ns, checkpoint_id)", (keep,)).fetchone()
        on, ob = pconn.execute(
            "SELECT count(*), coalesce(sum(pg_column_size(b.blob)), 0) FROM checkpoint_blobs b WHERE NOT EXISTS (SELECT 1 FROM checkpoints c "
            "WHERE c.thread_id = b.thread_id AND c.checkpoint_ns = b.checkpoint_ns AND c.checkpoint->'channel_versions'->>b.channel = b.version)").fetchone()
        return {"checkpoints": n, "checkpoints_bytes": int(b), "writes": wn, "writes_bytes": int(wb), "orphan_blobs": on, "orphan_blob_bytes": int(ob)}
    except _pg().errors.UndefinedTable:
        return None


def checkpoint_trim(pconn, keep: int) -> dict:
    """Delete LangGraph checkpoints (and their writes) beyond the newest `keep` per thread. Blobs are NOT touched (see checkpoint_estimate)."""
    try:
        w = pconn.execute(f"WITH old AS ({_OLD_CKPT}), d AS (DELETE FROM checkpoint_writes cw USING old WHERE cw.thread_id = old.thread_id "
                          "AND cw.checkpoint_ns = old.checkpoint_ns AND cw.checkpoint_id = old.checkpoint_id RETURNING 1) SELECT count(*) FROM d", (keep,)).fetchone()[0]
        c = pconn.execute("DELETE FROM checkpoints c USING (SELECT thread_id, checkpoint_ns, checkpoint_id FROM (SELECT thread_id, checkpoint_ns, "
                          "checkpoint_id, row_number() OVER (PARTITION BY thread_id, checkpoint_ns ORDER BY checkpoint_id DESC) rn FROM checkpoints) q "
                          "WHERE rn > %s) old WHERE c.thread_id = old.thread_id AND c.checkpoint_ns = old.checkpoint_ns "
                          "AND c.checkpoint_id = old.checkpoint_id", (keep,)).rowcount
        return {"checkpoint_writes_deleted": w, "checkpoints_deleted": c}
    except _pg().errors.UndefinedTable:
        return {}


def ensure_prune_index(tconn) -> bool:
    """Create the (run_id, tick) index CONCURRENTLY if migration 0012 skipped it for lack of headroom. Autocommit connection required."""
    if tconn.execute("SELECT 1 FROM pg_indexes WHERE indexname = %s", (PRUNE_INDEX,)).fetchone():
        return False
    tconn.execute(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {PRUNE_INDEX} ON sensor_samples (run_id, tick)")
    return True


def read_size(url: str) -> int:
    with connect(url, timeout=5) as c:
        return int(c.execute("SELECT pg_database_size(current_database())").fetchone()[0])


def active_runs(pconn) -> list[str]:
    return [r[0] for r in pconn.execute("SELECT run_id FROM simulation_runs WHERE phase IN ('running','paused') AND kind <> 'fork'").fetchall()]


def run_maintenance(primary_url: str, telemetry_url: str | None, level: str, *, params: ThinParams | None = None) -> dict:
    """One maintenance cycle. normal: thin every run's interval snapshots. critical: aggressive parameters, shorter sensor window, checkpoint trim."""
    crit = level in ("critical", "emergency")
    p = params or (ThinParams.aggressive() if crit else ThinParams.normal())
    out: dict[str, Any] = {"level": level, "deleted_snapshots": 0, "deleted_bytes_est": 0, "runs": {}}
    t_url = telemetry_url or primary_url
    pconn = connect(primary_url)
    tconn = pconn if t_url == primary_url else connect(t_url)
    try:
        for plan in plan_all(tconn, pconn, p):
            if plan.error:
                out["runs"][plan.run_id] = plan.error
                continue
            if plan.delete:
                n = apply_plan(tconn, plan)
                out["deleted_snapshots"] += n
                out["deleted_bytes_est"] += plan.delete_bytes
                out["runs"][plan.run_id] = n
        if out["deleted_snapshots"] >= 50:
            tconn.execute("VACUUM world_snapshots")               # plain VACUUM: free pages become reusable at once (autovacuum lags a burst)
        if crit:
            out["sensor_rows_deleted"] = sum(sensor_prune(tconn, rid, p.sensor_window_ticks) for rid in active_runs(pconn))
            out.update(checkpoint_trim(pconn, p.checkpoints_keep))
        else:
            try:
                if ensure_prune_index(tconn):
                    out["created_index"] = PRUNE_INDEX
            except Exception as e:                                # noqa: BLE001
                out["index_error"] = type(e).__name__
    finally:
        if tconn is not pconn:
            tconn.close()
        pconn.close()
    return out


# ================================================================================================ 2. snapshot cadence
class SnapshotPolicy:
    """Sim seconds between interval snapshots. `interval_s(base_s, sim_speed)`; feed `observe(len(state)+len(world json))` after each snapshot."""

    def __init__(self, budget_bytes_per_min: float | None = None, est_bytes: float = 270_000.0, guard: "SizeGuard | None" = None):
        self.budget = float(budget_bytes_per_min if budget_bytes_per_min is not None else _envf("LOOPKEEPER_SNAPSHOT_BUDGET_BYTES_PER_MIN", 200_000.0))
        self.est = float(est_bytes)
        self.guard = guard

    def observe(self, nbytes: int) -> None:
        if nbytes > 0:
            self.est = 0.8 * self.est + 0.2 * float(nbytes)

    def wall_gap_s(self) -> float:
        return 60.0 * self.est / max(self.budget, 1.0)

    def interval_s(self, base_s: float, sim_speed: float) -> float:
        g = self.guard if self.guard is not None else _GUARD
        mult = g.interval_multiplier() if g is not None else 1.0
        return max(float(base_s), float(sim_speed) * self.wall_gap_s()) * mult


POLICY = SnapshotPolicy()


# ================================================================================================ 3. size guard
def is_disk_full(exc: BaseException) -> bool:
    if getattr(exc, "sqlstate", None) in DISK_FULL_SQLSTATES:
        return True
    cls = _pg().errors.DiskFull
    if isinstance(exc, cls):
        return True
    msg = str(exc).lower()
    return "no space left" in msg or "project size limit" in msg or "could not extend file" in msg


@dataclass
class _Spool:
    events: deque = field(default_factory=deque)
    snaps: list = field(default_factory=list)


class SizeGuard:
    OK, WARN, CRITICAL = "ok", "warn", "critical"

    def __init__(self, primary_url: str, telemetry_url: str | None = None, *, cap_bytes: int | None = None, warn_frac: float = 0.80,
                 crit_frac: float = 0.90, interval_s: float | None = None, cap_scope: str | None = None, size_fn: Callable[[str], int] | None = None,
                 maintain_fn: Callable[[str, str | None, str], dict] | None = None, crit_stride: int = 4, spool_max_events: int = 50_000,
                 spool_max_snaps: int = 20, retry_hold_s: float = 5.0):
        self.primary_url = primary_url
        self.telemetry_url = telemetry_url if telemetry_url and telemetry_url != primary_url else None
        self.cap = int(cap_bytes or _envi("LOOPKEEPER_DB_CAP_BYTES", LIMIT_BYTES))
        self.warn_frac, self.crit_frac = warn_frac, crit_frac
        self.interval_s = float(interval_s if interval_s is not None else _envf("LOOPKEEPER_SIZE_GUARD_INTERVAL_S", 300.0))
        self.cap_scope = cap_scope or os.environ.get("LOOPKEEPER_DB_CAP_SCOPE", "sum")      # sum: both DBs share ONE project cap; each: per database
        self._size_fn, self._maintain_fn = size_fn or read_size, maintain_fn or run_maintenance
        self.crit_stride, self.spool_max_events, self.spool_max_snaps, self.retry_hold_s = max(2, crit_stride), spool_max_events, spool_max_snaps, retry_hold_s
        self.level = self.OK
        self.sizes: dict[str, int] = {}
        self.used_bytes = 0
        self.checked_at: float | None = None
        self.last_maintenance: dict = {}
        self.last_error: str | None = None
        self.emergency = False
        self._hold_until = 0.0
        self._emergency_until = 0.0
        self._lock = threading.Lock()
        self._spool: dict[str, _Spool] = {}
        self._sample_tick = None
        self._sample_group = 0
        self._snap_n = 0
        self.counters = {"disk_full": 0, "events_parked": 0, "events_dropped": 0, "samples_decimated": 0, "interval_snapshots_shed": 0, "checks": 0}
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._wake = threading.Event()

    # ---- level
    def _level_for(self, frac: float) -> str:
        hyst = 0.02 if self.level != self.OK else 0.0                 # leave a level only 2 points below its threshold (no flapping)
        if frac >= self.crit_frac or (self.level == self.CRITICAL and frac >= self.crit_frac - hyst):
            return self.CRITICAL
        if frac >= self.warn_frac or (self.level != self.OK and frac >= self.warn_frac - hyst):
            return self.WARN
        return self.OK

    def check(self) -> dict:
        """Read both sizes, set the level, run one maintenance cycle. Never raises."""
        with self._lock:
            self.counters["checks"] += 1
            try:
                sizes = {"primary": self._size_fn(self.primary_url)}
                if self.telemetry_url:
                    sizes["telemetry"] = self._size_fn(self.telemetry_url)
                self.sizes = sizes
                self.used_bytes = sum(sizes.values()) if self.cap_scope == "sum" else max(sizes.values())
                prev, self.level = self.level, self._level_for(self.used_bytes / self.cap)
                self.last_error = None
            except Exception as e:                                    # noqa: BLE001
                self.last_error = f"size read failed ({type(e).__name__})"
                log.warning("size guard: %s", self.last_error)
                return self.status()
            self.checked_at = time.time()
            pct = 100.0 * self.used_bytes / self.cap
            if self.level == self.CRITICAL:
                log.error("DATABASE SIZE CRITICAL: %.1f%% of the %s cap (%s) - aggressive thinning, sensor decimation, interval snapshots shed", pct, pretty(self.cap),
                          ", ".join(f"{k} {pretty(v)}" for k, v in self.sizes.items()))
            elif self.level == self.WARN:
                log.warning("database size warning: %.1f%% of the %s cap (%s)", pct, pretty(self.cap), ", ".join(f"{k} {pretty(v)}" for k, v in self.sizes.items()))
            elif prev != self.OK:
                log.info("database size back to ok: %.1f%% of the cap", pct)
            try:
                self.last_maintenance = self._maintain_fn(self.primary_url, self.telemetry_url, "critical" if (self.level == self.CRITICAL or self.emergency) else self.level)
                if self.last_maintenance.get("deleted_snapshots"):
                    log.info("retention: %s", {k: v for k, v in self.last_maintenance.items() if k != "runs"})
            except Exception as e:                                    # noqa: BLE001  (a full database may refuse even maintenance: report, keep running)
                self.last_maintenance = {"error": type(e).__name__}
                log.warning("size guard maintenance failed (%s)", type(e).__name__)
            return self.status()

    # ---- thread
    def start(self) -> "SizeGuard":
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="loopkeeper-size-guard", daemon=True)
            self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.check()
            self._wake.clear()
            wait = min(self.interval_s, 60.0) if (self.level == self.CRITICAL or self.emergency) else self.interval_s
            self._wake.wait(wait)

    # ---- /health/detail
    def status(self) -> dict:
        return {"enabled": True, "level": "emergency" if self.emergency else self.level, "used_bytes": self.used_bytes, "cap_bytes": self.cap,
                "used_pct": round(100.0 * self.used_bytes / self.cap, 1), "cap_scope": self.cap_scope, "sizes_bytes": dict(self.sizes),
                "warn_pct": self.warn_frac * 100, "critical_pct": self.crit_frac * 100, "checked_at": self.checked_at,
                "sample_stride": self.sample_stride(), "snapshot_interval_multiplier": self.interval_multiplier(),
                "spool_events": sum(len(s.events) for s in self._spool.values()), "spool_snapshots": sum(len(s.snaps) for s in self._spool.values()),
                "counters": dict(self.counters), "last_maintenance": {k: v for k, v in self.last_maintenance.items() if k != "runs"}, "last_error": self.last_error}

    # ---- write shaping
    def sample_stride(self) -> int:
        """0 = sensor_samples paused (disk full), 1 = every sample, N = every Nth sample group."""
        return 0 if self.emergency else (self.crit_stride if self.level == self.CRITICAL else 1)

    def interval_multiplier(self) -> float:
        return 8.0 if self.emergency else {self.OK: 1.0, self.WARN: 2.0, self.CRITICAL: 4.0}[self.level]

    def shape(self, b):
        """A copy of the batch with non-essential rows decimated for the current level (events, commands, missions ... are never touched)."""
        stride = self.sample_stride()
        samples = b.sensor_samples
        if samples and stride != 1:
            kept = []
            for s in samples:
                if s["tick"] != self._sample_tick:
                    self._sample_tick, self._sample_group = s["tick"], self._sample_group + 1
                if stride and self._sample_group % stride == 0:
                    kept.append(s)
            self.counters["samples_decimated"] += len(samples) - len(kept)
            samples = kept
        snaps = b.snapshots
        if snaps and (self.level == self.CRITICAL or self.emergency):
            kept = []
            for s in snaps:
                if s["reason"] != "interval":
                    kept.append(s)
                    continue
                self._snap_n += 1
                if not self.emergency and self._snap_n % self.crit_stride == 0:
                    kept.append(s)
            self.counters["interval_snapshots_shed"] += len(snaps) - len(kept)
            snaps = kept
        return dataclasses.replace(b, sensor_samples=samples, snapshots=snaps)

    @staticmethod
    def essential(b):
        return dataclasses.replace(b, sensor_samples=[], snapshots=[s for s in b.snapshots if s["reason"] != "interval"])

    def _park(self, b) -> None:
        sp = self._spool.setdefault(b.run_id, _Spool())
        for e in b.events:
            sp.events.append(e)
            self.counters["events_parked"] += 1
        while len(sp.events) > self.spool_max_events:
            sp.events.popleft()
            if self.counters["events_dropped"] == 0:
                log.error("telemetry spool overflow: the database stayed full, OLDEST parked events are being dropped (ledger gap)")
            self.counters["events_dropped"] += 1
        sp.snaps.extend(b.snapshots)
        del sp.snaps[: max(0, len(sp.snaps) - self.spool_max_snaps)]

    def _take_spool(self, b):
        sp = self._spool.pop(b.run_id, None)
        if not sp or (not sp.events and not sp.snaps):
            return b, None
        return dataclasses.replace(b, events=list(sp.events) + list(b.events), snapshots=list(sp.snaps) + list(b.snapshots)), sp

    def note_disk_full(self, exc: BaseException | None = None) -> None:
        self.counters["disk_full"] += 1
        if not self.emergency:
            log.error("DISK FULL on the telemetry plane (%s): non-essential writes paused, essential rows retried / parked, physics keeps running",
                      type(exc).__name__ if exc else "?")
        self.emergency = True
        self._emergency_until = time.monotonic() + 60.0
        self._wake.set()                                              # run an aggressive maintenance cycle now

    def commit_telemetry(self, b, do_commit: Callable[[Any], None]) -> None:
        """Wrap the telemetry-plane write (`PostgresStorage._commit_telemetry`). Non-DiskFull errors propagate unchanged (K's FK heal / retry still applies)."""
        shaped, taken = self._take_spool(self.shape(b))
        now = time.monotonic()
        try:
            if now < self._hold_until:                                # a DiskFull just happened: park instead of hammering the database
                self._park(self.essential(shaped))
                return
            try:
                do_commit(shaped)
                self._recovered(now)
                return
            except Exception as e:                                    # noqa: BLE001
                if not is_disk_full(e):
                    raise
                self.note_disk_full(e)
            ess = self.essential(shaped)
            try:
                do_commit(ess)
                return
            except Exception as e2:                                   # noqa: BLE001
                if not is_disk_full(e2):
                    raise
            self._park(ess)
            self._hold_until = now + self.retry_hold_s
        except BaseException:
            if taken is not None:                                     # the spool must survive an unrelated failure
                sp = self._spool.setdefault(b.run_id, _Spool())
                sp.events.extendleft(reversed(taken.events))
                sp.snaps[:0] = taken.snaps
            raise

    def _recovered(self, now: float) -> None:
        if self.emergency and now >= self._emergency_until:
            self.emergency = False
            log.warning("telemetry writes succeeded again: leaving emergency mode (level %s)", self.level)


# ---- process-wide handle (wired by storage / engine start, read by /health/detail)
_GUARD: SizeGuard | None = None


def install(storage: Any = None, *, primary_url: str | None = None, telemetry_url: str | None = None, start: bool = True) -> SizeGuard | None:
    """Create + start the guard once per process (idempotent). `LOOPKEEPER_SIZE_GUARD=off` disables. Sets `storage.size_guard` when given."""
    global _GUARD
    if os.environ.get("LOOPKEEPER_SIZE_GUARD", "on") == "off":
        return None
    if _GUARD is None:
        p = primary_url or getattr(storage, "_url", None)
        if not p:
            return None
        _GUARD = SizeGuard(p, telemetry_url or getattr(storage, "_telemetry_url", None))
        POLICY.guard = _GUARD
        if start:
            _GUARD.start()
    if storage is not None:
        try:
            storage.size_guard = _GUARD
        except Exception:                                             # noqa: BLE001
            pass
    return _GUARD


def get_guard() -> SizeGuard | None:
    return _GUARD


def guard_status() -> dict:
    return _GUARD.status() if _GUARD is not None else {"enabled": False}


# ================================================================================================ 4. CLI
def _load_env(path: str) -> dict[str, str]:
    env = dict(os.environ)
    try:
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass
    return env


def _urls(env: dict[str, str], pooled_first: bool) -> tuple[list[str], list[str] | None]:
    """Candidate URLs per database, tried in order (read-only dry-run: pooled first, it is reachable over IPv4 when the direct host is not)."""
    def cands(pooled: str, direct: str) -> list[str]:
        out = [u for u in ((env.get(pooled), env.get(direct)) if pooled_first else (env.get(direct), env.get(pooled))) if u]
        return list(dict.fromkeys(out))
    prim = cands("DATABASE_URL", "DATABASE_URL_UNPOOLED")
    tele = cands("TELEMETRY_DATABASE_URL", "TELEMETRY_DATABASE_URL_UNPOOLED")
    if not prim:
        sys.exit("no DATABASE_URL in the environment / .env")
    return prim, (tele if tele and set(tele) != set(prim) else None)


def _open(label: str, urls: list[str]):
    """First reachable URL -> connection, else None after ONE clean line per failed attempt (never prints a URL or credentials)."""
    import re
    for i, u in enumerate(urls):
        try:
            return connect(u, timeout=15)
        except Exception as e:                                    # noqa: BLE001
            cause = re.sub(r"postgres(ql)?://\S+", "<url>", str(e).strip().splitlines()[-1] if str(e).strip() else "")[-90:]
            print(f"  {label}: cannot connect (attempt {i + 1}/{len(urls)}, {type(e).__name__}: {cause})")
    return None


def _table_sizes(c, n: int = 8) -> list[tuple[str, int]]:
    return [(r[0], int(r[1])) for r in c.execute(
        "SELECT relname, pg_total_relation_size(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 2 DESC LIMIT %s", (n,)).fetchall()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Neon size maintenance. Dry-run is the default and is read-only.")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, change nothing (default)")
    ap.add_argument("--apply", action="store_true", help="execute the plan (DELETEs + plain VACUUM)")
    ap.add_argument("--aggressive", action="store_true", help="use the critical-level parameters (12 dense + <=40 coarse per run, 15 min sensor window, 5 checkpoints/thread)")
    ap.add_argument("--vacuum-full", action="store_true", help="with --apply: VACUUM FULL world_snapshots afterwards (ACCESS EXCLUSIVE lock; needs free space = live data)")
    ap.add_argument("--run", default="run_live", help="run whose per-table estimate is printed in detail (default run_live)")
    ap.add_argument("--all-runs", action="store_true", help="plan / apply for every run, not only --run")
    ap.add_argument("--env", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", ".env"))
    a = ap.parse_args(argv)
    if a.apply and a.dry_run:
        ap.error("--apply and --dry-run are mutually exclusive")
    prim_urls, tele_urls = _urls(_load_env(a.env), pooled_first=not a.apply)
    p = ThinParams.aggressive() if a.aggressive else ThinParams.normal()
    mode = "APPLY" if a.apply else "DRY-RUN (nothing is changed)"
    print(f"== loopkeeper storage maintenance: {mode} ==")
    print(f"params: keep newest {p.keep_newest} interval snapshots, older -> <=1 per {p.coarse_s / 60:.0f} sim-min and <= {p.max_coarse} survivors/run; "
          f"sensor window {p.sensor_window_ticks} ticks; checkpoints keep {p.checkpoints_keep}/thread")
    pconn = _open("primary", prim_urls)
    tconn = pconn if tele_urls is None else _open("telemetry", tele_urls)
    if pconn is None and tconn is None:
        print("no database reachable: nothing to report")
        return 1
    if pconn is None:
        print("primary unreachable: forks / contracts cannot be read, so NO snapshot plan is made (fail closed); telemetry-only figures follow")
    if tconn is None:
        print("telemetry unreachable: only primary figures follow (world_snapshots / sensor_samples / world_events need the telemetry database)")
    sensor_runs: list[str] = []
    try:
        total = 0
        for label, c in (("primary", pconn),) + ((("telemetry", tconn),) if tconn is not pconn else ()):
            if c is None:
                continue
            sz = int(c.execute("SELECT pg_database_size(current_database())").fetchone()[0])
            total += sz
            print(f"{label}: {pretty(sz)}; biggest tables: " + ", ".join(f"{n} {pretty(b)}" for n, b in _table_sizes(c)))
        part = "" if (pconn is not None and tconn is not None) else " (PARTIAL: one database unreachable)"
        print(f"project (sum of databases read): {pretty(total)} = {100 * total / LIMIT_BYTES:.1f}% of the 1 GiB cap{part}  (warn 80%, critical 90%)")

        grand = 0
        plans: list[ThinPlan] = []
        if tconn is not None:
            print("\n-- world_snapshots (telemetry) --")
            if pconn is None:
                print("SKIPPED: protection lookup needs the primary database")
            else:
                plans = plan_all(tconn, pconn, p, None if a.all_runs else [a.run])
            for pl in plans:
                if pl.error:
                    print(f"{pl.run_id}: SKIPPED, {pl.error} (fail closed, nothing would be deleted)")
                    continue
                tot_all, tot_b = tconn.execute("SELECT count(*), coalesce(sum(pg_column_size(state) + pg_column_size(world) + pg_column_size(rng_state)), 0) "
                                               "FROM world_snapshots WHERE run_id = %s", (pl.run_id,)).fetchone()
                print(f"{pl.run_id}: {tot_all} snapshots ({pretty(tot_b)}), {pl.interval_total} interval; would delete {len(pl.delete)} interval snapshots "
                      f"= ~{pretty(pl.delete_bytes)} of row data, keep {pl.kept} interval + {tot_all - pl.interval_total} non-interval "
                      f"(incident / fault / shutdown / fork_origin: untouched); bucket {pl.width_ticks * pl.dt_s / 60:.1f} sim-min; "
                      f"protected by {pl.protected_forks} fork(s) / {pl.protected_ticks} contract-fork tick(s)")
                grand += pl.delete_bytes
            print("\n-- sensor_samples (telemetry) --")
            sensor_runs = [a.run] if not a.all_runs else [r[0] for r in tconn.execute("SELECT DISTINCT run_id FROM sensor_samples").fetchall()]
            for rid in sensor_runs:
                est = sensor_estimate(tconn, rid, p.sensor_window_ticks)
                print(f"{rid}: {est['rows']} rows (max tick {est['max_tick']}); older than {est['window_ticks']} ticks: {est['old_rows']} rows = ~{pretty(est['est_bytes'])} "
                      f"(~{est['bytes_per_row']:.0f} B/row incl. indexes)")
                grand += est["est_bytes"]
            ev = tconn.execute("SELECT count(*), coalesce(sum(pg_column_size(payload)), 0) FROM world_events WHERE run_id = %s", (a.run,)).fetchone()
            print(f"\n-- world_events -- {a.run}: {ev[0]} rows ({pretty(ev[1])} payload): APPEND-ONLY (DB trigger rejects DELETE), would delete 0")
        if pconn is not None:
            ck = checkpoint_estimate(pconn, p.checkpoints_keep)
            print("\n-- LangGraph checkpoints (primary) --")
            if ck is None:
                print("tables not present")
            else:
                print(f"checkpoints beyond newest {p.checkpoints_keep}/thread: {ck['checkpoints']} rows = ~{pretty(ck['checkpoints_bytes'])}; their checkpoint_writes: "
                      f"{ck['writes']} rows = ~{pretty(ck['writes_bytes'])}")
                print(f"checkpoint_blobs not referenced by any remaining checkpoint: {ck['orphan_blobs']} rows = ~{pretty(ck['orphan_blob_bytes'])} "
                      "(estimate only, this command never deletes blobs)")
                grand += ck["checkpoints_bytes"] + ck["writes_bytes"]
        print(f"\nTOTAL row data this plan removes: ~{pretty(grand)}")
        print("NOTE: DELETE makes pages reusable (the live run's growth stops) but the files only shrink with VACUUM FULL (--vacuum-full): "
              "it rewrites world_snapshots to ~its live size and takes an ACCESS EXCLUSIVE lock for the duration; pg_database_size drops only then.")

        if a.apply:
            if tconn is not None:
                deleted = 0
                for pl in plans:
                    if pl.delete and not pl.error:
                        deleted += apply_plan(tconn, pl)
                print(f"\napplied: deleted {deleted} interval snapshots")
                n = sum(sensor_prune(tconn, rid, p.sensor_window_ticks) for rid in sensor_runs)
                print(f"applied: sensor_samples rows deleted {n}")
                tconn.execute("VACUUM world_snapshots")
                if a.vacuum_full:
                    tconn.execute("VACUUM FULL world_snapshots")
                    print("applied: VACUUM FULL world_snapshots")
                print("telemetry database size now:", pretty(int(tconn.execute("SELECT pg_database_size(current_database())").fetchone()[0])))
            if pconn is not None:
                print(f"applied: {checkpoint_trim(pconn, p.checkpoints_keep)}")
    finally:
        if tconn is not None and tconn is not pconn:
            tconn.close()
        if pconn is not None:
            pconn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
