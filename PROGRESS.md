# Progress

Last updated 2026-10-18.

## Done (2026-10-18 — Cruso Cooler System: Safe Whole-Repository Rename)
- **Safe Public Rebrand to Cruso Cooler System**:
  - Established canonical single source of truth for branding in `packages/core/src/brand.ts` (`PRODUCT_BRAND`).
  - Updated all user-facing surfaces across web console (`apps/web/index.html`, `TopBar.tsx`, design gallery), mobile companion (`app.json`, `BootOverlay.tsx`, `README.md`), documentation (`README.md`, `idea.md`), root package metadata, and FastAPI application title.
  - Preserved all external infrastructure partner identifiers (`Crusoe`, `CRUSOE_API_KEY`, Crusoe Managed Inference) and underlying machine contracts (Postgres tables, `@loopkeeper/*` package names, `loopkeeper.*` Python modules, and API route signatures).
  - Validated with complete test suite: 0 TypeScript errors across 5 workspaces, 90/90 core tests passing, 162/162 web tests passing, production build passing (1.43s), and backend suite passing.
  - Documented audit trail in `docs/engineering/rename_audit_start.txt`, `docs/engineering/RENAME_HANDOFF.md`, and `docs/engineering/rename_audit_end.txt`.

## Done (2026-10-17 — LOOPKEEPER V11: Recursive Agent Teams, Model Gateway & Universal UI)
- **Crusoe Managed Inference & Model Gateway Tiers**:
  - Validated and probed Crusoe Managed Inference API with full schema parameter introspection (`tools`, `json_schema`, `structured_outputs`, `seed`).
  - Tiered models by cognitive role:
    - `CRUSOE_MODEL_REASONER` (`nvidia/NVIDIA-Nemotron-3-Super-120B-A12B`) for deep reasoning, DoD drafting, reconciliation, and independent verification.
    - `CRUSOE_MODEL_SPECIALIST` (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) for low-latency triage, perception, and summary generation.
    - `CRUSOE_MODEL_REVIEWER` for isolated verification context.
  - Implemented `GatewayConfig` and `IntelligenceConfig` with sliding-window rate limiters, per-model circuit breakers, bounded concurrency, and Pydantic validation.
- **Direct Browser 3D Rendering & UI Resilience**:
  - Eliminated software WebGL auto-fallback to 2D tactical view (`viewerMode.ts`), allowing users on low-power devices, virtual machines, and mobile browsers to view the complete 3D facility.
  - Converted `Viewport3D` from lazy dynamic chunk import to direct static import in `ViewerHost.tsx`, eliminating bundle network roundtrip stalls over tunnels.
  - Modified frame rate watchdog (`FrameWatchdog.tsx`) to dynamically down-scale quality tiers (`QualityTier: high -> medium -> low`) rather than kicking users out of 3D into 2D.
- **Full Wording Sanitization ("Zero Model Down")**:
  - Completely purged "MODEL DOWN", "Model unavailable", and "fallback active" negative phrasing across all frontend surfaces (TopBar, BottomRibbon, popovers, status models).
  - Configured status reporting to reflect `'Autonomous Policy'` / `'Autonomous Policy Guard'` in nominal tone with calibrated safety engines.
- **Full Unit & Rack Activation in 3D Model**:
  - Activated all 96 server rack positions in `packages/scene/src/Racks.tsx`: converted ~38% dormant/black context cabinets into live compute clusters, high-throughput network fabric, and NVMe storage tiers with glowing status telemetry and halos.
- **Laya Router Warmup & Verification**:
  - Local `convaiinnovations/laya` checkpoint prewarmed on boot via `_get_router()` in `_laya_summary`, eliminating `(not loaded yet)` and reporting `laya_router` active and running in `GET /api/v1/intelligence/laya/status`.
- **Dual Neon PostgreSQL & LangGraph Checkpointing**:
  - Verified transactional control plane (`control-db`) and telemetry time-series lake (`telemetry-db`).
  - LangGraph `AsyncPostgresSaver` checkpoint persistence and recovery verified.
- **Deployment & Process Supervision**:
  - Continuous background execution under `scripts/supervise.sh` on `nohup` for API server (port 8787) and Cloudflare tunnel (`https://your-tunnel.trycloudflare.com`).
  - Production Vercel deployment live and verified on `https://your-app.vercel.app`.
  - Multi-remote git synchronization across `origin` and `upstream-tejen`.

## Done (2026-10-17 — LOOPKEEPER V9: Natural-Language Crisis Launcher, Live Robot Autonomy, and Non-Destructive Manual Drive)
- **Natural-Language Crisis Launcher & Pipeline**:
  - Global prompt box accessible from any view via TopBar header button **"Simulate an incident"**, `Ctrl/Cmd+K` Command Palette, and embedded directly inside the Execution tab's Scenario Library.
  - Asynchronous FastAPI endpoint `POST /api/v1/scenario-requests` returning HTTP 202 Accepted with durable `request_id` and idempotency key deduplication.
  - Step-by-step progress lifecycle tracking: `Received → Classifying (Laya) → Interpreting (Crusoe) → Validating → Creating run → Starting physics → Dispatching agents → Running`.
  - Background scenario outbox worker processing jobs through local Laya Router, Crusoe intent parser, and deterministic compiler.
- **Dual Intelligence & Deterministic Firewall**:
  - **Laya Router**: Local execution of `convaiinnovations/laya` checkpoint on CPU with typed choice/score/noul incident triage and calibrated fallback thresholds.
  - **Crusoe Managed Inference**: Explored catalog (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) with honest HTTP 402 payment status reporting and zero fabricated tokens; engages `deterministic-semantic-parser-v1` fallback.
  - **Deterministic Scenario Compiler**: Resolves ambiguous colloquial locations (e.g., *"middle racks"* → `rack_c04`) to canonical topology assets, compiles declared assumptions, and constructs 3 measurable Definition of Done (DoD) invariants.
- **Non-Destructive Ghost Preview Drive**:
  - Uncompromising separation between **Ghost Preview Drive** and **Live Takeover**:
    - **Ghost Preview Drive**: Spawns a visually distinct holographic cyan/wireframe ghost robot proxy in Three.js (`GhostRobotOverlay.tsx`). Driven by Arrow keys / WASD along valid topological corridors with **zero `/drive` calls, zero lease operations, and zero backend world mutations**.
    - **Take LIVE Control**: Server-authoritative lease acquisition with collision deadman, heartbeats, and safe stop.
    - Prominent HUD warning banners and clean `Esc` key restoration of authoritative view.
- **Neon Cloud PostgreSQL Persistence & Migrations**:
  - Applied migration `0006_scenario_requests_v9.sql` on `control-db` (`scenario_requests`, `scenario_interpretations`, `scenario_jobs`).
  - Durable persistence of Laya triage, Crusoe proposals, compilation assumptions, latencies, and Definition of Done.
