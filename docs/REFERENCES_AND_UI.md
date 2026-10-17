# Reference repositories and how the UI is built

Two questions answered in one place: **which repositories were cloned for this project and what we took from them**, and **how the user interface is put together**.

---

## Part 1 — Repositories cloned for this project

All clones live in the untracked `.references/` directory (three of them, `laya/`, `mujoco/` and `mujoco_menagerie/`, were also cloned at the repo root and are gitignored). Nothing is vendored into the source tree: each is either installed as a pinned dependency or only read for reference. SHAs are the revisions that were checked out on 16–17 October 2026.

### Used at runtime (installed as dependencies behind adapters)

| Repository | Revision | License | What we took from it |
|---|---|---|---|
| [HewlettPackard/compopt](https://github.com/HewlettPackard/compopt) | `4d9bfdc` | MIT (per its `pyproject.toml`; the clone ships no separate LICENSE file) | Lumped chip, server-rack and coolant-loop thermal models. We import its public physics classes (`compopt.physics.chip`, `fluids`) directly in `backend/.../physics/adapters/thermal_compopt.py`; its Gymnasium environments are **not** used because they own the clock. Pinned by commit in `backend/pyproject.toml` |
| [e2nIEE/pandapipes](https://github.com/e2nIEE/pandapipes) | `c565633` | BSD-3-Clause | Quasi-steady pipe-network hydraulics. The facility's pipe graph is built into a pandapipes net (`physics/adapters/hydraulics_pandapipes.py`) and re-solved when valves, faults or topology change. Installed from PyPI |
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | `e77a5cb` | MIT | Durable agent graphs (SENTINEL, INPIPE, OUTRIG, verifier), interrupts for human approval, and the Postgres checkpointer (`langgraph-checkpoint-postgres`) |
| [google-deepmind/mujoco](https://github.com/google-deepmind/mujoco) | `c2a39d7` | Apache-2.0 | Articulated-arm / gripper contact physics for the exterior robot's strainer-exchange workcell (`backend/.../robotics/mujoco_runtime.py`, `mujoco>=3.16`) |
| [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) | `4ac226d` (v0.4.8) | Apache-2.0 (checkpoint license not independently verified) | Typed incident triage (`choice` / `score` / `noul`). Advisory only; it never authorises an action. Optional extra: `uv sync --extra laya` |
| [crusoecloud/crusoe-developer-hub](https://github.com/crusoecloud/crusoe-developer-hub) | `7e13ad2` | MIT | Reference for the OpenAI-compatible Crusoe Managed Inference endpoint and the hackathon example; we reuse the *client pattern*, not the application stack (`backend/.../intelligence/crusoe.py`, `inference/`) |

### Read for reference only (not imported)

| Repository | Revision | License | What we took from it |
|---|---|---|---|
| [google-deepmind/mujoco_menagerie](https://github.com/google-deepmind/mujoco_menagerie) | `62ab00f` | per-asset licenses | Candidate manipulator rigs (TidyBot, Stretch, UR5e, Panda, Robotiq). **No Menagerie asset is used**; the workcell is a small hand-authored MJCF model |
| [shihminyang/MuJoCo-Example-Manipulation](https://github.com/shihminyang/MuJoCo-Example-Manipulation) | `e56fc61` | see repo | Grasp and operational-space examples consulted when designing contact-based grasp validation |
| [Walla17x/thermaloop](https://github.com/Walla17x/thermaloop) | `3a5ffe9` | MIT | Fallback / sanity reference for a RC thermal path, epsilon-NTU CDU and pump affinity laws. Not needed in the end because the CompOpt adapter worked |

### Cited in the design but never cloned

These shaped the architecture or the UI language; they were read as documentation, not checked out:

- **ASHRAE** liquid-cooling system configurations and *Water-Cooled Servers* white paper, **OCP** Coolant Distribution Unit project, **NVIDIA DGX GB200** manifold documentation, **LBNL** open liquid-cooled rack specification — the supply → rack manifold → return → CDU secondary / separate facility-water loop layout.
- **USEPA/WNTR**, **RWTH-EBC/HPC-digital-twin**, **Temporal samples**, ROS/Gazebo pipe-inspection robot projects — considered and deliberately **not** adopted (reasons in `DECISIONS.md`): one hydraulic solver is enough, heavy Julia/Modelica stacks cost more than they save, and ROS is not browser-compatible.
- **Three.js**, **React Three Fiber**, **drei**, **zustand**, **React Flow (`@xyflow/react`)**, **motion**, **lucide-react**, **Geist** fonts — installed from npm (see Part 2).

Full license and notice text: [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and [`engineering/upstreams.md`](engineering/upstreams.md).

---

## Part 2 — How the UI is built

### Stack

| Layer | Choice |
|---|---|
| App | React 19 + TypeScript, built with Vite (single-page app, static output) |
| 3D | `three` 0.186 + `@react-three/fiber` 9 + `@react-three/drei` 10 — **one** persistent canvas shared by every tab |
| State | `zustand` stores (world, camera/view, UI, preview-drive, communications, DOD) |
| Agent graph | `@xyflow/react` (React Flow), 2D only |
| Chrome | Hand-written CSS with design tokens (`apps/web/src/styles/tokens.css`), Geist / Geist Mono variable fonts, `lucide-react` icons, `motion` for transitions |
| Monorepo | pnpm workspaces: `packages/core` (contracts, stores, clients, dev simulator), `packages/scene` (the 3D scene), `apps/web`, `apps/mobile`, `apps/mock-api` |

### The four tabs share one world

`apps/web/src/tabs/TabHost.tsx` mounts exactly one tab's overlays (`Dashboard`, `Map`, `Agents`, `Execution`) on top of the **same** `Viewport` and the **same** scene. Switching tabs changes the scene's *view mode* (overview, robot cockpit, dimmed backdrop behind the agent graph, replay projection) and which panels are mounted; it never rebuilds the facility. There is no fifth tab: robots, incidents, scenarios, communications, the Definition of Done and the scorecard are panels, drawers and chips inside the four.

```
App
 ├─ Viewport  (lazy)  ── <Canvas> ── Scene
 │                         ├─ Facility / Rooms / HallDetail     (shell, floors, containment, supports)
 │                         ├─ Racks / Branches / Pipes / PipeFlow (instanced; fed by /topology)
 │                         ├─ Robots / Trail / GhostRobotOverlay  (pooled rigs, interpolated poses)
 │                         └─ CameraRig                           (store-driven goal → eased camera)
 └─ Shell
     ├─ TopBar (tabs, health, connection)      ├─ AuthGate (only on a 401)
     └─ TabHost → DashboardTab | MapTab | AgentsTab | ExecutionTab
                    └─ panels: Communications · DOD · Team · Scorecard · Inspector · Fleet · Presets …
```

### Data flow: the browser only renders server state

1. **Topology once, state continuously.** `GET /topology` gives static geometry, ids, passability and limits (cached by hash); `GET /world` gives a snapshot; then a WebSocket delivers ordered events (`world.diff`, `robot.pose`, `incident.*`, `agent.*`, `comm.*`, `dod.contract`, …) resumable by `since_seq`, with a gap triggering a snapshot refetch (`packages/core/src/client/live.ts`).
2. **The scene is data-driven.** Rows, roads, racks, pipes, docks and rooms are generated from the topology (`packages/scene/src/siteModel.ts`), never hard-coded, so the same scene renders the old 4-rack demo, the 16-rack hall and the 5×8 hall. Old runs replay on the topology version recorded with them.
3. **Poses are interpolated, never invented.** The server streams robot poses at about 2–10 Hz; the renderer runs at display refresh by interpolating a short, fixed delay behind the stream (`packages/core/src/store/poses.ts`). It never extrapolates, so a stalled stream makes a robot stop instead of drifting.
4. **No per-frame React renders.** Transforms are written to refs and instanced matrices inside `useFrame`; stores are read with selectors; pose updates do not set React state.
5. **Operator input is intent, not authority.** Keyboard, gamepad and touch controls send rate-limited, sequence-numbered, short-TTL drive intents under an exclusive server lease; blur, hidden-tab, disconnect or lease loss stops the robot on the server. *Preview Drive* moves only a local ghost and is labelled as non-authoritative.
6. **Replay is read-only.** Execution reconstructs a separate world projection from checkpoints plus recorded events; it never mixes with the live store and never calls a model.

### Rendering approach

- **Instancing.** All rack cabinets, branch drops, valves and rack meters are `InstancedMesh` sets (`Racks.tsx`, `Branches.tsx`); static equipment is merged by `Batch.tsx`; pipe geometry is cached per topology hash (`geomCache.ts`, `tube.ts`). Robots use pooled geometry and materials (`robotKit.ts`).
- **One real camera.** The cockpit, chase, orbit and tactical views reuse the single canvas camera, which follows backend poses; the camera rig applies a safe-area offset so the focus never hides behind a panel.
- **Fitted framing.** `fit.ts` computes the free viewport area from `data-inset` panels and frames the whole hall (about 75–85% of the central region at 1440×900 and 4K).
- **Quality presets** (`Auto / High / Balanced / Performance`, a native-4K option) change only render scale, shadows and effects; they never change the simulation or the robot count.
- **Optional progressive tiles** (`?tiles=1`, `features/tiles`) fetch immutable hashed LOD tiles from the manifest endpoints with abort, hysteresis and LRU disposal; the procedural LOD0 scene is always the fallback.
- Measured so far: draw calls dropped from 469 to about 248 on the old 3-robot Dashboard (the main cause was two `transmission` glass windows forcing a second render pass), and about 183–238 with 16 robots. These are headless numbers on a server GPU, **not** a 120/200 FPS claim.

### Visual language

- Dark graphite theme (`--bg #090b0f`), translucent panels, small readable type (≥ 12 px, tabular numerals, mono for ids).
- **Colour has jobs:** supervisors purple (`--sentinel`), INPIPE cyan, OUTRIG orange; severity nominal / watch / warning / critical; the loops are fixed — TCS supply cyan, TCS return amber, facility water navy/slate, red reserved for faults. Severity is always colour **and** text.
- Contextual overlays only: one pinned incident card, labels for the selected asset and top incident, no permanent KPI wall. Every panel has a visible hide/reopen affordance and closing one never stops the simulation or event ingestion.

### Responsive and degraded modes

- **A shell that works without 3D.** `features/visualization/ViewerHost.tsx` lazy-loads the whole 3D viewer behind a Suspense boundary and an error boundary; the four tabs, run picker, incidents, scenario launcher, playback controls and communications work if WebGL is missing or fails. Viewer modes: automatic, local lite 3D, and a 2D tactical fallback drawn from the topology and live poses.
- **Phones.** `features/responsive` provides a mobile tab bar and bottom sheets (closed / peek / expanded, tap-operable) that host Communications, the Definition-of-Done, Team and Scorecard panels; the first load on a 390 px viewport dropped from 681 KB to 381 KB after splitting the 3D bundle. `100dvh` shell, safe-area insets, 44 px touch targets, no root horizontal overflow from 320 px (emulation only; no physical device testing yet).

### The panels that carry the "agents prove it" story

| Panel | Source of truth | Rule |
|---|---|---|
| **Communications** (`features/communications`) | `comm.*` events in the agent-envelope format, persisted in Postgres | Faithful projection of what was actually emitted; filters by sender, recipient, robot, incident, type, period; virtualised list; click jumps to the tick and camera; no invented dialogue, no hidden reasoning |
| **Definition of Done** (`features/dod`) | `/incidents/{id}/contract`, `/verifications`, `dod.contract` stream event | Frozen checks with measured value, threshold, hold timer and PASS / FAIL / UNKNOWN; "Done" appears only on a server `VERIFIED`; an unmeasured check can never show PASS |
| **Team** | `/incidents/{id}/team` | The five SENTINEL seats, INPIPE/OUTRIG child tasks, budget used, depth, loop and drift warnings |
| **Scorecard** (`features/scorecard`) | `GET /eval/scorecard` | Shows denominators, confidence intervals and caveats verbatim; "recursive: NOT RUN" is shown as such |
| **Prompt strip** (`features/mission`) | `/scenario-requests` phases | received → classified → interpreted → scenario_validated → running, with real latencies and the API's own failure text |

### Where to look in the code

```
apps/web/src/tabs/*          one folder per tab
apps/web/src/features/*      communications, dod, mission, responsive, scorecard, tiles, visualization
apps/web/src/ui/*            shell, top bar, docks, inspector, presets, palette, shared kit
apps/web/src/styles/*        tokens + component CSS (mobile.css holds the phone layers)
packages/scene/src/*         the 3D scene (siteModel, Racks, Pipes, Robots, CameraRig, fit …)
packages/core/src/store/*    world, poses, feed, preview-drive stores
packages/core/src/client/*   REST + WebSocket transport, auth, stream interest
packages/core/src/control/*  lease / drive / release client
```
