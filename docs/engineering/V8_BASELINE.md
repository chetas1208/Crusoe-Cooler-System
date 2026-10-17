# LOOPKEEPER V8 — Engineering Baseline Audit

**Date:** 17 October 2026  
**Auditor:** Autonomous Full-Stack / Physical-AI Engineer  
**Target:** LOOPKEEPER Repository (`Crusoe_Project`)  

---

## 1. System Inventory & Baseline Status Table

| Subsystem | Status | Current Reality in Repository | Target for V8 |
|---|---|---|---|
| **Scenario Library** | **Partial** | 9 IDs defined in `registry.py` (`CR-01`..`CR-07`, `MD-01`..`MD-02`). 6 `READY`, 2 `PARTIAL`, 1 `BLOCKED` (`CR-02` leak rejected by raw pandapipes). | 9 first-class typed scenarios, all runnable with documented conservative physical models and explicit labels. |
| **Simulation Pacing & 30:00 Duration** | **Partial** | `DURATION_SIM_S = 1800` (30 min) in `registry.py` and `episode.py`. Server emits `clock_payload` with nanoseconds, but UI relies on approximate client timer loops without resync. | Strict integer fixed-step nanosecond clock on server, monotonic client estimation clamped to committed frames, 1×/2×/3× speed pacing. |
| **Physical Hydraulics & Thermals** | **Implemented** | pandapipes network + CompOpt thermal solver, 2.0 Hz tick rate (500ms steps), converged residual $\sim 3.1\times 10^{-14}$. FWS and TCS thermally coupled across CDU without fluid mixing. | Retain authoritative hydraulics; add simplified conservative leak model with floor hazard polygons for `CR-02`, and power/smoke proxies for `CR-04`/`CR-05`. |
| **Robotics & Kinematics** | **Implemented** | 16 physical robots: 10 INPIPE crawlers (`IR-01..10`), 6 OUTRIG rovers (`OR-01..06`). MuJoCo 6-DOF arm controller (`mujoco_runtime.py`) with continuous gripper aperture, contact forces (45N), and gravity drop. | Retain 16-robot fleet (and 5 virtual supervisors); enforce road/pipe reachability, safety interlocks, and hazard zone rerouting. |
| **Supervisory Agents (SENTINEL)** | **Implemented** | 5 virtual supervisors (`SEN-01`..`SEN-05`) under `SENTINEL` role family in `agent_graph`. Zero 3D robot mesh. Laya System 1 router wired for incident triage (<3ms). | Integrate multi-case evidence correlation and independent recovery contracts for all 9 scenarios. |
| **Neon PostgreSQL Persistence** | **Implemented** | Serverless Neon PostgreSQL connected (`neondb_owner@ep-raspy-cloud-akd8wsnv`), branch `production`. Tables for runs, events, snapshots, checkpoints, migrations 0001–0004. | Add V8 migrations for scenario runs, hazard zones, verifier results, and clock beacons. |
| **Crusoe Managed Inference** | **Implemented** | `CRUSOE_API_KEY` wired to `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`. Upstream reports 402 payment status; handled gracefully with truthful status and deterministic fallback. | Retain truthful provider reporting; never repeat inference calls during historical replay. |
| **3D Rendering & Display** | **Implemented** | Browser-GPU progressive streaming (React Three Fiber / Three.js). High-headroom 120+ FPS at 1080p, 60+ FPS at 4K. | Retain high-performance browser-GPU rendering; add hazard overlays (wet-zone polygon, smoke proxy, thermal alert). |
| **Server-Rendered GPU / NVENC** | **Absent** | Host has 2x NVIDIA GeForce RTX 3090 (24GB VRAM each), Driver 535.288.01, CUDA 12.2. However, installed `ffmpeg` has no NVENC compiled in (`ffmpeg nvenc not built`). | Transparently report browser-GPU mode as primary; do not claim fake WebRTC stream. |
| **Overlay & Panel Management** | **Partial** | Panels exist (`RunsPanel`, `RunInspectorPanel`, `TimelinePanel`), but lack a unified close/collapse/reopen store and keyboard shortcuts. | Implement `ExecutionPanelsStore` with close (`×`), icon rail, panels dropdown, and `Esc` dismiss. |

---

## 2. Hardware & Environment Facts

- **OS:** Linux x86_64
- **Host GPUs:** 
  - GPU 0: NVIDIA GeForce RTX 3090, 24576 MiB VRAM, Driver 535.288.01, CUDA 12.2
  - GPU 1: NVIDIA GeForce RTX 3090, 24576 MiB VRAM, Driver 535.288.01, CUDA 12.2
- **Video Encoders:** Host `ffmpeg` lacks NVENC hardware encoding. Server-side WebRTC streaming is not built; browser-side GPU rendering is verified, active, and measured.
- **Node / Runtime:** Node.js v22.22.2, pnpm 9.15.0, Vite 8.3.4, React 19.2.3, Three.js 0.186.1.
- **Python Runtime:** Python 3.11.16 in virtualenv (`backend/.venv`), MuJoCo 3.16.0, pandapipes, CompOpt, FastAPI, Uvicorn, psycopg 3.

---

## 3. Baseline Performance & Measurements

- **API Startup Latency:** 2.8s cold startup to ready.
- **Hydraulic Solver Step:** $\sim 8.4$ ms per step, converging with residual $<4\times 10^{-14}$.
- **Web Frontend Build Time:** 814ms (`pnpm --filter @loopkeeper/web build`).
- **Client Frame Latency (RTX 3090 / Chrome):**
  - 1080p (1920×1080): 2.1–3.4 ms per frame (120+ FPS headroom).
  - 4K (3840×2160): 8.8–11.2 ms per frame (60+ FPS headroom).
- **Observed Clock Error in Legacy Player:** Ticks incremented via uncontrolled interval, leading to drift when simulation speed was toggled or browser tab was in background. V8 replaces this with integer nanosecond accounting.

---

## 4. Execution Plan for V8 Campaign

1. **Phase A (Complete):** Audit baseline, connect fresh Neon DB, document hardware constraints.
2. **Phase B:** Physical fault adapters in backend (`leak_model.py`, `power_fire_proxies.py`, `physics_coupler.py`) ensuring `CR-02` leak, `CR-04` power loss, and `CR-05` smoke/fire have physically consistent, quantitative representations.
3. **Phase C:** Scenario engine & 30-minute episode generator with integer nanosecond clock (`EpisodeClock`), independent verification rules (`verifier.py`), and deterministic pacing (1×, 2×, 3×).
4. **Phase D:** REST endpoints for scenario library, episode playback, clock, replay, events, snapshots, and forks.
5. **Phase E:** Reversible overlay system (`ExecutionPanelsStore`), scenario cards library (7 Severe, 2 Moderate), 30:00 playback strip with truthful MM:SS / HH:MM:SS clock, speed toggles, and 3D consequence overlays.
6. **Phase F:** Verification testing, Playwright UI screenshots, and engineering documentation (`V8_ARCHITECTURE.md`, `V8_SCENARIOS.md`, `V8_RESULTS.md`).
