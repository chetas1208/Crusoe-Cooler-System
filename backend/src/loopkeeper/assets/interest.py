"""Stream interest management: per-connection robot.pose throttling driven by what the viewer can see.

The simulation is never touched: the engine keeps emitting every event; this only decides which ``robot.pose`` events
go onto ONE websocket.  Everything else (world.diff, incidents, heartbeat, snapshots, ...) always passes.

Protocol (client -> server, JSON text frame, after auth)::

    {"type":"subscribe", "run_id":"run_live", "visible_zone_ids":["ROW-01","ROAD-01-W"],
     "selected_entity_id":"OR-03", "camera_mode":"overview|orbit|chase|pov|map|inspect",
     "rate_budget": 80  |  {"total_hz":80,"selected_hz":20,"visible_hz":10,"background_hz":1},
     "manifest_id":"<manifest the client holds>"}

Server -> client acknowledgement ``stream.interest`` (accepted + effective policy + counters); wire events that follow a
run of elided poses carry ``"elided": n`` (n skipped seqs just before this one) so a client can tell a deliberate
throttle from a real gap: ``gap = ev.seq > lastSeq + 1 + (ev.elided ?? 0)``.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

Json = dict[str, Any]
CAMERA_MODES = ("overview", "orbit", "chase", "pov", "map", "inspect", "drive")
MAX_ZONE_IDS = 256
MAX_ID_LEN = 64
DEFAULTS = {"total_hz": 100.0, "selected_hz": 20.0, "visible_hz": 10.0, "background_hz": 1.0}
BOUNDS = {"total_hz": (1.0, 400.0), "selected_hz": (1.0, 20.0), "visible_hz": (0.5, 20.0), "background_hz": (0.0, 5.0)}
STOP_SPEED_MPS = 0.02
ZONE_PAD_M = 0.5


class InterestError(ValueError):
    def __init__(self, code: str, reason: str) -> None:
        super().__init__(reason)
        self.code, self.reason = code, reason


class ZoneIndex:
    """Zone bounds + pipe-segment (edge, s-range) lookup built from the manifest/partition zones."""

    def __init__(self, zones: dict[str, Any]) -> None:
        self.boxes: dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]] = {}
        self.pipes: dict[str, list[tuple[str, float, float]]] = {}      # edge_id -> [(zone_id, s_lo, s_hi)]
        self.children: dict[str, list[str]] = {}
        for zid, z in zones.items():
            self.boxes[zid] = (tuple(z.bounds_min), tuple(z.bounds_max))          # type: ignore[arg-type]
            if z.kind == "pipe":
                self.pipes.setdefault(z.meta["edge_id"], []).append((zid, z.meta["s_lo_m"], z.meta["s_hi_m"]))
            if z.parent:
                self.children.setdefault(z.parent, []).append(zid)

    def known(self, zid: str) -> bool:
        return zid in self.boxes

    def contains(self, zid: str, pos: Optional[list[float]], nav: Optional[Json]) -> bool:
        box = self.boxes.get(zid)
        if box is None:
            return False
        if pos is not None and len(pos) == 3:
            (x0, y0, z0), (x1, y1, z1) = box
            p = ZONE_PAD_M
            if x0 - p <= pos[0] <= x1 + p and z0 - p <= pos[2] <= z1 + p and y0 - p <= pos[1] <= y1 + p:
                return True
        if nav and nav.get("segment_id") in self.pipes and isinstance(nav.get("s_m"), (int, float)):
            for z, lo, hi in self.pipes[nav["segment_id"]]:
                if z == zid and lo - 0.5 <= nav["s_m"] <= hi + 0.5:
                    return True
        return False


@dataclass
class _RobotState:
    last_t: float = -1e18
    mode: Any = None
    segment: Any = None
    moving: bool = False


class InterestManager:
    def __init__(self, zones: Optional[ZoneIndex] = None, clock: Callable[[], float] = time.monotonic) -> None:
        self.zones = zones
        self.clock = clock
        self.active = False
        self.visible: set[str] = set()
        self.selected: Optional[str] = None
        self.camera_mode = "overview"
        self.rates = dict(DEFAULTS)
        self.manifest_id: Optional[str] = None
        self.robots: dict[str, _RobotState] = {}
        self.elided = 0
        self.stats = {"pose_in": 0, "pose_sent": 0, "pose_elided": 0, "by_tier": {"selected": 0, "visible": 0, "background": 0}, "subscribes": 0}
        self._intervals: Optional[dict[str, float]] = None
        self._vis_cache: dict[str, bool] = {}

    # ---- subscription ------------------------------------------------------
    def apply(self, msg: Json, *, connection_run_ids: set[str]) -> Json:
        rid = msg.get("run_id")
        if rid is not None and (not isinstance(rid, str) or rid not in connection_run_ids):
            raise InterestError("run_mismatch", "this connection is bound to run " + "/".join(sorted(connection_run_ids)))
        vis = msg.get("visible_zone_ids", [])
        if not isinstance(vis, list) or len(vis) > MAX_ZONE_IDS or not all(isinstance(v, str) and 0 < len(v) <= MAX_ID_LEN for v in vis):
            raise InterestError("bad_zones", f"visible_zone_ids must be a list of <= {MAX_ZONE_IDS} ids (<= {MAX_ID_LEN} chars)")
        sel = msg.get("selected_entity_id")
        if sel is not None and (not isinstance(sel, str) or len(sel) > MAX_ID_LEN):
            raise InterestError("bad_selected", "selected_entity_id must be a string")
        cam = msg.get("camera_mode", "overview")
        if cam not in CAMERA_MODES:
            raise InterestError("bad_camera_mode", "camera_mode must be one of " + ",".join(CAMERA_MODES))
        budget = msg.get("rate_budget")
        rates = dict(DEFAULTS)
        if budget is not None:
            if isinstance(budget, bool) or not isinstance(budget, (int, float, dict)):
                raise InterestError("bad_rate_budget", "rate_budget must be a number (total Hz) or an object")
            src = {"total_hz": budget} if not isinstance(budget, dict) else budget
            for k, v in src.items():
                if k not in rates or isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
                    raise InterestError("bad_rate_budget", f"invalid rate field {k!r}")
                lo, hi = BOUNDS[k]
                rates[k] = min(max(float(v), lo), hi)
        mid = msg.get("manifest_id")
        if mid is not None and (not isinstance(mid, str) or len(mid) > 128):
            raise InterestError("bad_manifest_id", "manifest_id must be a string")
        unknown = [z for z in vis if self.zones is not None and not self.zones.known(z)]
        self.visible = {z for z in vis if z not in unknown}
        self.selected, self.camera_mode, self.rates, self.manifest_id = sel, cam, rates, mid
        self.active = True
        self._intervals = None
        self._vis_cache.clear()
        self.stats["subscribes"] += 1
        return {"unknown_zone_ids": unknown}

    # ---- policy ------------------------------------------------------------
    def intervals(self) -> dict[str, float]:
        """Seconds between periodic poses per tier, after fitting the total budget (selected has priority)."""
        if self._intervals is not None:
            return self._intervals
        r = self.rates
        n = max(len(self.robots), 1)
        n_sel = 1 if self.selected in self.robots else 0
        n_vis = sum(1 for rid in self.robots if rid != self.selected and self._is_visible(rid))
        n_bg = max(n - n_sel - n_vis, 0)
        want_sel, want_vis, want_bg = r["selected_hz"] * n_sel, r["visible_hz"] * n_vis, r["background_hz"] * n_bg
        total = r["total_hz"]
        avail = max(total - min(want_sel, total), 0.0)
        # selected is served first; visible gets up to 85 % of what is left, background the rest (but never above its own ask)
        vis_hz = r["visible_hz"]
        if want_vis > avail * 0.85 and n_vis:
            vis_hz = max(avail * 0.85 / n_vis, 0.5)
        left = max(avail - vis_hz * n_vis, 0.0)
        bg_hz = r["background_hz"]
        if want_bg > left and n_bg:
            bg_hz = left / n_bg
        sel_hz = min(r["selected_hz"], total)
        self._intervals = {"selected": 1.0 / sel_hz if sel_hz > 0 else math.inf, "visible": 1.0 / vis_hz if vis_hz > 0 else math.inf,
                           "background": 1.0 / bg_hz if bg_hz > 0.01 else math.inf}
        return self._intervals

    def _is_visible(self, rid: str, pos: Optional[list[float]] = None, nav: Optional[Json] = None) -> bool:
        if pos is None:
            return self._vis_cache.get(rid, False)
        if self.zones is None or not self.visible:
            self._vis_cache[rid] = False
            return False
        ok = any(self.zones.contains(z, pos or None, nav) for z in self.visible)
        self._vis_cache[rid] = ok
        return ok

    def tier(self, rid: str) -> str:
        if rid == self.selected:
            return "selected"
        return "visible" if self._vis_cache.get(rid) else "background"

    def should_drop(self, ev: Json) -> bool:
        """True -> elide this event on this connection. Only robot.pose is ever elided, and only after a subscribe."""
        if not self.active or ev.get("type") != "robot.pose":
            return False
        self.stats["pose_in"] += 1
        p = ev.get("payload") or {}
        rid = p.get("robot_id") or ev.get("entity_id")
        pose = p.get("pose") or {}
        nav = p.get("nav") or {}
        pos = pose.get("position_xyz_m")
        vel = pose.get("linear_velocity_mps_xyz") or [0, 0, 0]
        speed = math.sqrt(sum(float(v) ** 2 for v in vel)) if isinstance(vel, list) else 0.0
        moving = speed > STOP_SPEED_MPS
        st = self.robots.get(rid)
        if st is None:
            st = self.robots[rid] = _RobotState()
            self._intervals = None
        was = self._vis_cache.get(rid)
        now_vis = self._is_visible(rid, pos if isinstance(pos, list) else [], nav)
        if was != now_vis:
            self._intervals = None
        tier = "selected" if rid == self.selected else ("visible" if self._vis_cache.get(rid) else "background")
        now = self.clock()
        iv = self.intervals()[tier]
        mode, seg = p.get("mode"), nav.get("segment_id")
        event_pass = (st.last_t < -1e17 or mode != st.mode or seg != st.segment or (st.moving and not moving))
        due = now - st.last_t >= iv - 1e-4
        if event_pass or due:
            st.last_t, st.mode, st.segment, st.moving = now, mode, seg, moving
            self.stats["pose_sent"] += 1
            self.stats["by_tier"][tier] += 1
            return False
        self.stats["pose_elided"] += 1
        self.elided += 1
        return True

    def annotate(self, ev: Json) -> Json:
        """Attach the elision count to the next event that actually goes out."""
        if self.active and self.elided:
            ev = {**ev, "elided": self.elided}
            self.elided = 0
        return ev

    def ack(self, extra: Optional[Json] = None) -> Json:
        return {"accepted": True, "effective": {"visible_zone_ids": sorted(self.visible), "selected_entity_id": self.selected,
                                                 "camera_mode": self.camera_mode, "rates_hz": self.rates,
                                                 "intervals_s": {k: (None if math.isinf(v) else round(v, 4)) for k, v in self.intervals().items()}},
                "stats": self.stats, **(extra or {})}
