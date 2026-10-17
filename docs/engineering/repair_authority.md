# LOOPKEEPER V4 — Governed Repair Authority & Safety Architecture

**Revision:** 2026-10-16  
**Status:** Implemented & Double-Enforced (API + WorldEngine)

---

## 1. Governance Principles

LOOPKEEPER implements physical AI with strict boundaries:
1. **No Autonomous Plant Shutdown:** AI agents can propose, investigate, and simulate minor restorative tasks, but high-consequence interventions require deterministic validation and operator sign-off.
2. **Double Enforcement:** Repair policies and authority levels are checked at the REST/WebSocket API boundary via Pydantic models **and** re-evaluated in the single-writer `WorldEngine` state machine prior to commit.
3. **Causal Consequence:** Virtual repairs modify physical parameters in the `pandapipes` and `CompOpt` hydraulic/thermal models (e.g., pipe resistance factor, strainer friction coefficient). A repair is only logged as successful if independent downstream sensors demonstrate thermal-hydraulic recovery.

---

## 2. Four-Tier Authority Hierarchy (L0 – L3)

| Authority Level | Scope | Preconditions & Interlocks | Autonomy | Example Actions |
|---|---|---|:---:|---|
| **L0 — Observe** | Visual, thermal, ultrasonic inspection | Robot within observation radius; target asset exists | **Fully Autonomous** | `inspect`, `sample`, `scan`, `pressure_test`, `navigate`, `move_to` |
| **L1 — Minor Restore** | Local non-disruptive remediation | Pre-approved access, isolated or low-pressure segment, equipped robot tooling | **Autonomous (Pre-approved)** | `brush_clear` (retractable brush on crawlers), `recalibrate_sensor` |
| **L2 — Bounded Service** | Component replacement in isolated conditions | Standby loop active, work order assigned, isolation plan verified | **Conditional / Whitelisted** | `replace_strainer` (duplex basket swap), `service_valve`, `clamp_accessible_leak` |
| **L3 — High Impact** | Plant isolation, pump shutdown, pipe section replacement | Operator digital signature, thermal safety envelope verified, interlocks satisfied | **Approval Required (Human Gate)** | `isolate_valve`, `replace_section` |

---

## 3. Double-Enforcement Mechanism

### A. API / Agent Seam Enforcement:
Every proposed action must deserialize into the `ProposedToolAction` schema:

```python
class ProposedToolAction(BaseModel):
    run_id: str
    robot_id: str
    incident_id: str
    target_asset_id: str
    tool_name: str
    requested_level: AuthorityLevel
    preconditions_evidence_ids: list[str]
    expected_world_revision: int
    idempotency_key: str
    approved_work_order_id: str | None = None
```

If an L3 action is submitted without `approved_work_order_id`, the API rejects the proposal immediately with HTTP 403 / `approval_required`.

### B. WorldEngine Commit Gate:
At commit time within the single-writer engine tick, `missions.py` re-checks:
- Robot tool inventory (`robot.hw["tools"]`) against required action tools.
- Resource reservation locks on the target segment or valve.
- State of approval request: `self._approval_ok(approval_id, incident_id)`.
- If unapproved, the engine terminates the mission with deterministic status `approval_required` and refuses to apply plant effects.

---

## 4. Manual Human Takeover & Deadman Safety

- **Exclusive Leases:** An operator acquires an exclusive control lease via `POST /robots/{id}/control/lease`. The lease provides exclusive driving authority.
- **Autonomous Mission Suspension:** When manual lease is granted, the robot transitions to `LEASE_PENDING` and then `MANUAL`. Autonomous trajectory motors suspend immediately.
- **Deadman Safe-Stop:** Leases require periodic heartbeat and drive commands within a strict deadman window (`deadman_s = 1.5 s`). If the client network drops or browser closes, the engine triggers a safe-stop (`SAFE_HOLD`) and expires the lease back to `AUTONOMOUS`.
- **Tool Authority Isolation:** Manual driving does **not** grant tool execution authority. An operator driving a crawler or OUTRIG unit cannot bypass L2/L3 repair interlocks.
