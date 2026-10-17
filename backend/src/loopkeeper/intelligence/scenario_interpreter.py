"""Crusoe Managed Inference semantic scenario parser for LOOPKEEPER V9.

Translates vague natural language incident reports into structured, strictly
bounded ScenarioProposalV1 models with declared assumptions.
Deterministic fallback is engaged if Crusoe returns 402/payment or is offline,
truthfully recording the engine without fabricating tokens or badges.
"""
from __future__ import annotations

import logging
import os
import re
import time
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field, ValidationError

from .crusoe import CrusoeClient, IntelligenceConfig, ModelError, extract_json

log = logging.getLogger("loopkeeper.intelligence.interpreter")

Family = Literal[
    "flow_restriction",
    "pump_failure",
    "leak",
    "overheating",
    "heat_rejection_loss",
    "power_failure",
    "fire_smoke",
    "sensor_fault",
    "unknown",
]

class CandidateFault(BaseModel):
    family: Family
    severity: Literal["minor", "moderate", "severe", "emergency"] = "moderate"
    asset_query: Optional[str] = None
    cause_hint: Optional[str] = None

class ScenarioProposalV1(BaseModel):
    intent: Literal["simulate", "inspect", "question"] = "simulate"
    summary: str = Field(min_length=1, max_length=300)
    proposed_faults: list[CandidateFault] = Field(min_length=1, max_length=4)
    location_hints: list[str] = Field(default_factory=list, max_length=8)
    assumptions: list[str] = Field(default_factory=list, max_length=8)
    unresolved_references: list[str] = Field(default_factory=list, max_length=8)
    needs_clarification: bool = False
    candidate_goals: list[str] = Field(default_factory=list, max_length=5)

SYSTEM_PROMPT = """You are a semantic parser for a simulated data-center cooling facility (LOOPKEEPER).
Interpret a user's vague incident report into a bounded JSON proposal adhering strictly to this schema:
{
  "intent": "simulate" | "inspect" | "question",
  "summary": "1-sentence summary under 240 chars",
  "proposed_faults": [
    {
      "family": "flow_restriction" | "pump_failure" | "leak" | "overheating" | "heat_rejection_loss" | "power_failure" | "fire_smoke" | "sensor_fault",
      "severity": "minor" | "moderate" | "severe" | "emergency",
      "asset_query": "approximate asset/location string or null",
      "cause_hint": "physical cause hint or null"
    }
  ],
  "location_hints": ["string"],
  "assumptions": ["string"],
  "unresolved_references": ["string"],
  "needs_clarification": boolean,
  "candidate_goals": ["string"]
}

Facility context:
- 5 rack rows: Row A, Row B, Row C, Row D, Row E (8 racks each: rack_a01..rack_e08).
- "middle racks" -> Row C racks (rack_c03..rack_c06) or Road 2 / Road 3.
- "back racks" / "end racks" -> Row E racks or high rack indices (07..08).
- Primary cooling equipment: CDU (CDU-01, CDU-02), FWS pumps (pump_fws_duty, pump_fws_stby), TCS pumps (pump_tcs_duty, pump_tcs_stby), basket strainers (str_01, str_02).
- Technology cooling loop (TCS) circulates to server racks; facility water system (FWS) rejects heat outdoors.
- Closed closed-loop boundaries; no mass transfer across CDU plate heat exchanger.
- Do not output SQL, code, or arbitrary coordinates. Output ONLY JSON.
"""

