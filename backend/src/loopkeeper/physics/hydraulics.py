"""Facility-specific hydraulic model: builds the two pandapipes loops (TCS, FWS) from the Topology and maps
physical state (fouling, valve opening, pump health, isolation) to effective network parameters.

Fault semantics (backend.md §5):
  * pipe fouling / blockage -> a deposit section of reduced effective diameter D_eff = D(1-occlusion) over
    `foul_extent` of the run (friction recomputed by pandapipes) + Borda-Carnot contraction/expansion K_loss.
  * strainer blockage -> K_loss ~ K0 / (1-occlusion)^2 (occlusion = blocked fraction of mesh area).
  * stuck valve -> effective opening replaces commanded opening: K = K_bal (theta_bal/theta)^2.
  * pump aging -> head curve multiplier floor + (1-floor)*health (affinity-law speed scaling on top).
The TS reference simulator lumps these as K; here friction/K emerge from geometry and are solved by pandapipes.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .adapters.hydraulics_pandapipes import PipeNetwork, SolveResult
from .fluids import Fluid

Json = dict[str, Any]


@dataclass
class HydInputs:
    occl: dict[str, float]               # pipe edge id / strainer id -> 0..1
    occl_s: dict[str, float]             # deposit centre along edge (m)
    valve_cmd: dict[str, float]          # rack key -> commanded opening 0..1
    valve_stuck: dict[str, float]        # rack key -> effective opening when stuck
    isolated: dict[str, bool]            # valve_/pump_ ids closed or out of service for work
    pump_run: dict[str, bool]            # pump id -> running (duty & not failed)
    pump_speed: dict[str, float]         # loop -> speed fraction
    pump_head_mult: dict[str, float]     # pump id -> head multiplier (aging)
    rho: dict[str, float]                # loop -> density at current loop temperature
    mu: dict[str, float]


@dataclass
class HydResult:
    converged: bool
    reason: str | None
    residual: float
    q: dict[str, float]                  # loop -> volumetric flow m3/s ('tcs','fws')
    zone_q: dict[str, float]             # 'a','b' m3/s
    rack_q: dict[str, float]             # rack key -> m3/s
    edge_q: dict[str, float]             # edge id -> m3/s
    edge_dp_pa: dict[str, float]
    edge_p_pa: dict[str, float]          # absolute pressure at the edge's upstream end (ref: expansion-tank setpoint)
    strainer_dp_pa: dict[str, float]
    pump_head_pa: dict[str, float]       # loop -> lift of running pump
    ext_grid_kg_s: dict[str, float]
    mass_balance: dict[str, float]       # loop -> |sum split flows - trunk| / trunk
    wall_ms: float = 0.0
    tried: int = 0

    def zero(self) -> bool:
        return self.q["tcs"] <= 0 and self.q["fws"] <= 0


class FacilityHydraulics:
    def __init__(self, topo: Json, cfg: Json, fluids: dict[str, Fluid]):
        self.cfg = cfg
        hc = cfg["physics"]["hydraulics"]
        self.hc = hc
        self.kd = hc["k_design"]
        self.topo = topo
        self.fluids = fluids
        self.edges = {e["id"]: e for e in topo["edges"]}
        fac = cfg["facility"]
        self.racks = [r["id"] for r in fac["racks"]]                       # instrumented (fault-target) racks
        self.aux_racks = [r["id"] for r in fac.get("aux_racks", [])]       # lighter network / storage / CPU racks
        self.all_racks = self.racks + self.aux_racks
        every = [*fac["racks"], *fac.get("aux_racks", [])]
        self.rack_zone = {r["id"]: r["zone"] for r in every}
        self.rack_drops = {r["id"]: (r.get("supply_drop_id") or f"p_{r['supply_drop']}", r.get("return_drop_id") or f"p_{r['return_drop']}") for r in every}
        self.zone_hdr = fac.get("zone_headers") or {"a": {"supply": "p_12", "return": "p_22"}, "b": {"supply": "p_17", "return": "p_27"}}
        self.zones = sorted(self.zone_hdr)
        self.rack_dn = {r["id"]: (25.0 if "kw" in r else 40.0) for r in every}
        # aux cold-plate resistance: same branch pressure drop as a GPU rack at its own (lower) design flow
        aux_dt = cfg["physics"]["thermal"].get("aux", {}).get("dt_k", 12.0)
        cp_t = fluids["tcs"].cp
        self.rack_kcp: dict[str, float] = {r: cfg["physics"]["hydraulics"]["k_design"]["cold_plate"] for r in self.racks}
        for r in fac.get("aux_racks", []):
            m = r["kw"] * 1000.0 / (cp_t * aux_dt)
            self.rack_kcp[r["id"]] = cfg["physics"]["hydraulics"]["k_design"]["cold_plate"] * 1.5 ** 2 / (m * m)
        self.pumps_cfg = {pid: loop for pid, _l, _n, loop, _p, _e, _s in cfg["facility"]["pumps"]}
        self.pump_ids = {"tcs": [p for p, l in self.pumps_cfg.items() if l == "tcs"],
                         "fws": [p for p, l in self.pumps_cfg.items() if l == "fws"]}
        # which passable edges carry fouling sections, and the series device (strainer/zone valve) on them
        passable = {e["id"] for e in topo["edges"] if e["robot_passable"]}
        self.device: dict[str, str] = {a["edge_id"]: a["id"] for a in topo["assets"]
                                       if a["type"] in ("strainer", "valve") and a.get("edge_id") in passable and
                                       (a["type"] == "strainer" or a["id"].startswith("valve_z"))}
        self.design_rho = {l: fluids[l].rho(cfg["physics"]["fluids"][l]["design_t_c"]) for l in ("tcs", "fws")}
        self.nets: dict[str, PipeNetwork] = {}
        self._edge_design_k: dict[str, float] = {}
        self._build()

    # ----------------------------------------------------------------- helpers
    def _kconv(self, k_kpa: float, d_mm: float, loop: str) -> float:
        """Lumped resistance K [kPa/(kg/s)^2] -> dimensionless loss coefficient k for diameter d (dp = k rho v^2 / 2)."""
        a = math.pi * (d_mm / 1000.0) ** 2 / 4.0
        return 2000.0 * k_kpa * self.design_rho[loop] * a * a

    def _junction(self, name: str) -> str:
        # rack taps are lumped onto the zone header end nodes (racks in a zone are in parallel)
        for r in self.all_racks:
            z = self.rack_zone[r]
            if name == f"n_{r}_s":
                return f"n_{z}_s_end"
            if name == f"n_{r}_r":
                return f"n_{z}_r_end"
        return name

    def _edge_k(self, eid: str) -> float:
        kd = self.kd
        fixed = {"p_10": kd["tcs_trunk_s"], "p_20": kd["tcs_trunk_r"], "p_01": kd["fws_p01"], "p_02": kd["fws_p02"], "p_03": kd["fws_p03"]}
        if eid in fixed:
            return fixed[eid]
        e = self.edges[eid]
        if e.get("zone_id"):                                   # row header
            return kd["header_s"] if e["role"] == "supply" else kd["header_r"]
        if eid in ("p_12", "p_17"):                            # legacy two-zone layout
            return kd["header_s"]
        if eid in ("p_22", "p_27"):
            return kd["header_r"]
        return kd.get("trunk_seg_s", 0.05) if e["role"] == "supply" else kd.get("trunk_seg_r", 0.05)   # inter-row trunk segment

    def _build(self) -> None:
        ph = self.cfg["physics"]
        sv, rough = self.hc["solver"], self.hc["pipe_roughness_mm"]
        for loop in ("tcs", "fws"):
            fl = self.fluids[loop]
            t = ph["fluids"][loop]["design_t_c"]
            self.nets[loop] = PipeNetwork(loop, fl.rho(t), fl.mu(t), fl.cp, sv, rough)
        kd = self.kd
        for eid, e in self.edges.items():
            if not e["robot_passable"]:
                continue
            loop = e["loop"]
            net = self.nets[loop]
            a, b = self._junction(e["from"]), self._junction(e["to"])
            L, D = e["length_m"], float(e["diameter_mm"])
            dev = self.device.get(eid)
            end = f"{eid}~3" if dev else b
            net.add_pipe(f"{eid}.pre", a, f"{eid}~1", L * 0.375, D, 0.0)
            net.add_pipe(f"{eid}.dep", f"{eid}~1", f"{eid}~2", L * self.hc["foul_extent"], D, 0.0)
            net.add_pipe(f"{eid}.post", f"{eid}~2", end, L * (1 - 0.375 - self.hc["foul_extent"]), D,
                         self._kconv(self._edge_k(eid), D, loop))
            if dev:
                net.add_valve(dev, end, b, D, self._kconv(kd["zone_valve_open"], D, loop) if dev.startswith("valve") else
                              self._kconv(kd["tcs_strainer"] if loop == "tcs" else kd["fws_strainer"], D, loop), True)
        tcs = self.nets["tcs"]
        for r in self.all_racks:
            z = self.rack_zone[r]
            sd, rd = self.rack_drops[r]
            dn = self.rack_dn[r]
            zs, zr = f"n_{z}_s_end", f"n_{z}_r_end"
            L_s, L_r = self.edges[sd]["length_m"], self.edges[rd]["length_m"]
            tcs.add_valve(f"valve_{r}", zs, f"{sd}~v", dn, self._kconv(kd["valve_balanced"], dn, "tcs"), True)
            tcs.add_pipe(sd, f"{sd}~v", f"n_{r}_in", L_s, dn, self._kconv(kd["drop"], dn, "tcs"))
            tcs.add_pipe(f"coldplate_{r}", f"n_{r}_in", f"n_{r}_out", self.hc["cold_plate_len_m"], dn,
                         self._kconv(self.rack_kcp[r], dn, "tcs"))
            tcs.add_pipe(rd, f"n_{r}_out", zr, L_r, dn, self._kconv(kd["drop"], dn, "tcs"))
        tcs.add_pipe("cdu_hx", "n_cdu_tr", "j_tcs_pin", 1.0, 150.0, self._kconv(kd["tcs_hx"], 150.0, "tcs"))
        tcs.set_ext_grid("j_tcs_pin")
        fws = self.nets["fws"]
        fws.add_pipe("cdu_hx", "n_cdu_fs", "n_cdu_fr", 1.0, 200.0, self._kconv(kd["fws_hx"], 200.0, "fws"))
        fws.add_pipe("chiller", "n_fws_chiller_r", "j_fws_pin", 1.0, 200.0, self._kconv(kd["fws_chiller"], 200.0, "fws"))
        fws.set_ext_grid("j_fws_pin")
        pc = ph["hydraulics"]["pumps"]
        for loop, net, out in (("tcs", tcs, "n_cdu_ts"), ("fws", fws, "n_fws_chiller_s")):
            pin = "j_tcs_pin" if loop == "tcs" else "j_fws_pin"
            for pid in self.pump_ids[loop]:
                # series loss K=a reproduces the quadratic head curve H = H0 - a Q^2 exactly (see add_pump)
                net.add_pump(pid, pin, f"{pid}~o", pc[loop]["h0_kpa"] * 1000.0 * pc[loop]["speed"] ** 2, True)
                net.add_pipe(f"{pid}.int", f"{pid}~o", out, 1.0, 150.0, self._kconv(pc[loop]["a_kpa_per_kgs2"], 150.0, loop))

    # --------------------------------------------------------------- configure
    def configure(self, inp: HydInputs) -> dict[str, float]:
        """Write effective parameters into the nets. Returns a signature dict for re-solve detection;
        keys ending in '!' are discrete (flags), others continuous."""
        hc, ph = self.hc, self.cfg["physics"]
        sig: dict[str, float] = {}
        for loop, net in self.nets.items():
            net.set_fluid(inp.rho[loop], inp.mu[loop], self.fluids[loop].cp)
            sig[f"rho:{loop}"] = inp.rho[loop]
        # pipes with deposits
        for eid, e in self.edges.items():
            if not e["robot_passable"]:
                continue
            loop = e["loop"]
            net = self.nets[loop]
            o = min(max(inp.occl.get(eid, 0.0), 0.0), 0.97)
            D, L = float(e["diameter_mm"]), e["length_m"]
            ext = hc["foul_extent"]
            dep_len = L * ext
            centre = inp.occl_s.get(eid, 0.5 * L)
            pre = min(max(centre - dep_len / 2, 0.02 * L), L - dep_len - 0.02 * L)
            post = L - pre - dep_len
            beta = (1 - o) ** 2
            k_c = 0.5 * (1 - beta) + (1 - beta) ** 2
            net.set_pipe(f"{eid}.pre", length_m=pre)
            net.set_pipe(f"{eid}.dep", length_m=dep_len, d_mm=D * (1 - o), k_loss=k_c)
            net.set_pipe(f"{eid}.post", length_m=post)
            sig[f"o:{eid}"] = o
            dev = self.device.get(eid)
            if dev and dev.startswith("strainer"):
                so = min(max(inp.occl.get(dev, 0.0), 0.0), 0.97)
                k0 = self.kd["tcs_strainer"] if loop == "tcs" else self.kd["fws_strainer"]
                net.set_valve(dev, k_loss=self._kconv(k0 / (1 - so) ** 2, D, loop))
                sig[f"o:{dev}"] = so
            elif dev:
                closed = inp.isolated.get(dev, False)
                net.set_valve(dev, opened=not closed)
                sig[f"closed!:{dev}"] = float(closed)
        tcs = self.nets["tcs"]
        th_bal, th_min = hc["valve_balanced_opening"], hc["valve_min_opening"]
        for r in self.all_racks:
            z = self.rack_zone[r]
            theta = inp.valve_stuck.get(r, inp.valve_cmd.get(r, th_bal))
            theta = min(max(theta, th_min), 1.0)
            k = self.kd["valve_balanced"] * (th_bal / theta) ** 2
            closed = inp.isolated.get(f"valve_{r}", False) or inp.isolated.get(f"valve_z{z}", False)
            tcs.set_valve(f"valve_{r}", k_loss=self._kconv(k, self.rack_dn[r], "tcs"), opened=not closed)
            sig[f"theta:{r}"] = theta
            sig[f"closed!:valve_{r}"] = float(closed)
        pc = hc["pumps"]
        for loop, net in self.nets.items():
            for pid in self.pump_ids[loop]:
                run = inp.pump_run.get(pid, False)
                s = inp.pump_speed[loop]
                h0 = pc[loop]["h0_kpa"] * 1000.0 * s * s * inp.pump_head_mult.get(pid, 1.0)
                net.set_pump(pid, h0_pa=h0, in_service=run)
                net.set_pipe(f"{pid}.int", k_loss=self._kconv(pc[loop]["a_kpa_per_kgs2"], 150.0, loop))
                sig[f"run!:{pid}"] = float(run)
                if run:
                    sig[f"h0:{pid}"] = h0
        return sig

    # ------------------------------------------------------------------- solve
    def solve(self) -> HydResult:
        res = {loop: net.solve() for loop, net in self.nets.items()}
        return self._collect(res)

    def _collect(self, res: dict[str, SolveResult]) -> HydResult:
        bad = [f"{l}: {r.reason}" for l, r in res.items() if not r.converged]
        rho = {l: self.nets[l].rho for l in res}
        q = {l: 0.0 for l in res}
        edge_q: dict[str, float] = {}
        edge_dp: dict[str, float] = {}
        edge_p: dict[str, float] = {}
        strainer_dp: dict[str, float] = {"strainer_01": 0.0, "strainer_02": 0.0}
        rack_q = {r: 0.0 for r in self.all_racks}
        zone_q = {z: 0.0 for z in self.zones}
        head = {"tcs": 0.0, "fws": 0.0}
        mb = {"tcs": 0.0, "fws": 0.0}
        if not bad:
            for loop, r in res.items():
                for pid in self.pump_ids[loop]:
                    if r.active.get(pid):
                        q[loop] += r.mdot[pid] / rho[loop]
                        head[loop] = max(head[loop], r.dp_pa[pid] - r.dp_pa[f"{pid}.int"])
            for eid, e in self.edges.items():
                r, loop = res[e["loop"]], e["loop"]
                if e["robot_passable"]:
                    edge_q[eid] = abs(r.mdot[f"{eid}.post"]) / rho[loop]
                    edge_dp[eid] = sum(r.dp_pa[f"{eid}.{s}"] for s in ("pre", "dep", "post"))
                else:
                    edge_q[eid] = abs(r.mdot[eid]) / rho[loop]
                    edge_dp[eid] = r.dp_pa[eid]
                edge_p[eid] = r.junction_p_pa.get(self._junction(e["from"]), 0.0)
            for s, loop in (("strainer_01", "fws"), ("strainer_02", "tcs")):
                strainer_dp[s] = res[loop].dp_pa.get(s, 0.0)
            for r in self.all_racks:
                rack_q[r] = abs(res["tcs"].mdot[f"coldplate_{r}"]) / rho["tcs"]
            for zz in self.zones:
                zone_q[zz] = edge_q[self.zone_hdr[zz]["supply"]]
            tr = res["tcs"]
            trunk = abs(tr.mdot["p_10.post"])
            if trunk > 1e-9:
                mb["tcs"] = abs(sum(abs(tr.mdot[f"coldplate_{r}"]) for r in self.all_racks) - trunk) / trunk
            fr = res["fws"]
            mb["fws"] = abs(abs(fr.mdot["p_01.post"]) - abs(fr.mdot["p_03.post"])) / max(abs(fr.mdot["p_01.post"]), 1e-9) \
                if abs(fr.mdot["p_01.post"]) > 1e-9 else 0.0
        resid = max((r.residual for r in res.values()), default=0.0) if not bad else float("inf")
        return HydResult(not bad, "; ".join(bad) or None, resid, q, zone_q, rack_q, edge_q, edge_dp, edge_p, strainer_dp, head,
                         {l: r.ext_grid_mdot for l, r in res.items()}, mb,
                         sum(r.wall_ms for r in res.values()), sum(r.iterations_tried for r in res.values()))
