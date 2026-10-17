"""Wire the real packages behind the API (A physics, B engine, C orchestration).

Imports are lazy and failures are explicit: this module never fabricates an engine. Expected seams:
  * ``loopkeeper.physics``       - a ``Plant`` implementation (package A)
  * ``loopkeeper.engine``        - ``create_engine(plant=..., agent_runtime=..., **cfg) -> EngineService`` (package B;
                                   see backend/src/loopkeeper/engine/README.md once it lands)
  * ``loopkeeper.orchestration`` - ``create_agent_runtime(...) -> AgentRuntime`` (package C)
Adjust the three factory names below if the packages export them differently (tracked in seam-requests.md).
"""
from __future__ import annotations

import importlib
import os
from typing import Any, Optional, Tuple


class WiringError(RuntimeError):
    pass


def _factory(module: str, names: tuple[str, ...]) -> Any:
    try:
        mod = importlib.import_module(module)
    except ImportError as e:
        raise WiringError(f"{module} is not available yet ({e.name or e})") from e
    for n in names:
        fn = getattr(mod, n, None)
        if callable(fn):
            return fn
    raise WiringError(f"{module} exports none of {names}")


def build_real_stack() -> Tuple[Any, Optional[Any]]:
    """Return ``(engine_service, agent_runtime)`` built from the environment (see .env.example)."""
    create_engine = _factory("loopkeeper.engine", ("create_engine",))
    runtime = None
    try:
        runtime = _factory("loopkeeper.orchestration", ("create_agent_runtime", "create_runtime"))()
    except WiringError:
        runtime = None  # engine may own its AgentRuntime; /models/status then reads engine health only (truthful)
    try:
        plant = _factory("loopkeeper.physics", ("create_plant",))(seed=int(os.environ.get("WORLD_SEED", "8")))
        engine = create_engine(plant=plant, agent_runtime=runtime)
    except WiringError:
        engine = create_engine(agent_runtime=runtime)  # engine builds its own plant if it can
    try:
        from .runs_storage import StorageRunManager
        if getattr(engine, "storage", None) is not None and not hasattr(engine, "runs"):
            engine.runs = StorageRunManager(engine)         # Execution tab: checkpoints/frames from stored snapshots
    except Exception:                                      # noqa: BLE001
        pass
    return engine, runtime
