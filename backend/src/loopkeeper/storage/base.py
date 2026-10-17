"""Storage interface shared by the Postgres and in-memory backends.

All methods are synchronous (callers wrap them with asyncio.to_thread). Everything is scoped by run_id.
`commit()` is the single atomic write path of the single-writer engine."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

Json = dict[str, Any]

SCHEMA_VERSION = 1
RUN_PHASES = ("queued", "running", "paused", "stopped", "failed", "completed")
RUN_UPDATE_FIELDS = ("last_tick", "last_seq", "last_apply_order", "phase", "sim_speed", "label", "meta", "nav_graph_revision")


class StorageError(RuntimeError):
    """Storage unavailable / failed (message is safe to show; no DSN, no SQL)."""


class LeadershipLost(StorageError):
    """The writer's leader epoch is stale: another process owns the facility."""


class NotFound(KeyError):
    pass


@dataclass
class CommitBatch:
    run_id: str
    facility_id: str
    leader_epoch: int | None = None
    events: list[Json] = field(default_factory=list)
    commands: list[Json] = field(default_factory=list)
    missions: list[Json] = field(default_factory=list)
    robots: list[Json] = field(default_factory=list)
    incidents: list[Json] = field(default_factory=list)
    agent_runs: list[Json] = field(default_factory=list)
    verification_runs: list[Json] = field(default_factory=list)
    leases: list[Json] = field(default_factory=list)
    snapshots: list[Json] = field(default_factory=list)
    contracts: list[Json] = field(default_factory=list)          # V11 done_contracts upserts
    routes: list[Json] = field(default_factory=list)            # V7 robot_routes upserts (committed / arrived / cancelled plans)
    reservations: list[Json] = field(default_factory=list)      # V7 traffic_reservations state changes
    sensor_samples: list[Json] = field(default_factory=list)
    applied_effects: list[str] = field(default_factory=list)
    run_update: Json = field(default_factory=dict)

    def empty(self) -> bool:
        return not any((self.events, self.commands, self.missions, self.robots, self.incidents, self.agent_runs,
                        self.verification_runs, self.leases, self.snapshots, self.contracts, self.routes, self.reservations, self.sensor_samples,
                        self.applied_effects, self.run_update))


class LeaderLease(ABC):
    facility_id: str
    holder: str
    epoch: int

    @abstractmethod
    def held(self) -> bool: ...
    @abstractmethod
    def heartbeat(self) -> bool: ...
    @abstractmethod
    def release(self) -> None: ...


