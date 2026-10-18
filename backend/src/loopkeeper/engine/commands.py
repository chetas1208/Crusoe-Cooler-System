"""Command bus: idempotent by command_id, strictly validated (pydantic extra=forbid), permissioned by actor,
precondition-checked, and fully ledgered. Runs inside the single writer (no awaits)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable

from . import schemas as S
from .util import Json, clone, valid_id

if TYPE_CHECKING:  # pragma: no cover
    from .core import Engine

TOP_KEYS = {
    "command_id", "kind", "target_id", "args", "issuer", "principal", "run_id",
    "actor_type", "expected_world_version", "agent_role", "incident_id", "task_id",
}
ACTORS = ("operator", "agent", "system")


@dataclass(frozen=True)
class Spec:
    model: type
    actors: tuple
    handler: str
    ledger: bool = True      # heartbeats are wall-clock liveness only: not ledgered, not replayed
    fast: bool = False       # do not await durability before acking (loop commits within one period)
    needs_target: bool = False


SPECS: dict[str, Spec] = {
    "approve_action": Spec(S.Empty, ("operator",), "_approve", needs_target=True),
    "hold_action": Spec(S.Empty, ("operator",), "_hold", needs_target=True),
    "set_sim_speed": Spec(S.SetSpeed, ("operator",), "_speed"),
    "pause": Spec(S.Empty, ("operator",), "_pause"),
    "resume": Spec(S.Empty, ("operator",), "_resume"),
    "test.inject_fault": Spec(S.InjectFault, ("operator",), "_inject"),
    "mission.create": Spec(S.MissionCreate, ("operator", "agent"), "_mission_create"),
    "robot.mission.assign": Spec(S.MissionCreate, ("operator", "agent"), "_mission_create"),
    "mission.abort": Spec(S.MissionAbort, ("operator", "agent"), "_mission_abort", needs_target=True),
    "robot.mission.cancel": Spec(S.MissionAbort, ("operator", "agent"), "_mission_abort"),
    "robot.return_home": Spec(S.Empty, ("operator", "agent"), "_return_home", needs_target=True),
    # additive (package C): make target_id the loop's duty pump (standby swap while the degraded pump is serviced)
    "pump.switch_duty": Spec(S.Empty, ("operator", "agent"), "_switch_duty", needs_target=True),
    "workload.set_load": Spec(S.SetLoad, ("operator", "agent"), "_set_load", needs_target=True),
    "control.acquire": Spec(S.Acquire, ("operator",), "_acquire"),
    "control.heartbeat": Spec(S.Heartbeat, ("operator",), "_heartbeat", ledger=False, fast=True),
    "control.release": Spec(S.Release, ("operator",), "_release"),
    "control.drive": Spec(S.Drive, ("operator",), "_drive", fast=True),
    "robot.control.acquire": Spec(S.Acquire, ("operator",), "_acquire"),
    "robot.control.heartbeat": Spec(S.Heartbeat, ("operator",), "_heartbeat", ledger=False, fast=True),
    "robot.control.release": Spec(S.Release, ("operator",), "_release"),
    "robot.drive": Spec(S.Drive, ("operator",), "_drive", fast=True),
    # V7 navigation: route commit/cancel (plans are previewed read-only through the API), graph closures (operator / test)
    "robot.route.commit": Spec(S.RouteCommit, ("operator",), "_route_commit", needs_target=True),
    "robot.route.cancel": Spec(S.RouteCancel, ("operator",), "_route_cancel", needs_target=True),
    "nav.closure.set": Spec(S.ClosureSet, ("operator",), "_closure_set"),
    # internal (never accepted from callers): wall-clock events are logged as commands so replay is deterministic
    "internal.end_lease": Spec(S.Internal, ("system",), "_i_end_lease"),
    "internal.restart_reset": Spec(S.Internal, ("system",), "_i_restart_reset"),
    "internal.degraded_pause": Spec(S.Internal, ("system",), "_i_degraded_pause"),
}


class CommandBus:
    def __init__(self, eng: "Engine"):
        self.eng = eng
        self.ledger: dict[str, Json] = {}   # session cache; storage is the durable source
        self.dirty: dict[str, Json] = {}
        self.stale_from_apply_order: int | None = None

    # ---- lookup --------------------------------------------------------
    def lookup(self, command_id: str) -> Json | None:
        rec = self.ledger.get(command_id)
        if rec is None and not self.eng.replay and self.eng.storage is not None:
            rec = self.eng.storage.get_command(self.eng.run_id, command_id)
            if rec and self.stale_from_apply_order is not None and int(rec.get("apply_order") or 0) > self.stale_from_apply_order:
                rec = None          # applied after the restored snapshot: its effects are not part of the restored state
            if rec:
                self.ledger[command_id] = rec
        return rec

    # ---- main entry ----------------------------------------------------
    def process(self, raw: Json, *, actor_default: str | None = None, internal: bool = False) -> Json:
        eng = self.eng
        if not isinstance(raw, dict):
            return {"command_id": None, "accepted": False, "reason": "command must be an object"}
        cid = raw.get("command_id")
        if not valid_id(cid):
            return {"command_id": None, "accepted": False, "reason": "invalid or missing command_id"}
        prior = self.lookup(cid)
        if prior is not None:
            return self._ack_of(prior, duplicate=True)
        extra = set(raw) - TOP_KEYS
        kind = raw.get("kind")
        spec = SPECS.get(kind) if isinstance(kind, str) else None
        actor = raw.get("actor_type")
        if actor_default and not internal:
            actor = actor_default
        if actor is None:
            actor = "agent" if kind in ("mission.create", "mission.abort", "robot.return_home", "workload.set_load") and not internal else "operator"
        if internal:
            actor = "system"
        # the API stamps the authenticated principal as `principal` (it overwrites any client value); `issuer` is set by Engine.submit
        # for in-process callers. Without this every HTTP operator was "anonymous", so leases were not exclusive across operators.
        who = raw.get("issuer") if isinstance(raw.get("issuer"), str) and valid_id(raw.get("issuer")) else (
            raw.get("principal") if isinstance(raw.get("principal"), str) and valid_id(raw.get("principal")) else None)
        issuer = who or ("engine" if internal else (actor if actor_default else "anonymous"))
        reason = None
        if extra:
            reason = "unexpected field(s): " + ", ".join(sorted(str(k)[:32] for k in extra)[:4])
        elif spec is None:
            reason = "unknown command kind"
        elif actor not in ACTORS:
            reason = "invalid actor_type"
        elif kind.startswith("internal.") and not internal:
            reason = "unknown command kind"
        elif actor not in spec.actors:
            reason = f"actor '{actor}' may not issue {kind}"
        elif kind == "test.inject_fault" and not eng.cfg.allow_test_faults:
            reason = "test controls disabled"
        target = raw.get("target_id")
        if reason is None and (target is not None and not valid_id(target)):
            reason = "invalid target_id"
        if reason is None and spec.needs_target and not target:
            reason = "target_id required"
        ewv = raw.get("expected_world_version")
        if reason is None and ewv is not None:
            if not isinstance(ewv, int) or isinstance(ewv, bool) or ewv < 0:
                reason = "invalid expected_world_version"
            elif ewv > eng.tick:
                reason = "future_world_version: client view is ahead of this run"
            elif eng.tick - ewv > eng.cfg.max_world_version_age_ticks:
                reason = "stale_world_version: refresh your view and retry"
        model = None
        if reason is None:
            model, err = S.check(spec.model, raw.get("args"))
            reason = err
        outcome: Json = {}
        accepted = False
        if reason is None:
            args = model.model_dump(exclude_none=True)
            handler: Callable = getattr(self, spec.handler)
            try:
                accepted, why, outcome = handler(args, target, issuer, cid)
            except Exception as e:   # never leak internals; fail closed
                eng.log.exception("command handler failed: %s", kind)
                accepted, why, outcome = False, f"internal_error ({type(e).__name__})", {}
            reason = None if accepted else why
        rec = {"command_id": cid, "kind": kind if isinstance(kind, str) else "?", "target_id": target, "issuer": issuer,
               "actor_type": actor, "issued_tick": eng.tick, "applied_tick": eng.tick if accepted else None,
               "apply_order": None, "seq_at_apply": eng.seq if accepted else None, "expected_world_version": ewv if isinstance(ewv, int) else None,
               "args": clone(raw.get("args") if isinstance(raw.get("args"), dict) else {}), "preconditions": {},
               "status": "accepted" if accepted else "rejected", "reason": reason, "outcome": outcome}
        if accepted:
            if spec is None or spec.ledger:
                eng.apply_order += 1
                rec["apply_order"] = eng.apply_order
        if spec is None or spec.ledger or not accepted:
            self.ledger[cid] = rec
            self.dirty[cid] = rec
        return self._ack_of(rec)

    @staticmethod
    def _ack_of(rec: Json, duplicate: bool = False) -> Json:
        ack = {"command_id": rec["command_id"], "accepted": rec["status"] != "rejected", "reason": rec.get("reason")}
        ack.update({k: v for k, v in (rec.get("outcome") or {}).items()})
        if duplicate:
            ack["duplicate"] = True
        if ack["reason"] is None:
            del ack["reason"]
        return ack

    # ---- navigation (V7) -------------------------------------------------------------------------------
    def _route_commit(self, a, target, issuer, cid):
        eng = self.eng
        nav = eng.navigation
        r = eng.robots.get(target)
        if r is None:
            return False, "UNKNOWN_ROBOT: no such robot", nav._refuse("UNKNOWN_ROBOT", f"no robot {target}")
        state = eng.control.state_of(target)
        lease_id = a.get("lease_id")
        if state == "MANUAL":
            lease = eng.control.leases.get(eng.control.ctl[target].get("lease_id") or "")
            if not lease or lease_id != lease["lease_id"] or lease["principal_id"] != issuer:
                return False, "LEASE_REQUIRED: robot is under manual control by another principal", nav._refuse("LEASE_REQUIRED", "robot is under manual control; destination mode needs the lease")
        elif state != "AUTONOMOUS":
            return False, f"ROBOT_BUSY: robot is in {state}", nav._refuse("ROBOT_BUSY", f"robot control state is {state}")
        elif eng.missions.active_mission(target) is not None or eng.missions.robot_busy_with(target):
            return False, "ROBOT_BUSY: robot has a mission", nav._refuse("ROBOT_BUSY", "robot is executing a mission; cancel it first")
        plan = nav.previews.get(a["plan_id"])
        if plan is None:
            return False, "UNKNOWN_PLAN: unknown or expired plan", nav._refuse("UNKNOWN_PLAN", "unknown or expired plan id; plan again")
        res = nav.commit(target, plan, a.get("graph_revision"), a.get("traffic_revision"), label="Operator route", mode="TRAVELING", source="operator",
                         manual=(state == "MANUAL"))
        if not res.get("ok"):
            return False, f"{res['reason']}: {res['detail']}", res
        nav.previews.pop(a["plan_id"], None)
        return True, "", res

    def _route_cancel(self, a, target, issuer, cid):
        res = self.eng.navigation.cancel(target, reason=a.get("reason", "operator"))
        if not res.get("ok"):
            return False, f"{res['reason']}: {res['detail']}", res
        return True, "", res

    def _closure_set(self, a, target, issuer, cid):
        res = self.eng.navigation.set_closed(a["edge_ids"], a.get("closed", True))
        if not res.get("ok"):
            return False, f"{res['reason']}: {res['detail']}", res
        return True, "", res

    # ---- handlers: (args, target, issuer, command_id) -> (accepted, reason, outcome) -------------------
    def _decide(self, approval_id: str, approve: bool, issuer: str, cid: str):
        eng = self.eng
        inc, err = eng.track.decide(approval_id, approve, by=f"operator:{issuer}")
        if err:
            return False, err, {}
        eng.emit_internal("incident.updated", inc["id"], {"incident": clone(inc)}, actor_type="operator", actor_id=issuer, command_id=cid)
        return True, "", {"approval_id": approval_id, "status": inc["approval"]["status"]}

    def _approve(self, a, target, issuer, cid): return self._decide(target, True, issuer, cid)
    def _hold(self, a, target, issuer, cid): return self._decide(target, False, issuer, cid)

    def _speed(self, a, target, issuer, cid):
        if not self.eng.clock.set_speed(a["speed"]):
            return False, "speed must be between 0.5 and 60", {}
        self.eng.publish_health()
        return True, "", {"sim_speed": self.eng.clock.speed}

    def _pause(self, a, target, issuer, cid):
        self.eng.clock.pause()
        self.eng.publish_health()
        return True, "", {}

    def _resume(self, a, target, issuer, cid):
        if self.eng.db_down:
            return False, "database_unavailable: cannot resume until evidence can be persisted", {}
        self.eng.clock.resume()
        self.eng.publish_health()
        return True, "", {}

    def _inject(self, a, target, issuer, cid):
        eng = self.eng
        tgt = a.get("target") or a.get("target_id") or target
        params = dict(a.get("params") or {})
        if "severity" in a and a["severity"] is not None:
            params["severity"] = a["severity"]
        args = {"kind": a["kind"], "params": params}
        if tgt:
            args["target"] = tgt
        res = eng.plant_apply("inject_fault", tgt, args)
        ok = bool(res.get("ok"))
        return ok, (None if ok else (res.get("reason") or "unsupported fault")), {"effects": res.get("effects") or {}}

    def _mission_create(self, a, target, issuer, cid):
        a = dict(a)
        if "kind" not in a and "mission_kind" in a:
            a["kind"] = a["mission_kind"]
        if "id" not in a and "mission_id" in a:
            a["id"] = a["mission_id"]
        if a.get("params"):
            a["params"] = dict(a["params"])
        if a.get("steps"):
            a["steps"] = [dict(s) for s in a["steps"]]
        ok, why, m = self.eng.missions.create(a, issuer, cid)
        return (True, "", {"mission_id": m["id"]}) if ok else (False, why, {})

    def _mission_abort(self, a, target, issuer, cid):
        mid = target or a.get("mission_id")
        ok, why = self.eng.missions.abort(mid, a.get("reason", "aborted"))
        return (True, "", {"mission_id": mid, "note": why}) if ok else (False, why, {})

    def _return_home(self, a, target, issuer, cid):
        eng = self.eng
        r = eng.robots.get(target)
        if not r:
            return False, "unknown_robot", {}
        return eng.control.send_to_dock(target, issuer, cid)         # releases a manual lease first; empty packs queue for recovery

    def _switch_duty(self, a, target, issuer, cid):
        if self.eng.physics_degraded():
            return False, "physics_degraded", {}
        res = self.eng.plant_apply("switch_duty", target, {})
        ok = bool(res.get("ok"))
        return ok, (None if ok else (res.get("reason") or "rejected by plant")), {"effects": res.get("effects") or {}}

    def _set_load(self, a, target, issuer, cid):
        eng = self.eng
        asset = eng.asset_index.get(target)
        if not asset or asset["type"] != "rack":
            return False, "target must be a rack", {}
        if eng.physics_degraded():
            return False, "physics_degraded", {}
        res = eng.plant_apply("set_load", target, {"factor": a["load_factor"]})
        ok = bool(res.get("ok"))
        return ok, (None if ok else (res.get("reason") or "rejected by plant")), {"effects": res.get("effects") or {}}

    def _acquire(self, a, target, issuer, cid):
        if not a.get("robot_id") and target:
            a["robot_id"] = target
        return self.eng.control.acquire(a, issuer, cid)

    def _heartbeat(self, a, target, issuer, cid):
        return self.eng.control.heartbeat(a, issuer)

    def _release(self, a, target, issuer, cid):
        return self.eng.control.release(a, issuer, cid)

    def _drive(self, a, target, issuer, cid):
        ok, why, out = self.eng.control.drive(a, issuer, cid)
        if not ok:
            self.eng.emit_internal("robot.drive.rejected", a.get("lease_id", "?"), {"lease_id": a.get("lease_id"), "command_seq": a.get("command_seq"), "reason": why},
                                   actor_type="operator", actor_id=issuer, command_id=cid)
        else:
            self.eng.note_drive_accepted(a["lease_id"], a["command_seq"], issuer, cid)
        return ok, why, out

    def _i_end_lease(self, a, target, issuer, cid):
        lid = a.get("lease_id")
        if not lid or lid not in self.eng.control.leases:
            return False, "unknown lease", {}
        self.eng.control.end_lease(lid, a.get("reason") or "expired", cid)
        return True, "", {}

    def _i_restart_reset(self, a, target, issuer, cid):
        for lid in self.eng.control.active_lease_ids():
            self.eng.control.end_lease(lid, "engine_restart", cid)
        return True, "", {}

    def _i_degraded_pause(self, a, target, issuer, cid):
        self.eng.clock.pause()
        self.eng.publish_health()
        return True, "", {"reason": a.get("reason", "")}
