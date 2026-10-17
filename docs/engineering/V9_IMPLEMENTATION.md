# LOOPKEEPER V9 — Natural-Language Crisis Launcher, Live Robot Autonomy, and Non-Destructive Manual Drive

**Release Date:** 17 October 2026  
**Status:** Implemented, Tested, and Verified  
**Governing Objective:** Verified Recursive Autonomy ("Done Means Done")

---

## 1. Executive Summary

LOOPKEEPER V9 introduces an end-to-end natural-language crisis orchestration pipeline, an authoritative 30-minute physics scenario generator, and a non-destructive manual drive preview mode. Operators can type colloquial, ambiguous incident descriptions (e.g., *"Something is wrong with the water near the middle racks, maybe overheating. Handle it."*) from any view. The system triages the intent via Laya Router, parses physical constraints via Crusoe Nemotron, deterministically resolves plant topology, and compiles a complete 30-minute incident episode.

Simultaneously, V9 establishes an uncompromising boundary between **Ghost Preview Drive** (a client-local visual proxy that moves along legal graph corridors with zero network calls and zero simulation impact) and **Live Takeover** (server-authoritative lease acquisition with deadman switch and collision envelopes).

```
                      ┌──────────────────────────────────────────────┐
                      │  Global Scenario Launcher / Ctrl+K Palette   │
                      │  "Water near middle racks overheating..."    │
                      └──────────────────────┬───────────────────────┘
                                             │ HTTP 202 Accepted
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │        FastAPI Scenario Requests API         │
                      │        (PostgreSQL Outbox & Jobs)            │
                      └──────┬───────────────────────────────┬───────┘
                             │                               │
                ┌────────────┴───────────┐       ┌───────────┴──────────┐
                │ Laya Router Classifier │       │ Crusoe Nemotron LLM  │
                │ convaiinnovations/laya │       │ 30B-A3B / Fallback   │
                └────────────┬───────────┘       └───────────┬──────────┘
                             │                               │
                             └───────────────┬───────────────┘
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │    Deterministic ScenarioCompiler            │
                      │    - Topology Localization (Rack C04)        │
                      │    - 3 Definition of Done Invariants         │
                      └──────────────────────┬───────────────────────┘
                                             ▼
                      ┌──────────────────────────────────────────────┐
                      │    Authoritative Physics & Robot Engine      │
                      │    - 30:00 Simulation Horizon (3600 ticks)   │
                      │    - Dual Neon DB Ledger Persistence         │
                      └──────────────────────────────────────────────┘
```

---

## 2. Intelligence Layer: Laya Router & Crusoe Nemotron

### 2.1 Local Laya Typed Router
- **Model Checkpoint:** `convaiinnovations/laya` running locally on CPU.
- **Routing Questions:** Choice, score, and noul triage questions classifying:
  1. `incident_family`: `flow_restriction`, `leak`, `pump_failure`, `overheating`, `power_failure`, `fire_smoke`, `sensor_fault`.
  2. `urgency`: `severe`, `moderate`, `watch`.
  3. `possible_immediate_hazard`: Boolean flag triggering safety holds.
- **Confidence Calibration:** Grounded by a 42-prompt dataset (`backend/tests/fixtures/laya_triage_prompts.jsonl`). Predictions with uncalibrated temperature or low confidence fall back safely to deterministic rules with explicit engine labeling (`engine: "laya_router"` vs `engine: "rule_fallback"`).

### 2.2 Crusoe Managed Inference & Truthful Fallback
- **Catalog Exploration:** `GET https://api.inference.crusoecloud.com/v1/models` successfully verifies model catalog (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`).
- **Truthful Status Reporting:** When Crusoe Cloud returns HTTP 402 ("no valid payment method"), the system **never invents fake model completions**. Instead, it transparently records:
  - `crusoe_model: "deterministic-semantic-parser-v1"`
  - `fallback_active: True`
  - Zero hallucinated tokens; exact structured Pydantic `ScenarioProposalV1` output.

---

## 3. Deterministic Scenario Compiler & Definition of Done

The `ScenarioCompiler` (`backend/src/loopkeeper/scenarios/compiler.py`) acts as the deterministic firewall between unstructured model outputs and physical execution:

1. **Topology Asset Localization:**
   - Translates ambiguous locations (*"middle racks"*, *"back racks"*, *"road 2"*) into exact topology identifiers (`rack_c04`, `rack_e04`, `strainer_02`, `cdu_01`).
2. **Declared Assumptions Compilation:**
   - Explicitly records every assumption made during intent compilation into the persistent run record.
3. **Measurable Definition of Done (DoD) Invariants:**
   Every generated scenario mandates 3 measurable invariants:
   - Target asset coolant mass flow rate $\ge$ nominal threshold for $\ge 120$ seconds.
   - Technology Cooling System (TCS) supply temperature $\le 24.0^\circ\text{C}$.
   - Zero active uncontained high-risk alarms (leak puddles isolated, electrical smoke cleared).

---

## 4. Ghost Preview Drive vs. Live Takeover

| Capability | Ghost Preview Drive (V9) | Live Takeover (Server Authoritative) |
| :--- | :--- | :--- |
| **Activation** | Dedicated button or `P` key | Explicit confirmation modal |
| **Network Traffic** | **0 API calls** (zero `/drive`, zero leases) | `/robots/{id}/control/lease` + 20Hz `/drive` heartbeats |
| **Simulation Pose** | Backend robot position is **100% unchanged** | Authoritative backend physics updates |
| **Visual Mesh** | Holographic cyan/wireframe ghost proxy | Solid textured physical model with headlights |
| **Restoration** | `Esc` instantly restores authoritative view | Server deadman release or operator safe stop |
| **Kinematic Bounds** | Hall boundaries and pipe segment bounds | MuJoCo contact physics & nav mesh colliders |

---

## 5. Dual Neon PostgreSQL Architecture

- **`loopkeeper-control`**: Owns `runs`, `scenario_requests`, `scenario_interpretations`, and `scenario_jobs`. Migration 0006 applied cleanly.
- **`loopkeeper-telemetry`**: Owns high-frequency frame timeseries, robot odometry snapshots, and physical metrics.