def parse_with_deterministic_rules(text: str) -> ScenarioProposalV1:
    """Truthful domain rule-based semantic parser when Crusoe is unavailable or returns 402."""
    t = text.lower()
    faults: list[CandidateFault] = []
    assumptions: list[str] = []
    location_hints: list[str] = []
    goals: list[str] = []

    # Location resolution
    asset_query = None
    if "middle" in t or "center" in t or "central" in t:
        location_hints.append("middle rack suite (Row C)")
        assumptions.append("Mapped 'middle racks' to central Row C (rack_c04)")
        asset_query = "rack_c04"
    elif "back" in t or "end" in t or "rear" in t:
        location_hints.append("back rack row (Row E)")
        assumptions.append("Mapped 'back racks' to Row E (rack_e04)")
        asset_query = "rack_e04"
    elif "front" in t:
        location_hints.append("front rack row (Row A)")
        assumptions.append("Mapped 'front racks' to Row A (rack_a04)")
        asset_query = "rack_a04"
    elif "road 2" in t or "aisle 2" in t:
        location_hints.append("Road 02 corridor")
        asset_query = "road_02"
    elif "cdu" in t or "pump" in t:
        location_hints.append("CDU Mechanical Gallery")
        asset_query = "cdu_01"

    # Family & severity matching
    if any(k in t for k in ["fire", "smoke", "burn", "arc", "spark"]):
        faults.append(CandidateFault(
            family="fire_smoke", severity="emergency", asset_query=asset_query or "rack_c05",
            cause_hint="Electrical arc surge causing localized thermal smoke excursion"
        ))
        goals.append("Enforce 3.6m robot evacuation perimeter and isolate rack power")
        assumptions.append("Modeled as electrical power surge and smoke exclusion zone")
    elif any(k in t for k in ["leak", "burst", "rupture", "flood", "wet", "puddle", "spill"]):
        faults.append(CandidateFault(
            family="leak", severity="severe", asset_query=asset_query or "manifold_row_c",
            cause_hint="Coolant supply manifold seal failure with fluid puddle expansion"
        ))
        goals.append("Dispatch OUTRIG to isolate header valve and contain floor puddle")
        assumptions.append("Torricelli fluid discharge with Road 02 obstacle hazard")
    elif any(k in t for k in ["overheat", "hot", "temperature", "temp", "margin"]):
        faults.append(CandidateFault(
            family="overheating", severity="severe", asset_query=asset_query or "rack_c04",
            cause_hint="TCS coolant starvation causing server core thermal margin collapse"
        ))
        goals.append("Restore TCS coolant flow to keep rack thermal margin > 8.0 K")
        assumptions.append("Assumed technology-cooling mass flow rate drop")
    elif any(k in t for k in ["pump", "circulation"]):
        faults.append(CandidateFault(
            family="pump_failure", severity="severe", asset_query="pump_tcs_duty",
            cause_hint="Primary circulation pump electrical drive trip"
        ))
        goals.append("Switch circulation duty to standby pump within 45 seconds")
        assumptions.append("Primary pump offline; secondary pump on hot standby")
    elif any(k in t for k in ["power", "ups", "blackout", "substation", "grid"]):
        faults.append(CandidateFault(
            family="power_failure", severity="emergency", asset_query="substation_feed",
            cause_hint="Main facility power loss, transferring to 15-minute battery reserve"
        ))
        goals.append("Shed high-compute racks before battery depletion")
        assumptions.append("15-minute battery reserve active")
    elif any(k in t for k in ["sensor", "drift", "lying", "false", "offset", "telemetry"]):
        faults.append(CandidateFault(
            family="sensor_fault", severity="minor", asset_query=asset_query or "sensor_tcs_temp_c",
            cause_hint="Temperature RTD sensor calibration drift"
        ))
        goals.append("Verify telemetry with redundant sensor and avoid false shutdown")
        assumptions.append("Hydraulic loop physical temperature remains nominal")
    else: # Default flow restriction / general cooling issue
        faults.append(CandidateFault(
            family="flow_restriction", severity="moderate", asset_query=asset_query or "pipe_tcs_c_supply",
            cause_hint="Cooling pipe lumen particulate accumulation or strainer clogging"
        ))
        goals.append("Deploy INPIPE crawler for lumen scan and deposit clearance")
        assumptions.append("Assumed partial lumen flow restriction")

    summary = f"Simulate {faults[0].family.replace('_', ' ')} incident near {location_hints[0] if location_hints else 'data hall racks'}"

    return ScenarioProposalV1(
        intent="simulate",
        summary=summary[:240],
        proposed_faults=faults,
        location_hints=location_hints,
        assumptions=assumptions,
        unresolved_references=[],
        needs_clarification=False,
        candidate_goals=goals,
    )

async def interpret_incident_prompt(
    prompt: str,
    client: CrusoeClient | None = None
) -> tuple[ScenarioProposalV1, str, dict[str, Any]]:
    """Parse user prompt using Crusoe Nemotron if available, else deterministic rules.
    Returns: (proposal, model_id_used, metadata)
    """
    t0 = time.perf_counter()
    text = (prompt or "").strip()
    meta: dict[str, Any] = {"tokens_in": 0, "tokens_out": 0, "latency_ms": 0, "fallback_active": True}

    if client is not None and client.cfg.configured:
        try:
            resp = await client.complete_json(
                system=SYSTEM_PROMPT,
                user=f"Report: {text}",
                schema_name="ScenarioProposalV1",
                timeout_s=30.0,
            )
            dt = round((time.perf_counter() - t0) * 1000.0, 2)
            parsed = extract_json(resp.text)
            proposal = ScenarioProposalV1.model_validate(parsed)
            meta.update({
                "tokens_in": resp.tokens_in or 0,
                "tokens_out": resp.tokens_out or 0,
                "latency_ms": dt,
                "fallback_active": False,
            })
            return proposal, client.model_id, meta
        except (ModelError, ValidationError, Exception) as e:
            log.warning("Crusoe interpretation failed (%s); using deterministic semantic parser.", e)

    # Truthful fallback
    dt = round((time.perf_counter() - t0) * 1000.0, 2)
    proposal = parse_with_deterministic_rules(text)
    meta["latency_ms"] = dt
    meta["fallback_active"] = True
    return proposal, "deterministic-semantic-parser-v1", meta
