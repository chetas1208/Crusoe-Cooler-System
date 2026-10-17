"""Deterministic threshold/residual monitor (backend.md §5 step 8: never an LLM per tick).

Driven ONLY by the world dict (measurements). It compares measurements with a
healthy-twin reference: either `world["twin_reference"]` supplied by the plant, or a
reference self-calibrated from the first `calib_samples` samples (median, frozen).
Residuals that persist for `persist_s` simulated seconds become Detections;
IncidentOpener turns detections into Incidents and emits `incident.opened`.
"""
from __future__ import annotations

import statistics
from dataclasses import asdict, dataclass, field
from typing import Any

from .facility import Facility
from .world import Json, rd, sim_time

FOUL_WATCH = None      # derived from the topology: every robot-passable TCS edge and the FWS supply line p_02
PUMP_VIB_WATCH = 3.2


@dataclass
class Detection:
    key: str
    cause: str
    target_id: str
    severity: str
    title: str
    summary: str
    affected: list[str]
    anchor_id: str
    evidence: list[str] = field(default_factory=list)

    def to_dict(self) -> Json:
        return asdict(self)


def key_for_anchor(anchor_id: str) -> str:
    """Re-derive a detector key from an incident anchor (used when no checkpoint survived)."""
    if anchor_id.startswith("strainer_"):
        return f"strainer:{anchor_id}"
    if anchor_id.startswith("valve_"):
        return f"valve:{anchor_id.replace('valve_', '')}"
    if anchor_id.startswith("pump_"):
        return f"pump:{anchor_id}"
    if anchor_id.startswith("sn_"):
        return f"sensor:{anchor_id}"
    if anchor_id.startswith("rack_"):
        return f"workload:{anchor_id.replace('rack_', '')}"
    return f"fouling:{anchor_id}"


