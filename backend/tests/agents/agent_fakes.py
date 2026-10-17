"""Scripted FakeEngine + FakeModelClient for tests/agents (no network, no key, no real plant).

FakeEngine implements EngineFacade and a tiny but causal mini-plant: faults change flows/dP/head/margins,
robot missions change faults when their steps complete, the monitor sees only the world dict.
"""
from __future__ import annotations

import copy
import json
import math
import random
from typing import Any, Callable

Json = dict[str, Any]


def foul(o: float, extent: float = 0.25) -> float:
    return 1.0 + extent * ((1.0 - o) ** -5 - 1.0)


def make_topology() -> Json:
    def v(x: float, y: float = 0.0, z: float = 0.0) -> list[float]:
        return [x, y, z]

    nodes = [{"id": n, "label": n, "loop": lp, "position_xyz_m": v(i)} for i, (n, lp) in enumerate([
        ("n_ch", "fws"), ("n_cf", "fws"), ("n_cdu", "tcs"), ("n_tr", "tcs"), ("n_za", "tcs"), ("n_zb", "tcs"), ("n_zar", "tcs"),
        ("n_zbr", "tcs"), ("n_trr", "tcs"), ("n_a1", "tcs"), ("n_a2", "tcs"), ("n_b1", "tcs"), ("n_b2", "tcs"),
        ("n_a1r", "tcs"), ("n_a2r", "tcs"), ("n_b1r", "tcs"), ("n_b2r", "tcs")])]

    def e(i: str, a: str, b: str, loop: str, role: str, zone: str | None, length: float, passable: bool = True, dia: float = 150.0) -> Json:
        d = {"id": i, "label": i.upper().replace("_", "-"), "name": i, "loop": loop, "role": role, "from": a, "to": b,
             "centerline_xyz_m": [v(0), v(length)], "fillet_radius_m": 0.2, "length_m": length, "diameter_mm": dia, "clearance_mm": 40.0,
             "robot_passable": passable, "access_port_ids": []}
        if zone:
            d["zone_id"] = zone
        if not passable:
            d["not_passable_reason"] = "bore 25 mm below crawler clearance"
        return d

    edges = [
        e("p_01", "n_ch", "n_cf", "fws", "supply", None, 10), e("p_02", "n_cf", "n_cdu", "fws", "supply", None, 6),
        e("p_03", "n_cdu", "n_ch", "fws", "return", None, 10),
        e("p_10", "n_cdu", "n_tr", "tcs", "supply", None, 8), e("p_20", "n_trr", "n_cdu", "tcs", "return", None, 8),
        e("p_12", "n_tr", "n_za", "tcs", "supply", "zone_a", 10), e("p_22", "n_zar", "n_trr", "tcs", "return", "zone_a", 10),
        e("p_17", "n_tr", "n_zb", "tcs", "supply", "zone_b", 10), e("p_27", "n_zbr", "n_trr", "tcs", "return", "zone_b", 10),
        e("p_13", "n_za", "n_a1", "tcs", "supply", "zone_a", 3, False, 25), e("p_14", "n_za", "n_a2", "tcs", "supply", "zone_a", 3, False, 25),
        e("p_18", "n_zb", "n_b1", "tcs", "supply", "zone_b", 3, False, 25), e("p_19", "n_zb", "n_b2", "tcs", "supply", "zone_b", 3, False, 25),
        e("p_23", "n_a1r", "n_zar", "tcs", "return", "zone_a", 3, False, 25), e("p_24", "n_a2r", "n_zar", "tcs", "return", "zone_a", 3, False, 25),
        e("p_28", "n_b1r", "n_zbr", "tcs", "return", "zone_b", 3, False, 25), e("p_29", "n_b2r", "n_zbr", "tcs", "return", "zone_b", 3, False, 25),
    ]
    assets: list[Json] = []

    def a(i: str, t: str, **kw: Any) -> None:
        d = {"id": i, "type": t, "label": i.upper().replace("_", "-"), "name": i, "position_xyz_m": v(1, 0, 1), "accessible_by": ["outrig"]}
        d.update(kw)
        assets.append(d)

    for r, z in (("a1", "zone_a"), ("a2", "zone_a"), ("b1", "zone_b"), ("b2", "zone_b")):
        a(f"rack_{r}", "rack", zone_id=z, size_m=[1, 2, 1], service_xyz_m=v(2, 0, 2))
        a(f"valve_{r}", "valve", zone_id=z, service_xyz_m=v(2, 0, 2))
    a("cdu_01", "cdu", size_m=[1, 2, 1])
    a("chiller_01", "chiller")
    for p in ("pump_t1", "pump_t2"):
        a(p, "pump", loop="tcs", service_xyz_m=v(3, 0, 3))
    for p in ("pump_f1", "pump_f2"):
        a(p, "pump", loop="fws", service_xyz_m=v(3, 0, 3))
    a("valve_za", "valve", service_xyz_m=v(4, 0, 4))
    a("valve_zb", "valve", service_xyz_m=v(5, 0, 4))
    a("strainer_01", "strainer", loop="fws", service_xyz_m=v(6, 0, 4))
    a("strainer_02", "strainer", loop="tcs", service_xyz_m=v(7, 0, 4))
    for sid, ed in (("sn_flow_za", "p_12"), ("sn_flow_zb", "p_17"), ("sn_flow_trunk", "p_10")):
        a(sid, "sensor", edge_id=ed, s_m=4.0, service_xyz_m=v(8, 0, 4))
    a("port_a1", "port", edge_id="p_10", s_m=0.5, accessible_by=["inpipe"])
    a("port_a2", "port", edge_id="p_12", s_m=1.0, accessible_by=["inpipe"])
    a("dock_o1", "dock")
    zones = [{"id": "zone_a", "name": "Zone A", "rack_ids": ["rack_a1", "rack_a2"], "anchor_xyz_m": v(0)},
             {"id": "zone_b", "name": "Zone B", "rack_ids": ["rack_b1", "rack_b2"], "anchor_xyz_m": v(0)}]
    return {"facility": {"id": "fake", "name": "Fake", "label": "Simulated facility", "config_version": "t", "topology_hash": "x"},
            "zones": zones, "nodes": nodes, "edges": edges, "assets": assets, "nav": {"cell_m": 0.25, "obstacles": [], "dock_ids": ["dock_o1"]},
            "limits": {"chip_limit_c": 90.0, "margin_warn_k": 8.0, "margin_crit_k": 4.0, "nominal_rack_kw": 120.0}, "expansion_bays": []}


