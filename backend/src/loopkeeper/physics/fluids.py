"""Coolant property correlations (SI). rho(T) is explicit per backend.md §5; cp is held constant per
fluid (config) so the thermal solver conserves energy exactly. Correlations are engineering approximations
over 5-80 C, not reference-grade property tables."""
from __future__ import annotations

import math


class Fluid:
    def __init__(self, kind: str, cp_j_kg_k: float):
        if kind not in ("water", "pg25"):
            raise ValueError(f"unknown fluid kind {kind!r}")
        self.kind = kind
        self.cp = float(cp_j_kg_k)

    def rho(self, t_c: float) -> float:
        """Density kg/m3."""
        if self.kind == "water":  # Tanaka et al. 2001 (valid 0-40 C), extended gently beyond
            t = max(0.0, min(t_c, 95.0))
            return 999.974950 * (1 - (t - 3.983035) ** 2 * (t + 301.797) / (522528.9 * (t + 69.34881)))
        return 1036.0 - 0.50 * t_c  # 25 % v/v propylene-glycol/water, ~20-60 C

    def mu(self, t_c: float) -> float:
        """Dynamic viscosity Pa.s (used for pipe friction only)."""
        if self.kind == "water":
            return 2.414e-5 * 10 ** (247.8 / (max(t_c, 0.0) + 273.15 - 140.0))
        return 3.3e-3 * math.exp(-0.0328 * (t_c - 20.0))
