"""Persistence for the LOOPKEEPER engine: Postgres (psycopg3, plain SQL migrations) + in-memory twin."""
from __future__ import annotations

from .base import (SCHEMA_VERSION, CommitBatch, LeaderLease, LeadershipLost, NotFound, Storage, StorageError)
from .memory import MemoryStorage


def open_storage(url: str | None, telemetry_url: str | None = None) -> Storage:
    """`None`, '' or 'memory:' -> MemoryStorage; 'postgresql://...' -> PostgresStorage (migrated)."""
    if not url or url.startswith("memory"):
        return MemoryStorage()
    from .postgres import PostgresStorage

    st = PostgresStorage(url, telemetry_url=telemetry_url)
    st.migrate()
    try:                                   # size guard: sheds telemetry at 90 % of the project size, thins on a timer (never fatal)
        from . import maintenance
        maintenance.install(st)
    except Exception:                      # noqa: BLE001
        pass
    return st


__all__ = ["open_storage", "Storage", "MemoryStorage", "CommitBatch", "LeaderLease", "LeadershipLost",
           "StorageError", "NotFound", "SCHEMA_VERSION"]
