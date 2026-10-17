# V7 Performance Audit

Measured on 2026-10-17 from `scripts/bench/perf_audit.mjs` against the local web app and API. Values below are observations from the JSON artifacts, not display-FPS claims.

## Hardware / Browser Facts

- Browser: Headless Chromium 153, DPR 1, viewport 1440x900.
- Client/server GPU available to the browser process: RTX 3090 through ANGLE/Vulkan (`NVIDIA GeForce RTX 3090`), WebGL timer queries available.
- Robot count in the test world: 18 physical robots.
- Remote rendering: gated off. `artifacts/perf/gpu_probe.json` reports RTX 3090 + NVENC API library present, but no usable ffmpeg `*_nvenc`, no aiortc/PyAV/GStreamer/TURN stack, and no measured local-renderer defeat.

## Baseline vs Tiled/Instanced Local Renderer

Artifacts:

- Baseline: `artifacts/perf/baseline/audit.json`
- Latest tiled run: `artifacts/perf/after2_tiles/audit.json`

| Phase | Baseline draw / tris | After draw / tris | Baseline CPU p95 | After CPU p95 | Baseline GPU p95 | After GPU p95 |
|---|---:|---:|---:|---:|---:|---:|
| Dashboard idle | 434 / 305,744 | 101 / 31,086 | 13.0 ms | 6.7 ms | 1.93 ms | 0.57 ms |
| Map overview | 394 / 214,128 | 92 / 22,294 | 12.0 ms | 5.9 ms | 0.99 ms | 0.35 ms |
| Map zoom | 395 / 214,128 | 92 / 22,294 | 11.5 ms | 4.9 ms | 1.01 ms | 0.35 ms |
| OUTRIG chase | 236 / 191,464 | 82 / 21,710 | 10.4 ms | 5.9 ms | 2.21 ms | 1.17 ms |
| Crawler pipe POV | 152 / 172,268 | 60 / 19,298 | 8.7 ms | 4.9 ms | 1.83 ms | 0.87 ms |
| Manual driving | 397 / 213,488 | 96 / 22,350 | 13.5 ms | 5.7 ms | 0.94 ms | 0.35 ms |
| Execution replay | 392 / 213,432 | 89 / 21,578 | 13.9 ms | 5.5 ms | 0.89 ms | 0.32 ms |

Cold ready time stayed roughly flat: 1042 ms baseline vs 1078 ms after. JS bytes rose from 937,890 to 970,591 because the tiled client code is now included.

## Interpretation

- The root cause was primarily renderer scene workload: too many static meshes/draw calls and high triangle count in overview scenes. The tiled/instanced path reduces draw calls by about 3-4x and triangles by about 7-10x in the measured phases.
- GPU time is not the current bottleneck on this RTX 3090 headless run after the change; CPU frame submission remains the higher cost.
- Headless `requestAnimationFrame` frame-interval p95 still shows 50-83 ms in some phases, so this audit does not claim 60/120 FPS on a physical display. A real display-attached run remains required.
- WebSocket load during the latest tiled audit was near zero because the audit used the interest-managed/pinned setup; browser manual-driving against the live V7 API still needs e2e verification.


---

# Appendix (Agent B): hypotheses vs findings and pinned-preset before/after

Harness `scripts/bench/perf_audit.mjs`; raw data `artifacts/perf/{baseline_pinned,after_pinned,after_pinned_tiles}/audit.json` (preset pinned to High, same rig as above; not a display-attached measurement).

## Hypotheses vs findings

