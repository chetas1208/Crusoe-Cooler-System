"""Brain stores: ONE interface, two implementations (in-memory twin and Postgres). All semantics (provenance, promotion, conflicts, TTL)
live in service.py on top of this thin row interface, so both backends behave identically by construction.

Interface (synchronous, like loopkeeper.storage):
  insert(kind, row) -> bool            idempotent on the primary key (False when the row already exists)
  get(kind, key) -> row | None
  update(kind, key, changes) -> bool   status / counters / evidence only; content columns are never rewritten by the service
  select(kind, eq, status_in, live_at, order_by, desc, limit) -> rows
  delete(kind, key) -> bool            only used by prune()
  locked(name)                         context manager: serialises read-modify-write on one subject (advisory lock in Postgres)
"""
from __future__ import annotations

import contextlib
import copy
import threading
import zlib
from typing import Any, Iterator, Protocol

from .schema import TABLES

Json = dict[str, Any]


class BrainStore(Protocol):
    kind: str

    def insert(self, kind: str, row: Json) -> bool: ...
    def get(self, kind: str, key: Json) -> Json | None: ...
    def update(self, kind: str, key: Json, changes: Json) -> bool: ...
    def select(self, kind: str, *, eq: Json | None = None, status_in: tuple[str, ...] | None = None, live_at: float | None = None,
               order_by: str | None = None, desc: bool = True, limit: int | None = None) -> list[Json]: ...
    def delete(self, kind: str, key: Json) -> bool: ...
    def locked(self, name: str) -> Any: ...


def _check_cols(kind: str, cols: Any) -> None:
    allowed = set(TABLES[kind]["cols"])
    bad = set(cols) - allowed
    if bad:
        raise KeyError(f"unknown {kind} column(s): {sorted(bad)}")


class MemoryBrainStore:
    kind = "memory"

    def __init__(self) -> None:
        self._t: dict[str, dict[tuple, Json]] = {k: {} for k in TABLES}
        self._lock = threading.RLock()

    def _pk(self, kind: str, row: Json) -> tuple:
        return tuple(row[c] for c in TABLES[kind]["pk"])

    def insert(self, kind: str, row: Json) -> bool:
        _check_cols(kind, row)
        with self._lock:
            full = {c: row.get(c) for c in TABLES[kind]["cols"]}
            k = self._pk(kind, full)
            if k in self._t[kind]:
                return False
            self._t[kind][k] = copy.deepcopy(full)
            return True

    def get(self, kind: str, key: Json) -> Json | None:
        with self._lock:
            r = self._t[kind].get(self._pk(kind, key))
            return copy.deepcopy(r) if r else None

    def update(self, kind: str, key: Json, changes: Json) -> bool:
        _check_cols(kind, changes)
        with self._lock:
            r = self._t[kind].get(self._pk(kind, key))
            if r is None:
                return False
            r.update(copy.deepcopy(changes))
            return True

    def select(self, kind, *, eq=None, status_in=None, live_at=None, order_by=None, desc=True, limit=None):
        _check_cols(kind, eq or {})
        with self._lock:
            out = []
            for r in self._t[kind].values():
                if any(r.get(c) != v for c, v in (eq or {}).items()):
                    continue
                if status_in is not None and r.get("status") not in status_in:
                    continue
                if live_at is not None and r.get("expires_ts") is not None and r["expires_ts"] <= live_at:
                    continue
                out.append(copy.deepcopy(r))
        if order_by:
            if order_by not in TABLES[kind]["order"]:
                raise KeyError(order_by)
            out.sort(key=lambda r: (r[order_by] is not None, r[order_by] if r[order_by] is not None else 0), reverse=desc)
        return out[:limit] if limit else out

    def delete(self, kind: str, key: Json) -> bool:
        with self._lock:
            return self._t[kind].pop(self._pk(kind, key), None) is not None

    @contextlib.contextmanager
    def locked(self, name: str) -> Iterator[None]:
        with self._lock:
            yield


