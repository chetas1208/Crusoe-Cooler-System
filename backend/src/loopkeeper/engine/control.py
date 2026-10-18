"""Manual control leases (backend.md section 10): server-owned, expiring, exclusive per robot.
AUTONOMOUS -> LEASE_PENDING -> MANUAL -> SAFE_HOLD -> AUTONOMOUS. Only the engine tick moves robots."""
from __future__ import annotations

import math
from typing import TYPE_CHECKING

from .util import Json, clone, new_uuid

if TYPE_CHECKING:  # pragma: no cover
    from .core import Engine

HOLD_TICKS = 2          # SAFE_HOLD dwell before reconciliation back to AUTONOMOUS
MIN_MANUAL_BATTERY = 1.0   # manual drive is refused only when the pack is (nearly) empty: 1 % is ~30 s of driving. Every robot of a class uses this same rule.


def battery_refusal(robot, docked_charging: bool) -> str:
    """Plain-language reason (the `battery_depleted` prefix is the machine key the clients match on)."""
    b = max(0.0, float(robot.battery))
    where = ("It is charging at its dock now: try again in a minute." if docked_charging
             else "It cannot drive itself home with an empty pack: send it to its dock and a recovery crew will bring it in, or pick another robot.")
    return f"battery_depleted: {robot.id} has {b:.1f} % battery, manual drive needs at least {MIN_MANUAL_BATTERY:.0f} %. {where}"


_LEASE_END_TEXT = {
    "deadman_timeout": "the robot stopped because drive commands stopped arriving (dead-man timer)",
    "lease_expired": "the control session timed out",
    "operator_release": "control was released",
    "client_disconnect": "the controlling browser disconnected",
    "client_hidden": "the controlling tab was hidden",
    "battery_depleted": "the battery ran out",
    "engine_restart": "the simulator restarted",
}


