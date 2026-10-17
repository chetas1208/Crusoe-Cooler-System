"""Integration tests for LOOPKEEPER V9 Natural-Language Crisis Launcher.

Tests the asynchronous pipeline:
1. REST submission (202 Accepted + Idempotency)
2. Laya Router classification & triage
3. Crusoe Nemotron intent parser with truthful fallback
4. Deterministic compiler & Definition of Done generation
5. Request cancellation & query endpoints
"""
from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from loopkeeper.intelligence.laya_classifier import LayaIncidentClassifier, get_laya_classifier
from loopkeeper.intelligence.scenario_interpreter import (
    ScenarioProposalV1,
    interpret_incident_prompt,
    parse_with_deterministic_rules,
)
from loopkeeper.scenarios.compiler import compile_scenario, resolve_location_asset
from loopkeeper.scenarios.registry import get_definition


def test_laya_router_triage():
    """Verify Laya classification identifies incident families with calibrated confidence."""
    clf = get_laya_classifier()
    
    # 1. Flow restriction / blocked pipe
    res1 = clf.triage_scenario_prompt("Water near the middle racks is blocked and overheating.")
    assert res1["incident_family"] in ("flow_restriction", "overheating")
    assert res1["urgency"] in ("severe", "moderate")
    assert res1["confidence"] > 0.4

    # 2. Leak / flooding
    res2 = clf.triage_scenario_prompt("Severe coolant puddle and pipe leak near manifold valve.")
    assert res2["incident_family"] in ("leak", "flow_restriction")

    # 3. Electrical / smoke
    res3 = clf.triage_scenario_prompt("Thick black smoke and burning smell in rack aisle.")
    assert res3["incident_family"] in ("fire_smoke", "power_failure")


def test_crusoe_interpreter_fallback_contract():
    """Verify Crusoe parser produces typed ScenarioProposalV1 with declared assumptions."""
    prompt = "The cooling near the back racks seems to be dying and one pipe is probably blocked. Fix it."
    proposal = parse_with_deterministic_rules(prompt)

    assert isinstance(proposal, ScenarioProposalV1)
    assert len(proposal.proposed_faults) > 0
    assert proposal.proposed_faults[0].family in ("flow_restriction", "overheating")
    assert len(proposal.assumptions) > 0


def test_scenario_compiler_and_definition_of_done():
    """Verify deterministic scenario compiler resolves assets and generates 3 invariants."""
    topo = {
        "assets": [
            {"id": "rack_c04", "type": "rack"},
            {"id": "rack_e04", "type": "rack"},
            {"id": "cdu_01", "type": "cdu"},
            {"id": "strainer_02", "type": "strainer"},
        ]
    }

    # 1. Location resolution
    assert resolve_location_asset("middle racks", topo) == "rack_c04"
    assert resolve_location_asset("back racks", topo) == "rack_e04"

    # 2. Compilation
    prompt = "Something is wrong with the water near the middle racks, maybe overheating. Handle it."
    proposal = parse_with_deterministic_rules(prompt)
    laya_triage = {"incident_family": "overheating", "urgency": "severe", "confidence": 0.85}

    compiled_def, compiler_meta = compile_scenario(proposal, laya_triage, topo, seed=1337)
    
    assert compiled_def.scenario_id in ("CR-03", "CR-06", "CR-01")
    assert len(compiler_meta["definition_of_done"]) >= 3
    assert any("nominal threshold" in dod for dod in compiler_meta["definition_of_done"])
    assert any("TCS supply temperature" in dod for dod in compiler_meta["definition_of_done"])
    assert any("alarms" in dod for dod in compiler_meta["definition_of_done"])


from datetime import datetime, timezone

