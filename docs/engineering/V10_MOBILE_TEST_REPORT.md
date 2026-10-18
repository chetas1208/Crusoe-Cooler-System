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

---

# V12: one experience in every layout and orientation (Agent J)

Why: Communications, Done, Team and Scorecard existed only inside the Execution tab on the regular chrome, and the compact (phone) chrome was keyed to one media query, so a rotated phone, a tablet in landscape or a 900-1280 px window showed a different, poorer product. Landscape was a squeezed portrait (3D stage 0 px high).

## What changed
* **Layout model** (`features/responsive/layout.ts`, hook `useLayoutMode`): `layout = phone-portrait | phone-landscape | tablet | desktop` from window size, orientation and pointer (coarse/fine); also `compact` (compact chrome: slim top bar + tab bar/rail) and `host` (`dock | drawer | sheet`). It writes `html[data-layout|orient|compact|comms-host]`; every layout rule is keyed to those attributes (no media query). Rules: short side <= 500 = phone; fine pointer and >= 1280x720 = desktop; the rest = tablet; compact when phone or <= 860 px wide; host = dock if regular chrome and >= 900x520, else drawer in landscape, else sheet. Unit-tested (`responsive/__tests__/layout.test.ts`).
* **One panel host** (`PanelsHost.tsx`, registry `panels.ts`): Communications / Done / Team / Scorecard are tabs of ONE host, one visible at a time, from every tab. Dock = fixed right column of 320-400 px and the app (stage, top bar, tab panels, camera fit) narrows beside it, so nothing is covered; drawer = right drawer, 40 % width, full height; sheet = bottom sheet with peek / half (exactly the panel area, stage stays visible) / expanded snap points, grabber drag, explicit buttons. Same tab strip in all three. Closing only hides: ingestion, polling, filters, scroll, run, selection live in their stores (tested). Opening one closes the others, an external flag (evidence link, persisted flag) wins (tested). Escape closes and returns focus to the opener for every panel; arrow/Home/End roving tabs.
* **Launchers**: Comms chip with state dot (and word on wide bars) + unread badge in the top bar (regular chrome) and in the tab bar/rail (compact); Done/Team/Scorecard chips in the top bar, a "panels" button in the tab bar/rail, and the host tab strip from any open panel. Default: docked open only when the app keeps >= 1200 px beside the dock (>= 1600 px wide), collapsed elsewhere.
* **Landscape phone is a design, not a squeezed portrait**: tab rail on the left (4 tabs + Comms + panels), 3D stage ~54 % of the width, each tab's panels in a scroll column on the right, compact top bar on top, panels as a right drawer over the column. Portrait keeps stage / panels / bottom tab bar. Same chips, sheet/drawer chrome and tokens in both.
* **Camera fit** now solves for the stage box (`stageSize()`), not the window, with compact stage overlays (Map HUD row, drive pad) declared via `data-stage-inset`; before, the hall was cropped beside the dock and in landscape.
* **Map HUD** on small stages: one row (status pill + icon camera modes); drive pad collapses to a one-line status chip until Preview/live drive is on. **Execution** compact layout: wrapped rail, one-column library, timeline that keeps its lanes. Soft keyboard: `interactive-widget=resizes-content`, tab bar hides while the keyboard is up, focused fields scroll into view.
* **Top bar**: one grid (brand | tabs | actions), nowrap, fitted at runtime: it starts full and drops secondary content in a fixed order (sub-line to tooltip, chip words to icons, model chip, TCS flow, "Simulate", wordmark, key hints, vitals + chips, icon tabs, name) until the clusters fit without touching. At 1280-1440 px this removes the model chip and the TCS flow vital that used to overlap the tabs.
* Review findings fixed: panel entry on compact chrome, Expand/Collapse keep focus (aria-disabled), one close button and one heading in host mode, Shell typing guard includes SELECT, Escape in the search box clears the field first, feed window clamps a stale scroll offset (a filter switch or reopen could render 0 rows until the next animation frame; unit-tested).

## Parity table (what lives where; enforced per device pair by `scripts/e2e/mobile_matrix.mjs`)
| Feature | Phone portrait (390x844) | Phone landscape (844x390, 932x430) | Tablet portrait (768x1024, 820x1180) | Tablet landscape / desktop (1024x768 ... 1440x900) |
|---|---|---|---|---|
| 4 tabs | bottom tab bar | left tab rail | bottom tab bar | top bar segmented control |
| Comms launcher chip (state dot, unread) | tab bar | rail | tab bar | top bar |
| Done / Team / Scorecard entry | tab-bar "panels" button + host tab strip | rail "panels" button + drawer tab strip | tab-bar "panels" button + host tab strip | top-bar chips (wide bars) + dock tab strip |
| Panel host | bottom sheet (peek / half / expanded) | right drawer, 40 % width, full height | bottom sheet | right dock 320-400 px, app narrows beside it |
| 3D stage | top 34 dvh | left ~54 % | top 40 dvh | whole area (minus dock) |
| Dashboard panels | scroll area under the stage | scroll column right of the stage | scroll area under the stage | overlays |
| Map: roster, inspector, presets | scroll area under the stage | scroll column | scroll area | drawers |
| Map: HUD (status pill, camera modes, drive) | on the stage; drive pad on the stage | on the stage | on the stage | HUD + keyboard controller |
| Execution: scenario input + library, playback, inspector | scroll area under the stage | scroll column | scroll area | overlay + bottom timeline + right inspector |
| Agents | list + inspector stacked | list and inspector side by side | stacked | delegation graph + inspector |
| Spatial view picker | layers button -> sheet | layers button -> drawer | layers button -> sheet | n/a (layer controls on the stage) |
| Search / Simulate | compact top bar | compact top bar | compact top bar | top bar |
Intentional single difference: the on-screen drive pad exists only in the compact chrome (desktop keeps the keyboard controller and the robot panel's manual-control buttons); the parity inventory excludes it for that reason.
