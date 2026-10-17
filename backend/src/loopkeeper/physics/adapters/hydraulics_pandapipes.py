"""pandapipes adapter: quasi-steady, incompressible, closed-loop hydraulics.

One `PipeNetwork` = one pandapipes net = one closed loop (FWS or TCS are solved separately so no mass
crosses the CDU). The adapter owns: network construction from a plain element spec, in-place parameter
updates (diameter / loss coefficient / valve state / pump curve), dead-end pruning (pandapipes cannot
solve zero-flow branches), damped retry on non-convergence, and a mass-balance residual.

It is NOT a transient solver: no water hammer, no thermal inertia, no CFD (backend.md §5).
Units in/out: SI at the edge of this module (m, kg/s, Pa); pandapipes' bar/mm/km are internal.
"""
from __future__ import annotations

import logging
import time
import warnings
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandapipes as pp
from pandapipes.pf.pipeflow_setup import PipeflowNotConverged
from pandapipes.properties.fluids import _add_fluid_to_net

log = logging.getLogger(__name__)

P_REF_BAR = 3.0  # absolute reference pressure fixed by the expansion tank (ext_grid)


@dataclass
class SolveResult:
    converged: bool
    residual: float = 0.0
    reason: str | None = None
    iterations_tried: int = 0
    wall_ms: float = 0.0
    # element mass flows kg/s (signed along from->to), at the constant solve density
    mdot: dict[str, float] = field(default_factory=dict)
    dp_pa: dict[str, float] = field(default_factory=dict)       # p_from - p_to for pipes/valves, lift for pumps
    ext_grid_mdot: float = 0.0
    junction_p_pa: dict[str, float] = field(default_factory=dict)
    active: dict[str, bool] = field(default_factory=dict)       # element carries flow (after pruning)


