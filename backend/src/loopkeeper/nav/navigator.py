"""Navigator: plan / commit / cancel routes for OUTRIG (G_ext) and INPIPE (G_in) robots, reachability, deadlock handling and the
manual-control route tube. Deterministic and LLM-free; uses simulated time only; hot state lives in this process (one active
scheduler per run: the engine's leader epoch fences it); Neon is written only when plans/reservations change (via the engine's
CommitBatch)."""
from __future__ import annotations

import math
from typing import Any

from .manual import DEST_SPEED, TubeDriver
from .graphs import OUTRIG_SPEED_PLAN, ExtGraph, IntGraph, NavValidationError, build_graphs
from .reasons import Refusal
from .table import INF, ReservationTable

Json = dict[str, Any]
NODE_MARGIN_S = 2.5
EDGE_MARGIN_S = 1.0
DWELL_S = 4.0
PARK_HOLD_S = 600.0
MAX_WAIT_S = 120.0
PLAN_SLACK_S = 90.0
MAX_ALT_PATHS = 3
CRAWLER_SPEED = 0.18
CRAWLER_MAX_PRESSURE_KPA = 900.0
DRAIN_MOVE_PCT_S = 0.03
MANUAL_PRIORITY_S = 30.0
DEADLOCK_CHECK_S = 1.0
STALL_EXPIRE_S = 45.0
AGING_S = 60.0                  # +1 priority per minute without being served ...
AGING_MAX = 2.5                 # ... capped so an old routine job never outranks a critical incident
RETREAT_COOLDOWN_S = 20.0


