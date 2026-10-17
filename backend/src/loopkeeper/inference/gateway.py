"""ModelGateway: the single door to the provider.

Per call: replay/frozen lookup -> budget gates -> bounded queue -> rate limiter -> concurrency slot -> HTTP with backoff
(429/5xx/timeout, honours Retry-After) -> circuit breaker -> audit row (+ frozen output). At most one JSON repair per structured
call, then an explicit failure that callers turn into a *labelled* deterministic fallback. Nothing is mocked: with no key the gateway
reports `configured=False` and every call raises GatewayError('no_api_key').
"""
from __future__ import annotations

import asyncio
import email.utils
import json
import logging
import random
import time
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

import httpx

from ..intelligence.crusoe import ModelError, ModelResponse, extract_json
from .calls import CallSink, Fanout, MemorySink, ModelCallRow, sha
from .catalog import Catalog, ModelInfo, load_cache, now_iso, parse_models, save_cache
from .config import GatewayConfig, role_for_kind

log = logging.getLogger("loopkeeper.inference")
Json = dict[str, Any]
RETRY_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class GatewayError(Exception):
    """code: no_api_key | queue_full | queue_timeout | circuit_open | call_budget | spend_ceiling | replay_miss | http_<status> | timeout |
    network | empty_output | degenerate_output | invalid_output | bad_request"""

    def __init__(self, code: str, msg: str = "", status: int | None = None, attempts: int = 0):
        super().__init__(f"{code}{': ' + msg if msg else ''}")
        self.code, self.status, self.attempts = code, status, attempts


@dataclass
class GatewayResult:
    text: str
    model: str
    role: str
    call_id: str
    tokens_in: int | None
    tokens_out: int | None
    latency_ms: int
    cost_usd: float | None
    attempts: int
    source: str = "network"           # network | frozen
    parsed: Any = None
    repaired: bool = False


class Breaker:
    def __init__(self, threshold: int, cooldown_s: float, clock: Callable[[], float]) -> None:
        self.threshold, self.cooldown, self.clock = threshold, cooldown_s, clock
        self.failures = 0
        self.opened_at: float | None = None
        self.trial = False

    @property
    def state(self) -> str:
        if self.opened_at is None:
            return "closed"
        return "half_open" if self.clock() - self.opened_at >= self.cooldown else "open"

    def allow(self) -> bool:
        s = self.state
        if s == "closed":
            return True
        if s == "half_open" and not self.trial:
            self.trial = True      # exactly one probe call
            return True
        return False

    def success(self) -> None:
        self.failures, self.opened_at, self.trial = 0, None, False

    def failure(self) -> None:
        self.failures += 1
        self.trial = False
        if self.failures >= self.threshold or self.opened_at is not None:
            self.opened_at = self.clock()


class RateLimiter:
    """Sliding 60 s window of request *attempts* (retries count)."""

    def __init__(self, per_min: int, clock: Callable[[], float], sleep: Callable[[float], Awaitable[None]]) -> None:
        self.per_min, self.clock, self.sleep = per_min, clock, sleep
        self.stamps: deque[float] = deque()
        self.lock = asyncio.Lock()
        self.waited_s = 0.0

    async def acquire(self) -> None:
        async with self.lock:
            while True:
                now = self.clock()
                while self.stamps and now - self.stamps[0] >= 60.0:
                    self.stamps.popleft()
                if len(self.stamps) < self.per_min:
                    self.stamps.append(now)
                    return
                wait = 60.0 - (now - self.stamps[0]) + 0.001
                self.waited_s += wait
                await self.sleep(wait)


def parse_retry_after(v: str | None, cap: float) -> float | None:
    if not v:
        return None
    v = v.strip()
    try:
        return max(0.0, min(float(v), cap))
    except ValueError:
        pass
    try:
        dt = email.utils.parsedate_to_datetime(v)
        return max(0.0, min(dt.timestamp() - time.time(), cap))
    except Exception:  # noqa: BLE001
        return None