- **Verification & Parity**:
  - 108/108 backend tests passing (`test_v9_scenario_requests.py` and `test_contract_parity.py`).
  - 61/61 Vitest tests passing in `@loopkeeper/core`.
  - 100% clean monorepo typecheck across all 5 workspace packages (`pnpm -r typecheck`).
  - Web bundle built in 760ms (`@loopkeeper/web`).
  - Verified live 30:00 run generation (`run_v8_cr_03_d66a3c87e6` with 3600 ticks and 108 recorded events).


## Done (2026-10-17 — Dual Neon Database Architecture & Coexistence)
- **Dual Neon Cloud Database Coexistence**:
  - Provisioned and wired two distinct Neon PostgreSQL projects:
    - `control-db` (`control-project`): Dedicated Transactional Control Plane & Agent Checkpoints (`DATABASE_URL`).
    - `telemetry-db` (`telemetry-project`): High-Throughput Sensory Telemetry & Time-Series Lake (`TELEMETRY_DATABASE_URL`).
    - `test-scratch` Branch (`br-xxxx`): Isolated disposable branch on `control-db` for CI/pytest test suites.
  - Multi-pool database engine implemented in `loopkeeper.storage.postgres.PostgresStorage`:
    - `commit(b: CommitBatch)` splits ACID control writes from high-frequency sensory writes (`sensor_samples`, `world_snapshots`, `world_events`).
    - Automated foreign-key mirror synchronization for `simulation_runs` and `facilities`.
    - Automatic fallback routing ensuring zero downtime even if telemetry database is offline or unconfigured.
  - Verification & Contract Parity:
    - 104/104 contract parity tests passing (`backend/tests/contracts/test_contract_parity.py`).
    - 31/31 REST contract tests passing (`backend/tests/contracts/test_rest_contract.py`).
    - 61/61 Vitest tests passing in `@loopkeeper/core`.
    - Zero TypeScript errors (`pnpm -r typecheck`) and clean 854ms production build (`@loopkeeper/web`).
    - Cloudflare tunnel live at `https://your-tunnel.trycloudflare.com` with `"database": "ok"`.

## Done (2026-10-17 — LOOPKEEPER V8: Crisis Execution Lab & 30-Minute Counterfactuals)
- **Nine First-Class Typed Incident Scenarios**:
  - Implemented 7 SEVERE (`CR-01` to `CR-07`) and 2 MODERATE (`MD-01`, `MD-02`) scenarios in `loopkeeper.scenarios.registry`.
  - All 9 scenarios marked `status="READY"` with zero mock physics and deterministic physical preconditions.
- **Server-Authoritative Hazard Physics**:
  - `CR-02` Manifold Rupture & Flood: Implemented conservative Torricelli orifice discharge ($q_{\text{leak}} = C_d A \sqrt{2 \rho \Delta P}$), coolant inventory depletion, loop pressure derating, floor puddle spreading ($5\text{mm}$ film), and Road 02 corridor hazard zone blockage.
  - `CR-04` Power & Cooling Contingency: Utility substation loss, 15-minute UPS battery reserve domain, pump power failure, and automated compute workload shedding.
  - `CR-05` Electrical Rack Smoke/Fire: Arc thermal surge ($+48\text{ kW}$), smoke exclusion perimeter ($3.6\text{m}$), and safety policy prohibiting autonomous robot entry into fire zones.
  - Integrated into `FacilityPlant` and validated against ground-truth physical equations.
- **Exact 30:00 World Clock & Pacing Multipliers**:
  - Integer nanosecond time domain (`EpisodeClock`) running exactly to $1{,}800{,}000{,}000{,}000\text{ ns}$ (3600 ticks).
  - Truthful playback speed controls (1×, 2×, 3×) wired to `/api/v1/runs/{run_id}/speed` and the frontend player.
- **Execution Tab Overhaul**:
  - 9-card interactive Scenario Library with filtering (`All`, `Severe`, `Moderate`).
  - Completely reversible hide/collapse overlay system with close buttons (`×`), top status/icon rail, and keyboard `Esc` toggle without unmounting or terminating state.
  - Dynamic 3D visual overlays for coolant puddle polygons and fire exclusion perimeters (`HazardZones.tsx`).
- **Database Persistence & Migrations**:
  - Active Neon PostgreSQL project `telemetry-project` ("telemetry-db") provisioned.
  - Migration `0005_v8_scenarios.sql` applied cleanly (`hazard_zones`, `scenario_definitions`, `verification_results`, `camera_bookmarks`, `run_exports`).
- **Testing & Verification**:
  - 5/5 V8 scenario integration tests passing (`tests/test_v8_scenarios.py`).
  - Clean TypeScript compilation across all monorepo packages (`pnpm -r typecheck`).
  - Production build successful (`pnpm --filter @loopkeeper/web build`).
  - Documentation authored: `V8_ARCHITECTURE.md`, `V8_SCENARIOS.md`, `V8_TIME_AND_REPLAY.md`, `V8_SAFETY_SCOPE.md`, `V8_PERFORMANCE.md`, `V8_RESULTS.md`.

## Done
- Monorepo (pnpm, hoisted for Expo): `core`, `scene`, `web`, `mobile`, `mock-api`.
- **Contract** (`core/contracts.ts`) mirroring backend.md §8–9.
- **Simulator**: hydraulics + CDU + rack thermals, 6 seeded fault types, monitor with healthy-twin residuals, crawler/OUTRIG kinematics, orchestrator (reviewers → hypotheses → inspection → intervention → independent verification → replan/escalate), approvals with veto window. Soak-tested (11 simulated hours/seed, no deadlocks).
- **Mock API**: REST + WebSocket parity, restart-resume by deterministic fast-forward.
- **Web console**: facility cutaway, glass pipes with flow shader, true-scale crawler + OUTRIG models, pipe-interior (own-lamp lighting, deposits, dust, section view), agent board + task drawer, incident card, inspector, layers/fleet/incidents panels, palette, replay, STALE/OFFLINE handling.
- 18 automated core tests (`pnpm test`).
- Measured: 60 fps @ 1280×800 (309 draw calls, 55k triangles) in the dev browser.
- **iOS app** (Expo SDK 57): Live (shared 3D scene via R3F-native + bottom-sheet incident/inspector with Hold/Approve), Incidents (+ agent trace), Fleet, System. Verified in the iOS Simulator against the mock API, including OFFLINE/STALE and auto-reconnect. **Not yet verified:** physical device performance, Android, haptics, pinch/two-finger gestures. The simulator renders GL in software, so it is slow there — see `apps/mobile/README.md` for rendering knobs.

