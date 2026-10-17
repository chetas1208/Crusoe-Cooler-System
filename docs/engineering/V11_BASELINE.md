# LOOPKEEPER V11 Baseline & Provenance Audit

**Date:** 2026-10-17  
**Build Context:** Cerebral Valley × Crusoe Recursive Agents Hackathon ("Done Means Done" / "Shared Brain")  
**Pre-Event Baseline SHA:** `ea30ba5`  

---

## 1. End-to-End Hop Integrity Table

This table documents each stage of the causal chain from human natural-language input to independent physical verification, indicating whether the implementation is real (physics-backed / live provider / persistent DB) or simulated/fallback.

| Hop | System / Module | Subsystem Type | Truth Level | Implementation Details & Proof |
|---|---|---|---|---|
| **1. Prompt** | `apps/web/src/features/execution/` | Global Scenario Composer | **REAL** | Reactive header button (`Simulate an incident`) and Execution composer. Submits `POST /api/v1/scenario-requests` returning HTTP 202 Accepted with durable `request_id`. |
| **2. Triage & Routing** | `backend/src/loopkeeper/ai/laya_classifier.py` | Laya Router SDK | **REAL** | Local `laya` repo (`4ac226d`) loaded on CPU (`_router.predict`). Classifies incident family (`choice`), urgency (`score`), and hazard (`noul`). |
| **3. Intent Interpretation** | `backend/src/loopkeeper/intelligence/crusoe.py` | Crusoe Managed Inference | **REAL** | `AsyncOpenAI` client targeting `https://api.inference.crusoecloud.com/v1`. Discovers `Nemotron-3-Nano-30B-A3B` and `Nemotron-3-Super-120B-A12B`. Emits typed `ScenarioProposalV1`. |
| **4. Scenario Compilation** | `backend/src/loopkeeper/scenarios/compiler.py` | Deterministic Compiler | **REAL** | Resolves colloquial asset locations to canonical topology IDs (`rack_c04`, `p_12`), attaches declared assumptions, bounds solver parameters, and builds 3 Definition of Done (DoD) invariants. |
| **5. Fault Injection** | `backend/src/loopkeeper/physics/plant.py` | Pandapipes + CompOpt | **REAL** | Modifies hydraulic boundary conditions (orifice discharge, valve closures, pump curve derating). Verified solver residuals $\le 10^{-14}$. |
| **6. Sensory Telemetry** | `backend/src/loopkeeper/engine/sensors.py` | Physics Solvers | **REAL** | Real closed-loop pressure, temperature, and mass-flow calculations. Dispatches sensor anomalies to monitor. |
| **7. Agent Delegation** | `backend/src/loopkeeper/agents/` | LangGraph + Supervisors | **REAL** | 5 SENTINEL roles (`SEN-01` Commander, `SEN-02` INPIPE Coord, `SEN-03` OUTRIG Coord, `SEN-04` Safety Arbiter, `SEN-05` Verifier). Emits typed `AgentEnvelope` tasks. |
| **8. Robot Motion** | `backend/src/loopkeeper/nav/` | Traffic & Route Graph | **REAL** | 8 OUTRIG rovers on 4 roads + 10 INPIPE crawlers in service pipes. Waypoint reservation, collision avoidance, and 0 LLM calls in motion loops. |
| **9. Physical Intervention** | `backend/src/loopkeeper/robotics/` | Governed Tools (L0–L3) | **REAL** | Strainer cartridge swap (ΔP recovery from 42 kPa to 8 kPa) and ultrasonic rotary brush deposit removal (line resistance restoration). |
| **10. Independent Verification** | `backend/src/loopkeeper/agents/verifier.py` | Layer-A Physics + SEN-05 | **REAL** | Deterministic check of frozen DoD invariants (flow $\ge 90\%$, temperature $\le 45^\circ\text{C}$ held for duration). Proposer cannot verify itself. |
| **11. Persistence & Checkpoints** | `backend/src/loopkeeper/storage/postgres.py` | Dual Neon PostgreSQL | **REAL** | Control plane (`loopkeeper-control`) + Telemetry lake (`loopkeeper-telemetry`). LangGraph `AsyncPostgresSaver` checkpoint persistence and recovery. |
| **12. Replay & Visualization** | `apps/web/src/features/visualization/` | WebGL Three.js / R3F | **REAL** | Direct browser WebGL2 rendering. Event-backed replay queries historical snapshots without LLM re-invocation. Ghost Preview Drive operates with 0 backend mutation. |

---

## 2. Environment Verification

- **OS / Runtime:** Linux x86_64, Python 3.11, Node v22.22.2, pnpm 9.
- **Crusoe Managed Inference:** Endpoint reachable, catalog verified with 13 models, `CRUSOE_API_KEY` active.
- **Neon Cloud PostgreSQL:** `loopkeeper-control` and `loopkeeper-telemetry` active, dual-DSN pooling, 37 schema tables verified.
- **Frontend / Rendering:** Direct browser WebGL2 via Three.js / React Three Fiber.
- **Cloudflare Tunnel:** `https://your-tunnel.trycloudflare.com` operational.
- **Vercel Production:** `https://your-app.vercel.app` deployed and verified E2E.

---

## 3. Corrections (Agent F, 17 Oct 2026 ~21:30 UTC; checked against the code and the live `:8787`)

1. **Hops 4 -> 9 are two separate runs today.** `POST /api/v1/scenario-requests` ends in `scenarios/episode.py::build_recorded_episode`, which builds a recorded 30:00 episode with `agents=None` and a fixed response script (`_intervention_plan`). The SENTINEL team, the frozen Definition of Done and the replan operate on the live run (`run_live`) fed by `test.inject_fault` or seeded wear. "Prompt -> scenario -> fault -> delegation" is therefore not one executed chain yet. REAL for each hop in isolation; the integration is `[PENDING: lead]`.
2. **Hop 10 path:** `backend/src/loopkeeper/agents/verifier.py` does not exist; the verifier is `orchestration/graphs/verifier.py` (Layer A) with `graphs/dod_nodes.py` (SEN-01 draft/revise, SEN-05 Layer B). At the baseline SHA `ea30ba5` the "frozen DoD invariants" were the compiler's three invariants and the legacy verifier checks; the executable contract (`orchestration/dod.py`) is V11 work.
3. **Hop 7:** the five SEN roles existed as supervisor seats at baseline; role differentiation, the task DAG and the bounds are V11 work (see `docs/engineering/V11_DOD.md`).
4. **Live server state:** at 21:19 UTC `:8787` predated the V11 routes (`GET /runs/run_live/contracts` -> 404) and `GET /models/status` reported `scenario_text.available=false`. Restart before any demo (`scripts/demo/preflight.sh` checks this).
5. **UI test menu:** "Foul P-17" targets `p_17`, which is not in the v6 topology; valid targets include `p_hs_b`, `strainer_02`, `valve_b1`.
