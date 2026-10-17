"""In-test EngineFacade double (NOT physics, NOT the real engine).

Serves contract-shaped fixtures dumped from the TypeScript mock (tests/fixtures/*.json) and implements just
enough single-writer behaviour to exercise the API: ordered seq, idempotent submit, subscribe/events_since,
a control-lease state machine with a deadman (driven by an injectable clock), pause/resume/speed.
Reports ``backend: "mock"`` / ``intelligence.status: "mock"`` so nothing here can pass for the live system.
"""
from __future__ import annotations

import asyncio
import copy
import json
import threading
import uuid
from pathlib import Path
from typing import Any, Optional

FIX = Path(__file__).resolve().parent.parent / "fixtures"
Json = dict[str, Any]


def load_fixture(name: str) -> Any:
    return json.loads((FIX / f"{name}.json").read_text())


class FakeSubscription:
    """Thread-safe: tests emit from the main thread while the API consumes on its own event loop."""

    def __init__(self, owner: "FakeEngine") -> None:
        self._owner = owner
        self._lock = threading.Lock()
        self._pre: list[Optional[Json]] = []
        self._q: Optional[asyncio.Queue] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self) -> Json:
        if self._q is None:
            with self._lock:
                self._loop = asyncio.get_running_loop()
                self._q = asyncio.Queue()
                for ev in self._pre:
                    self._q.put_nowait(ev)
                self._pre = []
        ev = await self._q.get()
        if ev is None:
            raise StopAsyncIteration
        return ev

    def _put(self, ev: Optional[Json]) -> None:
        with self._lock:
            if self._q is None:
                self._pre.append(ev)
            else:
                self._loop.call_soon_threadsafe(self._q.put_nowait, ev)  # type: ignore[union-attr]

    def push(self, ev: Json) -> None:
        if not self.closed:
            self._put(ev)

    def close(self) -> None:
        self.closed = True
        self._owner._subs.discard(self)
        self._put(None)


