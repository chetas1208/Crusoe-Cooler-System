"""Hydraulic <-> thermal coupling (custom, deterministic; backend.md §5).

  m_dot = rho(T) * Q_vol          (Q_vol from the pandapipes solve, rho at the local loop temperature)
  Q     = m_dot * cp * dT         (sensible heat; cp constant per fluid so energy is conserved exactly)
  CDU   = eps-NTU counterflow exchanger between two isolated loops: heat crosses, mass does not.

State is held in CompOpt CoolantLoop volumes (adapters/thermal_compopt.py): rack coolant (inside RackThermal),
TCS return header, CDU secondary side, FWS side of the CDU.
"""
from __future__ import annotations

import math
from typing import Any

from .adapters.thermal_compopt import LoopVolume, RackThermal
from .fluids import Fluid


def hx_effectiveness(ntu: float, cr: float) -> float:
    """Counterflow effectiveness."""
    if abs(1.0 - cr) < 1e-4:
        return ntu / (1.0 + ntu)
    e = math.exp(-ntu * (1.0 - cr))
    return (1.0 - e) / (1.0 - cr * e)


class AuxRackThermal:
    """Lumped low-density rack (network / storage / CPU): first-order coolant outlet and chip lag, no CompOpt chip model.
    Same interface as RackThermal for everything the coupling needs. Deterministic, no randomness."""

    def __init__(self, cp: float, aux: dict[str, float], t_init_c: float):
        self.cp = cp
        self.r_th = float(aux["r_th_k_per_kw"])
        self.tau_out, self.tau_chip = float(aux["tau_out_s"]), float(aux["tau_chip_s"])
        self.q_w = 0.0
        self.t_in = self.t_out = self.t_chip = float(t_init_c)
        self.m = 0.0

    def set_heat(self, rack_w: float) -> None:
        self.q_w = float(rack_w)

    def _targets(self, t_in: float, m: float) -> tuple[float, float]:
        q_kw = self.q_w / 1e3
        t_out = t_in + self.q_w / (m * self.cp) if m > 0.02 else t_in + 0.5 * q_kw
        t_out = min(t_out, t_in + 80.0)
        return t_out, 0.5 * (t_in + t_out) + self.r_th * q_kw

    def step(self, dt: float, t_in_c: float, rack_m_kg_s: float) -> None:
        self.t_in, self.m = float(t_in_c), float(max(rack_m_kg_s, 0.0))
        t_out, t_chip = self._targets(self.t_in, self.m)
        self.t_out += (t_out - self.t_out) * min(1.0, dt / self.tau_out)
        self.t_chip += (t_chip - self.t_chip) * min(1.0, dt / self.tau_chip)

    @property
    def t_out_c(self) -> float:
        return self.t_out

    @property
    def t_chip_c(self) -> float:
        return self.t_chip

    def coolant_heat_w(self) -> float:
        return self.m * self.cp * (self.t_out - self.t_in)

    def initialise_steady(self, rack_w: float, t_in_c: float, rack_m_kg_s: float) -> None:
        self.set_heat(rack_w)
        self.t_in, self.m = float(t_in_c), float(rack_m_kg_s)
        self.t_out, self.t_chip = self._targets(self.t_in, self.m)

    def get_state(self) -> dict[str, Any]:
        return {"q": self.q_w, "t_in": self.t_in, "t_out": self.t_out, "t_chip": self.t_chip, "m": self.m}

    def set_state(self, s: dict[str, Any]) -> None:
        self.q_w, self.t_in, self.t_out, self.t_chip, self.m = (float(s[k]) for k in ("q", "t_in", "t_out", "t_chip", "m"))


