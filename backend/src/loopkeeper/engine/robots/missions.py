"""Mission engine: validated creation (backend.md section 13), per-robot FIFO queues, step execution on the
fixed tick, idempotent transitions, effects applied to the plant ONLY on ActionCompleted."""
from __future__ import annotations

import math
from typing import Any, TYPE_CHECKING

from ..geometry import v_dist
from ..util import Json, clamp, clone, round_to
from .traffic import BACKOFF_AFTER_S
from .service_controller import StrainerExchange
from .actions import ACTIONS, PLANT_COMMANDS, ActionSpec, tool_matches, validate_step_args
from .actor import CRAWLER_SPEED, DRAIN_MOVE, OUTRIG_SPEED, RobotActor

if TYPE_CHECKING:  # pragma: no cover
    from ..core import Engine

KINDS_BY_CLASS = {"inpipe": ("inspect", "clear", "return"), "outrig": ("service", "return")}
TERMINAL_MODES = ("FAILED", "ABORTED", "BLOCKED", "NEEDS_CHARGE")
TOW_AFTER_S = 900.0              # sim seconds a rover with an empty battery may stay stranded before the maintenance crew tows it to its dock
# preconditions that can clear by themselves: the step waits (robot BLOCKED) up to cfg.blocked_timeout_s
WAITABLE = ("crawler_inside_segment", "racks_not_cordoned", "segment_locked", "route_blocked", "isolation_busy")


