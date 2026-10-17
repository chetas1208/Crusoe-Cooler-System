"""V11 prompt -> LIVE run bridge (Agent G).

One flow: vague prompt -> Laya triage (advisory) -> Crusoe/Nemotron ScenarioProposalV1 -> deterministic compile + topology
selector resolution -> faults injected into the LIVE run through the engine command bus (``test.inject_fault``, idempotent
command ids, operator policy, per-run cap) -> the SENTINEL team + frozen Definition of Done work on the resulting incident.

Rules enforced here:
* No direct state edits: the only write path is ``engine.submit({kind: "test.inject_fault", ...})``.
* ScenarioSpec families map ONLY to the six supported fault kinds (fouling, strainer_blockage, valve_stuck, pump_degradation,
  sensor_drift, workload_spike). leak / power_failure / fire_smoke / heat_rejection_loss are UNSUPPORTED and rejected with the reason.
* Targets come from the live topology / fault catalog. An explicit id that exists but is not faultable (e.g. ``p_17`` in v6) or an
  unresolvable pipe/rack selector is rejected with the reason; only families with a single safe default (pump, sensor, strainer)
  fall back to it, and the fallback is declared as an assumption.
* Per-run cap on injected faults + minimum spacing between launches + per-request cap.
* The request record stores the live run id, command ids and incident ids (``validation_report.live``).
* Replay / stored runs never inject and never call a model: this module only runs from the POST path; a request that already has a
  final state or recorded injections is returned untouched.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

log = logging.getLogger("loopkeeper.api.scenario_live")
Json = dict[str, Any]

SUPPORTED_KINDS = ("fouling", "strainer_blockage", "valve_stuck", "pump_degradation", "sensor_drift", "workload_spike")
UNSUPPORTED_FAMILIES: dict[str, str] = {
    "leak": "leak injection is not supported by the plant (closed pressurised loop cannot model it honestly: not_supported_yet)",
    "power_failure": "no test.inject_fault kind for power loss (the plant outage simulator is not exposed on the command bus)",
    "fire_smoke": "no test.inject_fault kind for rack fire/smoke (the fire simulator is not exposed on the command bus)",
    "heat_rejection_loss": "no fault kind for heat-rejection / chiller loss (chiller setpoint is a control, not an injectable fault)",
}
SEV_ORDER = ("minor", "moderate", "severe", "emergency")
SEV_FLOAT = {"minor": 0.25, "moderate": 0.5, "severe": 0.75, "emergency": 1.0}
# engine parameter tables per severity (bounds mirror physics/faults.py::FaultManager.begin)
PARAMS: dict[str, dict[str, tuple]] = {
    "fouling": {"omax": (0.35, 0.5, 0.7, 0.85), "tau_s": (220.0, 140.0, 90.0, 60.0)},
    "strainer_blockage": {"omax": (0.4, 0.55, 0.7, 0.8), "tau_s": (240.0, 200.0, 180.0, 170.0)},
    "valve_stuck": {"opening": (0.35, 0.25, 0.15, 0.08)},
    "pump_degradation": {"health_end": (0.7, 0.5, 0.3, 0.15), "duration_s": (200.0, 150.0, 120.0, 100.0)},
    "sensor_drift": {"rate": (0.004, 0.005, 0.006, 0.0075), "cap": (0.3, 0.5, 0.6, 0.75)},
    "workload_spike": {"extra": (0.1, 0.17, 0.22, 0.3), "duration_s": (240.0, 240.0, 240.0, 240.0)},
}
ISSUER = "scenario-launcher"


# ============================================================================ config / governor
def _env_num(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return float(default)


@dataclass
class LiveLimits:
    max_faults_per_run: int = 8          # accepted launcher injections per live run
    max_faults_per_request: int = 3
    min_interval_s: float = 10.0         # wall seconds between launches on one run
    link_wait_s: float = 300.0           # background incident-link watcher lifetime (wall)
    link_poll_s: float = 1.0

    @classmethod
    def from_env(cls) -> "LiveLimits":
        return cls(max_faults_per_run=int(_env_num("SCENARIO_LIVE_MAX_FAULTS_PER_RUN", 8)),
                   max_faults_per_request=int(_env_num("SCENARIO_LIVE_MAX_FAULTS_PER_REQUEST", 3)),
                   min_interval_s=_env_num("SCENARIO_LIVE_MIN_INTERVAL_S", 10.0),
                   link_wait_s=_env_num("SCENARIO_LIVE_LINK_WAIT_S", 300.0))


class Governor:
    """Per-run counters. The authoritative count is the max of this in-memory counter and accepted launcher commands in the engine ledger."""

    def __init__(self) -> None:
        self.accepted: dict[str, int] = {}
        self.last_launch: dict[str, float] = {}
        self.locks: dict[str, asyncio.Lock] = {}

    def lock(self, run_id: str) -> asyncio.Lock:
        return self.locks.setdefault(run_id, asyncio.Lock())

    @staticmethod
    def ledger_count(engine: Any) -> int:
        led = getattr(getattr(engine, "commands", None), "ledger", None)
        if not isinstance(led, dict):
            return 0
        return sum(1 for r in led.values() if isinstance(r, dict) and r.get("kind") == "test.inject_fault"
                   and r.get("status") == "accepted" and str(r.get("issuer", "")).startswith(ISSUER))

    def used(self, engine: Any, run_id: str) -> int:
        return max(self.accepted.get(run_id, 0), self.ledger_count(engine))


GOVERNOR = Governor()


# ============================================================================ request store (in-memory when storage has none)
def _now() -> datetime:
    return datetime.now(timezone.utc)


class MemoryScenarioStore:
    """Same surface as PostgresStorage's scenario_* methods, for in-memory runs (the Postgres tables do not exist there)."""

    def __init__(self) -> None:
        self.req: dict[str, Json] = {}
        self.interp: dict[str, Json] = {}
        self.idem: dict[str, str] = {}

    def create_scenario_request(self, request_id, principal_id, original_text, idempotency_key=None, facility_id="lab_01", source_run_id=None) -> Json:
        if idempotency_key and idempotency_key in self.idem:
            return dict(self.req[self.idem[idempotency_key]])
        row = {"request_id": request_id, "principal_id": principal_id, "original_text": original_text, "status": "QUEUED", "phase": "RECEIVED",
               "idempotency_key": idempotency_key, "facility_id": facility_id, "source_run_id": source_run_id, "run_id": None,
               "error_code": None, "error_message": None, "created_at": _now(), "updated_at": _now()}
        self.req[request_id] = row
        if idempotency_key:
            self.idem[idempotency_key] = request_id
        return dict(row)

    def get_scenario_request(self, request_id) -> Optional[Json]:
        r = self.req.get(request_id)
        if r is None:
            return None
        out = dict(r)
        out.update({k: None for k in ("laya_result", "laya_engine", "crusoe_proposal", "crusoe_model")})
        out.update({k: [] for k in ("assumptions", "resolved_assets", "definition_of_done")})
        out.update({"validation_report": {}, "latencies_ms": {}, "tokens_used": {}})
        out.update(self.interp.get(request_id, {}))
        return out

    def get_scenario_request_by_idempotency(self, key) -> Optional[Json]:
        rid = self.idem.get(key)
        return dict(self.req[rid]) if rid else None

    def update_scenario_request(self, request_id, **fields) -> None:
        if request_id in self.req:
            self.req[request_id].update(fields)
            self.req[request_id]["updated_at"] = _now()

    def save_scenario_interpretation(self, request_id, **kw) -> None:
        self.interp[request_id] = {k: v for k, v in kw.items()}

    def enqueue_scenario_job(self, job_id, request_id, phase="RECEIVED") -> None:
        return None


