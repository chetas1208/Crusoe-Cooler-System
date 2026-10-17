# LOOPKEEPER: 3-minute judged demo script (V11, "Done Means Done")

Written 17 Oct 2026 against the code and the live backend on `:8787` as they are today (read-only inspection). Items that depend on work
that is not finished or not lead-verified are marked `[PENDING: ...]`. Read section 0 before you rehearse: it changes what you may say.

## 0. Truth rules for this demo (read first)

1. **Say only what the screen shows.** Every claim below names the panel that proves it. If a panel is empty, say it is empty.
2. **What the prompt path really does today.** `POST /api/v1/scenario-requests` runs Laya -> Crusoe Nemotron -> deterministic compiler and then
   builds a *recorded 30:00 episode* (`scenarios/episode.py`, `agents=None`, fixed response script). The SEN-01..05 team, the frozen Definition
   of Done and the replan run on the **live run (`run_live`)** where the agent runtime is attached. They are two different runs.
   Bridge used in this script: after Segment 1 you inject the *same physical fault family* into the live plant through the engine's test
   command and say so out loud ("same fault, now on the live plant with the agent team attached").
   `[PENDING: lead] prompt -> scenario -> injection into the live run with the agent team (not wired as of this writing)`.
3. **Laya is advisory and weak.** Held-out eval (`artifacts/v11/laya_eval.json`, 36 test cases): Laya router raw accuracy 0.33, the labelled
   rule fallback 0.42; an unsafe-request override is deterministic code, not Laya. On a vague prompt Laya usually *abstains* and routes to
   `human_review`. That is the designed behaviour. Never say "Laya understood the request".
4. **First-repair-fails.** The signature flow (brush clears only part of a fouled pipe -> verifier rejects -> SEN-01 replans -> second action
   restores flow -> sustained checks held) is proven by `backend/tests/test_v11_dod.py` and `artifacts/v11/dod_signature_flow.json` with the
   deterministic drafter. `[PENDING: lead] signature flow executed live on Super-120B, verified` (checklist G1, last item). If it does not
   happen live, use Fallback B/C, do not narrate it as if it did.
5. **Terminal states.** PARTIAL / CONTAINED_NOT_REPAIRED / TIMED_OUT are derived in code and unit-tested but not yet produced end to end in a
   live run (V11_DOD.md "Known gaps"). Honest containment is only claimable if the Done panel actually shows it.
6. **The top-bar chip "Active (Autonomous Policy)" can mean the deterministic fallback.** Do not point at it as proof of a model. Use the
   Crusoe badge in the prompt result card and the model id in the status popover.
7. **Scorecard.** At last read, `artifacts/v11/scorecard.json` had the recursive DOD+delegation arm "NOT RUN". Do not claim it beats the
   baselines. `[PENDING: Agent E / lead]`.
8. Auth is off on the public tunnel (owner decision, `docs/deploy.md`): anyone with the tunnel URL can send commands. Share the web link only.

## 1. Cast, URLs, keys

| Thing | Value |
|---|---|
| Console (local dev) | `http://localhost:5173` (`pnpm dev:live`; proxies `/api` to `:8787`) |
| Console (public) | `https://your-app.vercel.app/?api=<tunnel origin>` (first visit stores the API origin in the browser) |
| Tunnel (changes on restart) | `cat .state/tunnel_url` (today `https://your-tunnel.trycloudflare.com`) |
| API base | `http://127.0.0.1:8787/api/v1` |
| Tabs / keys | `1` Dashboard, `2` Map, `3` Agents, `4` Execution; `Esc` closes launcher/panels; `Ctrl/Cmd+K` or `/` search |
| Open the launcher | top bar button **Simulate an incident** (right side) |
| Execution top strip chips | **Comms**, **Done**, **Team**, **Scenarios (9)**, **Runs**, **Details**, **Timeline**, **Hide All / Show All** |
| System popover | click the **LOOPKEEPER** logo (top left): data source, model id, checkpointer, speed x1/x2/x3, Engineering test controls |
| Playback | Execution > Details: Pause/Resume, **1x / 2x / 3x**, **Fork from Playhead**; mode switch **live / replay / branch** |

