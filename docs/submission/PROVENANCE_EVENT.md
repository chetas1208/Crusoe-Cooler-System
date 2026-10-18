# Provenance: pre-existing work vs work new in the event

Prepared 17 Oct 2026 from the private repository's git history (`git log`, UTC author dates), `PROGRESS.md`, `DECISIONS.md`,
`docs/engineering/HACKATHON_BUILD_LOG.md`, `docs/engineering/V11_CHECKLIST.md` and the public export's `docs/PROVENANCE.md`.
This is an evidence table, not a ruling: **the official event start time is not recorded anywhere in the repo.** See section 2.

## 1. History at a glance (private repo, 36 commits, all UTC; PDT = UTC-7, so event deadline 00:00 UTC 18 Oct = 17:00 PDT 17 Oct)

| Group | Commits (UTC) | What it contains | Size | Status |
|---|---|---|---|---|
| G1 | 1 commit `e04cb04`, 15 Oct 10:36 | First commit: web console, iOS app, shared 3D scene, embedded simulator, mock API | +28,160 lines, 185 files | **Pre-existing** under every reading |
| G2 | 5 commits, 16 Oct 17:35-18:38 (`17ff37b` .. `e071e87`) | Python backend (pandapipes + CompOpt physics, single-writer engine, agent loop, Crusoe client, Neon storage), four-tab frontend, 16-rack facility, Vercel config, tunnel/supervisor, V4 spec | +43,777 / -1,066, 260 files | **Pre-existing** under every reading (16 Oct) |
| G3 | 4 commits, 16 Oct 18:56-23:48 (`a7213b2` .. `8c51e96`) | Auth-off note, V6 layout spec, topology-driven hall frontend, PROGRESS/DECISIONS | +6,448 / -1,297, 81 files | **Pre-existing** (16 Oct) |
| G4 | 19 commits, 17 Oct 02:04-17:53 (`746e0a4` .. `ea30ba5`) | V6 five-row hall + OUTRIG traffic + MuJoCo cell, Laya classifier (first commit `746e0a4`), V7 navigation/streaming, V8 nine-scenario Crisis Lab, dual Neon, V9 natural-language launcher + compiler (`cfdf9a8`), Playwright E2E scripts, supervise.sh, V10 comms/mobile spec (`ea30ba5`) | +24,002 / -984, 249 files | **AMBIGUOUS** (see 2) |
| G5 | 7 commits, 17 Oct 18:13-21:09 (`6f2aa9c` .. `3a48565`) after baseline `ea30ba5` | V11 checklist; Crusoe tiered client (`4bd79cf`); `fcefdad` (titled "fix(ui) ..." but it also adds `comms/`, `inference/gateway.py`, `orchestration/dod.py`, `graphs/dod_nodes.py`, `eval/laya_bench.py`, migrations 0007-0009); V11 baseline doc; communications / DOD / team panels and prompt-status strip (`3a48565`) | +8,267 / -332, 118 files | **New in event** under every reading |
| G6 | uncommitted working tree at time of writing (39 paths) | `api/routes_dod.py`, `eval/{arms,fixtures,runner,sim}.py`, `memory/*`, migration `0010_shared_brain.sql`, scorecard UI, responsive/mobile UI, `V11_DOD.md`, `V11_EVAL.md`, tests | not committed | **New in event**; must be committed before the repo is submitted |

Caveats that make any single date unreliable:
- **Commit date is not authoring date.** `HACKATHON_BUILD_LOG.md` says V4/V5 work done on 16 Oct was still uncommitted at 18:56 UTC and landed in bundled commits afterwards; the 17 Oct 02:04 commit (`746e0a4`, "Backend V6") also carries the V5 Laya/robotics work (DECISIONS 54 records that a second coding tool edited the same tree). Treat G4 commit times as upper bounds for when the work was done.
- `fcefdad`'s message understates what it contains (see G5). Cite file first-add dates, not commit titles.
- Git dates are self-reported and rewritable; the maintainer retains the full private history and a bundle (per the public `PROVENANCE.md`).
- Development was AI-assisted (the build log lists "Pair Autonomous Agent + Human Engineer"; DECISIONS 54 names a second tool). State that in the form.

## 2. The ambiguity: three inconsistent cut lines are already in the repo

