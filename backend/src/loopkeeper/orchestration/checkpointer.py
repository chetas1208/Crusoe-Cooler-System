"""LangGraph checkpointer factory: PostgreSQL (restart-safe) or, ONLY without DATABASE_URL, InMemorySaver."""
from __future__ import annotations

import logging
from contextlib import AsyncExitStack
from typing import Any

log = logging.getLogger("loopkeeper.agents")


class CheckpointerUnavailable(RuntimeError):
    pass


def normalize_url(url: str) -> str:
    return url.replace("postgresql+psycopg://", "postgresql://").replace("postgres+psycopg://", "postgresql://")


async def make_checkpointer(database_url: str | None, stack: AsyncExitStack) -> tuple[Any, str, Any]:
    """Returns (saver, kind, pool). kind is 'postgres' or 'memory'."""
    if not database_url:
        from langgraph.checkpoint.memory import InMemorySaver
        log.warning("DATABASE_URL not set: using InMemorySaver - agent graphs will NOT survive a restart")
        return InMemorySaver(), "memory", None
    try:
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
        from psycopg.rows import dict_row
        from psycopg_pool import AsyncConnectionPool

        pool = AsyncConnectionPool(conninfo=normalize_url(database_url), max_size=10, open=False,
                                   kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row})
        await pool.open(wait=True, timeout=15)
        stack.push_async_callback(pool.close)
        saver = AsyncPostgresSaver(pool)
        await saver.setup()
        return saver, "postgres", pool
    except Exception as e:
        raise CheckpointerUnavailable(f"PostgreSQL checkpointer unavailable ({type(e).__name__}); agents fail closed") from None
