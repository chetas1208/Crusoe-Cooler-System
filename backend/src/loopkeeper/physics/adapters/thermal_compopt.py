"""CompOpt adapter: rack/chip thermal RC stepping and coolant control volumes.

Uses CompOpt's *public* physics classes directly (compopt.physics.chip.GPUChipModel / make_gpu / PowerProfile,
compopt.physics.fluids.CoolantLoop). The Gymnasium envs are not used: they own the clock and hide flow/heat
inputs, whereas the physics classes accept both through public attributes:
  * heat      -> PowerProfile callables (we feed them from a holder updated each step)
  * coolant   -> CoolantLoop.m_dot_kg_s and CoolantLoop.T_in_C (public dataclass fields)
No private CompOpt state is mutated. (compopt.physics.fluids.CDU is not used: its fixed lumped UA cannot
respond to flow; the CDU exchanger lives in coupling.py.)

Representative-chip scaling: one H100-class CompOpt GPU model per rack, scaled by `n_chips`
(per-chip power = rack power / n_chips; per-chip flow = rack flow / n_chips). A modelling assumption, not
a per-GPU simulation.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
from compopt.physics.chip import GPU_PRESETS, GPUChipModel, PowerProfile, make_gpu
from compopt.physics.fluids import CoolantLoop


class LoopVolume:
    """Well-mixed coolant control volume (CompOpt CoolantLoop) with externally supplied inlet T, flow and heat."""

    def __init__(self, tau_s: float, design_m_kg_s: float, cp: float, rho: float, t_init_c: float):
        v = tau_s * design_m_kg_s / rho
        self.loop = CoolantLoop(T_in_C=t_init_c, m_dot_kg_s=design_m_kg_s, c_p_J_kgK=cp, V_m3=v, rho_kg_m3=rho)
        self.cp = cp

    @property
    def t_c(self) -> float:
        return self.loop.T_coolant_C

    def set_temperature(self, t_c: float) -> None:
        self.loop.T_coolant_C = float(t_c)

    def step(self, dt: float, t_in_c: float, m_dot: float, q_in_w: float) -> None:
        self.loop.T_in_C = float(t_in_c)
        self.loop.m_dot_kg_s = float(max(m_dot, 0.0))
        self.loop.step(dt, Q_in_W=float(q_in_w))


@dataclass
class ChipSteady:
    t_nodes: np.ndarray
    t_die_max: float


class RackThermal:
    """One rack = one representative CompOpt GPU model x n_chips."""

    def __init__(self, preset: str, n_chips: int, r_scale: float, power_split: dict[str, float], tau_s: float,
                 design_rack_m_kg_s: float, cp: float, rho: float, t_init_c: float):
        if preset not in GPU_PRESETS:
            raise ValueError(f"unknown CompOpt GPU preset {preset!r}")
        self.n = int(n_chips)
        self.cp = cp
        self._power = {"tiles": 0.0, "hbm": 0.0, "vrm": 0.0, "pcb": 0.0}
        split = power_split
        self._split = split
        preset_p = GPU_PRESETS[preset]
        nx, ny = int(preset_p["nx_tiles"]), int(preset_p["ny_tiles"])
        n_tiles = nx * ny
        funcs: dict[str, Any] = {}
        for r in range(ny):
            for c in range(nx):
                funcs[f"tile_{r}_{c}"] = (lambda t, s=self: s._power["tiles"] / n_tiles)
        funcs["HBM"] = lambda t, s=self: s._power["hbm"]
        funcs["VRM"] = lambda t, s=self: s._power["vrm"]
        funcs["PCB"] = lambda t, s=self: s._power["pcb"]
        v = tau_s * (design_rack_m_kg_s / self.n) / rho
        coolant = CoolantLoop(T_in_C=t_init_c, m_dot_kg_s=design_rack_m_kg_s / self.n, c_p_J_kgK=cp, V_m3=v, rho_kg_m3=rho)
        self.chip: GPUChipModel = make_gpu(
            preset, power_profile=PowerProfile(funcs), coolant_loop=coolant,
            R_tile_to_coolant_K_W=preset_p["R_tile_to_coolant_K_W"] * r_scale,
            T_init_die_C=t_init_c + 20.0, T_init_others_C=t_init_c + 15.0)
        self.t_max_die = float(preset_p["T_max_die_C"])

    # ---------------------------------------------------------------- inputs
    def set_heat(self, rack_w: float) -> None:
        p = rack_w / self.n
        s = self._split
        tot = s["tiles"] + s["hbm"] + s["vrm"] + s["pcb"]
        for k in self._power:
            self._power[k] = p * s[k] / tot

    def step(self, dt: float, t_in_c: float, rack_m_kg_s: float) -> None:
        loop = self.chip.coolant_loop
        loop.T_in_C = float(t_in_c)
        loop.m_dot_kg_s = float(max(rack_m_kg_s, 0.0)) / self.n
        self.chip.step(dt)

    # ---------------------------------------------------------------- outputs
    @property
    def t_out_c(self) -> float:
        return self.chip.coolant_loop.T_coolant_C

    @property
    def t_chip_c(self) -> float:
        """Hottest die tile (GPU junction)."""
        return float(self.chip.get_observation()[1])

    @property
    def t_hbm_c(self) -> float:
        return float(self.chip.get_observation()[2])

    def coolant_heat_w(self) -> float:
        """Enthalpy rise of the rack coolant, W (public fields only)."""
        loop = self.chip.coolant_loop
        return self.n * loop.m_dot_kg_s * self.cp * (loop.T_coolant_C - loop.T_in_C)

    # ---------------------------------------------------------------- steady state
    def _g_cool(self) -> np.ndarray:
        """Coolant conductances per node, rebuilt from the chip's public R parameters."""
        c = self.chip
        g = np.zeros(len(c.node_names))
        for i, name in enumerate(c.node_names):
            if name.startswith("tile_"):
                g[i] = 1.0 / c.R_tile_to_coolant_K_W
            elif name == "HBM":
                g[i] = 1.0 / c.R_hbm_to_coolant_K_W
            elif name == "VRM":
                g[i] = 1.0 / c.R_vrm_to_coolant_K_W
            elif name == "PCB":
                g[i] = 1.0 / c.R_pcb_to_coolant_K_W
        return g

    def steady_state(self, rack_w: float, t_cool_c: float) -> ChipSteady:
        """Solve (G + diag(g_cool)) T = P + g_cool T_cool with the chip's own conductance matrix."""
        self.set_heat(rack_w)
        c = self.chip
        p = c.power_profile.power_vector(0.0, c.node_names)
        g = self._g_cool()
        t = np.linalg.solve(c.G_W_K + np.diag(g), p + g * t_cool_c)
        tiles = [i for i, n in enumerate(c.node_names) if n.startswith("tile_")]
        return ChipSteady(t, float(np.max(t[tiles])))

    def initialise_steady(self, rack_w: float, t_in_c: float, rack_m_kg_s: float) -> None:
        self.set_heat(rack_w)
        loop = self.chip.coolant_loop
        m_chip = rack_m_kg_s / self.n
        t_out = t_in_c + (rack_w / self.n) / (m_chip * self.cp)
        loop.T_in_C, loop.m_dot_kg_s, loop.T_coolant_C = float(t_in_c), float(m_chip), float(t_out)
        self.chip.T_C = self.steady_state(rack_w, t_out).t_nodes.copy()

    # ---------------------------------------------------------------- persistence
    def get_state(self) -> dict[str, Any]:
        c = self.chip
        return {"T": [float(x) for x in c.T_C], "time": float(c.time_s), "t_cool": float(c.coolant_loop.T_coolant_C),
                "t_in": float(c.coolant_loop.T_in_C), "m": float(c.coolant_loop.m_dot_kg_s),
                "p": {k: float(v) for k, v in self._power.items()}, "rep": float(c._reported_power_W)}

    def set_state(self, s: dict[str, Any]) -> None:
        c = self.chip
        c.T_C = np.array(s["T"], dtype=float)
        c.time_s = float(s["time"])
        c.coolant_loop.T_coolant_C = float(s["t_cool"])
        c.coolant_loop.T_in_C = float(s["t_in"])
        c.coolant_loop.m_dot_kg_s = float(s["m"])
        self._power = {k: float(v) for k, v in s["p"].items()}
        c._reported_power_W = float(s["rep"])
