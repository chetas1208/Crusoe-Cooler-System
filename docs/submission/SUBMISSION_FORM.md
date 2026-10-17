# Submission form: ready-to-paste text

Status as of 17 Oct 2026, ~21:30 UTC. Everything here is limited to what exists in the repo today. Items that depend on unfinished or unverified work are
tagged `[PENDING: ...]`: **delete the tag only after the lead has verified the item** (see `docs/engineering/V11_CHECKLIST.md`). Event-eligibility wording
depends on the organiser's start time `[PENDING: user]` (see `PROVENANCE_EVENT.md`).

---

## Project name
LOOPKEEPER

## One-liner (<= 140 characters)
A virtual liquid-cooled AI data center where agent teams must pass a frozen, physics-checked "definition of done" before a repair counts.

## Short description (about 60 words)
LOOPKEEPER simulates a liquid-cooled AI hall (real hydraulics and thermals) with robots and a team of Nemotron agents. Before any repair, an agent
drafts an executable Definition of Done; a deterministic compiler freezes it; an independent verifier re-measures the plant and can reject the fix. Every
decision, message and verdict is stored in Neon and replayable without calling a model.

## Problem statement choice
**Primary: DONE MEANS DONE.** Agents claim "fixed"; LOOPKEEPER makes completion a measured, held, independently verified fact.
**Secondary: SHARED BRAIN.** Agents read and write shared facts, tasks and lessons through Neon with provenance `[PENDING: Agent D, shared-brain tables/memory verified; code exists untracked, migration 0010]`.

## What problem it solves
Autonomous agents are good at saying a job is finished and bad at proving it. In a cooling plant the cost of a false "done" is thermal damage, so the
question is not "can an agent propose a fix" but "who decides it worked". LOOPKEEPER separates the roles: agents propose and delegate, deterministic code
moves robots and enforces safety, and a separate verifier decides from fresh physics whether the repair held.

## What is novel
1. **Executable Definition of Done.** SEN-01 (Nemotron Super-120B) drafts the contract from a vague request or anomaly; a deterministic compiler validates asset ids, units, allowlisted check types, hold periods and configured limits, then freezes it with a hash **before any repair is chosen**. Thresholds come from plant configuration, never from the model. Lifecycle PROPOSED -> VALIDATED -> FROZEN -> EVALUATING -> VERIFIED | FAILED | ESCALATED. Changing the contract needs a version bump and a reason and may never loosen a check (goalpost guard).
2. **Two-layer independent verification.** Layer A re-measures fresh solver state with redundant sensors and hold durations; missing data or non-convergence is UNKNOWN, never a pass. Layer B (SEN-05, isolated context) reviews the frozen contract and Layer-A results and **cannot force a pass**.
3. **Recursive agent team with hard bounds.** Five SENTINEL roles (goal architect, INPIPE coordinator, OUTRIG coordinator, safety arbiter, verifier) delegate to in-pipe crawlers and exterior rovers; depth <= 3, <= 6 active LLM subtasks, <= 2 concurrent deep calls, <= 2 plan revisions, loop/drift detection. `[PENDING: Agent B, protocol items verified: outbox, DAG cycle refusal, no duplicate actuation after restart]`
4. **Honest evaluation.** Nine scenarios x ten held-out seeds, frozen manifest with hashes, false-success as a headline metric, replay determinism check (see "Results so far").
5. **Physics-grounded.** Faults enter through valid solver parameters (pandapipes hydraulics, CompOpt thermals); closing a valve or clogging a pipe changes solved flow and temperature. Replays re-read stored decisions: zero model calls.
6. **Truthful degradation.** If the model is unavailable the system uses a labelled deterministic policy rather than a fake answer; a model saying "approved" is never authority (L0-L3 grading, checked at the tool boundary and again at engine commit).

## Tech used
| Layer | What |
|---|---|
| Inference | **Crusoe Managed Inference**, NVIDIA **Nemotron-3-Nano-30B-A3B** (fast tier: classification, perception, review) and **Nemotron-3-Super-120B-A12B** (deep tier: SEN-01 drafting, reconciliation, planning, SEN-05 review, escalation). Thinking off, seed 7, structured outputs. Measured on our account: Nano 0.3-0.9 s, Super 1.8-2.1 s per call (thinking off). Gateway with rate limit, per-model circuit breaker, bounded concurrency `[PENDING: Agent C, gateway wired into DecisionService and budgets/model_calls verified]` |
| Orchestration | **LangGraph** graphs per incident with Postgres checkpointing (restart-safe resume verified, checklist G0) |
| Persistence | **Neon** PostgreSQL: pooled + direct endpoints, dual projects (control plane and telemetry lake), 37 tables verified at G0 (runs, events, snapshots, checkpoints, communications, verification runs); migrations through 0009 in git (`0010_shared_brain` untracked) |
| Triage | **Laya** Router (open-source small classifier, advisory only, abstains to human review) |
| Physics | **pandapipes** (quasi-steady hydraulics), **CompOpt** (chip/coolant thermals behind adapters), **MuJoCo** (workcell manipulation: strainer swap, brush clean) |
| Frontend | React + Three.js (React Three Fiber), four tabs (Dashboard, Map, Agents, Execution), Communications / Definition-of-Done / Team panels, 30:00 player with replay and fork |
| Backend | FastAPI, single-writer engine per run, WebSocket stream, Cloudflare tunnel + Vercel for the public console |

