"""V9 Natural-Language Scenario Request API.

Durable, asynchronous submission of natural language crisis prompts.
Returns HTTP 202 Accepted with a request_id and executes through the
Laya classifier -> Crusoe interpreter -> deterministic compiler -> episode runner pipeline.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from .context import ctx_of, principal_of
from ..scenarios.worker import process_scenario_request

log = logging.getLogger("loopkeeper.api.scenario_requests")
router = APIRouter(tags=["scenario_requests"])

class ScenarioRequestCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    prompt: str = Field(min_length=3, max_length=2000, description="Natural language incident prompt")
    facility_id: str = Field(default="lab_01")
    source_run_id: Optional[str] = None
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

@router.post("/scenario-requests", status_code=status.HTTP_202_ACCEPTED, response_model=ScenarioRequestResponse)
async def submit_scenario_request(
    body: ScenarioRequestCreate,
    request: Request,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    ctx = ctx_of(request)
    principal = principal_of(request)
    principal_id = principal.id if principal else "operator"
    storage = ctx.engine.storage

    if storage is None:
        raise HTTPException(503, "Storage unavailable for scenario requests")

    # 1. Idempotency check
    if idempotency_key:
        existing = storage.get_scenario_request_by_idempotency(idempotency_key)
        if existing:
            created_str = existing["created_at"].isoformat() if hasattr(existing["created_at"], "isoformat") else str(existing["created_at"])
            return ScenarioRequestResponse(
                request_id=existing["request_id"],
                status=existing["status"],
                phase=existing["phase"],
                status_url=f"/api/v1/scenario-requests/{existing['request_id']}",
                created_at=created_str,
            )

    # 2. Create durable request & outbox job
    request_id = f"req_{uuid.uuid4().hex[:12]}"
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    
    row = storage.create_scenario_request(
        request_id=request_id,
        principal_id=principal_id,
        original_text=body.prompt,
        idempotency_key=idempotency_key,
        facility_id=body.facility_id,
        source_run_id=body.source_run_id,
    )
    storage.enqueue_scenario_job(job_id=job_id, request_id=request_id, phase="RECEIVED")

    # 3. Launch background async processing
    asyncio.create_task(process_scenario_request(ctx.engine, request_id))

    created_at_dt = row.get("created_at") or datetime.now(timezone.utc)
    created_str = created_at_dt.isoformat() if hasattr(created_at_dt, "isoformat") else str(created_at_dt)

    return ScenarioRequestResponse(
        request_id=request_id,
        status="QUEUED",
        phase="RECEIVED",
        status_url=f"/api/v1/scenario-requests/{request_id}",
        created_at=created_str,
    )

@router.get("/scenario-requests/{request_id}")
def get_scenario_request(request_id: str, request: Request):
    ctx = ctx_of(request)
    storage = ctx.engine.storage
    if storage is None:
        raise HTTPException(503, "Storage unavailable")

    rec = storage.get_scenario_request(request_id)
    if not rec:
        raise HTTPException(404, f"Scenario request {request_id} not found")

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
        "run_id": rec.get("run_id"),
        "original_prompt": rec["original_text"],
        "interpretation": interpretation,
        "error_code": rec.get("error_code"),
        "error_message": rec.get("error_message"),
        "created_at": created_str,
        "updated_at": updated_str,
    }

@router.post("/scenario-requests/{request_id}/cancel")
def cancel_scenario_request(request_id: str, request: Request):
    ctx = ctx_of(request)
    storage = ctx.engine.storage
    if storage is None:
        raise HTTPException(503, "Storage unavailable")

    rec = storage.get_scenario_request(request_id)
    if not rec:
        raise HTTPException(404, f"Scenario request {request_id} not found")

    if rec["status"] in ("READY", "FAILED", "CANCELED"):
        return {"ok": False, "message": f"Request already {rec['status']}"}

    storage.update_scenario_request(request_id, status="CANCELED", phase="CANCELED")
    return {"ok": True, "request_id": request_id, "status": "CANCELED"}
