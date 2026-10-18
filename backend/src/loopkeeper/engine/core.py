"""The single-writer simulation engine for ONE run. Implements `EngineFacade`.

Concurrency model: all mutation happens while holding `self._lock` (the tick loop, `submit`), and every
mutating code path is synchronous, so state can only change at tick boundaries / between awaits. Events are
buffered and committed atomically (events + ledger + projections + snapshots + run cursor) once per loop
iteration; they become visible to subscribers only after the commit succeeds. If the commit fails the engine
stops advancing physics (fail closed) and retries; evidence is never dropped.
"""
from __future__ import annotations

import math

import asyncio
import json
import logging
import os
import zlib
import random
import time
from typing import Any, Callable

from .. import interfaces  # noqa: F401  (Protocol docs)
from ..storage import maintenance
from ..storage.base import CommitBatch, LeadershipLost, Storage, StorageError
from .clock import SimClock
from .commands import CommandBus
from .config import ENGINE_VERSION, STATE_SCHEMA_VERSION, EngineConfig
from .control import ControlManager
from ..comms import CommRecorder
from .eventlog import EventBus, Subscription, event_hash, now_iso, to_envelope
from .locks import ResourceLocks
from .robots.actions import PLANT_COMMANDS
from .robots.fleet import build_fleet
from .robots.graphs import NavGrid, PipeGraph
from .robots.traffic import Traffic
from ..nav.navigator import Navigator
from .robots.missions import MissionManager
from .robots.manipulator import ManipulatorBank
from .sensing import Sensing
from .tracking import TRACKED, Tracking
from .util import Json, b64, chash, clone, new_uuid, sha256_hex, canon, unb64
from ..robotics.mujoco_runtime import MuJoCoRuntime

from .tracking import EVENT_ONLY  # noqa: E402
AGENT_EMIT = set(TRACKED) | set(EVENT_ONLY)
LEGACY_ROBOT_IDS = {"c_01": "IR-01", "c_02": "IR-02", "o_01": "OR-01"}
STREAM_ONLY_KINDS = frozenset({"world.diff", "robot.pose", "engine.health", "heartbeat"})
STREAM_PERSIST_EVERY_TICKS = 120
SNAP_KEYS_EXCLUDED_FROM_HASH = ("seq", "plant", "wall")
log = logging.getLogger("loopkeeper.engine")


def world_projection(world: Json) -> Json:
    """The slice of a WorldSnapshot that stream events fully determine (used for replay verification)."""
    robots = {}
    for rid, r in world["robots"].items():
        robots[rid] = {"pose": r["pose"], "battery_pct": r["battery_pct"], "mode": r["mode"], "mission_id": r.get("mission_id"),
                       "tool": r.get("tool"), "agent_task_id": r.get("agent_task_id"), "route_xyz_m": r.get("route_xyz_m")}
    missions = {}
    for mid, m in world["missions"].items():
        mm = {k: v for k, v in m.items() if k != "progress"}
        mm["steps"] = [{k: v for k, v in s.items() if k != "waiting"} for s in m["steps"]]
        missions[mid] = mm
    return {"sim_tick": world["sim_tick"], "sim_speed": world["sim_speed"], "sim_status": world["sim_status"],
            "assets": world["assets"], "robots": robots, "missions": missions, "incidents": world["incidents"], "kpis": world["kpis"]}


def world_hash(world: Json) -> str:
    return chash(world_projection(world))


COMMIT_ATTEMPTS = 3                 # a transient storage error is retried this many times (0.25 s, 0.5 s apart) before physics halts
COMMIT_RETRY_BASE_S = 0.25