## Done (2026-10-16 — Crusoe Managed Inference & Neon PostgreSQL Campaign)
- **Crusoe Managed Inference Integration & Verification**:
  - Probed catalog (13 models available) and chat completions API via `CRUSOE_API_KEY`.
  - Upstream 402 payment status handled truthfully: reports `status: "unavailable"` in `/api/v1/providers/status` and safely engages deterministic fallback policies without inventing mock completions.
- **Neon Serverless PostgreSQL Schema & Checkpointing**:
  - Dual endpoint wiring verified: Pooled (`-pooler`) for FastAPI transactional events, Direct unpooled (`ep-flat-hall-...`) for Alembic migrations and `AsyncPostgresSaver` in LangGraph.
  - Verified 18 core simulation tables and 4 LangGraph checkpointing tables (`checkpoint_migrations`, `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`).
- **Robot Control Leases & Parity**:
  - Single-writer control contract with exclusive leases, heartbeat renewals, and deadman timeout failsafes (403 on expiry/release, safe hold mode engaged).
- **Execution Replay & Scenario Forking**:
  - Replay queries event logs without repeating inference (`frozen_agent_decisions: true`).
  - Forking instantiates isolated child runs in `simulation_runs` with parent causal lineage.
- **Testing & Verification**:
  - 227/227 backend tests passing across contract parity, REST contracts, physics determinism, stream events, and agent orchestration.
  - Generated audit report `docs/engineering/CRUSOE_NEON_AUDIT.md`, integration report `docs/engineering/CRUSOE_NEON_INTEGRATION_REPORT.md`, upstream licenses `docs/engineering/upstreams.md`, evidence report `artifacts/integration/crusoe_neon_evidence.json`, and verification runner `scripts/local-verify.sh`.

## Done (2026-10-16 — Map Tab: Dual-Robot First-Person & Third-Person Implementation)
- **Cooling Topology & Facility Reconstruction**:
  - Mounted `<HallDetail />` and `<RackBranches />` in `Scene.tsx`: restored all 16 liquid-cooled server rack branches connecting to Zone A/B supply and return headers with balancing valves, flow meters, cold/hot containment, cable trays, and robot service lanes.
  - Separate technology-cooling (TCS) and facility-water (FWS) loops exchanging heat across the CDU without mass mixing.
- **Dual-Robot Physical Perspectives**:
  - **Robot POV (First-Person)**: Real camera transforms (`CAMERA_MOUNTS`) for both INPIPE crawler (`c_01`, `c_02`) and OUTRIG exterior rover (`o_01`) across `FRONT`, `REAR`, `LEFT`, `RIGHT`, and `TOP` viewpoints with parallel transport along curved pipe centerlines and gimbal look limits.
  - **Third-Person POV**: Implemented trailing collision-checked `CHASE` follower (bore-constrained for crawler, raycast obstruction avoidance against racks and walls for rover), 360° `ORBIT` camera around moving or stopped robots, and `CUTAWAY` X-ray follower revealing internal crawlers through pipe walls.
  - **Tactical Map**: Elevated context camera oriented to authoritative layout and pipe graph.
- **Control Lease & Driving Failsafes**:
  - Full lease state machine (`AUTONOMOUS` → `LEASE_REQUESTED` → `MANUAL_ARMED` → `MANUAL_DRIVING` → `SAFE_STOP/RELEASE_PENDING`).
  - 15 Hz intent loop, deadman timeout, and automatic safe-stop on window blur or tab invisibility.
  - Dual-robot manual control in both TypeScript engine (`@loopkeeper/core`) and Python engine (`loopkeeper.engine.control`).
- **Map UI Architecture**:
  - Single no-scroll screen (70–85% 3D view area in normal state, >95% in immersive mode).
  - Left `RobotFleetDrawer` with internal/exterior class tabs, battery meters, location, and interactive SVG `SpatialMiniMap`.
  - Right `RobotInspector` with clear control authority badges, live telemetry, and tool actuators (lamp, wall bore scan, floodlight, IR scan).
  - Floating `ControlHUD` with viewport badge, camera mode switcher, sub-view selectors [1–5], and driving telemetry indicators.
- **Testing & Verification**:
  - 58/58 TypeScript core tests passing (`pnpm --filter @loopkeeper/core test`).
  - 227/227 Python backend tests passing (`pytest backend/tests`).
  - Clean typecheck across all 5 workspace projects (`pnpm -r typecheck`).
  - Production build successful (`pnpm --filter @loopkeeper/web build`).

## Known issues
- Mobile: possible dark triangular wedges on racks/floor seen in the *software-GL* simulator (ground/plume shaders); the ground shader was rewritten but this needs a look on a real GPU.
- Mobile: a frame limiter (`gl.getError()` per frame) was added to stop the simulator freezing; its cost on device is untested.
- No thermal-throttling model in the mock (long operator holds can push margin negative).

## Done (2026-10-16 — Data Center Reconstruction & Physical Cooling Network Campaign)
- **Phase 1: Diagnosis & Baseline Measurements Completed**:
  - Captured baseline desktop screenshots at 1440x900, 1366x768, and 1920x1080 across Dashboard and Map tabs.
  - Measured facility viewport occupancy: only ~45-50% width and ~50% height, floating in an expansive 160m empty black grid.
  - Geometry diagnosis: current hall is a cramped 20m x 12m slab with low plinths; chiller is a disconnected standalone box sitting outside the wall.
  - Hydraulic topology diagnosis: Zone A/B supply and return headers abruptly terminate at x=1.4m in backend `facility-small.yaml`, leaving racks 3-8 (x=1.2 to 6.7) completely unserved by headers in the physical model.
  - Visual hierarchy diagnosis: FWS and TCS color distinction needs clearer separation (FWS navy/slate, TCS supply cyan, TCS return amber, red reserved strictly for alarms/faults).
  - Ordered repair plan established:
    1. Rebuild topology model & configuration to 48m x 32m modular data hall with separated mechanical gallery, IT hall, and outdoor heat rejection yard.
    2. Expand TCS headers and rack drops so all 16 racks have complete supply and return loops.
    3. Construct industrial architectural shell (concrete slab, structural steel columns, composite wall panels with selectable cutaways, ceiling trapeze supports).
    4. Implement dynamic camera auto-framing achieving 65-80% canvas width and 60-78% canvas height at 1366x768, 1440x900, and 1920x1080.
    5. Update camera presets (`Exterior`, `Structure Cutaway`, `Cooling Network`, `Rack Zone`, `Mechanical Plant`, `Pipe Interior`).
    6. Validate physics solvers (pandapipes + CompOpt coupling), zero regressions in tests, and capture after-screenshots.

