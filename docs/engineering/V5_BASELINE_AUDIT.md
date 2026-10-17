# LOOPKEEPER V5 — Baseline Truth Audit (Gate G0)

**Date:** 2026-10-16  
**Auditor:** Autonomous Systems Engineer  
**Status:** Baseline Established  

---

## 1. Environment & Hardware Facts

- **Operating System:** Linux `srva` 6.8.0-142-generic #142-Ubuntu SMP PREEMPT_DYNAMIC x86_64
- **Host CPU:** Intel(R) Core(TM) i9-10900X CPU @ 3.70GHz (20 logical cores, NUMA node 0)
- **Host Memory:** 125 GiB RAM (107 GiB available, 8.0 GiB swap)
- **Server GPUs:** 
  - GPU 0: NVIDIA GeForce RTX 3090, 24,576 MiB VRAM, PCI Bus `0000:1A:00.0`, Driver 535.288.01, CUDA 12.2
  - GPU 1: NVIDIA GeForce RTX 3090, 24,576 MiB VRAM, PCI Bus `0000:68:00.0`, Driver 535.288.01, CUDA 12.2
- **Python Runtime:** Python 3.13 / `uv` project backend
- **Node Runtime:** Node.js v20+ / `pnpm`
- **Network / Remote Access:** 
  - Cloudflare Tunnel: `https://your-tunnel.trycloudflare.com`
  - Local API: `http://127.0.0.1:8787`
  - Frontend: `http://127.0.0.1:5173` (with `/api` proxy) and served statically from FastAPI `/`
  - WebGL Context: WebGL2 verified with ACESFilmicToneMapping, InstancedMesh support.

---

## 2. Feature Baseline Matrix (Implemented / Partial / Absent / Unverified)

| Feature / Subsystem | Status | Description / Evidence |
|---|---|---|
| **Cooling Hydraulics (pandapipes)** | `implemented` | Steady-state two-loop solver (FWS + TCS, CDU heat exchange, pump curves, valve resistance). |
| **Thermal Dynamics (CompOpt adapter)** | `implemented` | Deterministic lumped-RC thermal model for racks, sensible heat dissipation, CDU margin. |
| **16 Robot World State** | `implemented` | 10 in-pipe crawlers (`IR-01..10`), 6 external rovers (`OR-01..06`), 5 virtual supervisors (`SEN-01..05`). |
| **Real 3D Pose Tracking** | `implemented` | Per-robot XYZ coordinates, quaternions, pipe branch bounds, patrol navigation. |
| **Crusoe Managed Inference** | `implemented` | AsyncOpenAI client configured for Crusoe Managed Inference (`nvidia/Nemotron-3-Nano-30B-A3B`). |
| **Neon PostgreSQL Persistence** | `implemented` | Runs, events, checkpoints, replay pages stored in Neon with pooling/direct split. |
| **Four Locked Tabs UI** | `implemented` | Dashboard, Map, Agents, Execution intact; single-viewport no-scrolling design. |
| **Exclusive Control Lease Protocol** | `implemented` | Server-enforced lease token with TTL, deadman safety stop, accepted/rejected logs. |
| **MuJoCo Articulated Dynamics** | `partial` | `mujoco==3.16.0` installed in backend; need articulated arm/gripper Python worker. |
| **Contact-Grounded Grasp/Drop** | `partial` | Basic grasp logic exists; needs multi-body contact constraint in MuJoCo worker. |
| **Interactive Joint Jogging (Map)** | `partial` | Map tab has base driving; joint jogging (1..7, Q/E) needs direct binding to MuJoCo worker. |
| **Physical Strainer Cartridge Service** | `partial` | Hydraulic resistance mutation exists; needs physical pick/carry/place sequence with tolerance verifier. |
| **In-pipe Deposit Clearing** | `partial` | Mechanical deposit model and brush action needs crawler arm coupling. |
| **Laya Incident Classifier** | `partial` | Reference cloned (`4ac226d5`); needs in-domain benchmark, uncertainty gating, and abstention logic. |
| **Native 4K drawing buffer mode** | `partial` | Canvas DPR scaling supported; needs dedicated 3840×2160 native diagnostic probe and FPS meter. |

---

## 3. Upstream Clones in `.references/` (Untracked)

- `google-deepmind/mujoco` @ `c2a39d7e0c430a34dce96c5c4f7a69b907092f90` (Apache-2.0)
- `google-deepmind/mujoco_menagerie` @ `62ab00f2bc44f6f20c1c9b7a13f3fb1dd41a4e35` (Curated models)
- `shihminyang/MuJoCo-Example-Manipulation` @ `e56fc610ba86eab07ea591f20903ac1d872345ce` (Apache-2.0)
- `NandhaKishorM/laya` @ `4ac226d5ee88ed6df8db288a05c766d7a34ee682` (Apache-2.0)
- `crusoecloud/crusoe-developer-hub` @ `7e13ad280dad30988f2d4ca5c366cae27f1f8311` (Apache-2.0)
- `HewlettPackard/compopt` @ `4d9bfdc10d9c4bc42f99339a1913de3f64abe1ed`
- `e2nIEE/pandapipes` @ `c565633648989cc24f8f9d8d4ec87fa8c32b778f` (BSD-3-Clause)
- `langchain-ai/langgraph` @ `e77a5cb08c1f3ff306d997dd76fc7169afdab5ea` (MIT)

