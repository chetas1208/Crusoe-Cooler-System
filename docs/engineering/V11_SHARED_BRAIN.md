# V11 Shared Brain (cross-run memory)

Package `backend/src/loopkeeper/memory/`, migration `backend/src/loopkeeper/storage/migrations/0010_shared_brain.sql`, tests `backend/tests/test_v11_memory.py`.
Feature flag `MEMORY_ENABLED` (default OFF). With the flag off nothing is read, written or created.

## Tables (migration 0010, idempotent, applied on both pools like every migration)
| table | purpose | key |
|---|---|---|
| `shared_facts` | claims about an asset/sensor/state with provenance | (fact_id, revision) |
| `procedural_lessons` | "for fault X on asset type Y do steps S" | (lesson_id, revision) |
| `memory_conflicts` | one row per contradiction, every side kept | conflict_id |
| `playbook_versions` | candidate/accepted/rejected playbooks + held-out evaluation | (playbook_id, version) |

Common columns: `run_id` (origin run), `incident_id`, `source_run_ids`, `evidence_ids`, `event_refs` (links to immutable `world_events`), `preconditions`,
`confidence`, `revision`, `status` (PROPOSED, VERIFIED, CONFLICTED, REJECTED, EXPIRED, ARCHIVED), `visibility` (run | shared), `proposed_by`, `verified_by`,
`verification_ref`, `expires_ts`. Timestamps are unix seconds (double precision). No FK to `simulation_runs`: memory outlives the run; run ids are provenance
references and every row can be re-derived from the event log. Indexes: scope (facility, fault, asset type, status), subject, run, partial expiry.
Stores: `MemoryBrainStore` and `PgBrainStore` implement one row interface (`insert/get/update/select/delete/locked`); all semantics are in `SharedBrain`, so both
behave identically. A test asserts SQL/Python column parity on a real Postgres. Read-modify-write is serialised per subject (process lock / Postgres
transaction-scoped advisory lock on one connection).

## Rules
* **Write = proposal.** `propose_fact` / `propose_lesson` need run id, evidence ids, proposer; stored PROPOSED, never read (not even by the proposing run).
* **Promotion only by an independent verified outcome** (`settle`): status `verified`, a verification id, a verifier different from the proposer, about a run the item names.
  FAILED verification: lesson REJECTED (kept for audit, never learned); a fact stays unverified (expires). UNKNOWN: nothing changes.
* **Corroboration** (same claim verified again) merges evidence/run ids into the verified twin (success_count, confidence up); the duplicate is ARCHIVED.
* **Contradiction = new revision, both kept, status CONFLICTED**, `memory_conflicts` row OPEN; conflicted items are never served as truth (listed under `disputed`).
  Resolution needs an independent verified outcome (`resolve_conflict`); a contradicting claim whose own verification fails is REJECTED and the other side is restored.
  Two unverified claims do not conflict until one is promoted. A verified lesson that fails under the same plan + preconditions becomes CONFLICTED.
* **TTL**: sensor facts 30 min, transient 10 min, unsettled proposals 7 days, explicit `ttl_s`; expired rows are filtered at read time and marked by `expire_sweep()`;
  `invalidate()` stops a wrong/stale fact immediately.
* **Compaction**: `compact(facility, older_than_s, delete)` replaces REJECTED/EXPIRED rows by one ARCHIVED `sum_*` row per subject keeping `event_refs`, evidence and run ids.
* **read_relevant(run_id, facility_id, fault_kind, asset_type, asset_id, topology_revision, limit, token_budget, exclude_runs)**: VERIFIED + unexpired + in-scope only, same
  facility, shared (or own run), topology revision must match when both are set, nothing whose provenance touches `exclude_runs` (held-out guard). Lessons first, then
  facts, ranked by confidence x success + asset match; greedy fill under the token budget (4 chars/token estimate; header 12); result `tokens <= token_budget`.
* Memory is advice: the text is data in the planner prompt; the deterministic policy still validates every action.

## Integration hooks for Agent A (two functions, two places)
```python
from loopkeeper.memory.hooks import memory_read, memory_write          # one import in orchestration/graphs/sentinel.py
```
1. **Read before SEN-01 plans** - top of `choose` in `graphs/sentinel.py`, right after `cause, attempts = ...`:
   `mem = await memory_read(ctx, det, s.inc)` -> `{}` or `{"memory": {"lessons": [...], "facts": [...], "disputed": [...], "tokens", "digest", "note"}}`;
   add it to the facts dict of `s.decide(t, kind, {...})` as `**mem` (and, if wanted, to the DOD drafting facts in `dn.ensure_contract`). Safe to call on every attempt.
2. **Write after verification** - top of `close` in `graphs/sentinel.py`, right after `v = state["verify"]`:
   `await memory_write(ctx, state)`. It proposes the attempt's lesson (`{action, target_role}` + preconditions) and the confirmed-cause fact with the incident's evidence
   ids, then settles them with the verifier's outcome (`state["verify"]["ok"]` / `["unknown"]`, verification id from `incident["verification"]["id"]`, verifier
   `verifier:SEN-05`, proposer `agent:SEN-01`). Skips escalations. Never raises (errors are logged and counted in `brain.stats["errors"]`).
Both are no-ops when `MEMORY_ENABLED` is unset/0. The brain lives on `engine.storage` (`storage._shared_brain`), so every run on that storage shares it; on Postgres the
rows are in the control database (`DATABASE_URL` pool), never the telemetry lake. Optional token budget: `MEMORY_TOKEN_BUDGET` (default 450).

## Ablation hook for the evaluation (Agent C) - `memory/ablation.py`
`make_brain(enabled)` -> `NullBrain` (OFF: same interface, remembers/returns nothing) or `SharedBrain` over an in-memory store (ON, ephemeral, no DB).
`record_episode(brain, ...)` writes a finished TRAINING episode through the real propose + settle path (the truth verdict is the independent verifier; failed
episodes teach nothing). `prior_block(brain, ..., exclude_runs=HELD_OUT_RUN_IDS)` returns the compact text to prepend to an arm's prompt (empty when OFF / nothing
learned). `paired_delta(off_rows, on_rows, metric)` gives the paired ON-OFF difference with n/wins/losses (no significance claim). The playbook candidate path:
`propose_playbook` -> `decide_playbook(evaluation)` accepts only with >= 10 held-out seeds, a positive verified-completion gain and no increase in false success;
otherwise it stores an honest REJECTED with reasons.

## Not done / limits
* Hooks are NOT yet wired into orchestration (Agent A owns those files); the exact lines are above. The ablation numbers do not exist yet (needs C's runs).
* Neon: migration 0010 was exercised only on an embedded Postgres (pgserver) and, if set, `TEST_DATABASE_URL`; it has not been applied to production.
* Retrieval ranks by confidence and scope only (no embeddings); the token count is an estimate (chars/4).
* **Integration gap (found by the V11 ablation, Agent I)**: in the real runtime `ctx.engine` is an `ActorView` that exposes no `storage`, `facility_id` or `topology_revision`, so `memory_read` / `memory_write` do nothing (brain_for -> None; _scope AttributeError swallowed) even with MEMORY_ENABLED=1. Fix = three read-only properties on `engine/core.py::ActorView`. Measured effect once exposed (harness shim): none, see V11_EVAL.md section 2c.
