"""Seeded, serialisable RNG streams (numpy PCG64). Separate streams per concern so that read-only calls never
perturb physics, and call patterns cannot change the trajectory."""
from __future__ import annotations

import numpy as np


class Rng:
    def __init__(self, seed: int, stream: int):
        self.g = np.random.Generator(np.random.PCG64(np.random.SeedSequence([int(seed) & 0xFFFFFFFF, int(stream)])))

    def random(self) -> float:
        return float(self.g.random())

    def uniform(self, lo: float, hi: float) -> float:
        return lo + (hi - lo) * float(self.g.random())

    def normal(self) -> float:
        return float(self.g.standard_normal())

    def bounded_normal(self, sigma: float, bound_sigmas: float) -> float:
        return max(-bound_sigmas, min(bound_sigmas, self.normal())) * sigma

    def pick(self, xs):
        return xs[int(self.g.random() * len(xs)) % len(xs)]

    def get_state(self) -> dict:
        return _plain(self.g.bit_generator.state)

    def set_state(self, st: dict) -> None:
        self.g.bit_generator.state = st


def _plain(x):
    if isinstance(x, dict):
        return {k: _plain(v) for k, v in x.items()}
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, (np.floating,)):
        return float(x)
    return x
