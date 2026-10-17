"""Durable Scenario Request Worker for LOOPKEEPER V9.

Processes asynchronous scenario requests from the PostgreSQL outbox through the
Laya classifier -> Crusoe interpreter -> deterministic compiler -> episode runner pipeline.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, Optional

from .compiler import compile_scenario
from .episode import build_recorded_episode
from ..intelligence.crusoe import CrusoeClient, IntelligenceConfig
from ..intelligence.laya_classifier import get_laya_classifier
from ..intelligence.scenario_interpreter import interpret_incident_prompt

log = logging.getLogger("loopkeeper.scenarios.worker")

async def process_scenario_request(live_engine: Any, request_id: str) -> dict[str, Any]:
    """Execute the end-to-end scenario launch pipeline for a single request_id."""
    storage = live_engine.storage
    if storage is None:
        raise RuntimeError("Authoritative storage required to process scenario request")

    req = storage.get_scenario_request(request_id)
    if not req:
        raise ValueError(f"Scenario request {request_id} not found")

    prompt = req["original_text"]
    principal_id = req["principal_id"]
    t0_all = time.perf_counter()

    try:
        # Step 1: Laya Classification
        storage.update_scenario_request(request_id, status="PROCESSING", phase="CLASSIFYING")
        t0_laya = time.perf_counter()
        laya_clf = get_laya_classifier()
        laya_result = laya_clf.triage_scenario_prompt(prompt)
        dt_laya = round((time.perf_counter() - t0_laya) * 1000.0, 2)
        log.info("Request %s Laya triage completed in %.1f ms: %s", request_id, dt_laya, laya_result["incident_family"])

        # Step 2: Crusoe Nemotron Interpretation
        storage.update_scenario_request(request_id, phase="INTERPRETING")
        t0_crusoe = time.perf_counter()
        crusoe_cfg = IntelligenceConfig.from_env()
        crusoe_client = CrusoeClient(crusoe_cfg) if crusoe_cfg.configured else None
        proposal, crusoe_model, crusoe_meta = await interpret_incident_prompt(prompt, crusoe_client)
        dt_crusoe = round((time.perf_counter() - t0_crusoe) * 1000.0, 2)
        log.info("Request %s Crusoe parse completed in %.1f ms (%s): %s", request_id, dt_crusoe, crusoe_model, proposal.summary)

        # Step 3: Deterministic Compilation & Safety Validation
        storage.update_scenario_request(request_id, phase="VALIDATING")
        topo = live_engine.topology()
        seed = 1337 + (hash(request_id) % 10000)
        compiled_def, compiler_meta = compile_scenario(proposal, laya_result, topo, seed=seed)

        # Save complete interpretation to DB
        storage.save_scenario_interpretation(
            request_id,
            laya_result=laya_result,
            laya_engine=laya_result.get("engine", "rule_fallback"),
            crusoe_proposal=proposal.model_dump(),
            crusoe_model=crusoe_model,
            assumptions=compiler_meta.get("assumptions", []),
            resolved_assets=compiler_meta.get("resolved_assets", []),
            definition_of_done=compiler_meta.get("definition_of_done", []),
            validation_report=compiler_meta.get("validation_report", {}),
            latencies_ms={
                "laya_ms": dt_laya,
                "crusoe_ms": dt_crusoe,
                "total_pipeline_ms": round((time.perf_counter() - t0_all) * 1000.0, 2),
            },
            tokens_used={
                "tokens_in": crusoe_meta.get("tokens_in", 0),
                "tokens_out": crusoe_meta.get("tokens_out", 0),
            },
        )

        # Step 4: Run Creation & Physics Initiation
        storage.update_scenario_request(request_id, phase="CREATING_RUN")
        ep_request = {
            "scenario_id": compiled_def.scenario_id,
            "seed": seed,
            "simulation_speed": 1,
            "duration_sim_s": 1800,
            "idempotency_key": req.get("idempotency_key"),
        }
        run_summary = await build_recorded_episode(live_engine, ep_request, principal_id)
        run_id = run_summary.get("run_id")

        # Step 5: Mark Ready / Running
        storage.update_scenario_request(
            request_id,
            status="READY",
            phase="RUNNING",
            run_id=run_id,
            error_code=None,
            error_message=None,
        )

        # Notify via live engine stream
        try:
            live_engine.emit_internal("scenario_request.completed", request_id, {
                "request_id": request_id,
                "run_id": run_id,
                "scenario_id": compiled_def.scenario_id,
                "phase": "RUNNING",
                "status": "READY",
            })
        except Exception:
            pass

        return {
            "ok": True,
            "request_id": request_id,
            "run_id": run_id,
            "scenario_id": compiled_def.scenario_id,
            "phase": "RUNNING",
            "status": "READY",
        }

    except Exception as e:
        log.exception("Scenario request %s failed in phase: %s", request_id, e)
        storage.update_scenario_request(
            request_id,
            status="FAILED",
            phase="FAILED",
            error_code="PIPELINE_ERROR",
            error_message=str(e)[:300],
        )
        return {
            "ok": False,
            "request_id": request_id,
            "phase": "FAILED",
            "status": "FAILED",
            "error": str(e),
        }
