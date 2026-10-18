"""AgentRuntime implementation (package C): monitor -> incidents -> LangGraph SENTINEL threads."""
from __future__ import annotations

import asyncio
import copy
import logging
import os
from contextlib import AsyncExitStack
from typing import Any

from loopkeeper.intelligence.crusoe import DETERMINISTIC_MODEL_ID, IntelligenceConfig, ModelClient, ModelStatus, probe_model
from loopkeeper.intelligence.decisions import DecisionService, DecisionStore, MemoryDecisionStore, PgDecisionStore

from .checkpointer import CheckpointerUnavailable, make_checkpointer
from .context import AgentContext, Limits
from .facility import Facility
from .graphs.sentinel import build_incident_graph
from .monitor import Detection, IncidentOpener, Monitor, key_for_anchor
from .policy import Policy, ResourceLocks
from .world import History, Json, sim_time

log = logging.getLogger("loopkeeper.agents")

CLOSED = ("resolved", "dismissed")
CAUSE_OF_PREFIX = {"strainer": "strainer_blockage", "valve": "valve_stuck", "pump": "pump_degradation", "sensor": "sensor_drift",
                   "workload": "workload_spike", "fouling": "fouling"}


class AgentRuntimeImpl:
    def __init__(self, *, intelligence: IntelligenceConfig | None = None, model_client: ModelClient | None = None,
                 checkpointer: Any | None = None, database_url: str | None = None, limits: Limits | None = None,
                 decision_store: DecisionStore | None = None, replay: bool = False) -> None:
        self.cfg = intelligence if intelligence is not None else IntelligenceConfig.from_env()
        self._client_in = model_client
        self._saver_in = checkpointer
        self.database_url = database_url if database_url is not None else (os.environ.get("DATABASE_URL") or None)
        self.limits = limits or Limits(approval_mode=os.environ.get("SAFE_AUTOMATION_MODE", "autonomous") if os.environ.get("SAFE_AUTOMATION_MODE") in ("autonomous", "supervised") else "autonomous")
        self._store_in = decision_store
        self.replay = replay
        self.engine: Any = None
        self.ctx: AgentContext | None = None
        self.graph: Any = None
        self.status = ModelStatus("deterministic", DETERMINISTIC_MODEL_ID, "fallback", "runtime not started")
        self.checkpointer_kind = "none"
        self._stack = AsyncExitStack()
        self._tasks: dict[str, asyncio.Task] = {}
        self._inc_seq = 0
        self._last_sev = -1e9
        self._monitor_saved = False
        self._progress: dict[str, tuple[Any, float]] = {}      # incident -> (progress signature, sim time it last changed)
        self._next_live = 0.0
        self._reopen_after: dict[str, float] = {}               # detector key -> sim time before which an escalated anchor is not re-opened
        self.errors: list[str] = []

    # ── lifecycle ──
    async def start(self, engine: Any) -> None:
        self.engine = engine
        run_id = getattr(engine, "run_id", "run")
        fac = Facility(engine.topology())
        locks = ResourceLocks()
        policy = Policy(fac, approval_mode=self.limits.approval_mode, approval_window_s=self.limits.approval_window_s, locks=locks)
        monitor = Monitor(fac, persist_s=self.limits.persist_s)
        client_in = self._client_in
        self.gateway = None
        if client_in is None and self.cfg.configured:                  # V11: the inference gateway (retry/backoff/budget/breaker/model_calls) is the default client
            from loopkeeper.inference.default import build_default_gateway, gateway_enabled
            if gateway_enabled():
                self.gateway = client_in = await build_default_gateway(self.cfg, run_id, getattr(engine, "storage", None) or getattr(getattr(engine, "_e", None), "storage", None))
        self.status, client = await probe_model(self.cfg, client_in)
        if self._saver_in is not None:
            saver, self.checkpointer_kind, pool = self._saver_in, "injected", None
            if type(saver).__name__ == "InMemorySaver":
                self.checkpointer_kind = "memory"
        else:
            saver, self.checkpointer_kind, pool = await make_checkpointer(self.database_url, self._stack)
        store = self._store_in or getattr(engine, "decision_store", None)
        if store is None:
            if pool is not None:
                store = PgDecisionStore(pool, run_id)
                await store.setup()
            else:
                store = MemoryDecisionStore()
        decisions = DecisionService(client, self.status, store, run_id=run_id, token_budget=self.limits.token_budget, replay=self.replay)
        self.ctx = AgentContext(engine, fac, policy, monitor, History(), decisions, self.limits, locks)
        decisions.observer = self._on_provider
        self.ctx.set_world(engine.world())
        self.opener = IncidentOpener(fac)
        self.graph = build_incident_graph(self.ctx, saver)
        self.client = client
        blob = await store.get_blob(f"{run_id}:monitor")
        if blob:
            monitor.load_state(blob)
        log.info("agent runtime started run=%s model=%s/%s status=%s checkpointer=%s", run_id, self.status.provider, self.status.model_id,
                 self.status.status, self.checkpointer_kind)

    def _on_provider(self, event: str, req: Any, info: Json) -> None:
        """Real model-provider boundary (Crusoe): started / finished / error / unavailable -> one typed communication event each."""
        fn = getattr(self.engine, "comm_provider", None)
        if fn is None or self.ctx is None:
            return
        st = self.ctx.decisions.status
        phase = {"started": "started", "finished": "completed"}.get(event, "error")
        key = req.key if event != "unavailable" else f"unavail:{info.get('reason', '')[:40]}:{int(self.ctx.now // 60)}"
        fn(phase, provider=info.get("provider") or st.provider, model_id=info.get("model_id") or st.model_id, purpose=req.kind, incident_id=req.incident_id or None,
           task_id=req.task_id or None, key=key, latency_ms=info.get("latency_ms"), reason=info.get("reason"), tokens_in=info.get("tokens_in"),
           tokens_out=info.get("tokens_out"))

    async def stop(self) -> None:
        for t in list(self._tasks.values()):
            t.cancel()
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)
        self._tasks.clear()
        if getattr(self, "client", None) is not None:
            await self.client.aclose()
        await self._stack.aclose()

    # ── per-tick (never blocks, never calls a model) ──
    async def on_tick(self, world: Json, new_events: list[Json]) -> None:
        ctx = self.ctx
        if ctx is None:
            return
        ctx.set_world(world)
        h = world.get("health") or {}
        if h.get("safe_automation_mode") in ("autonomous", "supervised"):
            ctx.policy.mode = h["safe_automation_mode"]
        if isinstance(h.get("approval_window_s"), (int, float)):
            ctx.policy.window = float(h["approval_window_s"])
        try:
            ctx.history.add(world)
            dets = ctx.monitor.evaluate(world, ctx.suppressed())
            if ctx.monitor.calibrated and not self._monitor_saved:
                self._monitor_saved = True
                await ctx.decisions.store.put_blob(f"{ctx.decisions.run_id}:monitor", ctx.monitor.export_state())
            self._ingest(dets, world)
            self._refresh_severity(world)
            self._reap()
            self._liveness(world)
        except Exception:
            log.exception("on_tick failed (physics unaffected)")
        ctx.eval_waiters()

    # ── incidents ──
    def _open_count(self) -> int:
        # monitor-only workload surges never dispatch a robot, so they must not starve real faults of incident slots
        return sum(1 for i in self.ctx.ledger.incidents.values() if i.get("closed_tick") is None and i.get("status") != "escalated" and i.get("cause") != "workload_spike"
                   and not str(i.get("title", "")).endswith("load surge"))

    def _next_inc_id(self, world: Json) -> str:
        nums = [self._inc_seq] + [int(i["id"].split("-")[-1]) for i in (world.get("incidents") or []) if str(i.get("id", "")).startswith("INC-")]
        self._inc_seq = max(nums) + 1
        return f"INC-{self._inc_seq:03d}"

    def _ingest(self, dets: list[Detection], world: Json) -> None:
        ctx = self.ctx
        for det in dets:
            if det.key in ctx.open_keys:
                continue
            if sim_time(world) < self._reopen_after.get(det.key, 0.0):
                continue
            if self._open_count() >= self.limits.max_open_incidents:
                break  # lower-priority investigations are deferred; the detector keeps asserting
            inc_id = self._next_inc_id(world)
            inc = self.opener.open(self.engine, det, inc_id, int(world.get("sim_tick", 0)), sim_time(world))
            ctx.ledger.incidents[inc_id] = copy.deepcopy(inc)
            ctx.open_keys[det.key] = inc_id
            ctx.severity[inc_id] = det.severity
            self._launch(inc_id, {"incident": inc, "det": det.to_dict(), "tasks": {}, "task_seq": 0, "ev_seq": 0, "attempt": 0, "tokens_used": 0})

    def _launch(self, inc_id: str, init: Json | None) -> None:
        self._tasks[inc_id] = asyncio.create_task(self._run(inc_id, init), name=f"incident:{inc_id}")

    def _cfg(self, inc_id: str) -> Json:
        return {"configurable": {"thread_id": f"{self.ctx.decisions.run_id}:{inc_id}"}, "recursion_limit": 250}

    async def _run(self, inc_id: str, init: Json | None) -> None:
        ctx = self.ctx
        try:
            await self.graph.ainvoke(init, self._cfg(inc_id), durability="sync")
            snap = await self.graph.aget_state(self._cfg(inc_id))
            outcome = (snap.values or {}).get("outcome")
            if outcome in ("resolved", "dismissed"):
                self._release_keys(inc_id)
            elif outcome == "escalated":
                self._release_keys(inc_id, cooldown_s=self.limits.reopen_cooldown_s)      # a persisting fault may open a fresh incident after the cool-down
            ctx.decisions.release(inc_id)
            ctx.locks.release_all(inc_id)
        except asyncio.CancelledError:
            ctx.release_suppress(inc_id)
            raise  # shutdown: checkpoints stay; resume() continues the thread
        except Exception as e:
            log.exception("incident graph failed id=%s", inc_id)
            self.errors.append(f"{inc_id}: {type(e).__name__}")
            ctx.locks.release_all(inc_id)
            ctx.release_suppress(inc_id)
            ctx.decisions.release(inc_id)
            inc = copy.deepcopy(ctx.ledger.incidents.get(inc_id))
            if inc and inc.get("closed_tick") is None:
                inc["status"] = "escalated"
                inc["summary"] = f"Agent orchestration error ({type(e).__name__}); operator review required. Monitoring continues."
                ctx.emit("incident.updated", inc_id, {"incident": inc})
                self._release_keys(inc_id, cooldown_s=self.limits.reopen_cooldown_s)
                self._stuck_contract(inc_id, "An internal error stopped the agent graph for this incident.", timed_out=False)

    def _release_keys(self, inc_id: str, cooldown_s: float = 0.0) -> None:
        """Free the detector anchors owned by an ended incident. After an escalation the anchor stays quiet for `cooldown_s` (no duplicate-incident storm),
        then a fault that persists is allowed to open a fresh incident instead of being ignored forever."""
        ctx = self.ctx
        until = ctx.now + cooldown_s
        for k, v in list(ctx.open_keys.items()):
            if v == inc_id:
                del ctx.open_keys[k]
                if cooldown_s > 0:
                    self._reopen_after[k] = until

    def _liveness(self, world: Json) -> None:
        """Stuck-stage guard (V11 drift detection): an open incident that makes no progress (status / stage / evidence / tasks unchanged) for
        `limits.stuck_stage_s` simulated seconds, or whose graph task is gone, is stopped and ESCALATED with the exact reason, which also frees its
        incident slot so new faults are not starved. A visible drift.detected event records it; nothing is retried silently."""
        ctx, now = self.ctx, sim_time(world)
        if now < self._next_live:
            return
        self._next_live = now + 15.0
        for iid, inc in list(ctx.ledger.incidents.items()):
            if inc.get("closed_tick") is not None or inc.get("status") in CLOSED or inc.get("status") == "escalated":
                self._progress.pop(iid, None)
                continue
            sig = (inc.get("status"), inc.get("stage"), len(inc.get("evidence") or []), len(inc.get("task_ids") or []), inc.get("attempts"),
                   (inc.get("approval") or {}).get("status"), (inc.get("verification") or {}).get("status"),
                   round(float((inc.get("verification") or {}).get("progress") or 0.0), 1))
            prev = self._progress.get(iid)
            if prev is None or prev[0] != sig:
                self._progress[iid] = (sig, now)
                continue
            if (inc.get("approval") or {}).get("status") in ("pending", "held"):
                self._progress[iid] = (sig, now)               # waiting for the operator is bounded by hold_timeout_s, not by this guard
                continue
            task = self._tasks.get(iid)
            idle = now - prev[1]
            dead = task is None or task.done()
            if idle < self.limits.stuck_stage_s and not (dead and idle > 120.0):
                continue
            why = (f"no agent graph is running for it (stage '{inc.get('stage')}')" if dead else
                   f"stage '{inc.get('stage')}' / status '{inc.get('status')}' made no progress for {round(idle)} simulated seconds")
            reason = f"Liveness guard: {why}; escalating to the operator instead of waiting forever."
            log.warning("incident %s stuck: %s", iid, why)
            if task is not None and not task.done():
                task.cancel()
            ctx.locks.release_all(iid)
            ctx.release_suppress(iid)
            ctx.emit("drift.detected", iid, {"incident_id": iid, "kind": "stuck_stage", "stage": inc.get("stage"), "status": inc.get("status"),
                                             "idle_sim_s": round(idle), "graph_running": not dead})
            inc2 = copy.deepcopy(inc)
            inc2.update(status="escalated", summary=reason, updated_tick=int(world.get("sim_tick", 0)))
            ctx.emit("incident.updated", iid, {"incident": inc2})
            self._progress.pop(iid, None)
            self._release_keys(iid, cooldown_s=self.limits.reopen_cooldown_s)
            ctx.decisions.release(iid)
            self._stuck_contract(iid, reason)

    def _stuck_contract(self, iid: str, reason: str, timed_out: bool = True) -> None:
        tr = getattr(getattr(self.engine, "_e", None), "track", None)
        c = (tr.contracts.get(iid) if tr is not None else None)
        if c is None or c.get("terminal_state"):
            return
        from . import dod
        c = copy.deepcopy(c)
        c["terminal_state"] = dod.terminal_of(c, escalated=True, timed_out=timed_out)
        c["state"], c["escalation_reason"] = "ESCALATED", reason[:300]
        c["outcome_text"] = dod.outcome_text(c, c["terminal_state"], reason if timed_out else "")
        self.ctx.emit("dod.contract", iid, {"contract": c})

    def _reap(self) -> None:
        for k in [k for k, t in self._tasks.items() if t.done()]:
            del self._tasks[k]

    def _refresh_severity(self, world: Json) -> None:
        ctx = self.ctx
        now = sim_time(world)
        if now - self._last_sev < 4:
            return
        self._last_sev = now
        fac = ctx.fac
        for iid, inc in list(ctx.ledger.incidents.items()):
            if inc.get("closed_tick") is not None:
                continue
            racks = [a for a in inc.get("affected_asset_ids", []) if a.startswith("rack_")] or list(fac.racks)
            worst = min(ctx.monitor.margin(r, world) for r in racks)
            nxt = "critical" if worst < fac.crit_k else "warning" if worst < fac.warn_k else "watch"
            if nxt != inc.get("severity") and inc.get("cause") != "workload_spike":
                ctx.severity[iid] = nxt
                inc = copy.deepcopy(inc)
                inc["severity"] = nxt
                inc["updated_tick"] = int(world.get("sim_tick", 0))
                ctx.emit("incident.updated", iid, {"incident": inc})

    # ── restart ──
    async def resume(self, open_incidents: list[Json]) -> None:
        ctx = self.ctx
        for inc in open_incidents:
            iid = inc["id"]
            self._inc_seq = max(self._inc_seq, int(iid.split("-")[-1]))
            if inc.get("closed_tick") is not None or inc.get("status") in CLOSED:
                continue
            ctx.ledger.incidents[iid] = copy.deepcopy(inc)
            cfg = self._cfg(iid)
            snap = await self.graph.aget_state(cfg)
            vals = snap.values or {}
            for tid, t in (vals.get("tasks") or {}).items():
                ctx.ledger.tasks[tid] = copy.deepcopy(t)
            det = vals.get("det")
            key = det["key"] if det else key_for_anchor(inc["anchor"]["entity_id"])
            ctx.open_keys[key] = iid
            ctx.decisions.set_used(iid, int(vals.get("tokens_used", 0)))
            if inc.get("status") == "escalated" or vals.get("outcome") == "escalated":
                continue
            if snap.next:
                log.info("resuming incident graph %s from checkpoint (next=%s)", iid, snap.next)
                self._launch(iid, None)
            elif not vals:
                prefix = key.split(":")[0]
                d = {"key": key, "cause": CAUSE_OF_PREFIX.get(prefix, "fouling"), "target_id": inc["anchor"]["entity_id"], "severity": inc.get("severity", "watch"),
                     "title": inc.get("title", ""), "summary": inc.get("summary", ""), "affected": inc.get("affected_asset_ids", []),
                     "anchor_id": inc["anchor"]["entity_id"], "evidence": []}
                log.info("no checkpoint for %s: restarting its graph from the persisted incident", iid)
                init: Json = {"incident": inc, "det": d, "tasks": {}, "task_seq": 0, "ev_seq": 0, "attempt": 0, "tokens_used": 0}
                tr = getattr(getattr(self.engine, "_e", None), "track", None)
                prior = (tr.contracts.get(iid) if tr is not None else None)
                if prior is not None and prior.get("frozen_hash") and not prior.get("terminal_state"):
                    init["dod"] = copy.deepcopy(prior)           # the FROZEN Definition of Done survives a restart; it is never silently dropped
                self._launch(iid, init)

    # ── status / introspection ──
    def model_status(self) -> Json:
        d = self.status.to_dict()
        # contracts.EngineHealth.intelligence.status is live|unavailable|mock: never claim live unless a real call succeeded;
        # the precise 4-state value (live|degraded|unavailable|fallback) is kept in `model_state`
        d["model_state"] = d["status"]
        d["status"] = "mock" if (d["status"] == "live" and d["provider"] == "mock") else ("live" if d["status"] == "live" else "unavailable")
        d["checkpointer"] = self.checkpointer_kind
        d["restart_safe"] = self.checkpointer_kind in ("postgres",)
        if self.checkpointer_kind == "memory":
            d["warning"] = "InMemorySaver: agent graphs do not survive restart (no DATABASE_URL)"
        return d

    def trace(self, incident_id: str) -> Json:
        return self.ctx.ledger.trace(incident_id)

    async def settle(self, idle_iterations: int = 400, max_iterations: int = 200000) -> None:
        """Test hook: yield until agent tasks are blocked on world conditions (no emits/commands for N loops)."""
        ctx, quiet = self.ctx, 0
        last = -1
        for _ in range(max_iterations):
            await asyncio.sleep(0)
            self._reap()
            if not self._tasks:
                return
            if ctx.activity == last:
                quiet += 1
                if quiet >= idle_iterations:
                    return
            else:
                quiet, last = 0, ctx.activity
