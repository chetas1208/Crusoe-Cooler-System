"""Manual driving of an OUTRIG projected onto the feasible route tube.

Low-level inputs never produce free 2-D motion: W/S move along the current graph edge, A/D move the robot inside the tube
(lateral offset within the clear width minus the robot envelope), and at a junction only the legal branches of that node are
selectable ("left" / "right" / "straight" or an exact edge id). Walls, racks and other robots are enforced twice: the tube
itself is collision-free by construction (validated at start-up) and every candidate pose is swept through the nav grid and the
traffic guard. Destination mode (a committed plan under the lease) follows the planned polyline and pauses on any manual input.
Deterministic; simulated time only."""
from __future__ import annotations

import math
from typing import Any, Callable

Json = dict[str, Any]
ENV_HALF = 0.45                  # half width of the OUTRIG envelope
TUBE_MARGIN = 0.12               # keep this far from the tube wall
LAT_RATE = 0.5                   # m/s lateral speed for full A/D
TURN_R = 0.9                     # junction connector radius
NODE_STOP = 0.05                 # distance from a node at which a robot waiting for a branch stops
DEST_SPEED = 0.405


def _norm(v):
    n = math.hypot(v[0], v[1]) or 1.0
    return (v[0] / n, v[1] / n)


def _right(d):
    return (-d[1], d[0])


