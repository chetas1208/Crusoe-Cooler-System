"""OUTRIG fleet traffic: oriented footprints (body + stowed-arm envelope), right-hand lanes on the four roads, planning around
parked robots, and a hard separation guard so that no two exterior robots can ever overlap, whatever the planner did.

Design (docs/engineering/v6-layout.md, "time-based corridor reservations / passing bays"):
* Planning: a route avoids every robot that is *stationary* when the route is planned (its footprint is an extra obstacle in the
  nav grid, inflated by the robot radius), and legs that run along a road are shifted into the right-hand lane
  (east-bound z0+0.55, west-bound z0-0.55 with z south, so opposing traffic is 1.1 m apart; a 2.7 m road leaves 1.05 m of
  envelope-to-envelope clearance). A lane shift is only kept when the shifted polyline is collision-free; otherwise the plain route stays.
* Execution: before each OUTRIG step the engine asks `blocker()` whether the *next* pose overlaps another robot's footprint (plus a
  safety margin). If so the robot holds (speed 0) for this tick:
  every overlap is a hold (nobody pushes through anybody). Opposing traffic is separated by lanes, so mutual holds only occur at
  junction corners; after `REPLAN_AFTER_S` held, the mission step is re-planned with the then-current stationary robots as
  obstacles (the existing BLOCKED/wait/retry path), and after `blocked_timeout_s` the mission fails and the agent replans.
* Manual (leased) driving uses the same `manual_ok()` test, so a human cannot drive through racks, walls or another robot.
Everything is deterministic and uses simulated time only."""
from __future__ import annotations

import math
from typing import Any, Iterable

BODY_L = 0.95          # m, along heading (arm stowed)
ENVELOPE_W = 0.90      # m, across heading incl. stowed arm
MARGIN_M = 0.12        # safety gap between envelopes (lower-priority robot)
HARD_GAP_M = 0.05      # minimum envelope gap the higher-priority robot may still close to
LANE_OFFSET_M = 0.55
PLAN_CLEAR_M = 0.58           # envelope half-extent + margin used when planning around a parked robot
FINAL_APPROACH_M = 0.7        # last metres into a road pose run along the road axis, so a parked rover ends with a cardinal heading
AISLE_LANE_M = 0.55
LANE_RAMP_M = 0.8
REPLAN_AFTER_S = 10.0
BACKOFF_AFTER_S = 3.0         # a mutual stand-off this long makes the lower-priority robot reverse out of the way
BACKOFF_M = 1.8
YIELD_MAX_S = 40.0            # the yielding robot waits at most this long ...
YIELD_CLEAR_M = 4.5           # ... or until the robot it yields to is this far away
MIN_LANE_LEG_M = 1.6


def corners(x: float, z: float, yaw: float, length: float = BODY_L, width: float = ENVELOPE_W) -> list[tuple[float, float]]:
    hx, hz = math.sin(yaw), math.cos(yaw)               # heading in the x/z plane
    nx, nz = -hz, hx                                    # lateral
    l2, w2 = length / 2.0, width / 2.0
    return [(x + sx * hx * l2 + sy * nx * w2, z + sx * hz * l2 + sy * nz * w2) for sx, sy in ((1, 1), (1, -1), (-1, -1), (-1, 1))]


def _axes(c: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out = []
    for i in range(2):
        ex, ez = c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1]
        n = math.hypot(ex, ez) or 1.0
        out.append((-ez / n, ex / n))
    return out


def rects_overlap(a: list[tuple[float, float]], b: list[tuple[float, float]]) -> bool:
    """Separating-axis test for two convex quads (touching counts as overlapping)."""
    for ax, az in _axes(a) + _axes(b):
        pa = [ax * x + az * z for x, z in a]
        pb = [ax * x + az * z for x, z in b]
        if max(pa) < min(pb) or max(pb) < min(pa):
            return False
    return True


