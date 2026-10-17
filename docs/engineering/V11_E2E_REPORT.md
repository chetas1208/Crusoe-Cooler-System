# V11 end-to-end browser verification (Agent H)

Run on 17 Oct 2026, 22:20 to 23:25 UTC, against the live stack: web `http://localhost:5173`, API `http://localhost:8787` (auth off, Neon-backed `run_live`, real Crusoe models).
Driver: `scripts/e2e/full_flow.mjs` (Playwright, Chromium 1243, SwiftShader software GL, 1440x900 plus one 390x844 pass).
Evidence: `artifacts/e2e/desktop/` and `artifacts/e2e/mobile/` (screenshots, `results.json`, `scenario_request_record.json`).
No app code was edited and `:8787` was not restarted.

Mutations made on `run_live` (disclosed): one prompt, which injected THREE faults (see D6; the target was one), and a 6 s API-level drive of OR-02 (moved 6.0 m, then driven back; robot is IDLE, not docked). One failed fork attempt created no run.

## Results

| Step | Verdict | Evidence |
|---|---|---|
| S1 load, four tabs, LIVE badge, model status | PASS | All four tabs rendered (`01_tab_*.png`). Top bar shows LIVE and NEMOTRON LIVE. `/models/status`: `status=live, online=true, fallback_active=false`, 313 ms. Zero console errors at 1440x900 (`S1b`). Caveat: the model chip flips to AUTONOMOUS POLICY whenever the stream is STALE (D1). |
| S2 vague prompt to live run | PASS (with defects D3, D6) | Prompt: "a GPU row is getting hot and the water feels wrong; sort it out". Request `req_8a3ed27d1269` was READY/RUNNING. The Execution status strip showed Received 580 ms, Classified 2.5 s, Interpreted 13.5 s, Scenario validated 13.5 s, Running 16.3 s, with request id, `laya 1.0 s`, `crusoe 10.8 s`, `pipeline 14.7 s`, model id and `run run_live`, then `injected fouling -> p_hs_c`, `strainer_blockage -> strainer_02`, `sensor_drift -> sn_flow_zc`, `incident: pending` (`09_after_prompt_exec_tab.png`). The record then linked INC-028. Laya abstained (family overheating, conf 0.327, 1009 ms). Nemotron-3-Nano proposal and compiler resolved `p_hs_c, strainer_02, sn_flow_zc` plus three DoD invariants. |
| S3 Communications panel | PASS with defect D5 | Rows are ordered by seq in the API (ascending) and by time in the DOM (monotonic). The API kinds for `run_live` include TASK_ASSIGN 5, ACK 5, REQUEST_TOOL 224, TOOL_ACCEPTED 248, VERIFICATION_REQUEST 8, VERIFICATION_RESULT 15, REPLAN 1, HUMAN_OVERRIDE 9, MODEL_ERROR 15 and more (`kind_counts_api`). Filters work: SENTINEL 1175, OUTRIG 129, Tools 513, Failures 22, Operator 12, INPIPE 12 (of about 1320). Close and reopen x3: closed and reopened every time, filter and count kept, ingestion continued. Detail view shows seq, event id, caused-by, thread, task, structured JSON. The "Seek timeline to tick" button exists. On the live run it only says it can jump while the run is open in replay (honest, no jump). |
| S4 Definition of Done | PASS | INC-028 (pump degradation): FROZEN v1, drafted by SEN-01 on Super-120B in 3966 ms, checks `head >= 96 %` and `vib <= 2.8 mm/s`, hold 30 s, both PASS with hold timers (24 s / 22 s), Layer B concur from Super-120B, terminal VERIFIED. Six contracts so far in `run_live`: INC-028, 032, 036, 042, 044 VERIFIED, INC-049 ESCALATED. The panel shows ESCALATED, "WHY NOT DONE YET: Run ended as escalated; not verified", and a check at UNKNOWN (`mobile/06_m_panel_Done.png`). INC-036 needed two attempts (attempt 1 Layer A PASS, Layer B `request_replan`). No contract was ever FAIL or revised (v1 only, 0 revisions): the first-repair-fails flow was not observed live. |
| S5 Team panel | PASS | SEN-01..05 all shown with task counts (SEN-01 9 tasks, SEN-03 1, SEN-04 1, SEN-05 1, SEN-02 none). Limits line "depth 2/3 - llm tasks 9/6 - plan revisions 1/2" (D7). An OUTRIG task "Service TCS-PMP-1, OUTRIG OR-06/OR-08, 9 tool calls" is listed. No INPIPE task occurred in this incident (SEN-02 "no tasks"). |
| S6 Map: select OUTRIG, ghost preview, Take Control | FAIL (blocked by D1) | OR-01 selected. Ghost preview is labelled "GHOST PREVIEW MODE ... Authoritative Robot Unchanged", traveled 4.8 m, server pose unchanged (0.000 m) (`13_map_preview_after_keys.png`). Take LIVE Control: the lease was granted (epoch 1) but dropped within seconds ("Link lost. Safety stop", SAFE HOLD, `last_reason: link_lost`), or refused with "The live stream is not connected" (`61_map_live_control.png`). Cause: STALE stream (D1). |
| S6b drive path at API level | PASS | Same lease/drive endpoints as the UI. Lease OR-02 (epoch 1, deadman 1500 ms), 8 of 8 drive intents accepted, `GET /robots/OR-02` pose x 21.6 to 15.6 (moved 6.002 m, server-authoritative), authority HUMAN/MANUAL while leased. Release returned AUTO. The first run's release got HTTP 422 because my script omitted `idempotency_key` (script bug, fixed). A second run drove back with a clean release. |
| S7 Agents tab | PASS | SEN-01..05 cards with status ("working", "oversees all 18 robots", "owns IR-01..IR-10", "owns OR-01..OR-08"), SENTINEL 4 active / 24 blocked / 378 done / 16 failed, Laya panel (triage accuracy 40.0 %, p95 494 ms, abstention 66.7 %). API graph: 508 nodes, 689 edges (`10_agents_tab.png`). |
| S8 replay scrub + fork (stored run) | FAIL (D2) | Replay badge shows. Replay comms endpoint `model_calls: 0`, no future leak. Parent `head_hash` unchanged. But the timeline errors with "Cannot read properties of undefined (reading 'toFixed')", scrub stays at tick 0, and Fork says "no checkpoints yet" despite 36. |
| S8b fork from live run | FAIL (D4) | UI warning: "restored state hash differs from the recorded one; refusing to fork". No child created. Parent kept running. |
| S9 scorecard chip | PASS (partial) | Scorecard opens. API manifest sha256 `489b96a1441c6318...`, 9 scenarios x 10 seeds, arms `no_action, static, single_pass` (the recursive arm is still not in the file). |
| Mobile 390x844 | FAIL | No horizontal overflow, composer opens, Done/Team/Scorecard panels reachable as bottom sheets. But React console errors (hooks order, duplicate keys `inc:INC-027/028/029`, `vf:ver_INC-028_1`) and a garbled stacked first load of the Execution tab (D8). |

