"""Request-thread reads of live engine state.

Sync route handlers run on a worker thread while the engine loop mutates its dicts / deques on the event-loop thread. CPython raises
``RuntimeError: dictionary changed size during iteration`` / ``deque mutated during iteration`` for such a race; it is transient (the next
attempt sees a consistent state), so a read that hits it is simply re-run instead of answering 500. Wired in as the router ``route_class``.
"""
from __future__ import annotations

import functools
import inspect
import time
from typing import Any, Callable

from fastapi.routing import APIRoute

_RACE = ("changed size during iteration", "mutated during iteration")
TRIES = 8


def is_iteration_race(e: BaseException) -> bool:
    return isinstance(e, RuntimeError) and any(m in str(e) for m in _RACE)


def retry_on_iteration_race(fn: Callable[..., Any]) -> Callable[..., Any]:
    try:
        sig = inspect.signature(fn, eval_str=True)          # FastAPI resolves annotations against the wrapped function's globals
    except Exception:                                       # noqa: BLE001
        return fn

    @functools.wraps(fn)
    def wrapper(*a: Any, **k: Any) -> Any:
        for i in range(TRIES):
            try:
                return fn(*a, **k)
            except RuntimeError as e:
                if i + 1 >= TRIES or not is_iteration_race(e):
                    raise
                time.sleep(0.004 * (i + 1))

    wrapper.__signature__ = sig                              # type: ignore[attr-defined]
    return wrapper


class SafeReadRoute(APIRoute):
    def __init__(self, path: str, endpoint: Callable[..., Any], **kw: Any) -> None:
        if not inspect.iscoroutinefunction(endpoint):         # async handlers run on the engine's own thread: no race
            endpoint = retry_on_iteration_race(endpoint)
        super().__init__(path, endpoint, **kw)