class ModelGateway:
    provider = "crusoe"

    def __init__(self, cfg: GatewayConfig | None = None, *, run_id: str = "run", sink: CallSink | None = None, replay: bool = False,
                 transport: httpx.AsyncBaseTransport | None = None, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep, rng: random.Random | None = None, catalog_path: Any = None,
                 probe_path: Any = None) -> None:
        self.cfg = cfg or GatewayConfig.from_env()
        self.run_id, self.replay = run_id, replay
        self.mem = MemorySink()
        self.sink: CallSink = Fanout([self.mem] + ([sink] if sink is not None else []))
        self.clock, self.sleep = clock, sleep
        self.rng = rng or random.Random()
        self.catalog: Catalog | None = None
        self.catalog_path = catalog_path
        self.probe_path = probe_path
        self._transport = transport
        self._http: httpx.AsyncClient | None = None
        self.breakers: dict[str, Breaker] = {}
        self.limiter = RateLimiter(self.cfg.max_requests_per_min, clock, sleep)
        self.sem_high = asyncio.Semaphore(self.cfg.max_concurrency_high)
        self.sem_low = asyncio.Semaphore(self.cfg.max_concurrency_low)
        self.waiting = 0
        self.calls = 0                          # logical calls (budget)
        self.spend_usd = 0.0
        self.incident_spend: dict[str, float] = {}
        self.stats = {"http_attempts": 0, "retries": 0, "frozen_hits": 0, "repairs": 0, "failures": 0}
        self._inflight: dict[str, asyncio.Future] = {}
        self.capabilities: dict[str, Json] = {}   # model -> probe results (set by probe / loaded from artifacts)
        # ModelClient protocol (DecisionService)
        self.model_id = self.cfg.models["specialist"]

    # ---- lifecycle ----------------------------------------------------
    @property
    def configured(self) -> bool:
        return self.cfg.configured

    def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(base_url=self.cfg.validate_base_url(), timeout=self.cfg.timeout_s, follow_redirects=False,
                                           transport=self._transport, headers={"Authorization": f"Bearer {self.cfg.api_key}", "Content-Type": "application/json"})
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def start(self) -> Catalog:
        cat = await self._start()
        if self.probe_path:
            self.load_capabilities(self.probe_path)
        return cat

    async def _start(self) -> Catalog:
        """Startup discovery: /models -> context, supported_parameters, pricing (cached; the catalog date is recorded in run metadata)."""
        if self.catalog_path:
            c = load_cache(self.catalog_path, self.cfg.catalog_ttl_s)
            if c is not None:
                self.catalog = c
                return c
        self.catalog = await self.discover()
        if self.catalog_path and self.catalog.source == "live":
            save_cache(self.catalog_path, self.catalog)
        return self.catalog

    def load_capabilities(self, path: Any) -> None:
        """Adopt measured capabilities (`python -m loopkeeper.inference.probe` output); unknown models keep conservative defaults."""
        try:
            d = json.loads(open(path).read())
            for m, r in d.get("models", {}).items():
                self.capabilities[m] = dict(r.get("caps", {}))
        except (OSError, ValueError):
            pass

    async def discover(self) -> Catalog:
        host = self.cfg.base_url.split("//", 1)[-1].split("/", 1)[0]
        if not self.cfg.configured:
            return Catalog({}, now_iso(), "none", host)
        try:
            r = await self._client().get("/models")
            if r.status_code != 200:
                raise GatewayError(f"http_{r.status_code}", status=r.status_code)
            return Catalog(parse_models(r.json()), now_iso(), "live", host)
        except GatewayError:
            raise
        except Exception as e:  # noqa: BLE001
            raise GatewayError("network", type(e).__name__) from None

    def model_info(self, model: str) -> ModelInfo | None:
        return self.catalog.get(model) if self.catalog else None

    def run_metadata(self) -> Json:
        """What a run records about the models it used (goes into run metadata / the scorecard)."""
        c = self.catalog
        return {"provider": self.provider, "base_host": self.cfg.base_url.split("//", 1)[-1].split("/", 1)[0], "models": dict(self.cfg.models),
                "catalog_date": c.fetched_at if c else None, "catalog_source": c.source if c else "not_loaded",
                "pricing": {m: {"in_per_mtok": i.price_in_per_mtok, "out_per_mtok": i.price_out_per_mtok} for m in set(self.cfg.models.values()) if (i := self.model_info(m))},
                "seed": self.cfg.seed, "thinking": self.cfg.thinking, "limits": {k: getattr(self.cfg, k) for k in (
                    "max_requests_per_min", "max_concurrency_high", "max_concurrency_low", "run_call_budget", "run_spend_ceiling_usd", "incident_spend_ceiling_usd")}}

    def status(self) -> Json:
        return {"configured": self.configured, "calls": self.calls, "spend_usd": round(self.spend_usd, 6), "waiting": self.waiting, **self.stats,
                "breakers": {m: b.state for m, b in self.breakers.items()}, "replay": self.replay, "sink_failures": getattr(self.sink, "failures", 0)}

    # ---- request shaping -----------------------------------------------
    def build_payload(self, *, model: str, role: str, system: str, user: str, max_tokens: int, json_mode: bool, thinking: bool | None,
                      tools: list[Json] | None = None, schema: Json | None = None) -> Json:
        info = self.model_info(model)
        sp = (lambda p: info.supports(p) if info and info.supported_parameters else True)
        think = (self.cfg.thinking_reviewer if role in ("reviewer", "reasoner") else self.cfg.thinking) if thinking is None else thinking
        body: Json = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}], "temperature": 0.0,
                      "max_tokens": max(max_tokens, 2048) if think else max_tokens}
        if sp("chat_template_kwargs"):
            body["chat_template_kwargs"] = {"enable_thinking": bool(think)}
        if self.cfg.seed is not None and sp("seed"):
            body["seed"] = self.cfg.seed
        caps = self.capabilities.get(model, {})
        if schema is not None and sp("response_format") and caps.get("json_schema", False):
            # server-side constrained decoding (probe: supported by both Nemotron tiers); the output is still validated by the caller
            body["response_format"] = {"type": "json_schema", "json_schema": {"name": (schema.get("title") or "output")[:60], "schema": schema}}
        elif json_mode and sp("response_format") and caps.get("json_object", True):
            body["response_format"] = {"type": "json_object"}
        if tools:
            body["tools"] = tools
        return body

    # ---- core ---------------------------------------------------------
    async def complete(self, *, system: str, user: str, kind: str, schema_version: str = "v1", max_tokens: int = 700, role: str | None = None,
                       json_mode: bool = True, thinking: bool | None = None, idem_key: str | None = None, task_id: str | None = None,
                       incident_id: str | None = None, parent_call_id: str | None = None, timeout_s: float | None = None,
                       repair: bool = False, schema: Json | None = None) -> GatewayResult:
        role = role or role_for_kind(kind)
        model = self.cfg.models[role]
        prompt_hash = sha(system + "\n\x00\n" + user)
        base = dict(provider=self.provider, model=model, role=role, kind=kind, schema_version=schema_version, run_id=self.run_id,
                    idempotency_key=idem_key, task_id=task_id, incident_id=incident_id, parent_call_id=parent_call_id, prompt_hash=prompt_hash, repair=repair)
        # 1. frozen output (restart / replay / duplicate delivery): never touches the network
        if idem_key:
            fz = await self._frozen(idem_key)
            if fz is not None and fz.output_text is not None:
                self.stats["frozen_hits"] += 1
                row = ModelCallRow(call_id=_cid(), ts=now_iso(), source="frozen", output_hash=fz.output_hash, tokens_in=fz.tokens_in, tokens_out=fz.tokens_out,
                                   est_cost_usd=0.0, price_basis=fz.price_basis, **base)
                self.sink.record(row)
                return GatewayResult(fz.output_text, fz.model, role, row.call_id, fz.tokens_in, fz.tokens_out, 0, 0.0, 0, "frozen")
            if idem_key in self._inflight:           # the same logical call is already running: share it
                return await asyncio.shield(self._inflight[idem_key])
        if self.replay:
            self._fail_row(base, "replay_miss", None, 0, 0)
            raise GatewayError("replay_miss", "no frozen output for this call (replay never calls the model)")
        if not self.cfg.configured:
            self._fail_row(base, "no_api_key", None, 0, 0)
            raise GatewayError("no_api_key", "CRUSOE_API_KEY is not set")
        fut: asyncio.Future | None = None
        if idem_key:
            fut = asyncio.get_running_loop().create_future()
            self._inflight[idem_key] = fut
        try:
            res = await self._execute(base, model, role, system, user, kind, max_tokens, json_mode, thinking, timeout_s, schema)
            if fut is not None:
                fut.set_result(res)
            return res
        except BaseException as e:
            if fut is not None and not fut.done():
                fut.set_exception(e if isinstance(e, Exception) else GatewayError("cancelled"))
                fut.exception()                           # mark retrieved: nobody may be waiting
            raise
        finally:
            if idem_key:
                self._inflight.pop(idem_key, None)

    async def _frozen(self, key: str) -> ModelCallRow | None:
        for s in getattr(self.sink, "sinks", []):
            f = getattr(s, "frozen", None)
            if f is None:
                continue
            try:
                r = f(key) if isinstance(s, MemorySink) else await asyncio.to_thread(f, self.run_id, key)
            except Exception:  # noqa: BLE001
                r = None
            if r is not None:
                return r
        return None

    def _gate(self, base: Json) -> None:
        if self.calls >= self.cfg.run_call_budget:
            self._fail_row(base, "call_budget", None, 0, 0)
            raise GatewayError("call_budget", f"run call budget {self.cfg.run_call_budget} reached")
        if self.spend_usd >= self.cfg.run_spend_ceiling_usd:
            self._fail_row(base, "spend_ceiling", None, 0, 0)
            raise GatewayError("spend_ceiling", f"run spend ceiling ${self.cfg.run_spend_ceiling_usd:.2f} reached")
        inc = base.get("incident_id")
        if inc and self.incident_spend.get(inc, 0.0) >= self.cfg.incident_spend_ceiling_usd:
            self._fail_row(base, "spend_ceiling", None, 0, 0)
            raise GatewayError("spend_ceiling", f"incident spend ceiling ${self.cfg.incident_spend_ceiling_usd:.2f} reached")
        br = self.breakers.setdefault(base["model"], Breaker(self.cfg.breaker_threshold, self.cfg.breaker_cooldown_s, self.clock))
        if not br.allow():
            self._fail_row(base, "circuit_open", None, 0, 0)
            raise GatewayError("circuit_open", f"breaker open for {base['model']}")

    async def _execute(self, base: Json, model: str, role: str, system: str, user: str, kind: str, max_tokens: int, json_mode: bool,
                       thinking: bool | None, timeout_s: float | None, schema: Json | None = None) -> GatewayResult:
        self._gate(base)
        if self.waiting >= self.cfg.queue_max:
            self._fail_row(base, "queue_full", None, 0, 0)
            raise GatewayError("queue_full", f"{self.waiting} requests already waiting")
        self.calls += 1
        sem = self.sem_low if role == "specialist" else self.sem_high
        self.waiting += 1
        t_queue = self.clock()
        try:
            await asyncio.wait_for(sem.acquire(), timeout=self.cfg.queue_timeout_s)
        except asyncio.TimeoutError:
            self.waiting -= 1
            self._fail_row(base, "queue_timeout", None, 0, 0)
            raise GatewayError("queue_timeout") from None
        self.waiting -= 1
        try:
            return await self._with_retries(base, model, role, system, user, max_tokens, json_mode, thinking, timeout_s, t_queue, schema)
        finally:
            sem.release()

    async def _with_retries(self, base: Json, model: str, role: str, system: str, user: str, max_tokens: int, json_mode: bool, thinking: bool | None,
                            timeout_s: float | None, t0: float, schema: Json | None = None) -> GatewayResult:
        body = self.build_payload(model=model, role=role, system=system, user=user, max_tokens=max_tokens, json_mode=json_mode, thinking=thinking, schema=schema)
        br = self.breakers[model]
        attempts = 0
        last: tuple[str, int | None] = ("network", None)
        for attempt in range(self.cfg.retries + 1):
            attempts += 1
            await self.limiter.acquire()
            self.stats["http_attempts"] += 1
            t1 = time.perf_counter()
            retry_after: float | None = None
            try:
                r = await self._client().post("/chat/completions", json=body, timeout=timeout_s or self.cfg.timeout_s)
            except httpx.TimeoutException:
                last = ("timeout", None)
            except httpx.HTTPError as e:
                last = ("network:" + type(e).__name__, None)
            else:
                lat = int((time.perf_counter() - t1) * 1000)
                if r.status_code == 200:
                    return self._finish(base, model, role, r, lat, attempts, br, t0)
                last = (f"http_{r.status_code}", r.status_code)
                retry_after = parse_retry_after(r.headers.get("retry-after"), self.cfg.retry_after_cap_s)
                if r.status_code not in RETRY_STATUS:
                    br.failure() if r.status_code >= 500 else None
                    self.stats["failures"] += 1
                    self._fail_row(base, last[0], last[1], attempts, int((self.clock() - t0) * 1000))
                    raise GatewayError(last[0], status=r.status_code, attempts=attempts)
            if attempt < self.cfg.retries:
                self.stats["retries"] += 1
                delay = retry_after if retry_after is not None else min(self.cfg.backoff_cap_s, self.cfg.backoff_base_s * (2 ** attempt)) * self.rng.random()
                await self.sleep(delay)
        br.failure()
        self.stats["failures"] += 1
        self._fail_row(base, last[0], last[1], attempts, int((self.clock() - t0) * 1000))
        raise GatewayError(last[0].split(":")[0] if last[0].startswith("network") else last[0], status=last[1], attempts=attempts)

    def _finish(self, base: Json, model: str, role: str, r: httpx.Response, lat: int, attempts: int, br: Breaker, t0: float) -> GatewayResult:
        try:
            d = r.json()
            msg = d["choices"][0]["message"]
            text = msg.get("content") or ""
            usage = d.get("usage") or {}
        except Exception:  # noqa: BLE001
            br.failure()
            self._fail_row(base, "bad_response", 200, attempts, lat)
            raise GatewayError("bad_response", "unparseable provider response", 200, attempts) from None
        tin, tout = usage.get("prompt_tokens"), usage.get("completion_tokens")
        info = self.model_info(model)
        cost = info.cost_usd(tin, tout) if info else None
        self.spend_usd += cost or 0.0
        if base.get("incident_id"):
            self.incident_spend[base["incident_id"]] = self.incident_spend.get(base["incident_id"], 0.0) + (cost or 0.0)
        # a provider 200 with unusable content still counts as spend but not as a healthy call for the breaker
        stripped = text.strip()
        err = None
        if not stripped:
            err = "empty_output"        # e.g. reasoning ON with a small max_tokens: all tokens went to reasoning_content
        elif len(text) > 200 and len(stripped) < len(text) * 0.05:
            err = "degenerate_output"   # whitespace loop
        if err:
            br.failure()
            self.stats["failures"] += 1
            self._fail_row(base, err, 200, attempts, lat, tin, tout, cost, info)
            raise GatewayError(err, status=200, attempts=attempts)
        br.success()
        row = ModelCallRow(call_id=_cid(), ts=now_iso(), http_status=200, latency_ms=lat, attempts=attempts, tokens_in=tin, tokens_out=tout,
                           est_cost_usd=cost, price_basis=self.catalog.fetched_at if self.catalog and info else None, output_hash=sha(text),
                           output_text=text, **base)
        self.sink.record(row)
        return GatewayResult(text, d.get("model") or model, role, row.call_id, tin, tout, lat, cost, attempts)

    def _fail_row(self, base: Json, code: str, status: int | None, attempts: int, lat: int, tin: int | None = None, tout: int | None = None,
                  cost: float | None = None, info: ModelInfo | None = None) -> None:
        self.sink.record(ModelCallRow(call_id=_cid(), ts=now_iso(), http_status=status, latency_ms=lat, attempts=attempts, tokens_in=tin, tokens_out=tout,
                                      est_cost_usd=cost, error=code, fallback_reason=code, **base))

    # ---- structured output (<= 1 repair) -----------------------------------
    async def complete_structured(self, *, system: str, user: str, kind: str, validate: Callable[[Any], Any], schema_version: str = "v1",
                                  **kw: Any) -> GatewayResult:
        """`validate(obj)` raises ValueError/pydantic.ValidationError on a bad object and returns the validated value. One repair, then GatewayError('invalid_output')."""
        idem = kw.pop("idem_key", None)
        res = await self.complete(system=system, user=user, kind=kind, schema_version=schema_version, idem_key=idem, **kw)
        problem = None
        try:
            res.parsed = validate(extract_json(res.text))
            return res
        except Exception as e:  # noqa: BLE001
            problem = str(e)[:200]
        if res.source == "frozen" or self.cfg.json_repairs < 1:
            raise GatewayError("invalid_output", problem or "", attempts=res.attempts)
        self.stats["repairs"] += 1
        user2 = user + "\n\nYour previous reply was rejected: " + (problem or "invalid") + "\nReply again with ONE valid JSON object only."
        kw2 = {k: v for k, v in kw.items() if k != "parent_call_id"}
        res2 = await self.complete(system=system, user=user2, kind=kind, schema_version=schema_version, idem_key=(idem + ":repair") if idem else None,
                                   parent_call_id=res.call_id, repair=True, **kw2)
        try:
            res2.parsed = validate(extract_json(res2.text))
            res2.repaired = True
            return res2
        except Exception as e:  # noqa: BLE001
            self.sink.record(ModelCallRow(call_id=_cid(), ts=now_iso(), provider=self.provider, model=res2.model, role=res2.role, kind=kind,
                                          schema_version=schema_version, run_id=self.run_id, parent_call_id=res2.call_id, repair=True,
                                          error="invalid_output", fallback_reason="invalid_output_after_repair", source="network"))
            raise GatewayError("invalid_output", str(e)[:160], attempts=res2.attempts) from None

    # ---- ModelClient protocol (intelligence.decisions.DecisionService) --------
    async def complete_json(self, *, system: str, user: str, schema_name: str, max_tokens: int = 700, timeout_s: float | None = None,
                            **meta: Any) -> ModelResponse:
        try:
            r = await self.complete(system=system, user=user, kind=schema_name, max_tokens=max_tokens, timeout_s=timeout_s, **meta)
        except GatewayError as e:
            raise ModelError(e.code, e.status) from None
        return ModelResponse(text=r.text, tokens_in=r.tokens_in, tokens_out=r.tokens_out, latency_ms=r.latency_ms, model_id=r.model)


def _cid() -> str:
    return "mc_" + uuid.uuid4().hex[:16]