## Numbers

- Time to first model call after submit: Laya answered at about 1.0 s (classified at 2.5 s). The first Crusoe call (Nemotron-3-Nano scenario interpretation) started about 2.5 s after submit and took 10.8 s. The prompt pipeline totalled 14.7 s (`latencies_ms`: laya 1011, crusoe 10794, inject 2333, compile 2). The first Super-120B call (SEN-01 DoD draft) took 3966 ms.
- Tokens, scenario request: 499 in / 440 out.
- Tokens, whole session (`/health/ready` intelligence, started at 31 in / 6 out): 188 calls, 17 failures, 11 invalid outputs, 94,693 in / 15,492 out. No dollar cost is exposed by any endpoint, so I cannot state a cost.
- Crusoe 503s: about 17 provider 503s plus 3 schema rejections, each labelled "deterministic fallback used" in Comms. INC-049's contract was drafted on the fallback and ended ESCALATED.
- Stream: node WebSocket probe, 60 s. At x24 speed: max gap 6.4 s (2 gaps over 5 s). At x3: max gap 8.4 s, p95 7.4 s (5 gaps over 5 s). No `heartbeat` events.
- Browser: whole-script step times were large (S3 118 to 135 s) because SwiftShader renders the 3D scene on the CPU. UI latencies below are an upper bound.

