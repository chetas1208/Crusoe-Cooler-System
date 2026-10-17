# LOOPKEEPER — mobile

The on-call operator's companion for the LOOPKEEPER maintenance twin: a live 3D view of the simulated
liquid-cooled hall, the incident that needs attention right now, the agent trace behind it, and the robots
doing the work. Built with Expo (SDK 57), Expo Router, React Native Reanimated and `@react-three/fiber/native`.

Everything on screen is streamed from the backend. The facility is **simulated** (labelled as such), robots are
**virtual**, and the app never invents telemetry, poses or outcomes — if the stream goes quiet it says `STALE`,
`RECONNECTING` or `OFFLINE`, dims the scene, and disables commands.

## Screens

| Tab | What it does |
| --- | --- |
| **Live** | Full-bleed 3D scene with a floating status card (facility · link state · sim clock · `MOCK` chip · min thermal margin / flow / incidents) and a three-detent glass sheet (peek / half / full). The sheet shows the pinned incident — severity, five-step stepper, live status line, **operator approval banner with countdown ring and Hold / Approve**, verification checks (before → after), hypotheses — or, when you tap an object, a contextual inspector (readings with units, simulator truth, robotic access, linked incidents, Focus / Follow / Enter pipe). One finger orbits, two fingers pinch-zoom and pan, tap selects, double-tap focuses. Camera presets: Whole · Plant · Zone A · Zone B. **Pipe cam** drops inside a crawler-passable segment (lit only by the crawler lamp) with a Front / Section toggle and a telemetry strip. |
| **Incidents** | Open / resolved list with severity, status, mini stepper and elapsed sim time → detail screen with the full card, evidence, missions and the **agent trace**: SENTINEL / INPIPE / OUTRIG tasks as a vertical timeline (lane colour, status, outcome, model chip `provider · model_id`, expandable tool calls with JSON input / output). |
| **Fleet** | Internal (INPIPE) / External (OUTRIG) robots: battery, mode, pose, current mission steps, **Follow** (jumps to Live and chases the robot) and Robot cam. |
| **System** | Backend `MOCK` / `LIVE`, engine health, intelligence provider and model, sim speed and pause / resume, and — behind an "Engineering test controls" disclosure — fault injection for testing. |

Haptics mark new incidents, approval requests, approvals, verifier outcomes and mode changes. Reduce Motion is
respected (system setting is mirrored into the scene and Reanimated).

## Run it

```bash
pnpm install                 # from the repo root (node-linker=hoisted is required for Expo)
pnpm dev:api                 # simulator-backed API → http://localhost:8787 (prints a LAN URL too)
pnpm dev:mobile              # Expo dev server; press `i` for the iOS Simulator, or scan the QR in Expo Go
```

The app picks its backend like this:

1. `EXPO_PUBLIC_API_URL` if set — e.g. `EXPO_PUBLIC_API_URL=http://192.168.1.20:8787 pnpm dev:mobile`
2. otherwise the machine Metro is served from, on port `8787` (so a physical phone on the same Wi-Fi just works)
3. otherwise `http://localhost:8787` (iOS Simulator)

If the backend is down the app keeps retrying and shows "Can't reach the facility backend". No credentials are
stored or sent by the client.

Expo Go is enough — every native module used (expo-gl, expo-blur, expo-haptics, Reanimated, Gesture Handler,
react-native-svg) ships in it.

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
src/app/            Expo Router — (tabs)/index = Live, incidents/, fleet/, system/
src/components/     ui kit (Glass, Chip, Ring, Segmented…), live/ (canvas, sheet, inspector, pipe cam),
                    incident/ (stepper, approval, verification, agent trace), fleet/
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
