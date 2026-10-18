# Crusoe Cooler System — mobile

The on-call operator's companion for the Crusoe Cooler System maintenance twin: a live 3D view of the simulated
liquid-cooled hall, the incident that needs attention right now, the agent trace behind it, and the robots
doing the work. Built with Expo (SDK 57), Expo Router, React Native Reanimated and `@react-three/fiber/native`.

Everything on screen is streamed from the backend. The facility is **simulated** (labelled as such), robots are
**virtual**, and the app never invents telemetry, poses or outcomes — if the stream goes quiet it says `STALE`,
`RECONNECTING` or `OFFLINE`, dims the scene, and disables commands.

## Screens (four tabs, same model as the web console)

| Tab | What it does |
| --- | --- |
| **Dashboard** | Link state, `SIMULATED FACILITY`, backend chip, sim clock. **Cooling health** strip (TCS supply / return / flow / pressure from CDU-01 and trunk P-10, dimmed with the age of the last update when the stream stops), min margin / heat / open incidents, the **pinned incident** (severity, five-step stepper, status line, operator approval with countdown, verification) and **fleet counts**: internal INPIPE / external OUTRIG robots (world snapshot) and SENTINEL supervisors (`GET /agents/graph`) — 10 / 8 / 5 on the current backend. Incident rows open the incident detail (evidence, missions, agent trace). |
| **Map** | Pinned **2D tactical map** drawn from `/topology` + streamed poses (pipes, assets, obstacles, robots, incident anchors, selected robot route), zoom controls; optional **3D scene** toggle on native (shared `@loopkeeper/scene` on R3F-native). Below it: roster (internal / external filter, search) and the **control surface** for the selected robot. **Preview (ghost)**: a local ghost, nothing is sent, no lease, the simulation is unchanged. **Live control**: lease-based (`/control/lease` → `/drive` ≤ 15 Hz intents → `/control/release`); the pad is enabled only after the lease is granted. Releasing, leaving the tab, selecting another robot, **backgrounding the app** (safe-stop `client_hidden`), or losing the stream releases / safe-stops (`features/map/useDriveSafety.ts` + the core control session). |
| **Agents** | SENTINEL (5 supervisors) / INPIPE / OUTRIG lists with status filters → detail: **tasks** (causal timeline), **tool calls** (JSON, secret-looking keys redacted) and **verdicts** (independent verification checks before → after, task outcomes). |
| **Execution** | Chips: **Scenario** (natural-language prompt box + presets → `POST /scenario-requests`, polled through its phases), **Comms** (`comm.*` events for the target run: REST backfill + stream, role filters, search, expandable detail, **Hide / Reopen** with an unread count), **DoD** (frozen contract checks, measured vs required, holds, terminal state, a "why not done yet" line), **Team** (SENTINEL seats, task tree, budgets, loop / drift warnings), **Run** (live play / pause / speed, run list, read-only **replay** with scrubber, step, play, speed; an amber banner on every tab while a replay is shown; engineering fault injection behind a disclosure). |

Haptics mark new incidents, approval requests, approvals, verifier outcomes and mode changes. Reduce Motion is
respected (system setting is mirrored into the scene and Reanimated).

## Run it

```bash
pnpm install                 # from the repo root (node-linker=hoisted is required for Expo)
EXPO_PUBLIC_API_URL=http://<backend-host>:8787 pnpm dev:mobile   # press `i` / `a`, or scan the QR in Expo Go
EXPO_PUBLIC_API_URL=http://<backend-host>:8787 npx expo export --platform web   # static web build (2D map only; no GL scene)
```

The backend URL comes from `EXPO_PUBLIC_API_URL`; with none set the app falls back to the machine Metro is served from
on port `8787`, then `http://localhost:8787`. **No secrets are bundled.** If the backend answers 401 the app asks for an
operator token, keeps it in memory for the session only, and never persists it. A browser build also needs the backend's
CORS to allow the origin.

### Rendering knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXPO_PUBLIC_RENDER_SCALE` | `min(1, 2 / devicePixelRatio)` (≈ 0.67 on a 3× iPhone) | Internal resolution of the 3D canvas (expo-gl always renders at native density) |
| `EXPO_PUBLIC_RENDER_FPS` | `30` | Frame cap for the scene; each frame is fenced on the previous one so a slow GPU degrades gracefully instead of freezing the app |
| `EXPO_PUBLIC_FAST_GL` | unset | `1` skips shader-link status queries (blocking round trips) in dev |

The iOS Simulator is detected automatically (`expo-device`) and gets a low-cost profile (scale 0.3, 2 fps, fast GL); physical devices keep the better one. The variables above still override. The simulator renders OpenGL ES in **software**, so the full scene is slow there. For quick functional
checks use e.g. `EXPO_PUBLIC_RENDER_SCALE=0.3 EXPO_PUBLIC_RENDER_FPS=3 EXPO_PUBLIC_FAST_GL=1 pnpm dev:mobile`;
a real device should run the scene at full quality, but that has **not been verified on physical hardware yet** (only the iOS Simulator, via Expo Go).

## How it is put together

```
src/app/            Expo Router — (tabs)/index = Dashboard, map, agents/ (list + [id]), execution; incident/[id]
src/components/     ui kit (Chip, Ring, Segmented…), live/ (R3F-native canvas + input), incident/ (stepper, approval, verification, agent trace)
src/features/       map/ (tactical map, roster, control surface, safety), agents/, execution/ (scenario, comms, DoD, team, run), comms/, dod/
src/hooks/          world bootstrap + retry, link status, alerts (haptics), incident selectors
src/theme/          tokens that mirror apps/web (colours, radii, Geist fonts)
```

* **Data**: `@loopkeeper/core` — `LiveTransport` (REST + WebSocket) feeding the `useWorld` store, and
  `commands.approve / hold / setSpeed / pause / resume`. The simulator (`@loopkeeper/core/engine`) is never imported,
  so it stays out of the bundle.
* **3D**: `@loopkeeper/scene`'s `<Scene>` rendered through `@react-three/fiber/native` + `expo-gl`. Touch input only
  writes camera *goals* into the shared `useView` store; the shared `CameraRig` eases the real camera. The sheet's
  height is fed back as a camera inset so the subject stays visible above it.
* **Metro**: `metro.config.js` pins every `three` import to one ESM build (the CJS build calls `process.emitWarning`,
  which React Native lacks, and would load a second copy of three).
* Overlays above the GL view live in one always-mounted layer (toggled by opacity, not by mounting siblings of the
  canvas), and the canvas is only created once the first snapshot has landed and the first layout has settled.

## Checks

```bash
npx tsc --noEmit
npx expo lint
npx expo-doctor
```