_MEM_STORES: dict[int, MemoryScenarioStore] = {}


def scenario_store(engine: Any) -> Any:
    """The engine's storage when it has the scenario tables (Postgres), else a process-local in-memory store."""
    st = getattr(engine, "storage", None)
    if st is not None and hasattr(st, "create_scenario_request"):
        return st
    return _MEM_STORES.setdefault(id(engine), MemoryScenarioStore())


# ============================================================================ fault catalog + selector resolution
@dataclass
class Catalog:
    foul: tuple = ()
    strainers: tuple = ()
    sensors: tuple = ()
    pumps: tuple = ()
    racks: tuple = ()            # modelled racks (valve_stuck / workload_spike capable), ids like rack_a1
    tcs_duty: str = ""
    zone_headers: dict = field(default_factory=dict)   # 'b' -> 'p_hs_b'
    known_ids: frozenset = frozenset()                # every asset / edge id in the topology


def build_catalog(engine: Any) -> Catalog:
    topo = engine.topology() or {}
    assets = topo.get("assets", []) or []
    edges = topo.get("edges", []) or []
    fm = getattr(getattr(engine, "plant", None), "fault_mgr", None)
    by_type: dict[str, list[str]] = {}
    for a in assets:
        by_type.setdefault(a.get("type", ""), []).append(a["id"])
    if fm is not None:
        foul = tuple(fm.foul_allowed)
        strainers = tuple(fm.strainers)
        sensors = tuple(fm.sensors)
        pumps = tuple(fm.pump_ids)
        racks = tuple(f"rack_{r}" for r in fm.racks)
        tcs_duty = str(fm.tcs_duty)
    else:
        foul = tuple(e["id"] for e in edges if e.get("robot_passable"))
        strainers = tuple(by_type.get("strainer", ()))
        sensors = tuple(i for i in by_type.get("sensor", ()) if i.startswith("sn_flow_"))
        pumps = tuple(by_type.get("pump", ()))
        racks = tuple(by_type.get("rack", ()))
        tcs_duty = next((p for p in pumps if p.startswith("pump_t")), "")
    zh: dict[str, str] = {}
    for e in edges:
        eid = e["id"]
        m = re.match(r"^p_hs_([a-z])$", eid)
        if m and eid in foul:
            zh[m.group(1)] = eid
        z = str(e.get("zone_id", ""))
        if e.get("role") == "supply" and z.startswith("zone_") and eid in foul and z[5:] not in zh and e.get("diameter_mm", 0) >= 100:
            zh[z[5:]] = eid
    ids = frozenset([a["id"] for a in assets] + [e["id"] for e in edges])
    return Catalog(foul, strainers, sensors, pumps, racks, tcs_duty, zh, ids)