RACKS = ["a1", "a2", "b1", "b2"]
ZONE = {"a1": "a", "a2": "a", "b1": "b", "b2": "b"}
Q0 = 2.0
STEP_S = {"launch": 3, "move_to": 8, "inspect": 6, "brush_clear": 10, "return_to_port": 8, "dock": 3, "fetch_tool": 3, "navigate": 6,
          "scan": 3, "isolate_valve": 4, "replace_section": 10, "replace_strainer": 8, "service_valve": 8, "service_pump": 10,
          "recalibrate_sensor": 6, "pressure_test": 4, "reopen_valve": 3, "return_to_dock": 5}
STEP_MODE = {"launch": "ASSIGNED", "move_to": "TRAVELING", "inspect": "INSPECTING", "brush_clear": "WORKING", "return_to_port": "RETURNING",
             "dock": "RETURNING", "fetch_tool": "WORKING", "navigate": "TRAVELING", "scan": "INSPECTING", "isolate_valve": "WORKING",
             "replace_section": "WORKING", "replace_strainer": "WORKING", "service_valve": "WORKING", "service_pump": "WORKING",
             "recalibrate_sensor": "WORKING", "pressure_test": "INSPECTING", "reopen_valve": "WORKING", "return_to_dock": "RETURNING"}


class FakeEngine:
    run_id = "run_test"

    def __init__(self, seed: int = 7, *, twin_support: bool = True, brush_efficacy: float = 0.95, tick_every: int = 2,
                 approval_mode: str = "autonomous", approval_window_s: float = 20.0) -> None:
        self.topo = make_topology()
        self.rng = random.Random(seed)
        self.t = 0.0
        self.version = 0
        self.twin_support, self.brush_efficacy, self.tick_every = twin_support, brush_efficacy, tick_every
        self.mode, self.window = approval_mode, approval_window_s
        self.occl: dict[str, tuple[float, float]] = {}          # edge -> (occlusion, s_m)
        self.occl_s: dict[str, float] = {"strainer_01": 0.0, "strainer_02": 0.0}
        self.valve: dict[str, float] = {}                       # rack -> effective opening (stuck)
        self.health = {"pump_t1": 1.0, "pump_t2": 1.0}
        self.offset: dict[str, float] = {}
        self.spike: dict[str, float] = {}
        self.duty = "pump_t1"
        self.speed = 1.0
        self.load = {r: 1.0 for r in RACKS}
        self.load_target = {r: 1.0 for r in RACKS}
        self.isolated: set[str] = set()
        self.robots: dict[str, Json] = {
            "c_01": {"id": "c_01", "class": "inpipe", "name": "IR-01", "mode": "DOCKED", "battery_pct": 95.0, "home_id": "port_a1",
                     "pose": {"segment_id": "p_10", "s_m": 0.5, "position_xyz_m": [0, 0, 0], "yaw_rad": 0, "speed_m_s": 0}},
            "c_02": {"id": "c_02", "class": "inpipe", "name": "IR-02", "mode": "DOCKED", "battery_pct": 90.0, "home_id": "port_a2",
                     "pose": {"segment_id": "p_12", "s_m": 1.0, "position_xyz_m": [0, 0, 0], "yaw_rad": 0, "speed_m_s": 0}},
            "o_01": {"id": "o_01", "class": "outrig", "name": "OR-01", "mode": "DOCKED", "battery_pct": 88.0, "home_id": "dock_o1",
                     "pose": {"position_xyz_m": [0, 0, 0], "yaw_rad": 0, "speed_m_s": 0}},
        }
        self.missions: dict[str, Json] = {}
        self._m_rt: dict[str, Json] = {}
        self.events: list[Json] = []
        self.seq = 0
        self.acks: dict[str, Json] = {}
        self.commands: list[Json] = []
        self.applied: list[str] = []          # command ids whose effects were applied (must never repeat)
        self.reject_kinds: set[str] = set()
        self.runtime: Any = None
        self._cursor = 0
        self.max_concurrent_working: dict[str, int] = {}

    # ── EngineFacade ──
    def world(self) -> Json:
        return self._world()

    def topology(self) -> Json:
        return self.topo

    def emit(self, type: str, entity_id: str, payload: Json) -> Json:
        self.seq += 1
        ev = {"event_id": f"ev_{self.seq:06d}", "seq": self.seq, "sim_tick": int(self.t), "sim_time_s": self.t, "world_version": self.version,
              "type": type, "entity_id": entity_id, "facility_id": "fake", "ts": "2026-10-16T00:00:00Z", "payload": copy.deepcopy(payload)}
        self.events.append(ev)
        return ev

    def events_since(self, seq: int, limit: int = 1000) -> list[Json]:
        return [e for e in self.events if e["seq"] > seq][:limit]

    def subscribe(self) -> Any:
        raise NotImplementedError

    async def submit(self, cmd: Json) -> Json:
        cid = cmd["command_id"]
        self.commands.append(copy.deepcopy(cmd))
        if cid in self.acks:
            return copy.deepcopy(self.acks[cid])
        ack = self._apply(cmd)
        self.acks[cid] = ack
        return copy.deepcopy(ack)

    # ── helpers for tests ──
    def of(self, typ: str) -> list[Json]:
        return [e for e in self.events if e["type"] == typ]

    def incidents(self) -> dict[str, Json]:
        out: dict[str, Json] = {}
        for e in self.events:
            if e["type"].startswith("incident."):
                out[e["entity_id"]] = e["payload"]["incident"]
        return out

    def tasks(self, inc: str | None = None) -> dict[str, Json]:
        out: dict[str, Json] = {}
        for e in self.of("agent.task"):
            t = e["payload"]["task"]
            if inc is None or t["incident_id"] == inc:
                out[t["id"]] = t
        return out

    # ── faults ──
    def inject(self, kind: str, target: str, severity: float = 0.6) -> None:
        if kind == "fouling":
            self.occl[target] = (severity, self.fac_len(target) * 0.4)
        elif kind == "strainer":
            self.occl_s[target] = severity
        elif kind == "valve":
            self.valve[target] = severity
        elif kind == "pump":
            self.health[target] = severity
        elif kind == "sensor":
            self.offset[target] = severity
        elif kind == "spike":
            self.spike[target] = severity

    def fac_len(self, edge: str) -> float:
        return next(e["length_m"] for e in self.topo["edges"] if e["id"] == edge)

    # ── physics ──
    def _flows(self, occl: Json | None = None, occl_s: Json | None = None, valve: Json | None = None, health: Json | None = None) -> Json:
        occl = self.occl if occl is None else occl
        occl_s = self.occl_s if occl_s is None else occl_s
        valve = self.valve if valve is None else valve
        health = self.health if health is None else health
        fm = self.speed * (0.55 + 0.45 * health[self.duty]) if self.speed > 0 else 0.0
        fs = (1 - occl_s["strainer_02"]) ** 1.25
        ft = foul(occl.get("p_10", (0, 0))[0]) ** -0.25
        rack: dict[str, float] = {}
        for r in RACKS:
            z = ZONE[r]
            fz = foul(occl.get("p_12" if z == "a" else "p_17", (0, 0))[0]) ** -0.25
            fz2 = foul(occl.get("p_22" if z == "a" else "p_27", (0, 0))[0]) ** -0.25
            op = valve.get(r, 1.0)
            iso = f"valve_z{z}" in self.isolated
            rack[r] = 0.0 if iso else Q0 * fm * fs * ft * fz * fz2 * (op ** 0.6)
        return {"rack": rack, "tcs": sum(rack.values()), "fws": 12.0 * (1 - occl_s["strainer_01"]) ** 1.25}

    def _edge_flow(self, e: str, f: Json) -> float:
        if e in ("p_12", "p_22"):
            return f["rack"]["a1"] + f["rack"]["a2"]
        if e in ("p_17", "p_27"):
            return f["rack"]["b1"] + f["rack"]["b2"]
        if e in ("p_10", "p_20"):
            return f["tcs"]
        if e in ("p_01", "p_02", "p_03"):
            return f["fws"]
        r = {"p_13": "a1", "p_23": "a1", "p_14": "a2", "p_24": "a2", "p_18": "b1", "p_28": "b1", "p_19": "b2", "p_29": "b2"}[e]
        return f["rack"][r]

    def _world(self) -> Json:
        f = self._flows()
        n = lambda s: self.rng.gauss(0, s)
        assets: Json = {}
        for e in self.topo["edges"]:
            q = self._edge_flow(e["id"], f)
            k = 0.15 if e["id"] in ("p_12", "p_22", "p_17", "p_27") else 0.12
            o = self.occl.get(e["id"], (0.0, 0.0))[0]
            dp = k * q * q * foul(o)
            assets[e["id"]] = {"status": "nominal", "readings": {"flow_kg_s": max(q + n(0.01), 0), "dp_kpa": max(dp + n(0.03), 0), "velocity_m_s": q / 10}}
            if o:
                assets[e["id"]]["fault"] = {"occlusion": o, "location_s_m": self.occl[e["id"]][1]}
        for sid, ed in (("sn_flow_za", "p_12"), ("sn_flow_zb", "p_17"), ("sn_flow_trunk", "p_10")):
            assets[sid] = {"status": "nominal", "readings": {"flow_kg_s": max(self._edge_flow(ed, f) + self.offset.get(sid, 0.0) + n(0.01), 0)}}
        for r in RACKS:
            q = f["rack"][r]
            power = 120.0 * self.load[r] * self.spike.get(r, 1.0)
            chip = 60 + 15 * (power / 120.0) * (Q0 / max(q, 0.1)) ** 0.8 if q > 0.05 else 60 + 60 * power / 120
            margin = 90.0 - min(chip, 150)
            assets[f"rack_{r}"] = {"status": "critical" if margin < 4 else "warning" if margin < 8 else "nominal",
                                   "readings": {"power_kw": power + n(0.4), "flow_kg_s": max(q + n(0.01), 0), "t_chip_c": chip, "margin_k": margin + n(0.03)}}
            op = self.valve.get(r)
            assets[f"valve_{r}"] = {"status": "nominal", "readings": {"opening_pct": 100.0, "flow_kg_s": q}}
            if op is not None:
                assets[f"valve_{r}"]["fault"] = {"opening": op, "commanded_opening": 1.0}
        for z in ("a", "b"):
            assets[f"valve_z{z}"] = {"status": "isolated" if f"valve_z{z}" in self.isolated else "nominal",
                                     "readings": {"opening_pct": 0.0 if f"valve_z{z}" in self.isolated else 100.0}}
        for sid, qn in (("strainer_01", f["fws"]), ("strainer_02", f["tcs"])):
            o = self.occl_s[sid]
            assets[sid] = {"status": "nominal", "readings": {"strainer_dp_kpa": max(0.05 * qn * qn * (1 - o) ** -2.5 + n(0.03), 0), "flow_kg_s": qn + n(0.01)}}
        for p in ("pump_t1", "pump_t2", "pump_f1", "pump_f2"):
            tcs = p.startswith("pump_t")
            duty = (self.duty == p) if tcs else (p == "pump_f1")
            h = self.health.get(p, 1.0)
            head = (183 * self.speed ** 2 * (0.55 + 0.45 * h) * 1.0 - 1.6 * f["tcs"] ** 2) if duty and tcs else (100.0 if duty else 0.0)
            vib = 1.0 + 8 * (1 - h) if duty else 0.2
            assets[p] = {"status": "nominal", "readings": {"speed_pct": self.speed * 100 if duty else 0.0, "head_kpa": head + (n(0.5) if duty else 0),
                                                            "flow_kg_s": f["tcs"] if duty else 0.0, "vibration_mm_s": vib + n(0.03)}}
            if h < 0.995:
                assets[p]["fault"] = {"health": h}
        assets["cdu_01"] = {"status": "nominal", "readings": {"tcs_flow_kg_s": f["tcs"] + n(0.02), "fws_flow_kg_s": f["fws"] + n(0.02), "approach_k": 5.0}}
        return {"facility_id": "fake", "version": self.version, "sim_tick": int(self.t), "sim_time_s": self.t, "sim_speed": 1, "sim_status": "running",
                "assets": assets, "robots": copy.deepcopy(self.robots), "missions": copy.deepcopy(self.missions), "incidents": list(self.incidents().values()),
                "health": {"safe_automation_mode": self.mode, "approval_window_s": self.window}, "kpis": {}, "last_seq": self.seq}

    def truth(self) -> Json:
        return self._flows()

    # ── commands ──
    def _apply(self, cmd: Json) -> Json:
        cid, kind, a = cmd["command_id"], cmd["kind"], cmd.get("args") or {}
        if kind in self.reject_kinds:
            return {"accepted": False, "command_id": cid, "reason": "engine rejected (test)"}
        if kind == "plant.swap_duty":
            self.duty = a["to"]
            self.applied.append(cid)
            return {"accepted": True, "command_id": cid}
        if kind in ("plant.migrate_workload", "plant.restore_workload"):
            for r in a["racks"]:
                self.load_target[r.replace("rack_", "")] = a["target_load_pct"] / 100.0
            self.applied.append(cid)
            return {"accepted": True, "command_id": cid}
        if kind == "twin.counterfactual":
            if not self.twin_support:
                return {"accepted": False, "command_id": cid, "reason": "unsupported"}
            rm = a["remove_fault"]
            occl, occl_s, valve, health = dict(self.occl), dict(self.occl_s), dict(self.valve), dict(self.health)
            if rm["cause"] == "fouling":
                occl.pop(rm["target_id"], None)
            elif rm["cause"] == "strainer_blockage":
                occl_s[rm["target_id"]] = 0.0
            elif rm["cause"] == "valve_stuck":
                valve.pop(rm["target_id"].replace("valve_", ""), None)
            elif rm["cause"] == "pump_degradation":
                health[rm["target_id"]] = 1.0
            f = self._flows(occl, occl_s, valve, health)
            return {"accepted": True, "command_id": cid, "result": {"rack_flow_kg_s": {f"rack_{r}": q for r, q in f["rack"].items()},
                                                                  "tcs_flow_kg_s": f["tcs"], "fws_flow_kg_s": f["fws"]}}
        if kind == "robot.mission.cancel":
            return {"accepted": True, "command_id": cid}
        if kind == "robot.mission.assign":
            r = self.robots.get(a["robot_id"])
            if not r or r["mode"] not in ("DOCKED", "IDLE", "ASSIGNED"):
                return {"accepted": False, "command_id": cid, "reason": "robot unavailable"}
            mid = a["mission_id"]
            m = {"id": mid, "incident_id": cmd["incident_id"], "robot_id": r["id"], "kind": a["mission_kind"], "title": a["title"], "target_id": a["target_id"],
                 "status": "ASSIGNED", "progress": 0.0, "opened_tick": int(self.t),
                 "steps": [{"id": s["id"], "command": s["command"], "label": s["label"], "status": "pending"} for s in a["steps"]]}
            self.missions[mid] = m
            self._m_rt[mid] = {"args": a["steps"], "i": 0, "left": None, "robot": r["id"], "iso": a.get("isolation"), "cid": cid}
            self.applied.append(cid)
            return {"accepted": True, "command_id": cid, "mission_id": mid}
        return {"accepted": False, "command_id": cid, "reason": f"unknown kind {kind}"}

    def _effect(self, rt: Json, step: Json, st: Json) -> None:
        c, a = step["command"], step.get("args") or {}
        rob = self.robots[rt["robot"]]
        if c == "launch":
            pass
        elif c == "move_to":
            rob["pose"].update(segment_id=a["edge_id"], s_m=a["s_m"])
        elif c == "inspect":
            e, g = a["edge_id"], a["gauge"]
            o, s_at = self.occl.get(e, (0.0, 0.0))
            f = self._flows()
            if g == "flow":
                sensor = next(x["id"] for x in self.topo["assets"] if x.get("edge_id") == e and x["type"] == "sensor")
                trueq = self._edge_flow(e, f)
                meter = trueq + self.offset.get(sensor, 0.0)
                st["observation"] = {"probe_kg_s": round(trueq, 2), "meter_kg_s": round(meter, 2), "offset_kg_s": round(meter - trueq, 2)}
            else:
                dn = next(x["diameter_mm"] for x in self.topo["edges"] if x["id"] == e)
                st["observation"] = {"occlusion": round(o, 2), "effective_bore_mm": round(dn * (1 - o)), "deposit_thickness_mm": round(dn / 2 * o, 1),
                                     "location_s_m": round(s_at, 1)}
            st["result"] = "inspected"
        elif c == "brush_clear":
            e = a["edge_id"]
            o, s_at = self.occl.get(e, (0.0, 0.0))
            self.occl[e] = (o * (1 - self.brush_efficacy), s_at)
            st["observation"] = {"removed_pct": round(self.brush_efficacy * 100)}
        elif c == "return_to_port":
            rob["pose"].update(segment_id=a["edge_id"], s_m=a["s_m"])
        elif c in ("dock", "return_to_dock"):
            rob["mode"] = "DOCKED"
        elif c == "isolate_valve":
            self.isolated.add(a["valve"])
        elif c == "reopen_valve":
            self.isolated.discard(a["valve"])
        elif c == "replace_section":
            self.occl.pop(a["segment"], None)
        elif c == "replace_strainer":
            self.occl_s[a["strainer"]] = 0.0
        elif c == "service_valve":
            self.valve.pop(a["valve"].replace("valve_", ""), None)
        elif c == "service_pump":
            self.health[a["pump"]] = 1.0
        elif c == "recalibrate_sensor":
            self.offset.pop(a["sensor"], None)

    def _step_missions(self, dt: float) -> None:
        for mid, rt in self._m_rt.items():
            m = self.missions[mid]
            if m.get("closed_tick") is not None:
                continue
            rob = self.robots[rt["robot"]]
            if rt["i"] >= len(rt["args"]):
                continue
            step, st = rt["args"][rt["i"]], m["steps"][rt["i"]]
            if rt["left"] is None:
                rt["left"] = float(STEP_S.get(step["command"], 4))
                st["status"], st["started_tick"] = "active", int(self.t)
                rob["mode"] = STEP_MODE.get(step["command"], "WORKING")
                m["status"] = rob["mode"]
            rt["left"] -= dt
            if rt["left"] <= 0:
                self._effect(rt, step, st)
                st["status"], st["ended_tick"] = "done", int(self.t)
                st.setdefault("result", step["label"])
                rt["i"] += 1
                rt["left"] = None
                m["progress"] = rt["i"] / len(rt["args"])
                if rt["i"] >= len(rt["args"]):
                    m["closed_tick"] = int(self.t)
                    if rob["mode"] != "DOCKED":
                        rob["mode"] = "ASSIGNED" if rob["class"] == "inpipe" and m["kind"] == "inspect" else rob["mode"]
                        if m["kind"] in ("clear",):
                            rob["mode"] = "ASSIGNED"
                    m["status"] = rob["mode"]

    def _step_plant(self, dt: float) -> None:
        for r in RACKS:
            d = self.load_target[r] - self.load[r]
            self.load[r] += max(-0.05 * dt, min(0.05 * dt, d)) if abs(d) > 1e-9 else 0
            # (ramp ~20 s for a 100% -> 10% migration)
        self.version += 1

    # ── time ──
    async def advance(self, seconds: float, dt: float = 1.0) -> None:
        steps = int(round(seconds / dt))
        for _ in range(steps):
            self.t += dt
            self._step_plant(dt)
            self._step_missions(dt)
            if int(self.t) % self.tick_every == 0 and self.runtime is not None:
                new = self.events[self._cursor:]
                self._cursor = len(self.events)
                await self.runtime.on_tick(self._world(), new)
                await self.runtime.settle()
                self._track_concurrency()

    def _track_concurrency(self) -> None:
        latest: dict[str, Json] = {}
        for e in self.of("agent.task"):
            latest[e["payload"]["task"]["id"]] = e["payload"]["task"]
        per: dict[str, int] = {}
        for t in latest.values():
            if t["status"] == "working":
                per[t["incident_id"]] = per.get(t["incident_id"], 0) + 1
        for k, v in per.items():
            self.max_concurrent_working[k] = max(self.max_concurrent_working.get(k, 0), v)

    async def run_until(self, cond: Callable[[], bool], max_s: float = 1500, dt: float = 1.0) -> bool:
        t_end = self.t + max_s
        while self.t < t_end:
            await self.advance(self.tick_every, dt)
            if cond():
                return True
        return False