class ThermalNetwork:
    def __init__(self, cfg: dict[str, Any], racks: list[str], fluids: dict[str, Fluid], aux_racks: list[str] | None = None):
        th = cfg["physics"]["thermal"]
        self.cfg = cfg
        self.th = th
        self.fluids = fluids
        self.cp_t, self.cp_f = fluids["tcs"].cp, fluids["fws"].cp
        design_rack_m = th.get("rack_design_flow_kg_s") or th["ua_design_flow"]["tcs"] / len(racks)
        t0 = 33.0
        rho_t = fluids["tcs"].rho(43.0)
        self.rack: dict[str, Any] = {
            r: RackThermal(th["gpu_preset"], th["n_chips_per_rack"], th["r_scale"], th["power_split"], th["chip_tau_s"],
                           design_rack_m, self.cp_t, rho_t, t0) for r in racks}
        for r in aux_racks or []:
            self.rack[r] = AuxRackThermal(self.cp_t, th["aux"], t0)
        self.racks = [*racks, *(aux_racks or [])]
        m_t, m_f = th["ua_design_flow"]["tcs"], th["ua_design_flow"]["fws"]
        self.ret = LoopVolume(th["return_tau_s"], m_t, self.cp_t, rho_t, 50.0)
        self.sec = LoopVolume(th["cdu_secondary_tau_s"], m_t, self.cp_t, rho_t, t0)
        self.fws = LoopVolume(th["fws_tau_s"], m_f, self.cp_f, fluids["fws"].rho(31.0), 35.0)
        self.q_hx_w = 0.0
        self.eff = 0.0
        self.ntu = 0.0
        self.guard_tripped: str | None = None
        # facility heat-rejection plant (CR-03): design duty and the supply-temperature rise above the chiller setpoint
        # that appears when the plant cannot remove the heat the CDU hands it (see _facility_step). 0 when healthy.
        self.q_design_w = 0.0
        self.facility_rise_k = 0.0
        self.facility_cap_w = None            # None = plant healthy (diagnostic / truth)

    # ---------------------------------------------------------------- CDU
    def cdu_duty(self, t_hot_in: float, m_hot: float, t_cold_in: float, m_cold: float) -> tuple[float, float, float]:
        th = self.th
        mn = th["min_flow_kg_s"]
        mh, mc = max(m_hot, mn), max(m_cold, mn)
        ch, cc = mh * self.cp_t, mc * self.cp_f
        cmin, cmax = min(ch, cc), max(ch, cc)
        n = th["ua_flow_exponent"]
        ua = th["ua0_w_k"] * (mh / th["ua_design_flow"]["tcs"]) ** n * (mc / th["ua_design_flow"]["fws"]) ** n
        ntu = ua / cmin
        eff = hx_effectiveness(ntu, cmin / cmax)
        q = max(eff * cmin * (t_hot_in - t_cold_in), 0.0)
        return q, eff, ntu

    # ---------------------------------------------------------------- init
    def initialise_steady(self, loads_w: dict[str, float], rack_m: dict[str, float], m_fws: float, fws_in_c: float) -> None:
        q_tot = sum(loads_w.values())
        m_tot = max(sum(rack_m.values()), self.th["min_flow_kg_s"])
        # closed form: Q = eff*Cmin*(T_ret - T_fws_in) and T_sup = T_ret - Q/Ct
        _, eff, ntu = self.cdu_duty(100.0, m_tot, fws_in_c, m_fws)
        cmin = min(m_tot * self.cp_t, m_fws * self.cp_f)
        t_ret = fws_in_c + q_tot / (eff * cmin)
        t_sup = t_ret - q_tot / (m_tot * self.cp_t)
        for r in self.racks:
            self.rack[r].initialise_steady(loads_w[r], t_sup, max(rack_m[r], 1e-3))
        self.ret.set_temperature(t_ret)
        self.sec.set_temperature(t_sup)
        self.fws.set_temperature(fws_in_c + q_tot / (m_fws * self.cp_f))
        self.q_hx_w, self.eff, self.ntu = q_tot, eff, ntu
        self.q_design_w = q_tot
        self.facility_rise_k = 0.0

    # ---------------------------------------------------------------- step
    @property
    def t_supply(self) -> float:
        return self.sec.t_c

    @property
    def t_return(self) -> float:
        return self.ret.t_c

    def step(self, dt: float, loads_w: dict[str, float], q_vol_rack: dict[str, float], q_vol_fws: float,
             fws_in_c: float, facility: dict[str, Any] | None = None) -> dict[str, float]:
        """Advance thermal state by dt. Returns mass flows used (kg/s) for diagnostics.
        `fws_in_c` is the water temperature entering the CDU (the plant adds `facility_rise_k` to the chiller setpoint);
        `facility` is FaultState.facility (CR-03) or None/{} for a healthy heat-rejection plant."""
        ft, ff = self.fluids["tcs"], self.fluids["fws"]
        t_sup = self.sec.t_c
        rho_t = ft.rho(t_sup)
        m_rack = {r: rho_t * q_vol_rack[r] for r in self.racks}
        m_tcs = sum(m_rack.values())
        m_fws = ff.rho(fws_in_c) * q_vol_fws
        mix_num = mix_den = 0.0
        for r in self.racks:
            rt = self.rack[r]
            rt.set_heat(loads_w[r])
            rt.step(dt, t_sup, m_rack[r])
            if m_rack[r] > 1e-3:
                mix_num += m_rack[r] * rt.t_out_c
                mix_den += m_rack[r]
        t_mix = mix_num / mix_den if mix_den > 0 else self.ret.t_c
        self.ret.step(dt, t_mix, m_tcs, 0.0)
        q, self.eff, self.ntu = self.cdu_duty(self.ret.t_c, m_tcs, fws_in_c, m_fws)
        self.q_hx_w = q
        self.sec.step(dt, self.ret.t_c, m_tcs, -q)
        self.fws.step(dt, fws_in_c, m_fws, +q)
        self._facility_step(dt, facility)
        self._guard()
        return {"tcs": m_tcs, "fws": m_fws, **{f"rack:{r}": m for r, m in m_rack.items()}}

    def _facility_step(self, dt: float, facility: dict[str, Any] | None) -> None:
        """Facility heat-rejection plant with finite capacity Q_cap = cap_frac * rated_margin * Q_design.

        The plant holds the setpoint while it can remove the heat the CDU rejects into the FWS loop (q_hx). Above capacity
        the facility water buffer (C = buffer_j_per_k) heats at (q_hx - Q_cap)/C, so the supply temperature rises above
        setpoint (`facility_rise_k`, capped at rise_max_k = plant trip/limit); below capacity the buffer recovers at the same
        rate. Energy-conserving: the heat the CDU can no longer reject accumulates in the TCS loop and the chips, so the
        only containment is to cut the heat load (or restore the plant). Healthy plant: the rise decays with tau_rec."""
        if not facility or not facility.get("active"):
            self.facility_cap_w = None
            if self.facility_rise_k > 0.0:
                tau = float(self.th.get("facility_recover_tau_s", 120.0))
                self.facility_rise_k *= math.exp(-dt / tau)
                if self.facility_rise_k < 1e-3:
                    self.facility_rise_k = 0.0
            return
        cap = facility["cap_frac"] * facility["rated_margin"] * self.q_design_w
        self.facility_cap_w = cap
        d = (self.q_hx_w - cap) / facility["buffer_j_per_k"] * dt
        self.facility_rise_k = min(max(self.facility_rise_k + d, 0.0), facility["rise_max_k"])

    def _guard(self) -> None:
        lo, hi = self.th["temp_guard_c"]["min"], self.th["temp_guard_c"]["max"]
        self.guard_tripped = None
        temps = [self.sec.t_c, self.ret.t_c, self.fws.t_c] + [self.rack[r].t_chip_c for r in self.racks]
        for t in temps:
            if not (lo <= t <= hi) or t != t:
                self.guard_tripped = f"temperature {t:.1f} C outside [{lo}, {hi}]"
                break
        if self.guard_tripped:  # clamp so state stays finite; flagged degraded by the plant
            for v in (self.sec, self.ret, self.fws):
                v.set_temperature(min(max(v.t_c, lo), hi))

    # ---------------------------------------------------------------- persistence
    def get_state(self) -> dict[str, Any]:
        return {"rack": {r: self.rack[r].get_state() for r in self.racks},
                "ret": self._lv(self.ret), "sec": self._lv(self.sec), "fws": self._lv(self.fws),
                "q_hx": self.q_hx_w, "eff": self.eff, "ntu": self.ntu,
                "q_design": self.q_design_w, "fac_rise": self.facility_rise_k}

    @staticmethod
    def _lv(v: LoopVolume) -> dict[str, float]:
        return {"t": float(v.loop.T_coolant_C), "t_in": float(v.loop.T_in_C), "m": float(v.loop.m_dot_kg_s)}

    def set_state(self, s: dict[str, Any]) -> None:
        for r in self.racks:
            self.rack[r].set_state(s["rack"][r])
        for name in ("ret", "sec", "fws"):
            lv = getattr(self, name)
            lv.loop.T_coolant_C, lv.loop.T_in_C, lv.loop.m_dot_kg_s = s[name]["t"], s[name]["t_in"], s[name]["m"]
        self.q_hx_w, self.eff, self.ntu = float(s["q_hx"]), float(s["eff"]), float(s["ntu"])
        self.q_design_w, self.facility_rise_k = float(s.get("q_design", self.q_hx_w)), float(s.get("fac_rise", 0.0))
