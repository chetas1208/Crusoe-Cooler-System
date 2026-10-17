# V10/V11 communication protocol (Agent Envelope Protocol, `agent-envelope.v1`)

Source of truth = what the runtime actually emitted. Every record is a canonical `world_events` row of kind `comm.<message_type>` written in the SAME
transaction (and the same per-run `seq`) as the runtime event it was derived from, then delivered on the existing stream after commit (the engine's
commit -> bus publish is the outbox relay: at-least-once on reconnect via `since_seq`, idempotent consumer by `(run_id, seq)`; producer-side dedupe by
`payload.idempotency_key`, rebuilt from storage after a restart). No LLM narrates anything: summaries are templates over authoritative fields; no prompts,
reasoning or secrets are stored (`bound_detail` strips hidden-reasoning keys, `scrub` masks secret keys/values, text is control-char free and <= 240 chars).
Code: `backend/src/loopkeeper/comms/` (schema.py, derive.py), hook in `Engine.emit_internal`, REST `api/routes_comms.py`, migration `0007_communications.sql`.

## Fields (`CommunicationEventV1` / envelope)
schema_version, message_id (= event_id), event_id, run_id, seq, sim_tick, sim_time_ms, wall_time_utc (from the row timestamp, not part of the stored payload),
message_type (agent_message | task_transition | tool_event | verification | safety | operator | simulation | provider), subtype (concrete boundary),
kind (protocol kind: TASK_ASSIGN ACK REQUEST_OBSERVATION OBSERVATION HYPOTHESIS REQUEST_TOOL TOOL_ACCEPTED TOOL_REJECTED PROPOSE_PLAN PLAN_APPROVED PLAN_REJECTED
SAFETY_VETO PROGRESS REPLAN VERIFICATION_REQUEST VERIFICATION_RESULT ESCALATION STOP HEARTBEAT MODEL_ERROR HUMAN_OVERRIDE), phase, status
(ok|pending|info|warning|failed|blocked), sender{kind,id,class}, recipient?, thread_id, task_id, parent_task_id, mission_id, incident_id, asset_id, robot_id,
summary, evidence_ids, model_provider, model_id, visibility, causal_event_id, priority, deadline_sim_tick, world_version_observed, topology_revision,
permission_scope (observe|plan|act|operator|system), idempotency_key, payload (bounded authoritative metadata; also mirrored as `detail`).
Classes: SENTINEL (seats SEN-01..05), INPIPE, OUTRIG, OPERATOR, SYSTEM, PROVIDER.

## REST
`GET /runs/{id}/communications?after_seq&before_seq&limit<=200&kind&agent_class&thread_id&until_tick&order&include_parent`, `GET .../communications/{event_id}`,
`GET /runs/{id}/replay/communications?cursor_tick=N` (sim_tick <= N only, `model_calls: 0`). Unauthorised or foreign run: 404 with no body leak. Fork: the child
lists its own events; `include_parent=true` prepends the immutable parent history up to the fork checkpoint (`lineage.parent_cut_seq`).

## DAG / duplicates
`IncidentSession.task()` refuses a task that would become its own ancestor (`PolicyReject`, test `test_task_dag_cycle_is_refused...`). Re-emitted task/tool/verification
state is deduped by key (test `test_duplicate_state_emissions_and_restart...`). Pose spam never produces a record; drive intents are coalesced to one record per 15 sim-s
per lease; navigation reports route milestones only.

## Real examples
Taken from the stored rows of the live-flow harness run (seed 3, fouling on p_hs_b, brush insufficient -> verification fails -> replan -> verified; deterministic
fallback, no model): `artifacts/v10/communications_real_run.json` (172 records, order list, REST page, stream envelope). Excerpts:

