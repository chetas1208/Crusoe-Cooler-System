# Recording checklist (3-minute demo + 1-minute video)

Run `scripts/demo/preflight.sh` first. Do not record while it prints NO-GO unless you are recording a known-limit shot on purpose (and say so in the caption).
Script: `docs/submission/DEMO_SCRIPT.md`. Honest-captions rule: every clip that is a replay, a rehearsal run or a unit-test artifact says so on screen.

## Before you press record
- [ ] Backend restarted AFTER the final V11 code landed (DOD route returns 200); `git rev-parse --short HEAD` noted: `________`
- [ ] Working tree state noted (uncommitted work changes what the demo shows): `git status --short | wc -l` = `____`
- [ ] Live run clean: no open incident (`GET /api/v1/incidents` all resolved/escalated/dismissed), plant health nominal
- [ ] Model: `/models/status` live, `fallback_active=false`, deep tier = Super-120B; spend ceiling not hit (gateway budget)
- [ ] Laya status `laya_router`; note that it will probably abstain on the vague prompt (expected)
- [ ] Neon reachable (`database: ok`, checkpointer `postgres`); Neon console SQL editor logged in, saved queries ready
- [ ] Tunnel URL current; Vercel API origin updated if the tunnel changed
- [ ] Browser: Chrome, 1920x1080, 100 % zoom, WebGL2 on, bookmarks bar hidden, notifications / DND on, no other windows visible
- [ ] Secrets hidden: no `.env`, no API keys, no connection strings on screen (Neon console: hide the connection string panel; blur the org name if needed)
- [ ] Terminal font 18 pt, the curl pre-typed with a fresh `command_id`; `API` variable set
- [ ] Recorder: 1080p 30 fps, system audio off, mic test (clap), record the whole screen, not a window (so popovers are captured)
- [ ] Sim speed set to x2 from the logo popover (not higher; x3 hides the hold timers)

## Take protocol
1. Start recorder. Wait 5 s on the Dashboard (clean plant).
2. Segment 1 (prompt) live. At 0:20 fire the curl. Note the wall-clock time `__:__:__` and the run id from the strip: `________`.
3. Do not cut during live model waits; cut afterward and keep the real latencies visible (they are the proof).
4. Segments 2-6 per script. Capture each Done-panel state change at full resolution (the check state, measured value, threshold and hold timer must be legible).
5. After the take: `GET /api/v1/runs/run_live/contracts`, `GET /api/v1/runs/run_live/incidents/<id>/team`, and save the JSON next to the video
   (`artifacts/v11/demo_take_<n>_*.json`; `artifacts/` is gitignored, keep it for the evidence folder, not the public repo).
6. Record the terminal state the take ended in: `VERIFIED | ESCALATED | FAILED | other: ____`. Caption the video with exactly that.

## Shots that must be real (no composite)
- [ ] Prompt strip with all five steps and real latencies
- [ ] Crusoe model id badge on the scenario result card
- [ ] Frozen contract (FROZEN + revision label)
- [ ] A Comms row from SEN-02 and one from SEN-03, opened to the detail view
- [ ] A FAIL check and the SEN-05 row, if (and only if) it happened on this take; otherwise record it as a replay with a caption
- [ ] Terminal state badge
- [ ] Replay scrub with `model_calls: 0`
- [ ] Neon rows

## Post
- [ ] Captions: run id, date, "live" or "replay of run <id>", "deterministic fallback active" if it was
- [ ] Remove any frame showing keys, tokens, or personal email addresses
- [ ] Export 1080p MP4 (<= 100 MB), 60 s version and 3 min version; upload; paste links into `docs/submission/SUBMISSION_FORM.md`
- [ ] Re-watch once at 1x with sound off: every claim legible from the screen alone
