# Frontend work split (4 agents) — four-tab UI

Spec: the pasted "Complete Four-Tab Spatial Frontend" (v2.0) — summarised in the agent prompts; repo copies: frontend-ui.md, idea.md.
Shell is DONE and owned by the lead: `apps/web/src/tabs/TabHost.tsx`, `tabs/types.ts`, `ui/store.ts` (`tab`), `ui/TopBar.tsx`, `ui/Shell.tsx`.
Each tab = one component dir under `apps/web/src/tabs/<tab>/`. The 3D `Viewport` + `packages/scene` are shared & persistent.

## Hard rules (every agent)
1. **Nothing may regress.** Before AND after your work: `pnpm -r --parallel typecheck` and `pnpm test` (18 core tests) must pass. Other tabs must keep working. Baseline backup: scratchpad `frontend-baseline.tgz` (do not edit).
2. **Performance budget: the app runs at 120–200 FPS on the user's machine.** No per-frame allocations in hot paths, no new always-on full-res extra canvases/render targets, instance repeated geometry, throttle React state from the 10 Hz pose stream, no new per-frame `setState`. Measure draw calls/triangles/frame time before and after (see `apps/mobile/README.md`/PROGRESS.md for how it was measured; use the dev browser or a headless perf probe) and report numbers. Don't add >10% frame cost.
3. No page scroll on any tab (`100dvh`, `min-height:0`, internal panes only). 4 tabs only — no 5th tab.
4. No fabricated data: everything from `useWorld` / the contract. Disable unavailable actions with a reason. Label MOCK honestly.
5. Edit ONLY your owned files. Shared files you need changed (contracts.ts, store/world.ts, engine/*, scene files owned by others): put new types in NEW files (`packages/core/src/contracts.<yours>.ts`, re-exported from your own index) and request the minimal shared edit in `docs/engineering/seam-requests.md` — or, if tiny and additive, make it and list it in your report.
6. Dev servers: use a unique port per agent (web 5173+N, mock-api 8787+N) and kill them when done. Don't run `pnpm install` that changes the lockfile without adding only the dependencies you need (state them).
7. No git commits, no GitHub Actions. No mobile (`apps/mobile`) edits except keeping it typechecking.
8. Visual language: existing tokens in `apps/web/src/styles/tokens.css`, kit in `ui/kit.tsx`. Panels 85–94% opaque, ≥12px text, tabular numerals, mono for IDs. Contextual overlays only.
9. Report: files changed, what you verified (commands + outputs) vs not, perf numbers, open issues.

## Ownership
| Agent | Owns |
|---|---|
| 1 scene+dashboard | `packages/scene/src/{Facility,Equipment,Pipes,Scene,theme,tube,dims}.ts(x)`, `packages/core/src/engine/facility.ts` (+ its tests), `apps/web/src/tabs/dashboard/**`, `ui/{Dock,Inspector,Callouts,MiniMap,IncidentCard}.tsx` |
| 2 map | `packages/scene/src/{Robots,PipeInterior,CameraRig}.tsx`, `apps/web/src/tabs/map/**`, `ui/PipeHud.tsx`, `packages/core/src/engine/robots.ts` + control additions, `packages/core/src/control/**`, mock-api control routes |
| 3 agents | `apps/web/src/tabs/agents/**`, `ui/AgentsBoard.tsx`, `styles/board.css` |
| 4 execution | `apps/web/src/tabs/execution/**`, `packages/core/src/runs/**`, `apps/mock-api/src/runs*`, recorder/fork in embedded engine wrapper (not engine internals) |