def _norm_id(q: str, cat: Catalog) -> str:
    s = q.strip().lower().replace(" ", "_").replace("-", "_")
    m = re.match(r"^(rack|valve|sn_rack)_([a-z])0*(\d+)$", s)
    if m:
        return f"{m.group(1)}_{m.group(2)}{m.group(3)}"
    m = re.match(r"^(?:str|strainer)_0*(\d+)$", s)
    if m:
        return f"strainer_{int(m.group(1)):02d}"
    tcs = [p for p in cat.pumps if p.startswith("pump_t")]
    fws = [p for p in cat.pumps if p.startswith("pump_f")]
    if s in ("pump_tcs_duty", "tcs_duty") and cat.tcs_duty:
        return cat.tcs_duty
    if s in ("pump_tcs_stby", "pump_tcs_standby") and len(tcs) > 1:
        return next((p for p in tcs if p != cat.tcs_duty), tcs[-1])
    if s == "pump_fws_duty" and fws:
        return fws[0]
    if s in ("pump_fws_stby", "pump_fws_standby") and len(fws) > 1:
        return fws[1]
    return s


def _zone_of(*texts: Optional[str]) -> Optional[str]:
    for t in texts:
        if not t:
            continue
        s = t.lower()
        for pat in (r"(?:row|zone)[ _\-]?([a-e])\b", r"(?:rack|valve|sn_rack)_([a-e])\d", r"p_h[sr]_([a-e])\b", r"_([a-e])_(?:supply|return)", r"\b([a-e])\d{1,2}\b"):
            m = re.search(pat, s)
            if m:
                return m.group(1)
        if re.search(r"middle|centre|center|central", s):
            return "c"
        if re.search(r"\bback\b|\brear\b|\bend\b", s):
            return "e"
        if re.search(r"\bfront\b", s):
            return "a"
    return None


@dataclass
class Injection:
    kind: str
    target: str
    severity: str
    params: Json
    family: str
    method: str
    note: str = ""

    def args(self, with_params: bool) -> Json:
        a: Json = {"kind": self.kind, "target": self.target, "severity": SEV_FLOAT[self.severity]}
        if with_params and self.params:
            a["params"] = dict(self.params)
        return a

    def view(self) -> Json:
        return {"kind": self.kind, "target": self.target, "severity": self.severity, "family": self.family, "resolution": self.method,
                "params": dict(self.params), "note": self.note}


@dataclass
class Plan:
    injections: list = field(default_factory=list)
    rejected: list = field(default_factory=list)       # [{family, query, code, reason}]
    unsupported: list = field(default_factory=list)    # [{family, reason}]
    assumptions: list = field(default_factory=list)


def _params(kind: str, severity: str) -> Json:
    i = SEV_ORDER.index(severity)
    return {k: float(v[i]) for k, v in PARAMS[kind].items()}


def _explicit(q: str, cat: Catalog) -> bool:
    return q in cat.known_ids or bool(re.match(r"^p_\d{2}$", q))


