"""Time-aware reservation table (prioritised planning with safe intervals).

A resource is an exclusive slot in time: a graph node (junction / dock / service / door), one direction of an edge (lane) or a
pipe segment. A reservation is `(resource, [t0, t1], owner, plan_id)`. The table is plain in-memory state of the single active
world worker (fencing is the engine's leader epoch); every mutation bumps `revision`, which is what route commits are
optimistic on (never the world tick). Reservations are bounded: each plan has `valid_until`, `expire(now)` drops stale plans, and
resources are released as the robot actually passes them."""
from __future__ import annotations

from typing import Any

Json = dict[str, Any]
INF = 1e12


class ReservationTable:
    def __init__(self) -> None:
        self.by_resource: dict[str, list[Json]] = {}
        self.by_plan: dict[str, list[Json]] = {}
        self.plan_meta: dict[str, Json] = {}
        self.revision = 0
        self.journal: list[Json] = []                 # state changes of route reservations (parking is hot-state only), drained by the engine

    def _log(self, state: str, rows: list[Json]) -> None:
        for r in rows:
            if r.get("kind") != "park":
                if len(self.journal) > 5000:
                    del self.journal[:1000]                  # nobody is draining (no storage / replay): stay bounded
                self.journal.append({"plan_id": r["plan_id"], "resource": r["resource"], "owner": r["owner"], "t0": r["t0"], "t1": r["t1"], "state": state})

    # ------------------------------------------------------------------ queries
    def conflict(self, resource: str, t0: float, t1: float, owner: str) -> Json | None:
        for r in self.by_resource.get(resource, ()):
            if r["owner"] != owner and r["t0"] < t1 and t0 < r["t1"]:
                return r
        return None

    def first_conflict(self, items: list[tuple[str, float, float]], owner: str) -> tuple[int, Json] | None:
        for i, (res, a, b) in enumerate(items):
            c = self.conflict(res, a, b, owner)
            if c is not None:
                return i, c
        return None

    def occupancy(self, resource: str, now: float) -> list[Json]:
        return [r for r in self.by_resource.get(resource, ()) if r["t1"] > now]

    # ------------------------------------------------------------------ mutation
    def reserve(self, plan_id: str, owner: str, items: list[tuple[str, float, float]], valid_until: float, kind: str = "route") -> list[Json]:
        rows = []
        for res, a, b in items:
            row = {"resource": res, "owner": owner, "plan_id": plan_id, "t0": round(a, 3), "t1": round(b, 3), "kind": kind}
            self.by_resource.setdefault(res, []).append(row)
            rows.append(row)
        self.by_plan.setdefault(plan_id, []).extend(rows)
        self.plan_meta[plan_id] = {"owner": owner, "valid_until": valid_until, "kind": kind}
        self.revision += 1
        self._log("active", rows)
        return rows

    def release_resource(self, plan_id: str, resource: str) -> bool:
        rows = [r for r in self.by_plan.get(plan_id, ()) if r["resource"] == resource]
        for r in rows:
            self.by_plan[plan_id].remove(r)
            self.by_resource[resource].remove(r)
            if not self.by_resource[resource]:
                del self.by_resource[resource]
        if rows:
            self.revision += 1
        return bool(rows)

    def extend(self, plan_id: str, resource: str, t1: float) -> None:
        for r in self.by_plan.get(plan_id, ()):
            if r["resource"] == resource and t1 > r["t1"]:
                r["t1"] = round(t1, 3)

    def release_plan(self, plan_id: str, state: str = "released") -> list[Json]:
        rows = self.by_plan.pop(plan_id, [])
        self._log(state, rows)
        for r in rows:
            lst = self.by_resource.get(r["resource"], [])
            if r in lst:
                lst.remove(r)
            if not lst:
                self.by_resource.pop(r["resource"], None)
        self.plan_meta.pop(plan_id, None)
        if rows:
            self.revision += 1
        return rows

    def release_owner(self, owner: str, kinds: tuple[str, ...] | None = None) -> list[str]:
        gone = [p for p, m in self.plan_meta.items() if m["owner"] == owner and (kinds is None or m["kind"] in kinds)]
        for p in gone:
            self.release_plan(p)
        return gone

    def expire(self, now: float) -> list[str]:
        """Bounded expiry: plans whose `valid_until` has passed are dropped (the robot replans or the owner is told)."""
        gone = [p for p, m in self.plan_meta.items() if m["valid_until"] < now]
        for p in gone:
            self.release_plan(p, state="expired")
        return gone

    # ------------------------------------------------------------------ persistence
    def to_state(self) -> Json:
        return {"revision": self.revision, "plans": {p: {"meta": self.plan_meta[p], "rows": self.by_plan.get(p, [])} for p in sorted(self.plan_meta)}}

    def load_state(self, st: Json) -> None:
        self.by_resource, self.by_plan, self.plan_meta = {}, {}, {}
        for p, d in (st.get("plans") or {}).items():
            self.plan_meta[p] = dict(d["meta"])
            rows = [dict(r) for r in d["rows"]]
            self.by_plan[p] = rows
            for r in rows:
                self.by_resource.setdefault(r["resource"], []).append(r)
        self.revision = int(st.get("revision", 0))

    def summary(self) -> Json:
        return {"revision": self.revision, "plans": len(self.plan_meta), "resources": len(self.by_resource),
                "rows": sum(len(v) for v in self.by_plan.values())}