class PgBrainStore:
    """Postgres twin over the control-plane pool of PostgresStorage (psycopg_pool.ConnectionPool, dict_row). Parameterised SQL only; table and
    column names come from schema.TABLES (static), never from caller input."""
    kind = "postgres"

    def __init__(self, pool: Any) -> None:
        self.pool = pool
        self._tl = threading.local()

    @contextlib.contextmanager
    def _cx(self) -> Iterator[Any]:
        """Inside locked() the thread reuses the locked connection (one connection per worker, no pool starvation); otherwise a pooled one."""
        c = getattr(self._tl, "conn", None)
        if c is not None:
            yield c
        else:
            with self.pool.connection() as c2:
                yield c2

    @staticmethod
    def _wrap(kind: str, row: Json) -> Json:
        from psycopg.types.json import Jsonb
        js = set(TABLES[kind]["json"])
        return {c: (Jsonb(v) if (c in js and v is not None) else v) for c, v in row.items()}

    def insert(self, kind: str, row: Json) -> bool:
        _check_cols(kind, row)
        spec = TABLES[kind]
        cols = [c for c in spec["cols"]]
        full = self._wrap(kind, {c: row.get(c) for c in cols})
        sql = f"INSERT INTO {spec['table']} ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))}) ON CONFLICT ({', '.join(spec['pk'])}) DO NOTHING"
        with self._cx() as c:
            cur = c.execute(sql, [full[x] for x in cols])
            return cur.rowcount == 1

    def get(self, kind: str, key: Json) -> Json | None:
        spec = TABLES[kind]
        with self._cx() as c:
            cur = c.execute(f"SELECT {', '.join(spec['cols'])} FROM {spec['table']} WHERE " + " AND ".join(f"{k}=%s" for k in spec["pk"]),
                            [key[k] for k in spec["pk"]])
            return cur.fetchone()

    def update(self, kind: str, key: Json, changes: Json) -> bool:
        _check_cols(kind, changes)
        spec = TABLES[kind]
        ch = self._wrap(kind, changes)
        if not ch:
            return True
        with self._cx() as c:
            cur = c.execute(f"UPDATE {spec['table']} SET " + ", ".join(f"{k}=%s" for k in ch) + " WHERE " + " AND ".join(f"{k}=%s" for k in spec["pk"]),
                            [*ch.values(), *[key[k] for k in spec["pk"]]])
            return cur.rowcount == 1

    def select(self, kind, *, eq=None, status_in=None, live_at=None, order_by=None, desc=True, limit=None):
        _check_cols(kind, eq or {})
        spec = TABLES[kind]
        where, params = [], []
        for col, v in (eq or {}).items():
            if v is None:
                where.append(f"{col} IS NULL")
            else:
                where.append(f"{col}=%s")
                params.append(v)
        if status_in is not None:
            where.append("status = ANY(%s)")
            params.append(list(status_in))
        if live_at is not None:
            where.append("(expires_ts IS NULL OR expires_ts > %s)")
            params.append(live_at)
        sql = f"SELECT {', '.join(spec['cols'])} FROM {spec['table']}" + (" WHERE " + " AND ".join(where) if where else "")
        if order_by:
            if order_by not in spec["order"]:
                raise KeyError(order_by)
            sql += f" ORDER BY {order_by} {'DESC' if desc else 'ASC'} NULLS LAST"
        if limit:
            sql += " LIMIT %s"
            params.append(int(limit))
        with self._cx() as c:
            return list(c.execute(sql, params).fetchall())

    def delete(self, kind: str, key: Json) -> bool:
        spec = TABLES[kind]
        with self._cx() as c:
            cur = c.execute(f"DELETE FROM {spec['table']} WHERE " + " AND ".join(f"{k}=%s" for k in spec["pk"]), [key[k] for k in spec["pk"]])
            return cur.rowcount == 1

    @contextlib.contextmanager
    def locked(self, name: str) -> Iterator[None]:
        """Transaction-scoped advisory lock: the whole read-modify-write of the block runs in ONE transaction on ONE connection (committed on exit,
        rolled back on error) and the lock is released with it."""
        if getattr(self._tl, "conn", None) is not None:       # re-entrant use inside an already locked block
            yield
            return
        h = zlib.crc32(name.encode()) & 0x7FFFFFFF
        with self.pool.connection() as c:
            c.execute("SELECT pg_advisory_xact_lock(%s, %s)", (0x4C4B4252, h))      # 'LKBR' namespace
            self._tl.conn = c
            try:
                yield
            finally:
                self._tl.conn = None


def store_for(storage: Any) -> BrainStore:
    """The brain store that belongs to a loopkeeper Storage: Postgres pool when it has one, else a process-local in-memory store attached to the
    storage object (so every engine/run sharing that storage shares one brain)."""
    pool = getattr(storage, "pool", None)
    if pool is not None and getattr(storage, "kind", "") == "postgres":
        st = getattr(storage, "_shared_brain_store", None)
        if st is None:
            st = PgBrainStore(pool)
            try:
                storage._shared_brain_store = st
            except Exception:                                  # noqa: BLE001
                pass
        return st
    st = getattr(storage, "_shared_brain_store", None)
    if st is None:
        st = MemoryBrainStore()
        try:
            storage._shared_brain_store = st
        except Exception:                                      # noqa: BLE001
            pass
    return st
