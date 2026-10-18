"""model_calls rows (audit; no secrets, no reasoning) and the frozen-output store used by replay."""
from __future__ import annotations

import asyncio
import hashlib
import json
import threading
from collections import OrderedDict, deque
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

Json = dict[str, Any]


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


@dataclass
class ModelCallRow:
    call_id: str
    provider: str
    model: str
    role: str
    kind: str                         # decision kind / schema name
    schema_version: str
    run_id: str
    ts: str
    idempotency_key: str | None = None
    task_id: str | None = None
    incident_id: str | None = None
    parent_call_id: str | None = None
    prompt_hash: str = ""
    output_hash: str | None = None
    latency_ms: int = 0
    attempts: int = 0
    http_status: int | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    est_cost_usd: float | None = None
    price_basis: str | None = None    # catalog date the price came from
    source: str = "network"           # network | frozen
    repair: bool = False
    error: str | None = None          # error class + status only, never a body
    fallback_reason: str | None = None
    output_text: str | None = None    # frozen for replay (assistant `content` only - never reasoning); omitted from public views

    def public(self) -> Json:
        d = asdict(self)
        d.pop("output_text", None)
        return d


class CallSink(Protocol):
    def record(self, row: ModelCallRow) -> None: ...


class MemorySink:
    """Bounded in-process audit + frozen-output index. `rows` keeps the newest `max_rows` rows (a copy; oldest evicted); `frozen()` is O(1) through a dict keyed by
    idempotency key (successful network rows with their output text), also bounded (`max_frozen`, oldest evicted)."""

    def __init__(self, max_rows: int = 20000, max_frozen: int = 20000) -> None:
        self._rows: deque[ModelCallRow] = deque(maxlen=max_rows)
        self._frozen: OrderedDict[str, ModelCallRow] = OrderedDict()
        self.max_frozen = max_frozen
        self.evicted_rows = self.evicted_frozen = 0
        self._lock = threading.Lock()

    @property
    def rows(self) -> list[ModelCallRow]:
        with self._lock:
            return list(self._rows)

    def record(self, row: ModelCallRow) -> None:
        with self._lock:
            if len(self._rows) == self._rows.maxlen:
                self.evicted_rows += 1
            self._rows.append(row)
            if row.idempotency_key and row.output_text is not None and row.error is None and row.source == "network":
                self._frozen.setdefault(row.idempotency_key, row)
                while len(self._frozen) > self.max_frozen:
                    self._frozen.popitem(last=False)
                    self.evicted_frozen += 1

    def frozen(self, key: str) -> ModelCallRow | None:
        with self._lock:
            return self._frozen.get(key)

    def stats(self) -> Json:
        return {"rows": len(self._rows), "frozen_index": len(self._frozen), "evicted_rows": self.evicted_rows, "evicted_frozen": self.evicted_frozen}


class LogSink:
    """ONE structured INFO line per model call row (provider, model, kind, latency, tokens, status, cost estimate). Never prompt / response text, never secrets."""

    def __init__(self, logger: Any = None) -> None:
        import logging
        self.log = logger or logging.getLogger("loopkeeper.model_calls")

    def record(self, row: ModelCallRow) -> None:
        self.log.info("model_call provider=%s model=%s role=%s kind=%s status=%s source=%s latency_ms=%s attempts=%s tokens_in=%s tokens_out=%s est_cost_usd=%s run_id=%s incident_id=%s task_id=%s call_id=%s",
                      row.provider, row.model, row.role, row.kind, row.error or "ok", row.source, row.latency_ms, row.attempts, row.tokens_in, row.tokens_out,
                      f"{row.est_cost_usd:.6f}" if row.est_cost_usd is not None else None, row.run_id, row.incident_id, row.task_id, row.call_id)


class JsonlSink:
    """Append-only JSONL (one file per run). Used for artifacts and as a durable fallback when no database is configured."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)

    def record(self, row: ModelCallRow) -> None:
        with self._lock, self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(asdict(row), separators=(",", ":"), default=str) + "\n")

    def load(self) -> list[ModelCallRow]:
        if not self.path.exists():
            return []
        return [ModelCallRow(**json.loads(line)) for line in self.path.read_text().splitlines() if line.strip()]

    def frozen(self, run_id: str, key: str) -> ModelCallRow | None:
        """Durable lookup for restart (no database): the first successful network row for this key."""
        for r in self.load():
            if r.idempotency_key == key and r.output_text is not None and r.error is None and r.source == "network" and r.run_id == run_id:
                return r
        return None


class PgSink:
    """Writes to the `model_calls` table (migration 0008) over the storage layer's psycopg pool (sync pool, run in a thread)."""

    COLS = ("call_id", "run_id", "provider", "model", "role", "kind", "schema_version", "ts", "idempotency_key", "task_id", "incident_id",
            "parent_call_id", "prompt_hash", "output_hash", "latency_ms", "attempts", "http_status", "tokens_in", "tokens_out",
            "est_cost_usd", "price_basis", "source", "repair", "error", "fallback_reason", "output_text")

    def __init__(self, pool: Any) -> None:
        self.pool = pool

    def record(self, row: ModelCallRow) -> None:
        d = asdict(row)
        sql = f"INSERT INTO model_calls ({','.join(self.COLS)}) VALUES ({','.join(['%s'] * len(self.COLS))}) ON CONFLICT (call_id) DO NOTHING"
        with self.pool.connection() as c:
            c.execute(sql, tuple(d[k] for k in self.COLS))

    def frozen(self, run_id: str, key: str) -> ModelCallRow | None:
        with self.pool.connection() as c:
            cur = c.execute("SELECT * FROM model_calls WHERE run_id=%s AND idempotency_key=%s AND error IS NULL AND output_text IS NOT NULL "
                            "AND source='network' ORDER BY ts LIMIT 1", (run_id, key))
            r = cur.fetchone()
        return ModelCallRow(**{k: r[k] for k in ModelCallRow.__dataclass_fields__ if k in r}) if r else None


@dataclass
class Fanout:
    """Several sinks; a failing sink never fails a model call (it is counted and logged by the gateway)."""
    sinks: list[CallSink] = field(default_factory=list)
    failures: int = 0

    def record(self, row: ModelCallRow) -> None:
        for s in self.sinks:
            try:
                s.record(row)
            except Exception:  # noqa: BLE001
                self.failures += 1

    def flush(self) -> None:
        for s in self.sinks:
            fl = getattr(s, "flush", None)
            if callable(fl):
                fl()

    def leaves(self) -> list[Any]:
        out: list[Any] = []
        for s in self.sinks:
            out.extend(s.leaves() if isinstance(s, Fanout) else [s])
        return out


async def arecord(sink: CallSink, row: ModelCallRow) -> None:
    await asyncio.to_thread(sink.record, row)
