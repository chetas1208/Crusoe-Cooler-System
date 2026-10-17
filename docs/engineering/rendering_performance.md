# Rendering performance (web scene) — measured, with limits

Revision 2026-10-16. Everything below was measured by `scripts/bench/run.mjs` driving `window.__lkBench` (apps/web/src/bench).
Raw JSON: `artifacts/benchmarks/*.json`. Nothing here is a 120/200 FPS claim; see "What is not verified".

## 1. How to measure (and how you can run it yourself)

- Harness: add `?bench=1` to the app URL (any browser). A small panel appears; "Run all presets" runs 5 seeded camera paths
  (dashboard_orbit, map_pipe_pov, outrig_chase, agent_graph, execution_replay) x preset(s) and downloads a JSON file.
  No FPS overlay exists anywhere; numbers only leave through the JSON.
- Headless driver: `node scripts/bench/run.mjs --gpu --url <app> --presets high,balanced,performance --out artifacts/benchmarks/x.json`.
  `--gpu` asks Chromium for ANGLE/Vulkan; without it you get SwiftShader (software). Build the app first
  (`scripts/bench/serve-build.sh <outDir> <port>`) — a dev server's bundle sizes mean nothing.
- Recorded per scenario: frame interval p50/p95/p99 (rAF gap), `cpu_frame_ms` (JS time from R3F frame start to after `gl.render`
  returns = submission cost), `gpu_ms` (EXT_disjoint_timer_query_webgl2 when exposed), draw calls, triangles, geometries,
  programs, long tasks, JS heap, WebSocket bytes, page-load bytes, GL renderer string, estimated display refresh, `software_rasteriser`.
- `verdict.can_claim_120fps` is true only for hardware GL + non-automated browser + >=115 Hz cadence + p95 <= 8.33 ms in every scenario.
  It is false in every file in this repo.

## 2. Test rig (what the numbers are)

Server box, 20 logical cores, 2x RTX 3090, headless Chromium 153 with `--use-angle=vulkan` (renderer string
`ANGLE (NVIDIA ... GeForce RTX 3090 ... Vulkan)`, `software_rasteriser:false`, timer queries available), 1440x900, DPR 1,
production build, no display attached. rAF cadence in this setup is ~60 Hz (measured 50-60 Hz), so `frame_interval_ms` cannot show
more than ~60 fps here; the useful headroom signals are `cpu_frame_ms` and `gpu_ms`. This is a server-side GPU run, not a
user-display run. SwiftShader (software) runs are in `*_software_*.json` (4 Hz; only draw calls/tris are meaningful there).

## 3. Results (preset High, dashboard orbit unless stated)

| build | robots | draw calls p50 | tris p50 | cpu_frame p50 / p95 ms | gpu p50 / p95 ms |
|---|---|---|---|---|---|
| before (original scene, embedded mock) | 3 | 469 | 125,944 | 11.6 / 21.0 | 3.32 / 5.20 |
| after render pass (same mock, same rig) | 3 | 248 | 84,690 | 5.7 / 7.2 | 1.66 / 1.89 |
| after, live Python backend (V4 hall, 80 context cabinets) | 16 | 238 | 203,718 | 5.4 / 7.5 | 2.22 / 2.48 |
| after hall visual pass (floors, containment, busway, side gear, columns, supports) | 16 | 183 | 231,274 | 5.6 / 7.3 | 2.29 / 2.60 |

Other scenarios, High (before mock 3 robots -> after live 16 robots): map_pipe_pov 237 -> 207 calls, cpu p50 8.9 -> 4.9 ms;
outrig_chase 529 -> 98 calls, cpu p50 12.9 -> 3.4 ms. Hall visual pass cost vs the previous 16-robot build: dashboard cpu p50
+0.2 ms (+4 %), tris +13 %, draw calls -23 %. Initial JS 568 KB (before) -> 534 KB (after) encoded; HTML+CSS+fonts unchanged.
Presets (1440x900, mock, before -> after, dashboard_orbit): High 469 -> 248, Balanced 483 -> 246, Performance 479 -> 207 draw calls.

## 4. What the profile showed, and what fixed it

1. **Transmission pass.** The profile put 29 % of main-thread time in three.js `getParameters/getProgram`, called from
   `renderTransmissionPass`. Two tiny `transmission={0.85}` window glasses made three.js re-render every opaque object into an
   offscreen target each frame (about 40 % of draw calls) and flip programs twice per frame. Replaced by plain alpha glass.
2. **Fleet.** OUTRIG robots (27 meshes each) are now ~12 `InstancedMesh` for the whole class; crawler close-ups use 5 pooled meshes and
   exist only within 7 m or inside a bore; far robots are billboard markers in 4 instanced meshes with instance-id picking.
   Geometry/materials are shared (`robotKit.ts`); selection brackets exist only for the hovered/selected robot.
   (Fixed along the way: OUTRIG locator markers used to sit at the world origin.)
3. **Pipes.** Tube geometry is cached by `(topology_hash, edge, kind, radial segments)` (`geomCache.ts`); a topology refetch with
   identical geometry rebuilds nothing.
4. **Columns / floors / hall furniture** are instanced or merged (one draw per material bucket), data-driven from `/topology`.
5. **Pose interpolation** is timestamp-based (render ~160 ms behind the newest sample, never extrapolated) and now carries the
   orientation quaternion (nlerp) and (segment, s). All robot transforms are written in `useFrame`; no per-frame React state.
6. **Quality presets** `Auto / High / Balanced / Performance` (System popover): DPR cap 2 / 1.5 / 1, shadow map 2048 / 1024 / off, pipe
   radial segments 18 / 12 / 8. They never change simulated robots, topology or physics (the bench records `sim_invariants_equal`).
   Auto steps down after 2.5 s of p95 overrun vs the display cadence and up after 15 s of headroom, never within 20 s of a change.

## 5. Server GPU boundary

The browser GPU renders. In this lab the headless browser on the server could use the RTX 3090 through ANGLE/Vulkan, so the server
GPU *did* accelerate this benchmark's rendering — that says nothing about a user's browser. No server-side rendering or physics GPU
path exists or is claimed.

## 6. What is not verified

- No measurement on a real 120/144/240 Hz display with a user-facing browser. Run the in-page harness there.
- WebGPURenderer was not tried; WebGL2 (three r186) is the only renderer.
- Draw calls in agent_graph/execution include the DOM-heavy tabs only partially; GPU timer values are only present where the
  browser exposes the extension.
- Bench worlds differ run to run (the simulator advances in real time); camera paths are deterministic functions of time.
- 3840x2160 not measured. Memory/texture upload cost not profiled; hall furniture adds ~13 % triangles.