class Engine:
    def __init__(self, run_id: str, cfg: EngineConfig, plant, topology: Json, storage: Storage | None, *, agents=None,
                 wall: Callable[[], float] = time.monotonic, wall_time: Callable[[], float] = time.time,
                 replay: bool = False, leader_epoch: int | None = None, seed: int | None = None, owner_id: str | None = None):
        self.run_id, self.cfg, self.plant, self.topo, self.storage, self.agents = run_id, cfg, plant, topology, storage, agents
        self.facility_id = topology["facility"]["id"]
        self.topology_revision = topology["facility"]["topology_hash"]
        self.seed = cfg.seed if seed is None else seed
        self.owner_id = owner_id
        self.replay = replay
        self.leader_epoch = leader_epoch
        self.wall_time = wall_time
        self.log = log
        self.clock = SimClock(cfg.dt_s, cfg.sim_speed, wall, cfg.max_catchup_ticks)
        self.bus = EventBus(cfg.ring_size)
        self.rng = random.Random(self.seed * 2654435761 % (2 ** 32))
        self.seq = 0
        self.apply_order = 0
        self.forced_ids: dict[str, str] = {}
        self.pending_events: list[Json] = []
        self._pose_baseline: set = set()
        self.shadow: list[Json] = []           # replay mode: regenerated deterministic events, for verification
        self.pending_snaps: list[Json] = []
        self.pending_samples: list[Json] = []
        self.db_down = False
        self.fenced = False
        self.physics_err: str | None = None
        self._phys_fail = 0
        self._truth: Json | None = None
        self._truth_tick = -1
        self._pw: Json | None = None
        self._deg: Json | None = None
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._stop = False
        self._started_wall = time.time()
        self._last_cad = {"pose": 0.0, "diff": 0.0, "health": 0.0, "hb": 0.0, "agent": 0.0}
        self._last_pose: dict[str, str] = {}
        self._drive_note: dict[str, float] = {}
        self._agent_task: asyncio.Task | None = None
        self._agent_cursor = 0
        self._next_snap_s = maintenance.POLICY.interval_s(cfg.snapshot_interval_s, cfg.sim_speed)
        self._snap_request: str | None = None
        self._next_sample_s = 0.0
        self.hist: dict[str, list] = {}
        self.hist_t: list = []
        self._robots_dirty: set[str] = set()
        # topology indexes
        self.asset_index = {a["id"]: a for a in topology["assets"]}
        self.graph = PipeGraph(topology)
        self.nav = NavGrid(topology)
        # subsystems
        self.locks = ResourceLocks()
        self.track = Tracking()
        self.robots = {r.id: r for r in build_fleet(topology, self.graph)}
        self.traffic = Traffic(self)
        self.sensing = Sensing(self)
        self.missions = MissionManager(self)
        self.control = ControlManager(self)
        self.commands = CommandBus(self)
        self.comms = CommRecorder(self, enabled=os.environ.get("LOOPKEEPER_COMMS", "1") != "0")     # V10: typed communication events derived at runtime boundaries
        self.navigation = Navigator(self)           # G_ext / G_in, reservations, route plan/commit (validated at build; raises NavValidationError)
        # MuJoCo manipulation cells are REAL service bays of the facility, one per mechanically modelled strainer, anchored at the snapped service pose
        # (the bay heading is the first free direction of E, W, S, N so the cartridge, the fixture and the carry path are all on free floor).
        # One OUTRIG holds a cell at a time (`rt.owner`); the engine owns the rover pose and the cell follows it.
        self.bays: dict[str, MuJoCoRuntime] = {}
        for bid in ("strainer_01", "strainer_02"):
            svc = (self.asset_index.get(bid) or {}).get("service_xyz_m")
            if not svc:
                continue
            rt = MuJoCoRuntime(self.run_id, bid)
            sp = self.nav.snap([float(svc[0]), 0.0, float(svc[2])])             # where a rover really stops (nav grid)
            for yaw in (math.pi / 2.0, -math.pi / 2.0, 0.0, math.pi):          # E, W, S, N
                hx, hz = math.sin(yaw), math.cos(yaw)
                ax, az = float(sp[0]) + 0.05 * hx, float(sp[2]) + 0.05 * hz
                pts = [(ax + hx * d - hz * l, az + hz * d + hx * l) for d in (0.0, 0.5, 1.2, 1.8, 2.25, 2.6) for l in (-0.3, 0.0, 0.3)]
                if all(self.nav.is_free(x, z) for x, z in pts):
                    rt.set_anchor(ax, az, yaw)
                    break
            else:
                rt.set_anchor(float(sp[0]) + 0.05, float(sp[2]), math.pi / 2.0)
            self.bays[bid] = rt
        self.mujoco_runtime = self.bays.get("strainer_01") or MuJoCoRuntime(self.run_id)      # primary bay (back-compat alias)
        self.manipulators = ManipulatorBank(self)      # one independent 6-DOF arm + gripper state per OUTRIG (engine/robots/manipulator.py)
        self.recovery_info: Json = {}
        self.run_row: Json = {}

    @property
    def workcell_owner(self) -> str | None:
        return self.mujoco_runtime.owner

    def bay_of(self, rid: str) -> "MuJoCoRuntime | None":
        return next((b for b in self.bays.values() if b.owner == rid), None)

    def service_facing(self, target_id: str) -> float | None:
        """Heading a rover takes on arriving at a service pose: the bay heading for a MuJoCo service bay, else toward the asset."""
        if target_id in self.bays:
            return float(self.bays[target_id].anchor_yaw)
        a = self.asset_index.get(target_id)
        sp = (a or {}).get("service_xyz_m")
        pos = (a or {}).get("position_xyz_m")
        if not sp or not pos:
            return None
        dx, dz = pos[0] - sp[0], pos[2] - sp[2]
        return math.atan2(dx, dz) if math.hypot(dx, dz) > 0.2 else None

    def claim_workcell(self, rid: str, bay_id: str | None = None) -> tuple[bool, str]:
        """Bind a MuJoCo service-bay cell to an OUTRIG so it can use the arm/gripper. A rover that already holds a cell keeps it; otherwise the
        named bay, else the nearest free one. Refused for crawlers (no such arm) and while another rover's payload is in that cell's gripper."""
        r = self.robots.get(rid)
        if r is None or r.klass != "outrig":
            return False, "no_manipulator: only OUTRIG rovers carry the 6-DOF arm"
        arm = self.manipulators.arms.get(rid)
        if arm is not None and arm.held_source == "operator":
            return False, f"hands_full: {rid} is holding {arm.held_object_id} (operator grasp); place it first"
        mine = self.bay_of(rid)
        if mine is not None and (bay_id is None or bay_id == mine.bay_id):
            return True, ""
        if bay_id is None:
            bay_id = min(self.bays, key=lambda b: math.hypot(r.pos[0] - self.bays[b].anchor_xz[0], r.pos[2] - self.bays[b].anchor_xz[1]), default=None)
        mj = self.bays.get(bay_id or "")
        if mj is None:
            return False, "no_bay: this facility has no mechanical service bay"
        if mine is not None and mine.held_object_id:
            return False, f"hands_full: {rid} is holding {mine.held_object_id} in bay {mine.bay_id}"
        if mj.owner and mj.owner != rid and mj.held_object_id:
            return False, f"workcell_busy: {mj.owner} is holding {mj.held_object_id}"
        if mine is not None:
            mine.owner = None
        mj.owner = rid
        mj.set_arm_pose(list(mj.REST_POSE))
        mj.bind_base_to_facility_pose(r.pos[0], r.pos[2], r.yaw)
        self.emit_internal("robot.workcell", rid, {"robot_id": rid, "event": "bound", "bay_id": mj.bay_id, "anchor": mj.to_robot_state_dict(rid)["cell_anchor"]},
                           actor_type="system")
        return True, ""

    # ================================================================ properties
    @property
    def tick(self) -> int: return self.clock.tick
    @property
    def sim_time(self) -> float: return self.clock.sim_time_s
    @property
    def dt(self) -> float: return self.cfg.dt_s

    @property
    def paused(self) -> bool: return self.clock.paused

    # ================================================================ plant access
    def assets_truth(self) -> Json:
        if self._truth is None or self._truth_tick != self.tick:
            self._truth = self.plant.assets()
            self._truth_tick = self.tick
        return self._truth

    def _invalidate(self) -> None:
        self._truth = None
        self._pw = None
        self._deg = None

    def physics_degraded(self) -> bool:
        if self._deg is None:
            try:
                h = self.plant.solver_health()
            except Exception:
                h = {"converged": False, "degraded": True, "residual": 1.0, "reason": "solver_health_error"}
            self._deg = h
        return bool(self._deg.get("degraded")) or self.physics_err is not None

    def plant_apply(self, effect_key: str, target: str | None, args: Json) -> Json:
        kind = self.cfg.plant_command_map.get(effect_key) or PLANT_COMMANDS[effect_key]
        try:
            res = self.plant.apply({"kind": kind, "target_id": target, "args": args})
        except Exception as e:
            log.exception("plant.apply failed")
            res = {"ok": False, "reason": f"plant_error ({type(e).__name__})"}
        self._invalidate()
        return res if isinstance(res, dict) else {"ok": bool(res)}

    # ================================================================ events
    def emit(self, type: str, entity_id: str, payload: Json) -> Json:
        """EngineFacade.emit: agents append incident.*, agent.task, agent.tool, verification.result."""
        if type not in AGENT_EMIT:
            raise ValueError(f"event type '{type}' is reserved for the engine")
        return self.emit_internal(type, entity_id, payload, actor_type="agent")

    def emit_internal(self, kind: str, entity_id: str, payload: Json, actor_type: str = "system", actor_id: str | None = None,
                      command_id: str | None = None, causal_parent_id: str | None = None) -> Json:
        self.seq += 1
        seq = self.seq
        payload = clone(payload)
        ev = {"seq": seq, "event_id": f"ev_{seq:06d}", "facility_id": self.facility_id, "tick": self.tick, "sim_time_s": self.sim_time,
              "world_version": self.tick, "kind": kind, "entity_id": entity_id, "actor_type": actor_type, "actor_id": actor_id,
              "payload": payload, "causal_parent_id": causal_parent_id, "command_id": command_id, "ts": now_iso(),
              "schema_version": STATE_SCHEMA_VERSION}
        ev["event_hash"] = event_hash(ev)
        if kind in TRACKED:
            self.track.ingest(kind, payload)
            if kind in ("incident.opened", "incident.closed") and not self.replay:
                self._snap_request = "incident"
        if self.replay:
            self.shadow.append(ev)
        else:
            self.pending_events.append(ev)
        env = to_envelope(self.run_id, ev)
        if kind not in STREAM_ONLY_KINDS and not kind.startswith("comm."):
            self.comms.observe(kind, entity_id, payload, actor_type, actor_id, command_id, ev["event_id"])
        return env

    def note_drive_accepted(self, lease_id: str, seq: int, principal: str, cid: str) -> None:
        now = self.wall_time()
        if now - self._drive_note.get(lease_id, 0.0) >= 1.0:   # throttled: full detail lives in the command ledger
            self._drive_note[lease_id] = now
            self.emit_internal("robot.drive.accepted", lease_id, {"lease_id": lease_id, "command_seq": seq}, actor_type="operator",
                               actor_id=principal, command_id=cid)

    def events_since(self, seq: int, limit: int = 1000) -> list[Json]:
        limit = max(1, min(int(limit), 5000))
        got = self.bus.since(seq, limit)
        if got is not None:
            return got
        if self.storage is None:
            return []
        rows = self.storage.load_events(self.run_id, after_seq=seq, until_seq=self.bus.last_published_seq or self.seq, limit=limit)
        return [to_envelope(self.run_id, r) for r in rows]

    def subscribe(self, since_seq: int | None = None) -> Subscription:
        return self.bus.subscribe(since_seq)

    def snapshot_and_subscribe(self) -> tuple[Json, Subscription]:
        """Atomic (no await in between): the snapshot event and a subscription that starts right after it."""
        return self.snapshot_event(), self.bus.subscribe(None)

    def snapshot_event(self) -> Json:
        w = self.world()
        return {"event_id": f"snap_{w['last_seq']:06d}", "seq": w["last_seq"], "sim_tick": w["sim_tick"], "sim_time_s": w["sim_time_s"],
                "world_version": w["version"], "type": "snapshot", "entity_id": self.facility_id, "facility_id": self.facility_id,
                "ts": now_iso(), "payload": w, "run_id": self.run_id}

    # ---- wall-cadence publishers (same cadence as the reference engine: 10 Hz poses, 2 Hz diff) ----------
    def publish_poses(self, force: bool = False) -> None:
        for rid in sorted(self.robots):
            r = self.robots[rid]
            k = r.pose_key()
            if not force and self._last_pose.get(rid) == k:
                continue
            self._last_pose[rid] = k
            c = r.to_contract()
            self.emit_internal("robot.pose", rid, {"robot_id": rid, "robot_class": r.klass, "pose": c["pose"], "nav": c["nav"],
                                                   "battery_pct": c["battery_pct"], "mode": c["mode"], "sim_tick": self.tick,
                                                   "route_xyz_m": c["route_xyz_m"], "mission_id": r.mission_id, "tool": r.tool,
                                                   "agent_task_id": r.task_id, "facility_id": self.facility_id, "run_id": self.run_id,
                                                   "topology_version": self.topo.get("facility", {}).get("topology_version") or self.topology_revision,
                                                   "world_version": self.tick})
            self.control.dirty.discard(None)
            self._robots_dirty.add(rid)

    def world_assets(self) -> Json:
        a = clone(self.assets_truth())
        for aid in a:
            h = self.locks.holder_of(f"asset:{aid}")
            if h:
                a[aid]["locked_by"] = h
        return a

    def publish_diff(self) -> None:
        self.emit_internal("world.diff", self.facility_id, {"assets": self.world_assets(), "kpis": self.kpis(), "sim_speed": self.clock.speed,
                                                              "sim_status": self.sim_status()})

    def publish_health(self) -> None:
        self.emit_internal("engine.health", self.facility_id, {"health": self.health()})

    def publish_heartbeat(self) -> None:
        self.emit_internal("heartbeat", self.facility_id, {"server_ts": now_iso()})

    # ================================================================ views
    def topology(self) -> Json:
        return self.topo

    def sim_status(self) -> str:
        if self.paused:
            return "paused"
        if self.physics_degraded() or self.db_down:
            return "degraded"
        return "recovering" if self.track.busy() else "running"

    def health(self) -> Json:
        try:
            ph = self.plant.solver_health()
        except Exception:
            ph = {"converged": False, "residual": 1.0, "degraded": True}
        status = "failed" if self.physics_err else ("degraded" if ph.get("degraded") else ("converged" if ph.get("converged", True) else "degraded"))
        intel = {"provider": "deterministic", "model_id": "none", "status": "unavailable"}
        if self.agents is not None:
            try:
                intel = self.agents.model_status()
            except Exception:
                pass
        mem = self.storage is None or self.storage.kind == "memory"
        return {"status": self.sim_status(), "tick_rate_hz": 1.0 / self.dt,
                "solver": {"status": status, "residual": float(ph.get("residual", 0.0) or 0.0)},
                "database": "n/a" if mem else ("unavailable" if self.db_down else "ok"), "intelligence": intel,
                "safe_automation_mode": self.cfg.safe_automation_mode, "approval_window_s": self.cfg.approval_window_s,
                "backend": "live", "uptime_s": round(time.time() - self._started_wall, 1), "seed": self.seed}

    def kpis(self) -> Json:
        try:
            k = dict(self._plant_world().get("kpis") or {})
        except Exception:
            k = {}
        o, r = self.track.counts()
        for key in ("min_margin_k", "total_heat_kw", "tcs_flow_kg_s", "fws_flow_kg_s", "tcs_supply_c", "tcs_return_c"):
            k.setdefault(key, 0.0)
        k["open_incidents"], k["resolved_incidents"] = o, r
        return k

    def _plant_world(self) -> Json:
        if self._pw is None:
            self._pw = self.plant.world()
        return self._pw

    def robots_view(self) -> Json:
        out = {}
        for rid, r in self.robots.items():
            c = r.to_contract()
            c["control"] = self.control.view(rid)
            cs = c["control"].get("controller_state")
            if cs == "MANUAL":
                c["fleet"]["state"] = "manual"
            elif cs == "SAFE_HOLD":
                c["fleet"]["state"] = "safe_hold"
            elif r.mode == "DOCKED" and r.battery < 99.9:
                c["fleet"]["state"] = "charging"
            bay = self.bay_of(rid)
            if bay is not None:
                mj = bay.to_robot_state_dict(rid)
                c["arm_joint_names"] = mj["arm_joint_names"]
                c["arm_qpos_rad"] = mj["arm_qpos_rad"]
                c["gripper_aperture_m"] = mj["gripper_aperture_m"]
                c["held_object_id"] = mj["held_object_id"]
                c["grip_force_N"] = mj["grip_force_N"]
                c["end_effector_pose"] = mj["end_effector_pose"]
                c["contact_list"] = mj["contact_list"]
                c["payload_mass_kg"] = mj["payload_mass_kg"]
                c["deposit_fouling_pct"] = mj["deposit_fouling_pct"]
            self.manipulators.decorate(rid, c)          # per-robot arm state (OUTRIG): c["manipulator"] + the flat arm fields of THIS robot
            out[rid] = c
        return out          # registry is the only source of robot ids: no legacy aliases in emitted data

    def world(self) -> Json:
        last = self.bus.last_published_seq if not self.replay else self.seq
        w = {"facility_id": self.facility_id, "run_id": self.run_id, "version": self.tick, "sim_tick": self.tick, "sim_time_s": self.sim_time,
                "sim_speed": self.clock.speed, "sim_status": self.sim_status(), "assets": self.world_assets(), "robots": self.robots_view(),
                "missions": clone(self.missions.missions), "incidents": self.track.world_incidents(), "health": self.health(),
                "kpis": self.kpis(), "last_seq": max(last, self.bus.base_seq, 0), "mode": "REPLAY" if self.replay else "LIVE"}
        if self.bays:
            ro, fx = {}, {}
            for bay in self.bays.values():
                cs, rs = bay.cartridge_state, bay.repair_state
                ro[cs.id] = {"id": cs.id, "name": cs.name, "mass_kg": cs.mass_kg,
                             "pos_xyz": [round(v, 4) for v in bay.to_facility_point(cs.pos_xyz)], "quat_xyzw": bay.to_facility_quat(cs.quat_xyzw),
                             "frame_id": "facility_world", "held_by_robot_id": cs.held_by_robot_id, "seated_in_fixture_id": cs.seated_in_fixture_id,
                             "bay_id": bay.bay_id}
                fx[rs.fixture_id] = {"id": rs.fixture_id, "target_component_id": rs.target_component_id, "is_isolated": rs.is_isolated,
                                     "cartridge_installed": rs.cartridge_installed, "mechanical_fit_pass": rs.mechanical_fit_pass,
                                     "pos_xyz": [round(v, 4) for v in bay.to_facility_point([14.2, 1.8, 0.27])], "frame_id": "facility_world",
                                     "bay_id": bay.bay_id}
            w["rigid_objects"], w["mechanical_fixtures"] = ro, fx
        if hasattr(self.plant, "leak_sim") or hasattr(self.plant, "fire_sim"):
            hz = []
            if hasattr(self.plant, "leak_sim"):
                hz.extend(self.plant.leak_sim.get_hazard_zones())
            if hasattr(self.plant, "fire_sim"):
                hz.extend(self.plant.fire_sim.get_hazard_zones())
            if hasattr(self.plant, "hazards"):      # V12 L2: manifold leak / smoke event zones (physics/hazards.py)
                hz.extend(self.plant.hazards.get_hazard_zones())
            w["hazard_zones"] = hz
        if hasattr(self.plant, "power_sim"):
            w["power_state"] = {**self.plant.power_sim.state.to_dict(), **(self.plant.hazards.power_state() if hasattr(self.plant, "hazards") else {})}
        return w

    def telemetry(self, asset_id: str, metric: str, window_s: float = 600.0) -> Json | None:
        from ..engine.util import round_to  # noqa: PLC0415
        key = f"{asset_id}.{metric}"
        arr = self.hist.get(key)
        tmin = self.sim_time - window_s
        unit = ""
        points = []
        if arr:
            n = len(arr)
            times = self.hist_t[-n:]
            points = [[round_to(t, 1), round_to(v, 3)] for t, v in zip(times, arr) if t >= tmin]
        elif self.storage is not None:
            rows = self.storage.load_sensor_samples(self.run_id, asset_id, metric, max(tmin, 0.0))
            points = [[round_to(r["sim_time_s"], 1), round_to(r["value"], 3)] for r in rows]
        if not points and key not in self.hist and asset_id not in self.assets_truth():
            return None
        return {"asset_id": asset_id, "metric": metric, "unit": unit, "points": points}

    # ================================================================ state document / snapshots
    def state_doc(self) -> Json:
        return {"schema_version": STATE_SCHEMA_VERSION, "engine_version": ENGINE_VERSION, "run_id": self.run_id, "facility_id": self.facility_id,
                "tick": self.tick, "seq": self.seq, "apply_order": self.apply_order, "speed": self.clock.speed, "paused": self.paused,
                "dt": self.dt, "plant": b64(self.plant.get_state()), "plant_hash": self.plant.state_hash(), "rng": _rng_dump(self.rng),
                "robots": {rid: r.to_state() for rid, r in self.robots.items()}, "missions": self.missions.to_state(),
                "locks": self.locks.to_state(), "track": self.track.to_state(), "control": self.control.to_state(), "nav": self.navigation.to_state(),
                "next_snap_s": self._next_snap_s, "next_sample_s": self._next_sample_s, "topology_hash": self.topology_revision,
                "workcells": {bid: {"owner": b.owner, "state": b.get_state()} for bid, b in self.bays.items()},
                "manipulators": self.manipulators.to_state()}

    def state_hash(self) -> str:
        d = self.state_doc()
        for k in SNAP_KEYS_EXCLUDED_FROM_HASH:
            d.pop(k, None)
        d["plant_hash"] = self.plant.state_hash()
        return chash(d)

    def load_state_doc(self, doc: Json) -> None:
        if doc["schema_version"] != STATE_SCHEMA_VERSION:
            raise StorageError("incompatible snapshot schema_version")
        self.clock.tick = doc["tick"]
        self.seq = doc["seq"]
        self.apply_order = doc["apply_order"]
        self.clock.speed = doc["speed"]
        self.clock.paused = doc["paused"]
        self.plant.set_state(unb64(doc["plant"]))
        _rng_load(self.rng, doc["rng"])
        self._restore_robots(doc)
        self.missions.load_state(doc["missions"])
        self._reconcile_mission_robots()
        self.locks.load_state(doc["locks"])
        self.track.load_state(doc["track"])
        self.control.load_state(doc["control"])
        self.navigation.load_state(doc.get("nav") or {})
        self.control.reconcile_robot_ids(LEGACY_ROBOT_IDS, set(self.robots))
        self._next_snap_s = doc["next_snap_s"]
        self._next_sample_s = doc["next_sample_s"]
        wcs = doc.get("workcells") or ({"strainer_01": doc["workcell"]} if doc.get("workcell") else {})       # older snapshots: one cell
        for bid, wc in wcs.items():                    # snapshots written before a cell was persisted simply start with a fresh cell
            bay = self.bays.get(bid)
            if bay is None:
                continue
            bay.owner = wc.get("owner") if wc.get("owner") in self.robots else None
            try:
                bay.set_state(wc["state"])
            except Exception as e:                     # noqa: BLE001
                log.warning("workcell %s state not restored (%s)", bid, type(e).__name__)
        self.manipulators.load_state(doc.get("manipulators") or {})
        self._invalidate()

    def recover_from_storage(self) -> Json:
        """Resume a run that already has history in storage (process restart). State comes from the latest snapshot
        (plant, robots, missions, locks, incidents, leases); seq / apply_order continue from the persisted maxima so the
        ledger stays append-only. Commands applied AFTER that snapshot belong to the abandoned timeline and are not treated
        as idempotent duplicates (their effects were lost), they are simply re-issuable. Returns an info dict."""
        info: Json = {"restored": False}
        st = self.storage
        if st is None or self.replay:
            return info
        try:
            run = st.get_run(self.run_id)
        except Exception as e:                                   # noqa: BLE001
            info["error"] = f"{type(e).__name__}"
            return info
        if not run or not (run.get("last_seq") or 0):
            return info
        snap = st.latest_snapshot(self.run_id)
        base_seq = int(run.get("last_seq") or 0)
        base_order = int(run.get("last_apply_order") or 0)
        stale_from = 0
        if snap:
            doc = json.loads(zlib.decompress(snap["state"]))
            if doc.get("topology_hash") != self.topology_revision:
                info.update(reason="topology_changed", snapshot_topology=doc.get("topology_hash"))
            else:
                self.load_state_doc(doc)
                stale_from = int(doc.get("apply_order", 0))
                info.update(restored=True, snapshot_tick=doc["tick"], snapshot_seq=doc["seq"], snapshot_reason=snap.get("reason"))
        else:
            info["reason"] = "no_snapshot"
        self.seq = max(self.seq, base_seq)
        self.apply_order = max(self.apply_order, base_order)
        self.bus.base_seq = self.seq
        self._rebuild_comm_keys()
        self.commands.stale_from_apply_order = stale_from       # ledger rows with a higher apply_order are not duplicates
        info.update(continued_seq=self.seq, continued_apply_order=self.apply_order, lost_ticks=max(0, int(run.get("last_tick") or 0) - self.tick))
        self.recovery_info = info
        log.warning("run %s recovered from storage: %s", self.run_id, info)
        self._robots_dirty = set(self.robots)
        return info

    def _rebuild_comm_keys(self) -> None:
        """After a restart the dedupe keys of already-persisted communication events are reloaded, so a re-emitted task / tool / verification
        state does not produce a second record of the same boundary."""
        keys: set[str] = set()
        try:
            after = 0
            for _ in range(200):
                rows = self.storage.load_communications(self.run_id, after_seq=after, limit=1000)
                if not rows:
                    break
                keys.update(k for k in ((r["payload"].get("payload") or {}).get("key") for r in rows) if k)
                after = int(rows[-1]["seq"])
        except Exception:                                    # noqa: BLE001
            log.warning("could not reload communication dedupe keys; duplicates are possible after this restart", exc_info=True)
        self.comms.rebuild(keys)

    def _restore_robots(self, doc: Json) -> None:
        """Reconcile persisted robot state against the registry (the registry wins; never add, duplicate or resurrect ids):
        legacy ids are migrated to their V4 id unless the V4 id is also present, unknown/stale ids are dropped."""
        saved = doc["robots"]
        for rid in self.robots:
            st = saved.get(rid)
            if st is None:
                for old, new in LEGACY_ROBOT_IDS.items():
                    if new == rid and old in saved:
                        st = {**saved[old], "id": rid}
            if st is not None:
                self.robots[rid].load_state(st)
        dropped = sorted(r for r in saved if r not in self.robots and LEGACY_ROBOT_IDS.get(r) not in self.robots)
        if dropped:
            log.warning("restore: dropped %d stale robot rows not in the registry: %s", len(dropped), dropped)

    def _reconcile_mission_robots(self) -> None:
        mm = self.missions
        for m in mm.missions.values():
            m["robot_id"] = LEGACY_ROBOT_IDS.get(m["robot_id"], m["robot_id"])
        q: dict[str, list] = {}
        for rid, ids in mm.queues.items():
            rid = LEGACY_ROBOT_IDS.get(rid, rid)
            if rid in self.robots:
                q.setdefault(rid, []).extend(i for i in ids if i not in q.get(rid, []))
        mm.queues = q

    def take_snapshot(self, reason: str) -> Json | None:
        if self.replay:
            return None
        self.publish_diff()
        self.publish_poses()
        doc = self.state_doc()
        world = self.world()
        world["last_seq"] = self.seq
        blob = canon(doc).encode()
        row = {"snapshot_id": new_uuid(), "tick": self.tick, "last_seq": self.seq, "reason": reason, "state": __import__("zlib").compress(blob, 3),
               "world": world, "rng_state": {"engine": doc["rng"]}, "schema_version": STATE_SCHEMA_VERSION, "engine_version": ENGINE_VERSION,
               "content_hash": sha256_hex(blob), "world_hash": world_hash(world), "state_hash": self.state_hash()}
        try:
            maintenance.POLICY.observe(len(row["state"]) + len(json.dumps(world, default=str)))     # sizes the snapshot cadence (storage budget)
        except Exception:                                                                            # noqa: BLE001
            pass
        self.pending_snaps.append(row)
        self.emit_internal("world.snapshot", self.facility_id, {"snapshot_id": row["snapshot_id"], "tick": row["tick"], "reason": reason,
                                                                  "world_hash": row["world_hash"], "state_hash": row["state_hash"]})
        return row

    # ================================================================ tick
    def _auto_approvals(self) -> None:
        for aid in self.track.due_auto_approvals(self.sim_time):
            inc, err = self.track.decide(aid, True, by="auto:veto_window")
            if inc:
                self.emit_internal("incident.updated", inc["id"], {"incident": clone(inc)}, actor_type="system")

    def tick_once(self) -> bool:
        """One fixed physics step. Returns False (and does not advance) if the plant failed: fail closed."""
        self.control.on_tick()
        self._auto_approvals()
        try:
            self.plant.step(self.dt)
            self._phys_fail = 0
            self.physics_err = None
        except Exception as e:
            self._phys_fail += 1
            self.physics_err = type(e).__name__
            self._invalidate()
            log.error("plant.step failed (%s) x%d", self.physics_err, self._phys_fail)
            if self._phys_fail >= 5 and not self.paused:
                self.commands.process({"command_id": f"sys-physpause-{self.tick}-{self.seq}", "kind": "internal.degraded_pause",
                                       "args": {"reason": "physics_failure"}}, internal=True)
            return False
        self.clock.tick += 1
        self._invalidate()
        self.manipulators.on_tick()                   # arms ease toward their targets; carried objects follow the end effector (before the cells step)
        for bay in self.bays.values():
            owner = self.robots.get(bay.owner) if bay.owner else None
            if owner is not None:
                # run the cell for the whole engine tick (not one 20 ms step per 0.5 s tick) with the base following the ENGINE's rover pose
                bay.advance_with_base(self.dt, owner.pos[0], owner.pos[2], owner.yaw)
            else:
                bay.step()                            # idle cell: objects just settle under gravity
        self.missions.advance(self.dt)
        self.navigation.on_tick()
        if self.sim_time >= self._next_sample_s:
            self._sample()
            self._next_sample_s = self.sim_time + self.cfg.sample_interval_s
        if not self.replay:
            if self.sim_time >= self._next_snap_s:
                self.take_snapshot("interval")
                self._next_snap_s = self.sim_time + maintenance.POLICY.interval_s(self.cfg.snapshot_interval_s, self.clock.speed)
        return True

    def _sample(self) -> None:
        truth = self.assets_truth()
        self.hist_t.append(self.sim_time)
        for aid, st in truth.items():
            for metric, v in (st.get("readings") or {}).items():
                if not isinstance(v, (int, float)) or v != v:
                    continue
                k = f"{aid}.{metric}"
                arr = self.hist.get(k)
                if arr is None:
                    arr = [v] * (len(self.hist_t) - 1)
                    self.hist[k] = arr
                arr.append(v)
                if len(arr) > self.cfg.history_len:
                    del arr[0]
                if not self.replay:
                    self.pending_samples.append({"tick": self.tick, "sim_time_s": self.sim_time, "sensor_id": aid, "metric": metric, "value": float(v)})
        if len(self.hist_t) > self.cfg.history_len:
            del self.hist_t[0]

    def _maybe_snapshot_request(self) -> None:
        if self._snap_request and not self.replay:
            self.take_snapshot(self._snap_request)
        self._snap_request = None

    # ================================================================ commit
    def _collect_batch(self) -> tuple[CommitBatch, Json]:
        b = CommitBatch(run_id=self.run_id, facility_id=self.facility_id, leader_epoch=self.leader_epoch)
        marks: Json = {"events": len(self.pending_events), "snaps": len(self.pending_snaps), "samples": len(self.pending_samples)}
        # Stream-only telemetry is persisted at a one-minute cadence instead of every tick: `world.diff` carries the whole asset table (5.5 KB, 11 000 rows /
        # 61 MB in 2.5 h on Neon) and replay is rebuilt from snapshots + the discrete events, never from these. Discrete events are all kept.
        b.events = [e for e in self.pending_events if self._persist_event(e)]
        b.snapshots = list(self.pending_snaps)
        b.sensor_samples = list(self.pending_samples)
        b.commands = list(self.commands.dirty.values())
        marks["cmds"] = list(self.commands.dirty)
        b.missions = [{"mission_id": m["id"], "incident_id": m.get("incident_id"), "robot_id": m["robot_id"], "target_id": m["target_id"],
                       "status": m["status"], "progress": m["progress"], "outcome": m.get("outcome"), "opened_tick": m["opened_tick"],
                       "closed_tick": m.get("closed_tick"), "doc": clone(m)} for mid in sorted(self.missions.dirty) for m in [self.missions.missions[mid]]]
        marks["missions"] = set(self.missions.dirty)
        rd = sorted(self._robots_dirty)
        for rid in rd:
            r = self.robots[rid]
            c = r.to_contract()
            c["control"] = self.control.view(rid)
            b.robots.append({"robot_id": rid, "robot_class": r.klass, "location": c["pose"], "health": {"battery_pct": c["battery_pct"]},
                             "battery_pct": c["battery_pct"], "mode": r.mode, "mission_id": r.mission_id, "control": c["control"],
                             "doc": c, "updated_tick": self.tick})
        marks["robots"] = set(rd)
        b.incidents = [{"incident_id": i, "opened_tick": self.track.incidents[i]["opened_tick"], "updated_tick": self.track.incidents[i].get("updated_tick", self.tick),
                        "severity": self.track.incidents[i]["severity"], "status": self.track.incidents[i]["status"],
                        "closed_tick": self.track.incidents[i].get("closed_tick"), "close_reason": self.track.incidents[i].get("close_reason"),
                        "doc": clone(self.track.incidents[i])} for i in sorted(self.track.dirty_incidents)]
        marks["inc"] = set(self.track.dirty_incidents)
        b.agent_runs = [{"task_id": t, "thread_id": f"{self.run_id}:{self.track.tasks[t].get('incident_id')}", "parent_task_id": self.track.tasks[t].get("parent_id"),
                         "incident_id": self.track.tasks[t].get("incident_id"), "role": self.track.tasks[t]["role"],
                         "provider": (self.track.tasks[t].get("model") or {}).get("provider"), "model": (self.track.tasks[t].get("model") or {}).get("model_id"),
                         "started_tick": self.track.tasks[t].get("started_tick"), "ended_tick": self.track.tasks[t].get("ended_tick"),
                         "state": clone(self.track.tasks[t])} for t in sorted(self.track.dirty_tasks)]
        marks["tasks"] = set(self.track.dirty_tasks)
        b.verification_runs = [{"verification_id": v, "incident_id": self.track.verifications[v]["incident_id"], "attempt": self.track.verifications[v]["attempt"],
                                "status": self.track.verifications[v]["status"], "confidence": self.track.verifications[v].get("confidence"),
                                "failed_reason": self.track.verifications[v].get("failed_reason"), "checks": clone(self.track.verifications[v].get("checks", [])),
                                "doc": clone(self.track.verifications[v])} for v in sorted(self.track.dirty_verifications)]
        marks["ver"] = set(self.track.dirty_verifications)
        b.contracts = [{"contract_id": self.track.contracts[i]["id"], "incident_id": i, "version": self.track.contracts[i]["version"],
                        "state": self.track.contracts[i]["state"], "terminal_state": self.track.contracts[i].get("terminal_state"),
                        "frozen_hash": self.track.contracts[i].get("frozen_hash"), "frozen_tick": self.track.contracts[i].get("frozen_tick"),
                        "updated_tick": self.tick, "doc": clone(self.track.contracts[i])} for i in sorted(self.track.dirty_contracts)]
        marks["contracts"] = set(self.track.dirty_contracts)
        b.leases = [clone(self.control.leases[l]) for l in sorted(self.control.dirty)]
        marks["leases"] = set(self.control.dirty)
        b.applied_effects = list(self.missions.new_effects)
        marks["effects"] = len(self.missions.new_effects)
        nroutes, nres = self.navigation.drain()
        b.routes, b.reservations = nroutes, nres
        marks["nav"] = (nroutes, nres)
        b.run_update = {"last_tick": self.tick, "last_seq": self.seq, "last_apply_order": self.apply_order, "sim_speed": self.clock.speed,
                        "nav_graph_revision": self.navigation.graph_revision}
        return b, marks

    def _clear_marked(self, marks: Json) -> None:
        del self.pending_events[: marks["events"]]
        del self.pending_snaps[: marks["snaps"]]
        del self.pending_samples[: marks["samples"]]
        for c in marks["cmds"]:
            self.commands.dirty.pop(c, None)
        self.missions.dirty -= marks["missions"]
        self._robots_dirty -= marks["robots"]
        self.track.dirty_incidents -= marks["inc"]
        self.track.dirty_tasks -= marks["tasks"]
        self.track.dirty_verifications -= marks["ver"]
        self.track.dirty_contracts -= marks["contracts"]
        self.control.dirty -= marks["leases"]
        del self.missions.new_effects[: marks["effects"]]
        if marks.get("nav"):
            self.navigation.drained(*marks["nav"])

    def _persist_event(self, e: Json) -> bool:
        """Discrete events always; stream-only telemetry once per sim minute, plus each robot's first pose of the run (a stamped baseline)."""
        if e["kind"] not in STREAM_ONLY_KINDS or e["tick"] % STREAM_PERSIST_EVERY_TICKS == 0:
            return True
        if e["kind"] == "robot.pose" and e.get("entity_id") not in self._pose_baseline:
            self._pose_baseline.add(e.get("entity_id"))
            return True
        return False

    async def commit(self) -> bool:
        """Persist everything pending atomically, then publish the committed events. Returns durability."""
        if self.replay or self.storage is None:
            return True
        self._maybe_snapshot_request()
        batch, marks = self._collect_batch()
        # the LIVE stream gets every event of this commit, stream-only telemetry included: `batch.events` is only the subset worth persisting
        # (heartbeat / world.diff / robot.pose are thinned for storage). Publishing the subset left permanent seq gaps on the wire, so clients saw
        # no heartbeats or diffs and a resync snapshot at every gap.
        events = list(self.pending_events[: marks["events"]])
        failure: StorageError | None = None
        attempts = 1 if self.db_down else COMMIT_ATTEMPTS        # already down: the loop itself is the retry (one probe per iteration)
        for attempt in range(attempts):
            try:
                if self.storage.kind == "memory":
                    self.storage.commit(batch)
                else:
                    await asyncio.to_thread(self.storage.commit, batch)
                failure = None
                break
            except LeadershipLost:
                self.fenced = True
                self.clock.pause()
                self.db_down = False
                log.error("leadership lost: engine fenced (run %s)", self.run_id)
                return False
            except StorageError as e:                    # the batch is idempotent (ON CONFLICT everywhere): retry quickly before halting physics
                failure = e
                if attempt + 1 < attempts:
                    await asyncio.sleep(COMMIT_RETRY_BASE_S * (attempt + 1))
        if failure is not None:
            if not self.db_down:
                log.error("%s: halting physics until storage recovers (after %d attempts)", failure, attempts)
            self.db_down = True
            return False
        if self.db_down:
            log.info("storage recovered")
        self.db_down = False
        self._clear_marked(marks)
        self.bus.publish([to_envelope(self.run_id, e) for e in events])
        return True

    # ================================================================ public async API
    async def submit(self, cmd: Json, *, principal: str | None = None, actor_type: str | None = None) -> Json:
        if self.fenced:
            return {"command_id": (cmd or {}).get("command_id") if isinstance(cmd, dict) else None, "accepted": False,
                    "reason": "engine_fenced: another process is the writer"}
        raw = dict(cmd) if isinstance(cmd, dict) else cmd
        if isinstance(raw, dict):
            if principal is not None:
                raw["issuer"] = principal
            else:
                raw.pop("issuer", None)
            raw.pop("principal", None)      # identity is the `principal=` argument only: a `principal` key inside the body never impersonates
            if actor_type is not None:
                raw["actor_type"] = actor_type
            else:
                raw.pop("actor_type", None)
        async with self._lock:
            if self.db_down and isinstance(raw, dict) and raw.get("kind") not in ("pause", "control.drive", "control.heartbeat"):
                # evidence cannot be persisted: refuse (not recorded, so the same command_id can be re-sent once storage is back) instead of applying
                # a change in memory that the ledger and event log would not hold
                return {"command_id": raw.get("command_id"), "accepted": False, "durable": False,
                        "reason": "database_unavailable: command refused until evidence can be persisted"}
            ack = self.commands.process(raw, actor_default=actor_type)
            self.publish_poses()
            spec_fast = isinstance(raw, dict) and raw.get("kind") in ("control.drive", "control.heartbeat")
            if not spec_fast:
                durable = await self.commit()
                if not durable and ack.get("accepted"):
                    ack["durable"] = False            # applied in memory, persisted when storage recovers: callers must surface this
        return ack

    def as_actor(self, actor_type: str, principal: str | None = None) -> "ActorView":
        return ActorView(self, actor_type, principal or actor_type)

    # ---- manual-control lifecycle helpers used by the API ----------------------
    async def end_lease(self, lease_id: str, reason: str = "disconnect") -> Json:
        """Called by the API when the browser disconnects / hides: zero velocity + SAFE_HOLD, reason-coded."""
        reason_map = {
            "disconnect": "client_disconnect",
            "hidden": "client_hidden",
            "safety": "safety_interlock",
            "expired": "lease_expired",
            "deadman": "deadman_timeout",
            "released": "operator_release",
        }
        reason = reason_map.get(reason, reason)
        if reason not in ("operator_release", "deadman_timeout", "lease_expired", "client_hidden", "client_disconnect", "link_lost", "safety_interlock", "low_battery", "operator_stop", "safe_hold_timeout", "resume_blocked"):
            reason = "client_disconnect"
        async with self._lock:
            ack = self.commands.process({"command_id": f"sys-end-{lease_id}-{self.seq}", "kind": "internal.end_lease",
                                         "args": {"lease_id": lease_id, "reason": reason}}, internal=True)
            await self.commit()
        return ack

    def lease_view(self, lease_id: str, principal: str | None = None) -> Json | None:
        l = self.control.leases.get(lease_id)
        if not l or (principal is not None and l["principal_id"] != principal):
            return None
        return {k: l[k] for k in ("lease_id", "robot_id", "principal_id", "epoch", "status", "granted_tick", "expires_at", "ended_reason")}

    # ================================================================ loop
    async def start(self) -> None:
        if self._task:
            return
        self._stop = False
        self._robots_dirty = set(self.robots)
        if self.agents is not None:
            await self.agents.start(self.as_actor("agent", "agent"))
            open_inc = self.track.open_incidents()
            if open_inc:
                await self.agents.resume(open_inc)
        self._task = asyncio.create_task(self._run(), name=f"engine-{self.run_id}")

    async def stop(self) -> None:
        self._stop = True
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=10)
            except Exception:
                self._task.cancel()
            self._task = None
        if self._agent_task and not self._agent_task.done():
            self._agent_task.cancel()
        if self.agents is not None:
            try:
                await self.agents.stop()
            except Exception:
                log.exception("agent runtime stop failed")
        async with self._lock:
            if not self.fenced and not self.db_down:
                self.comms.run_end("engine stopped")
                self.take_snapshot("shutdown")
            await self.commit()
        self.bus.close_all()

    async def step_ticks(self, n: int, commit: bool = True) -> None:
        """Deterministic manual stepping (tests / headless): n ticks, as one loop iteration without wall pacing."""
        async with self._lock:
            for _ in range(n):
                if not self.tick_once():
                    break
                self._maybe_snapshot_request()
            self._cadence(force=True)
            if commit:
                await self.commit()

    def _cadence(self, force: bool = False) -> None:
        now = self.clock.wall()
        c = self._last_cad
        if force or now - c["pose"] >= self.cfg.pose_period_s:
            c["pose"] = now
            self.publish_poses()
        if force or now - c["diff"] >= self.cfg.diff_period_s:
            c["diff"] = now
            self.publish_diff()
        if force or now - c["health"] >= self.cfg.health_period_s:
            c["health"] = now
            self.publish_health()
        if force or now - c["hb"] >= self.cfg.heartbeat_period_s:
            c["hb"] = now
            self.publish_heartbeat()

    def _wall_monitor(self) -> None:
        """Deadman / lease TTL are wall-clock; each expiry is applied as a LOGGED internal command (replayable)."""
        for lid, why in self.control.due_expiries(self.wall_time()):
            self.commands.process({"command_id": f"sys-{why}-{lid}", "kind": "internal.end_lease",
                                   "args": {"lease_id": lid, "reason": why}}, internal=True)

    async def _run(self) -> None:
        try:
            while not self._stop and not self.fenced:
                async with self._lock:
                    self._wall_monitor()
                    n = 0 if self.db_down else self.clock.due_ticks()
                    for _ in range(n):
                        if not self.tick_once():
                            break
                        self._maybe_snapshot_request()
                    self._cadence()
                    await self.commit()
                await self._maybe_agent_tick()
                await asyncio.sleep(self.cfg.loop_period_s)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("engine loop crashed (run %s)", self.run_id)
            raise

    async def _maybe_agent_tick(self) -> None:
        if self.agents is None:
            return
        now = self.clock.wall()
        if now - self._last_cad["agent"] < self.cfg.agent_tick_period_s:
            return
        if self._agent_task and not self._agent_task.done():
            return
        self._last_cad["agent"] = now
        evs = self.bus.since(self._agent_cursor, 5000) or []
        if evs:
            self._agent_cursor = evs[-1]["seq"]
        world = self.world()

        async def _go() -> None:
            try:
                await self.agents.on_tick(world, evs)
            except Exception:
                log.exception("agent runtime on_tick failed")

        self._agent_task = asyncio.create_task(_go())