def plan_for_fault(fault: Any, laya: Json, cat: Catalog, plan: Plan) -> None:
    fam = fault.family
    sev = fault.severity if fault.severity in SEV_ORDER else "moderate"
    if fam == "unknown":
        lf = laya.get("incident_family")
        if (lf in UNSUPPORTED_FAMILIES or lf in ("flow_restriction", "pump_failure", "overheating", "sensor_fault")) and not laya.get("abstained", True):
            fam = lf
    if fam in UNSUPPORTED_FAMILIES:
        plan.unsupported.append({"family": fam, "reason": UNSUPPORTED_FAMILIES[fam]})
        return
    q = (fault.asset_query or "").strip()
    qn = _norm_id(q, cat) if q else ""
    hint = (fault.cause_hint or "").lower()

    def rej(code: str, reason: str) -> None:
        plan.rejected.append({"family": fam, "query": q or None, "code": code, "reason": reason})

    def add(kind: str, target: str, method: str, note: str = "") -> None:
        plan.injections.append(Injection(kind, target, sev, _params(kind, sev), fam, method, note))
        if note:
            plan.assumptions.append(note)

    zone = _zone_of(q, *(getattr(fault, "_hints", ()) or ()))

    def header(why: str) -> bool:
        h = cat.zone_headers.get(zone or "")
        if h:
            add("fouling", h, "zone_header", f"{why}: modelled as restriction of the row-{zone} supply header {h}")
            return True
        return False

    if fam == "flow_restriction":
        if "strainer" in qn or "strainer" in hint and not qn.startswith("p_"):
            if qn in cat.strainers:
                add("strainer_blockage", qn, "exact")
            elif qn in cat.known_ids:
                rej("INVALID_SELECTOR", f"{qn} is not a strainer")
            else:
                t = cat.strainers[-1] if cat.strainers else ""
                if t:
                    add("strainer_blockage", t, "default", f"no strainer id in the prompt: defaulted to {t}")
                else:
                    rej("INVALID_SELECTOR", "topology has no strainer")
            return
        if qn.startswith("p_") and _explicit(qn, cat):
            if qn in cat.foul:
                add("fouling", qn, "exact")
            else:
                rej("INVALID_SELECTOR", f"{qn} is not a faultable pipe in this topology (valid: {', '.join(cat.foul[:12])}...)")
            return
        if qn in cat.known_ids:
            if not header(f"{qn} is not itself faultable"):
                rej("INVALID_SELECTOR", f"{qn} is not a pipe and no supply header resolves for it")
            return
        if not header("pipe selector resolved by row"):
            rej("INVALID_SELECTOR", f"cannot resolve a pipe or row from {q!r}; name a pipe id or a row (a-e)")
        return
    if fam == "overheating":
        if qn in cat.racks:
            if re.search(r"valve|stuck|starv", hint):
                add("valve_stuck", "valve_" + qn[5:], "exact", f"coolant starvation hint: stuck balancing valve of {qn}")
            else:
                add("workload_spike", qn, "exact", f"overheating modelled as a workload spike on {qn}")
            return
        if qn.startswith("valve_") and qn[6:] in {r[5:] for r in cat.racks}:
            add("valve_stuck", qn, "exact")
            return
        if qn.startswith("p_") and _explicit(qn, cat):
            if qn in cat.foul:
                add("fouling", qn, "exact", f"overheating modelled as restricted supply {qn}")
            else:
                rej("INVALID_SELECTOR", f"{qn} is not a faultable pipe in this topology")
            return
        if not header(f"{qn or q or 'rack'} is not a directly faultable rack (only {', '.join(cat.racks)} are modelled)"):
            rej("INVALID_SELECTOR", f"cannot resolve a faultable rack or row from {q!r}; modelled racks: {', '.join(cat.racks)}")
        return
    if fam == "pump_failure":
        if qn in cat.pumps:
            add("pump_degradation", qn, "exact")
        elif qn in cat.known_ids:
            rej("INVALID_SELECTOR", f"{qn} is not a pump")
        elif cat.tcs_duty:
            add("pump_degradation", cat.tcs_duty, "default", f"no pump id in the prompt: defaulted to the TCS duty pump {cat.tcs_duty}")
        else:
            rej("INVALID_SELECTOR", "topology has no pump")
        return
    if fam == "sensor_fault":
        if qn in cat.sensors:
            add("sensor_drift", qn, "exact")
        elif qn in cat.known_ids:
            rej("INVALID_SELECTOR", f"{qn} is not a drift-capable sensor (valid: {', '.join(cat.sensors)})")
        else:
            t = f"sn_flow_z{zone}" if zone and f"sn_flow_z{zone}" in cat.sensors else ("sn_flow_trunk" if "sn_flow_trunk" in cat.sensors else (cat.sensors[0] if cat.sensors else ""))
            if t:
                add("sensor_drift", t, "default", f"no sensor id in the prompt: defaulted to {t}")
            else:
                rej("INVALID_SELECTOR", "topology has no drift-capable sensor")
        return
    rej("UNKNOWN_FAMILY", f"family {fam!r} has no mapping to a supported fault kind")


