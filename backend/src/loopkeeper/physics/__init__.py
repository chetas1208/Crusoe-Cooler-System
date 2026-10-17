"""Package A: physics. CompOpt thermal + pandapipes hydraulics + deterministic coupling behind interfaces.Plant."""
from .commands import COMMAND_KINDS
from .plant import FacilityPlant

__all__ = ["FacilityPlant", "COMMAND_KINDS", "create_plant"]


def create_plant(seed: int = 1, **kw) -> FacilityPlant:
    return FacilityPlant(seed, **kw)