class ControlManager:
    def __init__(self, eng: "Engine"):
        self.eng = eng
        self.ctl: dict[str, Json] = {}
        self.epochs: dict[str, int] = {}
        self.leases: dict[str, Json] = {}   # lease docs (include wall-clock fields; not part of the state hash)
        self.dirty: set = set()
        self._drive_emit: dict[str, float] = {}
        self.stop_info: dict[str, Json] = {}   # per robot: why the last manual step did not move it (transient, not part of the state hash)
        self.pending_dock: dict[str, str] = {}  # robot -> principal: "send to dock" asked while the robot was still under manual control
        for rid in eng.robots:
            self.ctl[rid] = self._blank()

    @staticmethod
    def _blank() -> Json:
        return {"state": "AUTONOMOUS", "lease_id": None, "principal_id": None, "epoch": 0, "last_command_seq": 0,
                "intent": None, "hold_since": None, "hold_reason": None, "junction": None}

    # ---- state ---------------------------------------------------------
    def to_state(self) -> Json:
        live = {lid: {k: l[k] for k in ("lease_id", "robot_id", "principal_id", "epoch", "status", "last_command_seq", "ttl_s", "deadman_s", "connection_id", "granted_tick")}
                for lid, l in self.leases.items() if l["status"] in ("pending", "active")}
        return {"ctl": self.ctl, "epochs": self.epochs, "leases": live}

    def load_state(self, st: Json) -> None:
        self.ctl = clone(st["ctl"])
        self.epochs = dict(st["epochs"])
        now = self.eng.wall_time()
        for lid, l in st.get("leases", {}).items():
            d = dict(l)
            d.update({"run_id": self.eng.run_id, "last_heartbeat": now, "expires_at": now + d["ttl_s"], "granted_at": now, "ended_reason": None})
            self.leases[lid] = d
        for rid in self.eng.robots:
            self.ctl.setdefault(rid, self._blank())

    def reconcile_robot_ids(self, legacy: dict, valid: set) -> None:
        """After a restore: migrate legacy robot ids, drop control rows/leases for robots outside the registry."""
        for old, new in legacy.items():
            if old in self.ctl:
                row = self.ctl.pop(old)
                if new in valid and (new not in self.ctl or self.ctl[new].get("state") == "AUTONOMOUS"):
                    self.ctl[new] = row
        for rid in [r for r in self.ctl if r not in valid]:
            self.ctl.pop(rid, None)
        for lid in list(self.leases):
            l = self.leases[lid]
            l["robot_id"] = legacy.get(l["robot_id"], l["robot_id"])
            if l["robot_id"] not in valid:
                self.leases.pop(lid, None)
        for rid in list(self.epochs):
            if rid not in valid:
                self.epochs.pop(rid, None)
        for rid in valid:
            self.ctl.setdefault(rid, self._blank())

    def state_of(self, rid: str) -> str:
        return self.ctl[rid]["state"]

    def view(self, rid: str) -> Json:
        c = self.ctl[rid]
        state = c["state"]
        robot = self.eng.robots.get(rid)
        controllable = bool(robot and robot.klass in ("inpipe", "outrig") and robot.mode not in ("WORKING", "FAILED", "VERIFYING"))
        why_not = "robot is not drivable right now"
        if robot and robot.klass not in ("inpipe", "outrig"):
            why_not = "manual_control_not_supported: this robot type has no manual drive"
        elif robot and robot.mode == "WORKING":
            why_not = "robot_busy: a repair action is in progress"
        if controllable and state == "AUTONOMOUS" and robot.battery < MIN_MANUAL_BATTERY:
            controllable = False
            why_not = battery_refusal(robot, robot.mode == "DOCKED")
        authority = "HUMAN" if state == "MANUAL" else ("STOP" if state == "SAFE_HOLD" else "AUTO")
        return {
            "authority": authority,
            "controller_state": state,
            "controllable": controllable,
            "uncontrollable_reason": None if controllable else why_not,
            "lease_id": c["lease_id"],
            "lease_epoch": float(c["epoch"]),
            "holder": c["principal_id"],
            "facing": 1,
            "velocity_m_s": float(c.get("velocity_m_s", 0.0)),
            "lamp": bool(c.get("lamp", False)),
            "last_applied_seq": float(c.get("last_command_seq", 0)),
            "last_reason": (
                "deadman_timeout" if c.get("hold_reason") == "deadman"
                else "lease_expired" if c.get("hold_reason") == "expired"
                else "operator_release" if c.get("hold_reason") == "released"
                else c.get("hold_reason")
                if c.get("hold_reason") in (
                    "operator_release", "deadman_timeout", "lease_expired", "client_hidden", "client_disconnect",
                    "link_lost", "safety_interlock", "low_battery", "operator_stop", "safe_hold_timeout", "resume_blocked"
                )
                else None
            ),
            "next_node": None,
            "junction": (self.stop_info.get(rid) or {}).get("junction") if state == "MANUAL" else None,
            "stopped_reason": (self.stop_info.get(rid) or {}).get("reason") if state == "MANUAL" else None,
            "stopped_message": (self.stop_info.get(rid) or {}).get("message") if state == "MANUAL" else None,
            "tools": [{"id": "lamp", "label": "Lamp", "available": True}],
            "last_scan": None,
            "odometer_m": float(c.get("odometer_m", 0.0)),
        }

    # ---- command handlers (called by the command bus, single-writer) ----
    def acquire(self, a: Json, principal: str, cmd_id: str) -> tuple[bool, str, Json]:
        eng = self.eng
        rid = a["robot_id"]
        alias = {"c_01": "IR-01", "c_02": "IR-02", "o_01": "OR-01"}
        if rid in alias and alias[rid] in eng.robots:
            rid = alias[rid]
            a["robot_id"] = rid
        robot = eng.robots.get(rid)
        if not robot:
            return False, "unknown_robot", {}
        if robot.klass not in ("inpipe", "outrig"):
            return False, "manual_control_not_supported", {}
        c = self.ctl[rid]
        if c["state"] in ("LEASE_PENDING", "MANUAL"):
            lease = self.leases.get(c["lease_id"])
            if lease and lease["principal_id"] == principal:  # idempotent re-acquire by the holder
                self._renew(lease)
                return True, "", self._ack(lease)
            return False, "lease_conflict: another operator already holds this robot", {}
        if c["state"] == "SAFE_HOLD":
            return False, "robot_in_safe_hold: the robot is settling after the last session, retry in a moment", {}
        if robot.active and robot.active["type"] == "action" and robot.mode == "WORKING":
            return False, "robot_busy: a repair action is in progress", {}
        if robot.battery < MIN_MANUAL_BATTERY:
            return False, battery_refusal(robot, robot.mode == "DOCKED"), {}
        if robot.klass == "inpipe" and robot.segment_id is None:
            return False, "robot_signal_unavailable: this crawler is not inside a pipe segment", {}
        self.epochs[rid] = self.epochs.get(rid, 0) + 1
        lid = eng.forced_ids.get(cmd_id) or new_uuid()
        now = eng.wall_time()
        lease = {"lease_id": lid, "run_id": eng.run_id, "robot_id": rid, "principal_id": principal, "connection_id": a.get("connection_id"),
                 "epoch": self.epochs[rid], "status": "pending", "granted_tick": eng.tick, "granted_at": now,
                 "last_heartbeat": now, "expires_at": now + eng.cfg.lease_ttl_s, "last_command_seq": 0, "ended_reason": None,
                 "ttl_s": eng.cfg.lease_ttl_s, "deadman_s": eng.cfg.deadman_s}
        self.leases[lid] = lease
        self.dirty.add(lid)
        c.update({"state": "LEASE_PENDING", "lease_id": lid, "principal_id": principal, "epoch": lease["epoch"],
                  "last_command_seq": 0, "intent": None, "junction": None, "hold_reason": None})
        self.stop_info.pop(rid, None)
        self.pending_dock.pop(rid, None)
        robot.held = True          # freeze the autonomous executor immediately (no teleporting, no overlap)
        robot.speed = 0.0
        robot.v = 0.0
        self._suspend_mission(rid)
        eng.navigation.manual_begin(rid)
        eng.emit_internal("robot.control.granted", rid, {"robot_id": rid, "lease_id": lid, "epoch": lease["epoch"], "principal_id": principal,
                                                         "state": "LEASE_PENDING", "ttl_s": lease["ttl_s"], "deadman_s": lease["deadman_s"],
                                                         "topology_revision": eng.topology_revision},
                          actor_type="operator", actor_id=principal, command_id=cmd_id)
        return True, "", self._ack(lease)

    def _ack(self, lease: Json) -> Json:
        rid = lease["robot_id"]
        ttl = float(lease["ttl_s"])
        deadman = float(lease["deadman_s"])
        vmax = self.max_speed_for(rid)
        limits = {
            "max_speed_m_s": vmax,
            "max_accel_m_s2": 0.6,
            "intent_ttl_ms": (20.0, 250.0),
            "max_intent_rate_hz": 20.0,
        }
        return {
            "accepted": True,
            "robot_id": rid,
            "lease_id": lease["lease_id"],
            "epoch": lease["epoch"],
            "lease_epoch": float(lease["epoch"]),
            "state": self.ctl[rid]["state"],
            "granted_world_version": float(getattr(self.eng, "world_version", self.eng.tick)),
            "expires_in_ms": ttl * 1000.0,
            "heartbeat_interval_ms": min(ttl * 1000.0 / 3.0, deadman * 1000.0 / 2.0),      # a client that heartbeats at this interval must never trip the deadman
            "deadman_ms": deadman * 1000.0,
            "limits": limits,
            "topology_revision": str(self.eng.topology_revision),
            "control": self.view(rid),
            "ttl_s": ttl,
            "deadman_s": deadman,
            "expires_at": lease["expires_at"],
            "max_speed_m_s": vmax,
        }

    def max_speed_for(self, rid: str) -> float:
        r = self.eng.robots.get(rid)
        return float(self.eng.cfg.manual_max_speed_outrig_m_s if r is not None and r.klass == "outrig" else self.eng.cfg.manual_max_speed_m_s)

    def _renew(self, lease: Json) -> None:
        now = self.eng.wall_time()
        lease["last_heartbeat"] = now
        lease["expires_at"] = now + lease["ttl_s"]
        self.dirty.add(lease["lease_id"])

    def _live(self, lid: str, principal: str) -> tuple[Json | None, str]:
        lease = self.leases.get(lid)
        if not lease:
            return None, "lease_unknown: there is no active control session (it may have timed out); take control again"
        if lease["status"] not in ("pending", "active"):
            end = lease.get("ended_reason") or lease["status"]
            return None, f"lease_{lease['status']}: {_LEASE_END_TEXT.get(end, 'the control session has ended')}; take control again"
        if lease["principal_id"] != principal:
            return None, "lease_unknown: there is no active control session (it may have timed out); take control again"       # do not reveal that it exists
        return lease, ""

    def heartbeat(self, a: Json, principal: str) -> tuple[bool, str, Json]:
        lease, why = self._live(a["lease_id"], principal)
        if not lease:
            return False, why, {}
        self._renew(lease)
        rid = lease["robot_id"]
        ttl = float(lease["ttl_s"])
        return True, "", {
            "accepted": True,
            "expires_in_ms": ttl * 1000.0,
            "controller_state": self.ctl[rid]["state"],
            "lease_id": lease["lease_id"],
            "robot_id": rid,
        }

    def release(self, a: Json, principal: str, cmd_id: str) -> tuple[bool, str, Json]:
        lease, why = self._live(a["lease_id"], principal)
        if not lease:
            return False, why, {}
        rid = lease["robot_id"]
        self.end_lease(lease["lease_id"], a.get("reason") or "operator_release", cmd_id, actor="operator", actor_id=principal)
        return True, "", {
            "accepted": True,
            "robot_id": rid,
            "controller_state": self.ctl[rid]["state"],
            "resumed": "mission",
            "control": self.view(rid),
            "lease_id": lease["lease_id"],
            "state": "SAFE_HOLD",
        }

    def drive(self, a: Json, principal: str, cmd_id: str) -> tuple[bool, str, Json]:
        eng = self.eng
        lease, why = self._live(a["lease_id"], principal)
        if not lease:
            return False, why, {}
        rid = lease["robot_id"]
        c = self.ctl[rid]
        robot = eng.robots[rid]
        if c["state"] != "MANUAL":
            return False, "lease_not_active: robot is still acquiring (retry)", {}
        if a.get("lease_epoch") is not None and a["lease_epoch"] != lease["epoch"]:
            return False, "stale_lease_epoch: this control session was replaced by a newer one; take control again", {}
        if a["command_seq"] <= c["last_command_seq"]:
            return False, "command_seq_not_increasing: an older command arrived after a newer one (ignored)", {}
        if a["topology_revision"] != eng.topology_revision:
            return False, "topology_revision_mismatch: the facility layout changed; reload and try again", {}
        if robot.battery < MIN_MANUAL_BATTERY:
            return False, battery_refusal(robot, False), {}
        ex = a.get("selected_exit_segment_id")
        if ex and c["junction"] is not None and ex not in c["junction"]:
            return False, "invalid_exit_segment: that road is not an option at this junction", {}
        if ex and ex not in eng.graph.edges:
            return False, "invalid_exit_segment: unknown pipe segment", {}
        c["last_command_seq"] = a["command_seq"]
        lease["last_command_seq"] = a["command_seq"]
        lease["last_heartbeat"] = eng.wall_time()   # drive input also proves operator presence
        lease["expires_at"] = lease["last_heartbeat"] + lease["ttl_s"]
        self.dirty.add(lease["lease_id"])
        ticks = max(1, int(round(a.get("duration_ms", 100.0) / 1000.0 * eng.clock.speed / eng.cfg.dt_s)))
        if a.get("graph_revision") and a["graph_revision"] != eng.navigation.graph_revision:
            return False, "stale_graph_revision: the navigation graph changed; re-read /navigation/graphs", {}
        c["intent"] = {"throttle": a.get("throttle", 0.0), "steer": a.get("steer", 0.0), "brake": bool(a.get("brake", False)), "exit": ex,
                       "branch": a.get("branch"), "ticks_left": ticks}

        # Authoritative physical robot actuation in MuJoCo
        manipulation_ack = {}
        if hasattr(eng, "mujoco_runtime") and eng.mujoco_runtime is not None:
            # The rover BASE pose is owned by the engine (nav grid + traffic guard + lease integration in manual_step). The MuJoCo arm sandbox
            # used to overwrite robot.pos/yaw here from its own hard-coded frame (teleporting the rover to [12, 2, 0.15] through racks);
            # it must never write the authoritative pose. Only arm / gripper actuation below goes to MuJoCo.

            # Per-robot arm + gripper (engine/robots/manipulator.py): every OUTRIG has its own independent arm state; targets are set here and the
            # arm moves on the engine tick. Crawlers get a plain refusal.
            manipulation_ack.update(eng.manipulators.apply(rid, a, principal))

            # In-pipe deposit clearing tool action: crawlers only, on the pipe segment the crawler is actually inside
            if a.get("action") == "clean_deposit":
                seg = getattr(robot, "segment_id", None)
                if robot.klass != "inpipe" or not seg:
                    manipulation_ack["rejected"] = {"reason": "no_brush: deposit clearing needs a crawler inside a pipe segment"}
                else:
                    fouling, cleared = eng.mujoco_runtime.clean_inpipe_deposit(0.5)
                    manipulation_ack["deposit_cleaning"] = {"fouling_pct": fouling, "cleared": cleared, "segment_id": seg}
                    if cleared:
                        # manual drive grants MOVEMENT (and the sandbox brush), never tool authority over the plant: healing a fouled segment is a
                        # mission step (capability registry: brush tool, reach, resource lock, battery, approval policy). Nothing is applied here.
                        manipulation_ack["plant_effect"] = {"ok": False, "reason": "tool_authority_required: clearing a plant deposit is a mission step, not a manual drive action"}

        pose_data = {
            "segment_id": str(getattr(robot, "segment_id", None) or "floor_corridor"),
            "s_m": float(getattr(robot, "s_m", 0.0) or 0.0),
            "speed_m_s": float(getattr(robot, "speed", 0.0) or 0.0),
            "velocity_m_s": float(getattr(robot, "v", 0.0) or 0.0),
            "facing": 1,
            "position_xyz_m": tuple(float(x) for x in robot.pos),
        }
        return True, "", {
            "accepted": True,
            "robot_id": rid,
            "lease_epoch": float(lease["epoch"]),
            "applied_seq": float(a["command_seq"]),
            "controller_state": c["state"],
            "world_version": float(getattr(eng, "world_version", eng.tick)),
            "pose": pose_data,
            "stopped_reason": (self.stop_info.get(rid) or {}).get("reason"),
            "stopped_message": (self.stop_info.get(rid) or {}).get("message"),
            "junction": (self.stop_info.get(rid) or {}).get("junction"),
            "odometer_m": float(c.get("odometer_m", 0.0)),
            "lease_id": lease["lease_id"],
            "applies_from_tick": eng.tick + 1,
            "ticks": ticks,
            "manipulation": manipulation_ack,
        }

    def end_lease(self, lid: str, reason: str, cmd_id: str | None = None, actor: str = "system", actor_id: str | None = None) -> None:
        eng = self.eng
        lease = self.leases.get(lid)
        if not lease or lease["status"] not in ("pending", "active"):
            return
        rid = lease["robot_id"]
        lease["status"] = "released" if reason in ("released", "operator_release") else "ended"
        lease["ended_reason"] = reason
        self.dirty.add(lid)
        c = self.ctl[rid]
        robot = eng.robots[rid]
        c.update({"state": "SAFE_HOLD", "intent": None, "hold_since": eng.tick, "hold_reason": reason, "junction": None})
        eng.navigation.manual_end(rid)
        robot.v = 0.0
        robot.speed = 0.0
        robot.held = True
        robot.mode = "SAFE_HOLD"
        eng.emit_internal("robot.control", rid, {"robot_id": rid, "lease_id": lid, "event": reason, "state": "SAFE_HOLD", "reason": reason},
                          actor_type=actor, actor_id=actor_id, command_id=cmd_id)

    # ---- suspend / resume of the autonomous mission ---------------------
    def _suspend_mission(self, rid: str) -> None:
        eng = self.eng
        robot = eng.robots[rid]
        m = eng.missions.active_mission(rid)
        robot.cancel_active()
        if m:
            rt = eng.missions.rt[m["id"]]
            st = m["steps"][rt["idx"]]
            if st["status"] == "active":
                st["status"] = "pending"
                st["result"] = "suspended: manual control"
            eng.missions.dirty.add(m["id"])

    def _resume(self, rid: str) -> None:
        eng = self.eng
        robot = eng.robots[rid]
        robot.held = False
        m = eng.missions.active_mission(rid)
        if m:
            st = m["steps"][eng.missions.rt[m["id"]]["idx"]]
            st.pop("result", None)
            eng.missions._start_step(m, robot)
        else:
            robot.mode = "DOCKED" if eng.missions._at_home(robot) else "IDLE"

    # ---- per tick -------------------------------------------------------
    def on_tick(self) -> None:
        eng = self.eng
        for rid in sorted(self.ctl):
            c = self.ctl[rid]
            robot = eng.robots[rid]
            st = c["state"]
            if st == "LEASE_PENDING":
                c["state"] = "MANUAL"
                lease = self.leases[c["lease_id"]]
                lease["status"] = "active"
                self.dirty.add(lease["lease_id"])
                robot.mode = "TRAVELING"
                eng.emit_internal("robot.control", rid, {"robot_id": rid, "lease_id": c["lease_id"], "event": "active", "state": "MANUAL"},
                                  actor_type="operator", actor_id=c["principal_id"])
            elif st == "MANUAL":
                it = c["intent"]
                thr, brake, ex = 0.0, False, None
                if it and it["ticks_left"] > 0:
                    thr, brake, ex = it["throttle"], it["brake"], it["exit"]
                    if ex is None and c["junction"] and abs(it["steer"]) >= 0.5:
                        ex = self._pick_exit(robot, c["junction"], it["steer"])
                    it["ticks_left"] -= 1
                else:
                    c["intent"] = None
                    brake = True
                if robot.klass == "outrig" and eng.navigation.ext.nodes and (it is None or it.get("tube", True)):
                    branch = it.get("branch") if it else None
                    info = eng.navigation.manual_step(robot, eng.cfg.dt_s, thr, it["steer"] if it else 0.0, brake, branch, self.max_speed_for(rid),
                                                      eng.cfg.manual_accel_m_s2, eng.cfg.manual_brake_m_s2,
                                                      lambda p, y, _r=robot: eng.traffic.manual_ok(_r, p, y), hands_off=(it is None))
                    if info.get("tube") is False and not info.get("destination"):
                        # off the exterior graph (e.g. inside a service bay): the guarded free-steering controller keeps the rover safe
                        info = robot.manual_step(eng.cfg.dt_s, eng.graph, thr, brake, ex, self.max_speed_for(rid),
                                                 eng.cfg.manual_accel_m_s2, eng.cfg.manual_brake_m_s2, eng.locks.blocked_edges(),
                                                 steer=it["steer"] if it else 0.0, guard=lambda p, y, _r=robot: eng.traffic.manual_ok(_r, p, y))
                else:
                    info = robot.manual_step(eng.cfg.dt_s, eng.graph, thr, brake, ex, self.max_speed_for(rid),
                                             eng.cfg.manual_accel_m_s2, eng.cfg.manual_brake_m_s2, eng.locks.blocked_edges(),
                                             steer=it["steer"] if it else 0.0,
                                             guard=(lambda p, y, _r=robot: eng.traffic.manual_ok(_r, p, y)) if robot.klass == "outrig" else None)
                c["junction"] = info["junction"]
                self._note_stop(rid, robot, info, moving_cmd=(it is not None and abs(it["throttle"]) > 0.05 and not brake))
                robot.mode = "TRAVELING"
                if robot.battery < MIN_MANUAL_BATTERY:
                    self.end_lease(c["lease_id"], "battery_depleted")
            elif st == "SAFE_HOLD":
                if eng.tick - (c["hold_since"] or 0) >= HOLD_TICKS:
                    c.update({"state": "AUTONOMOUS", "lease_id": None, "principal_id": None, "hold_since": None, "intent": None})
                    self._resume(rid)
                    who = self.pending_dock.pop(rid, None)
                    if who is not None:
                        eng.missions.create({"robot_id": rid, "kind": "return", "target_id": robot.home_id, "title": f"Return {rid} to its dock"}, who,
                                            f"dock-{rid}-{eng.tick}")
                    eng.emit_internal("robot.control", rid, {"robot_id": rid, "event": "resumed", "state": "AUTONOMOUS"}, actor_type="system")

    # ---- why the robot is not moving / what the operator can choose ------------------------
    _STOP_TEXT = {
        "junction_select_exit": "Junction ahead: hold left or right to choose the road, then keep the throttle down.",
        "dead_end": "Dead end: reverse to turn back.",
        "obstacle": "Blocked by a rack, wall or another robot. Reverse or steer away.",
        "wall": "Blocked by a wall or rack. Reverse or steer away.",
        "off_graph": "The rover is off the driving lanes. Use the route panel to send it back to a road.",
        "reverse_limit": "End of the lane behind the rover.",
    }

    def _note_stop(self, rid: str, robot, info: Json, moving_cmd: bool) -> None:
        reason = info.get("stopped_reason")
        if not reason or not moving_cmd:
            self.stop_info.pop(rid, None)
            return
        self.stop_info[rid] = {"reason": reason, "message": self._STOP_TEXT.get(reason, reason), "junction": self._junction_info(rid, robot, info)}

    def _junction_info(self, rid: str, robot, info: Json) -> Json | None:
        """JunctionInfo wire shape for a stop at a junction (crawler: pipe exits; rover: legal road branches), else None."""
        eng = self.eng
        opts = info.get("junction")
        if not opts:
            return None
        try:
            if robot.klass == "outrig":
                st = eng.navigation.tube.st.get(rid) or {}
                e = eng.navigation.ext.edges.get(st.get("edge"))
                node = (e["b"] if st.get("dir", 1) == 1 else e["a"]) if e else "junction"
                branches = info.get("branches") or {}
                bearing = {"left": -90.0, "straight": 0.0, "right": 90.0}
                exits = [{"segment_id": branches[k], "label": k.capitalize(), "passable": True, "bearing_deg": bearing.get(k, 0.0)} for k in ("left", "straight", "right") if k in branches]
                return {"node_id": node, "node_label": str(node), "distance_m": 0.0, "exits": exits, "selected": None}
            seg = robot.segment_id
            g = eng.graph
            at_end = (robot.s_m or 0.0) > 0.5 * g.length(seg)
            node = g.node_at(seg, at_end)
            hx, hz = math.sin(robot.yaw), math.cos(robot.yaw)
            exits = []
            for o in opts:
                e2 = g.edge(o)
                node_start = e2["from"] == node
                t = g.tangent(o, 0.0 if node_start else g.length(o))
                tx, tz = (t[0], t[2]) if node_start else (-t[0], -t[2])
                exits.append({"segment_id": o, "label": o, "passable": True,
                              "bearing_deg": round(math.degrees(math.atan2(hx * tz - hz * tx, hx * tx + hz * tz)), 1)})
            return {"node_id": node, "node_label": str(node), "distance_m": 0.0, "exits": exits, "selected": None}
        except Exception:      # noqa: BLE001 - a hint for the operator must never break the control tick
            return None

    # ---- operator "send to dock" ---------------------------------------------------------
    def send_to_dock(self, rid: str, principal: str, cmd_id: str) -> tuple[bool, str, Json]:
        """Route the robot to its home dock (a normal `return` mission). Under manual control the lease is released first and the return starts
        as soon as the robot is back under autonomous authority. A robot with an empty pack cannot drive: it is queued for recovery."""
        eng = self.eng
        robot = eng.robots.get(rid)
        if not robot:
            return False, "unknown_robot", {}
        c = self.ctl[rid]
        if eng.missions._at_home(robot) and c["state"] == "AUTONOMOUS":
            if robot.active is None and robot.mode in ("IDLE", "NEEDS_CHARGE"):
                robot.mode = "DOCKED"
            return True, "", {"robot_id": rid, "result": "already_docked", "battery_pct": round(robot.battery, 1)}
        if c["state"] in ("LEASE_PENDING", "MANUAL"):
            lease = self.leases.get(c["lease_id"])
            if lease and lease["principal_id"] != principal:
                return False, "lease_conflict: another operator already holds this robot", {}
            self.end_lease(c["lease_id"], "operator_release", cmd_id, actor="operator", actor_id=principal)
            c = self.ctl[rid]
        if c["state"] == "SAFE_HOLD":
            self.pending_dock[rid] = principal
            return True, "", {"robot_id": rid, "result": "queued_after_hold"}
        ok, why, m = eng.missions.create({"robot_id": rid, "kind": "return", "target_id": robot.home_id, "title": f"Return {rid} to its dock"}, principal, cmd_id)
        if not ok:
            return False, why, {}
        return True, "", {"robot_id": rid, "result": "returning", "mission_id": m["id"]}

    def _pick_exit(self, robot, options: list, steer: float) -> str | None:
        eng = self.eng
        best, bs = None, -1e9
        hx, hz = math.sin(robot.yaw), math.cos(robot.yaw)
        for o in options:
            e = eng.graph.edge(o)
            node_start = e["from"] == eng.graph.node_at(robot.segment_id, (robot.s_m or 0) > 0.5 * eng.graph.length(robot.segment_id))
            t = eng.graph.tangent(o, 0.0 if node_start else eng.graph.length(o))
            tx, tz = (t[0], t[2]) if node_start else (-t[0], -t[2])
            right = hx * tz - hz * tx   # +ve: exit bends to the right of travel
            sc = right * (1 if steer > 0 else -1)
            if sc > bs:
                best, bs = o, sc
        return best

    # ---- wall-clock monitor (deadman / TTL). Returns [(lease_id, reason)] for the engine to apply as logged commands
    def due_expiries(self, now: float) -> list[tuple[str, str]]:
        out = []
        for lid, lease in self.leases.items():
            if lease["status"] not in ("pending", "active"):
                continue
            if now - lease["last_heartbeat"] > lease["deadman_s"]:
                out.append((lid, "deadman_timeout"))
            elif now > lease["expires_at"]:
                out.append((lid, "lease_expired"))
        return sorted(out)

    def active_lease_ids(self) -> list:
        return sorted(l for l, v in self.leases.items() if v["status"] in ("pending", "active"))
