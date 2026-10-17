"""In-memory Storage with the same semantics as PostgresStorage (used by unit tests and ephemeral runs)."""
from __future__ import annotations

import copy
import hashlib
import threading
from typing import Any

from .base import (RUN_UPDATE_FIELDS, CommitBatch, LeaderLease, LeadershipLost, Storage, StorageError)

_LEADERS: dict[str, dict] = {}  # process-global registry, mimics the advisory lock namespace
_LEADERS_LOCK = threading.Lock()


class _MemLease(LeaderLease):
    def __init__(self, facility_id: str, holder: str, epoch: int, token: object):
        self.facility_id, self.holder, self.epoch, self._token = facility_id, holder, epoch, token

    def held(self) -> bool:
        with _LEADERS_LOCK:
            cur = _LEADERS.get(self.facility_id)
            return bool(cur and cur["token"] is self._token)

    def heartbeat(self) -> bool:
        return self.held()

    def release(self) -> None:
        with _LEADERS_LOCK:
            cur = _LEADERS.get(self.facility_id)
            if cur and cur["token"] is self._token:
                cur["token"] = None


def _cp(x: Any) -> Any:
    return copy.deepcopy(x)


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


class MemoryStorage(Storage):
    kind = "memory"

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.facilities: dict[str, dict] = {}
        self.scenarios: dict[str, dict] = {}
        self.runs: dict[str, dict] = {}
        self.events: dict[str, dict[int, dict]] = {}
        self.commands: dict[str, dict[str, dict]] = {}
        self.snapshots: dict[str, dict[str, dict]] = {}
        self.nav_graphs: dict[tuple[str, str], dict] = {}
        self.routes: dict[str, dict[str, dict]] = {}
        self.reservations: dict[str, dict[tuple, dict]] = {}
        self.topologies: dict[tuple, dict] = {}
        self.missions: dict[str, dict[str, dict]] = {}
        self.robots: dict[str, dict[str, dict]] = {}
        self.incidents: dict[str, dict[str, dict]] = {}
        self.agent_runs: dict[str, dict[str, dict]] = {}
        self.verifications: dict[str, dict[str, dict]] = {}
        self.leases: dict[str, dict[str, dict]] = {}
        self.samples: dict[str, list[dict]] = {}
        self.effects: dict[str, set] = {}
        self.decisions: dict[str, list[dict]] = {}
        self.fail_next_commit: Exception | None = None  # test hook: simulate DB outage

    # lifecycle
    def migrate(self) -> None: pass
    def close(self) -> None: pass
    def ping(self) -> bool: return self.fail_next_commit is None

    # facility / leader / scenarios
    def register_facility(self, facility_id, config_version, topology_hash, topology) -> None:
        with self._lock:
            self.facilities[facility_id] = {"id": facility_id, "config_version": config_version,
                                            "topology_hash": topology_hash, "topology": _cp(topology)}
            self.topologies.setdefault((facility_id, topology_hash), _cp(topology))       # never overwritten

    def get_facility(self, facility_id):
        with self._lock:
            return _cp(self.facilities.get(facility_id))

    def get_topology(self, facility_id, topology_hash):
        with self._lock:
            return _cp(self.topologies.get((facility_id, topology_hash)))

    def put_topology(self, facility_id, config_version, topology_hash, topology):
        with self._lock:
            if (facility_id, topology_hash) in self.topologies:
                return False
            self.topologies[(facility_id, topology_hash)] = _cp(topology)
            return True

    def fork_run(self, child, snapshot):
        with self._lock:
            if child["run_id"] in self.runs:
                raise StorageError("run exists")
            r = _cp(child)
            r.update(kind="fork", last_tick=snapshot["tick"], last_seq=snapshot["last_seq"])
            r.setdefault("last_apply_order", 0)
            r.setdefault("created_at", _now_iso()); r.setdefault("updated_at", r["created_at"])
            self.runs[child["run_id"]] = r
            s = _cp(snapshot)
            s["reason"] = "fork_origin"
            self.snapshots.setdefault(child["run_id"], {})[s["snapshot_id"]] = s

    def acquire_leader(self, facility_id, holder):
        with _LEADERS_LOCK:
            cur = _LEADERS.setdefault(facility_id, {"token": None, "epoch": 0})
            if cur["token"] is not None:
                return None
            cur["epoch"] += 1
            token = object()
            cur["token"] = token
            return _MemLease(facility_id, holder, cur["epoch"], token)

    def _leader_epoch(self, facility_id: str) -> int:
        with _LEADERS_LOCK:
            return _LEADERS.get(facility_id, {}).get("epoch", 0)

    def save_scenario(self, row) -> None:
        with self._lock:
            self.scenarios[row["scenario_id"]] = _cp(row)

    def get_scenario(self, scenario_id):
        with self._lock:
            return _cp(self.scenarios.get(scenario_id))

    # runs
    def create_run(self, row) -> None:
        with self._lock:
            if row["run_id"] in self.runs:
                raise StorageError("run exists")
            r = _cp(row)
            r.setdefault("last_tick", 0); r.setdefault("last_seq", 0); r.setdefault("last_apply_order", 0)
            r.setdefault("created_at", _now_iso()); r.setdefault("updated_at", r["created_at"])
            r.setdefault("topology_version", f"{r.get('config_version')}#{r.get('topology_hash')}")
            self.runs[row["run_id"]] = r

    def get_run(self, run_id):
        with self._lock:
            return _cp(self.runs.get(run_id))

    def list_runs(self, facility_id=None, phases=None, limit=200):
        with self._lock:
            rows = [r for r in self.runs.values()
                    if (facility_id is None or r["facility_id"] == facility_id) and (not phases or r["phase"] in phases)]
            rows.sort(key=lambda r: (r["created_at"], r["run_id"]), reverse=True)
            return _cp(rows[:limit])

    def update_run(self, run_id, **fields) -> None:
        with self._lock:
            bad = set(fields) - set(RUN_UPDATE_FIELDS)
            if bad:
                raise StorageError(f"field not updatable: {sorted(bad)}")
            if run_id not in self.runs:
                raise StorageError("unknown run")
            self.runs[run_id].update(_cp(fields))

    # atomic write path
    def commit(self, b: CommitBatch) -> None:
        with self._lock:
            if self.fail_next_commit is not None:
                raise StorageError("simulated storage failure")
            if b.leader_epoch is not None and b.leader_epoch != self._leader_epoch(b.facility_id):
                raise LeadershipLost("stale leader epoch")
            if b.run_id not in self.runs:
                raise StorageError("unknown run")
            # validate first (atomicity): event conflicts
            evs = self.events.setdefault(b.run_id, {})
            for e in b.events:
                old = evs.get(e["seq"])
                if old is not None and old["event_hash"] != e["event_hash"]:
                    raise StorageError("event immutability violation")
            for e in b.events:
                evs.setdefault(e["seq"], _cp(e))
            cmds = self.commands.setdefault(b.run_id, {})
            for c in b.commands:
                cmds[c["command_id"]] = _cp(c)
            for table, rows, key in ((self.missions, b.missions, "mission_id"), (self.robots, b.robots, "robot_id"),
                                     (self.incidents, b.incidents, "incident_id"), (self.agent_runs, b.agent_runs, "task_id"),
                                     (self.verifications, b.verification_runs, "verification_id"),
                                     (self.leases, b.leases, "lease_id")):
                t = table.setdefault(b.run_id, {})
                for r in rows:
                    t[r[key]] = _cp(r)
            snaps = self.snapshots.setdefault(b.run_id, {})
            for s in b.snapshots:
                if any(x["tick"] == s["tick"] and x["last_seq"] == s["last_seq"] for x in snaps.values()):
                    continue
                snaps[s["snapshot_id"]] = _cp(s)
            rt = self.routes.setdefault(b.run_id, {})
            for r in getattr(b, "routes", ()):
                rt[r["plan_id"]] = _cp(r)
            rs = self.reservations.setdefault(b.run_id, {})
            for r in getattr(b, "reservations", ()):
                rs[(r["plan_id"], r["resource"], r["t0"])] = _cp(r)
            self.samples.setdefault(b.run_id, []).extend(_cp(b.sensor_samples))
            self.effects.setdefault(b.run_id, set()).update(b.applied_effects)
            if b.run_update:
                self.update_run(b.run_id, **b.run_update)

    # V7 navigation
    def register_nav_graph(self, kind, revision, nodes, edges):
        with self._lock:
            self.nav_graphs.setdefault((revision, kind), {"nodes": _cp(nodes), "edges": _cp(edges)})      # immutable: first write wins

    def load_nav_graph(self, kind, revision):
        with self._lock:
            return _cp(self.nav_graphs.get((revision, kind)))

    def load_routes(self, run_id):
        with self._lock:
            return _cp(sorted(self.routes.get(run_id, {}).values(), key=lambda r: (r.get("created_tick") or 0, r["plan_id"])))

    def load_reservations(self, run_id, state=None):
        with self._lock:
            return _cp([r for r in self.reservations.get(run_id, {}).values() if state is None or r["state"] == state])

    # snapshots
    def list_snapshots(self, run_id, to_tick=None):
        with self._lock:
            out = []
            for s in self.snapshots.get(run_id, {}).values():
                if to_tick is None or s["tick"] <= to_tick:
                    m = {k: v for k, v in s.items() if k != "state"}
                    out.append(_cp(m))
            out.sort(key=lambda s: (s["tick"], s["last_seq"]))
            return out

    def get_snapshot(self, run_id, snapshot_id):
        with self._lock:
            return _cp(self.snapshots.get(run_id, {}).get(snapshot_id))

    def latest_snapshot(self, run_id, max_tick=None, max_seq=None):
        with self._lock:
            c = [s for s in self.snapshots.get(run_id, {}).values()
                 if (max_tick is None or s["tick"] <= max_tick) and (max_seq is None or s["last_seq"] <= max_seq)]
            if not c:
                return None
            return _cp(max(c, key=lambda s: (s["tick"], s["last_seq"])))

    # events
    def load_events(self, run_id, after_seq=0, until_seq=None, until_tick=None, limit=None, kinds=None, exclude_kinds=None):
        with self._lock:
            out = []
            for seq in sorted(self.events.get(run_id, {})):
                e = self.events[run_id][seq]
                if seq <= after_seq:
                    continue
                if until_seq is not None and seq > until_seq:
                    break
                if until_tick is not None and e["tick"] > until_tick:
                    break
                if kinds and e["kind"] not in kinds:
                    continue
                if exclude_kinds and e["kind"] in exclude_kinds:
                    continue
                out.append(_cp(e))
                if limit and len(out) >= limit:
                    break
            return out

    def last_event_seq(self, run_id):
        with self._lock:
            evs = self.events.get(run_id)
            return max(evs) if evs else 0

    def events_digest(self, run_id, upto_seq=None):
        h = hashlib.sha256()
        with self._lock:
            for seq in sorted(self.events.get(run_id, {})):
                if upto_seq is not None and seq > upto_seq:
                    break
                h.update(self.events[run_id][seq]["event_hash"].encode())
        return h.hexdigest()

    # commands
    def get_command(self, run_id, command_id):
        with self._lock:
            return _cp(self.commands.get(run_id, {}).get(command_id))

    def load_commands(self, run_id, after_apply_order=0, accepted_only=True, limit=None):
        with self._lock:
            rows = [c for c in self.commands.get(run_id, {}).values()
                    if (c.get("apply_order") or 0) > after_apply_order and (not accepted_only or c["status"] != "rejected")]
            rows.sort(key=lambda c: c.get("apply_order") or 0)
            return _cp(rows[:limit] if limit else rows)

    # projections
    def load_missions(self, run_id): return _cp(list(self.missions.get(run_id, {}).values()))
    def load_robots(self, run_id): return _cp(list(self.robots.get(run_id, {}).values()))

    def load_incidents(self, run_id, open_only=False):
        rows = list(self.incidents.get(run_id, {}).values())
        if open_only:
            rows = [r for r in rows if r.get("closed_tick") is None]
        return _cp(rows)

    def load_leases(self, run_id, active_only=False):
        rows = list(self.leases.get(run_id, {}).values())
        if active_only:
            rows = [r for r in rows if r["status"] in ("pending", "active")]
        return _cp(rows)

    def record_agent_decision(self, row) -> None:
        with self._lock:
            self.decisions.setdefault(row["run_id"], []).append(_cp(row))

    def load_agent_decisions(self, run_id, from_tick=0, to_tick=None):
        with self._lock:
            return _cp([d for d in self.decisions.get(run_id, [])
                        if d["tick"] >= from_tick and (to_tick is None or d["tick"] <= to_tick)])

    def load_sensor_samples(self, run_id, asset_id, metric, since_sim_time_s=0.0, limit=5000):
        with self._lock:
            rows = [s for s in self.samples.get(run_id, [])
                    if s["sensor_id"] == asset_id and s["metric"] == metric and s["sim_time_s"] >= since_sim_time_s]
            return _cp(rows[-limit:])

    def has_applied_effect(self, run_id, effect_key):
        with self._lock:
            return effect_key in self.effects.get(run_id, set())
