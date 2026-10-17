import warnings
from pathlib import Path

import pytest

from loopkeeper.physics import FacilityPlant
from loopkeeper.physics.config import load_config

warnings.filterwarnings("ignore")

# The physics unit tests were written against the legacy two-zone 16-rack hall (ids p_12/p_17/valve_zb...). They keep running on
# it explicitly; the V6 five-row layout has its own tests (test_topology_v6.py, tests/agents, tests/test_v6_acceptance.py).
SMALL = Path(__file__).resolve().parents[2] / "configs" / "facility-small.yaml"


def make_plant(seed: int = 1, steady_load: bool = True, faults: bool = False, **over) -> FacilityPlant:
    ov = {"physics": {"faults": {"enabled": faults}}}
    if steady_load:
        ov["physics"]["workload"] = {"wave_amplitude": 0.0}
    for k, v in over.items():
        ov.setdefault("physics", {})[k] = v
    return FacilityPlant(seed, config=load_config(SMALL, overrides=ov))


def run(p: FacilityPlant, seconds: float, dt: float = 0.5) -> None:
    for _ in range(int(round(seconds / dt))):
        p.step(dt)


@pytest.fixture
def plant():
    return make_plant()