| Source | Cut line | Implies "new in event" starts at |
|---|---|---|
| Public export `docs/PROVENANCE.md` | "work listed in PROGRESS.md sections dated 17 October 2026 and later (V6 layout and later)" | G4 onward (17 Oct, from 02:04 UTC) |
| `V11_CHECKLIST.md` / `V11_BASELINE.md` | baseline SHA `ea30ba5` (17 Oct 17:53 UTC = 10:53 PDT) | G5 onward (V11 only) |
| `HACKATHON_BUILD_LOG.md` | `e071e87` (16 Oct 18:38 UTC): "NEW (V4, this session, not pre-event)" after it | G3 onward (V4/V5/V6...) |

Also, the public export was cut at `8ad9aec` (17 Oct 18:19 UTC), so it does **not** contain `fcefdad`, `2281771` or `3a48565` nor any G6 work, and its README still lists the
communications panel and DOD contracts as "in progress". `[PENDING: lead]` re-export the public repo from the final private commit before submission.

If the event window is "17 Oct, calendar day" in UTC, G4 is new; if it is 17 Oct in Pacific time (07:00 UTC), commits before 07:00 UTC (`746e0a4` 02:04 .. V7 kickoff 06:33) are pre-event and `2d48fb8` (V8, 08:13) onward is new;
if the baseline is `ea30ba5`, only V11 is new. **Action `[PENDING: user]`: paste the organiser's official start timestamp and rule wording here, then pick one row.**
Until then the submission form uses the conservative reading (only V11, G5-G6, is claimed as new work; everything earlier is described as the pre-existing platform, "continued during the event window").

## 3. Event-eligibility table (conservative reading: baseline `ea30ba5`)

| Capability | Pre-existing (before `ea30ba5`) | New in event (V11) | Evidence |
|---|---|---|---|
| Physics (pandapipes hydraulics, CompOpt thermals, faults, sensors) | yes (16 Oct; five-row v6 hall 17 Oct, G4 ambiguous) | no change claimed | git log G2/G4 |
| Single-writer engine, leases, replay/fork, robots, navigation, MuJoCo cell | yes (G2/G4) | no | G2/G4 |
| Four-tab web console, 3D scene | yes (G1-G4) | direct 3D rendering and quality-tier watchdog (`fcefdad`, `28180da`) | G5 |
| Crusoe client, Neon storage, LangGraph checkpointer, dual Neon | yes (G2, G4; checkpointer resume re-verified in V11 G0) | model tiers by decision kind, thinking off, seed, env aliases (`4bd79cf`, `2281771`) | G5, checklist G0 |
| Laya classifier (advisory) | yes (first commit `746e0a4`) | held-out benchmark `eval/laya_bench.py`, `artifacts/v11/laya_eval.json` (151 hand-written cases, 48 held-out) | G5 |
| Natural-language launcher, scenario compiler, nine scenarios | yes (V8/V9, G4; ambiguous) | prompt-status strip with real latencies (`3a48565`) | G4/G5 |
| Five SENTINEL supervisors + INPIPE/OUTRIG mission agents (v5 baseline) | yes in earlier form | role differentiation, task DAG, bounds, team panel | `V11_BASELINE.md`, G5/G6 |
| Executable Definition of Done: compiler, freeze, Layer A, SEN-05 Layer B, terminal states, loop/drift guards | no | `orchestration/dod.py`, `graphs/dod_nodes.py`, `api/routes_dod.py`, migration 0009, `tests/test_v11_dod.py` (built; lead verification of the live signature flow `[PENDING: lead]`) | G5/G6, `V11_DOD.md` |
| Agent Envelope Protocol, communications as canonical events, comms panel | spec only (V10 doc `ea30ba5`) | `comms/`, migration 0007, panel (`fcefdad`, `3a48565`); outbox/DAG/dup-actuation items `[PENDING: Agent B]` per checklist G2 | G5 |
| Model gateway (budget, backoff, circuit breaker, `model_calls`) | no | `inference/gateway.py`, migration 0008; DecisionService not yet using it `[PENDING: Agent C]` (V11_DOD known gaps) | G5 |
| Shared brain / memory | no | `memory/*`, migration 0010 (untracked); `[PENDING: Agent D]` verification, memory ON/OFF ablation is stretch | G6 |
| Evaluation harness, 9 scenarios x 10 held-out seeds, scorecard | no | `eval/*`, `artifacts/v11/{eval_manifest,scorecard}.json` (`artifacts/` is gitignored: ship the evidence another way); recursive arm "NOT RUN" at last read `[PENDING: Agent E / lead]` | G6 |
| Mobile shell, scorecard view | no | `features/responsive/*`, `features/scorecard/*` (untracked) `[PENDING: Agent F-UI / lead]` | G6 |

