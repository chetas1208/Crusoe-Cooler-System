"""V11 Definition of Done + agent team read APIs (per-run authorisation like every run read; live runs read the engine's tracking mirror,
stored runs read the persisted done_contracts rows).

* GET /runs/{run_id}/incidents/{incident_id}/contract       the frozen DoneContract (checks, thresholds, hold timers, Layer A / B, revisions, history)
* GET /runs/{run_id}/incidents/{incident_id}/verifications   verification attempts (each with the contract version / hash it was judged against)
* GET /runs/{run_id}/incidents/{incident_id}/team            the SEN-01..05 seats, the task DAG (parent links, robots as children), budgets and loop / drift warnings
* GET /runs/{run_id}/contracts                                contract summaries of the run"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .context import RunScope, run_scope
from .scrub import scrub

router = APIRouter()
SEATS = {"SEN-01": "goal architect / planner", "SEN-02": "INPIPE coordinator", "SEN-03": "OUTRIG coordinator", "SEN-04": "safety arbiter", "SEN-05": "independent verifier"}
LIMITS = {"max_depth": 3, "max_active_llm_subtasks_per_incident": 6, "max_concurrent_high_cost_calls": 2, "max_plan_revisions": 2}


def _track(sc: RunScope) -> Any:
    return getattr(sc.engine, "track", None)


def _storage(sc: RunScope) -> Any:
    return getattr(sc.engine, "storage", None)


def _contract(sc: RunScope, iid: str) -> dict | None:
    tr = _track(sc)
    if tr is not None:
        return tr.contracts.get(iid)
    st = _storage(sc)
    rows = st.load_contracts(sc.run_id, iid) if st is not None else []
    return rows[0]["doc"] if rows else None


@router.get("/runs/{run_id}/incidents/{incident_id}/contract")
def contract(incident_id: str, sc: RunScope = Depends(run_scope("read"))):
    c = _contract(sc, incident_id)
    if c is None:
        raise HTTPException(404, "no Definition of Done for this incident")
    return scrub({"run_id": sc.run_id, "incident_id": incident_id, "contract": c})


@router.get("/runs/{run_id}/contracts")
def contracts(sc: RunScope = Depends(run_scope("read"))):
    tr = _track(sc)
    docs = list(tr.contracts.values()) if tr is not None else [r["doc"] for r in (_storage(sc).load_contracts(sc.run_id) if _storage(sc) else [])]
    return scrub({"run_id": sc.run_id, "contracts": [{"incident_id": c["incident_id"], "id": c["id"], "version": c["version"], "state": c["state"],
                                                      "terminal_state": c.get("terminal_state"), "frozen_hash": c.get("frozen_hash")} for c in docs]})


@router.get("/runs/{run_id}/incidents/{incident_id}/verifications")
def verifications(incident_id: str, sc: RunScope = Depends(run_scope("read"))):
    tr = _track(sc)
    if tr is not None:
        vs = sorted((v for v in tr.verifications.values() if v.get("incident_id") == incident_id), key=lambda v: v.get("attempt", 0))
    else:
        c = _contract(sc, incident_id) or {}
        vs = c.get("history", [])
    return scrub({"run_id": sc.run_id, "incident_id": incident_id, "verifications": vs})


@router.get("/runs/{run_id}/incidents/{incident_id}/team")
def team(incident_id: str, sc: RunScope = Depends(run_scope("read"))):
    tr = _track(sc)
    if tr is None:
        raise HTTPException(404, "team graph is available for the live run only")
    tasks = [t for t in tr.tasks.values() if t.get("incident_id") == incident_id]
    if not tasks:
        raise HTTPException(404, "unknown incident")
    nodes = [{"id": t["id"], "seat": t.get("agent_id") or "SEN-01", "role": t.get("role"), "kind": t.get("kind"), "title": t.get("title"), "status": t.get("status"),
              "parent_id": t.get("parent_id"), "depth": t.get("depth"), "robot_id": t.get("robot_id"),
              "model": {k: (t.get("model") or {}).get(k) for k in ("provider", "model_id", "fallback", "latency_ms")}, "tool_calls": len(t.get("tool_calls") or [])}
             for t in sorted(tasks, key=lambda x: x["id"])]
    seats = {s: {"seat": s, "function": f, "tasks": [n["id"] for n in nodes if n["seat"] == s]} for s, f in SEATS.items()}
    inc = tr.incidents.get(incident_id) or {}
    c = tr.contracts.get(incident_id) or {}
    llm = sum(1 for t in tasks if (t.get("model") or {}).get("fallback") is False)
    eng = getattr(sc.engine, "comms", None)
    warnings = []
    st = _storage(sc)
    if st is not None:
        try:
            for e in st.load_events(sc.run_id, kinds=["drift.detected", "loop.detected"], limit=200):
                if (e["payload"] or {}).get("incident_id") == incident_id:
                    warnings.append({"seq": e["seq"], "type": e["kind"], **{k: v for k, v in e["payload"].items() if k != "incident_id"}})
        except Exception:                                    # noqa: BLE001
            pass
    return scrub({"run_id": sc.run_id, "incident_id": incident_id, "seats": list(seats.values()), "tasks": nodes,
                  "edges": [{"from": n["parent_id"], "to": n["id"]} for n in nodes if n["parent_id"]],
                  "budgets": {"limits": LIMITS, "max_depth_seen": max((n["depth"] or 0) for n in nodes), "llm_tasks": llm, "tasks": len(nodes),
                              "plan_revisions": len([h for h in c.get("history", [])]) , "attempts": inc.get("attempts"), "contract_version": c.get("version")},
                  "warnings": warnings})