## Results so far (snapshot `artifacts/v11/scorecard.json`, generated 17 Oct 21:16 UTC; **refresh from the file before pasting** `[PENDING: Agent E]`)
- 9 scenarios x 10 held-out seeds, manifest sha256 `489b96a1...b5afc9`, development seeds never evaluated.
- Arms measured: `no_action` (0 of 90 verified), `static` playbook (60 of 90 verified; 30 false-success claims in 90 runs), `single_pass` Nemotron agent (25 of 90 verified; 62 false-success claims in 87 claims; 104,611 tokens, about USD 0.05).
- **The recursive DOD + delegation arm was "NOT RUN" in that snapshot.** We make no claim about it until it runs `[PENDING: Agent E / lead]`.
- Replay determinism: 180 of 180 re-executions identical with zero model network calls.
- Unsafe-action probe: 6 probes, 0 unsafe actions proposed by the model.
- Laya, held-out test (36 cases): router raw accuracy 0.33, labelled rule fallback 0.42; Laya is advisory and a deterministic override handles unsafe requests. We report this as a limitation, not a feature.
- Signature flow (first repair insufficient -> verifier rejects -> SEN-01 replans -> second action restores flow -> sustained checks held): passes in `backend/tests/test_v11_dod.py` with the deterministic drafter; live with Super-120B `[PENDING: lead]`.

## Honest limitations
- **Simulation, not a control system.** Hydraulics are quasi-steady, thermals lumped, robot cleaning/manipulation use documented simplified models. Nothing controls real equipment.
- **The natural-language prompt path and the agent-team path are two runs today.** `POST /scenario-requests` (Laya -> Nemotron -> compiler) builds a recorded 30:00 episode with a fixed response script; the SEN team and the frozen DOD operate on the live run. The demo bridges them by injecting the same fault family into the live run and says so. `[PENDING: lead]` single integrated flow.
- **Live signature flow with the real 120B model is not yet verified**; the verified end-to-end real-model flow so far resolved a strainer fault without a replan. Terminal states PARTIAL, CONTAINED_NOT_REPAIRED and TIMED_OUT are derived and unit-tested but not yet produced end to end in a live run.
- **Laya is weak** (see above) and advisory; abstaining on vague prompts is expected.
- **Recursive-arm results pending** (see above). Scorecard numbers come from a simulated-plant harness at equal budgets, not from real plants.
- **Auth is off on the public tunnel** by the owner's decision: anyone with the link can send commands. The demo link should not be treated as a hardened service.
- The top-bar status wording can read "Active (Autonomous Policy)" when the deterministic fallback is acting; use the model id and the Crusoe badge as the proof of a live model.
- Facility scale: five rows x 8 racks (40 rack loads in the pandapipes network per `docs/engineering/v6-layout.md`; thermals use CompOpt for instrumented racks and a documented lumped representation for the rest `[PENDING: lead, confirm the exact split]`). The 3D scene draws more cabinet positions (the "96 rack units" in PROGRESS.md) than the solver models: do not describe drawn cabinets as simulated racks. 10 in-pipe crawlers and 8 exterior rovers.
- Fairness of multi-robot traffic under heavy load, measured frame rates on real high-refresh displays, and the mobile layout are not fully verified (README "Status and honest limits"). `[PENDING: Agent F-UI / lead]` mobile shell.
- Development was AI-assisted (agent tooling plus a human engineer); see `docs/submission/PROVENANCE_EVENT.md` for what is pre-existing versus new in the event, including three inconsistent cut lines that the organiser's rules must settle.
- Test status: the README records 351 backend tests passed and 4 skipped (skips need a real database or provider key) at its last full run; re-run before submitting `[PENDING: lead]`.

## Event-eligibility statement (draft; finalise after the cut line is chosen `[PENDING: user]`)
LOOPKEEPER's simulation platform (physics, engine, robots, console, earlier agent loop) existed before the event; its first commit is 15 Oct 2026. Work built
for this event, from baseline commit `ea30ba5` (17 Oct 2026 17:53 UTC): the executable Definition of Done and two-layer verifier, the five-role team with bounded
delegation, the agent communications protocol and panels, the model gateway and tiering, the evaluation harness and scorecard, the shared-brain tables, and the demo/submission pack.
Full table with commit evidence: `docs/submission/PROVENANCE_EVENT.md`. Third-party components and licenses: `THIRD_PARTY_NOTICES.md` (being corrected, see that doc, section 5d).

## Links (fill in; do not publish placeholders)
- Public repo: `[PENDING: lead, re-export from final private commit; the existing export is at 8ad9aec and lags]` https://github.com/<org>/loopkeeper
- Live demo (Vercel): https://your-app.vercel.app (needs the API origin; see DEMO_SCRIPT.md) `[PENDING: confirm still up at submission]`
- API tunnel (ephemeral, changes on restart): `<paste current .state/tunnel_url>`
- 3-minute demo video: `[PENDING: record per scripts/demo/record_checklist.md]` <url>
- 1-minute video: `[PENDING]` <url>
- Scorecard / evidence bundle: `[PENDING: artifacts/ is gitignored; publish a curated copy]` <url>
- Neon project (read-only evidence view, if shareable): `[PENDING: decide what may be shared]`
- Demo script: `docs/submission/DEMO_SCRIPT.md`; provenance: `docs/submission/PROVENANCE_EVENT.md`
- Team: `[PENDING: names / emails as the form requires]`