| hypothesis | measured | verdict |
|---|---|---|
| React re-renders on every pose | driving phase: 33 commits/s (baseline) -> 1/s | CONFIRMED, fixed (pose-only updates merged <=4 Hz; `scrollIntoView` ref callback forced 52 layouts/s while driving) |
| too many draw calls / transmission pass | 433 calls, 305k tris at idle; earlier transmission pass doubled everything | CONFIRMED, fixed (equipment 232 meshes -> instanced ports/docks/sensors + one bracket layer; adaptive pipe tessellation) |
| shader compile stalls | 565 ms `getProgramInfoLog`, 690 ms long task when robots first moved | CONFIRMED, mitigated (up-front `gl.compile` of every light/clipping variant; shadows never switched off by a quality tier, which was a second recompile source) |
| WS JSON volume / parse cost | 36-98 KB/s, JSON.parse < 0.1 % of samples | REFUTED as a freeze cause |
| GC | 0.1-0.5 % | REFUTED |
| memory | JS heap 63-88 MB, 445 geometries, 6 textures | not a problem at this scale |
| overlays / DOM | 24-32 style recalcs/s (anchored labels), layouts ~1/s | minor |
| Agents tab | main thread 86-92 % busy (React Flow + 30 fps canvas behind it) | CONFIRMED; backdrop now renders at ~10 fps there (unmeasured after the change) |
| harness artefact | `GLES2::ReadPixels` ~7 ms per frame on the main thread (25 % of it), present with every canvas option tried; makes headless rAF ~30 fps | the freeze is NOT this; it caps the interval numbers here, so use cpu_frame / gpu / long tasks / commits |

## Before / after (High preset, p50 unless stated)

| phase | draw calls | tris (k) | cpu_frame ms | gpu ms | React commits/s | script % |
|---|---|---|---|---|---|---|
| dashboard idle | 433 -> 324 -> 101* | 305 -> 199 -> 31* | 10.9 -> 8.6 -> 4.3* | 1.67 -> 1.45 -> 0.56* | 1.5 -> 1 | 36 -> 25 -> 15* |
| 18 robots moving | 435 -> 324 | 306 -> 199 | 11.1 -> 8.6 | 1.67 -> 1.45 | 8.1 -> 1.1 | 34 -> 30 |
| map overview | 435 -> 324 | 306 -> 199 | 11.5 -> 8.7 | 1.38 -> 1.15 | 6.6 -> 1 | 30 -> 21 |
| chase (OUTRIG) | 326 -> 227 | 297 -> 182 | 11.4 -> 7.1 | 2.66 -> 2.83 | 2.4 -> 1 | 31 -> 17 |
| pipe POV (crawler) | 193 -> 170 | 241 -> 170 | 8.5 -> 6.2 | 2.21 -> 2.10 | 2.8 -> 1 | 20 -> 15 |
| driving (lease, W held) | 437 -> 328 | 305 -> 199 | 13.1 -> 9.0 | 1.38 -> 1.16 | 1.9 -> 1 | 25 -> 23 |
| Agents tab | 431 -> 323 | 305 -> 198 | 10.3 -> 7.2 | 1.37 -> 1.18 | 1.7 -> 1 | 42 -> 39 |
| execution replay | 429 -> 324 | 305 -> 199 | 13.6 -> 8.7 | 1.29 -> 1.08 | 1.7 -> 1.7 | 29 -> 21 |

`*` = experimental server-tile mode (`?tiles=1`, render manifest from Agent C, geometry-only plus rack/state tint, 18 tiles, 73 KB gzip fetched,
no flow shader / hall furniture). It is opt-in and not the default. Long tasks: baseline had one 690 ms (shader compile) and one 70 ms; the pinned
after run has none over 5 ms in any phase. Cold: DOMContentLoaded 457 -> 373 ms, initial JS 938 -> 971 KB (unminified; the bench harness and tile code added ~33 KB).

## What is still open

- Real-display behaviour (frame pacing, 4K, integrated GPUs) is unmeasured; the `Performance` tier now also removes backdrop blur, untested on hardware.
- The Auto controller could step down on this rig because of the ReadPixels floor; the audit pins High to keep runs comparable.
- Agents-tab frame governor and the tile path were measured only in the cases listed above.
