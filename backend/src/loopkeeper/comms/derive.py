"""CommRecorder: turns the runtime's authoritative events into typed communication events (no model calls, no narration).

Hooked into ``Engine.emit_internal``: every authoritative event that is a real communication boundary (task delegation / transition, tool
started / completed / failed, verification pass / fail, safety block, approval, mission delegation + ack, operator lease / drive / release /
deadman, navigation milestones, provider start / finish / error, run end) produces EXACTLY ONE ``comm.<kind>`` world event right behind it
(same tick, next canonical seq, same commit). Summaries are templates over authoritative fields. A dedupe key (stored in ``detail.key``)
makes every boundary idempotent across repeated state emissions and restarts (the key set is rebuilt from the persisted comm events)."""
from __future__ import annotations

import logging
from typing import Any, Optional

from pydantic import ValidationError

from .schema import EVENT_PREFIX, KIND_OF_SUBTYPE, CommunicationEventV1, Party, clean_text

log = logging.getLogger("loopkeeper.comms")
Json = dict[str, Any]
DRIVE_NOTE_S = 15.0
FAIL_TOOL = ("error",)
BLOCK_TOOL = ("rejected",)


class CommRecorder:
    def __init__(self, eng: Any, enabled: bool = True) -> None:
        self.eng = eng
        self.enabled = enabled
        self.seen: set[str] = set()
        self.stats = {"emitted": 0, "deduped": 0, "invalid": 0, "dropped_fk": 0}
        self._by_kind: dict[str, int] = {}
        self._ev_seen: dict[str, int] = {}               # incident -> number of evidence entries already reported
        self._drive_t: dict[str, float] = {}
        self._nav_t: dict[str, float] = {}

    # ------------------------------------------------------------------ parties
    def agent(self, role: str, instance: str | None = None) -> Party:
        return Party(kind="agent", id=clean_text(instance or role, 96), **{"class": str(role).upper()[:24]})

    def robot(self, rid: str) -> Party:
        r = self.eng.robots.get(rid)
        return Party(kind="robot", id=rid, **{"class": (r.klass.upper() if r is not None else "SYSTEM")})

    def _seat(self, task_id: str | None) -> str | None:
        t = self.eng.track.tasks.get(task_id or "") or {}
        return t.get("agent_id") or task_id

    @staticmethod
    def operator(pid: str | None) -> Party:
        return Party(kind="operator", id=clean_text(pid or "operator", 96), **{"class": "OPERATOR"})

    @staticmethod
    def system(name: str = "engine") -> Party:
        return Party(kind="system", id=name, **{"class": "SYSTEM"})

    @staticmethod
    def provider(name: str) -> Party:
        return Party(kind="provider", id=clean_text(name, 48) or "provider", **{"class": "PROVIDER"})

    # ------------------------------------------------------------------ core
    def emit(self, *, kind: str, mtype: str, phase: str, status: str, sender: Party, summary: str, recipient: Party | None = None, key: str | None = None,
             thread: str | None = None, task_id: str | None = None, mission_id: str | None = None, incident_id: str | None = None,
             asset_id: str | None = None, robot_id: str | None = None, evidence: Any = (), model_provider: str | None = None, model_id: str | None = None,
             detail: Json | None = None, causal: str | None = None, visibility: str = "operator", actor_type: str = "system",
             actor_id: str | None = None, command_id: str | None = None) -> Optional[Json]:
        if not self.enabled:
            return None
        if key is not None:
            if key in self.seen:
                self.stats["deduped"] += 1
                return None
            self.seen.add(key)
        eng = self.eng
        if robot_id is not None and robot_id not in eng.robots:
            robot_id = None
            self.stats["dropped_fk"] += 1
        if asset_id is not None and asset_id not in eng.asset_index and asset_id not in eng.robots and asset_id not in eng.graph.edges:
            asset_id = None
            self.stats["dropped_fk"] += 1
        seq = eng.seq + 1
        d = dict(detail or {})
        if key is not None:
            d["key"] = key
        task = eng.track.tasks.get(task_id or "") or {}
        inc = eng.track.incidents.get(incident_id or task.get("incident_id") or "") or {}
        prio = {"critical": "critical", "warning": "high", "watch": "normal"}.get(str(inc.get("severity")), "normal")
        scope = {"agent": "plan", "robot": "act", "operator": "operator", "system": "system", "provider": "observe"}[sender.kind]
        if kind in ("tool_event", "verification") and sender.kind == "agent":
            scope = "observe"
        try:
            ev = CommunicationEventV1(
                message_id=f"ev_{seq:06d}", kind=KIND_OF_SUBTYPE.get(mtype, "HUMAN_OVERRIDE" if kind == "operator" else "PROGRESS"),
                parent_task_id=task.get("parent_id"), priority=prio, deadline_sim_tick=None, world_version_observed=eng.tick,
                topology_revision=str(eng.topology_revision), permission_scope=scope, idempotency_key=key,
                event_id=f"ev_{seq:06d}", run_id=eng.run_id, seq=seq, sim_tick=eng.tick, sim_time_ms=int(round(eng.sim_time * 1000.0)),
                message_type=kind, subtype=mtype, phase=phase, status=("blocked" if phase == "blocked" else {"warn": "warning", "fail": "failed"}.get(status, status)),
                sender=sender, recipient=recipient,
                thread_id=incident_id or mission_id or task_id or thread or robot_id or "run", task_id=task_id, mission_id=mission_id,
                incident_id=incident_id, asset_id=asset_id, robot_id=robot_id, summary=summary, evidence_ids=list(evidence or ()),
                model_provider=model_provider, model_id=model_id, visibility=visibility, causal_event_id=causal, payload=d)
        except ValidationError as e:                                   # never let a malformed record break the runtime; count it, keep the key free
            self.stats["invalid"] += 1
            self.seen.discard(key or "")
            log.warning("communication event rejected by validation (%s): %s", mtype, str(e)[:200])
            return None
        out = eng.emit_internal(EVENT_PREFIX + kind, ev.thread_id, ev.stored(), actor_type=actor_type, actor_id=actor_id, command_id=command_id,
                                causal_parent_id=ev.causal_event_id)
        self.stats["emitted"] += 1
        self._by_kind[kind] = self._by_kind.get(kind, 0) + 1
        return out

    def rebuild(self, keys: set[str]) -> None:
        self.seen |= keys

    def summary(self) -> Json:
        return {**self.stats, "by_kind": dict(self._by_kind), "enabled": self.enabled}

    # ------------------------------------------------------------------ hook (called by Engine.emit_internal after the authoritative event)
    def observe(self, kind: str, entity_id: str, payload: Json, actor_type: str, actor_id: str | None, command_id: str | None, event_id: str) -> None:
        if not self.enabled or kind.startswith(EVENT_PREFIX):
            return
        h = getattr(self, "_on_" + kind.replace(".", "_"), None)
        if h is None:
            return
        try:
            h(entity_id, payload, actor_type, actor_id, command_id, event_id)
        except Exception:                                                # noqa: BLE001  the recorder must never break the engine tick
            log.exception("communication derivation failed for %s", kind)

    # ------------------------------------------------------------------ agent tasks
    def _on_agent_task(self, eid, p, at, aid, cid, ev) -> None:
        t = p["task"]
        tid, st, role, tk = t["id"], str(t.get("status")), str(t.get("role") or "sentinel"), str(t.get("kind") or "")
        model = t.get("model") or {}
        mp = None if model.get("fallback") else model.get("provider")
        mid = None if model.get("fallback") else model.get("model_id")
        common = dict(task_id=tid, incident_id=t.get("incident_id"), robot_id=t.get("robot_id"), asset_id=(t.get("asset_ids") or [None])[0],
                      model_provider=mp, model_id=mid, causal=ev, actor_type="agent")
        title = clean_text(t.get("title"), 100)
        aid_ = t.get("agent_id") or tid                                   # SEN-01..05 seat (or the task id for legacy tasks)
        if st == "working":
            parent = self.eng.track.tasks.get(t.get("parent_id") or "")
            if tk == "replan":
                self.emit(kind="task_transition", mtype="task.replan", phase="started", status="warn", sender=self.agent("sentinel", aid_),
                          summary=f"Replanning after a rejected repair: {title}", key=f"task:{tid}:working", detail={"task_kind": tk, "depth": t.get("depth")},
                          **common)
            elif parent is not None and role != str(parent.get("role")):
                to = self.robot(t["robot_id"]) if t.get("robot_id") in self.eng.robots and role in ("inpipe", "outrig") else self.agent(role, aid_)
                self.emit(kind="agent_message", mtype="task.delegated", phase="requested", status="pending",
                          sender=self.agent(str(parent.get("role") or "sentinel"), parent.get("agent_id") or parent.get("id")), recipient=to,
                          summary=f"{str(parent.get('role') or 'sentinel').upper()} delegated to {to.klass} {to.id}: {title}",
                          key=f"task:{tid}:working", detail={"task_kind": tk, "parent_task": parent.get("id"), "depth": t.get("depth")}, **common)
            else:
                self.emit(kind="task_transition", mtype="task.started", phase="started", status="info", sender=self.agent(role, aid_),
                          summary=f"{role.upper()} started: {title}", key=f"task:{tid}:working", detail={"task_kind": tk, "depth": t.get("depth")}, **common)
            return
        if tk == "verify" or st == "working":
            return                                                        # verification.result carries pass / fail exactly once
        out = t.get("outcome") or {}
        text = clean_text(t.get("summary") or out.get("label") or st, 160)
        if st == "blocked":
            self.emit(kind="safety", mtype="task.blocked", phase="blocked", status="warn", sender=self.agent(role, aid_),
                      summary=f"{title} blocked: {text}", key=f"task:{tid}:{st}", detail={"task_kind": tk, "outcome": out.get("label")}, **common)
            return
        failed = st in ("failed", "rejected") or out.get("ok") is False
        self.emit(kind="task_transition", mtype=f"task.{st}"[:48], phase="failed" if failed else "completed", status="fail" if failed else "ok",
                  sender=self.agent(role, aid_), summary=f"{title}: {text}", key=f"task:{tid}:{st}", evidence=t.get("evidence_ids"),
                  detail={"task_kind": tk, "outcome": out.get("label")}, **common)

    # ------------------------------------------------------------------ tools
    def _on_agent_tool(self, eid, p, at, aid, cid, ev) -> None:
        call, tid = p["tool_call"], p["task_id"]
        task = self.eng.track.tasks.get(tid) or {}
        role = str(task.get("role") or "sentinel")
        name = clean_text(call.get("name"), 64)
        st = str(call.get("status"))
        if name.startswith("model.propose."):
            return                                                        # the model leg is reported as provider.* events (start / finish / error)
        base = dict(task_id=tid, incident_id=task.get("incident_id"), robot_id=task.get("robot_id"), causal=ev, actor_type="agent",
                    detail={"tool": name, "tool_call_id": call.get("id"), "latency_ms": call.get("latency_ms")}, sender=self.agent(role, task.get("agent_id") or tid))
        if st == "running":
            self.emit(kind="tool_event", mtype="tool.started", phase="started", status="pending", summary=f"{role.upper()} called {name}",
                      key=f"tool:{call['id']}:running", **base)
        elif st == "ok":
            self.emit(kind="tool_event", mtype="tool.completed", phase="completed", status="ok", summary=f"{name} completed (result received; not yet verified)",
                      key=f"tool:{call['id']}:ok", **base)
        elif st in BLOCK_TOOL:
            why = clean_text((call.get("output") or {}).get("reason") or "policy refused the call", 160)
            self.emit(kind="safety", mtype="policy.blocked", phase="blocked", status="warn", summary=f"{name} blocked by policy: {why}",
                      key=f"tool:{call['id']}:rejected", **base)
        else:
            why = clean_text((call.get("output") or {}).get("detail") or (call.get("output") or {}).get("error") or st, 160)
            self.emit(kind="tool_event", mtype="tool.failed", phase="failed", status="fail", summary=f"{name} failed: {why}",
                      key=f"tool:{call['id']}:{st}", **base)

    # ------------------------------------------------------------------ verification
    def _on_verification_result(self, eid, p, at, aid, cid, ev) -> None:
        v = p["verification"]
        vid, st = str(v.get("id") or eid), str(v.get("status"))
        inc = v.get("incident_id") or None
        checks = [{"id": c.get("id"), "pass": c.get("pass")} for c in (v.get("checks") or [])][:8]
        base = dict(sender=self.agent("sentinel", "SEN-05"), incident_id=inc, causal=ev, actor_type="agent",
                    detail={"verification_id": vid, "attempt": v.get("attempt"), "window_s": v.get("window_s"), "checks": checks})
        if st == "pending":
            self.emit(kind="verification", mtype="verification.started", phase="started", status="pending",
                      summary=f"Verification started ({round(float(v.get('window_s') or 0))} s stabilisation window)", key=f"ver:{vid}:pending", **base)
        elif st == "rejected" and (v.get("dod") or {}).get("layer_a") == "PASS" and (v.get("dod") or {}).get("independently_reviewed") is False \
                and not (v.get("dod") or {}).get("terminal_state"):
            # every measured check held, but no independent model review: a real recovery that is NOT counted as verified (V12 review #1)
            self.emit(kind="verification", mtype="verification.unreviewed", phase="info", status="warn",
                      summary=f"Checks held ({sum(1 for c in checks if c['pass'])}/{len(checks)}) but no independent review was available - not counted as verified",
                      key=f"ver:{vid}:{st}", **base)
        elif st in ("verified", "rejected"):
            ok = st == "verified"
            summ = (f"Verification passed ({sum(1 for c in checks if c['pass'])}/{len(checks)} checks)" if ok
                    else f"Verification failed: {clean_text(v.get('failed_reason') or 'checks not met', 170)}")
            self.emit(kind="verification", mtype="verification.passed" if ok else "verification.failed", phase="completed" if ok else "failed",
                      status="ok" if ok else "fail", summary=summ, key=f"ver:{vid}:{st}", **base)
        elif st:
            self.emit(kind="verification", mtype=f"verification.{st}"[:48], phase="info", status="info",
                      summary=f"Verification {clean_text(st, 40)}", key=f"ver:{vid}:{st}", **base)

    # ------------------------------------------------------------------ V11 Definition of Done, drift / loop guards
    def _on_dod_contract(self, eid, p, at, aid, cid, ev) -> None:
        c = p["contract"]
        iid, cidn, ver, st = c["incident_id"], c["id"], c.get("version", 1), c.get("state")
        ev_ = c.get("evaluation") or {}
        base = dict(incident_id=iid, causal=ev, actor_type="agent", thread=iid)
        checks = [{"id": k.get("id"), "type": k.get("type"), "threshold": k.get("threshold"), "hold_sim_s": k.get("hold_sim_s")} for k in (c.get("checks") or [])][:10]
        who = self.agent("sentinel", "SEN-01")
        if st == "PROPOSED":
            src = (c.get("drafted_by") or {})
            self.emit(kind="agent_message", mtype="contract.proposed", phase="requested", status="pending", sender=who, recipient=self.system("dod-compiler"),
                      summary=f"SEN-01 proposed a Definition of Done ({src.get('source', 'fallback')})", key=f"dod:{cidn}:v{ver}:proposed",
                      model_provider=src.get("provider"), model_id=src.get("model_id"), detail={"drafted_by": src}, **base)
        elif st == "FROZEN" and not ev_:
            kind_ = "contract.frozen" if ver == 1 else "contract.revised"
            self.emit(kind="verification", mtype=kind_, phase="completed", status="ok", sender=self.system("dod-compiler"), recipient=who,
                      summary=(f"Definition of Done frozen (v{ver}, {len(checks)} checks, hash {c.get('frozen_hash')}) before any repair" if ver == 1
                               else f"Definition of Done revised to v{ver}: {clean_text((c.get('revisions') or [{}])[-1].get('reason'), 140)}"),
                      key=f"dod:{cidn}:v{ver}:frozen", detail={"checks": checks, "frozen_hash": c.get("frozen_hash"), "version": ver}, **base)
        if st == "EVALUATING" and ev_:
            self.emit(kind="verification", mtype="contract.evaluating", phase="started", status="pending", sender=self.agent("sentinel", "SEN-05"),
                      summary=f"Layer A evaluating contract v{ver} (attempt {ev_.get('attempt')})", key=f"dod:{cidn}:v{ver}:eval{ev_.get('attempt')}",
                      detail={"checks": checks}, **base)
        if ev_ and ev_.get("layer_a") in ("PASS", "FAIL", "UNKNOWN"):
            tab = {k: {"status": x.get("status"), "measured": x.get("measured"), "held_s": x.get("held_s")} for k, x in (ev_.get("checks") or {}).items()}
            ok = ev_["layer_a"] == "PASS"
            self.emit(kind="verification", mtype="contract.layer_a", phase="completed" if ok else "failed", status="ok" if ok else "warn",
                      sender=self.agent("sentinel", "SEN-05"), summary=f"Layer A {ev_['layer_a']} (attempt {ev_.get('attempt')}): " + ", ".join(f"{k} {x['status']}" for k, x in list(tab.items())[:6]),
                      key=f"dod:{cidn}:v{ver}:la{ev_.get('attempt')}:{ev_['layer_a']}", detail={"table": tab}, **base)
            lb = ev_.get("layer_b") or {}
            if lb.get("verdict"):
                self.emit(kind="verification", mtype="contract.layer_b", phase="completed" if lb["verdict"] == "concur" else "blocked",
                          status="ok" if lb["verdict"] == "concur" else "warn", sender=self.agent("sentinel", "SEN-05"), recipient=who,
                          summary=f"SEN-05 {lb['verdict'].replace('_', ' ')} ({lb.get('source')}): " + clean_text("; ".join(lb.get("reasons") or []), 140),
                          key=f"dod:{cidn}:lb{ev_.get('attempt')}:{lb['verdict']}:{lb.get('for')}", model_id=lb.get("model_id"), model_provider=lb.get("provider"),
                          detail={"verdict": lb["verdict"], "source": lb.get("source")}, **base)
        for i, rr in enumerate(c.get("refused_revisions") or []):
            self.emit(kind="safety", mtype="contract.revision_refused", phase="blocked", status="warn", sender=self.system("dod-compiler"), recipient=who,
                      summary="Contract revision refused: " + clean_text("; ".join(rr.get("reasons") or []), 160), key=f"dod:{cidn}:refused:{rr.get('tick')}:{i}",
                      detail=rr, **base)
        if c.get("terminal_state"):
            t_ = c["terminal_state"]
            ok = t_ == "VERIFIED"
            self.emit(kind="verification", mtype="contract.terminal", phase="completed" if ok else "failed", status="ok" if ok else "warn",
                      sender=self.agent("sentinel", "SEN-05"), summary=clean_text(c.get("outcome_text"), 400) or f"Definition of Done ended {t_.replace('_', ' ').lower()} (contract v{ver})",
                      key=f"dod:{cidn}:terminal:{t_}",
                      detail={"terminal_state": t_, "escalation_reason": c.get("escalation_reason"), "needs_review": bool(c.get("needs_review")),
                              "assessment": c.get("assessment")}, **base)

    def _on_drift_detected(self, eid, p, at, aid, cid, ev) -> None:
        self.emit(kind="safety", mtype="drift.detected", phase="blocked", status="warn", sender=self.system("guard"), recipient=self.agent("sentinel", "SEN-01"),
                  summary=f"Drift detected: {clean_text(p.get('kind'), 60).replace('_', ' ')}", incident_id=p.get("incident_id"), key=f"drift:{ev}", causal=ev, detail=p)

    def _on_loop_detected(self, eid, p, at, aid, cid, ev) -> None:
        self.emit(kind="safety", mtype="loop.detected", phase="blocked", status="warn", sender=self.system("guard"), recipient=self.agent("sentinel", "SEN-01"),
                  summary=f"Loop detected: {clean_text(p.get('kind'), 60).replace('_', ' ')}", incident_id=p.get("incident_id"), key=f"loop:{ev}", causal=ev, detail=p)

    # ------------------------------------------------------------------ incidents, approvals, observations
    def _on_incident_opened(self, eid, p, at, aid, cid, ev) -> None:
        inc = p["incident"]
        self.emit(kind="task_transition", mtype="incident.opened", phase="started", status="warn", sender=self.agent("sentinel", "SEN-01"),
                  summary=f"Incident opened: {clean_text(inc.get('title'), 120)} ({inc.get('severity', 'unknown')})", incident_id=inc["id"],
                  asset_id=(inc.get("affected_asset_ids") or [None])[0], key=f"inc:{inc['id']}:opened", causal=ev, actor_type="agent",
                  detail={"severity": inc.get("severity"), "cause": inc.get("cause")})
        self._on_incident_updated(eid, p, at, aid, cid, ev)

    def _on_incident_closed(self, eid, p, at, aid, cid, ev) -> None:
        inc = p["incident"]
        self._on_incident_updated(eid, p, at, aid, cid, ev)
        failed = str(inc.get("status")) in ("escalated", "failed")
        self.emit(kind="task_transition", mtype="incident.closed", phase="failed" if failed else "completed", status="fail" if failed else "ok",
                  sender=self.agent("sentinel", "SEN-01"), summary=f"Incident {inc['id']} closed: {clean_text(inc.get('status'), 40)}"
                  + (f" - {clean_text(inc.get('summary'), 120)}" if inc.get("summary") else ""), incident_id=inc["id"], key=f"inc:{inc['id']}:closed",
                  causal=ev, actor_type="agent", detail={"status": inc.get("status"), "attempts": inc.get("attempts")})

    def _on_incident_updated(self, eid, p, at, aid, cid, ev) -> None:
        inc = p["incident"]
        iid = inc["id"]
        ap = inc.get("approval")
        if ap and ap.get("id"):
            st = str(ap.get("status"))
            who = aid if at == "operator" else ("auto-policy" if st == "approved" else "system")
            if st == "pending":
                self.emit(kind="safety", mtype="approval.requested", phase="requested", status="pending", sender=self.agent("sentinel", "SEN-01"),
                          recipient=self.operator(None), summary=f"Approval requested for {clean_text(ap.get('action') or ap.get('title') or iid, 120)}",
                          incident_id=iid, key=f"appr:{ap['id']}:pending", causal=ev, actor_type="agent",
                          detail={"approval_id": ap["id"], "auto_approve_at_s": ap.get("auto_approve_at_s")})
            elif st in ("approved", "held", "expired", "rejected"):
                self.emit(kind="safety", mtype=f"approval.{st}", phase="completed" if st == "approved" else "blocked", status="ok" if st == "approved" else "warn",
                          sender=self.operator(aid) if at == "operator" else self.system("policy"), recipient=self.agent("sentinel", "SEN-01"),
                          summary=f"Approval {st} by {clean_text(who, 60)}", incident_id=iid, key=f"appr:{ap['id']}:{st}", causal=ev,
                          actor_type=at, actor_id=aid, detail={"approval_id": ap["id"]})
        evs = inc.get("evidence") or []
        done = self._ev_seen.get(iid, 0)
        if len(evs) > done:
            for e in evs[done:]:
                if str(e.get("kind")) in ("verification",) or not e.get("id"):
                    continue
                self.emit(kind="agent_message", mtype="observation", phase="info", status="info", sender=self.agent("sentinel", "SEN-01"),
                          summary=clean_text(e.get("summary"), 200), incident_id=iid, asset_id=e.get("asset_id"), key=f"obs:{e['id']}", causal=ev,
                          evidence=[e["id"]], actor_type="agent", detail={"evidence_kind": e.get("kind"), "tick": e.get("tick")})
            self._ev_seen[iid] = len(evs)

    # ------------------------------------------------------------------ missions: delegation ack, step results, robot actions
    def _on_robot_mission_assigned(self, eid, p, at, aid, cid, ev) -> None:
        rid, mid = p["robot_id"], p["mission_id"]
        m = self.eng.missions.missions.get(mid) or {}
        task = self.eng.track.tasks.get(m.get("agent_task_id") or "") or {}
        issuer = m.get("created_by") or "system"
        if p.get("kind") == "return" and not task:
            to = self.system("missions")
        else:
            to = self.agent(str(task.get("role") or "sentinel"), task.get("id")) if task else (self.operator(issuer) if str(issuer).startswith("op") else self.system("missions"))
        self.emit(kind="agent_message", mtype="mission.ack", phase="completed", status="ok", sender=self.robot(rid), recipient=to,
                  summary=f"{rid} accepted {p.get('kind')} mission {mid} on {clean_text(p.get('target_id'), 60)}", mission_id=mid, robot_id=rid,
                  incident_id=p.get("incident_id") or None, task_id=task.get("id"), asset_id=p.get("target_id"), key=f"mis:{mid}:ack", causal=ev,
                  detail={"kind": p.get("kind"), "steps": len(m.get("steps") or [])}, command_id=cid)

    def _on_mission_transition(self, eid, p, at, aid, cid, ev) -> None:
        m = p["mission"]
        mid, rid = m["id"], m["robot_id"]
        out = m.get("outcome")
        if out is None:
            return                                                         # step-level progress is covered by robot action events
        failed = out != "completed"
        self.emit(kind="task_transition", mtype=f"mission.{out}"[:48], phase="completed" if not failed else "failed", status="ok" if not failed else "fail",
                  sender=self.robot(rid), summary=f"{rid} mission {mid} {out}" + (f": {clean_text(m.get('failure_reason'), 120)}" if failed and m.get("failure_reason") else ""),
                  mission_id=mid, robot_id=rid, incident_id=m.get("incident_id") or None, task_id=m.get("agent_task_id"), asset_id=m.get("target_id"),
                  key=f"mis:{mid}:{out}", causal=ev, detail={"kind": m.get("kind"), "failure_reason": m.get("failure_reason")})

    def _action(self, p, ev, phase: str) -> None:
        rid, mid, cmd = p["robot_id"], p["mission_id"], p["command"]
        key = f"act:{mid}:{p.get('step_id')}:{phase}"
        if phase == "started":
            self.emit(kind="tool_event", mtype="robot.action.started", phase="started", status="pending", sender=self.robot(rid),
                      summary=f"{rid} started {cmd} on {clean_text(p.get('target_id'), 60)}", mission_id=mid, robot_id=rid, incident_id=p.get("incident_id") or None,
                      asset_id=p.get("target_id"), key=key, causal=ev, detail={"command": cmd})
        else:
            ok = bool(p.get("ok"))
            self.emit(kind="tool_event", mtype="robot.action.completed" if ok else "robot.action.failed", phase="completed" if ok else "failed",
                      status="ok" if ok else "fail", sender=self.robot(rid),
                      summary=(f"{rid} {cmd} done (physical result reported; verification is a separate step)" if ok
                               else f"{rid} {cmd} failed: {clean_text(p.get('result'), 140)}"),
                      mission_id=mid, robot_id=rid, incident_id=p.get("incident_id") or None, asset_id=p.get("target_id"), key=key, causal=ev,
                      detail={"command": cmd, "result": p.get("result")})

    def _on_action_started(self, eid, p, at, aid, cid, ev) -> None:
        self._action(p, ev, "started")

    def _on_repair_started(self, eid, p, at, aid, cid, ev) -> None:
        self._action(p, ev, "started")

    def _on_action_completed(self, eid, p, at, aid, cid, ev) -> None:
        self._action(p, ev, "completed")

    # repair.completed duplicates action.completed (same payload): intentionally not mapped.

    # ------------------------------------------------------------------ operator: lease, drive, release, deadman
    def _on_robot_control_granted(self, eid, p, at, aid, cid, ev) -> None:
        rid = p["robot_id"]
        self.emit(kind="operator", mtype="lease.granted", phase="started", status="info", sender=self.operator(p.get("principal_id") or aid),
                  recipient=self.robot(rid), summary=f"Operator took manual control of {rid} (lease epoch {p.get('epoch')})", robot_id=rid,
                  key=f"lease:{p['lease_id']}:granted", causal=ev, actor_type="operator", actor_id=aid, command_id=cid,
                  detail={"lease_id": p["lease_id"], "epoch": p.get("epoch"), "deadman_s": p.get("deadman_s"), "ttl_s": p.get("ttl_s")})

    def _on_robot_control(self, eid, p, at, aid, cid, ev) -> None:
        rid, e = p["robot_id"], str(p.get("event"))
        lid = p.get("lease_id")
        if e == "active":
            return                                                         # the grant already announced manual control
        if e == "resumed":
            self.emit(kind="operator", mtype="control.resumed", phase="completed", status="ok", sender=self.system("control"), recipient=self.robot(rid),
                      summary=f"{rid} returned to autonomous operation", robot_id=rid, key=f"ctl:{rid}:resumed:{ev}", causal=ev)
            return
        released = e in ("released", "operator_release")
        who = self.operator(aid) if at == "operator" else self.system("control")
        if released:
            self.emit(kind="operator", mtype="lease.released", phase="completed", status="ok", sender=who, recipient=self.robot(rid),
                      summary=f"Operator released {rid}; safe hold then autonomy", robot_id=rid, key=f"lease:{lid}:ended:{e}", causal=ev,
                      actor_type=at, actor_id=aid, command_id=cid, detail={"lease_id": lid, "reason": e})
        else:
            kind_map = {"deadman_timeout": "lease.deadman", "lease_expired": "lease.expired", "client_disconnect": "lease.disconnect",
                        "client_hidden": "lease.blur", "safety_interlock": "lease.safety_interlock", "battery_depleted": "lease.battery"}
            self.emit(kind="safety", mtype=kind_map.get(e, "lease.safe_hold"), phase="blocked", status="warn", sender=who, recipient=self.robot(rid),
                      summary=f"{rid} held safely: {clean_text(e.replace('_', ' '), 60)}", robot_id=rid, key=f"lease:{lid}:ended:{e}", causal=ev,
                      actor_type=at, actor_id=aid, command_id=cid, detail={"lease_id": lid, "reason": e})

    def _on_robot_drive_accepted(self, eid, p, at, aid, cid, ev) -> None:
        lid = str(p.get("lease_id"))
        now = self.eng.sim_time
        if now - self._drive_t.get(lid, -1e9) < DRIVE_NOTE_S:
            return                                                         # drive intents arrive at 10-20 Hz: one record per 15 simulated seconds per lease
        self._drive_t[lid] = now
        lease = self.eng.control.leases.get(lid) or {}
        rid = lease.get("robot_id")
        self.emit(kind="operator", mtype="drive.command", phase="progress", status="info", sender=self.operator(aid), recipient=self.robot(rid) if rid else None,
                  summary=f"Operator driving {rid or 'robot'} (command seq {p.get('command_seq')})", robot_id=rid, key=f"drive:{lid}:{int(now // DRIVE_NOTE_S)}",
                  causal=ev, actor_type="operator", actor_id=aid, command_id=cid, detail={"lease_id": lid, "command_seq": p.get("command_seq")})

    def _on_robot_drive_rejected(self, eid, p, at, aid, cid, ev) -> None:
        lid = str(p.get("lease_id"))
        lease = self.eng.control.leases.get(lid) or {}
        rid = lease.get("robot_id")
        why = clean_text(p.get("reason"), 120)
        self.emit(kind="safety", mtype="drive.rejected", phase="blocked", status="warn", sender=self.system("control"), recipient=self.operator(aid),
                  summary=f"Drive command refused: {why}", robot_id=rid, key=f"driverej:{lid}:{why[:30]}:{int(self.eng.sim_time // DRIVE_NOTE_S)}",
                  causal=ev, actor_type="operator", actor_id=aid, command_id=cid, detail={"lease_id": lid, "reason": p.get("reason")})

    # ------------------------------------------------------------------ navigation milestones (never per-pose)
    def _nav(self, p, ev, mtype: str, phase: str, status: str, text: str, key: str, **extra) -> None:
        rid = p["robot_id"]
        m = (self.eng.missions.missions.get(p.get("mission_id") or "") if p.get("mission_id") else None) or self.eng.missions.active_mission(rid) or {}
        self.emit(kind="task_transition", mtype=mtype, phase=phase, status=status, sender=self.robot(rid), summary=text, robot_id=rid,
                  mission_id=p.get("mission_id") or m.get("id"), incident_id=p.get("incident_id") or m.get("incident_id") or None, task_id=m.get("agent_task_id"), key=key, causal=ev,
                  detail={"plan_id": p.get("plan_id"), "target": p.get("target"), "eta_s": p.get("eta_s"), "graph_revision": p.get("graph_revision"), **extra})

    def _on_robot_route_committed(self, eid, p, at, aid, cid, ev) -> None:
        self._nav(p, ev, "nav.route_committed", "started", "info", f"{p['robot_id']} route committed to {clean_text(p.get('target'), 60)} "
                  f"({p.get('length_m')} m, ETA {p.get('eta_s')} s)", f"nav:{p['plan_id']}:committed")

    def _on_robot_arrived(self, eid, p, at, aid, cid, ev) -> None:
        self._nav(p, ev, "nav.arrived", "completed", "ok", f"{p['robot_id']} arrived at {clean_text(p.get('target'), 60)} "
                  f"(actual {p.get('actual_s')} s vs ETA {p.get('eta_s')} s)", f"nav:{p['plan_id']}:arrived", actual_s=p.get("actual_s"))

    def _on_robot_route_replanned(self, eid, p, at, aid, cid, ev) -> None:
        self._nav(p, ev, "nav.route_replanned", "progress", "warn", f"{p['robot_id']} rerouted ({clean_text(p.get('reason'), 80)})",
                  f"nav:{p.get('plan_id')}:replanned", old_plan_id=p.get("old_plan_id"), reason=p.get("reason"))

    def _on_robot_route_cancelled(self, eid, p, at, aid, cid, ev) -> None:
        self._nav(p, ev, "nav.route_cancelled", "failed", "warn", f"{p['robot_id']} route cancelled ({clean_text(p.get('reason'), 80)})",
                  f"nav:{p.get('plan_id')}:cancelled", reason=p.get("reason"))

    def _on_traffic_blocked(self, eid, p, at, aid, cid, ev) -> None:
        rid = p["robot_id"]
        unresolved = str(p.get("reason")) == "DEADLOCK_UNRESOLVED"
        if not unresolved:
            return                                                         # resolving cycles are reported once, by the yield that resolved them
        self.emit(kind="safety", mtype="nav.deadlock_unresolved", phase="blocked", status="warn", sender=self.system("navigation"), recipient=self.robot(rid),
                  summary=f"{rid} stopped safely: unresolved traffic cycle {', '.join(p.get('cycle') or [])}", robot_id=rid,
                  key=f"nav:deadlock:{rid}:{int(self.eng.sim_time // 30)}", causal=ev, detail={"cycle": p.get("cycle"), "action": p.get("action")})

    def _on_traffic_yield(self, eid, p, at, aid, cid, ev) -> None:
        rid = p["robot_id"]
        if self.eng.sim_time - self._nav_t.get(rid, -1e9) < 10.0:
            return
        self._nav_t[rid] = self.eng.sim_time
        self.emit(kind="simulation", mtype="nav.yield", phase="info", status="info", sender=self.system("navigation"), recipient=self.robot(rid),
                  summary=f"{rid} yielded to {p.get('to')} ({clean_text(p.get('strategy'), 40)})", robot_id=rid, key=f"nav:yield:{rid}:{ev}", causal=ev,
                  detail={"strategy": p.get("strategy"), "to": p.get("to")})

    # ------------------------------------------------------------------ scenario / simulation
    def _on_scenario_fault_injected(self, eid, p, at, aid, cid, ev) -> None:
        self.emit(kind="simulation", mtype="scenario.fault_injected", phase="info", status="warn", sender=self.system("scenario"),
                  summary=f"Scenario injected a fault on {clean_text(eid, 60)}", asset_id=eid, key=f"scn:fault:{ev}", causal=ev)

    def _on_scenario_created(self, eid, p, at, aid, cid, ev) -> None:
        self.emit(kind="simulation", mtype="scenario.created", phase="started", status="info", sender=self.system("scenario"),
                  summary=f"Scenario {clean_text(eid, 60)} started", key=f"scn:created:{eid}", causal=ev)

    def _on_robot_towed(self, eid, p, at, aid, cid, ev) -> None:
        self.emit(kind="simulation", mtype="robot.towed", phase="info", status="warn", sender=self.system("missions"), recipient=self.robot(p["robot_id"]),
                  summary=f"{p['robot_id']} was stranded and towed to {p.get('to')}", robot_id=p["robot_id"], key=f"tow:{p['robot_id']}:{ev}", causal=ev)

    # ------------------------------------------------------------------ direct boundaries (provider adapters, run end)
    def provider_event(self, phase: str, *, provider: str, model_id: str | None, purpose: str, incident_id: str | None = None, task_id: str | None = None,
                       key: str, latency_ms: int | None = None, reason: str | None = None, tokens_in: int | None = None, tokens_out: int | None = None) -> None:
        det = {"purpose": purpose, "latency_ms": latency_ms, "tokens_in": tokens_in, "tokens_out": tokens_out, "reason": reason}
        who = self.provider(provider)
        if phase == "started":
            self.emit(kind="provider", mtype="provider.started", phase="started", status="pending", sender=self.agent("sentinel", self._seat(task_id)), recipient=who,
                      summary=f"Asked {provider} ({purpose})", incident_id=incident_id, task_id=task_id, model_provider=provider, model_id=model_id,
                      key=f"prov:{key}:started", detail=det, actor_type="agent")
        elif phase == "completed":
            self.emit(kind="provider", mtype="provider.finished", phase="completed", status="ok", sender=who, recipient=self.agent("sentinel", self._seat(task_id)),
                      summary=f"{provider} answered ({purpose}, {latency_ms if latency_ms is not None else '?'} ms)", incident_id=incident_id, task_id=task_id,
                      model_provider=provider, model_id=model_id, key=f"prov:{key}:finished", detail=det, actor_type="agent")
        else:
            self.emit(kind="provider", mtype="provider.error", phase="failed", status="fail", sender=who, recipient=self.agent("sentinel", self._seat(task_id)),
                      summary=f"Provider unavailable ({provider}): {clean_text(reason, 140)}; deterministic fallback used", incident_id=incident_id,
                      task_id=task_id, model_provider=provider, model_id=model_id, key=f"prov:{key}:error", detail=det, actor_type="agent")

    def safety_block(self, *, command_id: str | None, command_kind: str, reasons: str, role: str = "sentinel", incident_id: str | None = None,
                     task_id: str | None = None, target_id: str | None = None) -> None:
        self.emit(kind="safety", mtype="policy.command_refused", phase="blocked", status="warn", sender=self.system("policy"), recipient=self.agent(role, task_id),
                  summary=f"Policy refused {command_kind}: {clean_text(reasons, 170)}", incident_id=incident_id, task_id=task_id, asset_id=target_id,
                  key=f"policy:{command_id}", detail={"command_kind": command_kind, "command_id": command_id}, actor_type="agent")

    def run_end(self, reason: str) -> None:
        self.emit(kind="simulation", mtype="run.ended", phase="completed", status="info", sender=self.system("engine"),
                  summary=f"Run {self.eng.run_id} ended at tick {self.eng.tick} ({clean_text(reason, 60)})", key=f"run:{self.eng.run_id}:ended:{self.eng.tick}")