class MissionManager:
    def __init__(self, eng: "Engine"):
        self.eng = eng
        self.missions: dict[str, Json] = {}
        self.rt: dict[str, Json] = {}
        self.stranded_since: dict[str, int] = {}
        self.queues: dict[str, list] = {}
        self.seq = 0
        self.applied_effects: set = set()
        self.emitted: set = set()
        self.new_effects: list = []        # effect keys to persist with the next commit
        self.dirty: set = set()
        self._ret_cache: dict[str, tuple] = {}

    # ------------------------------------------------------------------ state
    def to_state(self) -> Json:
        return {"missions": self.missions, "rt": self.rt, "queues": self.queues, "seq": self.seq,
                "applied_effects": sorted(self.applied_effects), "emitted": sorted(self.emitted)}

    def load_state(self, st: Json) -> None:
        self.missions = clone(st["missions"])
        self.rt = clone(st["rt"])
        self.queues = clone(st["queues"])
        self.seq = st["seq"]
        self.applied_effects = set(st["applied_effects"])
        self.emitted = set(st["emitted"])

    # ------------------------------------------------------------------ helpers
    def _robot(self, rid) -> RobotActor | None:
        if rid in self.eng.robots:
            return self.eng.robots[rid]
        alias = {"c_01": "IR-01", "c_02": "IR-02", "o_01": "OR-01"}
        if rid in alias and alias[rid] in self.eng.robots:
            return self.eng.robots[alias[rid]]
        return None

    def active_mission(self, rid: str) -> Json | None:
        q = self.queues.get(rid) or []
        if q:
            m = self.missions.get(q[0])
            if m and self.rt[m["id"]]["state"] == "running":
                return m
        return None

    def robot_busy_with(self, rid: str) -> str | None:
        q = self.queues.get(rid) or []
        return q[0] if q else None

    def _resolve_segment(self, target_id: str, s_hint: float | None):
        eng = self.eng
        if target_id in eng.graph.edges:
            L = eng.graph.length(target_id)
            if s_hint is None:
                f = (eng.assets_truth().get(target_id) or {}).get("fault") or {}
                s_hint = f.get("location_s_m", L / 2)
            return target_id, clamp(float(s_hint), 0.0, L)
        a = eng.asset_index.get(target_id)
        if a and a.get("edge_id"):
            L = eng.graph.length(a["edge_id"])
            return a["edge_id"], clamp(float(s_hint if s_hint is not None else a.get("s_m", L / 2)), 0.0, L)
        return None

    def _service_pose(self, target_id: str):
        eng = self.eng
        a = eng.asset_index.get(target_id)
        if a:
            p = a.get("service_xyz_m") or a["position_xyz_m"]
            return eng.nav.snap(p)
        if target_id in eng.graph.edges:
            e = eng.graph.edge(target_id)
            z = e.get("zone_id")
            for v in eng.topo["assets"]:
                if v["type"] == "valve" and v.get("zone_id") == z and "isolation" in v.get("name", "").lower() and v.get("service_xyz_m"):
                    return eng.nav.snap(v["service_xyz_m"])
            p = eng.graph.position(target_id, eng.graph.length(target_id) / 2)
            return eng.nav.snap([p[0], 0.0, p[2]])
        return None

    def _zone_edges(self, valve_id: str) -> list:
        a = self.eng.asset_index.get(valve_id)
        if not a:
            return []
        z = a.get("zone_id")
        edges = [e["id"] for e in self.eng.topo["edges"] if z and e.get("zone_id") == z]
        if a.get("edge_id") and a["edge_id"] not in edges:
            edges.append(a["edge_id"])
        return edges

    # ------------------------------------------------------------------ planning
    def default_plan(self, robot: RobotActor, kind: str, target_id: str, p: Json) -> tuple[list | None, str | None]:
        eng = self.eng
        if kind == "return":
            return [{"command": "return_to_port" if robot.klass == "inpipe" else "return_to_dock", "args": {}}], None
        if robot.klass == "inpipe":
            seg = self._resolve_segment(target_id, p.get("s_m"))
            if not seg:
                return None, "unknown_target"
            edge, s = seg
            steps = []
            if robot.mode == "DOCKED":
                steps.append({"command": "launch", "args": {}})
            if robot.mission_id is not None or robot.segment_id != edge or abs((robot.s_m or 0) - s) > 1.0 or robot.mode == "DOCKED":
                steps.append({"command": "move_to", "args": {"segment_id": edge, "s_m": round_to(s, 3)}})
            if kind == "inspect":
                steps.append({"command": "inspect", "args": {"gauge": p.get("gauge", "deposit")}})
            else:
                steps.append({"command": "brush_clear", "args": {"segment_id": edge, "s_m": round_to(s, 3),
                                                                   "max_torque_pct": p.get("max_torque_pct", 60)}})
            return steps, None
        # outrig service
        action = p.get("action")
        spec = ACTIONS.get(action or "")
        if not spec or spec.klass != "outrig" or action in ("isolate_valve", "reopen_valve", "navigate", "scan",
                                                            "fetch_tool", "return_to_dock"):
            return None, "service_action_required"
        main_tool = (spec.tools[0] if spec.tools else "valve actuator")
        arg_key = "segment_id" if action == "replace_section" else "target_id"
        steps = [{"command": "fetch_tool", "args": {"tool": main_tool}},
                 {"command": "navigate", "args": {"target_id": target_id}},
                 {"command": "scan", "args": {"target_id": target_id}}]
        iso = p.get("isolate_valve")
        if iso:
            if iso != target_id:
                steps.append({"command": "navigate", "args": {"target_id": iso}})
            steps.append({"command": "isolate_valve", "args": {"valve_id": iso}})
            if iso != target_id:
                steps.append({"command": "navigate", "args": {"target_id": target_id}})
        steps.append({"command": action, "args": {arg_key: target_id}})
        if iso:
            steps.append({"command": "pressure_test", "args": {"target_id": target_id, "hold_s": 15, "kpa": 280}})
            if iso != target_id:
                steps.append({"command": "navigate", "args": {"target_id": iso}})
            steps.append({"command": "reopen_valve", "args": {"valve_id": iso}})
        steps.append({"command": "return_to_dock", "args": {}})
        return steps, None

    def _label(self, cmd: str, args: Json, robot: RobotActor) -> str:
        t = args.get("target_id") or args.get("segment_id") or args.get("valve_id") or ""
        lab = (self.eng.asset_index.get(t) or {}).get("label") or (self.eng.graph.edges.get(t) or {}).get("label") or t
        home = (self.eng.asset_index.get(robot.home_id) or {}).get("label", robot.home_id)
        return {
            "launch": f"Pre-flight check · launch from {home}", "move_to": f"Travel to {lab} @ {args.get('s_m', 0):.1f} m",
            "inspect": f"Inspect ({args.get('gauge', 'general')})", "sample": "Take sample",
            "brush_clear": "Extend brush · clear deposit", "return_to_port": f"Return to {home}", "dock": "Dock",
            "navigate": f"Navigate to {lab} service pose", "scan": f"Scan {lab} (visual + thermal)",
            "fetch_tool": f"Fetch {args.get('tool', 'tool')}", "isolate_valve": f"Isolate {lab}",
            "replace_strainer": f"Replace {lab} basket", "service_valve": f"Service {lab}",
            "replace_section": f"Replace {lab} spool section", "clamp_accessible_leak": f"Clamp leak at {lab}",
            "pressure_test": "Pressure test at 1.5x operating", "reopen_valve": f"Re-open {lab}",
            "return_to_dock": "Return to charging bay",
        }.get(cmd, cmd)

    # ------------------------------------------------------------------ creation (preconditions, section 13)
    def create(self, args: Json, issuer: str, command_id: str) -> tuple[bool, str, Json | None]:
        eng = self.eng
        rid = args["robot_id"]
        robot = self._robot(rid)
        if not robot:
            return False, "unknown_robot", None
        rid = robot.id
        args["robot_id"] = rid
        kind = args["kind"]
        if kind not in KINDS_BY_CLASS[robot.klass]:
            return False, f"mission kind '{kind}' not valid for {robot.klass} robots", None
        if eng.control.state_of(rid) != "AUTONOMOUS":
            return False, "robot_under_manual_control", None
        if eng.physics_degraded() and kind != "return":
            return False, "physics_degraded", None
        if robot.battery < eng.cfg.battery_reserve_pct and kind != "return":
            return False, "battery_below_reserve", None
        target = args["target_id"]
        params = args.get("params") or {}
        if args.get("steps"):
            steps_in = [{"command": s["command"], "args": s.get("args") or {}, "label": s.get("label")} for s in args["steps"]]
        else:
            steps_in, err = self.default_plan(robot, kind, target, params)
            if err:
                return False, err, None
        # existence of the target entity
        if kind != "return" and target not in eng.asset_index and target not in eng.graph.edges:
            return False, "unknown_target", None
        # step whitelist + arg validation + approval + static reachability
        needs_approval = False
        needs_human = False
        zone_keys: list = []
        for s in steps_in:
            spec = ACTIONS.get(s["command"])
            if not spec:
                return False, f"not_whitelisted: {s['command']}", None
            if spec.klass != robot.klass:
                return False, f"{s['command']} not available to {robot.klass} robots", None
            err = validate_step_args(spec, s["args"])
            if err:
                return False, err, None
            for k, v in s["args"].items():
                if k in ("target_id", "valve_id", "segment_id") and v not in eng.asset_index and v not in eng.graph.edges:
                    return False, f"unknown_target: {v}", None
            if spec.tools and robot.klass == "outrig" and not tool_matches(" ".join(robot.hw.get("tools", [])), spec.tools):
                return False, f"tool_unavailable: {s['command']}", None
            if spec.tools and robot.klass == "inpipe" and not tool_matches(" ".join(robot.hw.get("tools", [])), spec.tools):
                return False, f"tool_unavailable: {s['command']}", None
            if s["command"] == "fetch_tool" and not tool_matches(" ".join(robot.hw.get("tools", [])), (s["args"].get("tool", "").lower(),)):
                return False, f"tool_unavailable: {s['args'].get('tool')}", None
            needs_approval = needs_approval or spec.requires_approval
            needs_human = needs_human or spec.authority_level == "L3"
            if s["command"] == "move_to":
                a = s["args"]
                if "segment_id" not in a or "s_m" not in a:
                    return False, "move_to requires segment_id and s_m", None
                why = eng.graph.why_not(a["segment_id"], robot.hw.get("min_bore_mm", 0), eng.locks.blocked_edges())
                if why:
                    return False, f"segment_not_reachable: {why}", None
            if s["command"] == "isolate_valve":
                zone_keys.append(("zone:" + str((eng.asset_index.get(s["args"].get("valve_id", ""), {}).get("zone_id") or s["args"].get("valve_id"))), True))
        if needs_approval:
            ok, why = self._approval_ok(args.get("approval_id"), args.get("incident_id"), human=needs_human)
            if not ok:
                return False, why, None
        # static feasibility of the INPIPE travel + battery (when the robot is free right now)
        if robot.klass == "inpipe" and kind != "return":
            first_move = next((s for s in steps_in if s["command"] == "move_to"), None)
            if first_move and not self.robot_busy_with(rid):
                a = first_move["args"]
                start = {"edge_id": robot.segment_id, "s": robot.s_m}
                rt = eng.graph.route(start, {"edge_id": a["segment_id"], "s": a["s_m"]}, min_bore_mm=robot.hw["min_bore_mm"],
                                     blocked=eng.locks.blocked_edges())
                if rt is None:
                    return False, "no_route: target unreachable for this crawler", None
                need = (rt.length * 2 / CRAWLER_SPEED) * DRAIN_MOVE * 1.2 + eng.cfg.battery_reserve_pct
                if robot.battery < need:
                    return False, "insufficient_battery_for_round_trip", None
        # resource locks (reserved at acceptance, released at mission end)
        mid = args.get("id") or f"m_{self.seq + 1:02d}"
        keys: list = []
        if kind != "return":
            keys.append((f"asset:{target}", True))
            seg = target if target in eng.graph.edges else (eng.asset_index.get(target) or {}).get("edge_id")
            z = (eng.graph.edges.get(seg) or {}).get("zone_id") if seg else None
            if robot.klass == "inpipe" and z:
                keys.append((f"zone:{z}", False))
            keys.extend(zone_keys)
        ok, why = eng.locks.try_acquire(keys, mid)
        if not ok:
            return False, f"resource_locked: {why}", None
        self.seq += 1
        steps = []
        for i, s in enumerate(steps_in):
            steps.append({"id": f"s{i + 1}", "command": s["command"], "label": s.get("label") or self._label(s["command"], s["args"], robot),
                          "status": "pending", "args": s["args"]})
        m = {"id": mid, "incident_id": args.get("incident_id") or "", "robot_id": rid, "kind": kind,
             "title": args.get("title") or f"{kind} {target}", "target_id": target, "status": "ASSIGNED", "progress": 0.0,
             "steps": steps, "opened_tick": eng.tick, "approval_id": args.get("approval_id"),
             "agent_task_id": args.get("agent_task_id"), "created_by": issuer, "command_id": command_id,
             "outcome": None, "failure_reason": None}
        self.missions[mid] = m
        self.rt[mid] = {"idx": 0, "state": "queued", "wait_since": None, "cleanup": False, "isolated": []}
        self.queues.setdefault(rid, []).append(mid)
        self.dirty.add(mid)
        self._emit_transition(m, robot, "created", causal=command_id)
        eng.emit_internal("robot.mission_assigned", mid, {"mission_id": mid, "robot_id": rid, "kind": kind, "target_id": target,
                                                          "incident_id": m["incident_id"]}, actor_type="system", command_id=command_id)
        return True, "", m

    def _approval_ok(self, approval_id, incident_id, human: bool = False) -> tuple[bool, str]:
        if not approval_id:
            return False, "approval_required"
        found = self.eng.track.find_approval(approval_id)
        if not found:
            return False, "approval_unknown"
        inc, ap = found
        if incident_id and inc["id"] != incident_id:
            return False, "approval_incident_mismatch"
        if ap["status"] != "approved":
            return False, f"approval_{ap['status']}"
        if human and not str(ap.get("decided_by") or "").startswith("operator:"):
            return False, "approval_not_human: high-impact (L3) work needs an approval decided by a person, not a veto-window auto-approval"
        return True, ""

    # ------------------------------------------------------------------ events
    def _emit_transition(self, m: Json, robot: RobotActor, tag: str, causal: str | None = None) -> None:
        key = f"{m['id']}:{self.rt[m['id']]['idx']}:{tag}:{m['status']}"
        if key in self.emitted:
            return
        self.emitted.add(key)
        self.eng.emit_internal("mission.transition", m["id"], {"mission": clone(m), "robot_mode": robot.mode, "tool": robot.tool},
                               actor_type="system", causal_parent_id=causal)

    # ------------------------------------------------------------------ abort / finish
    def abort(self, mid: str, reason: str, outcome: str = "aborted", cleanup: bool = True) -> tuple[bool, str]:
        m = self.missions.get(mid)
        if not m or m.get("closed_tick") is not None:
            return False, "unknown_or_closed_mission"
        rt = self.rt[mid]
        robot = self.eng.robots[m["robot_id"]]
        if rt.get("cleanup"):
            return True, "already_cleaning_up"
        was_running = rt["state"] == "running"
        for s in m["steps"]:
            if s["status"] == "active":
                s["status"] = "failed"
                s["result"] = reason
                s["ended_tick"] = self.eng.tick
            elif s["status"] == "pending":
                s["status"] = "skipped"
        m["failure_reason"] = reason
        m["pending_outcome"] = outcome
        if was_running:
            robot.cancel_active()
        # make-safe tail: re-open any valve this mission closed, then go home
        tail = []
        if cleanup and was_running and rt["isolated"] and robot.klass == "outrig":
            for valve in rt["isolated"]:
                tail.append({"command": "reopen_valve", "args": {"valve_id": valve}})
        if cleanup and was_running and robot.klass == "outrig" and tail:
            tail.append({"command": "return_to_dock", "args": {}})
            base = len(m["steps"])
            for i, s in enumerate(tail):
                m["steps"].append({"id": f"s{base + i + 1}", "command": s["command"], "label": "Make safe · " + self._label(s["command"], s["args"], robot),
                                   "status": "pending", "args": s["args"]})
            rt["cleanup"] = True
            rt["idx"] = base
            rt["state"] = "running"
            self.dirty.add(mid)
            self._emit_transition(m, robot, "cleanup")
            return True, "cleanup_started"
        self._close(m, robot, outcome)
        return True, ""

    def _close(self, m: Json, robot: RobotActor, outcome: str) -> None:
        eng = self.eng
        rt = self.rt[m["id"]]
        m["outcome"] = m.pop("pending_outcome", None) or outcome
        m["closed_tick"] = eng.tick
        m["progress"] = 1.0 if m["outcome"] == "completed" else m["progress"]
        # an unfinished isolation must not silently persist as a held lock owner: it is released with the mission,
        # but the edges stay isolated (physical truth) until a reopen step completes -> keep isolated_edges.
        eng.locks.release_owner(m["id"])
        q = self.queues.get(m["robot_id"], [])
        if m["id"] in q:
            q.remove(m["id"])
        if robot.mission_id == m["id"]:
            robot.mission_id, robot.task_id = None, None
        if m["outcome"] == "completed":
            at_home = self._at_home(robot)
            robot.mode = "DOCKED" if at_home else "IDLE"
            if at_home and m["kind"] == "return":
                robot.tool = None
            eng.navigation.note_served(robot.id)
        elif m["outcome"] == "failed":
            robot.mode = "BLOCKED" if "route" in (m.get("failure_reason") or "") or "segment_locked" in (m.get("failure_reason") or "") else "FAILED"
        else:
            robot.mode = "NEEDS_CHARGE" if m.get("failure_reason") == "battery_reserve" else "ABORTED"
        m["status"] = robot.mode
        rt["state"] = "done"
        self.dirty.add(m["id"])
        self._emit_transition(m, robot, "closed")

    def _at_home(self, robot: RobotActor) -> bool:
        eng = self.eng
        home = eng.asset_index.get(robot.home_id)
        if not home:
            return False
        if robot.klass == "inpipe":
            return robot.segment_id == home.get("edge_id") and abs((robot.s_m or 0) - home["s_m"]) < 0.25
        return v_dist([robot.pos[0], 0, robot.pos[2]], [home["position_xyz_m"][0], 0, home["position_xyz_m"][2]]) < 0.8

    # ------------------------------------------------------------------ per-tick execution
    def advance(self, dt: float) -> None:
        eng = self.eng
        degraded = eng.physics_degraded()
        for rid in sorted(eng.robots):
            robot = eng.robots[rid]
            cs = eng.control.state_of(rid)
            if cs == "MANUAL":
                continue                      # manual_step drives (and drains) the robot
            if cs != "AUTONOMOUS":
                robot.step(dt, eng.graph)     # LEASE_PENDING / SAFE_HOLD: frozen, drains idle battery only
                continue
            m = self.active_mission(rid)
            if m is not None:
                rt = self.rt[m["id"]]
                step = m["steps"][rt["idx"]]
                spec = ACTIONS[step["command"]]
                if step["status"] == "active" and degraded and spec.high_impact and spec.kind == "action":
                    if not rt.get("hold_note"):
                        rt["hold_note"] = True
                        step["result"] = "paused: physics degraded"
                        self.dirty.add(m["id"])
                        self._emit_transition(m, robot, "phys_hold")
                    robot.battery = max(0.0, robot.battery - 0.012 * dt)
                    continue
                if rt.get("hold_note"):
                    rt["hold_note"] = False
                    step.pop("result", None)
            if robot.klass == "outrig" and m is not None:
                rt0 = self.rt[m["id"]]
                st0 = m["steps"][rt0["idx"]]
                if st0["status"] == "active" and self._mechanical_strainer(st0, robot) and robot.active is not None:
                    self._run_service_controller(m, st0, robot)
                    if st0["status"] != "active":
                        continue
            if robot.klass == "outrig":
                pk = robot.peek_outrig(dt)
                other = eng.traffic.blocker(robot, *pk) if pk else None
                if other is not None:                  # traffic guard: never enter another robot's envelope
                    robot.hold_tick(dt)
                    replan = m is not None and eng.traffic.note_hold(robot, other, dt)
                    # stand-off: the lower-priority robot reverses out first; if it has no room behind it, the other one does 3 s later
                    if (m is not None and eng.traffic.blocked_s.get(rid, 0.0) >= BACKOFF_AFTER_S + (0.0 if not eng.navigation.outranks(robot.id, other.id) else 3.0)
                            and eng.traffic.blocked_by.get(rid) == other.id and not eng.traffic.yielding(robot, eng.sim_time)):
                        if self.back_off(robot, other):          # lower priority reverses out of a stand-off
                            continue
                    if replan:
                        rt = self.rt[m["id"]]
                        step = m["steps"][rt["idx"]]
                        if step["status"] == "active" and not step.get("waiting"):
                            robot.cancel_active()
                            eng.traffic.clear_hold(rid)
                            eng.traffic.stats["replans"] += 1
                            step["status"] = "pending"
                            rt["wait_since"] = None
                            self._wait_or_fail(m, step, robot, f"route_blocked: traffic ({other.id} in the way)")
                    continue
                eng.traffic.clear_hold(rid)
            finished = robot.step(dt, eng.graph)
            if m is None:
                # a rover that failed/ran dry away from its dock must not stay stranded: queue the safe return while it still has charge
                if (robot.klass == "outrig" and robot.mode in ("FAILED", "NEEDS_CHARGE", "ABORTED") and robot.battery > 0.5 and not self.queues.get(rid)
                        and not self._at_home(robot) and robot.active is None):
                    self._auto_return(robot)
                self._maybe_tow(robot)
                self._start_next(rid, robot)
                continue
            rt = self.rt[m["id"]]
            step = m["steps"][rt["idx"]]
            if step.get("waiting"):
                self._retry_wait(m, step, robot)
                continue
            if step["status"] == "active":
                m["progress"] = round_to((rt["idx"] + robot.progress()) / len(m["steps"]), 4)
                if finished or (not robot.busy and ACTIONS[step["command"]].kind in ("instant",)):
                    self._finish_step(m, step, robot)
                elif not finished and ACTIONS[step["command"]].kind == "move":
                    self._check_route_still_ok(m, step, robot)
                if m.get("closed_tick") is None and rt["state"] == "running" and step["status"] == "active":
                    self._battery_guard(m, robot)
        self._advance_routine_patrols()

    def _advance_routine_patrols(self) -> None:
        """Autonomous fleet condition monitoring: periodic routine L0 inspection patrols so the fleet
        maintains active sensor coverage, while keeping reserve robots ready for incident response."""
        eng = self.eng
        if eng.replay or eng.paused or eng.physics_degraded():
            return
        if eng.track.open_incidents():
            return

        active_inpipe = 0
        active_outrig = 0
        for rid, r in eng.robots.items():
            m = self.active_mission(rid)
            if m is not None or r.mode not in ("DOCKED", "IDLE"):
                if r.klass == "inpipe":
                    active_inpipe += 1
                else:
                    active_outrig += 1

        # Maintain 1 routine crawler scan
        if active_inpipe == 0 and eng.tick >= getattr(self, "_next_inpipe_patrol_tick", 25):
            passable = [e["id"] for e in eng.topo["edges"] if e.get("robot_passable")]
            candidates = ["IR-02", "IR-04", "IR-08"]
            for rid in candidates:
                r = eng.robots.get(rid)
                if r and r.mode == "DOCKED" and r.battery >= 85.0 and not self.queues.get(rid):
                    if not eng.locks.holder_of(f"robot:{rid}"):
                        target = passable[0] if passable else "p_10"
                        L = eng.graph.length(target)
                        s_target = round_to(L * 0.45, 2)
                        steps = [
                            {"command": "launch", "args": {}, "label": f"Pre-flight check · launch {rid}"},
                            {"command": "move_to", "args": {"segment_id": target, "s_m": s_target}, "label": f"Travel to {target} @ {s_target} m"},
                            {"command": "inspect", "args": {"gauge": "deposit"}, "label": "L0 ultrasonic condition scan"},
                            {"command": "return_to_port", "args": {}, "label": f"Return {rid} to port"},
                            {"command": "dock", "args": {}, "label": f"Dock {rid} at charging station"},
                        ]
                        self.create({
                            "robot_id": rid,
                            "kind": "inspect",
                            "target_id": target,
                            "title": f"Routine condition scan · {rid}",
                            "steps": steps,
                        }, "supervisor:sen_02", f"sys-patrol-{rid}-{eng.tick}")
                        self._next_inpipe_patrol_tick = eng.tick + 180
                        break

        # Maintain 1 routine OUTRIG scan
        if active_outrig == 0 and eng.tick >= getattr(self, "_next_outrig_patrol_tick", 35):
            facility_targets = [a["id"] for a in eng.topo["assets"] if a.get("type") in ("cdu", "strainer", "chiller")]
            candidates = ["OR-02", "OR-04"]
            for rid in candidates:
                r = eng.robots.get(rid)
                if r and r.mode == "DOCKED" and r.battery >= 85.0 and not self.queues.get(rid):
                    if not eng.locks.holder_of(f"robot:{rid}"):
                        target = facility_targets[0] if facility_targets else "cdu_01"
                        steps = [
                            {"command": "navigate", "args": {"target_id": target}, "label": f"Navigate to {target} inspection pose"},
                            {"command": "scan", "args": {"target_id": target}, "label": f"Scan {target} visual & thermal sensors"},
                            {"command": "return_to_dock", "args": {}, "label": "Return to dock"},
                        ]
                        self.create({
                            "robot_id": rid,
                            "kind": "inspect",
                            "target_id": target,
                            "title": f"Routine facility scan · {rid}",
                            "steps": steps,
                        }, "supervisor:sen_03", f"sys-patrol-{rid}-{eng.tick}")
                        self._next_outrig_patrol_tick = eng.tick + 220
                        break
    def _start_next(self, rid: str, robot: RobotActor) -> None:
        q = self.queues.get(rid) or []
        if not q or robot.busy:
            return
        m = self.missions[q[0]]
        rt = self.rt[m["id"]]
        if rt["state"] != "queued":
            return
        rt["state"] = "running"
        robot.mission_id, robot.task_id = m["id"], m.get("agent_task_id")
        if robot.mode != "DOCKED":
            robot.mode = "ROUTE_PLANNING"
        m["status"] = robot.mode
        self.dirty.add(m["id"])
        self._emit_transition(m, robot, "started")
        self._start_step(m, robot)

    def _start_step(self, m: Json, robot: RobotActor) -> None:
        eng = self.eng
        rt = self.rt[m["id"]]
        step = m["steps"][rt["idx"]]
        spec = ACTIONS[step["command"]]
        args = step["args"]
        reason = self._preconditions(m, step, spec, robot, "start")
        if reason:
            w = reason.split(":")[0]
            if w in WAITABLE:
                if rt["wait_since"] is None:
                    rt["wait_since"] = eng.sim_time
                    step["waiting"] = True
                    step["result"] = f"waiting: {reason}"
                    robot.mode = "BLOCKED"
                    m["status"] = "BLOCKED"
                    self.dirty.add(m["id"])
                    self._emit_transition(m, robot, "blocked")
                elif eng.sim_time - rt["wait_since"] > eng.cfg.blocked_timeout_s:
                    self._fail(m, step, robot, f"timeout waiting: {reason}")
                else:
                    step["waiting"] = True
                return
            self._fail(m, step, robot, reason)
            return
        rt["wait_since"] = None
        step.pop("result", None)
        step.pop("waiting", None)
        step["status"] = "active"
        step["started_tick"] = eng.tick
        m["status"] = spec.mode if spec.kind != "move" else ("RETURNING" if "return" in step["command"] else "TRAVELING")
        if spec.tools and robot.klass == "outrig":
            robot.tool = next((t for t in robot.hw.get("tools", []) if any(k in t for k in spec.tools)), robot.tool)
        if step["command"] == "fetch_tool":
            robot.tool = args.get("tool")
        # motion / action
        if spec.kind == "move":
            if not self._begin_move(m, step, robot):
                return
        elif spec.kind == "action":
            if self._mechanical_strainer(step, robot):
                robot.svc = None                      # fresh controller; the action stays open until the physical exchange finishes
                robot.start_action(step["command"], 1e9, spec.mode, False)
            else:
                robot.start_action(step["command"], spec.duration_s, spec.mode, False)
        else:  # instant
            robot.mode = spec.mode
        m["status"] = robot.mode
        if spec.effect:
            eng.emit_internal("repair.started" if spec.repair else "action.started", m["id"],
                              self._action_payload(m, step, robot, ok=None), actor_type="system")
        self.dirty.add(m["id"])
        self._emit_transition(m, robot, "step_started")

    @staticmethod
    def _mechanical_strainer(step: Json, robot: RobotActor) -> bool:
        """The FWS Y-strainer in the mechanical bay is the one fixture with a modelled mechanical service (MuJoCo cell): an OUTRIG replaces its
        cartridge physically; every other strainer / action keeps the timed, precondition-gated model (documented in v6-acceptance)."""
        return step["command"] == "replace_strainer" and robot.klass == "outrig" and step["args"].get("target_id") in ("strainer_01", "strainer_02")

    def _run_service_controller(self, m: Json, step: Json, robot: RobotActor) -> None:
        state, why = StrainerExchange(self.eng, robot, step["args"]["target_id"]).tick()
        if state == "done":
            robot.svc = None
            if robot.active:
                robot.active["duration_s"] = 0.0         # lets the ordinary completion path (effect + verification) run on the next robot step
        elif state == "failed":
            robot.svc = None
            robot.cancel_active()
            self._fail(m, step, robot, f"mechanical_service_failed: {why}")

    def _begin_move(self, m: Json, step: Json, robot: RobotActor) -> bool:
        """Motion planning goes through the deterministic navigator (graph search + time-aware reservations + explicit refusal
        reasons). The pre-V7 grid planner is kept as a labelled fallback for destinations that are not on the navigation graph."""
        eng = self.eng
        nav = eng.navigation
        cmd, a = step["command"], step["args"]
        blocked = eng.locks.blocked_edges()
        returning = cmd in ("return_to_port", "return_to_dock")
        if robot.klass == "inpipe":
            if cmd == "return_to_port":
                home = eng.asset_index[robot.home_id]
                target = {"segment_id": home["edge_id"], "s_m": home["s_m"]}
                mode = "RETURNING"
            else:
                target = {"segment_id": a["segment_id"], "s_m": a["s_m"]}
                mode = "TRAVELING"
            plan = nav.plan(robot.id, target, preview=False, purpose="return" if returning else "mission")
            nav.note_wait(robot.id, plan)
            if not plan.get("ok"):
                if plan["reason"] in ("RESERVATION_CONFLICT", "EQUIPMENT_BLOCK"):
                    self._wait_or_fail(m, step, robot, f"route_blocked: {plan['reason']}: {plan['detail']}")
                    return False
                self._wait_or_fail(m, step, robot, f"route_blocked: {plan['reason']}: {plan['detail']}")
                return False
            res = nav.commit(robot.id, plan, None, None, label=step["label"], mode=mode, source="mission")
            if not res.get("ok"):
                self._wait_or_fail(m, step, robot, f"route_blocked: {res['reason']}: {res['detail']}")
                return False
            rt = plan["route"]
            m["route_xyz_m"] = _decimate(rt.path.points, 0.35)
            m["route_segment_ids"] = [l["edge_id"] for l in rt.legs]
            m["route_plan_id"], m["eta_s"] = plan["plan_id"], plan["eta_s"]
            return True
        # outrig
        if cmd == "return_to_dock":
            d = eng.asset_index.get(robot.home_id) or eng.asset_index.get("dock_or1") or eng.asset_index.get("dock_o1")
            dest = [d["position_xyz_m"][0], 0.0, d["position_xyz_m"][2]] if d else [0.0, 0.0, 0.0]
            mode = "RETURNING"
            target: Any = robot.home_id
        else:
            dest = a.get("position_xyz_m") or self._service_pose(a.get("target_id", ""))
            mode = "TRAVELING"
            if dest is None:
                self._fail(m, step, robot, "unknown_target")
                return False
            target = {"x": dest[0], "z": dest[2]}
        plan = nav.plan(robot.id, target, preview=False, purpose="return" if returning else "mission")
        nav.note_wait(robot.id, plan)
        if plan.get("ok"):
            res = nav.commit(robot.id, plan, None, None, label=step["label"], mode=mode, source="mission")
            if res.get("ok"):
                m["route_xyz_m"] = plan["waypoints"]
                m["route_plan_id"], m["eta_s"] = plan["plan_id"], plan["eta_s"]
                return True
            plan = res
        if plan.get("reason") in ("RESERVATION_CONFLICT", "STALE_TRAFFIC", "EQUIPMENT_BLOCK", "BATTERY"):
            self._wait_or_fail(m, step, robot, f"route_blocked: {plan['reason']}: {plan.get('detail', '')} (traffic)")
            return False
        # not on the graph / refused for a geometric reason: labelled legacy grid planner
        nav.stats["fallbacks"] = nav.stats.get("fallbacks", 0) + 1
        extras = eng.traffic.stationary_rects(robot.id) + eng.traffic.closed_road_rects(robot.pos, dest)
        wp = eng.nav.route([robot.pos[0], 0.0, robot.pos[2]], list(dest), extra=extras)
        if wp is None:
            self._wait_or_fail(m, step, robot, "route_blocked: no collision-free path" + (" (parked robots in the way)" if extras else ""))
            return False
        wp = eng.traffic.apply_lanes(wp, extras)
        robot.start_move_outrig(wp, step["label"], mode)
        m["route_xyz_m"] = wp
        m["route_plan_id"] = "grid_fallback"
        return True

    def back_off(self, robot: RobotActor, other: RobotActor) -> bool:
        """Reverse out of a stand-off (shared by the traffic guard and the navigator's deadlock ladder). The mission step that was
        driving the robot is put back to pending/waiting so the yield move is not mistaken for the step finishing."""
        eng = self.eng
        back = eng.traffic.backoff_route(robot)
        if back is None:
            return False
        m = self.active_mission(robot.id)
        if m is not None:
            rt = self.rt[m["id"]]
            step = m["steps"][rt["idx"]]
            if step["status"] == "active" and not step.get("waiting"):
                robot.cancel_active()
                step["status"] = "pending"
                rt["wait_since"] = None
                self._wait_or_fail(m, step, robot, f"route_blocked: yielding to {other.id}")
        robot.cancel_active()
        robot.start_move_outrig(back, f"Yield to {other.id}", "TRAVELING")
        robot.mode = "BLOCKED"
        eng.traffic.clear_hold(robot.id)
        eng.traffic.start_yield(robot, other, eng.sim_time)
        eng.traffic.stats["backoffs"] = eng.traffic.stats.get("backoffs", 0) + 1
        eng.navigation.release_for_yield(robot.id)
        return True

    def requeue_step(self, robot: RobotActor, reason: str) -> None:
        """A navigation safe-stop / cancel took the robot off its route: the mission step goes back to waiting so it re-plans, instead of
        staying 'active' with nothing moving."""
        m = self.active_mission(robot.id)
        if m is None:
            return
        rt = self.rt[m["id"]]
        step = m["steps"][rt["idx"]]
        if step["status"] == "active" and not step.get("waiting"):
            step["status"] = "pending"
            rt["wait_since"] = None
            self._wait_or_fail(m, step, robot, reason)

    def _wait_or_fail(self, m, step, robot, reason):
        eng = self.eng
        rt = self.rt[m["id"]]
        if rt["wait_since"] is None:
            rt["wait_since"] = eng.sim_time
        # waiting for ANOTHER ROVER (parked at a service pose / yielding) is not a fault of this mission: the other job ends by itself (a pump
        # exchange takes minutes), so those waits get 5x the plain blocked timeout; everything else keeps the plain limit
        limit = eng.cfg.blocked_timeout_s * (5.0 if any(k in reason for k in ("parked robots", "traffic", "yielding")) else 1.0)
        if eng.sim_time - rt["wait_since"] > limit:
            self._fail(m, step, robot, reason)
            return
        step["status"] = "pending"
        step["waiting"] = True
        step["result"] = f"waiting: {reason}"
        robot.mode = "BLOCKED"
        m["status"] = "BLOCKED"
        self.dirty.add(m["id"])
        self._emit_transition(m, robot, "blocked")

    def _retry_wait(self, m, step, robot) -> None:
        if robot.active is not None or (robot.klass == "outrig" and self.eng.traffic.yielding(robot, self.eng.sim_time)):
            return                                        # backing off / yielding: plan again once that move is done and the other robot is past
        if self.eng.tick % 4 == 0:
            self._start_step(m, robot)

    def _check_route_still_ok(self, m, step, robot) -> None:
        if robot.klass != "inpipe" or robot.active is None or robot.active["type"] != "move_inpipe":
            return
        blocked = self.eng.locks.blocked_edges()
        if not blocked:
            return
        cur = robot.segment_id
        future = [l["edge_id"] for l in robot.active["legs"] if l["edge_id"] != cur]
        if any(e in blocked for e in future):
            robot.cancel_active()
            step["status"] = "pending"
            self.rt[m["id"]]["wait_since"] = None
            self._wait_or_fail(m, step, robot, "segment_locked: route crosses an isolated segment")

    def _battery_guard(self, m: Json, robot: RobotActor) -> None:
        eng = self.eng
        if m["kind"] == "return" or self.rt[m["id"]].get("cleanup") or eng.tick % 4:
            return
        reserve = eng.cfg.battery_reserve_pct
        need = reserve
        if robot.klass == "inpipe" and robot.segment_id:
            home = eng.asset_index.get(robot.home_id)
            if home:
                rt = eng.graph.route({"edge_id": robot.segment_id, "s": robot.s_m}, {"edge_id": home["edge_id"], "s": home["s_m"]},
                                     min_bore_mm=robot.hw["min_bore_mm"])
                if rt:
                    need += (rt.length / CRAWLER_SPEED) * DRAIN_MOVE * 1.2
        if robot.battery <= need:
            self.abort(m["id"], "battery_reserve", outcome="aborted", cleanup=True)
            robot.mode = "NEEDS_CHARGE"
            m["status"] = "NEEDS_CHARGE"
            eng.emit_internal("robot.mission_assigned", m["id"], {"mission_id": m["id"], "robot_id": robot.id, "kind": "return",
                                                                  "note": "battery_reserve_triggered_safe_return"}, actor_type="system")
            if robot.klass == "inpipe" and not self._at_home(robot):
                self._auto_return(robot)

    def _maybe_tow(self, robot: RobotActor) -> None:
        """An OUTRIG with an empty battery away from its dock cannot move. After TOW_AFTER_S of simulated time a maintenance crew tows it to its
        dock, where it charges like any other rover. This is a modelled, logged exception (event `robot.towed`), not a hidden reset: without it a
        long run slowly loses its whole fleet."""
        eng = self.eng
        rid = robot.id
        if (robot.klass != "outrig" or robot.mode not in TERMINAL_MODES or robot.battery > 0.5 or robot.active is not None
                or self._at_home(robot) or (eng.control.view(rid) or {}).get("state", "AUTONOMOUS") != "AUTONOMOUS"):
            self.stranded_since.pop(rid, None)
            return
        since = self.stranded_since.setdefault(rid, eng.tick)
        if (eng.tick - since) * eng.dt < TOW_AFTER_S:
            return
        home = eng.asset_index.get(robot.home_id)
        if not home:
            return
        frm = [round(robot.pos[0], 2), round(robot.pos[2], 2)]
        robot.cancel_active()
        robot.pos = [float(home["position_xyz_m"][0]), 0.0, float(home["position_xyz_m"][2])]
        robot.mode = "DOCKED"
        self.stranded_since.pop(rid, None)
        self.eng.emit_internal("robot.towed", rid, {"robot_id": rid, "from_xz": frm, "to": robot.home_id, "stranded_s": TOW_AFTER_S,
                                                    "reason": "battery_empty_away_from_dock"}, actor_type="system")

    def _auto_return(self, robot: RobotActor) -> None:
        mid = f"m_{self.seq + 1:02d}"
        self.seq += 1
        cmd = "return_to_port" if robot.klass == "inpipe" else "return_to_dock"
        m = {"id": mid, "incident_id": "", "robot_id": robot.id, "kind": "return", "title": "Safe return (battery reserve)",
             "target_id": robot.home_id, "status": "ASSIGNED", "progress": 0.0,
             "steps": [{"id": "s1", "command": cmd, "label": self._label(cmd, {}, robot), "status": "pending", "args": {}}],
             "opened_tick": self.eng.tick, "approval_id": None, "agent_task_id": None, "created_by": "engine",
             "command_id": None, "outcome": None, "failure_reason": None}
        self.missions[mid] = m
        self.rt[mid] = {"idx": 0, "state": "queued", "wait_since": None, "cleanup": False, "isolated": []}
        self.queues.setdefault(robot.id, []).insert(0, mid)
        self.dirty.add(mid)
        self._emit_transition(m, robot, "created")

    def _fail(self, m: Json, step: Json, robot: RobotActor, reason: str) -> None:
        step["status"] = "failed"
        step["result"] = reason
        step["ended_tick"] = self.eng.tick
        for s in m["steps"]:
            if s["status"] == "pending":
                s["status"] = "skipped"
        m["failure_reason"] = reason
        robot.cancel_active()
        rt = self.rt[m["id"]]
        # a failed service must still make safe if it already isolated something
        if rt["isolated"] and robot.klass == "outrig" and not rt.get("cleanup"):
            self.abort(m["id"], reason, outcome="failed", cleanup=True)
            return
        self._close(m, robot, "failed")

    # -- finish --
    def _finish_step(self, m: Json, step: Json, robot: RobotActor) -> None:
        eng = self.eng
        rt = self.rt[m["id"]]
        spec = ACTIONS[step["command"]]
        args = step["args"]
        effect_key = f"{m['id']}:{step['id']}"
        ok = True
        result: str | None = None
        data: Json | None = None
        effects: Json = {}
        if step["command"] in ("return_to_port", "return_to_dock", "dock"):
            if self._at_home(robot):
                robot.mode = "DOCKED"
                robot.tool = None
            else:
                ok, result = False, "not_at_home"
        elif step["command"] == "inspect":
            data = eng.sensing.inspect(robot, args.get("gauge", "general"))
            result = data.get("summary")
        elif step["command"] == "sample":
            data = eng.sensing.inspect(robot, "general")
            result = "sample taken"
        elif step["command"] == "navigate" and robot.klass == "outrig":
            robot.face_yaw = eng.service_facing(args.get("target_id", ""))     # arrive facing the work: the arm must not have to reach back over its own chassis
        elif step["command"] == "scan":
            data = eng.sensing.scan(args.get("target_id", ""))
            result = data.get("summary")
        elif step["command"] == "pressure_test":
            data = eng.sensing.pressure_test(args.get("target_id", ""), args.get("kpa", 280), args.get("hold_s", 15))
            result = data.get("summary")
            ok = data.get("hold_ok", True)
        elif spec.effect:
            reason = self._preconditions(m, step, spec, robot, "complete")
            if reason:
                ok, result = False, reason
            elif effect_key in self.applied_effects:
                result, effects = "already applied (idempotent)", {"duplicate": True}
            else:
                target = args.get("valve_id") or args.get("segment_id") or args.get("target_id")
                self.applied_effects.add(effect_key)
                self.new_effects.append(effect_key)
                res = eng.plant_apply(spec.effect, target, self._plant_args(spec.effect, target, args))
                ok = bool(res.get("ok"))
                effects = res.get("effects") or {}
                result = res.get("reason") if not ok else (res.get("summary") or f"{step['command']} complete")
                if ok:
                    self._after_effect(m, step, robot, spec, args)
        elif step["command"] == "fetch_tool":
            result = f"{args.get('tool')} attached"
        step["ended_tick"] = eng.tick
        if result is not None:
            step["result"] = result
        if data is not None:
            step["data"] = data
        step["status"] = "done" if ok else "failed"
        pl = self._action_payload(m, step, robot, ok=ok)
        pl["effects"] = effects
        pl["effect_key"] = effect_key
        eng.emit_internal("action.completed", m["id"], pl, actor_type="system")
        if spec.effect and spec.repair:
            eng.emit_internal("repair.completed", m["id"], pl, actor_type="system")
        self.dirty.add(m["id"])
        if not ok:
            self._fail(m, step, robot, result or "action_failed")
            return
        rt["idx"] += 1
        rt["wait_since"] = None
        if rt["idx"] >= len(m["steps"]):
            self._close(m, robot, "completed" if not rt.get("cleanup") else (m.get("pending_outcome") or "aborted"))
            return
        m["progress"] = round_to(rt["idx"] / len(m["steps"]), 4)
        self._emit_transition(m, robot, "step_done")
        self._start_step(m, robot)

    def _plant_args(self, effect: str, target: str | None, args: Json) -> Json:
        """Map a mission step's args to the plant command's strict arg set (the plant rejects unknown keys)."""
        if effect == "brush_clear":
            occ = float((((self.eng.assets_truth().get(target or "") or {}).get("fault")) or {}).get("occlusion") or 0.0)
            g = self.eng.sensing._gauss()
            return {"removed_fraction": round_to(clamp(0.9 - 0.85 * occ + 0.07 * g, 0.2, 0.95), 4)}
        return {}

    def _after_effect(self, m, step, robot, spec, args) -> None:
        eng = self.eng
        rt = self.rt[m["id"]]
        if step["command"] == "isolate_valve":
            for e in self._zone_edges(args["valve_id"]):
                eng.locks.isolated_edges[e] = m["id"]
            rt["isolated"].append(args["valve_id"])
        elif step["command"] == "reopen_valve":
            for e in [e for e, o in eng.locks.isolated_edges.items() if o == m["id"] or e in self._zone_edges(args["valve_id"])]:
                eng.locks.isolated_edges.pop(e, None)
            rt["isolated"] = [v for v in rt["isolated"] if v != args["valve_id"]]
        elif step["command"] == "brush_clear":
            robot.tool = "brush"

    def _action_payload(self, m, step, robot, ok) -> Json:
        a = step["args"]
        return {"mission_id": m["id"], "step_id": step["id"], "command": step["command"], "robot_id": robot.id,
                "incident_id": m["incident_id"], "target_id": a.get("valve_id") or a.get("segment_id") or a.get("target_id") or m["target_id"],
                "ok": ok, "result": step.get("result")}

    # ------------------------------------------------------------------ preconditions (section 13)
    def _preconditions(self, m: Json, step: Json, spec: ActionSpec, robot: RobotActor, phase: str) -> str | None:
        eng = self.eng
        cmd, a = step["command"], step["args"]
        if eng.physics_degraded() and spec.high_impact:
            return "physics_degraded"
        if robot.battery < 1.0 and spec.kind != "instant":
            return "battery_depleted"
        # 5. conflicting reservations: a foreign exclusive lock on the asset
        tgt = a.get("valve_id") or a.get("segment_id") or a.get("target_id")
        if tgt:
            h = eng.locks.holder_of(f"asset:{tgt}")
            if h and h != m["id"] and spec.effect:
                return f"resource_locked: {tgt} held by {h}"
        if cmd == "move_to":
            why = eng.graph.why_not(a["segment_id"], robot.hw.get("min_bore_mm", 0), eng.locks.blocked_edges())
            if why:
                return ("segment_locked: " + why) if "locked" in why else f"segment_not_reachable: {why}"
        if cmd == "launch":
            if not self._at_home(robot):
                return "launch_requires_robot_at_port"
        # 2. tools + proximity
        if spec.tools and not tool_matches(" ".join(robot.hw.get("tools", [])), spec.tools):
            return "tool_unavailable"
        if spec.proximity == "segment":
            if robot.segment_id != a.get("segment_id") or abs((robot.s_m or 0.0) - a.get("s_m", robot.s_m or 0.0)) > 1.0:
                return "out_of_reach: crawler is not at the target position"
        elif spec.proximity == "asset":
            t = a.get("valve_id") or a.get("target_id") or a.get("segment_id")
            if not self._within_reach(robot, t):
                return "out_of_reach: robot is not within manipulator reach"
        # 4. isolation + pressure for disassembly / clamp
        if spec.needs_isolation:
            t = a.get("target_id") or a.get("segment_id")
            if not self._is_isolated(t):
                return "not_isolated: target segment must be isolated first"
            p = eng.sensing.pressure_kpa(t)
            if p is not None and p > eng.cfg.safe_service_pressure_kpa:
                return f"pressure_above_service_threshold: {p:.0f} kPa"
        # 5b. isolating requires: no crawler inside, racks cordoned, single isolation per zone
        if cmd == "replace_strainer" and phase == "complete" and a.get("target_id") in eng.bays:
            rs = eng.bays[a["target_id"]].repair_state
            if not (rs.cartridge_installed and rs.mechanical_fit_pass):
                return "mechanical_service_incomplete: the cartridge is not seated in the fixture"
        if cmd == "isolate_valve":
            edges = set(self._zone_edges(a["valve_id"]))
            for r in eng.robots.values():
                if r.klass == "inpipe" and r.mode != "DOCKED" and r.segment_id in edges:
                    return "crawler_inside_segment"
            if any(o != m["id"] for e, o in eng.locks.isolated_edges.items() if e in edges):
                return "isolation_busy"
            if not eng.sensing.racks_cordoned(a["valve_id"]):
                return "racks_not_cordoned"
        return None

    def _within_reach(self, robot: RobotActor, target_id: str | None) -> bool:
        eng = self.eng
        if not target_id:
            return False
        reach = robot.hw.get("reach_m", 3.0)
        rp = [robot.pos[0], 0.0, robot.pos[2]]
        a = eng.asset_index.get(target_id)
        cands = []
        if a:
            cands.append([a["position_xyz_m"][0], 0.0, a["position_xyz_m"][2]])
            if a.get("service_xyz_m"):
                cands.append(list(a["service_xyz_m"]))
        elif target_id in eng.graph.edges:
            # distance to the pipe polyline in plan view (long straight runs have only their end points as vertices)
            pts = eng.graph.path(target_id).points
            for i in range(1, len(pts)):
                if _seg_dist_xz(rp, pts[i - 1], pts[i]) <= reach:
                    return True
            return False
        return any(v_dist(rp, c) <= reach for c in cands)

    def _is_isolated(self, target_id: str | None) -> bool:
        eng = self.eng
        if not target_id:
            return False
        edge = target_id if target_id in eng.graph.edges else (eng.asset_index.get(target_id) or {}).get("edge_id")
        if edge in eng.locks.isolated_edges:
            return True
        st = eng.assets_truth().get(target_id) or {}
        return st.get("status") == "isolated"


def _seg_dist_xz(p: list, a: list, b: list) -> float:
    """Plan-view (x, z) distance from p to the segment a-b."""
    ax, az, bx, bz = a[0], a[2], b[0], b[2]
    dx, dz = bx - ax, bz - az
    l2 = dx * dx + dz * dz
    t = 0.0 if l2 < 1e-12 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[2] - az) * dz) / l2))
    return math.hypot(p[0] - (ax + dx * t), p[2] - (az + dz * t))


def _decimate(points: list, step_m: float) -> list:
    if not points:
        return []
    out = [points[0]]
    acc = 0.0
    for i in range(1, len(points)):
        acc += v_dist(points[i - 1], points[i])
        if acc >= step_m:
            out.append(points[i])
            acc = 0.0
    if out[-1] != points[-1]:
        out.append(points[-1])
    return out
