# LOOPKEEPER V8 — Safety Scope & Verifiable Recovery

## 1. Safety Policies & Operational Invariants

LOOPKEEPER V8 enforces strict physical and operational safety boundaries to ensure simulations reflect genuine engineering constraints rather than fabricated outcomes:

1. **Hazard Zone Exclusion**:
   - In `CR-02` (Coolant Leak), floor puddles with $r \ge 0.8\text{m}$ lock the affected travel corridor. Autonomous robots may not traverse flooded roads until the rupture is physically isolated.
   - In `CR-05` (Electrical Smoke/Fire), a $3.6\text{m}$ exclusion perimeter is established. Autonomous firefighting or robotic camera inspection inside energized smoke boundaries is prohibited and rejected by safety policy.
2. **Authority & Separation of Powers**:
   - Robot motion and tool actuation are governed by explicit digital leases (`control.lease`).
   - High-risk physical interventions (e.g., valve servicing, pump cartridge replacement) require SENTINEL supervisory agent approval and deterministic precondition verification.
3. **Truth vs. Telemetry**:
   - Sensor drift (e.g., `sn_flow_trunk` in `CR-07` and `MD-02`) modifies measurement streams without corrupting true fluid physical state.
   - Verifier checks evaluate ground-truth hydraulic and thermal equations to ensure an intervention cannot claim victory based on a drifted sensor.

---

## 2. Recovery Verdict Taxonomy

Every completed episode terminates with a deterministic verdict:

- **`VERIFIED_RECOVERY`**: Fault cleared, physical parameters (flow, pressure, chip thermal margin) restored to within nominal tolerances, solver converged, zero active safety violations.
- **`CONTAINED`**: Catastrophic hazard arrested (e.g., power shed, rack tripped), critical telemetry preserved, safe shutdown posture achieved without uncontrolled escalation.
- **`SAFE_SHUTDOWN`**: Severe contingency where system safely halted within reserve limits (e.g., UPS power window).
- **`ESCALATED`**: Thermal runway ($T_{\text{chip}} > T_{\text{limit}}$), hydraulic non-convergence, or uncontained hazard breach.
- **`BLOCKED`**: Scenario rejected at onset due to missing assets or unsupported operator requests.
