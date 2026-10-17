"""Facility configuration loading (backend/configs/facility-large.yaml (default) or facility-small.yaml (legacy mock-parity))."""
from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG = Path(__file__).resolve().parents[3] / "configs" / "facility-v6.yaml"


def load_config(path: str | os.PathLike | None = None, overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    """Load the YAML facility config. `overrides` is a nested dict deep-merged on top (tests/scenarios)."""
    p = Path(path) if path else Path(os.environ.get("LOOPKEEPER_FACILITY_CONFIG", DEFAULT_CONFIG))
    with open(p, "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    if not isinstance(cfg, dict) or ("facility" not in cfg and "layout" not in cfg) or "physics" not in cfg:
        raise ValueError("facility config must contain 'facility' and 'physics' sections")
    if "layout" in cfg:
        # facility_layout_v6: the geometry/topology section is GENERATED from the layout parameters (single source of truth)
        from .layout_v6 import generate
        lp = dict(cfg["layout"])
        env = os.environ.get("EXTERNAL_ROBOTS_PER_CORRIDOR")
        if env not in (None, ""):
            lp["external_robots_per_corridor"] = int(env)
        gen = generate(lp, limits=cfg.get("limits"))
        cfg["facility"] = {**gen, **{k: v for k, v in (cfg.get("facility") or {}).items()}}
    if overrides:
        _merge(cfg, overrides)
    return cfg


def _merge(dst: dict, src: dict) -> None:
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _merge(dst[k], v)
        else:
            dst[k] = copy.deepcopy(v)
