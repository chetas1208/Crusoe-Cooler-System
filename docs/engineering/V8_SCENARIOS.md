# LOOPKEEPER V8 — Scenario Registry & Physics Specifications

## 1. Overview of the Nine Typed Incidents

LOOPKEEPER V8 defines exactly nine first-class physical scenarios (7 SEVERE, 2 MODERATE) running on an exact 30:00 (1800 simulated seconds) horizon.

| Scenario ID | Severity | Title | Physics Operator | Target Asset | Default Outcome |
|:---:|:---:|---|---|---|:---:|
| **CR-01** | SEVERE | CDU Circulation Collapse | `pump_degradation` | `pump_t1` | `VERIFIED_RECOVERY` |
| **CR-02** | SEVERE | Manifold Rupture & Floor Flood | `leak` (Torricelli Orifice) | `p_hs_c` | `VERIFIED_RECOVERY` |
| **CR-03** | SEVERE | Heat Rejection Collapse | `set_chiller_setpoint` | `chiller_01` | `CONTAINED` |
| **CR-04** | SEVERE | Power & Cooling Double Contingency | `trip_pump` & UPS Domain | `pump_t1`, `pump_f1` | `CONTAINED` |
| **CR-05** | SEVERE | Electrical Rack Smoke/Fire | `workload_spike` & Emergency Trip | `rack_a1` | `CONTAINED` |
| **CR-06** | SEVERE | Multi-Row Fouling & Starvation | `strainer_blockage` | `strainer_02` | `VERIFIED_RECOVERY` |
| **CR-07** | SEVERE | Stuck Valve & Misleading Sensor | `valve_stuck`, `sensor_drift` | `valve_a1`, `sn_flow_trunk` | `VERIFIED_RECOVERY` |
| **MD-01** | MODERATE | Single-Rack Strainer Restriction | `strainer_blockage` | `strainer_02` | `VERIFIED_RECOVERY` |
| **MD-02** | MODERATE | Temperature-Sensor Drift | `sensor_drift` | `sn_flow_trunk` | `VERIFIED_RECOVERY` |

---

## 2. Detailed Scenario Profiles

### CR-01: CDU Circulation Collapse
- **Seed**: 12001
- **Fault Description**: TCS duty pump `pump_t1` experiences rapid impeller degradation (health drops to 0.02 within 2 seconds).
- **Physical Preconditions**: Both `pump_t1` and standby pump `pump_t2` available at CDU-01.
- **Intervention Plan**: At tick 640, standby pump duty swap (`pump.switch_duty` -> `pump_t2`), followed by workload shedding on adjacent racks.
- **Verification Rule**: Standby pump reaches nominal speed and head, loop flow restores to $> 18.0\text{ kg/s}$, all chip thermal margins $> -5\text{ K}$.

### CR-02: Manifold Rupture & Aisle Flood
- **Seed**: 12002
- **Fault Description**: Header pipe section `p_hs_c` ruptures with an orifice area of $2.8 \times 10^{-5}\text{ m}^2$, discharging liquid coolant into Road 02.
- **Physical Preconditions**: Sectional isolation valve `valve_zc` operational.
- **Hazard Dynamics**: Coolant puddle expands across Road 02; when radius $\ge 0.8\text{m}$, corridor is locked.
- **Intervention Plan**:
  1. Tick 480: Close sectional valve `valve_zc` to isolate rupture.
  2. Tick 720: Service robot replaces pipe segment `p_hs_c`.
  3. Tick 1000: Reopen `valve_zc`.
- **Verification Rule**: Leak rate zero, loop pressure stabilized, no active wet-zone hazard, solver converged.

### CR-03: Heat Rejection Collapse
- **Seed**: 12003
- **Fault Description**: FWS cooling tower / external chiller setpoint drifts upward from $18^\circ\text{C}$ to $36^\circ\text{C}$.
- **Intervention Plan**: Load curtailment to 0.25 on Racks A1, A2, B1, B2.
- **Verification Rule**: System contained within safe operating thermal limits without pump cavitation.

### CR-04: Power & Cooling Double Contingency
- **Seed**: 12004
- **Fault Description**: Utility substation trip knocks out primary power feeds for pumps and charger docks.
- **Intervention Plan**: Emergency load shedding to 0.0 on prioritized high-power compute racks; 15-minute battery reserve preserves telemetry.
- **Verification Rule**: Safe shutdown posture achieved before UPS exhaustion; zero uncommanded robot travel.

### CR-05: Electrical Rack Smoke/Fire
- **Seed**: 12005
- **Fault Description**: Electrical fire outbreak on `rack_a1` causing thermal heat surge and smoke generation ($3.6\text{m}$ radius exclusion perimeter).
- **Intervention Plan**: Emergency power trip on `rack_a1`, workload shed, robot fleet evacuated outside perimeter.
- **Verification Rule**: Prohibition of autonomous robotic entry into energized fire zone; rack power isolated; contained status verified.

### CR-06: Multi-Row Fouling & Starvation
- **Seed**: 12006
- **Fault Description**: Common secondary strainer `strainer_02` occludes to 78%, causing flow starvation across Racks B, C, D.
- **Intervention Plan**: Outdoor rover `OR-04` dispatches to replace strainer basket.
- **Verification Rule**: Occlusion cleared to 0.0, differential pressure drops below $5\text{ kPa}$, flow recovered.

### CR-07: Stuck Valve & Misleading Sensor Cascade
- **Seed**: 12007
- **Fault Description**: Balancing valve `valve_a1` sticks at 12% opening while primary flow sensor `sn_flow_trunk` drifts positively by $+0.55\text{ kg/s}$.
- **Counterfactual Challenge**: Verifier rejects premature success based on drifted sensor; requires physical valve service and sensor recalibration.
- **Verification Rule**: Independent dual verification passes only after physical service and zero calibration offset confirmed.