Vague prompt (type it, do not use the chips; chips auto-submit):
> `Something is wrong with the water near the middle racks, maybe overheating. Handle it.`

Fault injection for the live plant (use curl, not the UI menu: the menu's "Foul P-17" targets `p_17`, which does not exist in the v6 topology):
```bash
API=http://127.0.0.1:8787/api/v1
# fouling -> brush clears only part -> verifier rejects -> replan (the signature flow)
curl -s -X POST $API/commands -H 'content-type: application/json' \
  -d '{"command_id":"demo-foul-1","kind":"test.inject_fault","args":{"kind":"fouling","target":"p_hs_b"}}'
# single-step alternative (strainer swap resolves in one repair): UI = logo > Engineering test controls > "Clog S-02"
```
Use a fresh `command_id` every take. The command goes to the active live run only; stored runs and forks refuse it (409 read_only).

## 2. Shot list (3:00)

Time budget: inject the fault at **0:20** (while the prompt strip is finishing) and set **x2** from the logo popover so the live team has
about 2.5 minutes of plant time. Everything on screen after 0:25 is the live run unless stated.

### 0:00-0:25  Vague prompt, real classification, real model id, validated scenario
- **Screen:** Dashboard (`1`). Click **Simulate an incident**. Type the vague prompt. Click **Run Simulation (30:00)**.
- **Watch:** the step strip Received -> Classified -> Interpreted -> Scenario validated -> Running, each with a real latency
  (`laya NNN ms`, `crusoe N.N s`, `pipeline N.N s`) and the request id / run id. The result card shows
  `Laya: <family> (conf x.xx, N ms)`, `Crusoe: nvidia/NVIDIA-Nemotron-3-...`, `Target: <resolved asset ids>`, the assumptions and the compiled
  Definition-of-Done invariants. The modal then closes and the app jumps to Execution (`4`).
- **Say:** "A vague sentence. Laya, a small router, gives an advisory family and here it abstains to human review, which is correct for this input.
  Crusoe Nemotron turns it into a typed scenario proposal. A deterministic compiler resolves 'middle racks' to real asset ids and refuses anything
  outside the plant. No model output reaches the plant without that compiler."
- **At 0:20:** run the curl injection above (second terminal, pre-typed) and say: "I now inject the same fault family on the live plant where the
  agent team is attached."
- **If slow:** the strip shows real elapsed time; narrate the stage it is on. If a stage fails, the strip shows `Failed at <stage>: <message>`:
  read it aloud, then go to Fallback B. Do not retry silently.

### 0:25-0:55  Frozen Definition of Done
- **Screen:** Execution (`4`), selected run = **Live baseline**. Click **Done** (right rail panel "Definition of Done") then **Comms**.
- **Watch:** lifecycle PROPOSED -> VALIDATED -> FROZEN, revision `v1`, each check with state PASS / FAIL / UNKNOWN, measured value, threshold,
  hold timer (how long the check has held continuously), evidence links.
- **Say:** "SEN-01 on the 120B model drafted the contract. The compiler checked ids, units and allowlisted check types, then froze it with a hash
  before any repair was chosen. Thresholds come from plant configuration, not from the model. Done means these checks held for the hold period."
- **Proof to point at:** the revision label and `FROZEN`; a Comms row `dod.contract` (click it: Detail shows the source event).
- **If slow:** the Done panel says "has not published a Definition of Done" until SEN-01 returns; talk through the lifecycle strip and the
  Crusoe latency from the status popover (one deep-tier call is about 2-5 s; the earlier measured reconcile took 4.6 s and, in another run, 17-24 s).

### 0:55-1:30  SEN-02/INPIPE and SEN-03/OUTRIG delegation with real messages
- **Screen:** click **Team**; keep **Comms** open. Optionally press `3` for the delegation graph, `Esc` to return.
- **Watch:** SEN-01..05 seats, task DAG with parent links and robots as children, budgets; Comms rows `TASK_ASSIGN` / reports from SEN-02 and SEN-03,
  an INPIPE crawler and an OUTRIG rover taking tasks. Use the Comms filters to show only SEN-02 / SEN-03, click a row for the full envelope.
- **Say:** "SEN-02 coordinates in-pipe crawlers, SEN-03 the exterior rovers. These are real envelopes from the event log, not narration. Models
  decide at boundaries; routing and motion are deterministic and never wait on a model. SEN-04 checks every action again at the engine commit."
- **Honest note:** depth <= 3, <= 6 active LLM subtasks, <= 2 concurrent deep calls, <= 2 plan revisions are enforced limits shown in the Team panel.

### 1:30-2:05  First repair fails, SEN-05 rejects, SEN-01 replans
- **Screen:** Done panel + Comms (filter: verification / SEN-05).
- **Watch:** after the brush repair a check goes FAIL (flow below threshold or dP above) while the hold timer resets; SEN-05's Layer-B review row
  (`dod_review`) rejects or requests replan; the contract shows a **revision v2 with a reason** and never a looser threshold; SEN-01 issues a new plan
  (replace section / reroute).
- **Say:** "The proposer cannot verify itself. Layer A re-measures the solver, not the agent's claim. SEN-05 reviews in an isolated context and
  cannot force a pass. SEN-01 may revise only by version bump and never by loosening a check."
- **If it does not fail:** say "this run's first repair held; the reject path is shown in the recorded run" and go to Fallback B for 20 s. Do not say it failed.

### 2:05-2:35  Recovery or honest containment
- **Screen:** Done panel terminal row, then `1` Dashboard for flow / thermal margin, `2` Map for the robots (optional).
- **Watch:** checks turning PASS and their hold timers filling; terminal state badge (`VERIFIED`, or `ESCALATED`/`FAILED` if it did not recover).
- **Say (recovery):** "Flow restored and held for the full hold window: VERIFIED."
  **Say (not recovered):** "It did not recover inside the window. The system says ESCALATED, with the reason, and frees the incident. That is the point:
  it never repaints a failure green."
- **Never say** CONTAINED_NOT_REPAIRED unless the badge says it (see rule 5).

### 2:35-3:00  Neon evidence, replay, costs, scorecard
- **Neon:** logo popover shows `Checkpointer: postgres`; show Neon console SQL (second tab, saved queries below) for rows in `done_contracts`,
  `agent_communications`, `verification_runs`, `agent_tasks`/`agent_messages` `[PENDING: Agent B/C - confirm table names after migration]`.
- **Replay:** Execution > mode **replay**, drag the Timeline playhead before the incident; Comms replay endpoint reports `model_calls: 0`
  (decisions are frozen; replay never calls a model). Optional **Fork from Playhead** (forks are read-only today).
- **Costs:** `[PENDING: Agent C]` a per-run model-calls / cost view does not exist in the UI today. Use the evaluation spend line from
  `artifacts/v11/scorecard.json` (`spend`: model network calls and USD) and say it is the evaluation spend, not this run's.
- **Scorecard:** `[PENDING: Agent E / G4]` scorecard view. Show `artifacts/v11/scorecard.json` or the rendered view if shipped. Quote only fields
  you can read on screen: manifest sha256, 9 scenarios x 10 held-out seeds, arms no_action / static / single_pass, `false_success`, replay
  determinism (180 of 180 identical, 0 network model calls during replay). The recursive arm: quote the file's status text verbatim if still "NOT RUN".
- **Say:** "Everything you saw is an event in Neon; replay re-reads it. Our evaluation counts a run as verified only if the claim and the physics agree.
  False success is the number we care about; here is what we measured and here is what is still not run."

## 3. Saved Neon queries (read-only)

```sql
select count(*) from agent_communications where run_id = 'run_live';
select incident_id, version, state, terminal_state, frozen_hash from done_contracts order by created_at desc limit 5;  -- [PENDING: confirm columns after migration 0009 is applied]
select count(*) from world_events where run_id = 'run_live';
```

## 4. Fallbacks (decide in rehearsal, announce them to the judges)

- **A. Live model slow (> 8 s on a deep call):** keep talking over the real latency in the status strip / Comms row; the gateway has backoff,
  a circuit breaker and a labelled deterministic fallback. If the UI says fallback, say "the deterministic policy is acting, not the model".
- **B. Replay of a good rehearsal run:** Execution > Runs > `[PENDING: lead: rehearsal run id]` > mode **replay**; say "this is a recording of a live run
  at HH:MM, replayed from Neon with frozen decisions". Never present it as live.
- **C. Video:** the 1-minute video (section 6) or the full recording from `scripts/demo/record_checklist.md`.
- **D. Backend down:** `scripts/supervise.sh status|start`; the console falls back to an embedded simulator labelled MOCK. Never demo in MOCK;
  state it if it happens.

## 5. Pre-flight (T-60 min, T-10 min)

1. `scripts/demo/preflight.sh` (add `--spare` once) -> must print `GO`. FAIL lines and their meaning:
   DOD route 404 = backend predates the V11 code: restart (`scripts/supervise.sh stop && scripts/supervise.sh start`), then re-run.
2. No open incident on the live run (WARN otherwise; resolve or let the guard escalate it). `[PENDING: lead] a clean live run / reset path`.
3. `.state/tunnel_url` reachable; Vercel page loads; the API origin stored in the browser matches the tunnel.
4. Model: popover shows the Super-120B in `MODEL_NAME_DEEP` and `Online`; `fallback_active=false`.
5. Browser: Chrome, 1920x1080, zoom 100 %, hardware acceleration on (the 3D view needs WebGL2), no extension popups, notifications off.
6. Dry run the curl with a throwaway `command_id` only on a rehearsal take, never before the judged run.
7. Open tabs in this order: console, Neon SQL editor, `artifacts/v11/scorecard.json`, a terminal with the curl pre-typed.
8. Two minutes of silence at the start is fine; start the timer on the first click of **Simulate an incident**.

## 6. One-minute video storyboard (screen capture + voice-over, no music needed)

| Sec | Visual | Voice-over (about 150 words total) |
|---|---|---|
| 0-6 | Dashboard, glass pipes flowing, title card "LOOPKEEPER: done means done" | "AI agents say 'fixed'. Who checks?" |
| 6-16 | Launcher: vague prompt typed, step strip with latencies, Laya + Crusoe badges | "A vague sentence becomes a validated scenario: Laya triage, Nemotron interpretation, a deterministic compiler." |
| 16-26 | Done panel: contract FROZEN, checks with hold timers | "Before any repair, the agent writes an executable definition of done. The compiler freezes it." |
| 26-38 | Team + Comms: SEN-02 / SEN-03 delegating to crawler and rover | "Coordinator agents delegate to in-pipe and exterior robots. Every message is a real event." |
| 38-48 | A check turns FAIL, SEN-05 rejection, revision v2 | "The first repair is not enough. An independent verifier rejects it. The planner revises, never loosening the bar." |
| 48-56 | Terminal state badge, replay scrub, Neon tables | "Done is measured, held, and replayable from Neon without calling a model." |
| 56-60 | Repo URL, "Crusoe Nemotron, Neon, LangGraph, Laya, pandapipes, MuJoCo" | "Open source. Honest limits in the README." |

Use a recorded successful take for the video only if the footage is a real run; caption it with the run id. Record each beat separately and cut,
but never splice a fail from one run with a pass from another without a caption.
