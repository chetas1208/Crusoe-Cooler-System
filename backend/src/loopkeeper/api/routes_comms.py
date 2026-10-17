"""V10 communications REST: what the runtime really did, as typed CommunicationEventV1 records read from the persisted run log.

* ``GET /runs/{run_id}/communications``  filters: after_seq, before_seq, limit (1..200), kind (= message_type), agent_class, thread_id, until_tick,
  order (asc | desc), include_parent (fork lineage). Bounded pagination (``has_more`` + ``next_after_seq`` / ``prev_before_seq``).
* ``GET /runs/{run_id}/communications/{event_id}`` one record.
* ``GET /runs/{run_id}/replay/communications?cursor_tick=N`` the same list limited to ``sim_tick <= N`` (no future leakage); pure read of stored
  rows, no model or physics is run. A fork's own list starts at the fork point; ``include_parent=true`` prepends the (immutable) parent's records up to the
  fork checkpoint, so lineage reads as one monotonic ``seq`` line.
Per-run authorisation is the same ``run_scope('read')`` as every other run read (foreign / unknown run -> 404). Payloads are scrubbed again on the way out."""
from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from ..comms.schema import KINDS, to_v1
from ..engine.eventlog import to_envelope
from .context import RunScope, run_scope
from .scrub import scrub

router = APIRouter()
MAX_LIMIT = 200
AgentClass = Literal["SENTINEL", "INPIPE", "OUTRIG", "OPERATOR", "SYSTEM", "PROVIDER"]
Kind = Literal["agent_message", "task_transition", "tool_event", "verification", "safety", "operator", "simulation", "provider"]


def _storage(sc: RunScope) -> Any:
    st = getattr(sc.engine, "storage", None)
    if st is None or not hasattr(st, "load_communications"):
        raise HTTPException(501, "this engine has no communication log")
    return st


def _v1(run_id: str, row: dict) -> dict:
    return scrub(to_v1(to_envelope(run_id, row)))


def _lineage(st: Any, run_id: str) -> dict:
    row = None
    try:
        row = st.get_run(run_id)
    except Exception:                                    # noqa: BLE001
        pass
    if not row or not row.get("parent_run_id"):
        return {"parent_run_id": None}
    sid = (row.get("meta") or {}).get("fork_snapshot_id")
    cut = None
    if sid:
        try:
            snap = st.get_snapshot(row["parent_run_id"], sid)
            cut = int(snap["last_seq"]) if snap else None
        except Exception:                                # noqa: BLE001
            cut = None
    return {"parent_run_id": row["parent_run_id"], "fork_tick": row.get("fork_tick"), "fork_snapshot_id": sid, "parent_cut_seq": cut}


def _page(st: Any, run_id: str, *, after_seq: int, before_seq: Optional[int], limit: int, kind: Optional[str], agent_class: Optional[str],
          thread_id: Optional[str], until_tick: Optional[int], desc: bool, include_parent: bool) -> dict:
    lin = _lineage(st, run_id)
    segs: list[tuple[str, Optional[int], Optional[int]]] = []          # (run, after, before) in ascending seq order
    cut = lin.get("parent_cut_seq")
    if include_parent and lin.get("parent_run_id"):
        cap = (cut + 1) if cut is not None else None
        segs.append((lin["parent_run_id"], after_seq, cap if before_seq is None else min(before_seq, cap) if cap is not None else before_seq))
        segs.append((run_id, max(after_seq, cut or 0), before_seq))
    else:
        segs.append((run_id, after_seq, before_seq))
    if desc:
        segs.reverse()
    out: list[dict] = []
    for rid, a, b in segs:
        if len(out) > limit:
            break
        want = limit + 1 - len(out)
        rows = st.load_communications(rid, after_seq=int(a or 0), before_seq=b, until_tick=until_tick, limit=want, message_type=kind, agent_class=agent_class,
                                      thread_id=thread_id, newest_first=desc)
        if rid != run_id and until_tick is None and lin.get("fork_tick") is not None and cut is None:
            rows = [r for r in rows if r["tick"] <= int(lin["fork_tick"])]
        out.extend((rid, r) for r in rows)
    has_more = len(out) > limit
    out = out[:limit]
    events = [_v1(rid, r) for rid, r in out]
    if desc:
        events.reverse()
    seqs = [e["seq"] for e in events]
    return {"run_id": run_id, "events": events, "count": len(events), "has_more": has_more, "order": "desc" if desc else "asc",
            "next_after_seq": max(seqs) if seqs else after_seq, "prev_before_seq": min(seqs) if seqs else before_seq,
            "head_seq": st.last_event_seq(run_id), "kinds": list(KINDS), "lineage": lin}


@router.get("/runs/{run_id}/communications")
def list_communications(after_seq: int = Query(default=0, ge=0), before_seq: Optional[int] = Query(default=None, ge=1),
                        limit: int = Query(default=100, ge=1, le=MAX_LIMIT), kind: Optional[Kind] = Query(default=None),
                        agent_class: Optional[AgentClass] = Query(default=None), thread_id: Optional[str] = Query(default=None, max_length=96),
                        until_tick: Optional[int] = Query(default=None, ge=0), order: Literal["asc", "desc"] = Query(default="asc"),
                        include_parent: bool = Query(default=False), sc: RunScope = Depends(run_scope("read"))):
    st = _storage(sc)
    return _page(st, sc.run_id, after_seq=after_seq, before_seq=before_seq, limit=limit, kind=kind, agent_class=agent_class, thread_id=thread_id,
                 until_tick=until_tick, desc=order == "desc", include_parent=include_parent)


@router.get("/runs/{run_id}/replay/communications")
def replay_communications(cursor_tick: int = Query(ge=0), after_seq: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=MAX_LIMIT),
                          kind: Optional[Kind] = Query(default=None), agent_class: Optional[AgentClass] = Query(default=None),
                          thread_id: Optional[str] = Query(default=None, max_length=96), include_parent: bool = Query(default=False),
                          sc: RunScope = Depends(run_scope("read"))):
    st = _storage(sc)
    out = _page(st, sc.run_id, after_seq=after_seq, before_seq=None, limit=limit, kind=kind, agent_class=agent_class, thread_id=thread_id,
                until_tick=cursor_tick, desc=False, include_parent=include_parent)
    out["cursor_tick"] = cursor_tick
    out["model_calls"] = 0                                 # replay reads stored rows only
    return out


@router.get("/runs/{run_id}/communications/{event_id}")
def get_communication(event_id: str, sc: RunScope = Depends(run_scope("read"))):
    st = _storage(sc)
    rows = st.load_communications(sc.run_id, limit=1, event_id=event_id)
    if not rows:
        raise HTTPException(404, "unknown communication event")
    return _v1(sc.run_id, rows[0])
