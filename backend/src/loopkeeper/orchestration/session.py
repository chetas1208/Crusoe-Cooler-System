"""IncidentSession: node-local view of an incident that emits contract-shaped events.

Every graph node builds a Session from the checkpointed state, mutates local copies,
emits `incident.updated` / `agent.task` / `agent.tool`, and returns `patch()` as the
state update. IDs are deterministic functions of checkpointed counters, so a node that
is re-run after a restart re-creates the SAME ids and events upsert instead of duplicating.
"""
from __future__ import annotations

import copy
import inspect
import time
from typing import Any, Awaitable, Callable

from loopkeeper.intelligence.decisions import DecisionRequest, DecisionResult, det_meta

from .context import AgentContext, redact
from .world import Json


class PolicyReject(Exception):
    pass


def inc_num(inc_id: str) -> str:
    return inc_id.split("-")[-1]


def agent_id_for(role: str, kind: str) -> str:
    """The five SENTINEL seats (V11 team): SEN-01 goal architect / planner, SEN-02 INPIPE coordinator, SEN-03 OUTRIG coordinator,
    SEN-04 safety arbiter, SEN-05 independent verifier. Robots (INPIPE / OUTRIG) are the children these coordinators delegate to."""
    if role == "inpipe":
        return "SEN-02"
    if role == "outrig":
        return "SEN-03"
    if kind == "safety":
        return "SEN-04"
    if kind in ("verify", "dod_review"):
        return "SEN-05"
    return "SEN-01"