class Monitor:
    def __init__(self, fac: Facility, *, persist_s: float = 16.0, calib_samples: int = 30) -> None:
        self.fac, self.persist_s, self.calib_samples = fac, persist_s, calib_samples
        self.watch = [e for e, d in fac.edges.items() if d.get("robot_passable") and (d.get("loop") == "tcs" or e == "p_02")]
        self.k_edge: dict[str, float] = {}
        self.k_strainer: dict[str, float] = {}
        self.ref_rack: dict[str, float] = {}
        self.speed0 = 0.0
        self.h_norm = 0.0
        self.ref_q: dict[str, float] = {}
        self.calibrated = False
        self._cal: dict[str, list[float]] = {}
        self._n = 0
        self._streak: dict[str, tuple[float, int]] = {}
        self._ema: dict[str, float] = {}
        self._low_since: dict[str, float] = {}
        self._last_t: float | None = None
        self.last_minmargin = 99.0

    # ── reference ──
    def export_state(self) -> Json:
        return {"k_edge": self.k_edge, "k_strainer": self.k_strainer, "ref_rack": self.ref_rack,
                "speed0": self.speed0, "h_norm": self.h_norm, "ref_q": self.ref_q, "calibrated": self.calibrated, "ema": self._ema}

    def load_state(self, s: Json) -> None:
        self.k_edge, self.k_strainer = dict(s.get("k_edge", {})), dict(s.get("k_strainer", {}))
        self.ref_rack, self.speed0 = dict(s.get("ref_rack", {})), float(s.get("speed0", 0.0))
        self.h_norm, self.calibrated = float(s.get("h_norm", 0.0)), bool(s.get("calibrated", False))
        self.ref_q = dict(s.get("ref_q", {}))
        self._ema = dict(s.get("ema", {}))

    def tcs_speed(self, w: Json) -> float:
        return max([rd(w, p, "speed_pct", 0.0) or 0.0 for p in self.fac.tcs_pumps] or [0.0])

    def duty_pump(self, w: Json) -> str | None:
        best, bs = None, 0.0
        for p in self.fac.tcs_pumps:
            s = rd(w, p, "speed_pct", 0.0) or 0.0
            if s > bs:
                best, bs = p, s
        return best

    def speed_ratio(self, w: Json) -> float:
        s = self.tcs_speed(w)
        return s / self.speed0 if self.speed0 > 0 and s > 0 else 1.0

    def ref_rack_flow(self, rack: str, w: Json) -> float:
        return self.ref_rack.get(rack, 0.0) * self.speed_ratio(w)

    def loop_flows(self, w: Json) -> dict[str, float]:
        tcs = rd(w, "cdu_01", "tcs_flow_kg_s", None)
        fws = rd(w, "cdu_01", "fws_flow_kg_s", None)
        if tcs is None:
            tcs = sum(rd(w, r, "flow_kg_s", 0.0) or 0.0 for r in self.fac.all_racks)
        if fws is None:
            fws = rd(w, "strainer_01", "flow_kg_s", 0.0) or 0.0
        return {"tcs": tcs, "fws": fws}

    def flow_est(self, edge: str, w: Json) -> float:
        racks = self.fac.served_racks(edge)
        if racks:
            return sum(rd(w, r, "flow_kg_s", 0.0) or 0.0 for r in racks)
        return rd(w, edge, "flow_kg_s", 0.0) or 0.0

    def dp_ratio(self, edge: str, w: Json) -> float:
        k = self.k_edge.get(edge)
        if not k:
            return 1.0
        q = max(self.flow_est(edge, w), 0.25)
        return max(rd(w, edge, "dp_kpa", 0.0) or 0.0, 0.01) / (k * q * q)

    def strainer_flow(self, sid: str, w: Json) -> float:
        return rd(w, sid, "flow_kg_s", None) or (sum(rd(w, r, "flow_kg_s", 0.0) or 0.0 for r in self.fac.all_racks))

    def strainer_ratio(self, sid: str, w: Json) -> float:
        k = self.k_strainer.get(sid)
        if not k:
            return 1.0
        q = max(self.strainer_flow(sid, w), 0.5)
        return max(rd(w, sid, "strainer_dp_kpa", 0.0) or 0.0, 0.01) / (k * q * q)

    def margin(self, rack: str, w: Json) -> float:
        return rd(w, rack, "margin_k", 99.0)  # type: ignore[return-value]

    def _calibrate(self, w: Json) -> None:
        tr = w.get("twin_reference")
        if isinstance(tr, dict) and tr.get("k_edge") is not None and tr.get("rack_flow_kg_s") is not None:
            self.k_edge, self.k_strainer = dict(tr["k_edge"]), dict(tr.get("k_strainer", {}))
            self.ref_rack, self.speed0 = dict(tr["rack_flow_kg_s"]), float(tr.get("tcs_speed_pct", self.tcs_speed(w)))
            self.h_norm, self.calibrated = float(tr.get("pump_head_norm", 0.0)), True
            self.ref_q = dict(tr.get("loop_flow_kg_s", {}))
            return
        c = self._cal
        for e in self.watch:
            q = self.flow_est(e, w)
            dp = rd(w, e, "dp_kpa", None)
            if q > 0.4 and dp is not None:
                c.setdefault(f"e:{e}", []).append(dp / (q * q))
        for s in self.fac.strainers:
            q, dp = self.strainer_flow(s, w), rd(w, s, "strainer_dp_kpa", None)
            if q > 0.5 and dp is not None:
                c.setdefault(f"s:{s}", []).append(dp / (q * q))
        for r in self.fac.racks:
            c.setdefault(f"r:{r}", []).append(rd(w, r, "flow_kg_s", 0.0) or 0.0)
        lf = self.loop_flows(w)
        c.setdefault("q:fws", []).append(lf["fws"])
        c.setdefault("q:tcs", []).append(lf["tcs"])
        sp = self.tcs_speed(w)
        c.setdefault("speed", []).append(sp)
        duty = self.duty_pump(w)
        if duty and sp > 0:
            h = rd(w, duty, "head_kpa", None)
            if h:
                c.setdefault("h", []).append(h / ((sp / 100.0) ** 2))
        self._n += 1
        if self._n >= self.calib_samples:
            med = statistics.median
            self.k_edge = {k[2:]: med(v) for k, v in c.items() if k.startswith("e:") and v}
            self.k_strainer = {k[2:]: med(v) for k, v in c.items() if k.startswith("s:") and v}
            self.ref_rack = {k[2:]: med(v) for k, v in c.items() if k.startswith("r:") and v}
            self.ref_q = {"fws": med(c["q:fws"]), "tcs": med(c["q:tcs"])}
            self.speed0 = med(c["speed"]) if c.get("speed") else 0.0
            self.h_norm = med(c["h"]) if c.get("h") else 0.0
            self.calibrated = True
            self._cal = {}

    # ── evaluation ──
    def _hit(self, key: str, cond: bool, t: float) -> bool:
        if not cond:
            self._streak.pop(key, None)
            return False
        t0, n = self._streak.get(key, (t, 0))
        self._streak[key] = (t0, n + 1)
        return (t - t0) >= self.persist_s and n + 1 >= 3

    def _sev(self, margins: list[float]) -> str:
        w = min(margins) if margins else 99.0
        return "critical" if w < self.fac.crit_k else "warning" if w < self.fac.warn_k else "watch"

    def _isolated(self, w: Json, ident: str) -> bool:
        a = (w.get("assets") or {}).get(ident) or {}
        return a.get("status") in ("isolated", "service", "offline") or rd(w, ident, "opening_pct", 100.0) == 0.0

    def evaluate(self, w: Json, suppressed: set[str] | None = None) -> list[Detection]:
        sup = suppressed or set()
        t = sim_time(w)
        if self._last_t is not None and t <= self._last_t:
            return []
        dt = 1.0 if self._last_t is None else t - self._last_t
        self._last_t = t
        if not self.calibrated:
            self._calibrate(w)
            return []
        fac = self.fac
        out: list[Detection] = []
        margins = {r: self.margin(r, w) for r in fac.racks}
        self.last_minmargin = min(margins.values()) if margins else 99.0
        deficit: dict[str, float] = {}
        for r in fac.racks:
            ref = self.ref_rack_flow(r, w)
            deficit[r] = (ref - (rd(w, r, "flow_kg_s", 0.0) or 0.0)) / ref if ref > 0.2 else 0.0
        import math
        a = 1 - math.exp(-dt / 250.0)
        for r in fac.racks:
            p = rd(w, r, "power_kw", None)
            if p is None:
                continue
            ema = self._ema.setdefault(r, p)
            ratio = p / max(ema, 1.0)
            if 0.9 <= ratio < 1.05:
                self._ema[r] = ema + (p - ema) * a
                self._low_since.pop(r, None)
            elif ratio < 0.9:
                # a deliberate cordon / migration: keep the old baseline (so the restore is not mistaken for a surge) unless the
                # lower level is sustained for a long time, in which case it becomes the new normal
                t0 = self._low_since.setdefault(r, t)
                if t - t0 > 900.0:
                    self._ema[r], _ = p, self._low_since.pop(r, None)
            else:
                self._low_since.pop(r, None)

        # fouling
        for e in self.watch:
            q = self.flow_est(e, w)
            ratio = self.dp_ratio(e, w)
            zone = fac.edge_zone(e)
            if self._hit(f"fouling:{e}", q > 0.4 and e not in sup and ratio > 1.6, t):
                racks = fac.zone_racks(zone) if zone else list(fac.racks)
                edge = fac.edges[e]
                exp = (self.k_edge[e] * q * q)
                out.append(Detection(
                    f"fouling:{e}", "fouling", e, self._sev([margins[r] for r in racks if r in margins]),
                    f"{edge['label']} pressure drop rising",
                    f"dP across {edge['label']} is {ratio:.1f}x design at {q:.2f} kg/s - progressive restriction suspected.",
                    [e, *racks], e, [f"dP {rd(w, e, 'dp_kpa', 0.0):.1f} kPa vs {exp:.1f} kPa expected"]))
        # strainers
        for s in fac.strainers:
            ratio = self.strainer_ratio(s, w)
            if self._hit(f"strainer:{s}", ratio > 2.1 and s not in sup, t):
                label = fac.label(s)
                out.append(Detection(
                    f"strainer:{s}", "strainer_blockage", s, self._sev(list(margins.values())),
                    f"{label} strainer dP rising",
                    f"Strainer dP is {ratio:.1f}x design; loop flow is reduced.",
                    [s, "cdu_01", *fac.racks], s, [f"Strainer dP {rd(w, s, 'strainer_dp_kpa', 0.0):.1f} kPa"]))
        # stuck valve
        for r in fac.racks:
            z = fac.rack_zone(r)
            peers = [x for x in fac.zone_racks(z or "") if x != r and self.ref_rack.get(x, 0) >= 0.5]
            hdr = fac.zone_header(z) if z else None
            vid = r.replace("rack_", "valve_")
            zv = fac.zone_valve(z) if z else None
            import statistics
            peer_def = statistics.median(deficit[x] for x in peers) if peers else 1.0
            cond = (self.ref_rack.get(r, 0) >= 0.5 and hdr is not None and deficit[r] > 0.11 and peer_def < 0.07
                    and self.dp_ratio(hdr, w) < 1.35 and vid not in sup and not (zv and self._isolated(w, zv))
                    and not self._isolated(w, vid))
            if self._hit(f"valve:{r.replace('rack_', '')}", cond, t):
                lab = r.replace("rack_", "").upper()
                fl = rd(w, r, "flow_kg_s", 0.0) or 0.0
                out.append(Detection(
                    f"valve:{r.replace('rack_', '')}", "valve_stuck", vid, self._sev([margins[r]]),
                    f"Rack {lab} branch flow low",
                    f"Rack {lab} receives {fl:.2f} kg/s ({round(deficit[r] * 100)}% below expected) while the other racks on the same header are normal.",
                    [vid, r], vid, [f"Branch flow {fl:.2f} vs {self.ref_rack_flow(r, w):.2f} kg/s expected"]))
        # pump degradation
        duty = self.duty_pump(w)
        if duty and self.h_norm > 0:
            sp = self.tcs_speed(w) / 100.0
            exp = self.h_norm * sp * sp
            head = rd(w, duty, "head_kpa", 0.0) or 0.0
            ratio = head / max(exp, 1.0)
            vib = rd(w, duty, "vibration_mm_s", 0.0) or 0.0
            if self._hit(f"pump:{duty}", ratio < 0.89 and vib > PUMP_VIB_WATCH and duty not in sup and not self._isolated(w, duty), t):
                out.append(Detection(
                    f"pump:{duty}", "pump_degradation", duty, self._sev(list(margins.values())),
                    f"{fac.label(duty)} head below curve",
                    f"Delivering {round(ratio * 100)}% of expected head at {round(sp * 100)}% speed, vibration {vib:.1f} mm/s.",
                    [duty, "cdu_01", *fac.racks], duty, [f"Head {head:.0f} kPa vs {exp:.0f} kPa on curve"]))
        else:
            self._streak = {k: v for k, v in self._streak.items() if not k.startswith("pump:")}
        # workload spike
        for r in fac.racks:
            p = rd(w, r, "power_kw", None)
            if p is None:
                continue
            up = p / max(self._ema.get(r, p), 1.0)
            cond = up > 1.13 and abs(deficit[r]) < 0.06 and r not in sup
            if self._hit(f"workload:{r.replace('rack_', '')}", cond, t):
                m = margins[r]
                lab = r.replace("rack_", "").upper()
                out.append(Detection(
                    f"workload:{r.replace('rack_', '')}", "workload_spike", r,
                    "warning" if m < fac.warn_k + 2 else "watch", f"Rack {lab} load surge",
                    f"Rack {lab} is drawing {p:.0f} kW (+{round((up - 1) * 100)}% vs baseline); coolant flow is nominal.",
                    [r], r, [f"Power {p:.0f} kW vs {self._ema.get(r, p):.0f} kW baseline"]))
        # sensor drift
        for sid in fac.flow_sensors:
            edge = fac.assets[sid]["edge_id"]
            racks = fac.served_racks(edge)
            if not racks:
                continue
            total = sum(rd(w, r, "flow_kg_s", 0.0) or 0.0 for r in racks)
            meter = rd(w, sid, "flow_kg_s", None)
            if meter is None:
                continue
            dev = meter - total
            rel = abs(dev) / max(total, 0.5)
            zv = fac.zone_valve(z) if z else None
            if self._hit(f"sensor:{sid}", rel > 0.06 and sid not in sup and not (zv and self._isolated(w, zv)), t):
                lab = fac.label(sid)
                out.append(Detection(
                    f"sensor:{sid}", "sensor_drift", sid, "watch", f"{lab} readings inconsistent",
                    f"{lab} reads {dev:+.2f} kg/s against the rack meters beneath it - mass balance does not close.",
                    [sid], sid, [f"Mass-balance residual {rel * 100:.1f}%"]))
        return out


class IncidentOpener:
    """Builds the contract Incident and emits `incident.opened` through the engine."""

    def __init__(self, fac: Facility) -> None:
        self.fac = fac

    def build(self, det: Detection, inc_id: str, tick: int, sim_t: float) -> Json:
        return {
            "id": inc_id, "opened_tick": tick, "opened_at_s": sim_t, "updated_tick": tick,
            "severity": det.severity, "status": "open", "stage": "observed",
            "stage_log": [{"stage": "observed", "tick": tick}], "title": det.title, "summary": det.summary,
            "cause": "unknown",
            "anchor": {"entity_id": det.anchor_id, "position_xyz_m": self.fac.pos_of(det.anchor_id)},
            "affected_asset_ids": list(det.affected), "hypotheses": [], "evidence": [], "mission_ids": [],
            "task_ids": [], "attempts": 0,
        }

    def open(self, engine: Any, det: Detection, inc_id: str, tick: int, sim_t: float) -> Json:
        inc = self.build(det, inc_id, tick, sim_t)
        import copy
        engine.emit("incident.opened", inc_id, {"incident": copy.deepcopy(inc)})
        return inc