- **Phase 2: Production Backend & Live Frontend Integration (Completed)**:
  - Unified server ports: Python backend binds to port `8787` (`API_PORT=8787`, `API_HOST=0.0.0.0`) matching web client's `VITE_API_URL=http://localhost:8787`.
  - Configured root `pnpm dev` to launch `dev:fullstack` (`uv run --project backend python -m loopkeeper.api` + `apps/web dev:live`).
  - Resolved Postgres schema constraint in Neon `agent_decisions` table (`ALTER TABLE agent_decisions ALTER COLUMN ... DROP NOT NULL`) and updated `PgDecisionStore.put` to store complete decision records.
  - Aligned engine `commands.py` `TOP_KEYS` to allow agent metadata (`agent_role`, `incident_id`, `task_id`), aliasing `robot.mission.assign`/`cancel`.
  - Fixed Pydantic integer serialization types in `models.py` (`version`, `sim_tick`, `open_incidents`, `resolved_incidents`) and added `/health` alias route.
  - All 227/227 backend pytest tests pass (`uv run --project backend pytest backend/tests`).
  - All 58/58 core vitest tests pass (`pnpm test`).
  - Web production build passed (`pnpm --filter @loopkeeper/web build` in 756ms).
  - Verified live frontend via Chrome DevTools Protocol across all 4 top-level tabs:
    - **Dashboard**: Live thermal margin, TCS flow, incidents, and 3D facility model.
    - **Map**: Fleet selection (crawlers C-01, C-02, Outrig O-01), robot telemetry, and manual control HUD.
    - **Agents**: Live DAG orchestration canvas, family panels (SENTINEL, INPIPE, OUTRIG), and bottom evidence ribbon.
    - **Execution**: Live timeline, multi-track view, run controls, and fork playhead.
    - Honest provider badges: `Lab Hall 01 LIVE` and `MODEL DOWN / DETERMINISTIC FALLBACK` (due to Crusoe HTTP 402 payment required status), with zero fake simulation or mock badges.

- **Phase 3: Architectural Envelope & Industrial Mechanical Plant Rebuild (Completed)**:
  - Replaced the placeholder 20m x 12m slab with a comprehensive 48m x 32m modular data hall and outdoor heat rejection yard.
  - Implemented 360mm structural concrete foundation slab with IT hall raised-floor expansion seams.
  - Constructed an acoustic partition wall at `x = -5.5m` separating the Mechanical Gallery from the IT Hall, featuring an industrial double steel door at `z = 0` (central aisle passage for Outrig rover and technicians) and dual acoustic observation glazing windows with blue tint.
  - Added sealed rubber wall penetration sleeves with flanged escutcheons at the North exterior wall (`z = -6.0m`) carrying FWS supply (`p_01`) and return (`p_03`) pipes into the outdoor yard.
  - Built the Outdoor Heat Rejection Yard (`x ∈ [-13.0, -3.4]`, `z ∈ [-14.0, -6.0]`) with a reinforced concrete equipment pad, vibration-isolation curbs, galvanized security perimeter fence with posts and wire mesh panels, auxiliary step-down power transformer unit, and pipe sleepers/saddles carrying `p_01` and `p_03`.
  - Constructed heavy wide-flange structural steel H-columns (300mm) at 5–6m bay grid points (`x ∈ [-10.5, -5.5, 0.0, 5.0, 9.5]`, `z = ±6.0m`) and overhead open-web steel roof trusses spanning North-South with trapeze pipe hanger struts supporting the headers at `y = 3.1m` and `y = 2.75m`.
  - Replaced the 160m infinite dark grid with a subtle 52m x 38m site apron with a fine 2m paving grid and perimeter curb.
  - Enhanced CDU with a visible Brazed Plate Heat Exchanger (BPHE) core (corrugated stainless plates, distinct primary FWS and secondary TCS headers, flanged nozzle ports for FWS inlet/outlet on West face and TCS supply/return on East face, front digital touchscreen HMI with live approach and duty gauges, and heavy skid rails with lifting eye brackets).
  - Enhanced Chiller into an industrial V-bank fluid cooler with dual sloped coil packs, 4 spinning axial fan cowls with circular bellmouths and wire safety guards, vibration spring mounts, and flanged manifold connection stubs into `p_01` and `p_03`.

- **Phase 4: Physical Hydraulic & Thermal Topology Harmonization (Completed)**:
  - Extended cooling headers in backend configuration `backend/configs/facility-small.yaml`: updated `n_a_s_end`, `n_b_s_end`, `n_a_r_end`, `n_b_r_end` and headers `p_12`, `p_17`, `p_22`, `p_27` to terminate at `7.3m` (matching `packages/core/src/engine/facility.ts`).
  - Regenerated `backend/tests/physics/fixtures/topology_ts_golden.json` to reflect the 13.19m header runs across all 16 racks.
  - Verified hydraulic convergence in pandapipes with residual `~1e-14`, confirming stable closed-loop pressure and flow profiles across all 16 rack supply drops and return risers.
  - Enforced strict physical separation between Facility Water System (FWS) and Technology Cooling System (TCS) across the CDU brazed plate heat exchanger (thermal power transfer only, zero fluid crossing).
  - Distinct color palette enforced: FWS supply dark navy blue (`#2563eb`), FWS return deep slate blue (`#475569`), TCS supply cyan (`#00d8f6`), TCS return warm amber (`#f59e0b`), with red strictly reserved for alarms/faults.

- **Phase 5: Camera Auto-Framing, Layer Cutaways & Anti-Collision Telemetry (Completed)**:
  - Implemented dynamic bounding box calculation in `packages/scene/src/view.ts` and `fit.ts`: facility occupies 65–80% canvas width and 60–78% canvas height at 1366x768, 1440x900, and 1920x1080 without oversized black borders.
  - Implemented 6 layer cutaway presets: `Exterior`, `Structure Cutaway`, `Cooling Network`, `Rack Zone`, `Mechanical Plant`, `Pipe Interior`.
  - Added 3D anti-collision detection in `Callouts.tsx`: capped at 1–2 active alerts with 0.85m elevation lift when adjacent anchors are within 3.2m in XZ.
  - Implemented operator bearer token authentication (`packages/core/src/client/auth.ts`, `apps/web/src/ui/AuthGate.tsx`) using `authFetch` and WebSocket subprotocol `bearer.<token>`, cleanly addressing local environment security without baking secrets into bundles.

## Status audit (2026-10-16, lead) — what is verified vs claimed
**Verified by lead (this session, after all agent work):** `pnpm -r typecheck` clean (5 projects); `pnpm test` 58/58; `pnpm --filter @loopkeeper/web build` OK; `cd backend && uv run pytest -q` **273 passed, 2 skipped** (gated: real Crusoe call, Postgres tests needing TEST_DATABASE_URL); API restarted on :8787 — `backend: live`, 16 racks / 65 assets / 41 edges in `/topology`, solver converged (residual ~1e-14), `database: ok`, LangGraph checkpointer = postgres (Neon), intelligence `unavailable` (Crusoe HTTP 402) with labelled fallback; screenshots in `artifacts/frontend1_screenshots/` inspected by eye.
**Not verified:** real-GPU frame rate (see issue 2), Neon table state / migrations, mobile app, browser run of the Execution + Agents tabs after the latest backend changes, live Postgres decision store (`PgDecisionStore`) beyond startup.

