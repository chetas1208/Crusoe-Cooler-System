# Third-party notices

This repository's frontends depend on open-source packages installed from npm, each under its own license (see `node_modules/*/LICENSE`):
three.js, @react-three/fiber, @react-three/drei (MIT) · React, React DOM, React Native, Expo (MIT) · zustand (MIT) · motion (MIT) · lucide-react (ISC) · Geist fonts via @fontsource (SIL OFL 1.1) · Vite (MIT) · ws (MIT).

The simulator in `packages/core/src/engine` is original code. It does **not** vendor CompOpt, pandapipes, WNTR or any other upstream project; the backend team's planned use of those projects (backend.md §1) is tracked separately in the backend repository's `docs/engineering/upstreams.md`.

All 3D assets are procedural geometry authored in this repository. No third-party meshes or textures are used.

## Python backend dependencies (installed, not vendored)
* **psycopg 3** (PostgreSQL driver) — LGPL-3.0. Used as an unmodified installed library; replaceable by the user.
* **pandapipes** (BSD-3-Clause), **CompOpt** (MIT, per its pyproject; the pinned clone ships no separate LICENSE file), **MuJoCo** (Apache-2.0), **LangGraph / langgraph-checkpoint-postgres** (MIT), **FastAPI** (MIT), **Pydantic** (MIT), **openai** Python SDK (Apache-2.0), **NumPy** (BSD-3-Clause), **Gymnasium** (MIT).
* **NVIDIA Nemotron** models are served by Crusoe Managed Inference; model licenses are the providers' and are not redistributed here. **Laya** (Apache-2.0 per its repository; checkpoint license not independently verified).

