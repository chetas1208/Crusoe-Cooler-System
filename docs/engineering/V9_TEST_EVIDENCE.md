# LOOPKEEPER V9 — Test Evidence & Verification Record

**Build Date:** 17 October 2026  
**Environment:** Linux x86_64, Node.js v20.18.0, Python 3.11.16  
**Backend:** FastAPI 0.115.0 + Neon PostgreSQL (Dual-Project)  
**Verification Standard:** Done Means Done (Strict No-Mock / No-Fake Rule)

---

## 1. Automated Test Suite Results

### 1.1 Backend Contract Parity & Integration Suite
- **Command:** `pytest backend/tests/integration/test_v9_scenario_requests.py backend/tests/contracts/test_contract_parity.py`
- **Result:** **108 passed in 0.44s**
- **Verified Areas:**
  - Laya Router triage on scenario prompts.
  - Crusoe intent parser with truthful HTTP 402 fallback reporting.
  - Deterministic compiler generating 3 Definition of Done invariants.
  - REST endpoint `POST /api/v1/scenario-requests` returning HTTP 202 Accepted.
  - Idempotency key deduplication.
  - Request query `GET /api/v1/scenario-requests/{id}` and cancellation.

### 1.2 Frontend Core Unit Suite
- **Command:** `pnpm --filter @loopkeeper/core test`
- **Result:** **61 passed (7 test files, 100% pass)**
- **Verified Areas:**
  - Robot routing, navigation, and envelope gaps.
  - Manual control leases, deadman timeouts, and release semantics.
  - Deterministic run recording, seeking, and timeline event folding.
  - Non-destructive checkpoint forking and replay divergence.

### 1.3 Full Monorepo TypeScript Typecheck
- **Command:** `pnpm -r typecheck`
- **Result:** **5 of 5 workspace packages passed cleanly (0 errors)**
  - `packages/core`: `tsc -p tsconfig.json` (1.5s)
  - `apps/mock-api`: `tsc -p tsconfig.json` (1.9s)
  - `packages/scene`: `tsc -p tsconfig.json` (3.3s)
  - `apps/mobile`: `tsc --noEmit` (6.3s)
  - `apps/web`: `tsc -p tsconfig.json` (8.4s)

### 1.4 Production Bundle Compilation
- **Command:** `pnpm --filter @loopkeeper/web build`
- **Result:** **Built in 760ms**
  - Generated production assets:
    - `dist/index.html` (0.53 kB)
    - `dist/assets/index-DBzZrohU.css` (92.71 kB)
    - `dist/assets/engine-CJIYoCBy.js` (136.23 kB)
    - `dist/assets/index-BlTFJ7rJ.js` (2,001.86 kB)

---

## 2. Live End-to-End API Generation Evidence

### 2.1 Natural-Language Prompt Submission (HTTP 202 Accepted)
```bash
curl -X POST http://127.0.0.1:8787/api/v1/scenario-requests \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Something is wrong with the water near the middle racks, maybe overheating. Handle it."}'
```
**Response:**
```json
{
  "request_id": "req_54ea985e34c9",
  "status": "QUEUED",
  "phase": "RECEIVED",
  "status_url": "/api/v1/scenario-requests/req_54ea985e34c9",
  "created_at": "2026-10-17T09:01:37.841673+00:00"
}
```

### 2.2 Phase Progression & Model Latencies
```json
{
  "request_id": "req_54ea985e34c9",
  "status": "READY",
  "phase": "RUNNING",
  "run_id": "run_v8_cr_03_d66a3c87e6",
  "original_prompt": "Something is wrong with the water near the middle racks, maybe overheating. Handle it.",
  "interpretation": {
    "laya": {
      "result": {
        "engine": "laya_router",
        "checkpoint": "convaiinnovations/laya (english)",
        "incident_family": "flow_restriction",
        "urgency": "severe",
        "confidence": 0.715,
        "latency_ms": 4219.07
      }
    },
    "crusoe": {
      "proposal": {
        "summary": "Simulate overheating incident near middle rack suite (Row C)",
        "assumptions": [
          "Mapped 'middle racks' to central Row C (rack_c04)",
          "Assumed technology-cooling mass flow rate drop"
        ]
      },
      "model": "deterministic-semantic-parser-v1"
    },
    "compiler": {
      "resolved_assets": ["cdu_01"],
      "definition_of_done": [
        "Affected asset cdu_01 flow rate maintained >= nominal threshold for 120s",
        "TCS supply temperature maintained <= 24.0 C across technology cooling loop",
        "0 active uncontained high-risk alarms (leak puddle isolated, smoke exclusion maintained)"
      ],
      "validation_report": { "valid": true, "readiness": "READY" }
    },
    "latencies_ms": {
      "laya_ms": 4219.11,
      "crusoe_ms": 213.65,
      "total_pipeline_ms": 4691.44
    }
  }
}
```

### 2.3 Generated Authoritative 30:00 Run
```bash
curl -s http://127.0.0.1:8787/api/v1/runs/run_v8_cr_03_d66a3c87e6
```
```json
{
  "run_id": "run_v8_cr_03_d66a3c87e6",
  "label": "Heat rejection collapse",
  "kind": "scenario",
  "mode": "LIVE",
  "state": "stopped",
  "scenario_id": "CR-03",
  "facility_id": "lab_01",
  "current_tick": 3600.0,
  "current_time_s": 1800.0,
  "recording": {
    "frames": 0.0,
    "checkpoints": 0.0,
    "events": 108.0,
    "commands": 0.0
  }
}
```
*Exact 1800.0 simulated seconds (30:00) horizon with 108 physical events recorded to PostgreSQL.*
