"""Shared runtime handles for graph nodes: engine access, event emission, waiters, limits, ledger."""
from __future__ import annotations

import asyncio
import copy
import logging
import re
from dataclasses import dataclass
from typing import Any, Callable

from loopkeeper.intelligence.decisions import DecisionService

from .facility import Facility
from .monitor import Monitor
from .policy import Policy, ResourceLocks, Verdict
from .world import History, Json, sim_time

log = logging.getLogger("loopkeeper.agents")

_SECRET_KEY = re.compile(r"(api[_-]?key|secret|token|password|authorization|credential|bearer)", re.I)


def redact(obj: Any, depth: int = 0) -> Any:
    """Redact secret-looking keys and bound sizes before anything reaches events / the browser."""
    if depth > 6:
        return "[truncated]"
    if isinstance(obj, dict):
        return {str(k)[:64]: ("[redacted]" if _SECRET_KEY.search(str(k)) else redact(v, depth + 1))
                for k, v in list(obj.items())[:40]}
    if isinstance(obj, (list, tuple)):
        return [redact(v, depth + 1) for v in list(obj)[:40]]
    if isinstance(obj, str):
        return obj[:400]
    if isinstance(obj, (int, float, bool)) or obj is None:
        return obj
    return str(obj)[:200]


@dataclass
class Limits:
    max_depth: int = 3
    max_concurrent: int = 4
    max_replans: int = 2
    max_plan_retries: int = 2
    token_budget: int = 60000
    max_open_incidents: int = 3
    persist_s: float = 16.0
    verify_window_s: float = 55.0
    verify_extension_s: float = 60.0
    tool_dwell_s: float = 0.0
    hold_timeout_s: float = 1800.0
    mission_timeout_s: float = 900.0
    approval_mode: str = "autonomous"
    approval_window_s: float = 20.0
    settle_grace_s: float = 90.0


class Ledger:
    """Latest emitted objects, for /trace and restart seeding (the event log stays authoritative)."""

    def __init__(self) -> None:
        self.incidents: dict[str, Json] = {}
        self.tasks: dict[str, Json] = {}
        self.verifications: dict[str, Json] = {}

    def apply(self, typ: str, entity_id: str, p: Json) -> None:
        if typ.startswith("incident."):
            self.incidents[entity_id] = p["incident"]
        elif typ == "agent.task":
            self.tasks[p["task"]["id"]] = p["task"]
        elif typ == "agent.tool":
            t = self.tasks.get(p["task_id"])
            if t is not None:
                calls = [c for c in t.get("tool_calls", []) if c["id"] != p["tool_call"]["id"]]
                t["tool_calls"] = calls + [p["tool_call"]]
        elif typ == "verification.result":
            self.verifications[entity_id] = p["verification"]

    def trace(self, incident_id: str) -> Json:
        inc = self.incidents.get(incident_id) or {}
        ids = inc.get("task_ids", [])
        return {"incident_id": incident_id, "tasks": [self.tasks[i] for i in ids if i in self.tasks]}


