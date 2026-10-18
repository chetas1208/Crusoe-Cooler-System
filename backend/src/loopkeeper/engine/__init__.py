"""Package B: Engine. Single-authoritative-writer simulation engine."""
from __future__ import annotations

import os
from typing import Any, Optional

from .config import EngineConfig
from .core import Engine
from ..storage.base import Storage
from ..storage.memory import MemoryStorage


def _usable_run_id(storage: Any, run_id: str, topology_hash: str) -> str:
    base, n = run_id, 1
    while True:
        try:
            row = storage.get_run(run_id)
        except Exception:                                      # noqa: BLE001
            return run_id
        if not row or not (row.get("last_seq") or 0):
            return run_id
        try:
            snap = storage.latest_snapshot(run_id)
        except Exception:                                      # noqa: BLE001
            snap = None
        if row.get("topology_hash") == topology_hash and snap:
            return run_id
        n += 1
        run_id = f"{base}_{n}"


def backfill_topologies(storage: Any, facility_id: str) -> list[str]:
    """Recover the recorded topology of old runs whose layout was overwritten before the registry existed (migration 0002 can only copy the
    ONE row that survived). The generator is deterministic, so every shipped config is rebuilt and registered ONLY if its hash equals the
    hash a stored run recorded. Anything that does not match stays honestly 'unavailable'."""
    import logging
    from pathlib import Path
    from ..physics.config import load_config
    from ..physics.topology import build_topology
    out: list[str] = []
    try:
        wanted = {r["topology_hash"]: r for r in storage.list_runs(facility_id, limit=500)
                  if r.get("topology_hash") and storage.get_topology(facility_id, r["topology_hash"]) is None}
        if not wanted:
            return out
        cfg_dir = Path(__file__).resolve().parents[3] / "configs"
        for path in sorted(cfg_dir.glob("*.yaml")):
            try:
                topo = build_topology(load_config(str(path)))
            except Exception:                              # noqa: BLE001
                continue
            h = topo.get("facility", {}).get("topology_hash")
            if h in wanted and storage.put_topology(facility_id, topo["facility"].get("config_version", ""), h, topo):
                out.append(f"{path.name}:{h}")
    except Exception as e:                                 # noqa: BLE001
        logging.getLogger("loopkeeper.engine").warning("topology backfill skipped (%s)", type(e).__name__)
    return out


def create_engine(
    plant: Any = None,
    agent_runtime: Optional[Any] = None,
    storage: Optional[Storage] = None,
    run_id: str = "run_live",
    seed: int = 8,
    **kwargs: Any,
) -> Engine:
    """Create a real Engine instance wired to physics plant and storage."""
    if plant is None:
        from ..physics import create_plant
        plant = create_plant(seed=seed)

    topology = plant.topology()
    facility_id = topology.get("facility", {}).get("id", "lab_01")
    cfg = EngineConfig(facility_id=facility_id, seed=seed)

    if storage is None:
        db_url = os.environ.get("DATABASE_URL")
        telemetry_url = os.environ.get("TELEMETRY_DATABASE_URL")
        if db_url:
            try:
                from ..storage import open_storage
                storage = open_storage(db_url, telemetry_url=telemetry_url)                  # connects AND applies pending migrations (0002 backfills the topology registry)
            except Exception as e:                              # noqa: BLE001
                import logging
                logging.getLogger("loopkeeper.engine").error("persistent storage unavailable (%s): running with an IN-MEMORY store, "
                                                             "history will not survive a restart", type(e).__name__)
                storage = MemoryStorage()
        else:
            storage = MemoryStorage()

    config_version = topology.get("facility", {}).get("config_version", "v1")
    topology_hash = topology.get("facility", {}).get("topology_hash", "th_default")

    # A persisted run can only be resumed when it can be restored faithfully (same topology + a snapshot). Otherwise this
    # process starts a NEW run id (history of the old one is kept untouched) so old command ids / seqs cannot collide.
    run_id = _usable_run_id(storage, run_id, topology.get("facility", {}).get("topology_hash", ""))

    compact = getattr(storage, "compact_telemetry", None)
    if callable(compact):
        import logging
        res = compact(run_id)
        if res.get("dropped_rows") or res.get("error"):
            logging.getLogger("loopkeeper.engine").info("sensor_samples compaction for %s: %s", run_id, res)

    retain = getattr(storage, "apply_retention", None)
    if callable(retain) and os.environ.get("LOOPKEEPER_RETENTION", "thin") != "off":
        import logging
        res = retain(run_id)
        if res.get("deleted") or res.get("error"):
            logging.getLogger("loopkeeper.engine").info("snapshot retention: %s", res)

    # Ensure facility and assets exist in storage
    try:
        storage.register_facility(facility_id, config_version, topology_hash, topology)
        backfill_topologies(storage, facility_id)
    except Exception:
        pass
    backfill = getattr(storage, "backfill_telemetry_runs", None)
    if callable(backfill):
        try:
            n = backfill()
            if n:
                import logging
                logging.getLogger("loopkeeper.engine").info("telemetry database: mirrored %d run row(s) it was missing", n)
        except Exception:                                  # noqa: BLE001
            pass

    # a process restart that starts a NEW run id leaves the previous baseline "running" in the database forever: mark it stopped (history untouched)
    try:
        for r in storage.list_runs(facility_id, phases=["running", "paused"], limit=200):
            if r["run_id"] != run_id and r.get("kind") == "baseline":
                storage.update_run(r["run_id"], phase="stopped")
    except Exception:                                  # noqa: BLE001
        pass

    # Ensure run entry exists in storage
    try:
        storage.create_run({
            "run_id": run_id,
            "facility_id": facility_id,
            "config_version": config_version,
            "topology_hash": topology_hash,
            "topology_version": topology.get("facility", {}).get("topology_version") or f"{config_version}#{topology_hash}",
            "seed": seed,
            "rng_stream": "main",
            "kind": "baseline",
            "label": "Live baseline",
            "phase": "running",
            "owner_id": None,
            "engine_version": "1.0",
            "schema_version": 1,
            "sim_speed": cfg.sim_speed,
            "dt_s": cfg.dt_s,
            "last_tick": 0,
            "last_seq": 0,
            "last_apply_order": 0,
            "meta": {},
        })
    except Exception:
        pass

    eng = Engine(
        run_id=run_id,
        cfg=cfg,
        plant=plant,
        topology=topology,
        storage=storage,
        agents=agent_runtime,
        seed=seed,
        **kwargs,
    )
    if os.environ.get("LOOPKEEPER_RESUME", "1") != "0":
        eng.recover_from_storage()           # no-op for a brand-new run
    eng.navigation.persist_graphs()          # immutable graph versions + pin the run to the revision it navigates on
    return eng


__all__ = ["Engine", "EngineConfig", "create_engine"]
