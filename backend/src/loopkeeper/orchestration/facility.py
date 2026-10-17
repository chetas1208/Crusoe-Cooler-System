"""Topology-derived facility model (read only). Built from engine.topology() - never from plant internals."""
from __future__ import annotations

import heapq
from typing import Any

Json = dict[str, Any]


class Facility:
    def __init__(self, topo: Json) -> None:
        self.topo = topo
        self.edges: dict[str, Json] = {e["id"]: e for e in topo.get("edges", [])}
        self.assets: dict[str, Json] = {a["id"]: a for a in topo.get("assets", [])}
        self.zones: dict[str, Json] = {z["id"]: z for z in topo.get("zones", [])}
        self.limits: Json = topo.get("limits", {})
        self.warn_k = float(self.limits.get("margin_warn_k", 8.0))
        self.crit_k = float(self.limits.get("margin_crit_k", 4.0))
        self.nominal_rack_kw = float(self.limits.get("nominal_rack_kw", 120.0))
        self.all_racks = sorted(a["id"] for a in topo.get("assets", []) if a.get("type") == "rack")
        # instrumented racks = fault targets that the agents diagnose; auxiliary (telemetry-only) racks share the headers
        self.racks = [r for r in self.all_racks if not str(self.assets[r].get("spec", {}).get("Diagnosis", "")).startswith("Telemetry")]
        self.zone_of: dict[str, str] = {}
        for zid, z in self.zones.items():
            for r in z.get("rack_ids", []):
                self.zone_of[r] = zid
        self.pumps = sorted(a["id"] for a in topo.get("assets", []) if a.get("type") == "pump")
        self.tcs_pumps = [p for p in self.pumps if (self.assets[p].get("loop") == "tcs") or p.startswith("pump_t")]
        self.strainers = sorted(a["id"] for a in topo.get("assets", []) if a.get("type") == "strainer")
        self.flow_sensors = [a["id"] for a in topo.get("assets", []) if a.get("type") == "sensor" and a.get("edge_id")]
        self._adj: dict[str, list[tuple[str, str, float]]] = {}
        for e in self.edges.values():
            if not e.get("robot_passable"):
                continue
            L = float(e.get("length_m", 1.0))
            self._adj.setdefault(e["from"], []).append((e["to"], e["id"], L))
            self._adj.setdefault(e["to"], []).append((e["from"], e["id"], L))

    # ── structure helpers ──
    def label(self, ident: str) -> str:
        a = self.assets.get(ident) or self.edges.get(ident)
        return (a or {}).get("label") or ident.upper().replace("_", "-")

    def edge_of(self, ident: str) -> str | None:
        """The pipe edge an entity sits on: the id itself if it is an edge, else the edge of an edge-mounted asset (valve, strainer, meter, port)."""
        if ident in self.edges:
            return ident
        e = (self.assets.get(ident) or {}).get("edge_id")
        return e if e in self.edges else None

    def exists(self, ident: str) -> bool:
        return ident in self.assets or ident in self.edges

    def canon(self, ident: str) -> str:
        """Canonical spelling of an id the model wrote in another case ('rack_A2' -> 'rack_a2'); unknown ids are returned unchanged (and rejected by exists())."""
        if ident in self.assets or ident in self.edges:
            return ident
        if not hasattr(self, "_lower"):
            self._lower = {k.lower(): k for k in (*self.assets, *self.edges)}
        return self._lower.get(str(ident).lower().strip(), ident)

    def zone_racks(self, zone_id: str) -> list[str]:
        """Instrumented racks of a zone (what the agents diagnose / cordon)."""
        inst = set(self.racks)
        return [r for r in self.zones.get(zone_id, {}).get("rack_ids", []) if r in inst]

    def zone_all_racks(self, zone_id: str) -> list[str]:
        """Every rack on the zone header, instrumented or not (mass balances must include all of them)."""
        return list(self.zones.get(zone_id, {}).get("rack_ids", []))

    def zone_short(self, zone_id: str) -> str:
        return zone_id.replace("zone_", "")

    def rack_zone(self, rack: str) -> str | None:
        return self.zone_of.get(rack)

    def zone_valve(self, zone_id: str) -> str | None:
        v = f"valve_z{self.zone_short(zone_id)}"
        return v if v in self.assets else None

    def zone_header(self, zone_id: str) -> str | None:
        """Supply header of a zone (the TCS supply edge tagged with that zone)."""
        sup = [e for e in self.edges.values() if e.get("zone_id") == zone_id and e.get("loop") == "tcs" and e.get("role") == "supply"
               and e.get("robot_passable")]
        return sup[0]["id"] if sup else None

    def zone_edges(self, zone_id: str) -> set[str]:
        """Supply and return header edges of a zone (robot-passable runs only, not the rack drops)."""
        return {e["id"] for e in self.edges.values() if e.get("zone_id") == zone_id and e.get("loop") == "tcs" and e.get("robot_passable")}

    def served_racks(self, edge_id: str) -> list[str]:
        """Every rack whose coolant flows through this TCS edge (row header -> that row; trunk segment -> the rows beyond it)."""
        e = self.edges.get(edge_id) or {}
        out: list[str] = []
        for z in e.get("served_zones") or []:
            out += self.zone_all_racks(f"zone_{z}")
        return out

    def edge_zone(self, edge_id: str) -> str | None:
        return (self.edges.get(edge_id) or {}).get("zone_id")

    def scope_racks(self, cause: str, target_id: str) -> list[str]:
        if cause == "valve_stuck":
            return [target_id.replace("valve_", "rack_")]
        e = self.edges.get(target_id)
        if e and e.get("zone_id"):
            return self.zone_racks(e["zone_id"])
        if cause == "workload_spike":
            return [target_id]
        return list(self.racks)

    def pos_of(self, ident: str) -> list[float]:
        a = self.assets.get(ident)
        if a:
            p = list(a["position_xyz_m"])
            if a.get("type") in ("rack", "cdu"):
                p[1] += (a.get("size_m") or [0, 0, 0])[1] / 2
            return p
        e = self.edges.get(ident)
        if e and e.get("centerline_xyz_m"):
            pts = e["centerline_xyz_m"]
            return list(pts[len(pts) // 2])
        return [0.0, 1.0, 0.0]

    # ── robot reachability (topology only; engine re-validates) ──
    def port_pose(self, port_id: str) -> tuple[str, float] | None:
        a = self.assets.get(port_id)
        if a and a.get("edge_id"):
            return a["edge_id"], float(a.get("s_m") or 0.0)
        return None

    def route(self, frm: tuple[str, float], to: tuple[str, float]) -> tuple[float, list[str]] | None:
        """Shortest crawler path over robot_passable edges. Returns (length_m, edge ids)."""
        e0, s0 = frm
        e1, s1 = to
        E0, E1 = self.edges.get(e0), self.edges.get(e1)
        if not E0 or not E1 or not E0.get("robot_passable") or not E1.get("robot_passable"):
            return None
        best: tuple[float, list[str]] | None = None
        if e0 == e1:
            best = (abs(s1 - s0), [e0])
        starts = [(E0["from"], s0, e0), (E0["to"], float(E0["length_m"]) - s0, e0)]
        goals = {E1["from"]: s1, E1["to"]: float(E1["length_m"]) - s1}
        dist: dict[str, tuple[float, list[str]]] = {}
        pq: list[tuple[float, str, list[str]]] = []
        for n, d, e in starts:
            heapq.heappush(pq, (d, n, [e]))
        seen: set[str] = set()
        while pq:
            d, n, path = heapq.heappop(pq)
            if n in seen:
                continue
            seen.add(n)
            dist[n] = (d, path)
            for m, eid, L in self._adj.get(n, []):
                if m not in seen:
                    heapq.heappush(pq, (d + L, m, path + ([eid] if path[-1] != eid else [])))
        for n, tail in goals.items():
            if n in dist:
                d, path = dist[n]
                tot = d + tail
                p = path + ([e1] if path[-1] != e1 else [])
                if best is None or tot < best[0]:
                    best = (tot, p)
        return best
