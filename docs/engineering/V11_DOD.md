# V11 Gate 1: executable Definition of Done (Agent A)

Code: `backend/src/loopkeeper/orchestration/dod.py` (compiler, goalpost guard, Layer A, terminal states), `graphs/dod_nodes.py` (SEN-01 draft/revise, loop guard,
SEN-05 Layer B), `graphs/verifier.py` (Layer A runs inside the existing verifier window; the legacy checks are reused as the mandatory checks), API `api/routes_dod.py`,
migration `0009_done_contracts.sql`, events `dod.contract` (tracked), `drift.detected`, `loop.detected`.

Flow: detect -> classify -> reviewers -> reconcile -> probes -> inspection -> `choose`: **SEN-01 (deep model) drafts** (`dod_draft`: goal, subject ids, hold, allowlisted check
types) -> **compiler validates** (ids exist and are in scope, check types allowlisted and applicable to the cause, hold within bounds; thresholds/units come from the
existing verifier checks = plant configuration, never from the model; mandatory checks are always added) -> **FROZEN** (hash) before any repair is chosen or dispatched ->
repair -> verifier window: Layer A samples every check from fresh world data, a check counts only after it **held** continuously for `hold_sim_s`; missing data / solver
not converged = UNKNOWN -> **Layer B SEN-05** (`dod_review`, isolated: frozen contract + Layer-A table + 6 events; no history) may `concur` (rejected by the validator unless
Layer A = PASS), `request_more_tests` (more allowlisted checks / longer hold -> version bump) or `request_replan`; it has no way to force a pass. After a rejection SEN-01 may
revise (`dod_revise`): only by version bump + reason and only if not looser (no removed check, relaxed threshold or shorter hold).
Lifecycle PROPOSED -> VALIDATED -> FROZEN -> EVALUATING -> VERIFIED | FAILED | ESCALATED; terminal states VERIFIED | PARTIAL | CONTAINED_NOT_REPAIRED | ESCALATED | FAILED | TIMED_OUT | UNKNOWN.
Guards: repeat plan hash -> `loop.detected`; two attempts with no physical delta, exhausted model budget -> `drift.detected`; > 2 plan revisions; stuck-stage liveness guard
(`Limits.stuck_stage_s` = 1500 sim-s without progress, or a dead graph) escalates with the reason and frees the incident slot. Limits: depth <= 3, <= 6 active LLM subtasks per incident,
<= 2 concurrent deep-model calls (DecisionService semaphores), <= 1 validator/JSON repair.
Evidence: `tests/test_v11_dod.py` (signature flow: first repair insufficient -> rejected -> replan -> second action restores -> sustained checks held), artifact `artifacts/v11/dod_signature_flow.json`.
Real model check (Crusoe, in-memory, seed 3, strainer): reconcile accepted by Super in 4.6 s, `dod_draft` accepted, `dod_review` accepted (9.7 s), full flow resolved.
Known gaps: terminal states PARTIAL / CONTAINED_NOT_REPAIRED / TIMED_OUT are derived (unit-tested) but not yet produced end to end in a live run; the gateway
(Agent C) is not yet the DecisionService client; `:8787` not restarted.
