"""Named soak scenarios. Horizon is overridden by SOAK_SIM_S (seconds) / SOAK_SIM_HOURS; seeds by SOAK_SEED. Used by the pytest wrappers and scripts/soak/run_one.py."""
from __future__ import annotations

import os

from soak_lib import SoakConfig


def horizon(default_s: float) -> float:
    if os.environ.get("SOAK_SIM_S"):
        return float(os.environ["SOAK_SIM_S"])
    if os.environ.get("SOAK_SIM_HOURS"):
        return float(os.environ["SOAK_SIM_HOURS"]) * 3600.0
    return default_s


def seed(default: int) -> int:
    return int(os.environ.get("SOAK_SEED", default))


def build(name: str, **over) -> SoakConfig:
    h = horizon(3600.0)
    s = seed(11)
    base = dict(name=name, seed=s, horizon_s=h)
    if name == "faults":                               # all fault kinds, random + operator arrivals, no other chaos
        base.update(inject_mean_gap_s=260.0, hazards=True, mean_gap_s=300.0, replay_pairs=6)
    elif name == "restarts":
        base.update(inject_mean_gap_s=420.0, restarts=max(3, int(h / 900)), mean_gap_s=400.0)
    elif name == "outages":
        base.update(inject_mean_gap_s=420.0, model_outages=max(3, int(h / 700)), mean_gap_s=400.0, model_rates={"503": 0.03, "429": 0.02, "timeout": 0.02, "garbage": 0.05, "slow": 0.06})
    elif name == "dbfail":
        base.update(inject_mean_gap_s=420.0, db_windows=max(4, int(h / 600)), mean_gap_s=400.0)
    elif name == "leases":
        base.update(inject_mean_gap_s=360.0, leases=max(6, int(h / 300)), mean_gap_s=360.0)
    elif name == "concurrent":
        base.update(inject_mean_gap_s=600.0, bursts=max(4, int(h / 600)), pauses=max(2, int(h / 1800)), mean_gap_s=500.0, replay_pairs=4)
    elif name == "spend":
        base.update(inject_mean_gap_s=300.0, hog=True, token_budget=12000, mean_gap_s=400.0)
    elif name == "hostile":
        base.update(inject_mean_gap_s=360.0, model_outages=max(3, int(h / 600)), model_windows=("hostile_concur", "garbage"), mean_gap_s=400.0)
    elif name == "everything":
        n = max(1, int(h / 3600.0))
        base.update(inject_mean_gap_s=240.0, hazards=True, restarts=3 * n, model_outages=5 * n, db_windows=4 * n, leases=8 * n, bursts=3 * n, pauses=n, hog=True,
                    mean_gap_s=300.0, model_rates={"503": 0.02, "429": 0.01, "timeout": 0.01, "garbage": 0.03, "slow": 0.04})
    elif name == "postgres":
        base.update(inject_mean_gap_s=420.0, restarts=3, model_outages=2, db_windows=3, leases=3, mean_gap_s=400.0, horizon_s=horizon(1800.0), quiesce_s=1950.0)
    elif name == "determinism":                        # identical inputs twice -> identical hashes (no wall-clock-dependent chaos: leases carry random uuids)
        base.update(inject_mean_gap_s=400.0, restarts=2, model_outages=2, db_windows=2, bursts=1, mean_gap_s=400.0, horizon_s=horizon(1500.0), quiesce_s=600.0)
    else:
        raise KeyError(name)
    if os.environ.get("SOAK_QUIESCE_S"):
        base["quiesce_s"] = float(os.environ["SOAK_QUIESCE_S"])
    base.update(over)
    return SoakConfig(**base)
