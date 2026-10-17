"""LangGraph state shared by SENTINEL / INPIPE / OUTRIG / verifier graphs (checkpointed, JSON only)."""
from __future__ import annotations

import operator
from typing import Annotated, Any, TypedDict

RESET = {"__reset__": True}


def merge_tasks(a: dict | None, b: dict | None) -> dict:
    return {**(a or {}), **(b or {})}


def add_or_reset(a: list | None, b: Any) -> list:
    if isinstance(b, dict) and b.get("__reset__"):
        return []
    return (a or []) + list(b or [])


def max_int(a: int | None, b: int | None) -> int:
    return max(a or 0, b or 0)


class IncState(TypedDict, total=False):
    incident: dict          # contract Incident (source of truth for stage/status/evidence/hypotheses)
    det: dict               # originating Detection
    tasks: Annotated[dict, merge_tasks]   # task_id -> AgentTask
    task_seq: int
    ev_seq: int
    new_evidence: Annotated[list, add_or_reset]
    child_tasks: Annotated[list, add_or_reset]  # ids of reviewer/probe tasks (reconcile caused_by)
    probe_requests: list    # pending bounded follow-up probes
    probe_depth: int
    baseline: dict          # verification 'before' metrics, taken at incident open
    inspection: dict        # INPIPE inspect result
    plan: dict              # chosen intervention {action,target_id,...}
    safety: dict            # last safety verdict
    work: dict              # request handed to INPIPE/OUTRIG graphs
    work_result: dict       # their result
    verify: dict            # last verification outcome {ok}
    attempt: int
    replans: int
    tokens_used: Annotated[int, max_int]
    outcome: str            # resolved | dismissed | escalated
    esc_reason: str
    contradiction: str
    robot: str              # crawler held by this incident
