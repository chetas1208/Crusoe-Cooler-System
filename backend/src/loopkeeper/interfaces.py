"""Seams between the four backend work packages.

Everything crossing a seam is a plain JSON-able dict shaped EXACTLY like the
frontend contract in packages/core/src/contracts.ts (Topology, WorldSnapshot,
StreamEvent, Incident, AgentTask, ...). Do not invent parallel shapes.
SI units. Python 3.11+.
"""
from __future__ import annotations
from typing import Any, Awaitable, Callable, Protocol

Json = dict[str, Any]


class Plant(Protocol):
    """Physics (package A) -> engine (package B). Deterministic given seed + command order."""

    def topology(self) -> Json: ...                    # contracts.Topology
    def step(self, dt_s: float) -> None: ...           # advance fixed sim step (hydraulics when dirty, thermal always)
    def apply(self, cmd: Json) -> Json: ...            # plant-level command (valve/pump/clear/replace/inject_fault...) -> {ok, reason?, effects}
    def assets(self) -> Json: ...                      # {asset_id: AssetState} incl. status + readings (+ fault truth)
    def world(self) -> Json: ...                       # contracts.WorldSnapshot minus robots/incidents/agents (engine fills those)
    def get_state(self) -> bytes: ...                  # full serialisable state incl. RNG (snapshot)
    def set_state(self, blob: bytes) -> None: ...
    def state_hash(self) -> str: ...
    def solver_health(self) -> Json: ...               # {converged, residual, degraded: bool, reason?}


class EngineFacade(Protocol):
    """Engine (package B) -> orchestration (C) and API (D). Single writer lives behind this."""

    run_id: str
    def world(self) -> Json: ...                                       # full WorldSnapshot incl. last_seq
    def topology(self) -> Json: ...
    async def submit(self, cmd: Json) -> Json: ...                     # validated, idempotent by cmd["command_id"]; -> {accepted, reason?, command_id}
    def emit(self, type: str, entity_id: str, payload: Json) -> Json: ...  # append StreamEvent (agents use for incident.*, agent.task, agent.tool, verification.result)
    def events_since(self, seq: int, limit: int = 1000) -> list[Json]: ...
    def subscribe(self) -> "Subscription": ...


class Subscription(Protocol):
    def __aiter__(self): ...
    async def __anext__(self) -> Json: ...
    def close(self) -> None: ...


class AgentRuntime(Protocol):
    """Orchestration (package C). Engine calls on_tick at ~1 Hz wall/sim cadence; never per physics step.
    Must never block physics; model calls run as background tasks."""

    async def start(self, engine: EngineFacade) -> None: ...
    async def on_tick(self, world: Json, new_events: list[Json]) -> None: ...
    async def resume(self, open_incidents: list[Json]) -> None: ...    # after restart (from storage + LangGraph PG checkpoints)
    def model_status(self) -> Json: ...                                # contracts.EngineHealth.intelligence
    async def stop(self) -> None: ...
