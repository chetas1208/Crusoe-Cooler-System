# LOOPKEEPER V8 — Engineering Architecture

## 1. System Overview & Authoritative Single Writer

LOOPKEEPER V8 is an autonomous physical-AI data center operational simulation and crisis execution platform. It combines high-fidelity hydraulic and thermal physics, deterministic fleet robotics, supervisory multi-agent intelligence, and an explorable 3D digital twin.

```mermaid
flowchart TD
    subgraph Physics Engine [Deterministic Multi-Physics Core]
        Pandapipes[Pandapipes Closed-Loop Hydraulics]
        CompOpt[CompOpt Fluid & Thermal Solver]
        LeakModel[Torricelli Orifice Coolant Leak Model]
        PowerModel[Power Outage & UPS Contingency Simulator]
        FireModel[Rack Thermal Surge & Fire Proxy]
    end

    subgraph State Authority [Single Writer Engine]
        Engine[Authoritative Simulation Engine]
        EpisodeClock[Integer Nanosecond Server Clock - 30:00 Horizon]
        CommandBus[Deterministic Validated Command Bus]
        Verifier[Independent Recovery & Safety Verifier]
    end

    subgraph Storage [Neon PostgreSQL / Cloud Persistence]
        NeonDB[(Neon Postgres Database)]
        Ledger[Append-Only Event Ledger]
        Checkpoints[World Snapshots & Hashes]
    end

    subgraph Client [High-Performance Browser GPU Rendering]
        R3F[React Three Fiber / Three.js 3D Viewport]
        HazardVisualizer[Dynamic Leak & Fire Perimeters]
        OverlayPanels[Reversible Hide/Collapse Overlays]
        Player[Exact 30:00 Replay & Fork Controller]
    end

    Physics Engine --> Engine
    Engine --> NeonDB
    Engine --> Ledger
    Engine --> Checkpoints
    Engine -->|WebSockets / REST| Client
    Client -->|Command Requests| CommandBus
    CommandBus --> Engine
    Verifier --> Engine
```

---

## 2. Hardware Truthfulness & Rendering Architecture

- **Host Specifications**: Dual NVIDIA GeForce RTX 3090 GPUs (24GB VRAM each).
- **GPU Encoding Reality**: The host binary of `ffmpeg` lacks NVENC compilation (`Unknown encoder 'h264_nvenc'`).
- **Verified Rendering Path**: Client-side GPU rendering via React Three Fiber and Three.js with progressive geometry caching and instancing. Zero fabricated WebRTC streams or fictional remote streaming is claimed.
- **Physics Authority**: 100% server-authoritative on Python 3.11 with `pandapipes`, `scipy`, and deterministic physical state managers.

---

## 3. Physical Hazard Models

### 3.1 Torricelli Coolant Orifice Discharge (`CR-02`)
Liquid coolant loss is modeled through standard hydrodynamic orifice discharge:
$$q_{\text{leak}} = C_d \cdot A_{\text{orifice}} \cdot \sqrt{2 \cdot \rho \cdot \Delta P}$$
where:
- $C_d = 0.62$ (discharge coefficient)
- $\rho = 1000\text{ kg/m}^3$ (water/glycol mixture)
- $\Delta P$ is the instantaneous loop gauge pressure at the affected section.

The lost inventory dynamically derates the expansion tank pressure and TCS pump suction head. On the facility floor, puddle spreading is modeled by volume conservation over a $5\text{mm}$ thin liquid film:
$$r_{\text{puddle}} = \sqrt{\frac{V_{\text{coolant}}}{\pi \cdot 0.005}}$$
When $r_{\text{puddle}} \ge 0.8\text{m}$, the affected corridor (`HAZARD_ROAD_02`) transitions to `road_blocked = True`, prohibiting rover entry until isolated.

### 3.2 Power Contingency Domain (`CR-04`)
Simulates common-mode utility substation loss:
- Primary pump duty power drops, triggering zero-head trip.
- Robot charging stations enter battery preservation mode.
- Critical control electronics and telemetry transition to a 15-minute UPS battery reserve domain ($900\text{s}$).
- Autonomous survival policies enforce immediate compute load shedding.

### 3.3 Electrical Rack Fire & Thermal Surge (`CR-05`)
Simulates catastrophic electrical arc/thermal overload on rack `rack_a1`:
- Thermal heat surge injects $+48\text{ kW}$ to $+80\text{ kW}$ directly into the rack thermal circuit.
- Dynamic smoke perimeter exclusion zone expands to a radius of $3.6\text{m}$.
- Automated safety policies mandate emergency electrical rack isolation and forbid autonomous firefighting inside energized smoke perimeters.

---

## 4. Reversible Overlay Architecture

The V8 user interface features an overlay management store (`ExecutionPanelsStore`) providing:
1. **Scenario Library Overlay**: 9 first-class scenario definition cards.
2. **Runs & Branches Panel**: Stored run history and branch tree.
3. **Run Inspector Panel**: Verifier results, checks, and manual intervention controls.
4. **Timeline Player Panel**: 30:00 exact horizon scrub bar, speed multipliers (1×, 2×, 3×), and event markers.
5. **Dismissal & Reopening**: Every panel provides an `×` close button, and the top rail allows instantaneous, reversible expansion/collapse of all overlays or individual panels. Keyboard `Esc` toggles overlay visibility without terminating simulation state.
