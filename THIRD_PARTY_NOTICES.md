# Third-party notices

This repository's frontends depend on open-source packages installed from npm, each under its own license (see `node_modules/*/LICENSE`):
three.js, @react-three/fiber, @react-three/drei (MIT) · React, React DOM, React Native, Expo (MIT) · zustand (MIT) · motion (MIT) · lucide-react (ISC) · Geist fonts via @fontsource (SIL OFL 1.1) · Vite (MIT) · ws (MIT).

The simulator in `packages/core/src/engine` is original code. It does **not** vendor CompOpt, pandapipes, WNTR or any other upstream project; the backend team's planned use of those projects (backend.md §1) is tracked separately in the backend repository's `docs/engineering/upstreams.md`.

All 3D assets are procedural geometry authored in this repository. No third-party meshes or textures are used.