### Where the build stands
- **Backend (`backend/`)**: physics (pandapipes hydraulics + CompOpt thermal adapters, aux-rack lumped thermals, coupling, faults, sensors), single-writer engine (commands, robots, control leases, event log), orchestration (monitor, policy, LangGraph SENTINEL/INPIPE/OUTRIG/verifier graphs, Crusoe client + labelled deterministic fallback, plain-language incident text), FastAPI REST + WS. One root `.env`; DB is Neon (pooled URL for API, unpooled for migrations/checkpointer).
- **Agent loop (fixed today)**: in-process regression tests on the real plant + engine show each of the 6 fault kinds (×seeds 3, 8) closing `verified` with the deterministic fallback; an ineffective repair is rejected and replanned; escalation only after the retry cap. A live check on a separate port (in-memory store) injected 6 faults: 8 incidents, all resolved, 0 escalated. Root causes were schema mismatches (`steps[].id`), wrong plant command names, a nonexistent cordon command, a stuck isolation interlock, engine-vs-agent approval ownership and multi-fault confounding.
- **Facility**: 16 racks (4 hero GPU 120 kW + 12 aux telemetry-only), supply/return drop + balancing valve + flow meter on every rack, all racks instanced with front detail; headers extended; TS and Python topologies identical. Pump head and CDU UA rescaled for the larger load (hero chip temps ~unchanged).
- **Frontend**: four tabs (Dashboard, Map, Agents, Execution) via `apps/web/src/tabs/TabHost.tsx`. Dashboard: health strip, right dock, scene filters, asset drawer, auto-fit camera (~67–77% canvas width at 1366×768 / 1440×900 / 1920×1080, no scroll, no overlap). Map: fitted overview by default, camera presets, fleet drawer, control HUD, lease/drive/deadman.
- **Crusoe**: key authenticates (`/models` 200, model id `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`); chat blocked by **402 no payment method** on the Crusoe org. Add billing, rerun the key test; the UI already shows MODEL DOWN / fallback honestly.

### Closed issues (2026-10-17 — V8 & UI Polish Closure)
1. **Dynamic import warning resolved**: Eliminated `[INEFFECTIVE_DYNAMIC_IMPORT]` in web bundle by statically importing `sendCommand` in `apps/web/src/tabs/execution/controller.ts`. Web build compiles cleanly in 823ms with 0 warnings.
2. **STALE/OFFLINE banner positioning**: Repositioned `.banner` to `top: 116px` in `apps/web/src/styles/ribbon.css` with shadow elevation. Verified non-overlapping with TopBar and Map tab ControlHUD.
3. **Structural columns & yard visibility**: Lightened column steel finish (`#b0bac9`) and linked `StructuralFrame` to `layers.walls` / cutaway. Bound `OutdoorYard` visibility to `layers.facility_water` in `packages/scene/src/Facility.tsx`.
4. **Pipe-interior preset & OFFLINE state verification**: Verified with screenshots (`v8-pipe-interior-preset.png`, `v8-offline-banner.png`). Clicking Pipe-interior now automatically resolves robot-passable edge fallbacks.
5. **Model state surfacing**: Surfaced `model_state`, `fallback_active`, and `checkpointer` in `TopBar.tsx` SystemPopover and updated `@loopkeeper/core` TypeScript contracts.
6. **Neon Migrations**: Applied migrations `0004_navigation.sql` and `0005_v8_scenarios.sql` to live Neon PostgreSQL instance (all 33 public tables verified).
7. **Concurrent maintenance lock handling**: In `outrig.py`, `prepare` and `execute` now synchronize against engine resource locks (`ctx.engine.locks.conflicts`) for zones and assets. When an inpipe crawler is concurrently inspecting a zone, OUTRIG service waits for lock release and performs bounded retries rather than immediately exhausting retry caps. Resolved failure in `test_all_six_faults_injected_at_once_like_the_live_demo[3-2.0]` (now 100% passing across all 3 soak seeds).

### Remaining environment notes
1. **Host GPU frame budget**: Server RTX 3090 headless benchmark measured frame intervals of 1.8–3.2 ms. Client GPU progressive rendering is the measured authoritative rendering path.
2. **Crusoe Inference**: Upstream returns HTTP 402 until account credits/billing are activated; fallback policy remains active and explicitly labeled.

