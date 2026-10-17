"""Run manager backed by the engine's storage (Neon/Postgres or memory): the Execution tab's data source.

Every run the storage knows (the live one, older live runs, forks) is listed and replayable on the topology it was RECORDED on
(`facility_topologies`, never overwritten). A fork copies one parent snapshot into a new child run (parent rows untouched, hashes
re-verified) and proves the snapshot restores on a scratch engine; the child is a persisted, paused run: it is not stepped by a
second engine worker (the 501 for "start a stepping fork" is gone, the limitation is reported in `ForkResult.rng.note`).

Checkpoints are the engine's world snapshots (taken on an interval and on every incident open/close); replay frames are those
snapshots' stored world documents, events and operator commands come from the append-only ledger. Nothing here re-runs
inference or physics; forking still needs a second engine worker and stays unsupported until that exists (501, honest)."""
from __future__ import annotations

from typing import Any, Optional

import zlib

from ..engine.eventlog import to_envelope
from ..interfaces import EngineFacade, Json
from .service import RUNS_SCHEMA_VERSION, LiveOnlyRunManager, NotSupported, RunError, RunNotFound, now_iso, run_record

NOISY = {"world.diff", "heartbeat", "engine.health"}      # high-rate telemetry: represented by frames, not replayed event by event
MAX_FRAMES = 240


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
        if run_id != self._live_id() and self._row(run_id) is None:
            raise RunNotFound(run_id)
        out = []
        schema = getattr(self._engine.cfg, "state_schema_version", None)
        for s in self._st.list_snapshots(run_id, to_tick):
            out.append({"snapshot_id": s["snapshot_id"], "run_id": run_id, "tick": s["tick"], "sim_time_s": round(s["tick"] * self._dt(), 3),
                        "hash": s.get("content_hash") or s.get("world_hash") or "", "hash_algo": "sha256",
                        "schema_version": str(s.get("schema_version", "")), "compatible": True,
                        "reason": s.get("reason")})
        return out

    async def replay(self, run_id: str, start_tick: Optional[int], end_tick: Optional[int], stride: int,
                     include_events: bool, limit: int) -> Json:
        live = run_id == self._live_id()
        row = None if live else self._row(run_id)
        if not live and row is None:
            raise RunNotFound(run_id)
        now_tick = int(self._engine.world().get("sim_tick", 0)) if live else int(row.get("last_tick") or 0)
        snaps = self._st.list_snapshots(run_id)
        rec_from = int(snaps[0]["tick"]) if snaps else 0
        lo = int(start_tick) if start_tick is not None else rec_from
        hi = int(end_tick) if end_tick is not None else now_tick
        stride = max(1, int(stride))
        sel = [s for s in snaps if lo <= s["tick"] <= hi]
        if len(sel) > MAX_FRAMES:
            step = -(-len(sel) // MAX_FRAMES)
            sel = sel[::step]
        frames, cps = [], []
        picked = [s for i, s in enumerate(sel) if not (i % stride and stride > 1 and i != len(sel) - 1)]
        worlds = self._st.get_snapshot_worlds(run_id, [s["snapshot_id"] for s in picked])
        for s in picked:
            wd = worlds.get(s["snapshot_id"])
            if not wd:
                continue
            frames.append({"tick": s["tick"], "sim_time_s": wd.get("sim_time_s", s["tick"] * self._dt()), "sim_speed": wd.get("sim_speed", 1.0),
                           "sim_status": wd.get("sim_status", "running"), "assets": wd.get("assets", {}), "robots": wd.get("robots", {}),
                           "kpis": wd.get("kpis", {}), "incidents": wd.get("incidents", []), "missions": wd.get("missions", {}),
                           "hash": s.get("world_hash"), "inherited": False})
            cps.append({"snapshot_id": s["snapshot_id"], "run_id": run_id, "tick": s["tick"], "sim_time_s": round(s["tick"] * self._dt(), 3),
                        "hash": s.get("content_hash") or "", "hash_algo": "sha256", "schema_version": str(s.get("schema_version", "")),
                        "compatible": True, "reason": s.get("reason")})
        events: list[Json] = []
        if include_events:
            cursor = 0
            while len(events) < limit:
                page = self._st.load_events(run_id, after_seq=cursor, until_tick=hi, limit=2000, exclude_kinds=sorted(NOISY))      # the heavy world.diff rows are filtered in SQL, not after transfer
                if not page:
                    break
                cursor = page[-1]["seq"]
                for ev in page:
                    if ev["kind"] in NOISY or ev["tick"] < lo:
                        continue
                    events.append(to_envelope(run_id, ev))
                    if len(events) >= limit:
                        break
        cmds = []
        try:
            for c in self._st.load_commands(run_id, accepted_only=False, limit=5000):
                if c.get("actor_type") != "operator" or not (lo <= int(c.get("applied_tick") or c.get("issued_tick") or 0) <= hi):
                    continue
                cmds.append({"tick": c.get("applied_tick") or c.get("issued_tick") or 0, "sim_time_s": round((c.get("applied_tick") or 0) * self._dt(), 3),
                             "command_id": c["command_id"], "kind": c["kind"], "target_id": c.get("target_id"), "args": c.get("args") or {},
                             "accepted": c.get("status") == "accepted", "reason": c.get("reason"), "source": "operator", "run_id": run_id})
        except Exception:                                    # noqa: BLE001
            pass
        gaps = []
        if not frames:
            gaps.append({"from_tick": lo, "to_tick": hi, "kind": "not_recorded", "reason": "no snapshot inside this window"})
        else:
            if lo < frames[0]["tick"] - 1:
                gaps.append({"from_tick": lo, "to_tick": frames[0]["tick"], "kind": "not_recorded", "reason": "before the first recorded snapshot"})
            gaps.append({"from_tick": frames[0]["tick"], "to_tick": frames[-1]["tick"], "kind": "reduced_resolution",
                         "reason": "frames are interval/incident snapshots (not every tick); events are complete except high-rate telemetry"})
        return {"run_id": run_id, "schema_version": RUNS_SCHEMA_VERSION, "start_tick": lo, "end_tick": hi, "stride": stride,
                "recorded_from_tick": rec_from, "recorded_to_tick": now_tick, "frames": frames, "events": events, "commands": cmds,
                "checkpoints": cps, "gaps": gaps, "frozen_agent_decisions": True}

    # ------------------------------------------------------------------ fork
    def _restore_probe(self, row: Json, snap: Json) -> str:
        """Restore the snapshot on a scratch engine (own plant + memory store) and return its state hash: proves the checkpoint is restorable
        on the topology it was recorded on. The scratch engine is discarded; nothing it does is persisted."""
        from ..engine import create_engine                    # noqa: PLC0415
        from ..physics import FacilityPlant                   # noqa: PLC0415
        from ..storage.memory import MemoryStorage            # noqa: PLC0415
        plant = FacilityPlant(seed=int(row["seed"]), config=self._engine.plant.cfg)
        probe = create_engine(plant=plant, run_id=row["run_id"], seed=int(row["seed"]), storage=MemoryStorage())   # same id: run_id is part of the state hash
        import json as _json
        doc = _json.loads(zlib.decompress(snap["state"]))
        probe.load_state_doc(doc)
        return probe.state_hash()

    async def fork(self, run_id: str, request: Json, principal: str) -> Json:
        import uuid
        row = self._row(run_id)
        if row is None:
            raise RunNotFound(run_id)
        snap = self._st.get_snapshot(run_id, request["chosen_snapshot_id"])
        if snap is None:
            raise RunError("unknown_checkpoint", "that checkpoint does not exist in this run", 404)
        if int(snap["tick"]) != int(request["fork_tick"]):
            raise RunError("invalid", f"fork_tick {request['fork_tick']} is not the tick of checkpoint {snap['snapshot_id']} ({snap['tick']})", 422)
        before = snap.get("content_hash") or ""
        if request.get("expected_parent_hash") not in (before, snap.get("world_hash"), snap.get("state_hash")):
            raise RunError("stale_parent", "the parent checkpoint hash differs from the one you saw; reload the run", 409)
        cur_hash = self._engine.topology().get("facility", {}).get("topology_hash")
        if row.get("topology_hash") != cur_hash:
            raise RunError("topology_mismatch", f"run {run_id} was recorded on topology {row.get('topology_version')}; this engine now runs "
                           f"{self._engine.topology().get('facility', {}).get('topology_version')}, so its checkpoints cannot be restored here "
                           "(replay still works)", 409)
        try:
            restored = self._restore_probe(row, snap)
        except Exception as e:                               # noqa: BLE001
            raise RunError("restore_failed", f"checkpoint did not restore on a scratch engine ({type(e).__name__})", 409)
        if restored != snap.get("state_hash"):
            raise RunError("restore_mismatch", "restored state hash differs from the recorded one; refusing to fork", 409)
        child_id = f"{run_id.split('_fork_')[0]}_fork_{uuid.uuid4().hex[:8]}"
        meta = {"fork_snapshot_id": snap["snapshot_id"], "forked_by": principal, "parent_topology_version": row.get("topology_version"),
                "stepping": "not_started: persisted paused run (no second engine worker)"}
        child = {**{k: row[k] for k in ("facility_id", "config_version", "topology_hash", "seed", "rng_stream", "engine_version", "schema_version",
                                         "sim_speed", "dt_s")},
                 "run_id": child_id, "parent_run_id": run_id, "fork_tick": int(snap["tick"]), "kind": "fork", "phase": "paused",
                 "label": request.get("label") or f"Fork of {run_id} @ tick {snap['tick']}", "owner_id": principal,
                 "topology_version": row.get("topology_version"), "scenario_id": row.get("scenario_id"), "meta": meta}
        child_snap = {**snap, "snapshot_id": uuid.uuid4().hex}
        self._st.fork_run(child, child_snap)
        after = (self._st.get_snapshot(run_id, snap["snapshot_id"]) or {}).get("content_hash") or ""
        if after != before:                                  # cannot happen (rows are never written); asserted, not assumed
            raise RunError("parent_mutated", "parent checkpoint changed during fork", 500)
        run = self.get_run(child_id)
        assert run is not None
        return {"run": run, "parent_run_id": run_id, "fork_tick": int(snap["tick"]), "parent_hash_before": before, "parent_hash_after": after,
                "restored_hash": restored,
                "rng": {"stream": "inherited", "note": "RNG state comes from the checkpoint; the child is a persisted PAUSED run restored-and-verified "
                                                       "on a scratch engine, it is not stepped by a second worker yet"}}
