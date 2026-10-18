"""V9 Natural-Language Scenario Request API.

Durable, asynchronous submission of natural language crisis prompts.
Returns HTTP 202 Accepted with a request_id and executes through the
Laya classifier -> Crusoe interpreter -> deterministic compiler -> episode runner pipeline.
"""
from __future__ import annotations

import asyncio
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from .safe_reads import SafeReadRoute
from pydantic import BaseModel, ConfigDict, Field

from .context import RunScope, ctx_of, principal_of, run_scope
from .scenario_live import admit_or_raise, launch_scenario_request, live_view, refresh_record, release_admission, scenario_store

log = logging.getLogger("loopkeeper.api.scenario_requests")
router = APIRouter(tags=["scenario_requests"], route_class=SafeReadRoute)

class ScenarioRequestCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    prompt: str = Field(min_length=3, max_length=2000, description="Natural language incident prompt")
    facility_id: str = Field(default="lab_01", min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.:\-]+$")
    source_run_id: Optional[str] = Field(default=None, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:\-]+$")
    requested_duration_seconds: int = Field(default=1800, ge=60, le=7200)
    requested_speed: int = Field(default=1, ge=1, le=3)
    auto_start: bool = True
    isolated: bool = True

class ScenarioRequestResponse(BaseModel):
    request_id: str
    status: str
    phase: str
    status_url: str
    created_at: str

_IDEM_KEY = re.compile(r"^[A-Za-z0-9_.:\-]{1,128}$")


def _iso(v: Any) -> str:
    return v.isoformat() if hasattr(v, "isoformat") else str(v)


def _owns(principal: Any, rec: dict) -> bool:
    """Owner or admin. Everyone else gets the same 404 as a missing id (no existence oracle)."""
    return principal.role == "admin" or rec.get("principal_id") == principal.id


@router.post("/scenario-requests", status_code=status.HTTP_202_ACCEPTED, response_model=ScenarioRequestResponse)
async def submit_scenario_request(
    body: ScenarioRequestCreate,
    request: Request,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
    sc: RunScope = Depends(run_scope("command")),     # authenticated, role >= operator, run in the principal's allow-list, run is the live one
):
    ctx, principal = sc.ctx, sc.principal
    principal_id = principal.id
    storage = scenario_store(ctx.engine)   # Postgres when present, else an in-memory request store (V11 live flow)
    if idempotency_key is not None and not _IDEM_KEY.fullmatch(idempotency_key):
        raise HTTPException(422, "invalid Idempotency-Key")
    idem = f"{principal_id[:40]}:{idempotency_key}" if idempotency_key else None   # keys are per principal: no cross-principal replay / read

    def respond(row: dict, st: Optional[str] = None, ph: Optional[str] = None) -> ScenarioRequestResponse:
        return ScenarioRequestResponse(request_id=row["request_id"], status=st or row["status"], phase=ph or row["phase"],
                                       status_url=f"/api/v1/scenario-requests/{row['request_id']}", created_at=_iso(row.get("created_at") or datetime.now(timezone.utc)))

    # 1. replay fast path: no quota, no pipeline
    if idem:
        existing = storage.get_scenario_request_by_idempotency(idem)
        if existing:
            return respond(existing)

    # 2. admission control BEFORE any row, model call or engine write (per-principal + per-client + global bucket/in-flight/hourly cap)
    admit_or_raise(ctx, request, principal_id)
    launched = False
    try:
        # 3. atomic create: the upsert decides; a concurrent duplicate gets the ORIGINAL row back and no pipeline is started for it
        request_id = f"req_{uuid.uuid4().hex[:12]}"
        job_id = f"job_{uuid.uuid4().hex[:12]}"
        row = storage.create_scenario_request(
            request_id=request_id, principal_id=principal_id, original_text=body.prompt,
            idempotency_key=idem, facility_id=body.facility_id, source_run_id=body.source_run_id,
        )
        if not row or row.get("request_id") != request_id:
            return respond(row) if row else respond({"request_id": request_id, "status": "QUEUED", "phase": "RECEIVED"})
        storage.enqueue_scenario_job(job_id=job_id, request_id=request_id, phase="RECEIVED")
        # 4. launch background async processing (V11: live-run injection; falls back to the recorded-episode worker)
        launch_scenario_request(ctx, request_id, admitted=True)
        launched = True
        return respond(row, "QUEUED", "RECEIVED")
    finally:
        if not launched:
            release_admission(ctx)

@router.get("/scenario-requests/{request_id}")
def get_scenario_request(request_id: str, request: Request):
    ctx = ctx_of(request)
    principal = principal_of(request)
    storage = scenario_store(ctx.engine)

    rec = storage.get_scenario_request(request_id)
    if not rec or not _owns(principal, rec):
        raise HTTPException(404, "scenario request not found")
    rec = refresh_record(ctx, rec)

    created_str = rec["created_at"].isoformat() if hasattr(rec["created_at"], "isoformat") else str(rec["created_at"])
    updated_str = rec["updated_at"].isoformat() if hasattr(rec["updated_at"], "isoformat") else str(rec["updated_at"])

    interpretation = None
    if rec.get("laya_result") or rec.get("crusoe_proposal") or rec.get("definition_of_done"):
        interpretation = {
            "laya": {
                "result": rec.get("laya_result"),
                "engine": rec.get("laya_engine"),
            },
            "crusoe": {
                "proposal": rec.get("crusoe_proposal"),
                "model": rec.get("crusoe_model"),
            },
            "compiler": {
                "assumptions": rec.get("assumptions") or [],
                "resolved_assets": rec.get("resolved_assets") or [],
                "definition_of_done": rec.get("definition_of_done") or [],
                "validation_report": rec.get("validation_report") or {},
            },
            "latencies_ms": rec.get("latencies_ms") or {},
            "tokens_used": rec.get("tokens_used") or {},
        }

    return {
        "request_id": rec["request_id"],
        "status": rec["status"],
        "phase": rec["phase"],
        "run_id": rec.get("run_id") or (live_view(rec) or {}).get("run_id"),
        "live": live_view(rec),
        "original_prompt": rec["original_text"],
        "interpretation": interpretation,
        "error_code": rec.get("error_code"),
        "error_message": rec.get("error_message"),
        "created_at": created_str,
        "updated_at": updated_str,
    }

@router.post("/scenario-requests/{request_id}/cancel")
def cancel_scenario_request(request_id: str, request: Request, sc: RunScope = Depends(run_scope("command"))):
    ctx = sc.ctx
    storage = scenario_store(ctx.engine)

    rec = storage.get_scenario_request(request_id)
    if not rec or not _owns(sc.principal, rec):
        raise HTTPException(404, "scenario request not found")

    if rec["status"] in ("READY", "FAILED", "CANCELED"):
        return {"ok": False, "message": f"Request already {rec['status']}"}

    storage.update_scenario_request(request_id, status="CANCELED", phase="CANCELED")
    return {"ok": True, "request_id": request_id, "status": "CANCELED"}