def plan_injections(proposal: Any, laya: Json, cat: Catalog, *, max_per_request: int = 3) -> Plan:
    plan = Plan()
    if getattr(proposal, "intent", "simulate") != "simulate":
        plan.rejected.append({"family": None, "query": None, "code": "NOT_A_FAULT_REQUEST",
                              "reason": f"intent is {proposal.intent!r}: nothing to inject"})
        return plan
    if proposal.needs_clarification:
        plan.assumptions.append("model flagged needs_clarification; proceeding with the resolvable fault only")
    from types import SimpleNamespace
    for f in proposal.proposed_faults:
        # location hints only help zone resolution; they never override an explicit selector
        plan_for_fault(SimpleNamespace(family=f.family, severity=f.severity, asset_query=f.asset_query, cause_hint=f.cause_hint,
                                       _hints=tuple(proposal.location_hints)), laya, cat, plan)
    seen, uniq = set(), []
    for inj in plan.injections:
        k = (inj.kind, inj.target)
        if k not in seen:
            seen.add(k)
            uniq.append(inj)
    if len(uniq) > max_per_request:
        for inj in uniq[max_per_request:]:
            plan.rejected.append({"family": inj.family, "query": inj.target, "code": "REQUEST_CAP",
                                  "reason": f"more than {max_per_request} faults in one request"})
        uniq = uniq[:max_per_request]
    plan.injections = uniq
    return plan


# ============================================================================ incident linking
def _incidents(engine: Any) -> list[Json]:
    track = getattr(engine, "track", None)
    if track is not None and hasattr(track, "world_incidents"):
        return track.world_incidents()
    try:
        return list(engine.world().get("incidents") or [])
    except Exception:  # noqa: BLE001
        return []


def refresh_links(engine: Any, live: Json) -> list[str]:
    """Attach incidents opened after the injection (read-only). Returns newly linked ids."""
    if getattr(engine, "replay", False) or live.get("run_id") != getattr(engine, "run_id", live.get("run_id")):
        return []
    known = set(live.get("baseline_incident_ids") or [])
    have = list(live.get("incident_ids") or [])
    t0 = int(live.get("injected_tick") or 0)
    targets = {i["target"] for i in live.get("injections", []) if i.get("accepted")}
    new: list[str] = []
    for inc in sorted(_incidents(engine), key=lambda i: i.get("opened_tick", 0)):
        iid = inc.get("id")
        if not iid or iid in known or iid in have or int(inc.get("opened_tick", 0)) < t0:
            continue
        have.append(iid)
        new.append(iid)
        aff = set(inc.get("affected_asset_ids") or []) | {(inc.get("anchor") or {}).get("entity_id")}
        live.setdefault("incident_match", {})[iid] = "target_overlap" if aff & targets else "first_new_incident_after_injection"
    if new:
        live["incident_ids"] = have
        live["linked_at"] = _now().isoformat()
    return new


# ============================================================================ pipeline
def live_capable(ctx: Any) -> bool:
    eng = ctx.engine
    if os.environ.get("SCENARIO_LIVE", "1") == "0" or not hasattr(eng, "submit") or getattr(eng, "replay", False):
        return False
    return bool(getattr(ctx.settings, "enable_test_commands", True))


def live_view(rec: Json) -> Optional[Json]:
    live = (rec.get("validation_report") or {}).get("live")
    if not live:
        return None
    return {k: v for k, v in live.items() if k not in ("baseline_incident_ids",)}


def _sanitize(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.:\-]", "_", s)[:40] or "operator"


