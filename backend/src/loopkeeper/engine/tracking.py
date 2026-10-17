"""Engine-side mirror of agent-owned state (incidents, agent tasks, verification) built from the events agents
`emit()`, so world()/snapshots/replay are complete and restart can hand open incidents back to the agents.

The engine OWNS approval *decisions* (operator approve/hold, auto-approve at auto_approve_at_s); agents own
everything else in the incident object. Decided approvals are sticky against stale agent updates."""
from __future__ import annotations

from .util import Json, clone

TRACKED = ("incident.opened", "incident.updated", "incident.closed", "agent.task", "agent.tool", "verification.result", "dod.contract")
EVENT_ONLY = ("drift.detected", "loop.detected")      # agent-emitted evidence events with no engine-side mirror
RECENT_CLOSED = 50


class Tracking:
    def __init__(self) -> None:
        self.incidents: dict[str, Json] = {}
        self.tasks: dict[str, Json] = {}
        self.verifications: dict[str, Json] = {}
        self.decided: dict[str, str] = {}   # approval_id -> approved|held|expired
        self.contracts: dict[str, Json] = {}    # incident_id -> latest DoneContract document (V11)
        self.dirty_contracts: set = set()
        self.dirty_incidents: set = set()
        self.dirty_tasks: set = set()
        self.dirty_verifications: set = set()

    # ---- ingestion ------------------------------------------------------
    def ingest(self, kind: str, payload: Json) -> None:
        if kind in ("incident.opened", "incident.updated", "incident.closed"):
            inc = clone(payload["incident"])
            ap = inc.get("approval")
            if ap and ap.get("id") in self.decided and ap.get("status") == "pending":
                ap["status"] = self.decided[ap["id"]]
                if ap["status"] == "held":
                    ap["auto_approve_at_s"] = None
            self.incidents[inc["id"]] = inc
            self.dirty_incidents.add(inc["id"])
        elif kind == "agent.task":
            t = clone(payload["task"])
            self.tasks[t["id"]] = t
            self.dirty_tasks.add(t["id"])
        elif kind == "agent.tool":
            t = self.tasks.get(payload["task_id"])
            if t is not None:
                tc = clone(payload["tool_call"])
                calls = t.setdefault("tool_calls", [])
                for i, c in enumerate(calls):
                    if c["id"] == tc["id"]:
                        calls[i] = tc
                        break
                else:
                    calls.append(tc)
                self.dirty_tasks.add(t["id"])
        elif kind == "dod.contract":
            c = clone(payload["contract"])
            self.contracts[c["incident_id"]] = c
            self.dirty_contracts.add(c["incident_id"])
        elif kind == "verification.result":
            v = clone(payload["verification"])
            self.verifications[v["id"]] = v
            self.dirty_verifications.add(v["id"])

    # ---- approvals -----------------------------------------------------
    def find_approval(self, approval_id: str) -> tuple[Json, Json] | None:
        for inc in self.incidents.values():
            ap = inc.get("approval")
            if ap and ap.get("id") == approval_id:
                return inc, ap
        return None

    def decide(self, approval_id: str, approve: bool) -> tuple[Json | None, str | None]:
        """-> (updated incident, error)."""
        found = self.find_approval(approval_id)
        if not found:
            return None, "no pending approval with that id"
        inc, ap = found
        if ap["status"] not in ("pending", "held"):
            return None, f"approval already {ap['status']}"
        ap["status"] = "approved" if approve else "held"
        if not approve:
            ap["auto_approve_at_s"] = None
        self.decided[approval_id] = ap["status"]
        self.dirty_incidents.add(inc["id"])
        return inc, None

    def due_auto_approvals(self, sim_time_s: float) -> list[str]:
        out = []
        for inc in self.incidents.values():
            ap = inc.get("approval")
            if (ap and ap["status"] == "pending" and ap.get("auto_approve_at_s") is not None
                    and sim_time_s >= ap["auto_approve_at_s"] and inc.get("closed_tick") is None):
                out.append(ap["id"])
        return sorted(out)

    # ---- views ---------------------------------------------------------
    def open_incidents(self) -> list[Json]:
        return [clone(i) for i in self.incidents.values() if i.get("closed_tick") is None]

    def world_incidents(self) -> list[Json]:
        allv = sorted(self.incidents.values(), key=lambda i: (-i["opened_tick"], i["id"]))
        out, closed = [], 0
        for i in allv:
            if i.get("closed_tick") is not None:
                closed += 1
                if closed > RECENT_CLOSED:
                    continue
            out.append(clone(i))
        return out

    def counts(self) -> tuple[int, int]:
        o = sum(1 for i in self.incidents.values() if i.get("closed_tick") is None)
        r = sum(1 for i in self.incidents.values() if i["status"] in ("resolved", "dismissed"))
        return o, r

    def busy(self) -> bool:
        return any(i.get("closed_tick") is None and i["status"] in ("mitigating", "verifying")
                   for i in self.incidents.values())

    def trace(self, incident_id: str) -> list[Json]:
        return [clone(t) for t in self.tasks.values() if t.get("incident_id") == incident_id]

    # ---- state ---------------------------------------------------------
    def to_state(self) -> Json:
        return {"incidents": self.incidents, "tasks": self.tasks, "verifications": self.verifications,
                "decided": self.decided, "contracts": self.contracts}

    def load_state(self, st: Json) -> None:
        self.incidents = clone(st["incidents"])
        self.tasks = clone(st["tasks"])
        self.verifications = clone(st["verifications"])
        self.decided = dict(st["decided"])
        self.contracts = clone(st.get("contracts") or {})
