# V10 mobile test report (Agent C)

All numbers: `node scripts/mobile/matrix.mjs <dist> artifacts/v10/after` (Playwright Chromium 1243, device EMULATION, SwiftShader software GL) and `scripts/mobile/baseline.mjs` (before). **No physical iOS/Android device was available**: real GPU limits, dynamic browser toolbars, soft-keyboard behaviour and touch latency are unverified. Raw data + screenshots: `artifacts/v10/baseline/` (before) and `artifacts/v10/after/` (after, `matrix.json`, 73 rows).

## What was built
* **Stage 1 - shell without 3D**: three/R3F/drei/scene are behind `React.lazy` (`features/visualization/ViewerHost.tsx`), fixed-size placeholder, error boundary, bench harness and label projector split out. Measured at 390x844 (standalone sim, includes the 44 KB gz embedded engine): initial transfer **381 KB / 322 KB JS (was 681 KB / 610 KB; main chunk 585 KB gz -> ~190 KB gz)**, first usable 0.8 s unthrottled and **3.2 s on 4G + 4x CPU (was 4.6 s)**, three is NOT requested in 2D/phone-lite mode (`threeLoaded:false`). NOTE: commit `fcefdad` had replaced the lazy import by a static import (which silently put three back into the first chunk, 685 KB); it was restored here - keep it lazy.
* **Viewer mode policy** (`features/visualization`): AUTO | LOCAL_3D | LOCAL_LITE_3D | TACTICAL_2D | STREAMED_VIDEO (listed, disabled: no remote renderer exists; V7 GPU probe gated it). Feature detection only; frame-time watchdog and WebGL context loss fall back to the 2D plan with a "Try 3D again" button; `?viewer=auto|3d|lite|2d`; picker is the layers button in the phone top bar (bottom sheet). Tactical 2D = canvas plan from /topology + live poses; pan/pinch/wheel are view-only; tap selects through the shared store.
* **Responsive system** (`styles/mobile.css`, `features/responsive/*`): everything is gated on `(max-width: 860px), (max-height: 480px)`, so desktop is untouched. Phone: compact top bar, **MobileTabBar** (4 tabs, 56 px, safe-area), stage on top (34 dvh) with each tab's panels as a scroll area below, **BottomSheet** (closed/peek/expanded, tap-operable, Escape, focus return) hosting Agent B's `CommunicationsPanel variant="sheet"` (the Execution dock hides itself on phones), Agents = task list + inspector (no DAG on phones), Map = roster + camera modes + inspector, **hold-to-drive pad** that only dispatches the same key events the desktop controller already handles (Preview Drive = local ghost, live = lease required, blur/hidden/pointer-cancel -> existing safe-stop; disabled with an explanation otherwise), `100dvh` shell, `visualViewport` height var, 16 px inputs (no iOS zoom), 44 px targets on shell chrome.
* Desktop >= 861 px: unchanged by construction; before/after screenshots at 1440x900, 1920x1080, 1280x720 for all four tabs were compared (top bar pixel diff 0.0-0.2 % on Dashboard/Map/Agents; remaining differences are the animated scene, ticking numbers and Agent B's newer Execution chips).

## Matrix results (73 rows, `after/matrix.json`)
* Viewports: desktop 1920x1080, 1440x900, 1280x720, 900x600, tablets 768x1024 / 820x1180 / 1024x768, phones 320x640, 360x800, 390x844, 412x915, landscape 844x390 / 915x412, 200% zoom equivalents 640x450 / 450x600; each x 4 tabs.
* **Root horizontal overflow: 0 of 56 viewport/tab combinations** (320-1920 px).
* Touch targets under 44 px (emulated phones, count of interactive elements): Dashboard 2, Map 6, Agents 1-3, Execution 14 (was 24 / 33 / 15 / 53); desktop unchanged (25-68, mouse UI).
* WebGL disabled (phone): AUTO -> TACTICAL_2D, canvas drawn, all four tabs switch, no console errors. API blocked: "Backend Connection Required" card, no overflow. 4G + 4x CPU: first usable 3.2 s, 375 KB, 3D not downloaded. Orientation 390x844 -> 844x390 -> 390x844: selected tab preserved. 100x open/close of the Communications sheet: sheet opened 100/100, none left mounted, DOM nodes 435 -> 442, JS heap 5.6 -> 7.6 MB after forced GC (small residual growth, not a runaway; not investigated further).

## Not done / open
* Real devices; soft-keyboard (`visualViewport`) composer behaviour was only wired, not tested with a real keyboard; long-id (320 px) stress not run; 5,000-event list freeze test not run by me; Execution/Map tabs on phones still have 6-14 sub-44 px controls inside other agents' components; the Execution phone layout is a stacked reflow of the desktop panels (usable, not designed); LOCAL_LITE_3D only lowers the quality tier; STREAMED_VIDEO does not exist.
* Phone 3D mode (Canvas in the top stage) was smoke-tested under SwiftShader only.
* Files outside my ownership that I changed (owners told): `packages/scene/src/{fit.ts,MountedCameraTransforms.ts,mountTransform.ts,index.ts,CameraRig.tsx,../package.json}`, `apps/web/src/features/communications/CommunicationsPanel.tsx` (dock returns null on phones), `apps/web/src/bench/{index.tsx,flag.ts}`.

## Execution panels on phones and tablets (Agent B)
Command: `node scripts/e2e/mobile_matrix.mjs --url "http://localhost:5183/?api=http://localhost:8801"` against a REAL in-memory backend (`:8801`, three injected faults, contracts populated), raw rows in `artifacts/tests/mobile_matrix.json`, screenshots in `artifacts/screenshots/v11/mobile/`. Headless Chromium 153 device EMULATION (touch, DPR 2-3), SwiftShader. No physical iOS/Android device was used.

| viewport | root h-overflow | Communications | Definition of Done | Team | Scorecard | panels live in the shell sheet | first usable |
|---|---|---|---|---|---|---|---|
| 390x844 | none (390/390) | opens, fits | opens | opens | opens | yes | 0.70 s |
| 844x390 | none | opens, fits | opens | opens | opens | yes | 0.61 s |
| 820x1180 | none | opens, fits | opens | opens | opens | yes | 0.58 s |
| 1024x768 (desktop layout) | none | opens, fits | opens | opens | opens | no (desktop dock) | 0.91 s |
| 390x844, WebGL disabled | none | opens, fits | opens | opens | opens | yes | 0.56 s |

* Communications is hosted by the shell's BottomSheet (PhoneChrome); the desktop dock does not render on phones, so exactly one `#lk-comms-panel` exists. DOD + Team + prompt strip share one portal sheet ("Execution details"); the Scorecard is its own sheet and replaces it (one sheet at a time).
* Found and fixed with this matrix: (1) my sheet rendered inside the Execution container and floated mid-screen, now portaled to `body`; (2) on 844x390 the sheet covered the header chip rail, so Team/Scorecard were unreachable, now the toggles are repeated inside the sheet; (3) sheets were translucent and stacked into an unreadable mix, now opaque; (4) Comms launcher / chips measured 32 px high, now 44 px on phones (`html[data-phone='1']`, `pointer: coarse`).
* Touch targets after the fix (phones/tablet-emulated): launcher 44 px, chips 44 px, sheet buttons 44 px. On the 1024x768 desktop layout chips are 22 px high (desktop sizing, mouse).
* Not covered: physical devices, soft-keyboard behaviour in the search box, long-id stress at 320 px, 4G throttling of these panels, 100x open/close leak check (the store-level close/reopen x3 flow passes in `scripts/e2e/comms_flows.mjs`).