class InMemoryScenarioStorage:
    def __init__(self):
        self.requests = {}
        self.jobs = {}

    def create_scenario_request(self, request_id, principal_id, original_text, idempotency_key=None, facility_id="lab_01", source_run_id=None):
        now = datetime.now(timezone.utc)
        row = {
            "request_id": request_id,
            "principal_id": principal_id,
            "facility_id": facility_id,
            "source_run_id": source_run_id,
            "idempotency_key": idempotency_key,
            "original_text": original_text,
            "status": "QUEUED",
            "phase": "RECEIVED",
            "run_id": None,
            "laya_result": None,
            "laya_engine": None,
            "crusoe_proposal": None,
            "crusoe_model": None,
            "assumptions": [],
            "resolved_assets": [],
            "definition_of_done": [],
            "validation_report": {},
            "latencies_ms": {},
            "tokens_used": {},
            "error_code": None,
            "error_message": None,
            "created_at": now,
            "updated_at": now,
        }
        self.requests[request_id] = row
        return row

    def get_scenario_request(self, request_id):
        return self.requests.get(request_id)

    def get_scenario_request_by_idempotency(self, idempotency_key):
        for r in self.requests.values():
            if r.get("idempotency_key") == idempotency_key:
                return r
        return None

    def enqueue_scenario_job(self, job_id, request_id, phase="RECEIVED"):
        self.jobs[job_id] = {"job_id": job_id, "request_id": request_id, "phase": phase}

    def update_scenario_request(self, request_id, **kwargs):
        if request_id in self.requests:
            self.requests[request_id].update(kwargs)
            self.requests[request_id]["updated_at"] = datetime.now(timezone.utc)

    def save_scenario_interpretation(self, request_id, **kwargs):
        if request_id in self.requests:
            self.requests[request_id].update(kwargs)
            self.requests[request_id]["updated_at"] = datetime.now(timezone.utc)


def test_scenario_requests_api_flow(client: TestClient):
    """Test POST 202 Accepted, Idempotency, and GET query flow."""
    # Wire in-memory storage onto fake engine
    storage = InMemoryScenarioStorage()
    client.app.state.ctx.engine.storage = storage

    # 1. Submit request
    body = {
        "prompt": "Test incident: CDU secondary pump pressure dropping rapidly.",
        "facility_id": "lab_01",
        "requested_duration_seconds": 1800,
        "requested_speed": 1,
    }
    idem_key = "test-v9-idem-key-001"
    res = client.post("/api/v1/scenario-requests", json=body, headers={"Idempotency-Key": idem_key})
    
    assert res.status_code == 202
    data = res.json()
    assert "request_id" in data
    assert data["status"] in ("QUEUED", "PROCESSING", "READY")
    assert data["phase"] in ("RECEIVED", "CLASSIFYING", "INTERPRETING", "VALIDATING", "CREATING_RUN", "RUNNING")
    req_id = data["request_id"]

    # 2. Idempotency check: same key returns same request_id
    res_idem = client.post("/api/v1/scenario-requests", json=body, headers={"Idempotency-Key": idem_key})
    assert res_idem.status_code == 202
    assert res_idem.json()["request_id"] == req_id

    # 3. GET status
    res_get = client.get(f"/api/v1/scenario-requests/{req_id}")
    assert res_get.status_code == 200
    get_data = res_get.json()
    assert get_data["request_id"] == req_id
    assert get_data["original_prompt"] == body["prompt"]

    # 4. Cancel endpoint: if already processed/failed, correctly refuses cancel
    res_cancel_finished = client.post(f"/api/v1/scenario-requests/{req_id}/cancel")
    assert res_cancel_finished.status_code == 200
    assert res_cancel_finished.json()["ok"] is False

    # 5. Cancel active request
    storage.create_scenario_request("req_pending_001", "operator", "Pending test")
    res_cancel_pending = client.post("/api/v1/scenario-requests/req_pending_001/cancel")
    assert res_cancel_pending.status_code == 200
    assert res_cancel_pending.json()["ok"] is True
    assert res_cancel_pending.json()["status"] == "CANCELED"