class TubeDriver:
    def __init__(self, nav: Any) -> None:
        self.nav = nav
        self.st: dict[str, Json] = {}

    # ------------------------------------------------------------------ lifecycle
    def reset(self, rid: str) -> None:
        self.st.pop(rid, None)

    drop = reset

    def attach(self, robot: Any) -> Json | None:
        """Project the robot onto the nearest exterior edge (must be a clear straight move)."""
        ext, eng = self.nav.ext, self.nav.eng
        px, pz = robot.pos[0], robot.pos[2]
        best = None
        for eid, e in sorted(ext.edges.items()):
            if eid in ext.closed:
                continue
            (xa, za), (xb, zb) = e["centerline_xz_m"]
            dx, dz = xb - xa, zb - za
            L2 = dx * dx + dz * dz or 1.0
            t = max(0.0, min(1.0, ((px - xa) * dx + (pz - za) * dz) / L2))
            qx, qz = xa + dx * t, za + dz * t
            d = math.hypot(px - qx, pz - qz)
            if best is None or d < best[0]:
                best = (d, eid, t * math.sqrt(L2), qx, qz)
        if best is None or best[0] > 1.6:
            return None
        d, eid, s, qx, qz = best
        e = ext.edges[eid]
        (xa, za), (xb, zb) = e["centerline_xz_m"]
        dirv = _norm((xb - xa, zb - za))
        # facing: align with the closer of the two travel directions
        hx, hz = math.sin(robot.yaw), math.cos(robot.yaw)
        sign = 1 if hx * dirv[0] + hz * dirv[1] >= 0 else -1
        right = _right((dirv[0] * sign, dirv[1] * sign))
        lat = (px - qx) * right[0] + (pz - qz) * right[1]
        st = {"edge": eid, "dir": sign, "s": s, "lat": lat, "conn": None, "junction": None, "since": self.nav._now()}
        self.st[robot.id] = st
        return st

    # ------------------------------------------------------------------ geometry
    def _edge_dir(self, eid: str, sign: int) -> tuple[float, float]:
        e = self.nav.ext.edges[eid]
        (xa, za), (xb, zb) = e["centerline_xz_m"]
        d = _norm((xb - xa, zb - za))
        return (d[0] * sign, d[1] * sign)

    def _pose(self, st: Json) -> tuple[float, float, float]:
        """(x, z, yaw) of the robot for the current tube state."""
        if st["conn"]:
            c = st["conn"]
            x, z = _bezier(c["p0"], c["pc"], c["p1"], c["u"])
            tx, tz = _bezier_tangent(c["p0"], c["pc"], c["p1"], c["u"])
            n = _right(_norm((tx, tz)))
            return x + n[0] * st["lat"], z + n[1] * st["lat"], math.atan2(tx, tz)
        e = self.nav.ext.edges[st["edge"]]
        (xa, za), (xb, zb) = e["centerline_xz_m"]
        d = _norm((xb - xa, zb - za))
        f = (d[0] * st["dir"], d[1] * st["dir"])
        r = _right(f)
        return xa + d[0] * st["s"] + r[0] * st["lat"], za + d[1] * st["s"] + r[1] * st["lat"], math.atan2(f[0], f[1])

    def _tube_half(self, eid: str) -> float:
        return max(0.0, self.nav.ext.edges[eid]["width_m"] / 2 - ENV_HALF - TUBE_MARGIN)

    def _options_at(self, node: str, from_edge: str, facing: tuple[float, float]) -> dict[str, str]:
        """Legal exits at `node` keyed by turn type; also by exact edge id."""
        ext = self.nav.ext
        out: dict[str, str] = {}
        for eid, nb in ext.adj[node]:
            if eid == from_edge or eid in ext.closed:
                continue
            d = ext._dir(eid, node)                       # direction leaving the node along eid
            dot = facing[0] * d[0] + facing[1] * d[1]
            cross = facing[0] * d[1] - facing[1] * d[0]    # z-down frame: positive cross == turning right
            if dot > 0.85:
                kind = "straight"
            elif dot < -0.85:
                continue                                  # U-turn is not a branch
            else:
                kind = "right" if cross > 0 else "left"
            out.setdefault(kind, eid)
            out[eid] = eid
        return out

    # ------------------------------------------------------------------ one tick
    def step(self, robot: Any, dt: float, throttle: float, steer: float, brake: bool, branch: str | None, vmax: float, accel: float,
             decel: float, guard: Callable[[list[float], float], bool] | None) -> Json:
        info: Json = {"junction": None, "stopped_reason": None, "tube": True}
        st = self.st.get(robot.id) or self.attach(robot)
        if st is None:
            info["tube"] = False
            info["stopped_reason"] = "off_graph"
            robot.v = 0.0
            robot.speed = 0.0
            return info
        # speed profile (m/s along the facing direction; negative = reversing)
        target = 0.0 if brake else max(-1.0, min(1.0, throttle)) * min(vmax, 0.45)
        rate = decel if (brake or abs(target) < abs(robot.v) or target * robot.v < 0) else accel
        robot.v = min(target, robot.v + rate * dt) if target > robot.v else max(target, robot.v - rate * dt)
        robot.battery = max(0.0, robot.battery - (0.03 if abs(robot.v) > 1e-9 else 0.012) * dt)
        # lateral control inside the tube (only on straight runs)
        if not st["conn"]:
            half = self._tube_half(st["edge"])
            if abs(steer) > 1e-6 and not (st["junction"] and abs(steer) >= 0.5 and branch is None):
                st["lat"] = max(-half, min(half, st["lat"] + max(-1.0, min(1.0, steer)) * LAT_RATE * dt))
            else:
                st["lat"] = max(-half, min(half, st["lat"]))
        else:
            st["lat"] += (0.0 - st["lat"]) * min(1.0, 1.5 * dt)         # settle toward the centreline while turning
        dist = robot.v * dt
        prev = (list(robot.pos), robot.yaw)
        guard_hit = False
        if abs(dist) > 1e-9:
            new = self._advance(st, dist, branch, steer, info)
            x, z, yaw = self._pose(st)
            npos = [x, robot.pos[1], z]
            if guard is not None and not guard(npos, yaw):
                self._restore(st, new)
                robot.v = 0.0
                info["stopped_reason"] = "obstacle"
                guard_hit = True
            elif not self.nav.eng.nav.is_free(x, z) and not self._near_free(x, z):
                self._restore(st, new)
                robot.v = 0.0
                info["stopped_reason"] = "wall"
                guard_hit = True
            else:
                robot.pos = npos
                robot.yaw = yaw
        if info["junction"]:
            st["junction"] = info["junction"]
        elif not st["conn"]:
            st["junction"] = None
        robot.speed = abs(robot.v) if not guard_hit else 0.0
        robot.s_m = None
        return info

    def _near_free(self, x: float, z: float) -> bool:
        # tube edges lie on the nav-grid free cells by validation; allow the cell boundary quantisation (0.25 m grid)
        eng = self.nav.eng.nav
        return any(eng.is_free(x + dx, z + dz) for dx in (-0.13, 0.13, 0.0) for dz in (-0.13, 0.13, 0.0)) and not eng.in_obstacle(x, z)

    def _restore(self, st: Json, snap: Json) -> None:
        st.clear()
        st.update(snap)

    def _advance(self, st: Json, dist: float, branch: str | None, steer: float, info: Json) -> Json:
        """Move `dist` metres along the tube (negative = backwards). Returns the pre-move state so the caller can roll back if the swept
        pose is blocked. Junction decisions are taken one connector radius BEFORE the node; no choice -> the robot stops there."""
        before = {k: (dict(v) if isinstance(v, dict) else v) for k, v in st.items()}
        ext = self.nav.ext
        for _ in range(8):
            if abs(dist) <= 1e-9:
                break
            if st["conn"]:
                c = st["conn"]
                du = abs(dist) / max(c["len"], 1e-6)
                if dist > 0:
                    if c["u"] + du >= 1.0:
                        dist = (c["u"] + du - 1.0) * c["len"]
                        st.update(edge=c["to_edge"], dir=c["to_dir"], s=c["to_s"], conn=None)
                        continue
                    c["u"] += du
                else:
                    if c["u"] - du <= 0.0:
                        dist = -(du - c["u"]) * c["len"]
                        st.update(edge=c["from_edge"], dir=c["from_dir"], s=c["from_s"], conn=None)
                        continue
                    c["u"] -= du
                return before
            e = ext.edges[st["edge"]]
            L, sg = e["length_m"], st["dir"]
            fwd = dist > 0
            ns = st["s"] + dist * sg
            if not fwd:                                   # reversing never goes round a junction
                lo = max(0.0, min(L, ns))
                if lo != ns:
                    st["s"] = lo
                    info["stopped_reason"] = "reverse_limit"
                    return before
                st["s"] = ns
                return before
            end_s = L if sg == 1 else 0.0
            node = e["b"] if sg == 1 else e["a"]
            r_eff = min(TURN_R, L * 0.45)
            s_dec = end_s - sg * r_eff
            if (ns - s_dec) * sg <= 0:                    # still before the decision point
                st["s"] = ns
                return before
            facing = self._edge_dir(st["edge"], sg)
            opts = self._options_at(node, st["edge"], facing)
            legal = {k: v for k, v in opts.items() if k in ("straight", "left", "right")}
            choice = None
            uniq = set(legal.values())
            if branch and branch in opts:
                choice = opts[branch]
            elif len(uniq) == 1 and not branch:
                choice = next(iter(uniq))                 # nothing to decide
            elif not branch and abs(steer) >= 0.5 and len(uniq) > 1:
                choice = legal.get("right" if steer > 0 else "left")
            if choice is None:
                st["s"] = s_dec
                info["junction"] = sorted(uniq) if uniq else None
                info["branches"] = dict(legal)
                info["stopped_reason"] = "junction_select_exit" if uniq else "dead_end"
                if not uniq:                              # dead end: stop short of the end of the corridor
                    st["s"] = end_s - sg * NODE_STOP * 6
                return before
            ne = ext.edges[choice]
            to_dir = 1 if ne["a"] == node else -1
            nd = self._edge_dir(choice, to_dir)
            n = ext.nodes[node]
            beyond = (ns - s_dec) * sg                    # distance still to travel past the decision point
            straight = facing[0] * nd[0] + facing[1] * nd[1] > 0.85
            if straight:
                # pass the node and continue on the next edge (no connector needed)
                to_node_d = r_eff
                if beyond < to_node_d:
                    st["s"] = ns
                    return before
                dist = beyond - to_node_d
                st.update(edge=choice, dir=to_dir, s=0.0 if to_dir == 1 else ne["length_m"])
                continue
            r_out = min(TURN_R, ne["length_m"] * 0.45)
            p0 = (n["x"] - facing[0] * r_eff, n["z"] - facing[1] * r_eff)
            p1 = (n["x"] + nd[0] * r_out, n["z"] + nd[1] * r_out)
            st["s"] = s_dec
            st["conn"] = {"p0": p0, "pc": (n["x"], n["z"]), "p1": p1, "u": 0.0, "len": _bezier_len(p0, (n["x"], n["z"]), p1),
                          "from_edge": st["edge"], "from_dir": sg, "from_s": s_dec, "to_edge": choice, "to_dir": to_dir,
                          "to_s": r_out if to_dir == 1 else ne["length_m"] - r_out}
            dist = beyond
        return before


def _bezier(p0, pc, p1, u):
    a, b, c = (1 - u) ** 2, 2 * (1 - u) * u, u * u
    return (a * p0[0] + b * pc[0] + c * p1[0], a * p0[1] + b * pc[1] + c * p1[1])


def _bezier_tangent(p0, pc, p1, u):
    return (2 * (1 - u) * (pc[0] - p0[0]) + 2 * u * (p1[0] - pc[0]), 2 * (1 - u) * (pc[1] - p0[1]) + 2 * u * (p1[1] - pc[1]))


def _bezier_len(p0, pc, p1, n=12):
    pts = [_bezier(p0, pc, p1, i / n) for i in range(n + 1)]
    return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))