class Navigator:
    def __init__(self, eng: Any) -> None:
        self.eng = eng
        self.ext: ExtGraph
        self.inp: IntGraph
        self.table = ReservationTable()
        self.plans: dict[str, Json] = {}                  # plan_id -> plan (previews are not stored; committed/active are)
        self.active: dict[str, str] = {}                  # robot_id -> committed plan_id
        self.pending: dict[str, Json] = {}                # robot_id -> {"plan_id","depart_t"} waiting for its departure time
        self.wait_t: dict[str, float] = {}                # when a (non-injected) wait was last refreshed
        self.waits: dict[str, str] = {}                   # robot_id -> robot it currently waits for (reservation / physical)
        self.served: dict[str, float] = {}                # robot_id -> sim time of its last completed mission (aging)
        self.served_count: dict[str, int] = {}            # completed missions per robot (fair assignment: no repeat winners while peers starve)
        self.retreat_t: dict[str, float] = {}
        self.seq = 0
        self.stats = {"planned": 0, "committed": 0, "refused": 0, "replanned": 0, "deadlocks": 0, "deadlocks_resolved": 0,
                      "deadlocks_held": 0, "yields": 0, "expired": 0}
        self.history: list[Json] = []                     # compact route log (also what Neon stores): bounded
        self.dirty_plans: set[str] = set()
        self._next_check = 0.0
        self.manual: dict[str, Json] = {}                 # robot_id -> manual tube state
        self.arrivals: dict[str, Json] = {}
        self.tube = TubeDriver(self)
        self.dest: dict[str, Json] = {}                   # robot_id -> destination-mode follower under a manual lease
        self.previews: dict[str, Json] = {}               # bounded cache of previewed (read-only) plans, committed by id
        self.build()

    # ------------------------------------------------------------------ graphs
    def build(self) -> None:
        self.ext, self.inp = build_graphs(self.eng.topo, self.eng.nav, self.eng.graph, self.eng.robots)

    @property
    def graph_revision(self) -> str:
        return f"{self.ext.revision}.{self.inp.revision}"

    @property
    def traffic_revision(self) -> int:
        return self.table.revision

    def graphs(self, kind: str) -> Json:
        g = self.ext if kind == "exterior" else self.inp
        out = g.to_json()
        out.update(run_id=self.eng.run_id, graph_revision=self.graph_revision, traffic_revision=self.traffic_revision)
        return out

    # ------------------------------------------------------------------ closures (operator / fault injection)
    def set_closed(self, edge_ids: list[str], closed: bool) -> Json:
        """Close or reopen graph edges (an aisle blocked by equipment, a pipe taken out of service). Changes the graph revision;
        committed routes crossing a closed edge are cancelled and replanned."""
        changed: list[str] = []
        for eid in edge_ids:
            g = self.ext if eid in self.ext.edges else (self.inp if eid in self.inp.edges else None)
            if g is None:
                return {"ok": False, "reason": "UNKNOWN_TARGET", "detail": f"unknown graph edge {eid}"}
            if closed and eid not in g.closed:
                g.closed.add(eid)
                changed.append(eid)
            elif not closed and eid in g.closed:
                g.closed.discard(eid)
                changed.append(eid)
        if changed:
            self.eng.emit_internal("nav.graph_changed", self.eng.facility_id, {"edges": changed, "closed": closed, "graph_revision": self.graph_revision},
                                   actor_type="system")
            for rid, pid in list(self.active.items()):
                plan = self.plans.get(pid)
                if plan and closed and set(plan.get("edges", ())) & set(changed):
                    self.replan(rid, reason="graph_closed")
        return {"ok": True, "changed": changed, "graph_revision": self.graph_revision}

    # ------------------------------------------------------------------ helpers
    def _now(self) -> float:
        return float(self.eng.sim_time)

    def _robot(self, rid: str) -> Any | None:
        return self.eng.robots.get(rid)

    def _new_plan_id(self, rid: str) -> str:
        self.seq += 1
        return f"rp_{rid}_{self.seq:04d}"

    def _refuse(self, reason: str, detail: str, **data: Any) -> Json:
        self.stats["refused"] += 1
        self.stats[f"refused:{reason}"] = self.stats.get(f"refused:{reason}", 0) + 1
        return Refusal(reason, detail, {"graph_revision": self.graph_revision, "traffic_revision": self.traffic_revision, **data}).to_json()

    def _parked_rects(self, exclude: str) -> tuple[list[list[float]], dict[str, list[float]]]:
        """Planning obstacles = robots that are really parked (no mission, no route, not driving). A robot that is merely waiting for its own
        mission step will move again: it is handled by the traffic guard / deadlock ladder, not by making the planner give up."""
        from ..engine.robots.traffic import PLAN_CLEAR_M, corners
        eng = self.eng
        out: dict[str, list[float]] = {}
        for o in eng.traffic.outrigs():
            if o.id == exclude or eng.traffic.is_moving(o):
                continue
            busy = eng.missions.active_mission(o.id) is not None or o.id in self.active or o.id in self.pending
            leased = eng.control.state_of(o.id) in ("MANUAL", "LEASE_PENDING")
            if busy and not leased:
                continue
            c = corners(o.pos[0], o.pos[2], o.yaw)
            xs, zs = [p[0] for p in c], [p[1] for p in c]
            shrink = max(0.0, eng.nav.radius - PLAN_CLEAR_M)
            out[o.id] = [min(xs) + shrink, min(zs) + shrink, max(xs) - shrink, max(zs) - shrink]
        return list(out.values()), out

    def _stationary_nodes(self, exclude: str) -> set[str]:
        """Graph nodes occupied by parked/idle OUTRIGs (they can be passed in the other lane but not stopped on or planned through)."""
        out = set()
        for o in self.eng.traffic.outrigs():
            if o.id == exclude or self.eng.traffic.is_moving(o):
                continue
            nid = self.ext.nearest_node(o.pos[0], o.pos[2])
            if nid and math.hypot(self.ext.nodes[nid]["x"] - o.pos[0], self.ext.nodes[nid]["z"] - o.pos[2]) < 1.0:
                out.add(nid)
        return out

    def resolve_target(self, target: Any) -> tuple[str | None, list[float] | None, str]:
        """target = asset id | graph node id | dock id | {x,z} -> (node id, final pose xz or None, label)"""
        if isinstance(target, dict):
            x, z = float(target.get("x", 0.0)), float(target.get("z", 0.0))
            nid = self.ext.nearest_node(x, z)
            if nid is None:
                return None, None, f"({x:.1f},{z:.1f})"
            n = self.ext.nodes[nid]
            # Coordinate targets can come from an asset centroid or a user's click. If that point is inside equipment
            # or the last leg would cross a rack/wall, stop at the reachable graph node instead of inventing access.
            if (not self.eng.nav.is_free(x, z)) or (not self.eng.nav.segment_free([n["x"], 0.0, n["z"]], [x, 0.0, z])):
                return nid, None, f"({x:.1f},{z:.1f})"
            return nid, [x, z], f"({x:.1f},{z:.1f})"
        t = str(target)
        if t in self.ext.nodes:
            n = self.ext.nodes[t]
            return t, n.get("pose_xz") or [n["x"], n["z"]], t
        if t in self.ext.targets:
            sp = (self.eng.asset_index.get(t) or {}).get("service_xyz_m")
            n = self.ext.nodes[self.ext.targets[t]]
            return self.ext.targets[t], [sp[0], sp[2]] if sp else [n["x"], n["z"]], t
        if f"DK:{t}" in self.ext.nodes:
            n = self.ext.nodes[f"DK:{t}"]
            return f"DK:{t}", n.get("pose_xz") or [n["x"], n["z"]], t
        a = self.eng.asset_index.get(t)
        if a and a.get("position_xyz_m"):
            nid = self.ext.nearest_node(a["position_xyz_m"][0], a["position_xyz_m"][2])
            return nid, None, t
        return None, None, t

    # ------------------------------------------------------------------ reachability
    def reachability(self, robot_id: str, target: Any) -> Json:
        r = self._robot(robot_id)
        if r is None:
            return self._refuse("UNKNOWN_ROBOT", f"no robot {robot_id}")
        if r.klass == "outrig":
            p = self.plan(robot_id, target, preview=True, check_traffic=False)
        else:
            p = self.plan(robot_id, target, preview=True, check_traffic=False)
        if p.get("ok"):
            return {"ok": True, "reachable": True, "robot_id": robot_id, "target": str(target), "length_m": p["length_m"], "eta_s": p["eta_s"],
                    "via": p.get("edges", [])[:40], "graph_revision": self.graph_revision, "traffic_revision": self.traffic_revision}
        return {"ok": True, "reachable": False, "robot_id": robot_id, "target": str(target), "reason": p["reason"], "detail": p["detail"],
                "graph_revision": self.graph_revision, "traffic_revision": self.traffic_revision}

    # ------------------------------------------------------------------ planning
    def plan(self, robot_id: str, target: Any, *, preview: bool = True, check_traffic: bool = True, start_after_s: float = 0.0,
             avoid_nodes: set[str] | None = None, purpose: str = "operator") -> Json:
        r = self._robot(robot_id)
        if r is None:
            return self._refuse("UNKNOWN_ROBOT", f"no robot {robot_id}")
        if r.klass == "inpipe":
            return self._plan_interior(r, target, check_traffic=check_traffic, start_after_s=start_after_s, purpose=purpose)
        return self._plan_exterior(r, target, check_traffic=check_traffic, start_after_s=start_after_s, avoid_nodes=avoid_nodes or set(), purpose=purpose)

    # --- exterior
    def _plan_exterior(self, r: Any, target: Any, *, check_traffic: bool, start_after_s: float, avoid_nodes: set[str], purpose: str) -> Json:
        ext, now, eng = self.ext, self._now(), self.eng
        dst, pose, label = self.resolve_target(target)
        if dst is None:
            return self._refuse("UNKNOWN_TARGET", f"target {label} is not on the exterior navigation graph")
        src = ext.nearest_node(r.pos[0], r.pos[2], ok=lambda n: True)
        if src is None:
            return self._refuse("NO_ACCESS", f"{r.id} is not near any exterior graph node")
        start_pt = [r.pos[0], 0.0, r.pos[2]]
        sn = ext.nodes[src]
        if not eng.nav.segment_free(start_pt, [sn["x"], 0.0, sn["z"]]) and math.hypot(sn["x"] - r.pos[0], sn["z"] - r.pos[2]) > 0.8:
            return self._refuse("EQUIPMENT_BLOCK", f"{r.id} at ({r.pos[0]:.1f},{r.pos[2]:.1f}) has no clear way onto the graph")
        occupied = set(avoid_nodes)                 # parked robots are passed in the free part of the road (geometry below); only dwelling is exclusive
        dwell_nodes = {dst}
        path = ext.shortest(src, dst, avoid_nodes=occupied - dwell_nodes)
        alt_avoid: set[str] = set()
        if path is None:
            res2 = ext.shortest(src, dst)
            if res2 is None:
                comp_src = next((i for i, c in enumerate(ext.components()) if src in c), None)
                comp_dst = next((i for i, c in enumerate(ext.components()) if dst in c), None)
                why = "closed edge" if ext.closed else "no connecting road or aisle"
                return self._refuse("NO_ACCESS", f"no route from {src} to {dst} ({why}); components {comp_src} vs {comp_dst}", closed_edges=sorted(ext.closed))
            return self._refuse("RESERVATION_CONFLICT", f"every route to {label} passes a node excluded by a deadlock resolution", owner="?")
        for attempt in range(MAX_ALT_PATHS + 1):
            cost, nodes, edges = path
            plan = self._timeline_exterior(r, nodes, edges, now + start_after_s)
            conflict = None
            if check_traffic:
                conflict = self._place_in_time(r.id, plan)
            if conflict is None:
                break
            # try another path around the conflicting node/edge
            cres, cnode = conflict
            alt_avoid |= {cnode} if cnode in ext.nodes and cnode not in (src, dst) else set()
            alt = ext.shortest(src, dst, avoid_nodes=(occupied | alt_avoid) - dwell_nodes)
            if alt is None or attempt == MAX_ALT_PATHS:
                return self._refuse("RESERVATION_CONFLICT", f"{cres['resource']} is reserved by {cres['owner']} during [{cres['t0']:.0f}, {cres['t1']:.0f}] s",
                                    owner=cres["owner"], blocked_by=[cres["owner"]], window=[cres["t0"], cres["t1"]])
            path = alt
        # geometry: pose -> graph -> destination pose, right-hand lanes
        keep = []
        for i, n in enumerate(nodes):
            nd = ext.nodes[n]
            if 0 < i < len(nodes) - 1:
                pa, pn = ext.nodes[nodes[i - 1]], ext.nodes[nodes[i + 1]]
                d1 = (nd["x"] - pa["x"], nd["z"] - pa["z"])
                d2 = (pn["x"] - nd["x"], pn["z"] - nd["z"])
                l1, l2 = math.hypot(*d1) or 1.0, math.hypot(*d2) or 1.0
                if (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2) > 0.99:
                    continue                    # straight pass-through: no waypoint (a parked robot on a dock pad must not pin the path)
            keep.append([nd["x"], 0.0, nd["z"]])
        wps = [start_pt] + keep
        if pose is not None:
            wps.append([pose[0], 0.0, pose[1]])
        wps = _dedupe(wps)
        extras, parked = self._parked_rects(r.id)
        wps = eng.traffic.apply_lanes(wps, extras)
        fixed: list[list[float]] = [wps[0]]
        for a, b in zip(wps, wps[1:]):
            if math.dist(a, b) <= 0.05:
                continue
            if eng.nav.segment_free(a, b, extras):
                fixed.append(b)
                continue
            if not eng.nav.segment_free(a, b):
                return self._refuse("EQUIPMENT_BLOCK", f"leg ({a[0]:.1f},{a[2]:.1f}) -> ({b[0]:.1f},{b[2]:.1f}) intersects equipment or a wall")
            detour = eng.nav.route(a, b, extra=extras)           # a parked robot sits on the leg: pass it on the free side
            if detour is None:
                who = [oid for oid, rect in parked.items() if not eng.nav.segment_free(a, b, [rect])] or sorted(parked)
                return self._refuse("EQUIPMENT_BLOCK", f"leg ({a[0]:.1f},{a[2]:.1f}) -> ({b[0]:.1f},{b[2]:.1f}) is blocked by parked robot(s) {who}", blocked_by=who)
            fixed += [list(p) for p in detour[1:]]
        wps = fixed
        length = sum(math.dist(a, b) for a, b in zip(wps, wps[1:]))
        # energy: trip + return to the robot's own dock + reserve
        ret = ext.shortest(dst, ext.nearest_node(*(eng.asset_index[r.home_id]["position_xyz_m"][0::2])) or dst)
        ret_len = ret[0] if ret else 0.0
        need = (length + ret_len) / OUTRIG_SPEED_PLAN * DRAIN_MOVE_PCT_S + float(eng.cfg.battery_reserve_pct)
        if r.battery < need and purpose != "return":
            return self._refuse("BATTERY", f"{r.id} has {r.battery:.0f} % but the trip needs {need:.0f} % including the return to {r.home_id}", needed_pct=round(need, 1))
        plan.update(waypoints=[[round(c, 3) for c in p] for p in wps], length_m=round(length, 2), target=str(label), target_ref=target, kind="exterior", purpose=purpose,
                    from_node=src, to_node=dst, nodes=nodes, edges=edges, battery_needed_pct=round(need, 1), robot_id=r.id)
        plan["eta_s"] = round(plan["depart_t"] - now + length / OUTRIG_SPEED_PLAN, 1)
        plan["arrive_t"] = round(plan["depart_t"] + length / OUTRIG_SPEED_PLAN, 1)
        plan["valid_until"] = round(plan["arrive_t"] + PLAN_SLACK_S, 1)
        plan.update(graph_revision=self.graph_revision, traffic_revision=self.traffic_revision, plan_id=self._new_plan_id(r.id), ok=True, created_t=round(now, 2))
        self.stats["planned"] += 1
        self._remember(plan)
        return plan

    def _remember(self, plan: Json) -> None:
        self.previews[plan["plan_id"]] = plan
        while len(self.previews) > 128:
            self.previews.pop(next(iter(self.previews)))

    def _timeline_exterior(self, r: Any, nodes: list[str], edges: list[str], t0: float) -> Json:
        ext = self.ext
        v = OUTRIG_SPEED_PLAN
        t = t0
        items: list[tuple[str, float, float]] = []
        for i, n in enumerate(nodes):
            items.append((f"n:{n}", t - NODE_MARGIN_S, t + NODE_MARGIN_S))
            if i < len(edges):
                e = ext.edges[edges[i]]
                dt = e["length_m"] / v
                res = f"e:{e['id']}" if e["kind"] == "link" else f"e:{e['id']}:{n}"      # lanes: one slot per travel direction
                items.append((res, t - EDGE_MARGIN_S, t + dt + EDGE_MARGIN_S))
                t += dt + 0.5
        items.append((f"park:{nodes[-1]}", t, t + PARK_HOLD_S))
        return {"items": items, "depart_t": t0}

    def _place_in_time(self, owner: str, plan: Json) -> tuple[Json, str] | None:
        """Delay the whole plan (the robot waits where it stands) until every resource is free, up to MAX_WAIT_S.
        Returns None when placed, else (conflicting row, node id) so the caller can look for another path."""
        total = 0.0
        row, node = {}, ""
        for _ in range(80):
            hit = self.table.first_conflict(plan["items"], owner)
            if hit is None:
                plan["wait_s"] = round(total, 1)
                plan["depart_t"] = round(plan["depart_t"] + total, 3)
                return None
            i, row = hit
            res, a, _b = plan["items"][i]
            node = self._res_node(res)
            if res.startswith("park:"):
                return row, node                       # the destination itself is occupied: waiting cannot fix an occupied bay
            shift = max(0.5, row["t1"] - a + 0.25)
            if total + shift > MAX_WAIT_S:
                return row, node
            total += shift
            plan["items"] = [(rs, x + shift, y + shift) for rs, x, y in plan["items"]]
        return row, node

    @staticmethod
    def _res_node(res: str) -> str:
        parts = res.split(":")
        if res.startswith(("n:", "park:")):
            return ":".join(parts[1:])
        return ":".join(parts[2:]) if len(parts) > 2 else ""

    # --- interior
    def _plan_interior(self, r: Any, target: Any, *, check_traffic: bool, start_after_s: float, purpose: str) -> Json:
        eng, inp, now = self.eng, self.inp, self._now()
        eid, s = self._interior_target(target)
        if eid is None:
            a = eng.asset_index.get(str(target)) if not isinstance(target, dict) else None
            if a is not None:
                return self._refuse("NO_ACCESS", f"{a['id']} ({a['type']}) is not inside a crawler-passable pipe: heat-exchanger plates and rack cold-plate channels "
                                                 "are far below any crawler bore")
            return self._refuse("UNKNOWN_TARGET", f"target {target} is not a pipe segment or port")
        e_all = {e["id"]: e for e in eng.topo["edges"]}
        if eid not in e_all:
            return self._refuse("UNKNOWN_TARGET", f"no pipe segment {eid}")
        if not e_all[eid]["robot_passable"]:
            return self._refuse("NO_ACCESS", f"{eid} is not a crawler-passable segment: {e_all[eid].get('not_passable_reason', 'rack cold-plate / heat-exchanger channel')}")
        ed = inp.edges[eid]
        if r.hw.get("min_bore_mm", 0) > ed["bore_mm"]:
            return self._refuse("PIPE_CLEARANCE", f"{r.id} needs {r.hw['min_bore_mm']} mm but {eid} is {ed['bore_mm']} mm")
        if eid in inp.closed or eid in eng.locks.isolated_edges:
            return self._refuse("NO_ACCESS", f"{eid} is closed / isolated for service")
        pk = eng.sensing.pressure_kpa(eid)
        if pk is not None and pk > CRAWLER_MAX_PRESSURE_KPA:
            return self._refuse("PRESSURE_UNSAFE", f"{eid} reads {pk:.0f} kPa, above the {CRAWLER_MAX_PRESSURE_KPA:.0f} kPa crawler rating")
        if r.segment_id is None:
            return self._refuse("NO_ACCESS", f"{r.id} is not inside a pipe")
        blocked = set(eng.locks.blocked_edges()) | inp.closed
        occupant: dict[str, str] = {}
        # other crawlers that are out in the pipe (not parked in their port) block their segment
        for o in eng.robots.values():
            if o.klass == "inpipe" and o.id != r.id and o.segment_id and not eng.missions._at_home(o):       # a crawler in its port niche never blocks the through-bore
                blocked.add(o.segment_id)
                occupant[o.segment_id] = o.id
        rt = eng.graph.route({"edge_id": r.segment_id, "s": r.s_m}, {"edge_id": eid, "s": s}, min_bore_mm=r.hw["min_bore_mm"], blocked=blocked)
        if rt is None:
            rt2 = eng.graph.route({"edge_id": r.segment_id, "s": r.s_m}, {"edge_id": eid, "s": s}, min_bore_mm=r.hw["min_bore_mm"])
            if rt2 is not None:
                who = sorted({occupant[e] for e in (l["edge_id"] for l in rt2.legs) if e in occupant and occupant[e] != r.id})
                return self._refuse("RESERVATION_CONFLICT", "the only pipe route crosses a segment that is isolated or occupied by another crawler"
                                    + (f" ({', '.join(who)})" if who else ""), blocked_by=who)
            c1, c2 = inp.component_of_edge(r.segment_id), inp.component_of_edge(eid)
            return self._refuse("NO_ACCESS", f"{eid} is in pipe component {c2}, {r.id} is in component {c1}: the heat exchanger separates the circuits")
        # pressure along the route
        for leg in rt.legs:
            pk = eng.sensing.pressure_kpa(leg["edge_id"])
            if pk is not None and pk > CRAWLER_MAX_PRESSURE_KPA:
                return self._refuse("PRESSURE_UNSAFE", f"{leg['edge_id']} reads {pk:.0f} kPa on the route")
        need = rt.length * 2 / CRAWLER_SPEED * DRAIN_MOVE_PCT_S * 1.2 + float(eng.cfg.battery_reserve_pct)
        if r.battery < need and purpose != "return":
            return self._refuse("BATTERY", f"{r.id} has {r.battery:.0f} % but a round trip needs {need:.0f} %", needed_pct=round(need, 1))
        t = now + start_after_s
        items: list[tuple[str, float, float]] = []
        for leg in rt.legs:
            dt = abs(leg["s1"] - leg["s0"]) / CRAWLER_SPEED
            items.append((f"p:{leg['edge_id']}:{1 if leg['s1'] >= leg['s0'] else -1}", t - 1.0, t + dt + 1.0))
            t += dt
        plan: Json = {"items": items, "depart_t": now + start_after_s}
        if check_traffic:
            hit = self._place_in_time(r.id, plan)
            if hit is not None:
                row = hit[0]
                return self._refuse("RESERVATION_CONFLICT", f"{row['resource']} is reserved by {row['owner']} during [{row['t0']:.0f}, {row['t1']:.0f}] s", owner=row["owner"])
        wps = [[round(c, 3) for c in p] for p in rt.path.points][::max(1, len(rt.path.points) // 60)]
        plan.update(kind="interior", robot_id=r.id, target=eid, target_ref={"segment_id": eid, "s_m": s}, purpose=purpose, edges=[l["edge_id"] for l in rt.legs], nodes=[], waypoints=wps,
                    length_m=round(rt.length, 2), battery_needed_pct=round(need, 1), legs=rt.legs, route=rt)
        plan["eta_s"] = round(plan["depart_t"] - now + rt.length / CRAWLER_SPEED, 1)
        plan["arrive_t"] = round(plan["depart_t"] + rt.length / CRAWLER_SPEED, 1)
        plan["valid_until"] = round(plan["arrive_t"] + PLAN_SLACK_S, 1)
        plan.update(graph_revision=self.graph_revision, traffic_revision=self.traffic_revision, plan_id=self._new_plan_id(r.id), ok=True, created_t=round(now, 2))
        self.stats["planned"] += 1
        self._remember(plan)
        return plan

    def _interior_target(self, target: Any) -> tuple[str | None, float]:
        eng = self.eng
        if isinstance(target, dict):
            return target.get("segment_id") or target.get("edge_id"), float(target.get("s_m", target.get("s", 0.0)))
        t = str(target)
        if t in eng.graph.edges:
            return t, float(eng.graph.length(t)) / 2.0
        a = eng.asset_index.get(t)
        if a and a.get("edge_id"):
            return a["edge_id"], float(a.get("s_m") or eng.graph.length(a["edge_id"]) / 2.0)
        return None, 0.0

    # ------------------------------------------------------------------ commit / cancel / replan
    def commit(self, robot_id: str, plan: Json | None, expected_graph_revision: str | None, expected_traffic_revision: int | None,
               *, label: str = "Route", mode: str = "TRAVELING", source: str = "operator", manual: bool = False) -> Json:
        r = self._robot(robot_id)
        if r is None:
            return self._refuse("UNKNOWN_ROBOT", f"no robot {robot_id}")
        if plan is None or not plan.get("ok"):
            return self._refuse("UNKNOWN_PLAN", "no such plan (plans are previewed and committed by id; re-plan)")
        if plan["robot_id"] != robot_id:
            return self._refuse("UNKNOWN_PLAN", "plan belongs to another robot")
        if expected_graph_revision is not None and expected_graph_revision != self.graph_revision:
            return self._refuse("STALE_GRAPH", f"graph revision {expected_graph_revision} != current {self.graph_revision}; re-plan")
        # optimistic on the traffic revision: if somebody else reserved in the meantime, re-validate against the table
        items = [tuple(i) for i in plan["items"]]
        hit = self.table.first_conflict(items, robot_id)
        if hit is not None:
            row = hit[1]
            if expected_traffic_revision is not None and expected_traffic_revision != self.traffic_revision:
                return self._refuse("STALE_TRAFFIC", f"traffic revision moved and {row['resource']} is now held by {row['owner']}; re-plan", owner=row["owner"])
            return self._refuse("RESERVATION_CONFLICT", f"{row['resource']} is held by {row['owner']}", owner=row["owner"])
        if robot_id in self.active:
            self.cancel(robot_id, reason="superseded", quiet=True)
        if r.klass == "outrig" and (plan["waypoints"] is None or len(plan["waypoints"]) < 2):
            return self._refuse("NO_ACCESS", "empty route")
        # bind: reservations + motion
        self.table.release_owner(robot_id, ("park",))
        self.table.reserve(plan["plan_id"], robot_id, items, plan["valid_until"], kind="route")
        stored = {k: v for k, v in plan.items() if k not in ("route",)}
        stored.update(status="committed", source=source, label=label, committed_t=round(self._now(), 2), passed=[])
        stored["route_obj"] = plan.get("route")
        self.plans[plan["plan_id"]] = stored
        self.active[robot_id] = plan["plan_id"]
        self.dirty_plans.add(plan["plan_id"])
        self.stats["committed"] += 1
        if manual:
            pts = [list(p) for p in plan["waypoints"]]
            cum = [0.0]
            for a, b in zip(pts, pts[1:]):
                cum.append(cum[-1] + math.dist(a, b))
            self.dest[robot_id] = {"plan_id": plan["plan_id"], "pts": pts, "cum": cum, "moved": 0.0, "paused": False}
            self.tube.reset(robot_id)
        elif plan["depart_t"] > self._now() + 0.01:
            self.pending[robot_id] = {"plan_id": plan["plan_id"], "depart_t": plan["depart_t"], "label": label, "mode": mode}
        else:
            self._start_motion(r, stored, label, mode)
        e = self.eng
        e.emit_internal("robot.route_planned", robot_id, self._event_payload(stored), actor_type="system")
        e.emit_internal("robot.route_committed", robot_id, self._event_payload(stored), actor_type="system")
        e.emit_internal("traffic.reservation", robot_id, {"robot_id": robot_id, "plan_id": stored["plan_id"], "action": "reserved",
                                                          "resources": [i[0] for i in items][:12], "n_resources": len(items), "depart_t": stored["depart_t"],
                                                          "graph_revision": self.graph_revision, "traffic_revision": self.traffic_revision}, actor_type="system")
        return {"ok": True, "committed": True, **{k: stored[k] for k in ("plan_id", "robot_id", "eta_s", "length_m", "depart_t", "arrive_t", "wait_s")
                                                  if k in stored},
                "graph_revision": self.graph_revision, "traffic_revision": self.traffic_revision}

    def _event_payload(self, p: Json) -> Json:
        return {"robot_id": p["robot_id"], "plan_id": p["plan_id"], "kind": p["kind"], "target": p.get("target"), "length_m": p["length_m"],
                "eta_s": p["eta_s"], "wait_s": p.get("wait_s", 0.0), "edges": p.get("edges", [])[:30], "source": p.get("source", "operator"),
                "graph_revision": self.graph_revision, "traffic_revision": self.traffic_revision}

    def _start_motion(self, r: Any, plan: Json, label: str, mode: str) -> None:
        if plan["kind"] == "exterior":
            r.start_move_outrig([list(p) for p in plan["waypoints"]], label, mode)
        else:
            r.start_move_inpipe(plan["route_obj"], label, mode)
        plan["started_t"] = round(self._now(), 2)

    def cancel(self, robot_id: str, *, reason: str = "operator", quiet: bool = False) -> Json:
        r = self._robot(robot_id)
        if r is None:
            return self._refuse("UNKNOWN_ROBOT", f"no robot {robot_id}")
        pid = self.active.pop(robot_id, None)
        self.pending.pop(robot_id, None)
        self.dest.pop(robot_id, None)
        if pid is None:
            return {"ok": True, "cancelled": False, "detail": "no active route", "graph_revision": self.graph_revision}
        self.table.release_plan(pid)
        p = self.plans.get(pid)
        if p:
            p["status"] = "cancelled"
            self.dirty_plans.add(pid)
        if r.active is not None and r.active.get("type") in ("move_outrig", "move_inpipe") and self.eng.control.state_of(robot_id) == "AUTONOMOUS":
            r.cancel_active()
            if r.mode == "TRAVELING":
                r.mode = "IDLE"
        self.waits.pop(robot_id, None)
        if not quiet:
            self.eng.emit_internal("robot.route_cancelled", robot_id, {"robot_id": robot_id, "plan_id": pid, "reason": reason,
                                                                       "graph_revision": self.graph_revision}, actor_type="system")
            self.eng.emit_internal("traffic.reservation", robot_id, {"robot_id": robot_id, "plan_id": pid, "action": "released", "reason": reason,
                                                                     "graph_revision": self.graph_revision, "traffic_revision": self.traffic_revision}, actor_type="system")
        return {"ok": True, "cancelled": True, "plan_id": pid, "graph_revision": self.graph_revision, "traffic_revision": self.traffic_revision}

    def replan(self, robot_id: str, *, reason: str, avoid_nodes: set[str] | None = None) -> Json:
        """Plan again from where the robot is NOW; the old route is only replaced if a new one exists (commit supersedes it atomically),
        so a failed replan never leaves a robot with a half-cancelled route."""
        r = self._robot(robot_id)
        pid = self.active.get(robot_id)
        old = self.plans.get(pid or "")
        if r is None or old is None:
            return {"ok": False, "reason": "UNKNOWN_PLAN", "detail": "nothing to replan"}
        target = old.get("target_ref", old.get("target"))
        label, mode, source = old.get("label", "Route"), "TRAVELING", old.get("source", "operator")
        own = self.table.by_plan.get(pid, [])
        saved_rows = [dict(x) for x in own]
        self.table.release_plan(pid)                         # our own old reservations must not block the new plan
        new = self.plan(robot_id, target, preview=False, avoid_nodes=avoid_nodes, purpose=old.get("purpose", "operator"))
        if not new.get("ok"):
            self.table.reserve(pid, robot_id, [(x["resource"], x["t0"], x["t1"]) for x in saved_rows], old["valid_until"], kind="route")
            self.eng.emit_internal("traffic.blocked", robot_id, {"robot_id": robot_id, "plan_id": pid, "reason": new["reason"], "detail": new["detail"],
                                                                 "graph_revision": self.graph_revision}, actor_type="system")
            return new
        self.stats["replanned"] += 1
        res = self.commit(robot_id, new, None, None, label=label, mode=mode, source=source)
        if res.get("ok"):
            old["status"] = "replaced"
            self.eng.emit_internal("robot.route_replanned", robot_id, {"robot_id": robot_id, "old_plan_id": pid, "plan_id": new["plan_id"], "reason": reason,
                                                                       "graph_revision": self.graph_revision}, actor_type="system")
        else:
            self.table.reserve(pid, robot_id, [(x["resource"], x["t0"], x["t1"]) for x in saved_rows], old["valid_until"], kind="route")
        return res

    def release_for_yield(self, robot_id: str) -> None:
        """A robot that backs out of a stand-off gives its route reservations back (it will plan again from its new spot)."""
        pid = self.active.pop(robot_id, None)
        self.pending.pop(robot_id, None)
        if pid:
            self.table.release_plan(pid)
            p = self.plans.get(pid)
            if p:
                p["status"] = "yielded"
                self.dirty_plans.add(pid)
        self.waits.pop(robot_id, None)

    def get_plan(self, plan_id: str) -> Json | None:
        return self.plans.get(plan_id)

    def public_plan(self, p: Json) -> Json:
        return {k: v for k, v in p.items() if k not in ("route", "route_obj", "items")}

    # ------------------------------------------------------------------ per-tick maintenance
    def on_tick(self) -> None:
        now = self._now()
        eng = self.eng
        # departures
        for rid, pend in list(self.pending.items()):
            if now >= pend["depart_t"]:
                self.pending.pop(rid, None)
                r, p = self._robot(rid), self.plans.get(pend["plan_id"])
                if r is not None and p is not None and p["status"] == "committed":
                    self._start_motion(r, p, pend["label"], pend["mode"])
        # progress: release resources the robot has passed; arrival
        for rid, pid in list(self.active.items()):
            r, p = self._robot(rid), self.plans.get(pid)
            if r is None or p is None:
                self.active.pop(rid, None)
                continue
            if rid in self.pending:
                continue
            if r.active is None and r.mode not in ("WORKING",) and p.get("started_t") is not None:
                self._arrive(r, p)
        # park reservations for stationary outrigs; stalled-plan expiry
        for gone in self.table.expire(now):
            self.stats["expired"] += 1
            for rid, pid in list(self.active.items()):
                if pid == gone:
                    self.active.pop(rid, None)
                    self.eng.emit_internal("traffic.reservation", rid, {"robot_id": rid, "plan_id": gone, "action": "expired",
                                                                        "graph_revision": self.graph_revision, "traffic_revision": self.traffic_revision}, actor_type="system")
        if now >= self._next_check:
            self._next_check = now + DEADLOCK_CHECK_S
            self._refresh_parking(now)
            self.detect_and_resolve(now)

    def _arrive(self, r: Any, p: Json) -> None:
        now = self._now()
        self.active.pop(r.id, None)
        self.table.release_plan(p["plan_id"])
        p["status"] = "arrived"
        p["actual_arrival_t"] = round(now, 2)
        p["eta_error_s"] = round(now - p["arrive_t"], 1)
        self.dirty_plans.add(p["plan_id"])
        self.history.append({"plan_id": p["plan_id"], "robot_id": r.id, "kind": p["kind"], "eta_t": p["arrive_t"], "actual_t": p["actual_arrival_t"],
                             "wait_s": p.get("wait_s", 0.0), "source": p.get("source")})
        del self.history[:-400]
        self.arrivals[r.id] = {"plan_id": p["plan_id"], "t": now}
        m = self.eng.missions.active_mission(r.id)
        if m is not None and m.get("route_plan_id") == p["plan_id"]:
            m.setdefault("arrivals", []).append({"plan_id": p["plan_id"], "eta_s": p["eta_s"], "actual_s": round(now - p["created_t"], 1), "t": round(now, 1)})
            self.eng.missions.dirty.add(m["id"])
        self.eng.emit_internal("robot.arrived", r.id, {"robot_id": r.id, "plan_id": p["plan_id"], "target": p.get("target"),
                                                       "mission_id": m["id"] if m else None, "incident_id": m.get("incident_id") if m else None,
                                                       "eta_s": p["eta_s"], "actual_s": round(now - p["created_t"], 1), "eta_error_s": p["eta_error_s"],
                                                       "graph_revision": self.graph_revision, "traffic_revision": self.traffic_revision}, actor_type="system")
        if r.klass == "inpipe" and p.get("source") == "operator" and self.eng.missions.active_mission(r.id) is None and r.mode in ("ASSIGNED", "TRAVELING", "RETURNING"):
            r.mode = "DOCKED" if self.eng.missions._at_home(r) else "IDLE"
        if r.klass == "outrig":
            self._park(r, now)
            if p.get("source") == "operator" and self.eng.missions.active_mission(r.id) is None and r.mode in ("ASSIGNED", "TRAVELING", "RETURNING"):
                r.mode = "DOCKED" if self.eng.missions._at_home(r) else "IDLE"

    def _refresh_parking(self, now: float) -> None:
        for o in self.eng.traffic.outrigs():
            pid = f"park_{o.id}"
            if self.eng.traffic.is_moving(o) or o.id in self.active:
                self.table.release_plan(pid)
                continue
            self._park(o, now)

    def _park(self, o: Any, now: float) -> None:
        nid = self.ext.nearest_node(o.pos[0], o.pos[2])
        if not nid or math.hypot(self.ext.nodes[nid]["x"] - o.pos[0], self.ext.nodes[nid]["z"] - o.pos[2]) > 1.0:
            return
        pid = f"park_{o.id}"
        rows = self.table.by_plan.get(pid)
        if rows and rows[0]["resource"] == f"park:{nid}":
            return
        self.table.release_plan(pid)
        self.table.reserve(pid, o.id, [(f"park:{nid}", now, now + PARK_HOLD_S)], now + PARK_HOLD_S, kind="park")

    # ------------------------------------------------------------------ priority / deadlock
    def note_served(self, rid: str) -> None:
        self.served[rid] = self._now()
        self.served_count[rid] = self.served_count.get(rid, 0) + 1

    def age_bonus(self, rid: str) -> float:
        return min(AGING_MAX, max(0.0, (self._now() - self.served.get(rid, 0.0)) / AGING_S))

    def priority(self, rid: str) -> float:
        """Mission severity + aging (starvation guard), quantised to 0.5 so right-of-way does not flip every tick."""
        eng = self.eng
        if eng.control.state_of(rid) == "MANUAL":
            m = self.manual.get(rid) or {}
            held = self._now() - float(m.get("since", self._now()))
            return 3.0 if held < MANUAL_PRIORITY_S else 0.0            # bounded: a long-running manual take-over stops outranking autonomy
        m = eng.missions.active_mission(rid)
        if m is None:
            return 0.0
        sev = {"critical": 5, "warning": 4, "watch": 3}.get(str((eng.track.incidents.get(m.get("incident_id") or "") or {}).get("severity", "")), 2)
        base = 1 if m["kind"] == "return" else sev
        return base + round(self.age_bonus(rid) * 2) / 2.0

    def outranks(self, a: str, b: str) -> bool:
        pa, pb = self.priority(a), self.priority(b)
        return pa > pb or (pa == pb and a < b)

    def detect_and_resolve(self, now: float) -> list[Json]:
        """Wait-for graph (reservation waits + physical traffic-guard holds); resolve each cycle with a deterministic ladder."""
        eng = self.eng
        for rid in [r for r, t in self.wait_t.items() if now - t > 12.0]:         # stale planning waits drop out unless refreshed by the retry
            self.waits.pop(rid, None)
            self.wait_t.pop(rid, None)
        edges: dict[str, str] = dict(self.waits)
        for rid, other in eng.traffic.blocked_by.items():
            if eng.traffic.blocked_s.get(rid, 0.0) > 2.0:
                edges[rid] = other
        out = []
        seen: set[str] = set()
        for start in sorted(edges):
            if start in seen:
                continue
            path, cur = [], start
            while cur in edges and cur not in path:
                path.append(cur)
                cur = edges[cur]
            seen.update(path)
            if cur in path:
                cycle = path[path.index(cur):]
                out.append(self._resolve_cycle(cycle, now))
        return out

    def note_wait(self, rid: str, plan: Json | None) -> None:
        """A mission-driven plan was refused because of robot(s): record the wait-for edge (refreshed on every retry, dropped when it ends)."""
        by = [b for b in (plan or {}).get("blocked_by", []) if b != rid and b in self.eng.robots]
        if plan is None or plan.get("ok") or not by:
            self.waits.pop(rid, None)
            self.wait_t.pop(rid, None)
            return
        self.waits[rid] = by[0]
        self.wait_t[rid] = self._now()
        r = self.eng.robots.get(rid)
        if r is not None and r.klass == "inpipe":
            self._ask_crawlers_to_retreat(rid, by)

    def _ask_crawlers_to_retreat(self, waiter: str, blockers: list[str]) -> None:
        """Tree-shaped pipe network: a crawler cannot pass another one in the bore. A blocker that is not doing timed work (idle / waiting itself)
        and does not outrank the waiter retreats into its port niche; the waiter's retry then finds the bore free."""
        eng, now = self.eng, self._now()
        for bid in blockers:
            b = eng.robots.get(bid)
            if b is None or b.klass != "inpipe" or b.active is not None or bid in self.active or bid in self.pending:
                continue
            if b.mode not in ("IDLE", "BLOCKED", "ASSIGNED") or eng.missions._at_home(b):
                continue
            if self.outranks(bid, waiter) and not (eng.missions.active_mission(bid) is None):
                continue
            if now - self.retreat_t.get(bid, -1e9) < RETREAT_COOLDOWN_S:
                continue
            home = eng.asset_index.get(b.home_id)
            if not home:
                continue
            rp = self.plan(bid, {"segment_id": home["edge_id"], "s_m": home["s_m"]}, preview=False, purpose="return")
            if rp.get("ok") and self.commit(bid, rp, None, None, label="Retreat to port", mode="RETURNING", source="deadlock").get("ok"):
                self.retreat_t[bid] = now
                self.stats["retreats"] = self.stats.get("retreats", 0) + 1
                eng.emit_internal("traffic.yield", bid, {"robot_id": bid, "to": waiter, "strategy": "retreat_to_port", "graph_revision": self.graph_revision},
                                  actor_type="system")
                eng.missions.requeue_step(b, "route_blocked: retreating to port to let a higher-priority crawler pass (traffic)") if eng.missions.active_mission(bid) else None

    def inject_wait(self, a: str, b: str) -> None:
        """Test hook: declare that robot `a` waits for `b` (used to inject a deadlock cycle)."""
        self.waits[a] = b

    def _resolve_cycle(self, cycle: list[str], now: float) -> Json:
        eng = self.eng
        self.stats["deadlocks"] += 1
        victim = sorted(cycle, key=lambda r: (self.priority(r), [-ord(c) for c in r]))[0]       # lowest priority (aging included), ties: highest id
        info: Json = {"cycle": cycle, "victim": victim, "t": round(now, 1)}
        eng.emit_internal("traffic.blocked", victim, {"robot_id": victim, "reason": "DEADLOCK", "cycle": cycle, "action": "resolving",
                                                      "graph_revision": self.graph_revision}, actor_type="system")
        r = eng.robots[victim]
        other = next((c for c in cycle if c != victim), cycle[0])
        for strategy in ("reroute", "back_off", "preempt_parking", "expire"):
            ok = False
            if strategy == "reroute" and victim in self.active:
                blockers = {self.ext.nearest_node(eng.robots[c].pos[0], eng.robots[c].pos[2]) for c in cycle if c != victim}
                res = self.replan(victim, reason="deadlock", avoid_nodes={b for b in blockers if b})
                ok = bool(res.get("ok"))
            elif strategy == "back_off" and r.klass == "outrig":
                ok = eng.missions.back_off(r, eng.robots[other])
            elif strategy == "preempt_parking" and r.klass == "inpipe":
                # a crawler retreats to its own recovery port so the other one can pass; its mission step keeps waiting and re-plans from there
                home = eng.asset_index[r.home_id]
                rp = self.plan(victim, {"segment_id": home["edge_id"], "s_m": home["s_m"]}, preview=False, purpose="return")
                ok = bool(rp.get("ok")) and bool(self.commit(victim, rp, None, None, label="Retreat to port", mode="RETURNING", source="deadlock").get("ok"))
            elif strategy == "preempt_parking":
                for c in cycle:
                    o = eng.robots[c]
                    if c != victim and o.klass == "outrig" and eng.missions.active_mission(c) is None and c not in self.active:
                        park = self._free_parking_node(o)
                        if park:
                            pp = self.plan(c, park, preview=False, purpose="preempt")
                            ok = bool(pp.get("ok")) and bool(self.commit(c, pp, None, None, label="Move to parking", source="deadlock").get("ok"))
                            if ok:
                                break
            elif strategy == "expire":
                released = self.table.release_owner(victim)
                self.waits.pop(victim, None)
                eng.traffic.clear_hold(victim)
                r.cancel_active()
                self.active.pop(victim, None)
                self.pending.pop(victim, None)
                eng.missions.requeue_step(r, "route_blocked: safe stop after unresolved deadlock (traffic)")
                if r.klass == "outrig":
                    r.mode = "BLOCKED"
                eng.emit_internal("traffic.blocked", victim, {"robot_id": victim, "reason": "DEADLOCK_UNRESOLVED", "cycle": cycle, "action": "safe_stop",
                                                              "released_plans": released, "graph_revision": self.graph_revision}, actor_type="system")
                self.stats["deadlocks_held"] += 1
                info.update(strategy="safe_stop", resolved=False)
                return info
            if ok:
                for c in cycle:
                    self.waits.pop(c, None)
                self.stats["deadlocks_resolved"] += 1
                self.stats["yields"] += 1
                eng.emit_internal("traffic.yield", victim, {"robot_id": victim, "to": other, "strategy": strategy, "cycle": cycle,
                                                            "graph_revision": self.graph_revision}, actor_type="system")
                info.update(strategy=strategy, resolved=True)
                return info
        return info

    def _free_parking_node(self, o: Any) -> str | None:
        best, bd = None, 1e18
        for nid, n in self.ext.nodes.items():
            if "parking" not in n["kinds"]:
                continue
            if self.table.occupancy(f"park:{nid}", self._now()):
                continue
            d = math.hypot(n["x"] - o.pos[0], n["z"] - o.pos[2])
            if 1.5 < d < bd:
                best, bd = nid, d
        return best

    # ------------------------------------------------------------------ manual control (lease holder)
    def manual_begin(self, robot_id: str) -> None:
        self.manual[robot_id] = {"since": self._now()}
        self.tube.reset(robot_id)
        self.dest.pop(robot_id, None)

    def manual_end(self, robot_id: str) -> None:
        self.manual.pop(robot_id, None)
        self.tube.reset(robot_id)
        if robot_id in self.dest:
            self.cancel(robot_id, reason="lease_ended", quiet=False)

    def manual_step(self, robot: Any, dt: float, throttle: float, steer: float, brake: bool, branch: str | None, vmax: float, accel: float,
                    decel: float, guard, hands_off: bool = False) -> Json:
        """One tick for a leased OUTRIG: destination mode when a committed plan is being followed and the operator is hands-off,
        otherwise the route tube. Any manual input pauses (overrides) a destination run."""
        rid = robot.id
        d = self.dest.get(rid)
        override = (not hands_off) and (abs(throttle) > 0.05 or abs(steer) > 0.05 or brake or bool(branch))
        if d is not None and not d["paused"] and override:
            d["paused"] = True
            self.tube.reset(rid)
            self.eng.emit_internal("robot.route_paused", rid, {"robot_id": rid, "plan_id": d["plan_id"], "reason": "manual_override",
                                                              "graph_revision": self.graph_revision}, actor_type="operator")
        if d is not None and not d["paused"]:
            return self._follow_dest(robot, d, dt, vmax, accel, decel, guard)
        return self.tube.step(robot, dt, throttle, steer, brake, branch, vmax, accel, decel, guard)

    def _follow_dest(self, robot: Any, d: Json, dt: float, vmax: float, accel: float, decel: float, guard) -> Json:
        info: Json = {"junction": None, "stopped_reason": None, "tube": False, "destination": True}
        total = d["cum"][-1]
        remaining = total - d["moved"]
        target = min(DEST_SPEED, vmax, max(0.05, remaining * 0.8))
        robot.v = min(target, robot.v + accel * dt) if target > robot.v else max(target, robot.v - decel * dt)
        robot.battery = max(0.0, robot.battery - 0.03 * dt)
        step = robot.v * dt
        from ..engine.geometry import Path, sample_path
        pts = d["pts"]
        path = Path(pts, d["cum"], total)
        p, t = sample_path(path, min(total, d["moved"] + step))
        yaw = math.atan2(t[0], t[2])
        npos = [p[0], robot.pos[1], p[2]]
        if guard is not None and not guard(npos, yaw):
            robot.v = 0.0
            robot.speed = 0.0
            info["stopped_reason"] = "obstacle"
            return info
        d["moved"] = min(total, d["moved"] + step)
        robot.pos, robot.yaw, robot.speed = npos, yaw, abs(robot.v)
        if d["moved"] >= total - 1e-6:
            pid = d["plan_id"]
            plan = self.plans.get(pid)
            self.dest.pop(robot.id, None)
            robot.v = robot.speed = 0.0
            self.tube.reset(robot.id)
            if plan:
                self._arrive(robot, plan)
        return info

    # ------------------------------------------------------------------ incident assignment support
    def score(self, robot_id: str, target: Any, *, tools_ok: bool = True, urgency: float = 1.0) -> Json:
        """Feasible-robot score: lower is better. Records the plan id / ETA the assignment was based on."""
        r = self._robot(robot_id)
        if r is None:
            return {"feasible": False, "reason": "UNKNOWN_ROBOT"}
        p = self.plan(robot_id, target, preview=True, check_traffic=True)
        if not p.get("ok"):
            return {"feasible": False, "reason": p["reason"], "detail": p["detail"]}
        if urgency <= 1.0:
            peers = [x.id for x in self.eng.robots.values() if x.klass == r.klass and x.battery >= 30.0]
            floor = min((self.served_count.get(x, 0) for x in peers), default=0)
            if self.served_count.get(robot_id, 0) > floor:
                return {"feasible": False, "reason": "FAIRNESS_WAIT",
                        "detail": f"{robot_id} has {self.served_count.get(robot_id, 0)} completions; waiting for same-class peers at {floor}"}
        busy = 0 if r.mode in ("DOCKED", "IDLE") else 60.0
        batt = max(0.0, 40.0 - r.battery) * 2.0
        aging = min(60.0, 0.25 * max(0.0, self._now() - self.served.get(robot_id, 0.0)))     # the robot unserved the longest is preferred
        rotation = 240.0 * self.served_count.get(robot_id, 0)                                # stronger than any same-hall ETA delta: avoids starvation
        return {"feasible": tools_ok, "score": round(p["eta_s"] + busy + batt + rotation - aging, 1), "eta_s": p["eta_s"], "route_plan_id": p["plan_id"],
                "length_m": p["length_m"], "wait_s": p.get("wait_s", 0.0), "graph_revision": self.graph_revision}

    # ------------------------------------------------------------------ persistence (Neon only on change)
    def persist_graphs(self) -> None:
        st = getattr(self.eng, "storage", None)
        if st is None or self.eng.replay:
            return
        try:
            st.register_nav_graph("exterior", self.ext.base_revision, [self.ext.nodes[k] for k in sorted(self.ext.nodes)], [self.ext.edges[k] for k in sorted(self.ext.edges)])
            st.register_nav_graph("interior", self.inp.base_revision, [self.inp.nodes[k] for k in sorted(self.inp.nodes)], [self.inp.edges[k] for k in sorted(self.inp.edges)])
            st.update_run(self.eng.run_id, nav_graph_revision=self.graph_revision)
        except Exception:                                   # noqa: BLE001 - persistence problems must never stop navigation; the commit path reports them
            self.eng.log.exception("could not register navigation graphs")

    def drain(self) -> tuple[list[Json], list[Json]]:
        """(route rows, reservation rows) changed since the last commit."""
        routes = []
        for pid in sorted(self.dirty_plans):
            p = self.plans.get(pid)
            if p is None:
                continue
            doc = {k: v for k, v in p.items() if k not in ("route", "route_obj", "items", "waypoints", "legs")}
            doc["waypoints"] = (p.get("waypoints") or [])[:60]
            doc["run_id"] = self.eng.run_id
            routes.append({"plan_id": pid, "robot_id": p["robot_id"], "kind": p["kind"], "status": p.get("status", "committed"), "source": p.get("source"),
                           "graph_revision": p.get("graph_revision", self.graph_revision), "traffic_revision": p.get("traffic_revision", 0),
                           "created_tick": int(p.get("created_t", 0.0) / max(self.eng.dt, 1e-9)), "depart_t": p.get("depart_t"), "arrive_t": p.get("arrive_t"),
                           "actual_arrival_t": p.get("actual_arrival_t"), "eta_s": p.get("eta_s"), "length_m": p.get("length_m"), "doc": doc})
        res = [dict(r, graph_revision=self.graph_revision, updated_tick=self.eng.tick) for r in self.table.journal]
        return routes, res

    def drained(self, routes: list[Json], reservations: list[Json]) -> None:
        done = {r["plan_id"] for r in routes}
        self.dirty_plans -= done
        del self.table.journal[: len(reservations)]

    def to_state(self) -> Json:
        plans = {pid: {k: v for k, v in p.items() if k not in ("route_obj", "route", "items")} for pid, p in self.plans.items()
                 if p.get("status") in ("committed",)}
        return {"seq": self.seq, "active": dict(self.active), "pending": dict(self.pending), "plans": plans, "table": self.table.to_state(),
                "served_count": dict(self.served_count),
                "stats": dict(self.stats), "closed": {"ext": sorted(self.ext.closed), "inp": sorted(self.inp.closed)},
                "graph_revision": self.graph_revision}

    def load_state(self, st: Json) -> None:
        if not st:
            return
        self.seq = int(st.get("seq", 0))
        self.table.load_state(st.get("table") or {})
        self.plans = {pid: dict(p) for pid, p in (st.get("plans") or {}).items()}
        self.served_count = {str(k): int(v) for k, v in (st.get("served_count") or {}).items()}
        self.active = {r: p for r, p in (st.get("active") or {}).items() if p in self.plans and r in self.eng.robots}
        self.pending = dict(st.get("pending") or {})
        self.stats.update(st.get("stats") or {})
        self.ext.closed = set((st.get("closed") or {}).get("ext", ()))
        self.inp.closed = set((st.get("closed") or {}).get("inp", ()))
        # a restored robot continues its recorded motion (robot.active is part of the robot state); plans without motion are dropped
        for rid, pid in list(self.active.items()):
            r = self.eng.robots[rid]
            if r.active is None and rid not in self.pending:
                self.active.pop(rid, None)
                self.table.release_plan(pid)
            else:
                p = self.plans[pid]
                if p["kind"] == "interior" and r.active is not None:
                    p["route_obj"] = r._path


def _dedupe(wps: list[list[float]]) -> list[list[float]]:
    out = [wps[0]]
    for p in wps[1:]:
        if math.dist(p, out[-1]) > 0.05:
            out.append(p)
    return out if len(out) > 1 else wps + [list(wps[0])]
