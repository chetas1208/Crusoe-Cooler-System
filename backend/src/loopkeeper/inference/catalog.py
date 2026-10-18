"""Model catalog discovery: GET {base}/models -> context length, supported_parameters, pricing; cached with its date."""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

Json = dict[str, Any]


@dataclass
class ModelInfo:
    id: str
    type: str = ""
    context_length: int | None = None
    max_completion_tokens: int | None = None
    supported_parameters: list[str] = field(default_factory=list)
    price_in_per_mtok: float | None = None      # USD per 1M prompt tokens (catalog `pricing.prompt`, interpreted as per-million)
    price_out_per_mtok: float | None = None
    price_cached_in_per_mtok: float | None = None
    quantization: str | None = None

    def supports(self, param: str) -> bool:
        return param in self.supported_parameters

    def cost_usd(self, tokens_in: int | None, tokens_out: int | None) -> float | None:
        if self.price_in_per_mtok is None or self.price_out_per_mtok is None:
            return None
        return ((tokens_in or 0) * self.price_in_per_mtok + (tokens_out or 0) * self.price_out_per_mtok) / 1_000_000


@dataclass
class Catalog:
    models: dict[str, ModelInfo]
    fetched_at: str                 # ISO-8601 UTC, "the catalog date" stored in run metadata
    source: str                     # live | cache | none
    base_host: str = ""

    def get(self, model_id: str) -> ModelInfo | None:
        return self.models.get(model_id)

    def to_json(self) -> Json:
        return {"fetched_at": self.fetched_at, "source": self.source, "base_host": self.base_host,
                "models": {k: v.__dict__ for k, v in sorted(self.models.items())},
                "pricing_note": "pricing fields are the catalog's `pricing.prompt/completion`, treated as USD per 1M tokens (unit is not stated by the API); costs are estimates"}

    @classmethod
    def from_json(cls, d: Json) -> "Catalog":
        return cls({k: ModelInfo(**v) for k, v in d["models"].items()}, d["fetched_at"], d.get("source", "cache"), d.get("base_host", ""))


def _num(x: Any) -> float | None:
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def parse_models(payload: Json) -> dict[str, ModelInfo]:
    out: dict[str, ModelInfo] = {}
    for m in payload.get("data", []):
        mid = m.get("id")
        if not mid:
            continue
        pr = m.get("pricing") or {}
        tp = m.get("top_provider") or {}
        out[mid] = ModelInfo(
            id=mid, type=str(m.get("type") or ""), context_length=m.get("context_length") or tp.get("context_length"),
            max_completion_tokens=tp.get("max_completion_tokens"), supported_parameters=sorted(m.get("supported_parameters") or []),
            price_in_per_mtok=_num(pr.get("prompt")), price_out_per_mtok=_num(pr.get("completion")),
            price_cached_in_per_mtok=_num(pr.get("input_cache_reads")), quantization=m.get("quantization"))
    return out


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_cache(path: Path, ttl_s: float) -> Catalog | None:
    try:
        path = Path(path)
        d = json.loads(path.read_text())
        age = time.time() - path.stat().st_mtime
        c = Catalog.from_json(d)
        c.source = "cache"
        return c if age <= ttl_s else None
    except Exception:  # noqa: BLE001
        return None


def save_cache(path: Path, cat: Catalog) -> None:
    try:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")           # atomic: concurrent workers never read a half-written catalog
        tmp.write_text(json.dumps(cat.to_json(), indent=1, sort_keys=True) + "\n")
        os.replace(tmp, path)
    except OSError:
        pass
