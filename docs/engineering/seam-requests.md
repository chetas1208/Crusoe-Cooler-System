# Seam requests / cross-package edits (package C: agents)

## Edits made in the engine package (minimal, listed for the owner)
All are needed so the agents' autonomous flow can actually complete on the real plant. Each is covered by `backend/tests/agents/test_policy_seams.py`.

| File | Change | Why |
|---|---|---|
| `engine/robots/actions.py` `PLANT_COMMANDS` | Map engine effects to the plant's real command kinds (`isolate_valve`, `reopen_valve`, `service_valve`, `brush_clear`, `replace_section`, `replace_strainer`, `replace_pump`, `recalibrate_sensor`, `switch_duty`, `set_load_factor`). They were `valve.isolate`, `pipe.brush_clear`... which the plant rejects as unknown, so every physical repair step failed. | root cause of failed repairs |
| `engine/robots/actions.py` `ACTIONS` | `replace_strainer.needs_isolation=False` (duplex changeover, no flow interruption; the trunk strainer cannot be isolated by a zone valve). Add `service_pump` (effect `replace_pump`) and `recalibrate_sensor` OUTRIG actions. | strainer/pump/sensor faults had no executable repair |
| `engine/robots/fleet.py` | OUTRIG tools += `pump kit`, `calibration kit`. | tool check for the two new actions |
| `engine/robots/missions.py` | `_plant_args()`: brush clearing sends `removed_fraction` (derived from deposit truth + seeded noise); other effects send no extra args (the plant rejects unknown keys). | plant `brush_clear` requires `removed_fraction` |
| `engine/sensing.py` `pressure_kpa` | Edges in `locks.isolated_edges` read 0 kPa (isolated segments are vented). The solver dead-end node kept reading ~420 kPa so `pressure_above_service_threshold` blocked every disassembly. | isolation interlock could never pass |
| `engine/commands.py` | Additive: `pump.switch_duty` (operator, agent; target = new duty pump). `workload.set_load` now sends the plant arg name `factor` (was `load_factor`, rejected by the plant). | standby swap during pump service; cordon/restore workload |

## Contract notes for the API owner
* `AgentRuntime.model_status()` returns the contract-compatible `status` (`live|unavailable|mock`) PLUS `model_state` (`live|degraded|unavailable|fallback`), `fallback_active`, `checkpointer` (`postgres|memory`), `restart_safe`. `contracts.ts` / `IntelligenceHealth` may want `model_state` surfaced.
* Agents never decide approvals: they emit `incident.approval` (pending) and read the engine-owned decision from `world.incidents[].approval.status`; `approval_id` is passed in the mission args.
* Agents rely on the engine to expand `params` (`gauge`, `action`, `isolate_valve`, `s_m`) into whitelisted steps (`MissionCreate.params`); they no longer send `steps`.
* Optional engine capability: `supports_twin_counterfactual` + a read-only `twin.counterfactual` command (what-if without a fault). Without it the verifier uses the self-calibrated healthy reference (`world.twin_reference` is honoured if the plant ever provides it).
* The agent trace is served by the engine from emitted `agent.task` / `agent.tool` events (unchanged). Tool inputs/outputs are redacted and size-capped before emission; raw engine reasons stay in tool output only, never in incident summaries.