### TASK_ASSIGN (task.delegated)
```json
{
 "asset_id": "p_hs_b",
 "causal_event_id": "ev_001472",
 "detail": {
  "depth": 2,
  "key": "task:t_001_07:working",
  "parent_task": "t_001_06",
  "task_kind": "inspect"
 },
 "event_id": "ev_001473",
 "evidence_ids": [],
 "incident_id": "INC-001",
 "message_type": "agent_message",
 "mission_id": null,
 "model_id": "policy-engine-v1",
 "model_provider": "deterministic",
 "phase": "requested",
 "recipient": {
  "class": "INPIPE",
  "id": "IR-01",
  "kind": "robot"
 },
 "robot_id": "IR-01",
 "run_id": "run_t3",
 "schema_version": "communication.v1",
 "sender": {
  "class": "SENTINEL",
  "id": "t_001_06",
  "kind": "agent"
 },
 "seq": 1473,
 "sim_tick": 1796,
 "sim_time_ms": 898000,
 "status": "pending",
 "subtype": "task.delegated",
 "summary": "SENTINEL delegated to INPIPE IR-01: Inspect P-hs_b",
 "task_id": "t_001_07",
 "thread_id": "INC-001",
 "visibility": "operator",
 "wall_time_utc": "2026-10-17T18:13:55.937Z"
}
```
### ACK (mission.ack, from the robot)
```json
{
 "asset_id": "p_hs_b",
 "causal_event_id": "ev_001487",
 "detail": {
  "key": "mis:m_001_insp0:ack",
  "kind": "inspect",
  "steps": 3
 },
 "event_id": "ev_001488",
 "evidence_ids": [],
 "incident_id": "INC-001",
 "message_type": "agent_message",
 "mission_id": "m_001_insp0",
 "model_id": null,
 "model_provider": null,
 "phase": "completed",
 "recipient": {
  "class": "INPIPE",
  "id": "t_001_07",
  "kind": "agent"
 },
 "robot_id": "IR-01",
 "run_id": "run_t3",
 "schema_version": "communication.v1",
 "sender": {
  "class": "INPIPE",
  "id": "IR-01",
  "kind": "robot"
 },
 "seq": 1488,
 "sim_tick": 1800,
 "sim_time_ms": 900000,
 "status": "ok",
 "subtype": "mission.ack",
 "summary": "IR-01 accepted inspect mission m_001_insp0 on p_hs_b",
 "task_id": "t_001_07",
 "thread_id": "INC-001",
 "visibility": "operator",
 "wall_time_utc": "2026-10-17T18:13:56.353Z"
}
```
### VERIFICATION_RESULT (verification.failed) then REPLAN
```json
{
 "asset_id": null,
 "causal_event_id": "ev_002056",
 "detail": {
  "attempt": 1,
  "checks": [
   {
    "id": "flow",
    "pass": false
   },
   {
    "id": "dp",
    "pass": false
   },
   {
    "id": "margin",
    "pass": true
   },
   {
    "id": "collateral",
    "pass": true
   }
  ],
  "key": "ver:ver_INC-001_1:rejected",
  "verification_id": "ver_INC-001_1",
  "window_s": 55.0
 },
 "event_id": "ev_002057",
 "evidence_ids": [],
 "incident_id": "INC-001",
 "message_type": "verification",
 "mission_id": null,
 "model_id": null,
 "model_provider": null,
 "phase": "failed",
 "recipient": null,
 "robot_id": null,
 "run_id": "run_t3",
 "schema_version": "communication.v1",
 "sender": {
  "class": "SENTINEL",
  "id": "ver_INC-001_1",
  "kind": "agent"
 },
 "seq": 2057,
 "sim_tick": 2260,
 "sim_time_ms": 1130000,
 "status": "failed",
 "subtype": "verification.failed",
 "summary": "Verification failed: Zone B flow 2.691 kg/s (needs >= 2.793); Segment dP vs design 2.921 x (needs <= 1.4)",
 "task_id": null,
 "thread_id": "INC-001",
 "visibility": "operator",
 "wall_time_utc": "2026-10-17T18:14:00.461Z"
}
```
```json
{
 "asset_id": "p_hs_b",
 "causal_event_id": "ev_002061",
 "detail": {
  "depth": 1,
  "key": "task:t_001_13:working",
  "task_kind": "replan"
 },
 "event_id": "ev_002062",
 "evidence_ids": [],
 "incident_id": "INC-001",
 "message_type": "task_transition",
 "mission_id": null,
 "model_id": "policy-engine-v1",
 "model_provider": "deterministic",
 "phase": "started",
 "recipient": null,
 "robot_id": null,
 "run_id": "run_t3",
 "schema_version": "communication.v1",
 "sender": {
  "class": "SENTINEL",
  "id": "t_001_13",
  "kind": "agent"
 },
 "seq": 2062,
 "sim_tick": 2260,
 "sim_time_ms": 1130000,
 "status": "warning",
 "subtype": "task.replan",
 "summary": "Replanning after a rejected repair: Replan after rejected repair",
 "task_id": "t_001_13",
 "thread_id": "INC-001",
 "visibility": "operator",
 "wall_time_utc": "2026-10-17T18:14:00.469Z"
}
```

## V11 additions
`contract.proposed|frozen|revised|evaluating|layer_a|layer_b|terminal|revision_refused`, `drift.detected`, `loop.detected` (stuck stage, repeat plan hash, no physical
progress, budget, revision cap) are records of the same stream. Definition-of-Done API: `GET /runs/{id}/incidents/{iid}/contract|verifications|team`,
`GET /runs/{id}/contracts`. See `docs/engineering/V11_DOD.md`.

Not verified: live Neon end-to-end of migrations 0007/0009 (tested on an embedded PostgreSQL via pgserver), browser rendering (Agent B), outbox relay across a
real process crash (restart re-delivery is covered by `since_seq` backfill + key reload, not by killing a process).
