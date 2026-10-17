# V10 mobile baseline (measured; Agent C)

Method: `node scripts/mobile/baseline.mjs <dist> <out>` (Playwright chromium 1243 via `scripts/mobile/lib.mjs`, SwiftShader software WebGL, static gzip server, embedded simulator). Raw data + screenshots: `artifacts/v10/baseline/` (`baseline.json`, `*.png`, `bundle-before.json`). **Device emulation is not a real mobile GPU/CPU**: viewport, DPR, touch, 4G (1.6 Mbps/150 ms) and 4x CPU throttle only. No physical iOS/Android device was available.

## Bundle (before): one 2,001,862 B index chunk (585 KB gz) + 136 KB engine chunk (dynamic) + 92.7 KB CSS
Attribution via sourcemaps (`scripts/mobile/bundle-report.mjs`): three 605 KB, @loopkeeper/core 195, react-dom 174, @react-three/fiber 169, @loopkeeper/scene 155, motion 131, @xyflow 122, app code ~330, three-stdlib 25. So ~970 KB (49 %) of the eager JS was 3D that a phone cannot show usefully, and the Agents graph libs another ~125 KB.

## Observed (this environment) vs hypothesised
| rank | cause | status | evidence |
|---|---|---|---|
| 1 | **Desktop-only absolute-position overlays**: `.leftcol/.rightcol` (372 px), `.topbar` 3 panels, dock, preset bars, Map left+right drawers, Execution 3-column board; only 12 `@media` rules in the whole CSS, none for phones | observed | `dash_p390.png`, `map_p390.png`, `execution_p390.png`: top bar clipped ("Simulate an incident" cut at x=390), panels stacked over each other, labels wrapped one word per line; 24-54 targets under 44 px per tab |
| 2 | Eager 3D: three+R3F+drei+scene in the first chunk | observed | 2.0 MB / 585 KB gz before any pixel of UI; 4G+4x CPU: first usable 4.6 s (`dash_p390_4g_cpu4`) |
| 3 | Main-thread long tasks while the WebGL scene mounts (shader compile, geometry build) | observed under SwiftShader, **unverified on real GPUs** | 4.1-5.4 s longest task on every viewport incl. desktop; 150 ms with WebGL disabled |
| 4 | Fixed `100vh`-based heights (`calc(100vh - 150px)`, 14 uses), no `dvh`, no safe-area | observed in CSS, effect on real browser chrome unverified | grep; emulation has no dynamic toolbar |
| 5 | Canvas sizing / WebGL context loss / GPU memory | hypothesised | one canvas, fills `.stage`; context-loss path had no fallback (now handled); GPU memory not measurable here |
| 6 | WS / re-render storms | not observed | JS heap 21-36 MB, 8-10 long tasks all during scene mount; no storm in a 6 s idle sample (not a driving/replay session) |
| 7 | Root horizontal overflow | **not present** | `scrollWidth == clientWidth` on all 15 runs (body is `overflow:hidden`, overlays clip instead of scrolling) |

Viewports captured (before): 1440x900, 1920x1080, 390x844, 844x390, 820x1180, 1024x768, 320x640, per tab at 390 and 1440, 4G+CPU4 and WebGL-disabled at 390. WebGL-disabled phone: shell works but shows the same broken overlay stack plus a "3D view unavailable" card.

Present / Partial / Missing / Unverified: WebGL-absent message PRESENT; viewport meta with `viewport-fit=cover` PRESENT; responsive layout, tab bar, bottom sheet, 44 px targets, dvh, safe-area MISSING; remote streaming MISSING (no renderer exists, see V7 GPU probe); real-device behaviour UNVERIFIED.