class FakeEngine:
    LEASE_TTL_S = 1.5

    def __init__(self, *, run_id: str = "run_live", retention: Optional[int] = None, seed_events: bool = True) -> None:
        self.run_id = run_id
        self._topo = load_fixture("topology")
        self._world = load_fixture("world")
        self._log: list[Json] = []
        self._seq = 0
        self._subs: set[FakeSubscription] = set()
        self._acks: dict[str, Json] = {}
        self._leases: dict[str, Json] = {}          # robot_id -> lease
        self._epoch = 0
        self.retention = retention                  # keep only the last N events (simulates a log gap)
        self.submitted: list[Json] = []             # every command the API sent (tests assert "only submit")
        self.drop_next_n = 0                        # live subscription drops (gap simulation)
        self.now = float(self._world["sim_time_s"])
        self._world["last_seq"] = 0
        if seed_events:
            for ev in load_fixture("events"):
                self.emit(ev["type"], ev["entity_id"], ev["payload"], sim_tick=ev["sim_tick"], sim_time_s=ev["sim_time_s"])

    # ---- EngineFacade ------------------------------------------------
    def world(self) -> Json:
        w = copy.deepcopy(self._world)
        w["last_seq"] = self._seq
        w["sim_time_s"] = self.now
        return w

    def topology(self) -> Json:
        return copy.deepcopy(self._topo)

    def emit(self, type: str, entity_id: str, payload: Json, *, sim_tick: Optional[int] = None, sim_time_s: Optional[float] = None) -> Json:
        self._seq += 1
        ev = {
            "event_id": f"ev_{self._seq:06d}", "seq": self._seq,
            "sim_tick": sim_tick if sim_tick is not None else self._world["sim_tick"],
            "sim_time_s": sim_time_s if sim_time_s is not None else self.now,
            "world_version": self._world["version"], "type": type, "entity_id": entity_id,
            "facility_id": self._world["facility_id"], "ts": "2026-10-16T00:00:00.000Z",
            "payload": copy.deepcopy(payload),
        }
        self._log.append(ev)
        if self.retention is not None and len(self._log) > self.retention:
            del self._log[: len(self._log) - self.retention]
        self._world["last_seq"] = self._seq
        for s in list(self._subs):
            if self.drop_next_n > 0:
                self.drop_next_n -= 1
                continue
            s.push(copy.deepcopy(ev))
        return ev

    def events_since(self, seq: int, limit: int = 1000) -> list[Json]:
        return [copy.deepcopy(e) for e in self._log if e["seq"] > seq][:limit]

    def subscribe(self) -> FakeSubscription:
        s = FakeSubscription(self)
        self._subs.add(s)
        return s

    async def submit(self, cmd: Json) -> Json:
        self.submitted.append(copy.deepcopy(cmd))
        cid = cmd.get("command_id", "")
        if cid in self._acks:
            return copy.deepcopy(self._acks[cid])
        ack = self._handle(cmd)
        ack["command_id"] = cid
        self._acks[cid] = ack
        return copy.deepcopy(ack)

    # ---- command handling (toy rules; real engine validates physics) ----
    def _handle(self, cmd: Json) -> Json:
        k, a, target = cmd["kind"], cmd.get("args") or {}, cmd.get("target_id")
        if k in ("approve_action", "hold_action"):
            inc = next((i for i in self._world["incidents"] if (i.get("approval") or {}).get("id") == target), None)
            return {"accepted": inc is not None, **({} if inc else {"reason": "no pending approval with that id"})}
        if k == "set_sim_speed":
            s = a.get("speed")
            if not (0.5 <= s <= 60):
                return {"accepted": False, "reason": "speed must be between 0.5 and 60"}
            self._world["sim_speed"] = s
            return {"accepted": True}
        if k in ("pause", "resume"):
            self._world["sim_status"] = "paused" if k == "pause" else "running"
            self.emit("engine.health", self._world["facility_id"], {"health": self._world["health"]})
            return {"accepted": True}
        if k == "test.inject_fault":
            return {"accepted": True}
        if k.startswith("robot."):
            return self._robot(cmd)
        return {"accepted": False, "reason": f"unknown command kind {k}"}

    def _control_info(self, rid: str, lease: Optional[Json], state: str, last_reason: Optional[str] = None) -> Json:
        held = lease is not None
        info = {
            "authority": "HUMAN" if state == "MANUAL" else ("STOP" if state == "SAFE_HOLD" else "AUTO"),
            "controller_state": state, "controllable": True, "lease_epoch": lease["lease_epoch"] if held else self._epoch,
            "facing": 1, "velocity_m_s": 0.0, "lamp": False, "last_applied_seq": lease["last_seq"] if held else 0,
            "tools": [{"id": "lamp", "label": "Lamp", "available": True}], "odometer_m": lease["odo"] if held else 0.0,
        }
        if held:
            info.update(lease_id=lease["lease_id"], holder=lease["principal"])
        if last_reason:
            info["last_reason"] = last_reason
        return info

    def _robot(self, cmd: Json) -> Json:
        k, a, rid = cmd["kind"], cmd.get("args") or {}, cmd["target_id"]
        robot = self._world["robots"].get(rid)
        if robot is None:
            return {"accepted": False, "code": "unknown_robot", "reason": "unknown robot"}
        cur = self._leases.get(rid)
        if k == "robot.control.acquire":
            if robot["class"] != "inpipe" or robot["mode"] in ("WORKING", "FAILED", "VERIFYING"):
                return {"accepted": False, "code": "not_controllable", "reason": "robot is not drivable right now"}
            if a.get("expected_world_version") is not None and a["expected_world_version"] > self._world["version"] + 10_000:
                return {"accepted": False, "code": "stale_world_version", "reason": "world version mismatch",
                        "current_world_version": self._world["version"]}
            if cur and cur["expires_at_s"] > self.now and cur["principal"] != cmd["principal"]:
                return {"accepted": False, "code": "lease_held", "reason": "robot already under manual control", "holder": "another operator"}
            self._epoch += 1
            ttl = self.LEASE_TTL_S
            lease = {"lease_id": str(uuid.uuid4()), "lease_epoch": self._epoch, "principal": cmd["principal"], "ttl_s": ttl,
                     "expires_at_s": self.now + ttl, "last_seq": 0, "odo": 0.0}
            self._leases[rid] = lease
            control = self._control_info(rid, lease, "MANUAL")
            self.emit("robot.control", rid, {"robot_id": rid, "event": "human.override", "control": control})
            return {"accepted": True, "robot_id": rid, "lease_id": lease["lease_id"], "lease_epoch": self._epoch,
                    "granted_world_version": self._world["version"], "expires_in_ms": 5000,
                    "heartbeat_interval_ms": int(ttl * 1000 / 3), "deadman_ms": int(ttl * 1000),
                    "limits": {"max_speed_m_s": 0.3, "max_accel_m_s2": 0.6, "intent_ttl_ms": [20, 250], "max_intent_rate_hz": 20},
                    "topology_revision": a.get("topology_revision", "r1"), "control": control}
        if not cur or cur["lease_id"] != a.get("lease_id"):
            return {"accepted": False, "code": "no_lease", "reason": "no such active lease"}
        if cur["lease_epoch"] != a.get("lease_epoch"):
            return {"accepted": False, "code": "stale_epoch", "reason": "stale lease epoch"}
        if cur["expires_at_s"] <= self.now:
            return {"accepted": False, "code": "lease_revoked", "reason": "lease expired", "revoked_reason": "deadman_timeout"}
        if k == "robot.control.heartbeat":
            cur["expires_at_s"] = self.now + cur["ttl_s"]
            return {"accepted": True, "expires_in_ms": int(cur["ttl_s"] * 1000), "controller_state": "MANUAL"}
        if k == "robot.drive":
            if a["command_seq"] <= cur["last_seq"]:
                return {"accepted": False, "code": "stale_seq", "reason": "command_seq must increase"}
            cur["last_seq"] = a["command_seq"]
            pose = robot["pose"]
            d = float(a["throttle"]) * 0.3 * a["duration_ms"] / 1000
            pose["s_m"] = max(0.0, pose.get("s_m", 0.0) + d)
            pose["speed_m_s"] = abs(float(a["throttle"])) * 0.3
            cur["odo"] += abs(d)
            cur["expires_at_s"] = self.now + cur["ttl_s"]
            ctl = self._control_info(rid, cur, "MANUAL")
            self.emit("robot.pose", rid, {"robot_id": rid, "pose": pose, "battery_pct": robot["battery_pct"], "mode": robot["mode"], "control": ctl})
            return {"accepted": True, "robot_id": rid, "lease_epoch": cur["lease_epoch"], "applied_seq": a["command_seq"],
                    "controller_state": "MANUAL", "world_version": self._world["version"],
                    "pose": {"segment_id": pose.get("segment_id", "p_01"), "s_m": pose["s_m"], "speed_m_s": pose["speed_m_s"],
                             "velocity_m_s": float(a["throttle"]) * 0.3, "facing": 1, "position_xyz_m": pose["position_xyz_m"]},
                    "odometer_m": cur["odo"]}
        if k == "robot.control.release":
            del self._leases[rid]
            control = self._control_info(rid, None, "AUTONOMOUS", a.get("reason") or "operator_release")
            self.emit("robot.control", rid, {"robot_id": rid, "event": "agent.resumed", "reason": a.get("reason") or "operator_release", "control": control})
            return {"accepted": True, "robot_id": rid, "controller_state": "AUTONOMOUS", "resumed": "none", "control": control}
        return {"accepted": False, "code": "bad_request", "reason": "unknown robot command"}

    # ---- test drivers --------------------------------------------------
    def advance(self, dt_s: float) -> None:
        """Advance the fake clock; expired leases trip the deadman (zero velocity -> SAFE_HOLD)."""
        self.now += dt_s
        self._world["sim_tick"] += int(dt_s * 2)
        self._world["version"] = self._world["sim_tick"]
        for rid, lease in list(self._leases.items()):
            if lease["expires_at_s"] <= self.now:
                del self._leases[rid]
                r = self._world["robots"][rid]
                r["mode"] = "SAFE_HOLD"
                r["pose"]["speed_m_s"] = 0.0
                self.emit("robot.control", rid, {"robot_id": rid, "event": "safe_hold", "reason": "deadman_timeout",
                                                 "control": self._control_info(rid, None, "SAFE_HOLD", "deadman_timeout")})
                self.emit("robot.pose", rid, {"robot_id": rid, "pose": r["pose"], "battery_pct": r["battery_pct"], "mode": "SAFE_HOLD"})

    def tick(self) -> Json:
        """Emit one world.diff (all readings) like the real engine's ~2 Hz publisher."""
        w = self._world
        diff = {k: {"status": v["status"], "readings": v["readings"]} for k, v in w["assets"].items()}
        return self.emit("world.diff", w["facility_id"], {"assets": diff, "kpis": w["kpis"], "sim_speed": w["sim_speed"], "sim_status": w["sim_status"]})

    def set_intelligence(self, status: str, provider: str = "crusoe", model_id: str = "nemotron-test") -> None:
        self._world["health"]["intelligence"] = {"provider": provider, "model_id": model_id, "status": status}

    def set_health(self, **kw: Any) -> None:
        self._world["health"].update(kw)


class FakeRuntime:
    """AgentRuntime.model_status() double."""

    def __init__(self, status: str = "live", provider: str = "crusoe", model_id: str = "nemotron-test") -> None:
        self.status, self.provider, self.model_id = status, provider, model_id
        self.raises = False

    def model_status(self) -> Json:
        if self.raises:
            raise RuntimeError("probe failed key=sk-abcdefghijklmnopqrstuvwxyz")
        return {"provider": self.provider, "model_id": self.model_id, "status": self.status, "api_key": "sk-should-never-leak-0123456789"}