class Storage(ABC):
    kind: str = "abstract"

    # lifecycle
    @abstractmethod
    def migrate(self) -> None: ...
    @abstractmethod
    def close(self) -> None: ...
    @abstractmethod
    def ping(self) -> bool: ...

    # facility / leader / scenarios
    @abstractmethod
    def register_facility(self, facility_id: str, config_version: str, topology_hash: str, topology: Json) -> None: ...
    @abstractmethod
    def get_facility(self, facility_id: str) -> Json | None: ...
    @abstractmethod
    def get_topology(self, facility_id: str, topology_hash: str) -> Json | None:
        """The topology recorded under this hash (never overwritten); None if it was never registered."""
    @abstractmethod
    def put_topology(self, facility_id: str, config_version: str, topology_hash: str, topology: Json) -> bool:
        """Register a topology in the immutable registry only (no `facilities` upsert). True if it was new."""
    @abstractmethod
    def fork_run(self, child: Json, snapshot: Json) -> None:
        """Atomically create the child run row and copy ONE parent snapshot into it. The parent's rows are never touched."""
    @abstractmethod
    def acquire_leader(self, facility_id: str, holder: str) -> LeaderLease | None: ...
    @abstractmethod
    def save_scenario(self, row: Json) -> None: ...
    @abstractmethod
    def get_scenario(self, scenario_id: str) -> Json | None: ...

    # runs
    @abstractmethod
    def create_run(self, row: Json) -> None: ...
    @abstractmethod
    def get_run(self, run_id: str) -> Json | None: ...
    @abstractmethod
    def list_runs(self, facility_id: str | None = None, phases: list[str] | None = None, limit: int = 200) -> list[Json]: ...
    @abstractmethod
    def update_run(self, run_id: str, **fields: Any) -> None: ...

    # atomic write path
    @abstractmethod
    def commit(self, batch: CommitBatch) -> None: ...

    # snapshots
    @abstractmethod
    def list_snapshots(self, run_id: str, to_tick: int | None = None) -> list[Json]: ...
    @abstractmethod
    def get_snapshot(self, run_id: str, snapshot_id: str) -> Json | None: ...
    def get_snapshot_worlds(self, run_id: str, snapshot_ids: list[str]) -> dict[str, Json]:
        """{snapshot_id: world} for many snapshots; backends override this with a single query."""
        out: dict[str, Json] = {}
        for sid in snapshot_ids:
            row = self.get_snapshot(run_id, sid)
            if row and row.get("world"):
                out[sid] = row["world"]
        return out

    @abstractmethod
    def latest_snapshot(self, run_id: str, max_tick: int | None = None, max_seq: int | None = None) -> Json | None: ...

    # V7 navigation graphs (immutable per revision) and per-run routes / reservations
    @abstractmethod
    def register_nav_graph(self, kind: str, revision: str, nodes: list[Json], edges: list[Json]) -> None: ...
    @abstractmethod
    def load_nav_graph(self, kind: str, revision: str) -> Json | None: ...
    @abstractmethod
    def load_routes(self, run_id: str) -> list[Json]: ...
    @abstractmethod
    def load_reservations(self, run_id: str, state: str | None = None) -> list[Json]: ...

    # events
    @abstractmethod
    def load_events(self, run_id: str, after_seq: int = 0, until_seq: int | None = None, until_tick: int | None = None,
                    limit: int | None = None, kinds: list[str] | None = None,
                    exclude_kinds: list[str] | None = None) -> list[Json]: ...
    @abstractmethod
    def load_communications(self, run_id: str, *, after_seq: int = 0, before_seq: int | None = None, until_tick: int | None = None, limit: int = 100,
                            message_type: str | None = None, agent_class: str | None = None, thread_id: str | None = None,
                            newest_first: bool = False, event_id: str | None = None) -> list[Json]:
        """Stored world_events rows of kind 'comm.*' (V10 CommunicationEventV1 projection), bounded; filters are ANDed. `agent_class` matches the
        sender OR recipient class."""
    @abstractmethod
    def last_event_seq(self, run_id: str) -> int: ...
    @abstractmethod
    def events_digest(self, run_id: str, upto_seq: int | None = None) -> str: ...

    # commands
    @abstractmethod
    def get_command(self, run_id: str, command_id: str) -> Json | None: ...
    @abstractmethod
    def load_commands(self, run_id: str, after_apply_order: int = 0, accepted_only: bool = True,
                      limit: int | None = None) -> list[Json]: ...

    # projections of current state (written by commit, read for recovery / API)
    @abstractmethod
    def load_missions(self, run_id: str) -> list[Json]: ...
    @abstractmethod
    def load_robots(self, run_id: str) -> list[Json]: ...
    @abstractmethod
    def load_incidents(self, run_id: str, open_only: bool = False) -> list[Json]: ...
    @abstractmethod
    def load_leases(self, run_id: str, active_only: bool = False) -> list[Json]: ...
    @abstractmethod
    def load_contracts(self, run_id: str, incident_id: str | None = None) -> list[Json]: ...

    # agent decisions (frozen model output for replay) and telemetry history
    @abstractmethod
    def record_agent_decision(self, row: Json) -> None: ...
    @abstractmethod
    def load_agent_decisions(self, run_id: str, from_tick: int = 0, to_tick: int | None = None) -> list[Json]: ...
    @abstractmethod
    def load_sensor_samples(self, run_id: str, asset_id: str, metric: str, since_sim_time_s: float = 0.0,
                            limit: int = 5000) -> list[Json]: ...
    @abstractmethod
    def has_applied_effect(self, run_id: str, effect_key: str) -> bool: ...
