"""Read-side projections the API builds from the engine's own event log (pull-based, no background tasks).

These are caches of *read* data (telemetry sparkline history, agent task/tool-call upserts). They never feed
back into the world. If the engine offers ``telemetry()/trace()/agent_tasks()`` those win (see service.py).
"""
from __future__ import annotations

import threading
from collections import deque
from typing import Any, Deque, Optional

from ..interfaces import EngineFacade, Json
from .models import READING_UNITS

HISTORY_POINTS = 1800  # per series (~1 h at 2 s)


class Projection:
    def __init__(self, engine: EngineFacade, page: int = 1000) -> None:
        self._engine = engine
        self._page = page
        self.last_seq = 0
        self.series: dict[tuple[str, str], Deque[tuple[float, float]]] = {}
        self.tasks: dict[str, Json] = {}
        self.task_order: list[str] = []
        self._lock = threading.RLock()        # request handlers run on a thread pool: catch_up() mutates, queries iterate

    # -- ingestion --------------------------------------------------------
    def catch_up(self) -> None:
        with self._lock:
            self._catch_up()

    def _catch_up(self) -> None:
        while True:
            evs = self._engine.events_since(self.last_seq, self._page)
            if not evs:
                return
            for ev in evs:
                self._apply(ev)
                self.last_seq = max(self.last_seq, int(ev.get("seq", 0)))
            if len(evs) < self._page:
                return

    def seed_from_world(self, world: Json) -> None:
        with self._lock:
            self._seed_from_world(world)

    def _seed_from_world(self, world: Json) -> None:
        t = world.get("sim_time_s", 0.0)
        for aid, st in (world.get("assets") or {}).items():
            for m, v in (st.get("readings") or {}).items():
                self._push(aid, m, t, v)

    def _push(self, aid: str, metric: str, t: float, v: Any) -> None:
        if not isinstance(v, (int, float)):
            return
        d = self.series.setdefault((aid, metric), deque(maxlen=HISTORY_POINTS))
        if d and d[-1][0] >= t:
            return
        d.append((float(t), float(v)))

    def _apply(self, ev: Json) -> None:
        typ = ev.get("type")
        p = ev.get("payload") or {}
        if typ == "world.diff":
            t = ev.get("sim_time_s", 0.0)
            for aid, patch in (p.get("assets") or {}).items():
                for m, v in ((patch or {}).get("readings") or {}).items():
                    self._push(aid, m, t, v)
        elif typ == "snapshot":
            self._seed_from_world(p)
        elif typ == "agent.task":
            task = p.get("task") or {}
            tid = task.get("id")
            if tid:
                prev = self.tasks.get(tid)
                merged = dict(task)
                if prev and not merged.get("tool_calls"):
                    merged["tool_calls"] = prev.get("tool_calls", [])
                if tid not in self.tasks:
                    self.task_order.append(tid)
                self.tasks[tid] = merged
        elif typ == "agent.tool":
            tid = p.get("task_id")
            tc = p.get("tool_call") or {}
            task = self.tasks.get(tid)
            if task is not None and tc.get("id"):
                calls = [c for c in task.get("tool_calls", []) if c.get("id") != tc["id"]]
                calls.append(tc)
                task["tool_calls"] = calls

    # -- queries ----------------------------------------------------------
    def telemetry(self, asset_id: str, metric: str, window_s: float) -> Optional[Json]:
        with self._lock:
            d = self.series.get((asset_id, metric))
            if not d:
                return None
            tmax = d[-1][0]
            pts = [[round(t, 1), round(v, 3)] for t, v in list(d) if t >= tmax - window_s]
        return {"asset_id": asset_id, "metric": metric, "unit": READING_UNITS.get(metric, ""), "points": pts}

    def trace(self, incident_id: str) -> list[Json]:
        with self._lock:
            out = [self.tasks[i] for i in self.task_order if self.tasks[i].get("incident_id") == incident_id]
        out.sort(key=lambda t: (t.get("started_tick", 0), t.get("id", "")))
        return out

    def all_tasks(self) -> list[Json]:
        with self._lock:
            return [self.tasks[i] for i in self.task_order]


def agent_graph(run_id: str, tasks: list[Json]) -> Json:
    """Task/agent DAG (backend.md §9): three agent roots + 5 virtual supervisors + bounded sub-task lineage + causal edges."""
    ids = {t["id"] for t in tasks}
    roles = ["sentinel", "inpipe", "outrig"]
    nodes: list[Json] = [
        {"id": f"agent:{r}", "kind": "agent", "role": r, "title": r.upper()} for r in roles
    ]
    edges: list[Json] = []

    # 5 virtual SENTINEL supervisor instances (no physical mesh)
    supervisors = [
        {"id": "SEN-01", "title": "SEN-01 · Facility Watch", "specialty": "Continuous cooling health & anomaly clusters"},
        {"id": "SEN-02", "title": "SEN-02 · Internal Fleet Coordinator", "specialty": "Crawler allocation & pipe inspections"},
        {"id": "SEN-03", "title": "SEN-03 · External Repair Coordinator", "specialty": "OUTRIG fleet & physical repairs"},
        {"id": "SEN-04", "title": "SEN-04 · Safety & Authorization Guardian", "specialty": "Policy enforcement & interlock validation"},
        {"id": "SEN-05", "title": "SEN-05 · Verification & Recovery Auditor", "specialty": "Independent thermal/hydraulic audit"},
    ]
    for s in supervisors:
        nodes.append({
            "id": s["id"],
            "kind": "supervisor",
            "role": "sentinel",
            "title": s["title"],
            "specialty": s["specialty"],
            "status": "working",
        })
        edges.append({"from": "agent:sentinel", "to": s["id"], "type": "supervisor"})

    for t in tasks:
        nodes.append({
            "id": t["id"], "kind": "task", "role": t.get("role"), "task_kind": t.get("kind"),
            "title": t.get("title"), "status": t.get("status"), "depth": t.get("depth", 0),
            "incident_id": t.get("incident_id"), "robot_id": t.get("robot_id"),
            "fallback": (t.get("model") or {}).get("fallback"),
        })
        parent = t.get("parent_id")
        if parent and parent in ids:
            edges.append({"from": parent, "to": t["id"], "type": "parent"})
        elif t.get("role") in roles:
            edges.append({"from": f"agent:{t['role']}", "to": t["id"], "type": "owner"})
        for c in t.get("caused_by", []) or []:
            if c in ids and c != parent:
                edges.append({"from": c, "to": t["id"], "type": "caused_by"})
    return {"run_id": run_id, "nodes": nodes, "edges": edges, "task_count": len(tasks)}