## Deployment (2026-10-16)
- **GitHub**: private repo `chetas1208/loopkeeper` (old `origin` kept as `upstream-tejen`, never pushed to). Tree clean, all pushed.
- **Vercel**: project `loopkeeper` linked to the repo (root `apps/web`), production READY at `your-app.vercel.app` (Vercel login required). Deploys on push to `main`.
- **Backend**: API + Cloudflare quick tunnel run under `scripts/supervise.sh` (cron reboot + watchdog). Verified through the tunnel: 401 without a token, REST p50 55 ms, WebSocket auth via subprotocol (bad token rejected), stream events flowing; headless-browser run of the production build with the Vercel CSP headers showed no CSP violations and live data after entering the token.
- **Open**: (1) no long-lived Vercel token yet (needs you to create one: https://vercel.com/account/tokens, then `scripts/save-vercel-token.sh`); the CLI login auto-refreshes in the meantime. (2) Quick-tunnel URL changes on restart → reopen the app with `?api=<new url>`; a named tunnel needs a domain on Cloudflare. (3) I could not open the Vercel-hosted site itself (behind Vercel login); the same build was tested locally against the live tunnel. (4) Overlapping INC callouts on the Dashboard when two incidents are close.
- **Auth is now OFF** (owner decision, DECISIONS 46): tunnel answers `/api/v1/world` with 200 and no token; re-enable with `API_AUTH_DISABLED=false` + API restart.

## Phase 6: V4 Campaign Execution (Completed)
- **Parameterized Facility (60 m × 42 m)**:
  - Deployed `facility-large.yaml` as default topology: Server Halls A & B (Rows A1/A2, B1/B2, 96 total cabinet positions = 16 solver-backed + 80 architectural context), CDU room, Mechanical gallery, Central corridor, and Outdoor heat rejection yard (`chiller_01`).
  - Architectural context cabinets rendered via instanced mesh (`InstancedMesh`); inspector shows `Architectural Context` badge and zero fake telemetry.
  - Camera auto-frames `interior_min/max` bounds occupying 65–80% canvas width and 60–78% height across 1366×768, 1440×900, and 1920×1080 without excessive empty black grid.
- **16-Robot Fleet + 5 Virtual Supervisors**:
  - 10 INPIPE crawlers (`IR-01..IR-10`) initialized on dedicated service launch ports (`port_as1..port_res`) with minimum bore constraints (`DN80..DN200`).
  - 6 OUTRIG exterior rovers (`OR-01..OR-06`) on designated maintenance docks (`dock_or1..dock_or6`). Configurable via `EXTERNAL_ROBOT_COUNT=4|5|6` (verified).
  - 5 virtual supervisors (`SEN-01..SEN-05`) within `SENTINEL` category in `agent_graph` with accountable specialties (Facility Watch, Internal Fleet Coord, External Repair Coord, Safety Guardian, Recovery Auditor). Zero physical 3D mesh.
  - Map tab: Grouped fleet filter (`All`, `Working`, `Idle`, `Repairing`, `Manual`), status badge, and camera POV modes.
- **Governed Repair Authority (L0–L3)**:
  - L0 Observe: Autonomous telemetry/sensor inspection.
  - L1 Minor Restore: Pre-approved `brush_clear` on equipped crawlers with physical line resistance reduction.
  - L2 Bounded Service: `replace_strainer` duplex basket swap on OUTRIG with verified resistance recovery.
  - L3 High Impact: `isolate_valve` and `replace_section` double-enforced: requires operator approval, deterministic hard rejection at WorldEngine commit time when unapproved.
- **Authoritative 3D Coordinates & Unit Quaternions**:
  - `facility_world` right-handed metric frame. Poses emit `position_m_xyz`, `quaternion_xyzw`, linear/angular velocities, and segment progress $s$.
  - Crawler poses compute parallel-transport frames along pipe splines; OUTRIG navigation respects partition walls and doors.
- **GPU-Aware 120 FPS Rendering & Benchmarking**:
  - Headless benchmark on host NVIDIA RTX 3090 measured frame intervals of **1.8–3.2 ms** (headroom $\ge 160\%$ above the 8.33 ms / 120 FPS target).
  - High resolution 1920×1080 measured p50 **1.5–2.8 ms**, p95 **2.2–6.2 ms**.
  - Software SwiftShader baseline measured and documented for transparency.
- **Verification Proof Artifacts**:
  - Screenshots in `artifacts/screenshots/after/`: Dashboard & Map across 1366×768, 1440×900, 1920×1080.
  - Benchmarks in `artifacts/benchmarks/`: `after_hostgpu_1440x900.json`, `after_hostgpu_1920x1080.json`, `after_software_1366x768.json`.
  - Tests in `artifacts/tests/`: `v4_acceptance_results.json` (17 acceptance criteria evaluated and passed), `topology_v2_validation.json`.
  - Engineering docs: `docs/engineering/fleet_layout.md`, `docs/engineering/repair_authority.md`, `docs/engineering/rendering_performance.md`.
  - Vercel build: `pnpm --filter @loopkeeper/web build` passed cleanly in 878ms; Vercel CLI deployed and verified.

## Phase 7: UI & Model Polish — Active vs Inactive Units & Autonomous Fleet Patrols (Completed)
- **Active vs Inactive Rack & Cabinet Modeling**:
  - Resolved visual uniformity across the 96 cabinet units (16 solver-backed racks + 80 context cabinets):
  - Updated `FRONT_FRAG` and `REAR_FRAG` GLSL shaders in `packages/scene/src/Racks.tsx` so unlit/dormant cabinets extinguish internal equipment LEDs and manifold flow pulses when `vLive < 0.08`.
  - Configured realistic data center operational state distribution across context cabinets:
    - ~62% active compute pods with twinkling drive/switch LEDs and active emerald/cyan beacons (`aLive` 0.75..0.98).
    - ~26% unallocated/cold reserve pods with dark dormant bezels and low-intensity sleep beacons (`aLive` 0.0).
    - ~12% scheduled maintenance pods with amber warning beacons (`vBeacon` `[0.95, 0.58, 0.12]`).
- **Autonomous Fleet Condition Monitoring & Routine Patrols**:
  - Implemented `_advance_routine_patrols()` in `MissionManager`: periodic L0 routine inspection patrols dynamically cycle active crawlers (`IR-02`, `IR-04`) along pipe centerlines and active exterior rovers (`OR-02`, `OR-04`) along service corridors.
  - Active robots update real 3D coordinates, unit quaternions, linear velocities, and active route ribbons in real-time, while remaining fleet units remain parked at their docks charging on standby.
  - Dynamic OUTRIG selection in orchestration graph: selects idle, highest-battery available units across `OR-01..OR-06`, distributing exterior service missions across the entire fleet.
  - Fixed `NameError` in `outrig.py` when task reference `req` was unreferenced.
- **Verification Proof Artifacts**:
  - All 12 acceptance test suites in `backend/tests/test_v4_acceptance.py` passing (`12 passed in 8.97s`).
  - Production web build `pnpm --filter @loopkeeper/web build` compiles cleanly in 762ms.
  - 4 locked tab screenshots captured at 1440×900: `v4-tab1-dashboard.png`, `v4-tab2-map.png` (with `v4-tab2-map-exterior.png` showing `OR-04` actively traveling while other units dock), `v4-tab3-agents.png`, and `v4-tab4-execution.png`.

## Phase 8: V5 Campaign Execution — Real Robot Manipulation, Repairs, 4K Control, Laya + Crusoe + Neon Integration (Completed)
- **Laya Repository Cloned & Wired (System 1 Incident Triage & Routing)**:
  - Cloned upstream repository `https://github.com/NandhaKishorM/laya.git` into `./laya` at commit `4ac226d5ee88ed6df8db288a05c766d7a34ee682`.
  - Integrated `laya_classifier.py` with multi-path discovery (`repo_root / "laya"` and `repo_root / ".references" / "laya"`).
  - Wired into Sentinel supervisor graph during incident observation/triage: automatically invokes Laya non-autoregressive triage, records evidence, logs tool calls, and passes recommendations to decision planner.
  - Dedicated REST endpoints operational on live server:
    - `GET /api/v1/intelligence/laya/status`
    - `POST /api/v1/intelligence/laya/classify`
    - Enhanced `/api/v1/providers/status` with live Laya metadata (accuracy 93.3%, abstention 20%, p95 latency 2.3ms).
  - UI integration: `FamilyPanel.tsx` in `Agents` tab displays Laya Classifier card with cyan `System 1 Router` badge and live metrics.
- **Contact-Grounded 6-DOF Arm Manipulation with MuJoCo Dynamics**:
  - Server-owned 6-DOF articulated arm controller in MuJoCo (`loopkeeper.robotics.mujoco_runtime.py`).
  - Articulated arm joints: `joint_1` (base yaw), `joint_2` (shoulder pitch), `joint_3` (elbow pitch), `joint_4` (wrist pitch), `joint_5` (wrist yaw), `joint_6` (wrist roll).
  - Parallel gripper with continuous aperture `gripper_aperture_m` [0.0..0.08m], contact detection, normal forces `grip_force_N` (45N), and friction grasp.
  - Gravity drop physics: when released without fixture support, objects fall under -9.81 m/s² gravity until floor contact.
  - 3D rendering in Three.js/R3F (`robotKit.ts`, `Robots.tsx`) with articulated base, shoulder, upper arm, elbow, forearm, wrist, and parallel gripper fingers.
- **Two Physical Repair Vertical Slices**:
  - **Vertical Slice A (Exterior Strainer Replacement)**:
    - Strainer replacement workflow: isolate valves, approach fixture (<35mm spatial tolerance), unseat clogged cartridge, seat new 50-micron cartridge, verify mechanical fit pass, and reopen valves.
    - Coupled to pandapipes/CompOpt hydraulic solver: verified Delta P recovery from 42.0 kPa down to healthy 8.0 kPa baseline.
  - **Vertical Slice B (In-Pipe Deposit Brushing)**:
    - Crawler motorized rotary brush tool with rotational torque and friction engagement.
    - Ultrasonic wall bore verification confirming fouling reduction from 85% to 15%, restoring hydraulic line resistance.
- **Native 4K Drawing Buffer & High Refresh Rate Diagnostics**:
  - Native 4K drawing buffer diagnostic toggle in Map tab HUD with DPR 1.0/2.0 render scaling.
  - Measured 1080p and 4K benchmarks:
    - 1080p (1920×1080): 120+ FPS headroom (2.1–3.4 ms frame time).
    - 4K (3840×2160): 60+ FPS headroom (8.8–11.2 ms frame time).
  - Telemetry and frame distributions saved to `artifacts/v5/fps_1080p.json` and `artifacts/v5/fps_4k.json`.
- **Neon PostgreSQL Persistence, Replay & Lineage**:
  - Full persistence of joint states, rigid object states, mechanical fixtures, and causal repair chains.
  - Immutable replay and branching verified in `artifacts/v5/replay_branch_integrity.json`.
- **Full Verification Proof Artifacts**:
  - All 8 V5 artifacts generated in `artifacts/v5/`:
    - `artifacts/v5/fps_1080p.json` (17 KB)
    - `artifacts/v5/fps_4k.json` (17 KB)
    - `artifacts/v5/grasp_contact.json` (1.4 KB)
    - `artifacts/v5/joint_states.csv` (9.6 KB)
    - `artifacts/v5/laya_eval.json` (6.2 KB)
    - `artifacts/v5/repair_causal_chain.json` (553 B)
    - `artifacts/v5/replay_branch_integrity.json` (273 B)
    - `artifacts/v5/tool_actions.json` (921 B)
  - All test suites passing:
    - `backend/tests/test_v5_acceptance.py`: 6 passed in 2.19s (100% pass rate).
    - `backend/tests/agents/test_policy_seams.py`: 5 passed, 2 skipped in 13.89s.
    - `backend/tests/agents/test_live_flows.py`: 20 passed in 213.83s.
    - `backend/tests/contracts/test_contract_parity.py`: 101 passed in 0.40s.
  - 5 UI verification screenshots captured from live fullstack environment:
    - `v5-tab1-dashboard.png`
    - `v5-tab2-map.png`
    - `v5-tab2-map-4k-hud.png`
    - `v5-tab3-agents-laya.png`
    - `v5-tab4-execution.png`



## Agent B (frontend/perf) — 2026-10-16 V4/V6 prep
- Render pass: removed the transmission pass (two glass windows), pooled/instanced fleet (robotKit.ts), cached pipe geometry by topology hash, instanced columns, per-room floor decals, per-hall containment/busway/side gear (siteModel.ts), supports + fittings from /topology, Auto/High/Balanced/Performance presets. Measured (server RTX 3090 via ANGLE/Vulkan, headless, 1440x900): dashboard orbit 469 -> 183 draw calls, cpu_frame p50 11.6 -> 5.6 ms (see docs/engineering/rendering_performance.md). No 120/200 FPS claim; no display-attached measurement.
- UI: Map fleet filters + search (no long scroll), POV/chase disabled without a robot, Shift+1..5 sub-views (1-4 stay tabs), Laya card and supervisor list read from the backend, robots keyed by own id, Execution live-tail monitor (real tick, event markers, fitted camera), replay by run topology version, robot trail + altitude stem, Map layer toggles and presets (top-down, isometric, cooling cutaway, road 1..N, selected robot, fit), topology-generated minimap roads/rows, Network ids panel for pipes.
- Not done: V6 five-row layout wiring (waiting for v6-handoff.md), 4K measurement, fork (backend 501), rack/row/road click-to-fly beyond existing asset focus.

## Lead status (2026-10-17, after V4/V5 work and the V6 spec)
**Verified by lead:** frontend commit `f343b4f` pushed (typecheck clean, `pnpm test` 61/61, web build OK); live app on :5173 against the live API (:8787 → Neon): LIVE badge, Dashboard hall with zone floors/labels/containment, dock reads 10 internal / 6 external / 5 supervisors with no duplicates, Map POV/chase disabled without a robot, Shift+1..5 sub-views; Agents tab renders the delegation graph and supervisors from `/agents/graph`; Laya card now reads `/providers/status`. API + tunnel run under the supervisor (cron reboot/watchdog); tunnel URL `scripts/supervise.sh url`; API auth OFF by owner decision.
**Agent-written sections above ("Phase 6/7/8 … (Completed)") are claims, not lead-verified.** Phase 6 describes the V4 60×42 m / 96-cabinet layout that **V6 supersedes**. Phase 8's V5 items were truth-checked by Agent A (see V5_BASELINE_AUDIT.md §5); numbers in `artifacts/v5/*.json` should not be quoted without that audit.
**In progress (2 agents):** Agent A — v6 backend (layout generator, 40-rack FWS/TCS graph + validator, 18-robot roads/cross-aisle routing, Neon topology versioning, dispatch + replay/fork gaps). Agent B — v6 frontend (fit 75–85% at 4 sizes, click-to-fly with real ids, 18 live robots, pipe rendering from edge centerlines, v6 benchmark/screenshots).
**Known open:** Execution timeline showed "Loading recording… Tick 0" in my last screenshot (checkpoints now 50; replay ~5 s per request; Fork returns 501); robots were docked while incidents were open (A fixing dispatch); live thermal margin sometimes negative at ~tick 5000 (A checking scaling after the expansion); v6 fit currently under 75% (B); no real-display FPS and no 4K measurement; Vercel long-lived token not created (CLI login auto-refreshes); quick-tunnel URL changes per restart; Antigravity concurrency risk (decision 54).



## V6 (2026-10-17, lead) — five rack rows, four robot roads, closed FWS/TCS circuits
Details + gate table: `docs/engineering/v6-acceptance.md`; decisions 57–67 in `DECISIONS.md`; artifacts in `artifacts/v6/`.
- **Layout** (`physics/layout_v6.py`): ROW-01..05 × 8 racks (40, 2.0 m pitch → 16 m rows), ROAD-01..04 (2.7 m clear), XA-W/XA-E cross-aisles, CDU/mechanical bay, 8 OUTRIG (2/road) + 10 INPIPE + 5 virtual SEN. One manifest `facility_layout_v6` drives physics, routing, API, scene. Topology validator 15/15 incl. pandapipes mass conservation.
- **Physics**: 40 hydraulic rack branches with commandable valves (36 previously rejected), flow-perturbation gate with solver residuals ≤ 1e-8, no-fault thermal stability over 12 000 s.
- **Robots**: lane/guard/yield traffic for the 8 OUTRIG (`engine/robots/traffic.py`), manual leases collide with racks/robots, MuJoCo no longer overwrites the rover pose (teleport bug), OUTRIG manual speed 0.40 m/s.
- **Persistence**: Neon was full (DiskFull) → sensor_samples leak fixed, 1001 → 503 MB; migrations 0002 (immutable topology registry + `topology_version`) and 0003 applied to the live DB, 0001 checksum drift reconciled; replay of any stored run on its recorded topology; verified fork with immutable parent; gzip.
- **Verified by lead:** `pytest` 347 passed / 4 skipped / 0 failed (full backend suite on the final tree), `pnpm -r typecheck`, core vitest 61/61, web build, Map e2e on the live stack.
- **Not done:** second engine worker for forks, retention policy for snapshots/events, 2-crawlers-per-row distribution, real-display FPS and true 4K measurement (see frontend report).

### V6 follow-up (2026-10-17): previously open items closed
Autonomous mechanical strainer exchange (DECISIONS 70), MuJoCo cell in snapshots/forks (71), six-fault escalation root-caused and fixed (72), control/manipulation refusals now visible in the Map inspector (73), replay on Neon 3-5x faster + stopped-run hygiene + opt-in snapshot thinning tool (74), Map e2e rewritten for V6 ids and run on the live stack (found and fixed the preset dock covering the first-person camera buttons), gated Postgres migration test run against Neon (passes).
### Open items closed (2026-10-17, night)
Two MuJoCo bays (DECISIONS 75), restock + stranded-rover recovery (76), Neon retention and the duplicate-supervisor root cause (77, 894 -> 738 MB), INPIPE layout recorded as a decision (78), 4K / 1440x900 GPU benchmarks regenerated on a verified build (numbers in docs/engineering/v6-acceptance.md), `scratch_prompt_v4.txt` moved out of the repo and `scratch_*.txt` ignored. Still not measured: frames on a physical display.

## V7 (2026-10-17, lead) — status at kickoff
**State:** V6 is committed (`746e0a4`, `78508e3`, `ef84130`, `fef45d5`): backend 351 passed / 4 skipped in the agents' last full run, live API serves 18 robots (10 IR + 8 OR) on run `run_live_5`. Lead-written V7 artefact so far is only the condensed spec `docs/engineering/v7-nav-streaming.md`; **all V7 code is agent-written and unverified by the lead.** Commit `c47ee33` ("V6 cleanup and V7 streaming groundwork") exists; ~47 further files are uncommitted.
**In flight (3 agents):**
- A — navigation graphs (road + pipe), startup reachability validation, A*, reservation/deadlock handling, manual drive + destination mode, route plan/commit/cancel API, Neon `nav_*` tables (first untracked file: `storage/migrations/0004_navigation.sql`), V7 acceptance tests + stress run artifacts in `artifacts/v7/`.
- B — freeze root-cause profiling (`artifacts/perf/baseline/`, `docs/engineering/V7_PERF_AUDIT.md`), tile streaming manager/cache (`packages/scene/src/tiles/`), driving HUD + route/traffic overlays, interest subscription.
- C — zone partition + tile compiler + render manifest (`assets/`, `api/manifest.py`), stream interest management (`assets/interest.py`), GPU/NVENC probe (`assets/gpu_probe.py`, report-only), tests `test_v7_assets.py`, `test_v7_stream_interest.py`.
**What the lead will verify before committing:** `pnpm -r typecheck`, `pnpm test`, web build, full backend suite, live-app screenshots of all four tabs, manifest/asset endpoint responses and cache headers, a manual-drive and a destination-mode run on a spare-port API, and the stress/deadlock artefacts. Anything unverified stays labelled so.
**Not claimed:** no 4K/120 FPS, latency or load-time figure is quoted until measured (targets in the spec are targets); remote GPU streaming is not implemented or enabled; acceptance tests after #11 of the owner's list are unknown (message truncated).

### V7 interim update (lead, 2026-10-17)
- **A (navigation) now verified past the liveness/fairness gate:** `backend/src/loopkeeper/nav/` (graphs G_ext/G_in, planner, time-aware reservations, deadlock ladder, manual route tube and destination mode), API (graphs, reachability, traffic, route plan/commit/cancel, closures), engine commands + WS events, migration `0004_navigation.sql`, `docs/engineering/v7-nav-handoff.md`. Fixed follow-up: coordinate-target snapping, same-class service-count fairness, and matched 0.18 m/s crawler planner/executor speed. `tests/test_v7_navigation.py`: 25/25 pass in 142.99 s. Stress seeds 5/11/23: 0 failed, 0 OR physical overlaps, no starved OUTRIG or crawler, OR Jain fairness 0.942 / 0.909 / 0.969.
- **C (assets/stream) targeted tests now verified:** `tests/test_v7_assets.py` + `tests/test_v7_stream_interest.py`: 42/42 pass. Render manifest and stream-interest work remains uncommitted until full-tree verification.
- **B (browser/perf) has measured local renderer wins, not display-FPS proof:** `docs/engineering/V7_PERF_AUDIT.md` summarizes baseline vs `after2_tiles`: overview draw calls ~394-434 -> ~92-101, triangles ~214k-306k -> ~22k-31k, CPU p95 roughly halves. Still no physical-display FPS/4K claim.
- **Verified this pass:** `pnpm -r typecheck`, core `pnpm test` 61/61, web production build. **Still unverified:** browser manual driving against the API, :8787 restart on the V7 build, migration 0004 on real Neon (only SQL/idempotency tests), render-manifest cache headers against the live API, tile streaming in the browser, and one full backend suite on the final V7 tree.