## 4. Honest flags (do not paper over)

1. Event start is undefined in the repo (section 2). Three documents disagree.
2. The checklist baseline puts V8/V9 (17 Oct 08:13-09:58 UTC, i.e. 01:13-02:58 PDT) outside the event. If the organisers count 17 Oct UTC as event time, those become event work and the form may claim more; if they count work that began on 16 Oct as pre-event, the form claims less. Do not claim either until the rule is read.
3. `DECISIONS.md` 54: a second tool edited the same working tree; parts of V5 were "kept but treated as unverified". The Laya classifier and robotics code come from that window.
4. Public export lags the private repo (cut at `8ad9aec`). Its README says "351 passed" and the comms/DOD panels "in progress": re-check those numbers after re-export.
5. `fcefdad` mislabels a large V11 backend drop as a UI fix. Reviewers reading `git log --oneline` will not see V11 backend work; point them to file first-add dates (this doc).
6. `artifacts/` is in `.gitignore`: the evidence JSON (`scorecard.json`, `laya_eval.json`, `dod_signature_flow.json`, `eval_manifest.json`) is not in any commit or the public export. Either un-ignore a curated copy under `docs/submission/evidence/` or attach it separately `[PENDING: lead]`.

## 5. Third-party notices cross-check

Sources: `THIRD_PARTY_NOTICES.md` (private and public copies identical), `docs/engineering/upstreams.md`, `backend/pyproject.toml`, `apps/web/package.json`,
licenses read from `.references/<repo>/LICENSE`, from installed `backend/.venv/.../*.dist-info/METADATA`, and from installed `node_modules` package.json (all read 17 Oct 2026).
"Verified" = the license text/metadata was read locally. "Unverified" = relies on memory or an upstream claim.

### 5a. Upstreams (reference clones)

| Component | Role | License | Verification | Listed in THIRD_PARTY_NOTICES.md? | In upstreams.md? |
|---|---|---|---|---|---|
| pandapipes (`e2nIEE/pandapipes`, 0.15.0 installed) | hydraulics | BSD-3-Clause | Verified: `.references/pandapipes/LICENSE` (redistribution clauses) + METADATA "BSD License" | **No** (only says "planned") | Yes |
| CompOpt (`HewlettPackard/compopt`, 0.1.0 editable) | chip/coolant thermals via public classes (`thermal_compopt.py` imports `compopt.physics.*`) | MIT | Partially verified: `pyproject.toml` + README badge + METADATA say MIT; **the clone has no LICENSE file** at its top level. Unverified as a text | **No** | Yes, but wording "Adapted deterministic algorithms" is inaccurate (code imports the library, not adapted code) |
| LangGraph (`langchain-ai/langgraph`, 1.2.15) | agent graphs, checkpointing | MIT | Verified: LICENSE "(c) 2024 LangChain, Inc." + METADATA | No | Yes (copyright line says 2023-2026 Harrison Chase: does not match the LICENSE file, fix) |
| MuJoCo (`google-deepmind/mujoco`, 3.16.0) | workcell physics, inline procedural MJCF (`ROBOT_XML`) | Apache-2.0 | Verified: LICENSE + METADATA | No | Yes |
| Laya (`NandhaKishorM/laya`, commit `4ac226d`, v0.4.8) | advisory triage router | Apache-2.0 (SDK) | Verified for the SDK: LICENSE + `pyproject.toml`. **Checkpoint weights (`convaiinnovations/laya` on Hugging Face) license: unverified** | No | Yes (copyright "Convai Innovations / Nandha Kishor M": unverified) |
| Crusoe Developer Hub (`crusoecloud/crusoe-developer-hub`) | reference only | MIT | Verified (LICENSE "(c) 2026 Crusoe AI") | No | Not listed |
| MuJoCo Menagerie, MuJoCo-Example-Manipulation | **claimed in upstreams.md section 5 as used** | Menagerie: per-directory licenses; Example-Manipulation: MIT | LICENSE files read. **No code or asset in the repo references them** (`grep` finds only docs): the "Role" claim in upstreams.md overstates. Remove or mark "studied, not used" | No | Yes (overstated) |
| thermaloop (`Walla17x/thermaloop`) | reference clone only | MIT (LICENSE read) | Verified; not used in code | No | No |
| Nemotron-3-Nano-30B-A3B / Super-120B-A12B | hosted via Crusoe API, weights not redistributed | NVIDIA model license | **Unverified** (not read from a source in this repo) | n/a | named only |

