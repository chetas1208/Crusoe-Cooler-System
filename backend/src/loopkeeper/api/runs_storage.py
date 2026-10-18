"""Run manager backed by the engine's storage (Neon/Postgres or memory): the Execution tab's data source.

Every run the storage knows (the live one, older live runs, forks) is listed and replayable on the topology it was RECORDED on
(`facility_topologies`, never overwritten). A fork copies one parent snapshot into a new child run (parent rows untouched, hashes
re-verified) and proves the snapshot restores on a scratch engine; the child is a persisted, paused run: it is not stepped by a
second engine worker (the 501 for "start a stepping fork" is gone, the limitation is reported in `ForkResult.rng.note`).

Checkpoints are the engine's world snapshots (taken on an interval and on every incident open/close); replay frames are those
snapshots' stored world documents, events and operator commands come from the append-only ledger. Nothing here re-runs
inference or physics. A fork is a persisted PAUSED run (no second engine worker): its state is the parent's verified checkpoint with no control lease
and a new RNG stream; every refusal is a RunError with a machine-readable code + detail."""
from __future__ import annotations

import asyncio
import concurrent.futures
import copy
import hashlib
import json
import random
import threading
import time
import zlib
from collections import OrderedDict
from typing import Any, Optional

from ..engine.config import STATE_SCHEMA_VERSION
from ..engine.eventlog import to_envelope
from ..engine.util import b64, canon, sha256_hex, unb64
from ..interfaces import EngineFacade, Json
from ..storage.base import StorageError
from ..storage.snapshot_codec import decode_state
from .scrub import scrub
from .service import RUNS_SCHEMA_VERSION, LiveOnlyRunManager, RunError, RunNotFound, now_iso, run_record

NOISY = {"world.diff", "heartbeat", "engine.health"}      # high-rate telemetry: represented by frames, not replayed event by event
MAX_FRAMES = 240
MAX_FORKS_PER_PARENT = 25                                  # a fork copies a whole checkpoint (~100 KB); bound the write amplification
CACHE_ENTRIES, CACHE_TTL_S = 64, 300.0
_IO = concurrent.futures.ThreadPoolExecutor(max_workers=6, thread_name_prefix="replay-io")      # independent window queries run concurrently (1 RTT of wall time, not 4)
_PROBE_LOCK = threading.Lock()                             # one scratch engine at a time (each builds a plant + MuJoCo runtime)


# ---------------------------------------------------------------------------------------------- restore verification
def _is_default(v: Any) -> bool:
    return v is None or v is False or v == 0 or v == "" or v == [] or v == {}


def _diff(stored: Any, restored: Any, path: str, out: list[str], added: list[str]) -> None:
    """`stored` is the ground truth. Keys the restoring code added since the snapshot was written are fine while they sit at their empty default
    (schema growth, e.g. `track.contracts` in V11); anything else that differs is a real divergence and is reported by path."""
    if len(out) >= 12:
        return
    if isinstance(stored, dict) and isinstance(restored, dict):
        for k, v in stored.items():
            if k not in restored:
                out.append(f"{path}.{k}: missing after restore")
            else:
                _diff(v, restored[k], f"{path}.{k}", out, added)
        for k, v in restored.items():
            if k not in stored:
                (added if _is_default(v) else out).append(f"{path}.{k}" + ("" if _is_default(v) else ": not in the snapshot but non-empty after restore"))
    elif isinstance(stored, list) and isinstance(restored, list):
        if len(stored) != len(restored):
            out.append(f"{path}: length {len(stored)} != {len(restored)}")
            return
        for i, (a, b) in enumerate(zip(stored, restored)):
            _diff(a, b, f"{path}[{i}]", out, added)
    elif stored != restored or isinstance(stored, bool) != isinstance(restored, bool):
        out.append(f"{path}: {str(stored)[:40]} != {str(restored)[:40]}")


