"""Default wiring of the ModelGateway as the DecisionService model client (flag INFERENCE_GATEWAY, default ON).

The agent runtime calls `build_default_gateway(intelligence_cfg, run_id, storage)` only when it was NOT handed an explicit client and a key is configured,
so tests with fakes / no key are unaffected. INFERENCE_GATEWAY=0 restores the legacy CrusoeClient (OpenAI SDK) path.

model_calls rows: always in memory (gateway.mem); additionally JSONL at $INFERENCE_CALLS_JSONL (a file path, or a directory -> <run_id>.jsonl) and, when the
engine storage is Postgres and INFERENCE_CALLS_PG is not 0, the `model_calls` table (migration 0008) through a background writer so a slow database never
blocks the event loop. Sink failures are counted, never raised."""
from __future__ import annotations

import json
import logging
import os
import queue
import tempfile
import threading
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .calls import JsonlSink, ModelCallRow, PgSink
from .config import GatewayConfig
from .gateway import ModelGateway

log = logging.getLogger("loopkeeper.inference")


def gateway_enabled(env: dict[str, str] | None = None) -> bool:
    v = ((os.environ if env is None else env).get("INFERENCE_GATEWAY") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


class ThreadedSink:
    """Wraps a blocking sink (Postgres) with a bounded queue and one daemon writer thread, so a slow database never blocks the event loop.
    Nothing is dropped silently: a full queue or a failing write SPILLS the row to a JSONL file (`spill_path`, default a per-process file in the temp dir) and
    counts it; `stats()` is surfaced through gateway.status()['audit']. `frozen()` delegates to the wrapped sink (a restart must find the stored output)."""

    def __init__(self, inner: Any, maxsize: int = 4096, spill_path: str | Path | None = None) -> None:
        self.inner, self.q = inner, queue.Queue(maxsize=maxsize)
        self.written = self.errors = self.spilled = self.spill_failed = 0
        self.spill_path = Path(spill_path) if spill_path else Path(tempfile.gettempdir()) / f"loopkeeper_model_calls_spill_{os.getpid()}.jsonl"
        self._spill_lock = threading.Lock()
        self._t = threading.Thread(target=self._loop, name="model_calls_writer", daemon=True)
        self._t.start()

    @property
    def dropped(self) -> int:                                  # rows that could not even be spilled
        return self.spill_failed

    def _spill(self, row: ModelCallRow) -> None:
        try:
            with self._spill_lock, self.spill_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(asdict(row), separators=(",", ":"), default=str) + "\n")
            self.spilled += 1
        except Exception:                                      # noqa: BLE001
            self.spill_failed += 1
            log.error("model_calls audit row lost (queue full / write failed and spill failed) call_id=%s", getattr(row, "call_id", "?"))

    def record(self, row: ModelCallRow) -> None:
        try:
            self.q.put_nowait(row)
        except queue.Full:
            self._spill(row)

    def _loop(self) -> None:
        while True:
            row = self.q.get()
            if row is None:
                self.q.task_done()
                return
            try:
                self.inner.record(row)
                self.written += 1
            except Exception:                                  # noqa: BLE001
                self.errors += 1
                self._spill(row)
            self.q.task_done()

    def frozen(self, run_id: str, key: str) -> ModelCallRow | None:
        """Exceptions propagate on purpose: the gateway turns a failed lookup into an error instead of paying for a duplicate call."""
        return self.inner.frozen(run_id, key)

    def stats(self) -> dict[str, Any]:
        return {"queued": self.q.qsize(), "written": self.written, "write_errors": self.errors, "spilled": self.spilled, "lost": self.spill_failed, "spill_path": str(self.spill_path)}

    def flush(self, timeout: float = 10.0) -> bool:
        t = threading.Thread(target=self.q.join, daemon=True)
        t.start()
        t.join(timeout)
        return not t.is_alive()

    def close(self) -> None:
        self.flush()
        self.q.put(None)


def gateway_config_for(cfg: Any, env: dict[str, str] | None = None) -> GatewayConfig:
    """GatewayConfig from the environment; an explicit IntelligenceConfig (key / base url / model names) wins so both paths talk to the same account."""
    g = GatewayConfig.from_env(env)
    if getattr(cfg, "api_key", ""):
        g.api_key = cfg.api_key
    if getattr(cfg, "base_url", ""):
        g.base_url = cfg.base_url
    if getattr(cfg, "model_deep", ""):
        g.models["reasoner"] = cfg.model_deep
        if not (env or os.environ).get("CRUSOE_MODEL_REVIEWER"):
            g.models["reviewer"] = cfg.model_deep
    if getattr(cfg, "model_name", ""):
        g.models["specialist"] = cfg.model_name
    return g


async def build_default_gateway(cfg: Any, run_id: str, storage: Any = None, env: dict[str, str] | None = None) -> ModelGateway:
    e = os.environ if env is None else env
    sinks: list[Any] = []
    jl = (e.get("INFERENCE_CALLS_JSONL") or "").strip()
    if jl:
        p = Path(jl)
        sinks.append(JsonlSink(p / f"{run_id}.jsonl" if (p.is_dir() or not p.suffix) else p))
    pool = getattr(storage, "pool", None)
    if pool is not None and getattr(storage, "kind", "") == "postgres" and (e.get("INFERENCE_CALLS_PG") or "1").strip() not in ("0", "false", "off"):
        sinks.append(ThreadedSink(PgSink(pool)))
    sink = None
    if len(sinks) == 1:
        sink = sinks[0]
    elif sinks:
        from .calls import Fanout
        sink = Fanout(sinks)
    gw = ModelGateway(gateway_config_for(cfg, env), run_id=run_id, sink=sink, catalog_path=(e.get("INFERENCE_CATALOG_PATH") or None),
                      probe_path=(e.get("INFERENCE_PROBE_PATH") or None))
    try:
        await gw.start()                                  # catalog discovery (context, params, pricing) + measured capabilities; never fatal
    except Exception as ex:                               # noqa: BLE001
        log.warning("gateway catalog discovery failed (%s); continuing with conservative defaults", type(ex).__name__)
    return gw