### 5b. Python dependencies (`backend/pyproject.toml`, licenses from installed METADATA)

| Package | Installed | License (METADATA) | Verified |
|---|---|---|---|
| numpy | 2.4.6 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | yes |
| gymnasium | 1.4.0 | MIT | yes |
| fastapi | 0.143.2 | MIT | yes |
| uvicorn | 0.54.0 | BSD-3-Clause | yes |
| pydantic | 2.14.1 | MIT | yes |
| openai | 3.31.0 | Apache-2.0 | yes |
| langgraph / langgraph-checkpoint-postgres | 1.2.15 / 3.2.0 | MIT | yes |
| **psycopg, psycopg-binary, psycopg-pool** | 3.3.6 / 3.3.6 / 3.3.3 | **LGPL-3.0-only** | yes. Used as an unmodified library (dynamic use is fine), but it is **not in THIRD_PARTY_NOTICES.md**: add it |
| pyyaml | 6.0.3 | MIT | yes |
| httpx | 0.28.1 | BSD-3-Clause | yes |
| mujoco | 3.16.0 | Apache-2.0 | yes |
| pandapipes | 0.15.0 | BSD (METADATA) | yes |
| compopt | 0.1.0 | MIT (METADATA) | metadata only (see 5a) |
| laya (optional extra) | via `.pth` to the clone, not pip-installed | Apache-2.0 | yes (clone) |
| torch (optional) | 2.14.1+cpu | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause ... (compound) | partially: first terms read, full SPDX string not read |
| transformers (optional) | 5.20.1 | Apache-2.0 | yes |
| safetensors (optional) | 0.8.0 | Apache Software License (classifier) | yes |
| pytest, pytest-asyncio (dev) | not checked | MIT / Apache-2.0 expected | unverified |

### 5c. JavaScript dependencies (`apps/web/package.json`)

| Package | Version | License | Verified |
|---|---|---|---|
| three | 0.186.1 | MIT | yes (installed package.json) |
| @react-three/fiber, @react-three/drei | 9.8.2 / 10.7.9 | MIT | yes |
| react / react-dom | 19.2.3 | MIT | react yes; react-dom not read |
| zustand | 5.0.15 | MIT | yes |
| lucide-react | 1.57.0 | ISC | yes |
| motion | 14.2.0 | MIT | yes |
| @fontsource-variable/geist (+ geist-mono) | 5.3.0 | OFL-1.1 | geist yes; geist-mono not read |
| vite | 8.3.4 | MIT | yes |
| ws | 7.5.13 | MIT | yes |
| **@xyflow/react** (delegation graph) | ^12.12.0 | MIT expected | **unverified: not installed in this checkout, and not in THIRD_PARTY_NOTICES.md** |
| Expo / React Native (`apps/mobile`) | ~57 | MIT expected | unverified (mobile deps not installed here) |
| vitest, typescript, @vitejs/plugin-react (dev) | | MIT / Apache-2.0 expected | unverified |

### 5d. Required fixes to `THIRD_PARTY_NOTICES.md` (not edited here; owner: whoever owns the root docs)

1. Replace "planned use / does not vendor" wording: the backend now depends on pandapipes (BSD-3), CompOpt (MIT), MuJoCo (Apache-2.0), LangGraph (MIT), Laya (Apache-2.0), with copyright lines taken from each LICENSE file.
2. Add psycopg (LGPL-3.0), numpy, fastapi, uvicorn, pydantic, openai, httpx, pyyaml, gymnasium, torch/transformers/safetensors (optional), @xyflow/react.
3. Correct upstreams.md: LangGraph copyright line, CompOpt "adapted algorithms" wording, Neon hostnames (it shows `c-6.us-east-2`; `.env.example` shows `c-4.us-west-2` and `c-3.us-west-2`), and the Menagerie / Example-Manipulation "used" claim.
4. State the Nemotron model license and the Laya checkpoint license once someone has read them.
5. The private repo has no root `LICENSE`; the public export has an MIT one (verified in the export). Confirm that is intended.
6. 3D assets: the notices say all geometry is procedural; V11 changed `packages/scene/src/Racks.tsx` (procedural, still no meshes): statement still holds, re-check after the final scene commit.
