# LOOPKEEPER V9 — Interface Contracts & Workstream Protocol

**Date:** October 17, 2026  
**Status:** Canonical Interface Specification  

---

## 1. REST API Contract: Asynchronous Scenario Requests

### `POST /api/v1/scenario-requests`
Enqueues a natural language or structured scenario request into the durable PostgreSQL outbox. Returns immediately with HTTP 202.

**Headers:**
- `Content-Type: application/json`
- `Idempotency-Key`: Optional client string ensuring single execution.

**Request Body:**
```json
{
  "prompt": "Something is wrong with the water near the middle racks, maybe overheating. Handle it.",
  "facility_id": "lab_01",
  "source_run_id": "run_live",
  "requested_duration_seconds": 1800,
  "requested_speed": 1,
  "auto_start": true,
  "isolated": true
}
```

**Response (HTTP 202 Accepted):**
```json
{
  "request_id": "req_a1b2c3d4e5f6",
  "status": "QUEUED",
  "phase": "RECEIVED",
  "status_url": "/api/v1/scenario-requests/req_a1b2c3d4e5f6",
  "created_at": "2026-10-17T09:00:00Z"
}
```

---

### `GET /api/v1/scenario-requests/{request_id}`
Polls the request lifecycle progress.

**Lifecycle Phases:**
`RECEIVED` → `CLASSIFYING` → `INTERPRETING` → `VALIDATING` → `CREATING_RUN` → `RUNNING` (or `FAILED` / `REJECTED`)

**Response:**
```json
{
  "request_id": "req_a1b2c3d4e5f6",
  "status": "RUNNING",
  "phase": "RUNNING",
  "run_id": "run_v9_overheating_middle_b4f12",
  "original_prompt": "Something is wrong with the water near the middle racks, maybe overheating. Handle it.",
  "interpretation": {
    "laya": {
      "task_family": "thermal_review",
      "urgency": "time_sensitive",
      "confidence": 0.82,
      "insufficient_evidence": false,
      "engine": "laya_router"
    },
    "crusoe": {
      "intent": "simulate",
      "summary": "TCS loop cooling degradation at Row C middle racks with heat surge",
      "candidate_faults": [
        {
          "family": "overheating",
          "severity": "severe",
          "asset_query": "rack_c04",
          "cause_hint": "TCS valve throttling or local flow reduction"
        }
      ],
      "assumptions": [
        "Mapped 'middle racks' to Row C racks (rack_c03..rack_c06)",
        "Assumed technology-cooling system (TCS) side flow impairment"
      ]
    },
    "compiler": {
      "resolved_assets": ["rack_c04", "valve_tcs_c"],
      "fault_injected": "overheating",
      "hazard_zone": null,
      "definition_of_done": [
        "rack_c04 thermal margin restored > 8.0 K for 120s",
        "TCS supply temperature maintained < 24.0 C",
        "0 active high-severity alarms"
      ]
    }
  },
  "error": null,
  "created_at": "2026-10-17T09:00:00Z",
  "updated_at": "2026-10-17T09:00:04Z"
}
```

---

## 2. Pydantic Proposal Schema (`ScenarioProposalV1`)

```python
from typing import Literal
from pydantic import BaseModel, Field

Family = Literal[
    "flow_restriction",
    "pump_failure",
    "leak",
    "overheating",
    "heat_rejection_loss",
    "power_failure",
    "fire_smoke",
    "sensor_fault",
]

class CandidateFault(BaseModel):
    family: Family
    severity: Literal["moderate", "severe", "emergency"]
    asset_query: str | None = None
    cause_hint: str | None = None

class ScenarioProposalV1(BaseModel):
    intent: Literal["simulate", "inspect", "question"]
    summary: str = Field(min_length=1, max_length=240)
    proposed_faults: list[CandidateFault] = Field(min_length=1, max_length=3)
    location_hints: list[str] = Field(default_factory=list, max_length=8)
    assumptions: list[str] = Field(default_factory=list, max_length=8)
    unresolved_references: list[str] = Field(default_factory=list, max_length=8)
    needs_clarification: bool = False
    candidate_goals: list[str] = Field(default_factory=list, max_length=5)
```

---

## 3. Database Schema (`0006_scenario_requests_v9.sql`)

```sql
CREATE TABLE IF NOT EXISTS scenario_requests (
  request_id      text PRIMARY KEY,
  principal_id    text NOT NULL,
  original_text   text NOT NULL,
  status          text NOT NULL CHECK (status IN ('QUEUED', 'PROCESSING', 'READY', 'FAILED', 'REJECTED', 'CANCELED')),
  phase           text NOT NULL,
  idempotency_key text UNIQUE,
  run_id          text REFERENCES simulation_runs(run_id),
  error_code      text,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenario_interpretations (
  request_id          text PRIMARY KEY REFERENCES scenario_requests(request_id),
  laya_result         jsonb,
  laya_engine         text,
  crusoe_proposal     jsonb,
  crusoe_model        text,
  assumptions         jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolved_assets     jsonb NOT NULL DEFAULT '[]'::jsonb,
  definition_of_done  jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_report   jsonb NOT NULL DEFAULT '{}'::jsonb,
  latencies_ms        jsonb NOT NULL DEFAULT '{}'::jsonb,
  tokens_used         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenario_jobs (
  job_id          text PRIMARY KEY,
  request_id      text NOT NULL REFERENCES scenario_requests(request_id),
  phase           text NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  heartbeat_at    timestamptz NOT NULL DEFAULT now(),
  owner_epoch     bigint NOT NULL DEFAULT 0,
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenario_jobs_request_idx ON scenario_jobs(request_id);
```

---

## 4. Frontend Ghost Preview Drive Architecture

1. **State Store (`previewDriveStore.ts`)**:
   - `isActive: boolean`
   - `targetRobotId: string | null`
   - `ghostPose: { x: number, y: number, z: number, heading: number } | null`
   - `entryPose: { x: number, y: number, z: number, heading: number } | null`
   - `routeGraph: NavGraph | null`
   - `enterPreview(robotId)` / `exitPreview()` / `updateGhostPose()`
2. **Visual Ghost Proxy (`GhostRobotOverlay.tsx` in `packages/scene`)**:
   - Distinct holographic cyan wireframe / pulsing mesh overlay.
   - Positioned strictly at `ghostPose`.
   - Never touches authoritative robot meshes in `Robots.tsx`.
3. **Input Handling (`useDriveKeys.ts`)**:
   - Suppresses movement when typing in text fields or modals.
   - Moves ONLY along valid graph edges.
   - Zero API `/drive` calls; zero control leases requested.
4. **Exit Semantics**:
   - Closes preview, removes ghost mesh, and points camera back to live authoritative robot.
   - Authoritative backend robot is NEVER mutated or teleported.
