# Backend work split (4 agents)

Source of truth for behaviour: backend.md (repo root). Source of truth for wire shapes: packages/core/src/contracts.ts
and docs/backend-handoff.md. Seams: backend/src/loopkeeper/interfaces.py. Reference sim (TypeScript, behavioural spec for
incident flow/verification/faults): packages/core/src/engine/*.

| Pkg | Owner dir(s) | Deliverable |
|---|---|---|
| A physics | loopkeeper/physics/**, backend/configs/**, tests/physics | Plant impl: CompOpt thermal + pandapipes hydraulics + coupling, faults, sensors, topology matching the frontend's facility; docs/engineering/upstreams.md, THIRD_PARTY_NOTICES.md |
| B engine+storage+robots | loopkeeper/engine/**, loopkeeper/storage/**, docker-compose.yaml, tests/engine, tests/restart | single-writer loop, clock, command bus, robots/missions/leases/deadman, Postgres schema/snapshots/event log/advisory lock, run/fork/replay logic |
| C agents | loopkeeper/orchestration/**, loopkeeper/intelligence/**, tests/agents | monitor, policy, SENTINEL/INPIPE/OUTRIG LangGraph graphs (PG checkpointer), Crusoe client + deterministic fallback, verifier |
| D api | loopkeeper/api/**, tests/contracts, tests/integration, backend/README.md, .env.example | FastAPI REST+WS exactly per contracts.ts, health/models status, runs/replay/fork/lease routes, app wiring (apps entrypoint) |

Rules: edit only your owner dirs. Need a change in another's seam -> note it in docs/engineering/seam-requests.md, don't edit.
No GitHub Actions. No fabricated test results. No real credentials. Use `cd backend && uv run pytest`.
