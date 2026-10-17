# Backend hand-off

The frontends talk to a backend through one seam: the contract in
[`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts). `apps/mock-api` is a working reference
implementation (it runs the simulator in `packages/core/src/engine`). Replace it with the real service and
the web/mobile apps need no code changes.

## Switch a client to your backend

| Client | Setting |
|---|---|
| Web | `VITE_API_URL=https://your-api` (unset ⇒ embedded simulator) |
| iOS | `EXPO_PUBLIC_API_URL=https://your-api` |

Transport code: `packages/core/src/client/live.ts` (REST + WebSocket, reconnect with backoff, `since_seq`, gap → snapshot refetch).

## Endpoints used (all under `/api/v1`)

| Method / path | Notes |
|---|---|
| `GET /topology` | static geometry; **UI never guesses positions** |
| `GET /world` | full snapshot incl. `last_seq` |
| `GET /incidents/{id}/trace` | `{incident_id, tasks: AgentTask[]}` (thought *summaries*, tool calls with input/output, model metadata) |
| `GET /telemetry?asset_id&metric&window_s` | `TelemetrySeries` (sparkline backfill) |
| `GET /replay?from_seq&limit` | ordered events |
| `POST /commands` | `approve_action`, `hold_action` (target = approval id), `set_sim_speed`, `pause`, `resume`, `test.inject_fault` |
| `WS /stream?facility_id&since_seq` | first message **`snapshot`**, then ordered events |

Also implemented by the mock (not required by the UI): `/robots`, `/assets/{id}`, `/incidents`, `/health/live|ready`.

## Stream contract

Envelope: `event_id, seq, sim_tick, sim_time_s, world_version, type, entity_id, facility_id, ts, payload`.

- `seq` is monotonic **across every event type, including heartbeats**; the client treats a jump as a gap and refetches `/world`.
- Types: `snapshot`, `world.diff` (all assets' readings/status/fault ≈2 Hz), `robot.pose` (≈10 Hz), `mission.transition`, `incident.opened|updated|closed` (full incident object), `agent.task` (full task, upserted by id), `agent.tool` (tool-call upsert by id: `running` → `ok`), `verification.result`, `engine.health`, `heartbeat` (10 s).
- Robot motion: poses are interpolated *between* server samples (~160 ms delay) and **never extrapolated**.

## IDs & units

SI units, metres, `x/z` ground plane, `y` up. IDs: assets `rack_a1`, `cdu_01`, `pump_t1`, `valve_zb`, `strainer_02`, `sn_flow_zb`, `port_a2`; pipes `p_17` (label `P-17`); robots `c_01`, `c_02` (INPIPE) and `o_01` (OUTRIG); incidents `INC-009`; missions `m_09`; agent tasks `t_001`.

## Fields the UI depends on (beyond the obvious)

- `Topology.facility.interior_min/max`, `expansion_bays[]`, `edges[].centerline_xyz_m` + `fillet_radius_m` (the client rounds corners with the same routine the simulator uses — `buildPath` in `packages/core/src/geometry.ts`), `edges[].robot_passable` + `not_passable_reason`, `assets[].service_xyz_m`.
- `AssetState.fault.{occlusion, location_s_m, opening, commanded_opening, health}` — **simulator truth** used to render deposits and show a "twin only" panel. A real backend with no such truth can omit it.
- `Incident.approval` — high-impact actions open an `ApprovalRequest`; in `autonomous` mode it auto-approves at `auto_approve_at_s` unless held (operator veto window); in `supervised` mode `auto_approve_at_s` is `null`.
- `Incident.verification` — `checks[]` with `before/after/target/direction/pass`; `status: pending → verified | rejected`. A rejected repair must stay rejected and trigger a replan (`stage_log` records `outcome: 'rejected'`).
- `EngineHealth.backend: 'mock' | 'live'` and `intelligence.{provider, model_id, status}` — the UI shows `MOCK` / `MOCK AGENTS` vs `MODEL LIVE` from these. Never claim live inference when it isn't.
- `AgentTask.model.fallback` — true when the deterministic policy answered because the model was unavailable.

## What the mock simplifies

Physics is a small quasi-steady model (pump curve vs series/parallel resistances, ε-NTU CDU, RC rack thermals) — **not** CompOpt/pandapipes and not CFD. Leaks are listed in the contract but not simulated, and there is no GPU thermal-throttling model (a long operator hold can push margin negative).  The mock persists only `{seed, sim time}` and fast-forwards deterministically on restart.

## Parity checklist

- [ ] snapshot-first WebSocket, monotonic `seq`, `since_seq` resume
- [ ] `topology` includes passability + reasons
- [ ] `agent.task`/`agent.tool` stream, `/trace` returns the same objects
- [ ] verification can reject; replans appear in `stage_log`
- [ ] `engine.health.backend` / `intelligence` are truthful
- [ ] `world.diff` includes `status` per asset so severity colours are backend-derived
