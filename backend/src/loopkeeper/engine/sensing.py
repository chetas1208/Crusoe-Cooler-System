"""Robot sensing: observations are derived from the plant's current truth plus bounded noise from the engine's
seeded RNG (never invented narrative). Location-scoped: a crawler only sees a deposit within DETECT_RANGE_M."""
from __future__ import annotations

import math
from typing import TYPE_CHECKING

from .util import Json, round_to

if TYPE_CHECKING:  # pragma: no cover
    from .core import Engine

DETECT_RANGE_M = 3.0


class Sensing:
    def __init__(self, eng: "Engine"):
        self.eng = eng

    def _gauss(self) -> float:
        # Box-Muller from the engine RNG (fixed consumption: two uniforms per call)
        u = max(self.eng.rng.random(), 1e-9)
        v = self.eng.rng.random()
        return math.sqrt(-2.0 * math.log(u)) * math.cos(2.0 * math.pi * v)

    def inspect(self, robot, gauge: str) -> Json:
        eng = self.eng
        edge, s = robot.segment_id, float(robot.s_m or 0.0)
        truth = eng.assets_truth().get(edge) or {}
        fault = truth.get("fault") or {}
        occ = float(fault.get("occlusion") or 0.0)
        loc = fault.get("location_s_m")
        n1, n2, n3 = self._gauss(), self._gauss(), self._gauss()
        in_range = loc is not None and abs(s - float(loc)) <= DETECT_RANGE_M
        gain = 1.0 if (loc is None and occ > 0) else (max(0.0, 1.0 - abs(s - float(loc)) / DETECT_RANGE_M) if loc is not None else 0.0)
        occ_obs = max(0.0, min(1.0, occ * gain + 0.02 * n1))
        obs: Json = {"segment_id": edge, "s_m": round_to(s, 2), "gauge": gauge, "occlusion": round_to(occ_obs, 3),
                     "deposit_in_range": bool(in_range and occ > 0.02),
                     "deposit_s_m": round_to(float(loc) + 0.15 * n2, 2) if (in_range and loc is not None and occ > 0.02) else None,
                     "bore_clear": occ_obs < 0.1}
        sensors = [a for a in eng.topo["assets"] if a["type"] == "sensor" and a.get("edge_id") == edge]
        loc_read = {}
        for sa in sensors:
            for k, v in ((eng.assets_truth().get(sa["id"]) or {}).get("readings") or {}).items():
                loc_read[f"{sa['id']}.{k}"] = round_to(v * (1.0 + 0.005 * n3), 3)
        if loc_read:
            obs["local_readings"] = loc_read
        if gauge in ("deposit", "general"):
            obs["summary"] = (f"{occ_obs * 100:.0f}% of bore blocked near s={obs['deposit_s_m']} m" if obs["deposit_in_range"]
                              else "no deposit within sensor range")
        elif gauge == "bore":
            obs["summary"] = "bore clear" if obs["bore_clear"] else f"bore restricted ({occ_obs * 100:.0f}%)"
        else:
            obs["summary"] = "local flow sampled" if loc_read else "no flow sensor on this segment"
        return obs

    def scan(self, target_id: str) -> Json:
        st = self.eng.assets_truth().get(target_id) or {}
        r = {k: round_to(v, 3) for k, v in (st.get("readings") or {}).items()}
        return {"asset_id": target_id, "status": st.get("status", "unknown"), "readings": r, "suspect": list(st.get("suspect") or []),
                "summary": f"{target_id}: status {st.get('status', 'unknown')}"}

    def _truth_for(self, target_id: str) -> Json:
        eng = self.eng
        t = eng.assets_truth()
        st = t.get(target_id)
        if st is not None:
            return st
        a = eng.asset_index.get(target_id) or {}
        return t.get(a.get("edge_id", ""), {})

    def pressure_test(self, target_id: str, kpa: float, hold_s: float) -> Json:
        st = self._truth_for(target_id)
        edge_st = self._truth_for((self.eng.asset_index.get(target_id) or {}).get("edge_id", target_id))
        leak = float(((st.get("fault") or {}).get("leak_kg_s")) or ((edge_st.get("fault") or {}).get("leak_kg_s")) or 0.0)
        ok = leak < 1e-6
        return {"asset_id": target_id, "test_kpa": kpa, "hold_s": hold_s, "leak_kg_s": round_to(leak, 6), "hold_ok": ok,
                "summary": "hold ok" if ok else f"leak {leak:.4f} kg/s - hold failed"}

    def pressure_kpa(self, target_id: str) -> float | None:
        eng = self.eng
        # modelling assumption: once a zone is isolated its segments are vented to drain, so they read 0 kPa for the
        # service-pressure interlock (the dead-end node of the solver would otherwise keep reading supply pressure)
        edge0 = target_id if target_id in eng.graph.edges else (eng.asset_index.get(target_id) or {}).get("edge_id")
        if edge0 in eng.locks.isolated_edges:
            return 0.0
        cands = [target_id]
        a = eng.asset_index.get(target_id)
        if a and a.get("edge_id"):
            cands.append(a["edge_id"])
        if target_id in eng.graph.edges:
            cands.extend(x["id"] for x in eng.topo["assets"] if x.get("edge_id") == target_id and x["type"] == "sensor")
        else:
            cands.extend(x["id"] for x in eng.topo["assets"] if x.get("edge_id") == (a or {}).get("edge_id") and x["type"] == "sensor")
        for c in cands:
            v = ((eng.assets_truth().get(c) or {}).get("readings") or {}).get("pressure_kpa")
            if v is not None:
                return float(v)
        return None

    def racks_cordoned(self, valve_id: str) -> bool:
        eng = self.eng
        z = (eng.asset_index.get(valve_id) or {}).get("zone_id")
        zone = next((x for x in eng.topo["zones"] if x["id"] == z), None)
        if not zone:
            return True
        limit = eng.cfg.cordon_max_load_frac * eng.topo["limits"]["nominal_rack_kw"]
        for rid in zone["rack_ids"]:
            p = ((eng.assets_truth().get(rid) or {}).get("readings") or {}).get("power_kw")
            if p is not None and p > limit:
                return False
        return True