class LiveLauncher:
    def __init__(self, engine: Any, store: Any, *, run_id: Optional[str] = None, settings: Any = None, model_client: Any = None,
                 laya: Any = None, limits: Optional[LiveLimits] = None, governor: Optional[Governor] = None) -> None:
        self.engine, self.store = engine, store
        self.run_id = run_id or getattr(engine, "run_id", None) or "run_live"
        self.settings = settings
        self.model_client = model_client
        self.laya = laya
        self.limits = limits or LiveLimits.from_env()
        self.gov = governor or GOVERNOR

    # ---- helpers
    def _fail(self, request_id: str, status: str, code: str, msg: str, interp: Optional[Json] = None) -> Json:
        self.store.update_scenario_request(request_id, status=status, phase=status if status in ("REJECTED", "FAILED") else "FAILED",
                                           error_code=code, error_message=msg[:300])
        return {"ok": False, "request_id": request_id, "status": status, "error_code": code, "error": msg}

    def _save(self, request_id: str, interp: Json, live: Json) -> None:
        vr = dict(interp.get("validation_report") or {})
        vr["live"] = live
        interp["validation_report"] = vr
        self.store.save_scenario_interpretation(request_id, **interp)

    async def _submit(self, cmd: Json) -> Json:
        return await self.engine.submit(cmd)

    # ---- main
    async def run(self, request_id: str) -> Json:
        store, eng = self.store, self.engine
        req = store.get_scenario_request(request_id)
        if not req:
            raise ValueError(f"Scenario request {request_id} not found")
        if req["status"] in ("READY", "FAILED", "CANCELED", "REJECTED") or (req.get("validation_report") or {}).get("live", {}).get("injections"):
            return {"ok": req["status"] == "READY", "request_id": request_id, "status": req["status"], "skipped": "already processed"}
        prompt, principal_id = req["original_text"], req["principal_id"]
        t_all = time.perf_counter()
        lat: Json = {}
        tokens: Json = {}
        try:
            # 1 classify (advisory)
            store.update_scenario_request(request_id, status="PROCESSING", phase="CLASSIFYING")
            t = time.perf_counter()
            if self.laya is not None:
                laya = await asyncio.to_thread(self.laya.triage_scenario_prompt, prompt)
            else:
                from ..intelligence.laya_classifier import get_laya_classifier
                laya = await asyncio.to_thread(get_laya_classifier().triage_scenario_prompt, prompt)
            lat["laya_ms"] = round((time.perf_counter() - t) * 1000.0, 2)

            # 2 interpret (Nemotron) -- the only model call; never repeated for this request
            store.update_scenario_request(request_id, phase="INTERPRETING")
            from ..intelligence.scenario_interpreter import interpret_incident_prompt
            client, own = self.model_client, False
            if client is None:
                from ..intelligence.crusoe import CrusoeClient, IntelligenceConfig
                cfg = IntelligenceConfig.from_env()
                client, own = (CrusoeClient(cfg), True) if cfg.configured else (None, False)
            t = time.perf_counter()
            try:
                proposal, model_id, meta = await interpret_incident_prompt(prompt, client)
            finally:
                if own and client is not None:
                    try:
                        await client.aclose()
                    except Exception:  # noqa: BLE001
                        pass
            lat["crusoe_ms"] = round((time.perf_counter() - t) * 1000.0, 2)
            tokens = {"tokens_in": meta.get("tokens_in", 0), "tokens_out": meta.get("tokens_out", 0)}

            # 3 deterministic compile + selector resolution
            store.update_scenario_request(request_id, phase="VALIDATING")
            t = time.perf_counter()
            from ..scenarios.compiler import compile_scenario
            _, cmeta = compile_scenario(proposal, laya, eng.topology(), seed=1337 + zlib.crc32(request_id.encode()) % 10000)
            cat = build_catalog(eng)
            plan = plan_injections(proposal, laya, cat, max_per_request=self.limits.max_faults_per_request)
            lat["compile_ms"] = round((time.perf_counter() - t) * 1000.0, 2)
            assumptions = list(cmeta.get("assumptions", [])) + plan.assumptions
            live: Json = {"run_id": self.run_id, "mode": "live_injection", "injections": [], "rejected": plan.rejected,
                          "unsupported": plan.unsupported, "incident_ids": [], "supported_kinds": list(SUPPORTED_KINDS),
                          "planned": [i.view() for i in plan.injections]}
            interp: Json = dict(
                laya_result=laya, laya_engine=laya.get("engine", "rule_fallback"), crusoe_proposal=proposal.model_dump(), crusoe_model=model_id,
                assumptions=assumptions, resolved_assets=[i.target for i in plan.injections],
                definition_of_done=cmeta.get("definition_of_done", []),
                validation_report={"valid": bool(plan.injections), "readiness": cmeta.get("validation_report", {}).get("readiness"),
                                   "fault_mapping": [i.view() for i in plan.injections]},
                latencies_ms=dict(lat), tokens_used=tokens)
            self._save(request_id, interp, live)
            if not plan.injections:
                codes = [r["code"] for r in plan.rejected]
                code = "UNSUPPORTED_FAULT" if plan.unsupported and not plan.rejected else (codes[0] if codes else "UNSUPPORTED_FAULT")
                reasons = [f"{u['family']}: {u['reason']}" for u in plan.unsupported] + [r["reason"] for r in plan.rejected]
                lat["total_pipeline_ms"] = round((time.perf_counter() - t_all) * 1000.0, 2)
                interp["latencies_ms"] = dict(lat)
                self._save(request_id, interp, live)
                return self._fail(request_id, "REJECTED", code, "; ".join(reasons) or "nothing injectable")

            # 4 policy gate + injection through the command bus
            cur = store.get_scenario_request(request_id)
            if cur and cur["status"] == "CANCELED":
                return {"ok": False, "request_id": request_id, "status": "CANCELED"}
            store.update_scenario_request(request_id, phase="CREATING_RUN")
            res = await self._inject(request_id, principal_id, plan, live, lat)
            lat["total_pipeline_ms"] = round((time.perf_counter() - t_all) * 1000.0, 2)
            interp["latencies_ms"] = dict(lat)
            self._save(request_id, interp, live)
            if res is not None:
                return self._fail(request_id, "REJECTED", res[0], res[1])
            try:
                store.update_scenario_request(request_id, status="READY", phase="RUNNING", run_id=self.run_id, error_code=None, error_message=None)
            except Exception:  # noqa: BLE001  (run_id FK can refuse an unregistered run; the link is still in validation_report.live)
                store.update_scenario_request(request_id, status="READY", phase="RUNNING", error_code=None, error_message=None)
            self._emit("scenario_request.live_injected", request_id, {"request_id": request_id, "run_id": self.run_id,
                       "injections": [{k: i[k] for k in ("kind", "target", "command_id", "accepted")} for i in live["injections"]]})
            refresh_links(eng, live)
            if live["incident_ids"]:
                self._save(request_id, interp, live)
            return {"ok": True, "request_id": request_id, "run_id": self.run_id, "status": "READY", "phase": "RUNNING", "live": live, "_interp": interp}
        except Exception as e:  # noqa: BLE001
            log.exception("live scenario request %s failed", request_id)
            return self._fail(request_id, "FAILED", "PIPELINE_ERROR", f"{type(e).__name__}: {e}")

    async def _inject(self, request_id: str, principal_id: str, plan: Plan, live: Json, lat: Json) -> Optional[tuple[str, str]]:
        """Returns None on success (>=1 accepted) else (error_code, message)."""
        eng, lim = self.engine, self.limits
        if getattr(eng, "replay", False) or (self.run_id != getattr(eng, "run_id", self.run_id)):
            return "READ_ONLY_RUN", "target run is a replay or stored run: injection refused (replay never injects)"
        cfg = getattr(eng, "cfg", None)
        if cfg is not None and not getattr(cfg, "allow_test_faults", True):
            return "TEST_FAULTS_DISABLED", "engine has test faults disabled (allow_test_faults=false)"
        try:
            from ..engine import schemas as S
            with_params = "params" in S.InjectFault.model_fields
        except Exception:  # noqa: BLE001
            with_params = False
        live["params_sent"] = with_params
        async with self.gov.lock(self.run_id):
            used = self.gov.used(eng, self.run_id)
            n = len(plan.injections)
            if used + n > lim.max_faults_per_run:
                return "RATE_LIMITED", f"per-run cap: {used} launcher faults already injected, cap {lim.max_faults_per_run}"
            since = time.monotonic() - self.gov.last_launch.get(self.run_id, -1e9)
            if since < lim.min_interval_s:
                return "RATE_LIMITED", f"launches on one run must be {lim.min_interval_s:.0f}s apart (retry in {lim.min_interval_s - since:.0f}s)"
            self.gov.last_launch[self.run_id] = time.monotonic()
            live["baseline_incident_ids"] = [i["id"] for i in _incidents(eng) if i.get("id")]
            live["injected_tick"] = int(getattr(eng, "tick", 0) or 0)
            t = time.perf_counter()
            issuer = f"{ISSUER}:{_sanitize(principal_id)}"
            for idx, inj in enumerate(plan.injections):
                cid = f"scn-{request_id}-{idx}"
                cmd = {"command_id": cid, "kind": "test.inject_fault", "args": inj.args(with_params), "actor_type": "operator",
                       "principal": issuer, "run_id": self.run_id}
                try:
                    ack = await self._submit(cmd)
                except Exception as e:  # noqa: BLE001
                    ack = {"accepted": False, "reason": f"submit failed: {type(e).__name__}"}
                ok = bool(ack.get("accepted"))
                if ok and not ack.get("duplicate"):
                    self.gov.accepted[self.run_id] = self.gov.accepted.get(self.run_id, 0) + 1
                live["injections"].append({**inj.view(), "command_id": cid, "accepted": ok, "duplicate": bool(ack.get("duplicate")),
                                           "reason": ack.get("reason"), "effects": ack.get("effects")})
            lat["inject_ms"] = round((time.perf_counter() - t) * 1000.0, 2)
        if any(i["accepted"] for i in live["injections"]):
            return None
        return "INJECTION_REFUSED", "; ".join(f"{i['kind']}@{i['target']}: {i['reason']}" for i in live["injections"])

    def _emit(self, kind: str, entity_id: str, payload: Json) -> None:
        fn = getattr(self.engine, "emit_internal", None)
        if callable(fn):
            try:
                fn(kind, entity_id, payload)
            except Exception:  # noqa: BLE001
                log.debug("emit %s failed", kind, exc_info=True)

    async def watch_links(self, request_id: str, result: Json) -> None:
        """Background: link incidents the monitor opens after the injection (bounded)."""
        live, interp = result.get("live"), result.get("_interp")
        if not live or interp is None:
            return
        deadline = time.monotonic() + self.limits.link_wait_s
        while time.monotonic() < deadline:
            await asyncio.sleep(self.limits.link_poll_s)
            new = refresh_links(self.engine, live)
            if new:
                self._save(request_id, interp, live)
                self._emit("scenario_request.linked", request_id, {"request_id": request_id, "run_id": self.run_id, "incident_ids": live["incident_ids"]})
                return


