"""Robot actors: kinematics + battery + serialisable motion/action state. Port of RobotActor in
packages/core/src/engine/robots.ts (poses must match what the client interpolates), plus manual (lease)
centerline driving. Pure state machine: no I/O, no wall clock, deterministic given the same inputs."""
from __future__ import annotations

import math
from typing import Any

from ..geometry import angle_delta, clamp, join_paths, sample_path, v_dist, v_sub, yaw_of
from .graphs import InpipeRoute, PipeGraph

CRAWLER_SPEED = 0.18   # m/s inside the pipe
OUTRIG_SPEED = 0.45    # m/s through corridors
TURN_RATE = 1.6        # rad/s
DRAIN_MOVE = 0.03      # battery %/s while moving
DRAIN_IDLE = 0.012
CHARGE = 0.05          # %/s while docked

ROBOT_MODES = ("IDLE", "ASSIGNED", "ROUTE_PLANNING", "TRAVELING", "INSPECTING", "WORKING", "VERIFYING",
               "RETURNING", "DOCKED", "BLOCKED", "FAILED", "ABORTED", "NEEDS_CHARGE", "SAFE_HOLD")


class RobotActor:
    def __init__(self, rid: str, klass: str, name: str, home_id: str, pos, yaw: float, spec: dict, hw: dict,
                 home: dict | None = None):
        self.id, self.klass, self.name, self.home_id = rid, klass, name, home_id
        self.spec = spec          # operator-facing hardware envelope (strings)
        self.hw = hw              # machine-readable envelope: min_bore_mm, reach_m, tools[]
        self.mode = "DOCKED"
        self.battery = 100.0
        self.tool: str | None = None
        self.mission_id: str | None = None
        self.task_id: str | None = None
        self.pos = [float(pos[0]), float(pos[1]), float(pos[2])]
        self.yaw = yaw
        self.speed = 0.0
        self.segment_id: str | None = home["edge_id"] if home else None
        self.s_m: float | None = home["s"] if home else None
        self.route: list | None = None
        self.v = 0.0              # signed centerline velocity for manual driving (m/s along +s)
        self.held = False         # motion frozen (SAFE_HOLD / manual takeover)
        self.active: dict | None = None
        self.done_count = 0
        self._path = None
        self.tangent = None       # unit travel direction (crawlers), server truth for the 3D pose
        self.dims_m = None
        self.road_id = None
        self.sector = None
        self.svc: dict | None = None            # autonomous service-controller phase (strainer exchange in the MuJoCo bay); persisted
        self.face_yaw: float | None = None     # turn in place toward this heading when idle (service pose arrival)

    # ------------------------------------------------------------ state
    def to_state(self) -> dict:
        return {"id": self.id, "mode": self.mode, "battery": self.battery, "tool": self.tool,
                "mission_id": self.mission_id, "task_id": self.task_id, "pos": self.pos, "yaw": self.yaw,
                "speed": self.speed, "segment_id": self.segment_id, "s_m": self.s_m, "route": self.route,
                "v": self.v, "held": self.held, "active": self.active, "done_count": self.done_count, "tangent": self.tangent,
                "svc": self.svc}

    def load_state(self, st: dict) -> None:
        for k in ("mode", "battery", "tool", "mission_id", "task_id", "pos", "yaw", "speed", "segment_id", "s_m",
                  "route", "v", "held", "active", "done_count"):
            setattr(self, k, st[k])
        self.tangent = st.get("tangent")
        self.svc = st.get("svc")
        self._path = None

    @property
    def busy(self) -> bool:
        return self.active is not None

    # ------------------------------------------------------------ commands
    def start_move_inpipe(self, route: InpipeRoute, label: str, mode: str = "TRAVELING") -> None:
        self.active = {"type": "move_inpipe", "legs": route.legs_json(), "label": label, "elapsed": 0.0,
                       "moved": 0.0, "length": route.length}
        self._path = route
        self.mode = mode
        self.held = False

    def start_move_outrig(self, waypoints: list, label: str, mode: str = "TRAVELING") -> None:
        cum = [0.0]
        for i in range(1, len(waypoints)):
            cum.append(cum[i - 1] + v_dist(waypoints[i - 1], waypoints[i]))
        self.active = {"type": "move_outrig", "waypoints": [list(map(float, p)) for p in waypoints], "label": label,
                       "elapsed": 0.0, "moved": 0.0, "length": cum[-1]}
        self.route = self.active["waypoints"]
        self._path = None
        self.mode = mode
        self.held = False

    def start_action(self, label: str, duration_s: float, mode: str, tool: str | None | bool = False) -> None:
        self.active = {"type": "action", "label": label, "elapsed": 0.0, "duration_s": duration_s, "progress": 0.0}
        self.mode = mode
        if tool is not False:
            self.tool = tool  # type: ignore[assignment]
        self.held = False

    def cancel_active(self) -> None:
        self.active = None
        self._path = None
        self.speed = 0.0
        self.v = 0.0
        self.route = None

    def progress(self) -> float:
        a = self.active
        if not a:
            return 1.0
        if a["type"] == "action":
            return clamp(a["elapsed"] / max(a["duration_s"], 1e-9), 0.0, 1.0)
        return a["moved"] / a["length"] if a["length"] > 0 else 1.0

    # ------------------------------------------------------------ physics step
    def step(self, dt: float, graph: PipeGraph) -> bool:
        """Advance one tick. Returns True iff the active command finished this tick."""
        moving = bool(self.active) and self.active["type"] != "action" and not self.held
        if self.mode == "DOCKED" and not self.active:
            self.battery = min(100.0, self.battery + CHARGE * dt)
        else:
            self.battery = max(0.0, self.battery - (DRAIN_MOVE if moving or abs(self.v) > 1e-9 else DRAIN_IDLE) * dt)
        a = self.active
        if self.face_yaw is not None:
            if a is not None or self.held or self.klass != "outrig":
                self.face_yaw = None if a is not None else self.face_yaw
            else:
                dy = angle_delta(self.yaw, self.face_yaw)
                self.yaw += clamp(dy, -TURN_RATE * dt, TURN_RATE * dt)
                self.battery = max(0.0, self.battery - DRAIN_MOVE * dt * 0.3)
                if abs(angle_delta(self.yaw, self.face_yaw)) < 1e-3:
                    self.face_yaw = None
        if not a or self.held:
            if not a:
                self.speed = 0.0 if abs(self.v) < 1e-9 else self.speed
            else:
                self.speed = 0.0
            return False
        a["elapsed"] += dt
        if a["type"] == "action":
            self.speed = 0.0
            if a["elapsed"] >= a["duration_s"]:
                return self._finish()
            return False
        v = CRAWLER_SPEED if self.klass == "inpipe" else OUTRIG_SPEED
        remaining = a["length"] - a["moved"]
        v_eff = min(v, max(0.03, remaining * 0.8))
        was = list(self.pos)
        a["moved"] = min(a["length"], a["moved"] + v_eff * dt)
        self.speed = v_eff
        if self.klass == "inpipe":
            route = self._route(graph)
            p, t = sample_path(route.path, a["moved"])
            self.pos = p
            li = 0
            for i, st in enumerate(route.leg_start):
                if a["moved"] >= st:
                    li = i
            leg = route.legs[li]
            into = a["moved"] - route.leg_start[li]
            self.segment_id = leg["edge_id"]
            self.s_m = leg["s0"] + into if leg["s1"] >= leg["s0"] else leg["s0"] - into
            self.yaw = math.atan2(t[0], t[2])
            self.tangent = [float(c) for c in t]
        else:
            path = self._outrig_path()
            p, t = sample_path(path, a["moved"])
            self.pos = [p[0], 0.0, p[2]]
            d = v_sub(p, was)
            tgt = yaw_of(t if all(abs(x) < 1e-9 for x in d) else d)
            dy = angle_delta(self.yaw, tgt)
            self.yaw += clamp(dy, -TURN_RATE * dt, TURN_RATE * dt)
        if a["moved"] >= a["length"] - 1e-6:
            return self._finish()
        return False

    def peek_outrig(self, dt: float):
        """(pos, yaw) this robot would have after `dt` on its active floor route, without changing any state (traffic guard)."""
        a = self.active
        if not a or a["type"] != "move_outrig" or self.held:
            return None
        remaining = a["length"] - a["moved"]
        v_eff = min(OUTRIG_SPEED, max(0.03, remaining * 0.8))
        moved = min(a["length"], a["moved"] + v_eff * dt)
        p, t = sample_path(self._outrig_path(), moved)
        d = v_sub(p, self.pos)
        tgt = yaw_of(t if all(abs(x) < 1e-9 for x in d) else d)
        yaw = self.yaw + clamp(angle_delta(self.yaw, tgt), -TURN_RATE * dt, TURN_RATE * dt)
        return [p[0], 0.0, p[2]], yaw

    def hold_tick(self, dt: float) -> None:
        """Traffic hold: stay put for this tick (idle drain, no progress on the route)."""
        self.battery = max(0.0, self.battery - DRAIN_IDLE * dt)
        self.speed = 0.0

    def _route(self, graph: PipeGraph) -> InpipeRoute:
        if self._path is None:
            self._path = graph.assemble(self.active["legs"])
        return self._path

    def _outrig_path(self):
        if self._path is None:
            from ..geometry import Path, _cum  # noqa: PLC0415
            pts = self.active["waypoints"]
            cum = _cum(pts)
            self._path = Path(pts, cum, cum[-1])
        return self._path

    def _finish(self) -> bool:
        a = self.active
        self.active = None
        self.speed = 0.0
        self.done_count += 1
        if a["type"] == "move_inpipe":
            last = a["legs"][-1]
            self.segment_id, self.s_m = last["edge_id"], last["s1"]
        if a["type"] == "move_outrig":
            self.route = None
        if self._path is not None:
            self._path = None
        if self.mode in ("TRAVELING", "RETURNING"):
            self.mode = "ASSIGNED"
        return True

    # ------------------------------------------------------------ manual centerline driving
    def manual_step(self, dt: float, graph: PipeGraph, throttle: float, brake: bool, exit_id: str | None,
                    vmax: float, accel: float, decel: float, blocked=(), steer: float = 0.0, guard=None) -> dict:
        """Kinematics for a leased robot. Centerline for INPIPE, 2D floor rover for OUTRIG."""
        info: dict[str, Any] = {"junction": None, "stopped_reason": None}
        if self.segment_id is None:
            if self.klass != "outrig":
                return info
            vmax = min(vmax, OUTRIG_SPEED)
            target = 0.0 if brake else clamp(throttle, -1.0, 1.0) * vmax
            rate = decel if (brake or abs(target) < abs(self.v) or target * self.v < 0) else accel
            if target > self.v:
                self.v = min(target, self.v + rate * dt)
            else:
                self.v = max(target, self.v - rate * dt)
            self.battery = max(0.0, self.battery - (DRAIN_MOVE if abs(self.v) > 1e-9 else DRAIN_IDLE) * dt)
            vyaw = clamp(steer, -1.0, 1.0) * 1.6
            yaw = self.yaw + vyaw * dt
            dist = self.v * dt
            npos = [self.pos[0] + math.sin(yaw) * dist, self.pos[1], self.pos[2] + math.cos(yaw) * dist]
            if guard is not None and not guard(npos, yaw):       # racks, walls and other robots are solid for a leased robot too
                self.v = 0.0
                self.speed = 0.0
                info["stopped_reason"] = "obstacle"
                return info
            self.yaw = yaw
            self.pos = npos
            self.speed = abs(self.v)
            return info
        target = 0.0 if brake else clamp(throttle, -1.0, 1.0) * vmax
        rate = decel if (brake or abs(target) < abs(self.v) or target * self.v < 0) else accel
        if target > self.v:
            self.v = min(target, self.v + rate * dt)
        else:
            self.v = max(target, self.v - rate * dt)
        # battery
        self.battery = max(0.0, self.battery - (DRAIN_MOVE if abs(self.v) > 1e-9 else DRAIN_IDLE) * dt)
        min_bore = self.hw.get("min_bore_mm", 0)
        dist = self.v * dt
        edge, s = self.segment_id, float(self.s_m or 0.0)
        guard = 0
        while abs(dist) > 1e-12 and guard < 6:
            guard += 1
            L = graph.length(edge)
            ns = s + dist
            if 0.0 <= ns <= L:
                s = ns
                dist = 0.0
                break
            at_end = ns > L
            carry = (ns - L) if at_end else (-ns)  # distance beyond the end, >0
            s = L if at_end else 0.0
            opts = graph.junction_options(edge, at_end, min_bore, blocked)
            nxt = exit_id if exit_id in opts else (opts[0] if len(opts) == 1 else None)
            if nxt is None:
                self.v = 0.0
                dist = 0.0
                info["junction"] = opts
                info["stopped_reason"] = "junction_select_exit" if opts else "dead_end"
                break
            node = graph.node_at(edge, at_end)
            e2 = graph.edge(nxt)
            L2 = graph.length(nxt)
            if e2["from"] == node:
                edge, s, dist = nxt, 0.0, carry
                self.v = abs(self.v)
            else:
                edge, s, dist = nxt, L2, -carry
                self.v = -abs(self.v)
        self.segment_id, self.s_m = edge, s
        p, t = sample_path(graph.path(edge), s)
        self.pos = p
        sign = 1.0 if self.v >= 0 else -1.0
        if abs(self.v) > 1e-9:
            self.yaw = math.atan2(t[0] * sign, t[2] * sign)
            self.tangent = [float(c) * sign for c in t]
        self.speed = abs(self.v)
        return info

    # ------------------------------------------------------------ contract view
    @staticmethod
    def _quat_forward_up(f, up=(0.0, 1.0, 0.0)):
        """Unit quaternion [x,y,z,w] of the frame whose +z is `f` and whose +y is as close to world-up as possible
        (no roll about the travel direction, so bends cannot flip the body)."""
        fx, fy, fz = f
        n = math.sqrt(fx * fx + fy * fy + fz * fz) or 1.0
        fx, fy, fz = fx / n, fy / n, fz / n
        ux, uy, uz = up
        if abs(fx * ux + fy * uy + fz * uz) > 0.999:           # travelling along the up axis: keep the previous body x direction
            ux, uy, uz = 1.0, 0.0, 0.0
        rx, ry, rz = uy * fz - uz * fy, uz * fx - ux * fz, ux * fy - uy * fx          # right = up x forward
        rn = math.sqrt(rx * rx + ry * ry + rz * rz) or 1.0
        rx, ry, rz = rx / rn, ry / rn, rz / rn
        ux, uy, uz = fy * rz - fz * ry, fz * rx - fx * rz, fx * ry - fy * rx          # up' = forward x right
        m00, m01, m02, m10, m11, m12, m20, m21, m22 = rx, ux, fx, ry, uy, fy, rz, uz, fz   # columns = right, up, forward
        tr = m00 + m11 + m22
        if tr > 0:
            sq = math.sqrt(tr + 1.0) * 2
            w, x, y, z = 0.25 * sq, (m21 - m12) / sq, (m02 - m20) / sq, (m10 - m01) / sq
        elif m00 > m11 and m00 > m22:
            sq = math.sqrt(1.0 + m00 - m11 - m22) * 2
            w, x, y, z = (m21 - m12) / sq, 0.25 * sq, (m01 + m10) / sq, (m02 + m20) / sq
        elif m11 > m22:
            sq = math.sqrt(1.0 + m11 - m00 - m22) * 2
            w, x, y, z = (m02 - m20) / sq, (m01 + m10) / sq, 0.25 * sq, (m12 + m21) / sq
        else:
            sq = math.sqrt(1.0 + m22 - m00 - m11) * 2
            w, x, y, z = (m10 - m01) / sq, (m02 + m20) / sq, (m12 + m21) / sq, 0.25 * sq
        return [round(x, 5), round(y, 5), round(z, 5), round(w, 5)]

    def heading(self) -> list:
        """Unit travel direction: the pipe tangent for crawlers (includes pitch), the floor heading for rovers."""
        if self.klass == "inpipe" and getattr(self, "tangent", None):
            return list(self.tangent)
        return [math.sin(self.yaw), 0.0, math.cos(self.yaw)]

    def to_contract(self) -> dict:
        h = self.heading()
        quat = self._quat_forward_up(h)
        vx, vy, vz = (round(self.speed * c, 4) for c in h)
        if self.klass == "inpipe" and self.v < 0:                      # reversing along the centerline
            vx, vy, vz = -vx, -vy, -vz
        dims = list(getattr(self, "dims_m", None) or ([0.28, 0.07, 0.07] if self.klass == "inpipe" else [0.95, 2.0, 0.62]))
        clearance = 0.01 if self.klass == "inpipe" else 0.15
        group = "internal" if self.klass == "inpipe" else "external"
        if self.mode == "WORKING":
            fleet_state = "repairing"
        elif self.mode in ("IDLE", "DOCKED"):
            fleet_state = "idle"
        elif self.mode in ("BLOCKED", "FAILED", "ABORTED", "NEEDS_CHARGE", "SAFE_HOLD"):
            fleet_state = {"SAFE_HOLD": "safe_hold", "NEEDS_CHARGE": "charging"}.get(self.mode, self.mode.lower())
        else:
            fleet_state = "working"
        fleet = {"group": group, "state": fleet_state, "dock_id": self.home_id}
        if getattr(self, "road_id", None):
            fleet.update(road_id=self.road_id, sector=self.sector)
        return {
            "id": self.id, "class": self.klass, "name": self.name, "mode": self.mode,
            "battery_pct": round(self.battery * 10) / 10, "mission_id": self.mission_id,
            "agent_task_id": self.task_id, "tool": self.tool, "home_id": self.home_id,
            "pose": {
                "frame_id": "facility_world",
                "position_xyz_m": list(self.pos),
                "yaw_rad": self.yaw,
                "heading_xyz": h,
                "quaternion_xyzw": quat,
                "linear_velocity_mps_xyz": [vx, vy, vz],
                "speed_m_s": self.speed,
                "segment_id": self.segment_id,
                "s_m": self.s_m,
                "covariance_or_quality": "simulated_truth",
            },
            "nav": {
                "graph_id": "cooling_network" if self.klass == "inpipe" else "road_navmesh",
                "segment_id": self.segment_id,
                "s_m": self.s_m,
                "route_id": self.mission_id,
                "floor_id": "L0",
            },
            "fleet": fleet,
            "dims_m": dims,
            "clearance_m": clearance,
            "route_xyz_m": self.route,
            "spec": self.spec,
            "capabilities": {"tools": list(self.hw.get("tools", [])), "min_bore_mm": self.hw.get("min_bore_mm"), "reach_m": self.hw.get("reach_m")},
        }

    def pose_key(self) -> str:
        return (",".join(f"{x:.3f}" for x in self.pos) + f"|{self.mode}|{round(self.battery * 10) / 10}|{self.yaw:.2f}|"
                f"{self.mission_id}|{self.tool}")