class IncidentSession:
    def __init__(self, ctx: AgentContext, state: Json, *, ev_prefix: str = "") -> None:
        self.ctx = ctx
        self.inc: Json = copy.deepcopy(state["incident"])
        self.state = state
        self.det: Json = state.get("det") or {}
        self.known: dict[str, Json] = state.get("tasks") or {}
        self.changed: dict[str, Json] = {}
        self.task_seq = int(state.get("task_seq", 0))
        self.ev_seq = int(state.get("ev_seq", 0))
        self.ev_prefix = ev_prefix
        sev = ctx.severity.get(self.inc["id"])
        if sev:
            self.inc["severity"] = sev
        self.new_evidence: list[Json] = []
        self.child_ids: list[str] = []
        self.incident_dirty = False
        self._llm_n: dict[str, int] = {}

    @property
    def id(self) -> str:
        return self.inc["id"]

    # ── ids ──
    def _tid(self) -> str:
        self.task_seq += 1
        return f"t_{inc_num(self.id)}_{self.task_seq:02d}"

    def task_ref(self, tid: str) -> Json | None:
        return self.changed.get(tid) or self.known.get(tid)

    # ── incident mutation ──
    def touch(self) -> None:
        sev = self.ctx.severity.get(self.id)
        if sev:
            self.inc["severity"] = sev
        self.inc["updated_tick"] = self.ctx.tick
        self.ctx.emit("incident.updated", self.id, {"incident": self.inc})
        self.incident_dirty = True

    def set_status(self, status: str, summary: str | None = None) -> None:
        self.inc["status"] = status
        if summary:
            self.inc["summary"] = summary
        self.touch()

    def stage(self, stage: str, outcome: str | None = None) -> None:
        self.inc["stage"] = stage
        ent: Json = {"stage": stage, "tick": self.ctx.tick}
        if outcome:
            ent["outcome"] = outcome
        self.inc["stage_log"].append(ent)
        self.touch()

    def ev(self, kind: str, summary: str, *, local: bool = False, **extra: Any) -> str:
        self.ev_seq += 1
        eid = f"ev_{inc_num(self.id)}_{self.ev_prefix}{self.ev_seq}"
        e: Json = {"id": eid, "kind": kind, "summary": summary, "tick": self.ctx.tick}
        e.update({k: v for k, v in extra.items() if v is not None})
        if local:  # parallel branches: merged into the incident at fan-in
            self.new_evidence.append(e)
        else:
            self.inc["evidence"].append(e)
            self.incident_dirty = True
        return eid

    # ── tasks ──
    def task(self, role: str, kind: str, title: str, question: str, *, parent: Json | None = None,
             caused_by: list[Json] | None = None, robot_id: str | None = None, asset_ids: list[str] | None = None,
             task_id: str | None = None) -> Json:
        depth = (parent["depth"] + 1) if parent else 0
        if depth > self.ctx.limits.max_depth:
            raise PolicyReject(f"agent depth {depth} exceeds cap {self.ctx.limits.max_depth}")
        if task_id and parent is not None and self._cycle(task_id, parent):
            raise PolicyReject(f"task {task_id} under {parent['id']} would close a cycle in the task DAG")
        tid = task_id or self._tid()
        t: Json = {
            "id": tid, "incident_id": self.id, "role": role, "kind": kind, "title": title, "question": question,
            "status": "working", "depth": depth, "started_tick": self.ctx.tick, "evidence_ids": [], "tool_calls": [],
            "agent_id": agent_id_for(role, kind), "model": det_meta(False, "classify"), "caused_by": [c["id"] for c in (caused_by or ([parent] if parent else []))],
            "asset_ids": list(asset_ids or []),
        }
        t["model"]["schema_version"] = "agent.v1"
        if parent:
            t["parent_id"] = parent["id"]
        if robot_id:
            t["robot_id"] = robot_id
        self.changed[tid] = t
        if tid not in self.inc["task_ids"]:
            self.inc["task_ids"].append(tid)
            self.incident_dirty = True
        self.ctx.emit("agent.task", tid, {"task": t})
        return t

    def _cycle(self, tid: str, parent: Json) -> bool:
        """DAG guard: a task may not become its own ancestor (parent chain walked through everything this graph knows)."""
        seen, cur = set(), parent
        while cur is not None and cur["id"] not in seen:
            if cur["id"] == tid:
                return True
            seen.add(cur["id"])
            cur = self.task_ref(cur["parent_id"]) if cur.get("parent_id") else None
        return False

    def finish(self, t: Json, status: str, summary: str, outcome: tuple[str, bool] | None = None,
               evidence: list[str] | None = None) -> None:
        t["status"], t["summary"] = status, summary
        if outcome:
            t["outcome"] = {"label": outcome[0], "ok": outcome[1]}
        t["ended_tick"] = self.ctx.tick
        t["evidence_ids"].extend(evidence or [])
        self.changed[t["id"]] = t
        self.ctx.emit("agent.task", t["id"], {"task": t})

    def update_task(self, t: Json) -> None:
        self.changed[t["id"]] = t
        self.ctx.emit("agent.task", t["id"], {"task": t})

    # ── tools ──
    async def tool(self, t: Json, name: str, inp: Json, fn: Callable[[], Any], *, status_on_reject: str = "rejected") -> Json:
        call: Json = {"id": f"tc_{t['id']}_{len(t['tool_calls']) + 1}", "task_id": t["id"], "name": name,
                      "input": redact(inp), "status": "running", "tick": self.ctx.tick}
        t["tool_calls"].append(call)
        self.ctx.emit("agent.tool", t["id"], {"task_id": t["id"], "tool_call": call})
        t0 = time.perf_counter()
        out: Json
        try:
            if self.ctx.limits.tool_dwell_s > 0:
                await self.ctx.sleep_sim(self.ctx.limits.tool_dwell_s)
            r = fn()
            out = await r if inspect.isawaitable(r) else r
            call["status"] = "ok"
        except PolicyReject as e:
            out, call["status"] = {"reason": str(e)}, status_on_reject
        except Exception as e:  # tool failure must not kill the incident graph
            out, call["status"] = {"error": type(e).__name__, "detail": str(e)[:160]}, "error"
        call["output"] = redact(out)
        call["latency_ms"] = int((time.perf_counter() - t0) * 1000)
        self.ctx.emit("agent.tool", t["id"], {"task_id": t["id"], "tool_call": call})
        return out

    # ── model decisions (LLM proposes; validators gate; deterministic fallback labelled) ──
    async def decide(self, t: Json, kind: str, payload: Json, fallback: Callable[[], Json],
                     validate: Callable[[Any], list[str]] | None = None, *, suffix: str = "", cacheable: bool = False,
                     instruction: str = "", max_tokens: int = 700, closed: Json | None = None) -> Json:
        req = DecisionRequest(closed=closed or {}, 
            kind=kind, key=f"{self.id}:{t['id']}:{kind}{suffix}", payload=payload, fallback=fallback, validate=validate,
            incident_id=self.id, task_id=t["id"], world_version=self.ctx.version, tick=self.ctx.tick,
            cacheable=cacheable, instruction=instruction, max_tokens=max_tokens, evidence_ids=list(t["evidence_ids"]))
        res: DecisionResult = await self.ctx.decisions.decide(req)
        self.ctx.decisions.set_used(self.id, int(self.state.get("tokens_used", 0)))
        self._record_model(t, kind, res)
        return res.decision

    def _record_model(self, t: Json, kind: str, res: DecisionResult) -> None:
        if res.source == "fallback" and not res.consulted:
            # the model was never asked (no key / breaker open / budget): the task's model.fallback=true says so; no fake tool call
            t["model"] = {k: v for k, v in res.meta.items() if v is not None}
            return
        call: Json = {"id": f"tc_{t['id']}_{len(t['tool_calls']) + 1}", "task_id": t["id"],
                      "name": f"model.propose.{kind}", "input": {"schema_version": res.meta.get("schema_version")},
                      "tick": self.ctx.tick, "latency_ms": res.meta.get("latency_ms")}
        if res.source in ("model", "frozen", "cache") and not res.meta.get("fallback"):
            call["status"], call["output"] = "ok", {"accepted": True, "source": res.source}
        elif res.rejected:
            call["status"] = "rejected"
            call["output"] = {"accepted": False, "reasons": [r[:160] for r in res.rejected[:3]], "used": "deterministic fallback"}
        else:
            call["status"] = "error"
            call["output"] = {"accepted": False, "reason": res.reason[:160], "used": "deterministic fallback"}
        t["tool_calls"].append(call)
        self.ctx.emit("agent.tool", t["id"], {"task_id": t["id"], "tool_call": call})
        m = t["model"]
        new = res.meta
        if self._llm_n.get(t["id"]):
            for k in ("tokens_in", "tokens_out", "latency_ms"):
                new[k] = (m.get(k) or 0) + (new.get(k) or 0)
            new["fallback"] = bool(m.get("fallback")) or bool(new.get("fallback"))
        self._llm_n[t["id"]] = self._llm_n.get(t["id"], 0) + 1
        t["model"] = {k: v for k, v in new.items() if v is not None}

    # ── state patch ──
    def patch(self, **extra: Any) -> Json:
        p: Json = {"tasks": copy.deepcopy(self.changed), "task_seq": self.task_seq, "ev_seq": self.ev_seq,
                   "tokens_used": self.ctx.decisions.budget(self.id).used}
        if self.incident_dirty or "incident" in extra:
            p["incident"] = copy.deepcopy(self.inc)
        if self.new_evidence:
            p["new_evidence"] = copy.deepcopy(self.new_evidence)
        if self.child_ids:
            p["child_tasks"] = list(self.child_ids)
        p.update(extra)
        return p