---

## 4. Next Gate Lock

Proceeding to **Gate G1 (Real Articulated Mechanics with MuJoCo)**:
Build `backend/src/loopkeeper/robotics/mujoco_runtime.py` with an articulated mobile manipulator model (mobile base, 6-DOF arm, 2-finger parallel gripper, and rigid spare strainer cartridge payload). Verify physically grounded `grasp -> lift -> carry -> drop` contact dynamics.


---

## 5. Truth check (2026-10-16, Agent A) - what the V5 claims actually were, and what is verified now

| Claim in the original audit/log | Finding | Action |
|---|---|---|
| MuJoCo drives joints / gripper / object contact | `mj_step` really ran, but the arm angles were eased in Python and fed as targets; the end-effector pose used an analytic FK that was **29 cm off** MuJoCo's own link position; `held` came from a distance gate plus a **weld constraint**; `grip_force_N` was a constant 45.0; `contact_list` and `contact_verified: true` were constants; the placement test **teleported** the cartridge onto the fixture; the grippers self-collided (so the pads never moved). | Rewritten: pad centre and IK come from MuJoCo kinematics; pads are two real bodies with a **friction grasp (no weld)**, elliptic friction cone; `held` and `grip_force_N` come from `mj_contactForce`; release is a real drop (gravity measured from the trajectory, -9.81 m/s2); placement is judged where the cartridge physically comes to rest in a rail cradle (negative control included); base motion is a prescribed velocity so the payload feels accelerations. `OR-01`'s facility pose is no longer overwritten by the work-cell base pose. |
| Laya Router verified; 93.3% acc / 20% abstain / 2.34 ms | `Router()` constructs lazily without loading weights, and the string "(Laya Router verified)" was appended whenever it constructed; every number came from a keyword fallback tuned on the same 15 cases. The real router **does** run here from the cached checkpoint (`convaiinnovations/laya@7b928d8`, CPU, about 0.5 s per call, first call 5 s). | Every decision now carries `engine` (`laya_router`/`rule_fallback`) and `advisory: true`; the label is removed; the router is called off the event loop; `/intelligence/laya/*` reports numbers from the evaluation artifact, never constants. |
| laya_eval.json (held-out) | The 15 cases were the rules' design set, not held out. | New 30-case set (5/class), written before any Laya result was seen, nothing tuned after. Results (both engines, confusion matrices in the artifact): Laya router 40.0% accuracy overall, 70.0% on the 10 non-abstained cases, abstention 66.7%, p50 about 0.52 s, p95 about 0.6 s; rule fallback 46.7%, abstention 50%. The old 90% / 10% / 10 ms gates are removed (they cannot be met honestly); the test checks consistency and chance-level only. |
| Strainer repair recovers the plant | The old test injected a non-existent command (`apply_fault`, rejected) and then "verified" nothing (`recovery_verified: true` hard-coded). Brush test used `.get("ok", True)` so a rejected command passed. | Faults are injected with the real `inject_fault`; asserted: strainer dP 189.5 kPa -> 13.5 kPa after `replace_strainer`; p_01 dP 27.7 -> 3.6 kPa after `brush_clear`. In-pipe deposit clearing remains a simple rate model (labelled in the artifact), not MuJoCo contact physics. |
| `./laya`, `./mujoco`, `./mujoco_menagerie` at repo root | Only `./laya` was imported by path (`laya.pth` in the venv + a `sys.path` hack). | Moved to `.references/laya` (same commit 4ac226d); `laya.pth` and the classifier's path now point there; `pyproject.toml` has a `laya` extra (`laya==0.4.8`) documenting the PyPI route. The classifier works without it (labelled fallback). |
| HACKATHON_BUILD_LOG "pre-event" | The 16-robot fleet, 60 x 42 m facility and `IR-/OR-/SEN-` ids are V4 work from this session; "96 rack units" were 16 solver racks + 80 drawn context cabinets. | Corrected in `HACKATHON_BUILD_LOG.md`. |
| Acceptance tests | `test_v4_acceptance.py` partly asserted constants/echoed config (see below); `test_v5_acceptance.py` GRASP/REPAIR/LAYA tests were rewritten as above. | See section 6. |

Not verified: MuJoCo state is a local work cell (origin near x=12, y=2) with its own frame; it is **not** coupled to the facility-frame poses of the OR robots. Server GPUs are not used by any of this (CPU MuJoCo, CPU Laya).
