"""What the API needs from the rest of the backend, and the adapters that make a bare ``EngineFacade`` enough.

The API is a *thin* layer:
  * reads  -> ``EngineFacade.world() / topology() / events_since()`` (+ optional engine extensions below)
  * writes -> ``EngineFacade.submit(command)`` ONLY. The API never touches world state and contains no physics.

``create_app(engine_service)`` takes anything that satisfies ``EngineFacade``. If that object additionally
exposes the *optional* attributes of ``EngineExtensions`` the API uses them (they are strictly better than the
API-side projections); every extension is feature-detected with ``getattr`` so a plain facade works.
Seam requests for package B are tracked in docs/engineering/seam-requests.md.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional, Protocol, runtime_checkable

from ..interfaces import AgentRuntime, EngineFacade, Json

# Command kinds the API submits for run-scoped robot control (engine owns semantics + physics).
CMD_LEASE_ACQUIRE = "robot.control.acquire"
CMD_LEASE_HEARTBEAT = "robot.control.heartbeat"
CMD_LEASE_RELEASE = "robot.control.release"
CMD_DRIVE = "robot.drive"


class NotSupported(Exception):
    """Raised by a RunManager for operations the connected engine does not implement (-> HTTP 501)."""


class RunNotFound(Exception):
    pass


class RunError(Exception):
    """A run manager refusal that maps onto the ApiProblem envelope (runs/types.ts ApiProblemCode)."""

    def __init__(self, code: str, message: str, status: int = 409, detail: Any = None) -> None:
        super().__init__(message)
        self.code, self.message, self.status, self.detail = code, message, status, detail


@runtime_checkable
class EngineExtensions(Protocol):
    """OPTIONAL extras an engine may provide. Everything is feature-detected; none is required."""

    def telemetry(self, asset_id: str, metric: str, window_s: float) -> Optional[Json]: ...   # TelemetrySeries
    def trace(self, incident_id: str) -> Optional[list[Json]]: ...                           # AgentTask[]
    def agent_tasks(self) -> list[Json]: ...                                                 # all AgentTask
    def readiness(self) -> Json: ...                         # {ready: bool, reasons: [str], database: 'ok'|..}
    runs: "RunManager"


class RunManager(Protocol):
    """Execution tab (backend.md §11). Provided by package B; ``LiveOnlyRunManager`` is the fallback.

    Return shapes are the frontend wire types in packages/core/src/runs/types.ts:
    RunSummary / CheckpointList / ReplayWindow / ForkResult. Raise ``RunError`` / ``NotSupported`` / ``RunNotFound``.
    Optional extras (feature-detected): ``set_state(run_id, state)``, ``validate_scenario(spec) -> {issues, support}``,
    ``interpret_scenario(text)``.
    """

    active_run_id: str

    def list_runs(self) -> list[Json]: ...                                  # RunSummary[]
    def get_run(self, run_id: str) -> Optional[Json]: ...                    # RunSummary | None
    def engine_for(self, run_id: str) -> Optional[EngineFacade]: ...
    async def create_run(self, spec: Json, principal: str) -> Json: ...      # ScenarioSpec -> RunSummary
    def checkpoints(self, run_id: str, to_tick: Optional[int]) -> list[Json]: ...    # CheckpointInfo[]
    async def replay(self, run_id: str, start_tick: Optional[int], end_tick: Optional[int], stride: int,
                     include_events: bool, limit: int) -> Json: ...         # ReplayWindow
    async def fork(self, run_id: str, request: Json, principal: str) -> Json: ...    # ForkRequest -> ForkResult


RUNS_SCHEMA_VERSION = "lk.runs.v1"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def run_record(engine: EngineFacade, *, created_at: str) -> Json:
    """RunSummary (runs/types.ts) derived from a facade. Unknown values are zero/None, never invented."""
    w = engine.world()
    h = w.get("health", {})
    incs = w.get("incidents", [])
    try:
        topo_hash = engine.topology().get("facility", {}).get("topology_hash", "")
    except Exception:
        topo_hash = ""
    return {
        "run_id": engine.run_id, "label": "Live baseline", "kind": "baseline", "mode": "LIVE",
        "state": "paused" if w.get("sim_status") == "paused" else "running",
        "parent_run_id": None, "fork_tick": None, "fork_snapshot_id": None, "scenario_id": None,
        "facility_id": w.get("facility_id", ""), "seed": h.get("seed", 0), "topology_hash": topo_hash,
        "schema_version": RUNS_SCHEMA_VERSION,
        "engine": {"backend": h.get("backend", "live"), "build": str(getattr(engine, "build", "unversioned"))},
        "created_at": created_at, "current_tick": w.get("sim_tick", 0), "current_time_s": w.get("sim_time_s", 0),
        "first_tick": 0,
        "recording": {"frames": 0, "checkpoints": 0, "events": w.get("last_seq", 0), "commands": 0, "approx_bytes": 0},
        "incidents": {"opened": len(incs), "resolved": sum(1 for i in incs if i.get("status") in ("resolved", "dismissed"))},
        "children": [], "head_hash": None,
    }


class LiveOnlyRunManager:
    """Fallback run manager: knows exactly one run (the active LIVE one) and says so honestly.

    * list/get/world/trace/robots work for the live run.
    * replay is a *read-only* tick-window projection of the event log (no frames, no state restore -> a ``gap``).
    * checkpoints: none (we do not invent restore points); fork/create_run: NotSupported (501).
    """

    def __init__(self, engine: EngineFacade) -> None:
        self._engine = engine
        self._created = now_iso()

    @property
    def active_run_id(self) -> str:
        return self._engine.run_id

    def list_runs(self) -> list[Json]:
        return [run_record(self._engine, created_at=self._created)]

    def get_run(self, run_id: str) -> Optional[Json]:
        return self.list_runs()[0] if run_id == self._engine.run_id else None

    def engine_for(self, run_id: str) -> Optional[EngineFacade]:
        return self._engine if run_id == self._engine.run_id else None

    async def create_run(self, spec: Json, principal: str) -> Json:
        raise NotSupported("this engine serves a single live run; starting scenario runs is not available")

    def checkpoints(self, run_id: str, to_tick: Optional[int]) -> list[Json]:
        return []

    async def replay(self, run_id: str, start_tick: Optional[int], end_tick: Optional[int], stride: int,
                     include_events: bool, limit: int) -> Json:
        if run_id != self._engine.run_id:
            raise RunNotFound(run_id)
        w = self._engine.world()
        now_tick = int(w.get("sim_tick", 0))
        lo = int(start_tick) if start_tick is not None else 0
        hi = int(end_tick) if end_tick is not None else now_tick
        events: list[Json] = []
        first_tick: Optional[int] = None
        seq = 0
        done = False
        while include_events and not done:
            page = self._engine.events_since(seq, 1000)
            if not page:
                break
            for ev in page:
                t = int(ev.get("sim_tick", 0))
                if first_tick is None:
                    first_tick = t
                if t < lo:
                    continue
                if t > hi or len(events) >= limit:
                    done = True
                    break
                events.append(ev)
            seq = page[-1]["seq"]
        return {
            "run_id": run_id, "schema_version": RUNS_SCHEMA_VERSION, "start_tick": lo, "end_tick": hi,
            "stride": max(1, stride), "recorded_from_tick": first_tick or 0, "recorded_to_tick": now_tick,
            "frames": [], "events": events, "commands": [], "checkpoints": [],
            "gaps": [{"from_tick": lo, "to_tick": hi, "kind": "not_recorded",
                      "reason": "this engine has no world-frame recorder; only the event log is available"}],
            "frozen_agent_decisions": True,
        }

    async def fork(self, run_id: str, request: Json, principal: str) -> Json:
        raise NotSupported("this engine has no checkpoint store, so verified forks are not available")


def run_manager_for(engine: Any) -> RunManager:
    mgr = getattr(engine, "runs", None)
    if mgr is not None:
        return mgr
    if getattr(engine, "storage", None) is not None:
        try:
            from .runs_storage import StorageRunManager
            return StorageRunManager(engine)
        except Exception:
            pass
    return LiveOnlyRunManager(engine)