## Defects

| # | Owner | Defect | Evidence |
|---|---|---|---|
| D1 | Backend (A) | The WS stream is silent for more than 5 s and sends no heartbeats, so the UI flips to STALE constantly. STALE blocks Take Control (`control/session.ts:152`) and drops an active lease with a safety stop (`session.ts:200`). A reported the engine heartbeat period was 10 s and is now 2.0 s in code, needing an API restart to apply. Re-probe after restart. | `61_map_live_control.png`; WS gap probe numbers above. |
| D2 | Frontend (B) | Replay of a stored run throws `toFixed` of undefined, leaves empty tracks, and refuses to fork with "no checkpoints" although Details lists 36. | `66_replay_scrubbed_60pct.png`, `69_after_fork.png` |
| D3 | Frontend (B) | The scenario launcher modal shows "Total: 0 ms" (actual 14675 ms). | `08_prompt_status_2.png` |
| D4 | Backend (A) | Fork from the live playhead is refused: "restored state hash differs from the recorded one". | step S8b in `results.json` |
| D5 | Frontend (B) | Comms feed renders 0 rows for 1 to 5 s after reopen and for more than 8 s after switching to INPIPE (count says 12). Possibly CPU-bound under SwiftShader. | `results.json` S3 `reopen`, `filters` |
| D6 | Backend / lead | One vague prompt injected three faults (fouling, strainer_blockage, sensor_drift; per-request cap is 3). Two were defaults the user never named (`strainer_02`, `sn_flow_zc`). Each fault opened or fed incidents INC-028 to INC-049 within an hour. | `scenario_request_record.json` |
| D7 | Backend (A) | Team panel limits line reads "llm tasks 9/6", above its own cap of 6. | `08_team_panel.png` text |
| D8 | Frontend (B) | Mobile console errors (hooks order, duplicate React keys), and stacked panels on first load of Execution. | `mobile/results.json`, `mobile/04_m_Execution.png` |
| D9 | Frontend (B) | The live-timeline notice says "this backend recorded no world frames" while `/runs/run_live/replay` reports 161 frames. Wording is misleading. | `57_comms_after_jump_to_tick.png` |
| D10 | Docs | `DEMO_SCRIPT.md` says the prompt path builds a recorded episode and the live injection is "not wired". It is now wired (D6 shows it). The Total field in the modal is wrong (D3). The first-repair-fails flow did not happen in this run. | |

Also observed, not defects: the launcher modal strip (Received, Classifying, Interpreting, Compiling, Creating, Running) has no latencies. The real strip with latencies is on the Execution tab. One comms event has no `kind` field.

## Owner hypotheses (Agent A, not verified by H)

- D4: probably version skew. The snapshot-state change (contracts now carried in `Tracking.to_state/load_state`) makes a snapshot written by older code restore to a different hash. Check by forking a snapshot taken after the restart. If that also fails, look at the `state_doc` and `load_state_doc` symmetry in `engine/core.py` and `SNAP_KEYS_EXCLUDED_FROM_HASH`.
- 503s: the per-call fallback is labelled by design; `fallback_active` is run-level only. The inference gateway (backoff and breaker) is not yet the DecisionService client, which is the real fix.
- Comms event with no `kind`: legacy `communication.v1` rows from before the envelope change still sit in `run_live` in Neon.
