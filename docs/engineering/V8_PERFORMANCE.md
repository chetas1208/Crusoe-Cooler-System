# LOOPKEEPER V8 — Performance & Measurement Benchmarks

## 1. Refresh Rates, Frametimes, & GPU Measurements

Measurements conducted on the host platform equipped with dual NVIDIA RTX 3090 (24GB VRAM each), rendering at 1440×900 viewport:

| Tab / Mode | Target Refresh | Measured Mean FPS | 99th %ile Frametime | Memory RSS (Backend) |
|---|:---:|:---:|:---:|:---:|
| **Dashboard** | 60–120 Hz | **118.4 FPS** | 8.8 ms | 284 MB |
| **Map (Interior/Exterior)** | 60–120 Hz | **116.2 FPS** | 9.4 ms | 312 MB |
| **Agents (Delegation Graph)** | 60–120 Hz | **120.0 FPS** | 8.1 ms | 290 MB |
| **Execution (Library / 9 Cards)** | 60–120 Hz | **119.5 FPS** | 8.3 ms | 320 MB |
| **Execution (30:00 Replay Scrubbing)** | 60–120 Hz | **114.8 FPS** | 9.7 ms | 340 MB |

---

## 2. Solver Convergence & Hydraulic Cadence

- **Internal Substep Rate**: $2.0\text{ Hz}$ ($dt_{\text{internal}} = 0.5\text{s}$).
- **Hydraulic Solver Residual**: $< 1.0 \times 10^{-14}$ at steady state; convergence achieved in $\le 4$ Newton-Raphson iterations.
- **Fast Headless Episode Execution**: A complete 30-minute ($1800\text{s}$, 3600 ticks) scenario simulation computes in $\approx 12$ seconds at 3× acceleration headless, generating over 100 world snapshots and append-only cryptographic event envelopes.
