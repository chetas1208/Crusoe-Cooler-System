# V11 master checklist — "Done Means Done" (hackathon deadline 17 Oct 2026, 5 PM PT = 00:00 UTC 18 Oct)
Spec: user's V11 prompt (Recursive Agent Teams). Order = priority. [x] only when the lead has verified it (command/output), [~] = built by an agent, not yet verified by the lead, [ ] = not started. Pre-event baseline for provenance: git SHA at checklist creation = `ea30ba5` (earlier commits = pre-event/earlier work; event-period diff is `git diff <baseline>..HEAD`).

## G0 — audit + smoke (prove the real hops)
- [x] Crusoe key authenticates, credits active: `/models` 200, chat 200 (checked 17 Oct ~18:05 UTC)
- [x] Model capabilities probed: Nano-30B, Super-120B, 3.5-Lightning all support tools/structured_outputs/response_format/seed/reasoning; measured thinking-off = Nano 0.3–0.9 s, Super 1.8–2.1 s; thinking-on Super 13 s + whitespace-loop failure at 1200 tokens
- [x] Client wired: tiers by decision kind, thinking off, seed 7, probe live; 21 model-layer tests pass (`MODEL_NAME_DEEP` etc. in .env)
- [x] Agents' incident flow runs on the real models (in-process harness, in-memory store, strainer fault, seed 3, ~75 s wall): classify+review = Nano (0.44/0.63 s), intervention+verify = Super (0.79/0.72 s), incident resolved; 7 frozen decisions, 0 call failures. Defect found: `reconcile` (Super) took 17–24 s and was REJECTED twice for invented ids (loop_main, loop_flow, rack_A2) → deterministic fallback closed it (validators work; prompt must list valid ids). Live :8787 run: no incident has reached a model call since the restart yet; incidents INC-022..027 are stuck at 'investigated'
- [ ] Rename/alias env to spec: CRUSOE_MODEL_REASONER / _SPECIALIST / _REVIEWER, CRUSOE_MAX_REQUESTS_PER_MIN, spend ceiling
- [x] Neon: pooled + direct endpoints reachable, real transaction 172 ms, PostgreSQL 18.6, 37 public tables incl. checkpoint_*, agent_communications, world_events, verification_runs
- [x] LangGraph Postgres checkpoint: graph interrupted at an approval node, a fresh pool/saver/process saw next=('authorize',), Command(resume=True) completed it; 5 checkpoint rows written, test thread cleaned up
- [~] Laya: `Router` from the local SDK loads a real checkpoint (it warned the checkpoint ships invalid temperatures and clamped to 0.5, so confidences are suspect); accuracy/calibration still unmeasured (Agent C benchmark pending)
- [ ] Baseline hop table (prompt→scenario→fault→sensor→delegation→robot action→physics→verify→replay): which hop is real → docs/engineering/V11_BASELINE.md
## G1 — core proof: executable Definition of Done + independent verifier
- [ ] SEN-01 (Super) drafts a DOD contract from a vague request/anomaly; deterministic compiler validates (asset ids, units, allowlisted checks, hold periods, configured limits) and FREEZES before any repair; lifecycle PROPOSED→VALIDATED→FROZEN→EVALUATING→VERIFIED|FAILED|ESCALATED; version bump + reason for changes
- [ ] Layer A deterministic evaluator: fresh solver state, redundant sensors, hold durations, UNKNOWN on non-convergence/missing data
- [ ] Layer B SEN-05 (Super, isolated context) reviews frozen contract + Layer-A results; cannot force a pass
- [ ] Terminal states: VERIFIED | PARTIAL | CONTAINED_NOT_REPAIRED | ESCALATED | FAILED | TIMED_OUT | UNKNOWN
- [ ] Signature flow executed live: first repair insufficient → verifier rejects → SEN-01 replans → second action restores flow → sustained checks pass (or honest escalation)
## G2 — team, protocol, limits
- [ ] Five SENTINEL roles differentiated (SEN-01 goal architect, -02 INPIPE coordinator, -03 OUTRIG coordinator, -04 safety arbiter + deterministic policy, -05 verifier), model per role (Super/Nano)
- [ ] INPIPE/OUTRIG mission tasks persisted with parent links; recursive children bounded (depth ≤3, ≤6 active LLM subtasks, ≤2 concurrent high-cost calls, ≤2 plan revisions, budget)
- [ ] Agent Envelope Protocol v1 (kinds TASK_ASSIGN…HUMAN_OVERRIDE), per-run monotonic seq, transactional outbox (at-least-once + idempotent), DAG cycle refusal, no duplicate actuation after retry/restart
- [ ] drift.detected / loop.detected (repeat plan hash, no physical progress, budget) → replan/stop/escalate, visible in comms
- [ ] Tool registry + authority L0–L3 double enforcement (proxy + engine commit); no raw DB/shell/motor tools
- [ ] Model gateway: budget per run/incident, 429/503 backoff+jitter (+Retry-After), circuit breaker, ≤1 JSON repair, model_calls table (id, tokens, cost, latency, output hash), frozen outputs on replay
## G3 — shared brain (Neon)
- [ ] Tables: done_contracts, agent_tasks, agent_messages, tool_calls/results, observations, physical_verifications, shared_facts, procedural_lessons, memory_conflicts, agent_outbox (migration after 0004; reuse existing where possible)
- [ ] Read-before-work / write-after-work with provenance, conflict handling, expiry; restart recovery without duplicate repair
## G4 — demo + UI
- [ ] Execution: prompt→status chain (received→classified→interpreted→scenario_validated→running) with real latency/errors
- [ ] DOD panel (checks, measured values, hold timers, pass/fail/unknown, revision, evidence links)
- [ ] Communications panel (real events, filters, jump-to-source, hide/reopen) — V10 spec
- [ ] Team/Task DAG panel (5 SEN roles, INPIPE/OUTRIG children, budgets, loop warnings)
- [ ] 30:00 player 1×/2×/3×, replay with frozen decisions, fork lineage
- [ ] Mobile shell fallback + desktop regression (V10 spec; deferred behind G1–G3 if time is short)
- [ ] Scorecard view + demo script (3 min) + 1-minute video + public repo + provenance doc (event-period work vs pre-event)
## Evaluation
- [ ] 9 scenarios (CR-01…CR-07, MD-01, MD-02) injected via valid engine parameters
- [ ] ≥10 held-out seeds, manifest frozen with hashes; arms: static baseline vs single-pass agent vs recursive DOD+delegation at equal budgets; verified completion, false-success (target 0), time-to-containment/recovery, replan recovery, unsafe-action rejection, cost per verified run, trace coverage, replay determinism
- [ ] Laya: ≥30 labelled held-out inputs, confusion matrix, calibration, abstention; deterministic safety override
## Stretch (only after G1–G3 stable)
- [ ] Memory ON/OFF ablation; playbook candidate evaluated on held-out set (accept or honestly reject)
## Cross-cutting
- [ ] No mocks in operational paths; failures visible; secrets never in browser/logs; run isolation/auth; no GitHub Actions
- [ ] PROGRESS.md / DECISIONS.md updated per gate; docs: V11_BASELINE, V11_AGENT_PROTOCOL, V11_MODEL_CATALOG, V11_EVAL; artifacts/v11/
