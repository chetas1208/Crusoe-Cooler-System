"""Machine-readable test results for the V4 campaign: artifacts/tests/<name>.json (repo root)."""
from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

DIR = Path(__file__).resolve().parents[3] / "artifacts" / "tests"


def write_artifact(name: str, data: dict) -> Path:
    DIR.mkdir(parents=True, exist_ok=True)
    p = DIR / f"{name}.json"
    body = {"generated_by": "backend pytest", "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"), **data}
    p.write_text(json.dumps(body, indent=2, default=str))
    return p
