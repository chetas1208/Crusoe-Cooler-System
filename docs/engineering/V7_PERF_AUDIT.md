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