def envelope_gap(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    """Signed gap (m) between two robot envelopes (x, z, yaw); negative = overlapping. Used by tests (max over separating axes)."""
    ca, cb = corners(*a), corners(*b)
    best = -1e9
    for ax, az in _axes(ca) + _axes(cb):
        pa = [ax * x + az * z for x, z in ca]
        pb = [ax * x + az * z for x, z in cb]
        best = max(best, min(pb) - max(pa), min(pa) - max(pb))
    return best


class Traffic:
    def __init__(self, eng: Any) -> None:
        self.eng = eng
        lay = eng.topo.get("facility_layout_v6") or {}
        self.roads = [{"id": r["road_id"], "z": float(r["z_m"]), "half": float(r["clear_width_m"]) / 2.0,
                       "x0": float(r["x_min_m"]), "x1": float(r["x_max_m"])} for r in lay.get("roads", [])]
        self.aisles = [{"id": c["id"], "x0": float(c["x_min_m"]), "x1": float(c["x_max_m"]), "xc": (float(c["x_min_m"]) + float(c["x_max_m"])) / 2.0,
                        "z0": float(c["z_min_m"]), "z1": float(c["z_max_m"])} for c in lay.get("cross_aisles", [])]
        self.blocked_s: dict[str, float] = {}
        self.blocked_by: dict[str, str] = {}
        self.yield_to: dict[str, tuple[str, float]] = {}
        self.stats = {"holds": 0, "replans": 0, "lane_routes": 0}

    # ------------------------------------------------------------ robots
    def outrigs(self) -> list[Any]:
        return [r for _, r in sorted(self.eng.robots.items()) if r.klass == "outrig"]

    @staticmethod
    def is_moving(r: Any) -> bool:
        return bool(r.active) and r.active.get("type") == "move_outrig" and not r.held and r.speed > 0.01

    def _pri(self, r: Any) -> tuple[int, str]:
        return (0 if self.is_moving(r) else 1, r.id)

    def outranks(self, a: str, b: str) -> bool:
        """Right of way: mission priority plus aging (a robot that has waited long for service outranks a recently served one), ties by id."""
        nav = getattr(self.eng, "navigation", None)
        return nav.outranks(a, b) if nav is not None else a < b

    def blocker(self, robot: Any, pos: list[float], yaw: float) -> Any | None:
        """Another OUTRIG whose envelope the proposed pose of `robot` would squeeze below the safety margin. A move is only refused when it
        makes the gap to that robot smaller than the margin AND smaller than it is now, so two robots that ended up close together can
        always move apart (and an overlap can never be created or deepened)."""
        for o in self.outrigs():
            if o.id == robot.id:
                continue
            if math.hypot(o.pos[0] - pos[0], o.pos[2] - pos[2]) > 2.2 and math.hypot(o.pos[0] - robot.pos[0], o.pos[2] - robot.pos[2]) > 2.2:
                continue
            new = envelope_gap((pos[0], pos[2], yaw), (o.pos[0], o.pos[2], o.yaw))
            # priority breaks symmetric stand-offs: the lower id may close to the hard minimum gap, the other keeps the full margin
            if new >= (HARD_GAP_M if self.outranks(robot.id, o.id) else MARGIN_M):
                continue
            cur = envelope_gap((robot.pos[0], robot.pos[2], robot.yaw), (o.pos[0], o.pos[2], o.yaw))
            if new < cur - 1e-6 or new <= 0.0:
                if new <= 0.0 and new >= cur - 1e-6 and cur <= 0.0:
                    continue                    # already overlapping (never created by the guard): allow only moves that do not deepen it
                return o
        return None

    def note_hold(self, robot: Any, other: Any, dt: float) -> bool:
        """Record a hold tick; True when the hold has lasted long enough that the step must be re-planned."""
        self.blocked_s[robot.id] = self.blocked_s.get(robot.id, 0.0) + dt
        self.blocked_by[robot.id] = other.id
        self.stats["holds"] += 1
        return self.blocked_s[robot.id] >= REPLAN_AFTER_S

    def mutual(self, robot: Any, other: Any) -> bool:
        """Stand-off: `other` is held by `robot` too (head-on, nose-to-nose at a junction) or is stuck waiting without a route."""
        return self.blocked_by.get(other.id) == robot.id or (not self.is_moving(other) and other.mode in ("BLOCKED", "ASSIGNED"))

    def backoff_route(self, robot: Any) -> list[list[float]] | None:
        """A short straight reverse along the robot's own heading that stays on free floor and clear of every other robot."""
        nav = self.eng.nav
        hx, hz = math.sin(robot.yaw), math.cos(robot.yaw)
        for d in (BACKOFF_M, 1.2, 0.7):
            tgt = [robot.pos[0] - hx * d, 0.0, robot.pos[2] - hz * d]
            if nav.is_free(tgt[0], tgt[2]) and nav.segment_free([robot.pos[0], 0.0, robot.pos[2]], tgt) and self.blocker(robot, tgt, robot.yaw) is None:
                return [[robot.pos[0], 0.0, robot.pos[2]], tgt]
        return None

    def start_yield(self, robot: Any, other: Any, now_s: float) -> None:
        nav = getattr(self.eng, "navigation", None)
        window = nav.yield_window(robot.id, other.id) if nav is not None else YIELD_MAX_S      # bounded retries: repeats of a pair wait longer
        self.yield_to[robot.id] = (other.id, now_s + window)

    def yielding(self, robot: Any, now_s: float) -> bool:
        """True while `robot` must stay put to let the higher-priority robot it backed away from get past (bounded in time and distance)."""
        y = self.yield_to.get(robot.id)
        if not y:
            return False
        o = self.eng.robots.get(y[0])
        if o is None or now_s >= y[1] or math.hypot(o.pos[0] - robot.pos[0], o.pos[2] - robot.pos[2]) > YIELD_CLEAR_M:
            self.yield_to.pop(robot.id, None)
            return False
        return True

    def clear_hold(self, robot_id: str) -> None:
        self.blocked_s.pop(robot_id, None)
        self.blocked_by.pop(robot_id, None)

    def stationary_rects(self, exclude: str) -> list[list[float]]:
        """Axis-aligned bounds of the envelopes of every parked/waiting OUTRIG except `exclude` (extra planning obstacles)."""
        out = []
        for o in self.outrigs():
            if o.id == exclude or self.is_moving(o):
                continue
            c = corners(o.pos[0], o.pos[2], o.yaw)
            xs, zs = [p[0] for p in c], [p[1] for p in c]
            shrink = max(0.0, self.eng.nav.radius - PLAN_CLEAR_M)          # grid inflates by nav.radius; moving robots need only ~PLAN_CLEAR_M
            out.append([min(xs) + shrink, min(zs) + shrink, max(xs) - shrink, max(zs) - shrink])
        return out

    def closed_road_rects(self, start: list[float], goal: list[float]) -> list[list[float]]:
        """Roads that are neither where the robot is nor where it is going are closed to through traffic (the aisles are the
        through routes): their interiors become extra planning obstacles, so a route never uses another road as a shortcut."""
        out = []
        for r in self.roads:
            inside = lambda p: abs(p[2] - r["z"]) <= r["half"] + 0.3 and r["x0"] - 0.3 <= p[0] <= r["x1"] + 0.3      # noqa: E731
            if inside(start) or inside(goal):
                continue
            out.append([r["x0"] + 0.6, r["z"] - r["half"], r["x1"] - 0.6, r["z"] + r["half"]])
        return out

    # ------------------------------------------------------------ manual driving
    def manual_ok(self, robot: Any, pos: list[float], yaw: float) -> bool:
        if not self.eng.nav.is_free(pos[0], pos[2]):
            return False
        return self.blocker(robot, pos, yaw) is None

    # ------------------------------------------------------------ lanes
    def _road_of(self, a: list[float], b: list[float]) -> dict | None:
        for r in self.roads:
            if abs(a[2] - r["z"]) > r["half"] or abs(b[2] - r["z"]) > r["half"]:
                continue
            lo, hi = min(a[0], b[0]), max(a[0], b[0])
            if min(hi, r["x1"]) - max(lo, r["x0"]) > 2.0:
                return r
        return None

    def _aisle_of(self, a: list[float], b: list[float]) -> dict | None:
        for c in self.aisles:
            if not (c["x0"] - 0.3 <= a[0] <= c["x1"] + 0.3 and c["x0"] - 0.3 <= b[0] <= c["x1"] + 0.3):
                continue
            if abs(b[2] - a[2]) >= 2.0 and abs(b[2] - a[2]) > 2.0 * abs(b[0] - a[0]):
                return c
        return None

    def apply_lanes(self, wps: list[list[float]], extras: Iterable[list[float]] = ()) -> list[list[float]]:
        """Shift road- and aisle-running legs into the right-hand lane; keep the original route if the result is not collision-free.
        Right-hand rule with y up and z south: east-bound (+x) keeps to +z of the road centreline, west-bound to -z; south-bound (+z)
        keeps to -x of the aisle centreline, north-bound to +x. Opposing traffic is then LANE_OFFSET*2 (roads) / AISLE_LANE*2 (aisles) apart."""
        nav = self.eng.nav
        extras = [list(e) for e in extras]
        out = [list(wps[0])]
        changed = False
        for a, b in zip(wps, wps[1:]):
            road = self._road_of(a, b)
            aisle = None if road else self._aisle_of(a, b)
            if road and abs(b[0] - a[0]) >= MIN_LANE_LEG_M + 2 * LANE_RAMP_M - 0.8 and abs(b[2] - a[2]) < 0.9:
                sgn = 1.0 if b[0] > a[0] else -1.0
                z = road["z"] + sgn * LANE_OFFSET_M
                out += [[a[0] + sgn * LANE_RAMP_M, 0.0, z], [b[0] - sgn * LANE_RAMP_M, 0.0, z], list(b)]
                changed = True
            elif aisle and abs(b[2] - a[2]) >= MIN_LANE_LEG_M + 2 * LANE_RAMP_M - 0.8:
                sgn = 1.0 if b[2] > a[2] else -1.0
                x = aisle["xc"] - sgn * AISLE_LANE_M
                out += [[x, 0.0, a[2] + sgn * LANE_RAMP_M], [x, 0.0, b[2] - sgn * LANE_RAMP_M], list(b)]
                changed = True
            else:
                out.append(list(b))
        if not changed:
            return wps
        # end the route with a straight run along the road axis (cardinal final heading)
        last = out[-1]
        rd = next((r for r in self.roads if abs(last[2] - r["z"]) <= r["half"] and r["x0"] <= last[0] <= r["x1"]), None)
        if rd is not None and len(out) >= 2:
            prev = out[-2]
            if abs(last[0] - prev[0]) > FINAL_APPROACH_M + 0.3:
                sgn = 1.0 if last[0] > prev[0] else -1.0
                out.insert(len(out) - 1, [last[0] - sgn * FINAL_APPROACH_M, 0.0, last[2]])
        for p, q in zip(out, out[1:]):
            if not nav.segment_free(p, q, extras):
                return wps
        self.stats["lane_routes"] += 1
        return out
