# Upstream Software, Citations & Attributions

This document records the upstream open-source frameworks, physics libraries, provider platforms, and standards utilized by LOOPKEEPER.

---

## 1. Physical Simulation & Network Solvers

### pandapipes & pandapower
- **Role in LOOPKEEPER:** Used for steady-state hydraulic and thermodynamic pipe-flow calculations across primary and secondary loops (chilled facility water, technology cooling system, CDU heat exchange, pipe branches, valves, pumps).
- **License:** 3-Clause BSD License
- **Copyright:** (c) 2016-2026 Fraunhofer Institute for Energy Economics and Energy System Technology (IEE), Kassel, and University of Kassel.
- **Reference:**
  - Lohmeier, D. et al., *pandapipes: An Open-Source Tool for Fluid and Thermal Network Simulation*.
  - Repository: `https://github.com/e2nIEE/pandapipes`

### CompOpt (Computational Optimization & Thermal Models)
- **Role in LOOPKEEPER:** Provides mathematical foundations for numerical optimization, flow routing, coupled boundary-condition solvers, and thermodynamic rack heat dissipations.
- **Attribution:** Adapted deterministic algorithms for rack temperature margin prediction, steady-state hydraulic balance, and valve authority curves.

---

## 2. Agent Frameworks & Orchestration

### LangGraph & LangChain
- **Role in LOOPKEEPER:** Provides the stateful graph execution engine for recursive agents (`SENTINEL`, `INPIPE`, `OUTRIG`). Checkpoints world states, multi-agent messages, hypotheses, and verification gates to Neon Serverless PostgreSQL via `langgraph-checkpoint-postgres`.
- **License:** MIT License
- **Copyright:** (c) 2023-2026 Harrison Chase, LangChain Inc.
- **Repository:** `https://github.com/langchain-ai/langgraph`

---

## 3. Infrastructure & Cloud Providers

### Crusoe Cloud Managed Inference
- **Provider:** Crusoe Energy Systems LLC
- **Role in LOOPKEEPER:** Primary high-throughput inference engine for reasoning, triage, hypothesis formation, tool proposal, and post-repair causal verification.
- **Models Targeted:**
  - `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`
  - `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`
  - Compatible OpenAI-format Chat Completions endpoint: `https://api.inference.crusoecloud.com/v1`
- **Documentation & Reference:** `https://docs.crusoecloud.com/`

### Neon Serverless PostgreSQL
- **Provider:** Neon, Inc.
- **Role in LOOPKEEPER:** System-of-record relational store for simulation runs, incidents, agent reasoning traces, model request logs, robot control leases, telemetry time series, and durable LangGraph checkpoint blobs.
- **Architecture Utilized:**
  - Connection Pooler endpoint (`*-pooler.region.aws.neon.tech`) for high-concurrency stateless REST routes and worker events.
  - Direct endpoint (`*.c-6.us-east-2.aws.neon.tech`) for DDL migrations, long transactions, and `AsyncPostgresSaver` checkpoint persistence.
  - Instant Branching for branch-isolated scenarios and point-in-time recovery testing.
- **Documentation & Reference:** `https://neon.tech/docs`

---

## 4. Frontend & Visualization

### Three.js & React Three Fiber (R3F)
- **Role in LOOPKEEPER:** 3D digital-twin rendering of the data-center cooling facility, server racks, piping manifold, CDU, and autonomous internal crawler robots.
- **License:** MIT License
- **Copyright:** (c) 2010-2026 Three.js Authors; (c) 2019-2026 Poimandres.

---

## 5. Articulated Robot Dynamics & Manipulation

### MuJoCo & MuJoCo Menagerie
- **Role in LOOPKEEPER:** Authoritative multi-joint physics engine for exterior mobile rovers (OUTRIG), articulated arms, contact-grounded grippers, rigid tool payloads (strainer cartridge, fixture), and in-pipe crawler tool interaction.
- **License:** Apache License 2.0
- **Copyright:** (c) 2022-2026 Google LLC & DeepMind Technologies Limited.
- **Repositories & Cloned Upstreams:**
  - `google-deepmind/mujoco`: `c2a39d7e0c430a34dce96c5c4f7a69b907092f90`
  - `google-deepmind/mujoco_menagerie`: `62ab00f2bc44f6f20c1c9b7a13f3fb1dd41a4e35`
  - `shihminyang/MuJoCo-Example-Manipulation`: `e56fc610ba86eab07ea591f20903ac1d872345ce`

---

## 6. Incident Classification & Routing

### Laya
- **Role in LOOPKEEPER:** Low-latency incident triage and task routing classifier (Router `predict()` across `choice`, `score`, `noul`). Advisory task routing without safety authority over physical actuators.
- **License:** Apache License 2.0
- **Copyright:** (c) 2026 Convai Innovations / Nandha Kishor M.
- **Repository:** `https://github.com/NandhaKishorM/laya` (`4ac226d5ee88ed6df8db288a05c766d7a34ee682`)
- **Checkpoints:** `https://huggingface.co/convaiinnovations/laya`
- **Scientific Caveat:** Evaluated under benchmark with uncertainty-gating and abstention per arXiv:2610.02267.
