"""V11 eval fixtures: the nine scenarios mapped onto VALID engine fault parameters (reusing scenarios.registry, never re-invented), the
held-out seed set, and the frozen hashed manifest. Fixture/seed hashes live in the manifest; prompts are hashed SEPARATELY
(arms.PROMPT_HASHES) so a prompt edit can never silently change what was evaluated."""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from ..scenarios.registry import ORDER, get_definition

Json = dict[str, Any]
ROOT = Path(__file__).resolve().parents[4]
MANIFEST_PATH = ROOT / "artifacts" / "v11" / "eval_manifest.json"
DEV_SEEDS = (3, 5, 8)                                   # used while writing prompts / rules; never evaluated
HELD_OUT_SEEDS = tuple(31001 + 17 * i for i in range(10))
FAULT_ONSET_S = 240.0
JITTER_S = 30.0                                          # onset = 240 +- 30 s derived from (seed, scenario): the only per-seed variation besides plant noise
WARMUP_S = 120.0                                         # healthy baseline is measured here (before any fault)
HORIZON_S = 1800.0

# What the plant can and cannot model for each requested scenario (verified by running them; see docs/engineering/V11_EVAL.md)
FIDELITY: dict[str, Json] = {
    "CR-01": {"fidelity": "real", "engine_fault": "pump_degradation(health->0.02)", "note": "TCS duty pump collapses; standby is NOT auto-started (speed 0 on both) so recovery needs switch_duty"},
    "CR-02": {"fidelity": "real", "engine_fault": "leak(p_hs_c orifice 2.8e-5 m2)", "note": "Torricelli leak + puddle hazard zone; recovery = isolate zone valve, replace section, reopen"},
    "CR-03": {"fidelity": "real_but_mild", "engine_fault": "set_chiller_setpoint(36 C)", "note": "FWS boundary warms the loop; margin falls to ~6 K at 240 s; only workload shedding is sanctioned (not the setpoint)"},
    "CR-04": {"fidelity": "PROXY", "engine_fault": "trip_pump(pump_t1)+trip_pump(pump_f1)", "note": "power_state/UPS/utility are NOT modelled (power_state stays online); the double contingency is approximated by two pump trips"},
    "CR-05": {"fidelity": "PROXY", "engine_fault": "workload_spike(rack_a1 +0.8 for 900 s)", "note": "no smoke/fire/arc model; an electrical overload is approximated by a thermal load spike; 'no autonomous repair in a hazard' is enforced by policy only"},
    "CR-06": {"fidelity": "real", "engine_fault": "strainer_blockage(strainer_02 omax .78)", "note": "multi-row starvation from a common restriction"},
    "CR-07": {"fidelity": "real", "engine_fault": "valve_stuck(valve_a1 .12)+sensor_drift(sn_flow_trunk offset .55)", "note": "stuck valve on a hero rack plus a biased trunk flow meter"},
    "MD-01": {"fidelity": "real", "engine_fault": "strainer_blockage(strainer_02 omax .48)", "note": "moderate restriction"},
    "MD-02": {"fidelity": "real_but_proxy_sensor", "engine_fault": "sensor_drift(sn_flow_trunk offset .45)", "note": "the registry calls it a temperature-sensor drift; the engine only models FLOW-sensor drift, so a flow meter is used"},
}


def sha(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def onset_for(seed: int, scenario_id: str) -> float:
    h = int(hashlib.sha256(f"{seed}:{scenario_id}".encode()).hexdigest()[:8], 16)
    return FAULT_ONSET_S + 0.5 * ((h % int(2 * JITTER_S / 0.5 + 1)) - int(JITTER_S / 0.5))


def fixture(scenario_id: str) -> Json:
    d = get_definition(scenario_id)
    return {"scenario_id": scenario_id, "label": d.label, "severity": d.severity, "faults": [{"operator": f.operator, "asset_id": f.asset_id, "offset_s": f.tick / 2 - FAULT_ONSET_S, "params": f.params} for f in d.fault_injections],
            "allowed_interventions": list(d.allowed_interventions), "disallowed_interventions": list(d.disallowed_interventions), **FIDELITY[scenario_id]}


def build_manifest() -> Json:
    fx = {s: fixture(s) for s in ORDER}
    body = {"schema": "lk.eval_manifest.v1", "scenarios": fx, "scenario_hashes": {s: sha(f) for s, f in fx.items()}, "held_out_seeds": list(HELD_OUT_SEEDS), "dev_seeds_never_evaluated": list(DEV_SEEDS),
            "onset_rule": f"onset_s = {FAULT_ONSET_S} + deterministic jitter in [-{JITTER_S}, +{JITTER_S}] from sha256(seed:scenario)", "warmup_s": WARMUP_S, "horizon_s": HORIZON_S,
            "plant_overrides": {"physics": {"faults": {"enabled": False}, "workload": {"wave_amplitude": 0.0}}, "note": "no random faults: the injected fault is the only disturbance"},
            "n_runs_per_arm": len(ORDER) * len(HELD_OUT_SEEDS)}
    body["manifest_sha256"] = sha(body)
    return body


def freeze(path: Path = MANIFEST_PATH) -> Json:
    m = build_manifest()
    if path.exists():
        old = json.loads(path.read_text())
        if old.get("manifest_sha256") != m["manifest_sha256"]:
            raise RuntimeError(f"eval manifest changed ({old.get('manifest_sha256','')[:12]} -> {m['manifest_sha256'][:12]}); the held-out set is frozen. Delete {path} to re-freeze deliberately.")
        return old
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(m, indent=1, sort_keys=True) + "\n")
    return m