class AgentContext:
    def __init__(self, engine: Any, fac: Facility, policy: Policy, monitor: Monitor, history: History,
                 decisions: DecisionService, limits: Limits, locks: ResourceLocks) -> None:
        self.engine, self.fac, self.policy, self.monitor = engine, fac, policy, monitor
        self.history, self.decisions, self.limits, self.locks = history, decisions, limits, locks
        self.ledger = Ledger()
        self._world: Json = {}
        self._waiters: list[tuple[Callable[[], bool], asyncio.Future, float | None]] = []
        self._sems: dict[str, asyncio.Semaphore] = {}
        self.suppress: dict[str, float] = {}
        self.open_keys: dict[str, str] = {}
        self.command_count = 0
        self.approvals: dict[str, Json] = {}
        self.severity: dict[str, str] = {}
        self.maint: dict[str, tuple[str, float]] = {}   # rack -> (incident doing maintenance on it, until sim-time)
        self.activity = 0
        self.assignments: dict[str, Json] = {}          # incident id -> last robot assignment (score, ETA, route plan id)

    # ── world access ──
    @property
    def world(self) -> Json:
        return self._world or self.engine.world()

    def set_world(self, w: Json) -> None:
        self._world = w

    @property
    def now(self) -> float:
        return sim_time(self.world)

    @property
    def tick(self) -> int:
        return int(self.world.get("sim_tick", 0))

    @property
    def version(self) -> int:
        return int(self.world.get("version", 0))

    def sem(self, incident_id: str) -> asyncio.Semaphore:
        return self._sems.setdefault(incident_id, asyncio.Semaphore(self.limits.max_concurrent))

    # ── events ──
    def emit(self, typ: str, entity_id: str, payload: Json) -> None:
        self.activity += 1
        payload = copy.deepcopy(payload)
        try:
            self.ledger.apply(typ, entity_id, copy.deepcopy(payload))
        except Exception:
            log.exception("ledger apply failed")
        try:
            self.engine.emit(typ, entity_id, payload)
        except Exception:
            log.exception("engine.emit failed type=%s", typ)

    # ── commands ──
    def make_cmd(self, kind: str, command_id: str, *, incident_id: str, task_id: str, role: str,
                 target_id: str | None = None, args: Json | None = None) -> Json:
        return {"command_id": command_id, "kind": kind, "target_id": target_id, "args": args or {},
                "actor_type": "agent", "agent_role": role, "incident_id": incident_id, "task_id": task_id,
                "expected_world_version": None}

    async def submit(self, cmd: Json, incident_id: str | None = None) -> tuple[Json, Verdict]:
        self.activity += 1
        v = self.policy.check_command(cmd, self.world, incident_id)
        if not v.ok:
            log.info("command rejected by policy id=%s reasons=%s", cmd.get("command_id"), v.reasons[:3])
            return {"accepted": False, "command_id": cmd.get("command_id"), "reason": "policy: " + "; ".join(v.reasons)[:300],
                    "policy": True}, v
        last: Exception | None = None
        for _ in range(3):
            try:
                self.command_count += 1
                ack = await self.engine.submit(cmd)
                return dict(ack or {}), v
            except Exception as e:  # transient engine error: resubmit with the SAME id (idempotent)
                last = e
                await asyncio.sleep(0)
        return {"accepted": False, "command_id": cmd.get("command_id"), "reason": f"engine error: {type(last).__name__}"}, v

    # ── waiting on world conditions (sim time) ──
    async def wait_until(self, cond: Callable[[], bool], timeout_s: float | None = None) -> bool:
        if cond():
            return True
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._waiters.append((cond, fut, None if timeout_s is None else self.now + timeout_s))
        try:
            return await fut
        finally:
            self._waiters = [w for w in self._waiters if w[1] is not fut]

    async def sleep_sim(self, seconds: float) -> None:
        end = self.now + seconds
        await self.wait_until(lambda: self.now >= end)

    def eval_waiters(self) -> None:
        now = self.now
        for cond, fut, dl in list(self._waiters):
            if fut.done():
                continue
            try:
                if cond():
                    fut.set_result(True)
                elif dl is not None and now >= dl:
                    fut.set_result(False)
            except Exception as e:
                fut.set_exception(e)

    @property
    def waiting(self) -> int:
        return len([w for w in self._waiters if not w[1].done()])

    # ── suppression of detectors during repair ──
    def lock_suppress(self, ids: list[str], until: float | None = None) -> None:
        for i in ids:
            self.suppress[i] = float("inf") if until is None else until

    def racks_in_maintenance(self, except_incident: str) -> set[str]:
        """Racks another incident is cordoning/isolating (or recently restored): their margins/flows are transient, not evidence."""
        now = self.now
        return {r for r, (owner, until) in self.maint.items() if owner != except_incident and until > now}

    def suppressed(self) -> set[str]:
        now = self.now
        for k in [k for k, u in self.suppress.items() if u <= now]:
            del self.suppress[k]
        return set(self.suppress)