_TASKS: set = set()


def launch_scenario_request(ctx: Any, request_id: str) -> "asyncio.Task":
    """Route entry: live pipeline when the engine can take commands, else the legacy recorded-episode worker."""
    if not live_capable(ctx):
        from ..scenarios.worker import process_scenario_request
        t = asyncio.create_task(process_scenario_request(ctx.engine, request_id))
    else:
        async def go() -> Json:
            launcher = LiveLauncher(ctx.engine, scenario_store(ctx.engine), run_id=ctx.active_run_id, settings=ctx.settings,
                                    model_client=getattr(ctx, "scenario_model_client", None), laya=getattr(ctx, "scenario_laya", None),
                                    limits=getattr(ctx, "scenario_limits", None), governor=getattr(ctx, "scenario_governor", None))
            res = await launcher.run(request_id)
            if res.get("ok") and res.get("live") and not res["live"].get("incident_ids"):
                w = asyncio.create_task(launcher.watch_links(request_id, res))
                _TASKS.add(w)
                w.add_done_callback(_TASKS.discard)
            return {k: v for k, v in res.items() if k != "_interp"}
        t = asyncio.create_task(go())
    _TASKS.add(t)
    t.add_done_callback(_TASKS.discard)
    return t


def refresh_record(ctx: Any, rec: Json) -> Json:
    """GET-time lazy link (covers a watcher lost to a restart). Read-only on the engine; only the request record is updated."""
    live = (rec.get("validation_report") or {}).get("live")
    if not live or live.get("incident_ids") or rec.get("status") != "READY" or not live.get("injections"):
        return rec
    eng = ctx.engine
    if getattr(eng, "replay", False) or live.get("run_id") != ctx.active_run_id:
        return rec
    new = refresh_links(eng, live)
    if new:
        store = scenario_store(eng)
        interp = {k: rec.get(k) for k in ("laya_result", "laya_engine", "crusoe_proposal", "crusoe_model", "assumptions", "resolved_assets",
                                          "definition_of_done", "validation_report", "latencies_ms", "tokens_used")}
        interp["validation_report"] = dict(rec["validation_report"], live=live)
        try:
            store.save_scenario_interpretation(rec["request_id"], **interp)
        except Exception:  # noqa: BLE001
            log.debug("lazy link persist failed", exc_info=True)
        rec = dict(rec, validation_report=interp["validation_report"])
    return rec