class ActorView:
    """EngineFacade handed to agents: commands are pinned to actor_type='agent' (agents can never approve their own
    high-impact actions); emit() is restricted to agent event types."""

    def __init__(self, eng: Engine, actor_type: str, principal: str):
        self._e, self._actor, self._principal = eng, actor_type, principal

    @property
    def run_id(self) -> str: return self._e.run_id
    @property
    def storage(self) -> Any: return self._e.storage                  # read-only: shared-brain memory hooks locate their store through the engine
    @property
    def facility_id(self) -> str: return self._e.facility_id
    @property
    def topology_revision(self) -> str: return self._e.topology_revision

    def world(self) -> Json: return self._e.world()
    @property
    def navigation(self) -> Any: return self._e.navigation          # deterministic route planning / scoring (read-only use by agents)
    def topology(self) -> Json: return self._e.topology()
    def comm_provider(self, phase: str, **kw: Any) -> None: self._e.comms.provider_event(phase, **kw)       # V10: real provider start / finish / error
    def comm_safety_block(self, **kw: Any) -> None: self._e.comms.safety_block(**kw)                         # V10: policy-refused agent command
    async def submit(self, cmd: Json) -> Json: return await self._e.submit(cmd, principal=self._principal, actor_type=self._actor)
    def emit(self, type: str, entity_id: str, payload: Json) -> Json: return self._e.emit(type, entity_id, payload)
    def events_since(self, seq: int, limit: int = 1000) -> list: return self._e.events_since(seq, limit)
    def subscribe(self) -> Subscription: return self._e.subscribe()
    def plan_route(self, *a: Any, **k: Any) -> Json: return self._e.plan_route(*a, **k)
    def telemetry(self, *a: Any, **k: Any): return self._e.telemetry(*a, **k)
    def record_decision(self, *a: Any, **k: Any): return self._e.record_decision(*a, **k)


def _rng_dump(r: random.Random) -> list:
    v, internal, g = r.getstate()
    return [v, list(internal), g]


def _rng_load(r: random.Random, st: list) -> None:
    r.setstate((st[0], tuple(st[1]), st[2]))