class PipeNetwork:
    def __init__(self, name: str, rho: float, mu: float, cp: float, solver: dict[str, Any], roughness_mm: float):
        self.name = name
        self.solver = solver
        self.roughness_mm = roughness_mm
        self.net = pp.create_empty_network(name, add_stdtypes=True)
        self._set_fluid(rho, mu, cp)
        self.junctions: dict[str, int] = {}
        self.pipes: dict[str, dict] = {}
        self.valves: dict[str, dict] = {}
        self.pumps: dict[str, dict] = {}
        self.ext_grid_junction: str | None = None
        self._rho = rho
        self._dirty_tables = True
        self.last: SolveResult | None = None

    # ------------------------------------------------------------------ build
    def _set_fluid(self, rho: float, mu: float, cp: float) -> None:
        fl = pp.create_constant_fluid(f"{self.name}_fluid", "liquid", density=float(rho), viscosity=float(mu),
                                      heat_capacity=float(cp), compressibility=0.0)
        _add_fluid_to_net(self.net, fl, overwrite=True)
        self._rho = float(rho)

    def set_fluid(self, rho: float, mu: float, cp: float) -> None:
        self._set_fluid(rho, mu, cp)

    @property
    def rho(self) -> float:
        return self._rho

    def junction(self, name: str) -> int:
        if name not in self.junctions:
            self.junctions[name] = int(pp.create_junction(self.net, pn_bar=P_REF_BAR, tfluid_k=300.0, name=name))
        return self.junctions[name]

    def add_pipe(self, name: str, a: str, b: str, length_m: float, d_mm: float, k_loss: float = 0.0) -> None:
        idx = pp.create_pipe_from_parameters(self.net, self.junction(a), self.junction(b), length_km=length_m / 1000.0,
                                             inner_diameter_mm=d_mm, k_mm=self.roughness_mm, loss_coefficient=k_loss, name=name)
        self.pipes[name] = dict(idx=int(idx), a=a, b=b, length_m=length_m, d_mm=d_mm, k=k_loss, in_service=True)
        self._dirty_tables = True

    def add_valve(self, name: str, a: str, b: str, d_mm: float, k_loss: float, opened: bool = True) -> None:
        idx = pp.create_valve(self.net, self.junction(a), self.junction(b), et="ju", inner_diameter_mm=d_mm,
                              opened=opened, loss_coefficient=k_loss, name=name)
        self.valves[name] = dict(idx=int(idx), a=a, b=b, d_mm=d_mm, k=k_loss, opened=opened)
        self._dirty_tables = True

    def add_pump(self, name: str, a: str, b: str, h0_pa: float, in_service: bool = True) -> None:
        """Constant-lift pump. pandapipes evaluates the pump lift once per Newton iteration without a
        derivative, so a flow-dependent curve H0 - aQ^2 makes the iteration unstable on flat system curves.
        The exact equivalent is used instead: constant lift H0 in series with a loss element K=a (added by the
        caller, see FacilityHydraulics); delivered head = lift - dp(series element)."""
        idx = pp.create_pump_from_parameters(self.net, self.junction(a), self.junction(b), name,
                                             poly_coefficents=self._pump_coeffs(h0_pa), name=name, in_service=in_service)
        self.pumps[name] = dict(idx=int(idx), a=a, b=b, in_service=in_service, h0=h0_pa)
        self._dirty_tables = True

    def set_ext_grid(self, junction: str) -> None:
        self.ext_grid_junction = junction
        pp.create_ext_grid(self.net, self.junction(junction), p_bar=P_REF_BAR, t_k=300.0)

    @staticmethod
    def _pump_coeffs(h0_pa: float) -> list[float]:
        # pandapipes: lift[bar] = c2*q^2 + c1*q + c0 with q in m3/h; constant lift -> c2=c1=0
        return [0.0, 0.0, h0_pa / 1e5]

    # ----------------------------------------------------------------- update
    def set_pipe(self, name: str, *, d_mm: float | None = None, length_m: float | None = None,
                 k_loss: float | None = None, in_service: bool | None = None) -> None:
        p = self.pipes[name]
        if d_mm is not None: p["d_mm"] = float(d_mm)
        if length_m is not None: p["length_m"] = float(length_m)
        if k_loss is not None: p["k"] = float(k_loss)
        if in_service is not None: p["in_service"] = bool(in_service)
        self._dirty_tables = True

    def set_valve(self, name: str, *, k_loss: float | None = None, opened: bool | None = None) -> None:
        v = self.valves[name]
        if k_loss is not None: v["k"] = float(k_loss)
        if opened is not None: v["opened"] = bool(opened)
        self._dirty_tables = True

    def set_pump(self, name: str, *, h0_pa: float | None = None, in_service: bool | None = None) -> None:
        p = self.pumps[name]
        if h0_pa is not None: p["h0"] = float(h0_pa)
        if in_service is not None: p["in_service"] = bool(in_service)
        self._dirty_tables = True

    # ------------------------------------------------------------------ solve
    def _prune(self) -> dict[str, bool]:
        """Mark elements that can carry flow. Iteratively strip dead-end (degree-1) junctions."""
        elems: dict[str, tuple[str, str]] = {}
        for n, p in self.pipes.items():
            if p["in_service"]: elems[n] = (p["a"], p["b"])
        for n, v in self.valves.items():
            if v["opened"]: elems[n] = (v["a"], v["b"])
        for n, p in self.pumps.items():
            if p["in_service"]: elems[n] = (p["a"], p["b"])
        alive = set(elems)
        deg: dict[str, int] = {}
        for n in alive:
            for j in elems[n]:
                deg[j] = deg.get(j, 0) + 1
        changed = True
        while changed:
            changed = False
            for n in list(alive):
                a, b = elems[n]
                if deg.get(a, 0) <= 1 or deg.get(b, 0) <= 1:
                    alive.discard(n)
                    deg[a] -= 1
                    deg[b] -= 1
                    changed = True
        return {n: (n in alive) for n in list(self.pipes) + list(self.valves) + list(self.pumps)}

    def _write_tables(self, active: dict[str, bool]) -> None:
        net = self.net
        if self.pipes:
            order = sorted(self.pipes.values(), key=lambda p: p["idx"])
            names = [n for n, _ in sorted(self.pipes.items(), key=lambda kv: kv[1]["idx"])]
            net.pipe["inner_diameter_mm"] = np.array([p["d_mm"] for p in order], dtype=float)
            net.pipe["length_km"] = np.array([p["length_m"] / 1000.0 for p in order], dtype=float)
            net.pipe["loss_coefficient"] = np.array([p["k"] for p in order], dtype=float)
            net.pipe["in_service"] = np.array([active[n] for n in names], dtype=bool)
        if self.valves:
            names = [n for n, _ in sorted(self.valves.items(), key=lambda kv: kv[1]["idx"])]
            order = [self.valves[n] for n in names]
            net.valve["loss_coefficient"] = np.array([v["k"] for v in order], dtype=float)
            net.valve["opened"] = np.array([active[n] for n in names], dtype=bool)
        for n, p in self.pumps.items():
            net.std_types["pump"][n].reg_par = np.array(self._pump_coeffs(p["h0"]), dtype=float)
            net.pump.loc[p["idx"], "in_service"] = bool(active[n])

    def solve(self) -> SolveResult:
        t0 = time.perf_counter()
        active = self._prune()
        pumps_alive = any(active[n] for n in self.pumps)
        eg = self.ext_grid_junction
        if not pumps_alive or eg is None:
            res = SolveResult(True, 0.0, "no running pump", 0, 0.0, active=active,
                              mdot={n: 0.0 for n in active}, dp_pa={n: 0.0 for n in active})
            res.wall_ms = (time.perf_counter() - t0) * 1e3
            self.last = res
            return res
        self._write_tables(active)
        sv = self.solver
        reason = "not attempted"
        tried = 0
        for alpha in sv["alpha_sequence"]:
            tried += 1
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    pp.pipeflow(self.net, mode="hydraulics", max_iter=int(sv["max_iter"]), alpha=float(alpha),
                                tol_p=float(sv["tol"]), tol_m=float(sv["tol"]), tol_res=float(sv["tol"]), init="flat")
            except PipeflowNotConverged as exc:
                reason = f"pipeflow not converged (alpha={alpha}): {str(exc)[:80]}"
                continue
            except Exception as exc:  # solver internals; never leak a trace to callers
                reason = f"pipeflow error ({type(exc).__name__})"
                log.warning("pandapipes failure on %s: %s", self.name, exc)
                continue
            if not bool(getattr(self.net, "converged", False)):
                reason = f"pipeflow reported non-convergence (alpha={alpha})"
                continue
            res = self._extract(active)
            res.iterations_tried = tried
            if not np.isfinite(res.residual) or res.residual > 5e-3:
                reason = f"mass residual {res.residual:.2e} too high"
                continue
            res.wall_ms = (time.perf_counter() - t0) * 1e3
            self.last = res
            return res
        res = SolveResult(False, float("inf"), reason, tried, (time.perf_counter() - t0) * 1e3, active=active)
        return res

    def _extract(self, active: dict[str, bool]) -> SolveResult:
        net = self.net
        mdot: dict[str, float] = {}
        dp: dict[str, float] = {}
        for n, p in self.pipes.items():
            if not active[n]:
                mdot[n], dp[n] = 0.0, 0.0
                continue
            r = net.res_pipe.loc[p["idx"]]
            mdot[n] = float(r["mdot_from_kg_per_s"])
            dp[n] = float(r["p_from_bar"] - r["p_to_bar"]) * 1e5
        for n, v in self.valves.items():
            if not active[n]:
                mdot[n], dp[n] = 0.0, 0.0
                continue
            r = net.res_valve.loc[v["idx"]]
            mdot[n] = float(r["mdot_from_kg_per_s"])
            dp[n] = float(r["p_from_bar"] - r["p_to_bar"]) * 1e5
        for n, p in self.pumps.items():
            if not active[n]:
                mdot[n], dp[n] = 0.0, 0.0
                continue
            r = net.res_pump.loc[p["idx"]]
            mdot[n] = float(r["mdot_from_kg_per_s"])
            dp[n] = float(r["deltap_bar"]) * 1e5
        eg_m = float(net.res_ext_grid["mdot_kg_per_s"].iloc[0]) if len(net.res_ext_grid) else 0.0
        jp = {n: float(net.res_junction.loc[i, "p_bar"]) * 1e5 for n, i in self.junctions.items()
              if not np.isnan(net.res_junction.loc[i, "p_bar"])}
        # junction mass-balance residual (relative to the largest loop flow)
        bal: dict[str, float] = {}
        def acc(j: str, m: float) -> None: bal[j] = bal.get(j, 0.0) + m
        for coll in (self.pipes, self.valves, self.pumps):
            for n, e in coll.items():
                if active[n]:
                    acc(e["a"], -mdot[n]); acc(e["b"], mdot[n])
        if self.ext_grid_junction:
            acc(self.ext_grid_junction, eg_m)
        scale = max(max((abs(v) for v in mdot.values()), default=0.0), 0.1)
        resid = max((abs(v) for v in bal.values()), default=0.0) / scale
        resid = max(resid, abs(eg_m) / scale)
        return SolveResult(True, float(resid), None, 0, 0.0, mdot, dp, eg_m, jp, active)