def compare_restore(stored_doc: dict, restored_doc: dict) -> tuple[list[str], list[str]]:
    """(divergences, additions): the stored state document against what a scratch engine reproduced from it (plant compared by content, not blob hash)."""
    a, b = copy.deepcopy(stored_doc), json.loads(canon(restored_doc))
    for k in ("seq", "wall", "plant_hash"):
        a.pop(k, None)
        b.pop(k, None)
    pa, pb = a.pop("plant", None), b.pop("plant", None)
    out: list[str] = []
    added: list[str] = []
    _diff(a, b, "state", out, added)
    if pa is not None and pb is not None:
        _diff(json.loads(unb64(pa)), json.loads(unb64(pb)), "plant", out, added)
    return out, added


def recorded_hash_of(doc: dict) -> str:
    """The state hash exactly as the engine computed it when it wrote this document (same exclusions, plant hash taken from the document itself)."""
    from ..engine.core import SNAP_KEYS_EXCLUDED_FROM_HASH      # noqa: PLC0415
    from ..engine.util import chash                              # noqa: PLC0415
    d = copy.deepcopy(doc)
    for k in SNAP_KEYS_EXCLUDED_FROM_HASH:
        d.pop(k, None)
    return chash(d)


def derive_child_doc(doc: dict, child_id: str, parent_state_hash: str) -> dict:
    """The child's starting state: the parent's checkpoint with NO control lease carried over (every robot back to AUTONOMOUS) and a NEW
    deterministic RNG stream (engine + every plant stream re-seeded from sha256(parent state hash | child id)), so the branch is not a replay of the parent's future."""
    from ..engine.control import ControlManager                     # noqa: PLC0415
    from ..physics.rng import Rng                                   # noqa: PLC0415
    d = copy.deepcopy(doc)
    d["run_id"] = child_id
    seed = int.from_bytes(hashlib.sha256(f"{parent_state_hash}|{child_id}".encode()).digest()[:8], "big")
    v, internal, g = random.Random(seed & 0xFFFFFFFF).getstate()
    d["rng"] = [v, list(internal), g]
    plant = json.loads(unb64(d["plant"]))
    for i, name in enumerate(("sensor", "fault", "load", "aux"), 1):
        if name in plant.get("rng", {}):
            plant["rng"][name] = Rng(seed, i).get_state()
    blob = json.dumps(plant, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    d["plant"], d["plant_hash"] = b64(blob), hashlib.sha256(blob).hexdigest()
    ctl = d.get("control") or {}
    ctl["leases"] = {}
    for rid, row in (ctl.get("ctl") or {}).items():
        if row.get("state") != "AUTONOMOUS" or row.get("lease_id"):
            blank = ControlManager._blank()
            blank["epoch"] = row.get("epoch", 0)
            ctl["ctl"][rid] = blank
            rs = (d.get("robots") or {}).get(rid)
            if isinstance(rs, dict):
                rs["v"], rs["held"] = 0.0, False
    d["control"] = ctl
    return d


class RecordedRun:
    """Read-only EngineFacade over a stored run: its recorded topology + the world of its latest snapshot. Never writes."""

    def __init__(self, storage: Any, row: Json, topology: Json | None, world: Json | None) -> None:
        self.storage, self.row, self._topo, self._world = storage, row, topology, world
        self.run_id = row["run_id"]
        self.replay = True

    def topology(self) -> Json:
        if self._topo is None:
            raise RunError("topology_unavailable", f"the topology recorded for run {self.run_id} ({self.row.get('topology_version')}) is not stored", 409)
        return self._topo

    def world(self) -> Json:
        if self._world is None:
            raise RunError("not_recorded", f"run {self.run_id} has no snapshot to show", 404)
        return self._world

    def events_since(self, seq: int, limit: int = 1000) -> list[Json]:
        return [to_envelope(self.run_id, e) for e in self.storage.load_events(self.run_id, after_seq=seq, limit=limit)]

    async def submit(self, cmd: Json, **_: Any) -> Json:
        return {"accepted": False, "reason": "replay_readonly: recorded runs cannot be commanded; fork a checkpoint to act on history"}


class StorageRunManager(LiveOnlyRunManager):
    def __init__(self, engine: Any) -> None:
        super().__init__(engine)
        self._st = engine.storage
        self._cache: "OrderedDict[tuple, tuple[float, bytes]]" = OrderedDict()
        self._cache_lock = threading.Lock()
        self.cache_hits = 0

    # ------------------------------------------------------------------ helpers
    def _dt(self) -> float:
        return float(getattr(self._engine, "dt", 0.5))

    def _live_id(self) -> str:
        return self._engine.run_id

    def _row(self, run_id: str) -> Json | None:
        try:
            return self._st.get_run(run_id)
        except Exception:                                    # noqa: BLE001
            return None

    def topology_for(self, row: Json) -> Json | None:
        """The topology the run was recorded on (current one if the hashes match, else the stored registry copy; None = unavailable)."""
        cur = self._engine.topology()
        if row.get("topology_hash") in (None, "", cur.get("facility", {}).get("topology_hash")):
            return cur
        try:
            return self._st.get_topology(row["facility_id"], row["topology_hash"])
        except Exception:                                    # noqa: BLE001
            return None

    def _record(self, row: Json) -> Json:
        """RunSummary for a stored (not live) run. Values that were not recorded are zero/None, never invented."""
        rid = row["run_id"]
        snaps = self._st.list_snapshots(rid)
        try:
            children = [r["run_id"] for r in self._st.list_runs(row["facility_id"]) if r.get("parent_run_id") == rid]
        except Exception:                                    # noqa: BLE001
            children = []
        last = snaps[-1] if snaps else None
        tick = int(row.get("last_tick") or (last["tick"] if last else 0))
        return {
            "run_id": rid, "label": row.get("label") or rid, "kind": row.get("kind", "baseline"), "mode": "FORK" if row.get("kind") == "fork" else "LIVE",
            "state": "paused" if row.get("kind") == "fork" else "stopped",
            "parent_run_id": row.get("parent_run_id"), "fork_tick": row.get("fork_tick"),
            "fork_snapshot_id": (row.get("meta") or {}).get("fork_snapshot_id"), "scenario_id": row.get("scenario_id"),
            "facility_id": row["facility_id"], "seed": row.get("seed", 0), "topology_hash": row.get("topology_hash", ""),
            "topology_version": row.get("topology_version") or f"{row.get('config_version')}#{row.get('topology_hash')}",
            "schema_version": RUNS_SCHEMA_VERSION, "engine": {"backend": "live", "build": str(row.get("engine_version", ""))},
            "created_at": str(row.get("created_at") or now_iso()), "current_tick": tick, "current_time_s": round(tick * float(row.get("dt_s") or self._dt()), 3),
            "first_tick": snaps[0]["tick"] if snaps else 0,
            "recording": {"frames": len(snaps), "checkpoints": len(snaps), "events": int(row.get("last_seq") or 0), "commands": 0, "approx_bytes": 0},
            "incidents": {"opened": 0, "resolved": 0}, "children": children, "head_hash": last.get("content_hash") if last else None,
        }

    # ------------------------------------------------------------------ RunManager
    def list_runs(self) -> list[Json]:
        live = run_record(self._engine, created_at=self._created)
        try:
            snaps = self._st.list_snapshots(self._engine.run_id)
            live["recording"]["checkpoints"] = live["recording"]["frames"] = len(snaps)
            live["first_tick"] = snaps[0]["tick"] if snaps else 0
            live["recording"]["events"] = max(live["recording"].get("events", 0), self._st.last_event_seq(self._engine.run_id))
            row = self._row(self._engine.run_id) or {}
            live["topology_version"] = row.get("topology_version") or self._engine.topology().get("facility", {}).get("topology_version")
            live["head_hash"] = snaps[-1].get("content_hash") if snaps else None
        except Exception:                                    # noqa: BLE001
            pass
        out = [live]
        try:
            for row in self._st.list_runs(live["facility_id"] or None, limit=50):
                if row["run_id"] != self._engine.run_id:
                    out.append(self._record(row))
            live["children"] = [r["run_id"] for r in out[1:] if r.get("parent_run_id") == live["run_id"]]
        except Exception:                                    # noqa: BLE001
            pass
        return out

    def get_run(self, run_id: str) -> Optional[Json]:
        for r in self.list_runs():
            if r["run_id"] == run_id:
                return r
        return None

    def engine_for(self, run_id: str) -> Optional[EngineFacade]:
        if run_id == self._live_id():
            return self._engine
        row = self._row(run_id)
        if row is None:
            return None
        snap = self._st.latest_snapshot(run_id)
        return RecordedRun(self._st, row, self.topology_for(row), (snap or {}).get("world"))      # type: ignore[return-value]

    def checkpoints(self, run_id: str, to_tick: Optional[int]) -> list[Json]:
        row = self._row(run_id)
        if run_id != self._live_id() and row is None:
            raise RunNotFound(run_id)
        cur_topo = self._engine.topology().get("facility", {}).get("topology_hash")
        topo_ok = row is None or row.get("topology_hash") in (None, "", cur_topo)
        out = []
        for s in self._st.list_snapshots(run_id, to_tick):
            schema_ok = str(s.get("schema_version")) == str(STATE_SCHEMA_VERSION)
            out.append({"snapshot_id": s["snapshot_id"], "run_id": run_id, "tick": s["tick"], "sim_time_s": round(s["tick"] * self._dt(), 3),
                        "hash": s.get("content_hash") or s.get("world_hash") or "", "hash_algo": "sha256",
                        "schema_version": str(s.get("schema_version", "")), "compatible": schema_ok and topo_ok,
                        "reason": s.get("reason") if schema_ok and topo_ok else ("incompatible_snapshot" if not schema_ok else "topology_mismatch")})
        return out

    # ------------------------------------------------------------------ replay
    @staticmethod
    def _cursor(cursor: Optional[str]) -> Optional[tuple[int, int]]:
        if not cursor:
            return None
        try:
            t, q = str(cursor).split(":", 1)
            return int(t), int(q)
        except ValueError:
            raise RunError("invalid_cursor", "cursor must be '<tick>:<seq>' as returned in next_cursor", 422, {"cursor": str(cursor)[:40]})

    def _cache_get(self, key: tuple) -> Optional[bytes]:
        with self._cache_lock:
            hit = self._cache.get(key)
            if hit is None or time.monotonic() - hit[0] > CACHE_TTL_S:
                self._cache.pop(key, None)
                return None
            self._cache.move_to_end(key)
            self.cache_hits += 1
            return hit[1]

    def _cache_put(self, key: tuple, body: bytes) -> None:
        with self._cache_lock:
            self._cache[key] = (time.monotonic(), body)
            while len(self._cache) > CACHE_ENTRIES:
                self._cache.popitem(last=False)

    def _replay_sync(self, run_id: str, live: bool, row: Json | None, now_tick: int, start_tick: Optional[int], end_tick: Optional[int], stride: int,
                     include_events: bool, limit: int, cursor: Optional[str]) -> tuple[Json, bool]:
        """Snapshot + event-window projection (a handful of indexed round trips, never a scan from seq 0). Returns (window, immutable)."""
        st = self._st
        dt = self._dt()
        after = self._cursor(cursor)
        hi = int(end_tick) if end_tick is not None else now_tick
        lo_q = int(start_tick) if start_tick is not None else 0
        stride = max(1, int(stride))
        lo_ev = lo_q
        f_events = _IO.submit(st.replay_events, run_id, lo_ev, hi, after, limit + 1) if include_events else None
        f_cmds = _IO.submit(st.replay_commands, run_id, lo_q, hi)
        f_wm = _IO.submit(st.event_watermark, run_id) if (live and end_tick is not None) else None
        idx = st.replay_snapshot_window(run_id, lo_q, hi, MAX_FRAMES)
        rec_from = int(idx["first_tick"]) if idx.get("first_tick") is not None else 0
        lo = int(start_tick) if start_tick is not None else rec_from
        sel = list(idx["frames"])
        base = idx.get("base")
        picked = [s for i, s in enumerate(sel) if not (i % stride and stride > 1 and i != len(sel) - 1)]
        inherited_base = None
        if base is not None and (not picked or picked[0]["tick"] > lo):
            inherited_base = base                      # the window starts BETWEEN checkpoints: show the state it starts from, labelled inherited
        ids = ([inherited_base["snapshot_id"]] if inherited_base else []) + [s["snapshot_id"] for s in picked]
        fetch = getattr(st, "get_snapshot_replay_worlds", None) or st.get_snapshot_worlds
        worlds = fetch(run_id, ids)
        frames, cps = [], []
        for s, inh in [(inherited_base, True)] * bool(inherited_base) + [(p, False) for p in picked]:
            wd = worlds.get(s["snapshot_id"])
            if not wd:
                continue
            frames.append({"tick": s["tick"], "sim_time_s": wd.get("sim_time_s", s["tick"] * dt), "sim_speed": wd.get("sim_speed", 1.0),
                           "sim_status": wd.get("sim_status", "running"), "assets": wd.get("assets", {}), "robots": wd.get("robots", {}),
                           "kpis": wd.get("kpis", {}), "incidents": wd.get("incidents", []), "missions": wd.get("missions", {}),
                           "hash": s.get("world_hash"), "inherited": inh})
            cps.append({"snapshot_id": s["snapshot_id"], "run_id": run_id, "tick": s["tick"], "sim_time_s": round(s["tick"] * dt, 3),
                        "hash": s.get("content_hash") or "", "hash_algo": "sha256", "schema_version": str(s.get("schema_version", "")),
                        "compatible": str(s.get("schema_version")) == str(STATE_SCHEMA_VERSION), "reason": s.get("reason")})
        events: list[Json] = []
        has_more, next_cursor = False, None
        if include_events:
            rows = f_events.result()
            has_more = len(rows) > limit
            rows = rows[:limit]
            events = [to_envelope(run_id, e) for e in rows]
            if has_more and rows:
                next_cursor = f"{rows[-1]['tick']}:{rows[-1]['seq']}"
        cmds = []
        try:
            for c in f_cmds.result():
                t = c.get("applied_tick") or c.get("issued_tick") or 0
                cmds.append({"tick": t, "sim_time_s": round((c.get("applied_tick") or 0) * dt, 3), "command_id": c["command_id"], "kind": c["kind"],
                             "target_id": c.get("target_id"), "args": c.get("args") or {}, "accepted": c.get("status") == "accepted",
                             "reason": c.get("reason"), "source": "operator", "run_id": run_id})
        except Exception:                                    # noqa: BLE001
            pass
        gaps = []
        real = [f for f in frames if not f["inherited"]]
        if not frames:
            gaps.append({"from_tick": lo, "to_tick": hi, "kind": "not_recorded", "reason": "no snapshot inside or before this window"})
        else:
            if not real:
                gaps.append({"from_tick": lo, "to_tick": hi, "kind": "reduced_resolution",
                             "reason": f"no checkpoint inside this window: the frame is the state at checkpoint tick {frames[0]['tick']} (inherited); events are complete except high-rate telemetry"})
            else:
                if lo < real[0]["tick"] - 1 and not inherited_base:
                    gaps.append({"from_tick": lo, "to_tick": real[0]["tick"], "kind": "not_recorded", "reason": "before the first recorded snapshot"})
                gaps.append({"from_tick": real[0]["tick"], "to_tick": real[-1]["tick"], "kind": "reduced_resolution",
                             "reason": "frames are interval/incident snapshots (not every tick); events are complete except high-rate telemetry"})
        out = {"run_id": run_id, "schema_version": RUNS_SCHEMA_VERSION, "start_tick": lo, "end_tick": hi, "stride": stride,
               "recorded_from_tick": rec_from, "recorded_to_tick": now_tick, "frames": frames, "events": events, "commands": cmds,
               "checkpoints": cps, "gaps": gaps, "frozen_agent_decisions": True, "has_more": has_more, "next_cursor": next_cursor}
        immutable = not live
        if f_wm is not None:
            immutable = hi < int(f_wm.result()["tick"])
        return out, immutable

    async def replay_json(self, run_id: str, start_tick: Optional[int], end_tick: Optional[int], stride: int, include_events: bool, limit: int,
                          cursor: Optional[str] = None) -> bytes:
        """The scrubbed ReplayWindow as JSON bytes. Closed windows (everything at or before the committed watermark; any stored run) are immutable
        and served from a bounded LRU; replay never calls a model and never reads past `end_tick` (no future comm / event leakage)."""
        key = (run_id, start_tick, end_tick, int(stride), bool(include_events), int(limit), cursor)
        hit = self._cache_get(key)
        if hit is not None:
            return hit
        live = run_id == self._live_id()
        row = None if live else await asyncio.to_thread(self._row, run_id)
        if not live and row is None:
            raise RunNotFound(run_id)
        now_tick = int(self._engine.world().get("sim_tick", 0)) if live else int(row.get("last_tick") or 0)
        try:
            out, immutable = await asyncio.to_thread(self._replay_sync, run_id, live, row, now_tick, start_tick, end_tick, stride, include_events, limit, cursor)
        except RunError:
            raise
        except Exception as e:                               # noqa: BLE001
            raise RunError("storage_unavailable", f"the recorded history could not be read ({type(e).__name__})", 503, {"exception": type(e).__name__})
        body = json.dumps(scrub(out), separators=(",", ":"), default=str).encode()
        if immutable:
            self._cache_put(key, body)
        return body

    async def replay(self, run_id: str, start_tick: Optional[int], end_tick: Optional[int], stride: int,
                     include_events: bool, limit: int, cursor: Optional[str] = None) -> Json:
        return json.loads(await self.replay_json(run_id, start_tick, end_tick, stride, include_events, limit, cursor))

    # ------------------------------------------------------------------ fork
    def _restore_probe(self, row: Json, snap: Json) -> str:
        """Restore the snapshot on a scratch engine (own plant + memory store) and return its state hash. Kept for callers/tests that only need the hash."""
        probe, _doc = self._probe_engine(row, snap)
        return probe.state_hash()

    def _probe_engine(self, row: Json, snap: Json) -> tuple[Any, Json]:
        from ..engine import create_engine                    # noqa: PLC0415
        from ..physics import FacilityPlant                   # noqa: PLC0415
        from ..storage.memory import MemoryStorage            # noqa: PLC0415
        doc = json.loads(decode_state(snap["state"]))
        plant = FacilityPlant(seed=int(row["seed"]), config=self._engine.plant.cfg)
        probe = create_engine(plant=plant, run_id=row["run_id"], seed=int(row["seed"]), storage=MemoryStorage())   # same id: run_id is part of the state hash
        probe.load_state_doc(doc)
        return probe, doc

    def _fork_sync(self, run_id: str, row: Json, request: Json, principal: str, topo: Json, live_id: str) -> Json:
        import uuid
        st = self._st
        snap = st.get_snapshot(run_id, request["chosen_snapshot_id"])
        if snap is None:
            raise RunError("unknown_checkpoint", "that checkpoint does not exist in this run", 404, {"snapshot_id": request["chosen_snapshot_id"]})
        if int(snap["tick"]) != int(request["fork_tick"]):
            raise RunError("fork_tick_mismatch", f"fork_tick {request['fork_tick']} is not the tick of checkpoint {snap['snapshot_id']} ({snap['tick']})", 422,
                           {"fork_tick": request["fork_tick"], "checkpoint_tick": snap["tick"]})
        before = snap.get("content_hash") or ""
        if request.get("expected_parent_hash") not in (before, snap.get("world_hash"), snap.get("state_hash")):
            raise RunError("stale_parent", "the parent checkpoint hash differs from the one you saw; reload the run", 409,
                           {"expected_parent_hash": str(request.get("expected_parent_hash"))[:80], "checkpoint_hash": before})
        cur_hash = topo.get("facility", {}).get("topology_hash")
        if row.get("topology_hash") != cur_hash:
            raise RunError("topology_mismatch", f"run {run_id} was recorded on topology {row.get('topology_version')}; this engine now runs "
                           f"{topo.get('facility', {}).get('topology_version')}, so its checkpoints cannot be restored here (replay still works)", 409,
                           {"recorded_topology": row.get("topology_hash"), "current_topology": cur_hash})
        if str(snap.get("schema_version")) != str(STATE_SCHEMA_VERSION):
            raise RunError("incompatible_snapshot", f"checkpoint schema_version {snap.get('schema_version')} is not the engine's state schema {STATE_SCHEMA_VERSION}; "
                           "it can be replayed but not forked", 409, {"snapshot_schema": snap.get("schema_version"), "engine_schema": STATE_SCHEMA_VERSION})
        if sha256_hex(decode_state(snap["state"])) != before:     # content_hash = sha256 of the canonical (uncompressed) document
            raise RunError("snapshot_corrupt", "the stored checkpoint bytes do not match their recorded content hash; refusing to fork", 409, {"snapshot_id": snap["snapshot_id"]})
        try:
            kids = [r for r in st.list_runs(row["facility_id"], limit=200) if r.get("parent_run_id") == run_id]
        except Exception:                                    # noqa: BLE001
            kids = []
        if len(kids) >= MAX_FORKS_PER_PARENT:
            raise RunError("fork_limit_reached", f"run {run_id} already has {len(kids)} forks (limit {MAX_FORKS_PER_PARENT})", 409, {"forks": len(kids), "limit": MAX_FORKS_PER_PARENT})
        child_id = f"{run_id.split('_fork_')[0]}_fork_{uuid.uuid4().hex[:8]}"
        from ..engine.core import world_hash                  # noqa: PLC0415
        with _PROBE_LOCK:
            try:
                probe, doc = self._probe_engine(row, snap)
                restored_doc, restored = probe.state_doc(), probe.state_hash()
            except Exception as e:                           # noqa: BLE001
                raise RunError("restore_failed", f"checkpoint did not restore on a scratch engine ({type(e).__name__})", 409,
                               {"exception": type(e).__name__, "message": str(e)[:200], "snapshot_id": snap["snapshot_id"]})
            basis, additions = "exact", []
            if restored != snap.get("state_hash"):
                # the hash covers whatever state_doc() holds TODAY; a snapshot written by an older build lacks keys added since (V11 `contracts`, ...).
                # Compare the stored document itself, key by key: empty-default additions are schema growth, anything else is a real divergence.
                divergences, additions = compare_restore(doc, restored_doc)
                if divergences:
                    raise RunError("restore_mismatch", "restored state differs from the recorded checkpoint; refusing to fork", 409,
                                   {"divergences": divergences, "recorded_state_hash": snap.get("state_hash"), "restored_state_hash": restored})
                if recorded_hash_of(doc) != snap.get("state_hash"):
                    raise RunError("restore_mismatch", "the recorded state hash does not belong to the stored checkpoint document; refusing to fork", 409,
                                   {"divergences": ["recorded_state_hash does not match the stored document"], "recorded_state_hash": snap.get("state_hash"),
                                    "document_state_hash": recorded_hash_of(doc)})
                basis = "schema_evolved"
            parent_state_hash = snap.get("state_hash") or restored
            try:
                child_doc = derive_child_doc(doc, child_id, parent_state_hash)
                probe.run_id = child_id
                probe.control.leases.clear()                 # load_state only ADDS leases: the parent load above must not leak into the child
                probe.control.dirty.clear()
                probe.load_state_doc(child_doc)
                child_state, child_hash = probe.state_doc(), probe.state_hash()
                if probe.control.leases:
                    raise RuntimeError("lease carried into fork")
                child_world = copy.deepcopy(snap["world"])
                child_world["robots"], child_world["run_id"] = probe.robots_view(), child_id
            except Exception as e:                           # noqa: BLE001
                raise RunError("restore_failed", f"the child state could not be derived from the checkpoint ({type(e).__name__})", 409,
                               {"exception": type(e).__name__, "message": str(e)[:200], "stage": "derive_child"})
        raw = canon(child_state).encode()
        blob = zlib.compress(raw, 3)
        meta = {"fork_snapshot_id": snap["snapshot_id"], "forked_by": principal, "parent_topology_version": row.get("topology_version"),
                "parent_state_hash": parent_state_hash, "parent_content_hash": before, "parent_cut_seq": int(snap["last_seq"]),
                "restore_basis": basis, "leases_carried": 0, "rng": {"stream": f"fork:{child_id}", "derived_from": parent_state_hash},
                "stepping": "not_started: persisted paused run (no second engine worker)"}
        child = {**{k: row[k] for k in ("facility_id", "config_version", "topology_hash", "seed", "engine_version", "schema_version", "sim_speed", "dt_s")},
                 "rng_stream": f"fork:{child_id}", "run_id": child_id, "parent_run_id": run_id, "fork_tick": int(snap["tick"]), "kind": "fork", "phase": "paused",
                 "label": request.get("label") or f"Fork of {run_id} @ tick {snap['tick']}", "owner_id": principal,
                 "topology_version": row.get("topology_version"), "scenario_id": row.get("scenario_id"), "meta": meta}
        child_snap = {"snapshot_id": uuid.uuid4().hex, "tick": snap["tick"], "last_seq": snap["last_seq"], "reason": "fork_origin", "state": blob,
                      "world": child_world, "rng_state": {"engine": child_state["rng"]}, "schema_version": snap["schema_version"],
                      "engine_version": snap["engine_version"], "content_hash": sha256_hex(raw), "world_hash": world_hash(child_world), "state_hash": child_hash}
        try:
            st.fork_run(child, child_snap)
        except StorageError as e:
            raise RunError("storage_unavailable" if "exists" not in str(e) else "fork_id_collision", f"the fork could not be stored ({e})", 503 if "exists" not in str(e) else 409)
        after = (st.get_snapshot(run_id, snap["snapshot_id"]) or {}).get("content_hash") or ""
        if after != before:                                  # cannot happen (rows are never written); asserted, not assumed
            raise RunError("parent_mutated", "parent checkpoint changed during fork", 409, {"before": before, "after": after})
        return {"child_id": child_id, "snap": snap, "before": before, "after": after, "restored": restored, "basis": basis, "additions": additions,
                "child_hash": child_hash, "child_snapshot_id": child_snap["snapshot_id"], "parent_state_hash": parent_state_hash}

    async def fork(self, run_id: str, request: Json, principal: str) -> Json:
        row = await asyncio.to_thread(self._row, run_id)
        if row is None:
            raise RunNotFound(run_id)
        topo = self._engine.topology()
        try:
            r = await asyncio.to_thread(self._fork_sync, run_id, row, request, principal, topo, self._live_id())
        except StorageError as e:
            raise RunError("storage_unavailable", f"the run store is unavailable ({e})", 503)
        snap = r["snap"]
        run = await asyncio.to_thread(self.get_run, r["child_id"])
        assert run is not None
        return {"run": run, "parent_run_id": run_id, "fork_tick": int(snap["tick"]), "parent_hash_before": r["before"], "parent_hash_after": r["after"],
                "restored_hash": r["restored"], "restore_basis": r["basis"], "schema_additions": r["additions"], "child_state_hash": r["child_hash"],
                "parent_state_hash": r["parent_state_hash"], "child_snapshot_id": r["child_snapshot_id"], "leases_carried": 0,
                "rng": {"stream": "new", "note": f"the child runs a NEW deterministic RNG stream fork:{r['child_id']} derived from the parent's state hash; no control "
                                                 "lease is carried over. It is a persisted PAUSED run restored-and-verified on a scratch engine, not stepped by a second worker yet"}}