# ── fake model ──
class FakeModelClient:
    provider = "mock"

    def __init__(self, model_id: str = "fake-model", *, scripts: dict[str, list[Any]] | None = None, tokens: tuple[int, int] = (120, 60),
                 fail: Exception | None = None) -> None:
        self.model_id = model_id
        self.scripts = {k: list(v) for k, v in (scripts or {}).items()}
        self.calls: list[tuple[str, dict]] = []
        self.tokens = tokens
        self.fail = fail
        self.fail_probe = False
        self.closed = False

    async def list_models(self) -> list[str]:
        return [self.model_id]

    async def aclose(self) -> None:
        self.closed = True

    async def complete_json(self, *, system: str, user: str, schema_name: str, max_tokens: int = 700, timeout_s: float | None = None):
        from loopkeeper.intelligence.crusoe import ModelError, ModelResponse
        if self.fail is not None and (schema_name != "probe" or self.fail_probe):
            raise self.fail if isinstance(self.fail, ModelError) else ModelError(str(self.fail))
        payload = json.loads(user) if schema_name != "probe" else {}
        self.calls.append((schema_name, payload))
        script = self.scripts.get(schema_name)
        if script:
            item = script.pop(0) if len(script) > 1 else script[0]
            text = item(payload) if callable(item) else item
            text = text if isinstance(text, str) else json.dumps(text)
        else:
            text = json.dumps(self.default(schema_name, payload.get("facts", {})))
        return ModelResponse(text=text, tokens_in=self.tokens[0], tokens_out=self.tokens[1], latency_ms=5, model_id=self.model_id)

    def default(self, kind: str, f: Json) -> Json:
        if kind == "probe":
            return {"ok": True}
        if kind == "classify":
            return {"mechanism": f.get("detector_cause", "unknown"), "summary": "LLM: signature matches the detector's mechanism."}
        if kind == "review":
            return {"summary": f"LLM {f.get('role')} review of the supplied facts.", "findings": [], "supports": f.get("cause", "none")}
        if kind == "reconcile":
            return {"hypotheses": f["candidate_prior"], "summary": "LLM ranking follows the evidence.", "followups": []}
        if kind == "probe":
            return {"summary": "probe ok", "followups": []}
        if kind == "inspection":
            return {"inspect": True, "gauge": f["allowed_gauges"][0], "rationale": "confirm physically"}
        if kind == "observation":
            return {"summary": "LLM: observation consistent with the hypothesis.", "confirms": True}
        if kind in ("intervention", "replan"):
            o = f["options"][0]
            return {"action": o, "target_id": f["targets"][o], "rationale": "LLM picks the least invasive option.", "confidence": 0.8}
        if kind == "verify":
            return {"summary": "LLM: verifier verdict stands."}
        if kind == "escalate":
            return {"summary": "LLM: escalating to operator."}
        if kind in ("dod_draft", "dod_revise"):
            first = (f.get("valid_asset_ids") or [f.get("incident", {}).get("target")])[0]
            return {"goal": "LLM: the loop flow and thermal margin must hold at their configured limits.", "subject_asset_ids": [f.get("incident", {}).get("target", first)],
                    "hold_sim_seconds": 0, "checks": [], "reason": ""}
        if kind == "dod_review":
            ok = f.get("layer_a", {}).get("verdict") == "PASS"
            return {"verdict": "concur" if ok else "request_replan", "reasons": ["LLM: Layer A table matches the frozen contract."], "extra_checks": [], "extra_hold_sim_seconds": 0}
        return {}
