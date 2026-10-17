"""V11 model gateway: catalog, limits, retries, breaker, budgets, idempotency/replay, structured repair. No network: httpx.MockTransport."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from loopkeeper.inference.calls import JsonlSink, ModelCallRow
from loopkeeper.inference.catalog import Catalog, parse_models
from loopkeeper.inference.config import GatewayConfig, role_for_kind
from loopkeeper.inference.gateway import Breaker, GatewayError, ModelGateway, parse_retry_after

MODELS = {"data": [
    {"id": "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B", "type": "chat", "context_length": 262144, "supported_parameters": ["seed", "response_format", "chat_template_kwargs", "tools", "structured_outputs"],
     "pricing": {"prompt": "0.30", "completion": "2.40", "input_cache_reads": "0.15"}, "top_provider": {"max_completion_tokens": 262144}},
    {"id": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "type": "chat", "context_length": 262144, "supported_parameters": ["seed", "response_format", "chat_template_kwargs"],
     "pricing": {"prompt": "0.05", "completion": "0.20"}},
]}
OK = {"model": "m", "choices": [{"message": {"content": '{"ok": true}'}}], "usage": {"prompt_tokens": 1000, "completion_tokens": 100}}


class Provider:
    """Scripted provider: each entry is an httpx.Response factory or an exception to raise."""

    def __init__(self, script=None):
        self.script = list(script or [])
        self.requests: list[httpx.Request] = []
        self.inflight = 0
        self.max_inflight = 0
        self.delay = 0.0

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json=MODELS)
        self.inflight += 1
        self.max_inflight = max(self.max_inflight, self.inflight)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            step = self.script.pop(0) if self.script else httpx.Response(200, json=OK)
            if isinstance(step, Exception):
                raise step
            return step
        finally:
            self.inflight -= 1

    @property
    def chat(self):
        return [r for r in self.requests if r.url.path.endswith("/chat/completions")]


class Sleeps:
    def __init__(self):
        self.calls: list[float] = []

    async def __call__(self, s: float):
        self.calls.append(s)


def mk(provider=None, *, key="sk-test-SECRET", sleeps=None, **cfg):
    provider = provider or Provider()
    sleeps = sleeps or Sleeps()
    c = GatewayConfig(api_key=key, base_url="https://inference.example/v1", **cfg)
    gw = ModelGateway(c, run_id="run_t", transport=httpx.MockTransport(provider), sleep=sleeps)
    return gw, provider, sleeps


def run(coro):
    return asyncio.run(coro)


async def call(gw, kind="classify", **kw):
    return await gw.complete(system="sys", user="usr", kind=kind, **kw)


# ---------------------------------------------------------------- config + catalog
def test_env_spec_names_and_legacy_aliases():
    e = GatewayConfig.from_env({"CRUSOE_API_KEY": "k", "MODEL_NAME": "nano-x", "MODEL_NAME_DEEP": "super-y", "MODEL_BASE_URL": "https://a.example/v1"})
    assert e.models == {"reasoner": "super-y", "specialist": "nano-x", "reviewer": "super-y"} and e.base_url == "https://a.example/v1"
    n = GatewayConfig.from_env({"CRUSOE_MODEL_REASONER": "r", "CRUSOE_MODEL_SPECIALIST": "s", "CRUSOE_MODEL_REVIEWER": "v", "CRUSOE_BASE_URL": "https://b.example/v1",
                                "MODEL_NAME": "ignored", "CRUSOE_MAX_REQUESTS_PER_MIN": "12", "CRUSOE_SPEND_CEILING_USD": "0.25"})
    assert n.models == {"reasoner": "r", "specialist": "s", "reviewer": "v"} and n.max_requests_per_min == 12 and n.run_spend_ceiling_usd == 0.25
    d = GatewayConfig.from_env({})
    assert d.models["reasoner"].endswith("Super-120B-A12B") and d.models["specialist"].endswith("Nano-30B-A3B") and not d.configured
    assert d.max_concurrency_high == 2


def test_role_for_kind():
    assert role_for_kind("verify") == "reviewer" and role_for_kind("replan") == "reasoner" and role_for_kind("classify") == "specialist"


def test_config_never_exposes_key_and_rejects_bad_urls():
    c = GatewayConfig(api_key="sk-secret", base_url="https://x.example/v1")
    assert "sk-secret" not in json.dumps(c.public()) and c.public()["api_key_set"] is True
    for bad in ("http://evil.example/v1", "https://u:p@x.example/v1", "ftp://x"):
        with pytest.raises(ValueError):
            GatewayConfig(base_url=bad).validate_base_url()
    GatewayConfig(base_url="http://localhost:9/v1").validate_base_url()


def test_catalog_discovery_parses_pricing_context_params_and_records_date():
    gw, prov, _ = mk()
    cat = run(gw.start())
    sup = cat.get("nvidia/NVIDIA-Nemotron-3-Super-120B-A12B")
    assert cat.source == "live" and cat.fetched_at.endswith("Z") and sup.context_length == 262144 and sup.supports("tools")
    assert sup.price_in_per_mtok == 0.30 and sup.price_out_per_mtok == 2.40
    assert sup.cost_usd(1_000_000, 1_000_000) == pytest.approx(2.70)
    meta = gw.run_metadata()
    assert meta["catalog_date"] == cat.fetched_at and meta["models"]["specialist"].endswith("Nano-30B-A3B") and "api_key" not in json.dumps(meta)
    assert Catalog.from_json(json.loads(json.dumps(cat.to_json()))).models.keys() == cat.models.keys()
    assert parse_models({"data": [{"id": "x"}]})["x"].price_in_per_mtok is None


def test_catalog_cache_roundtrip(tmp_path):
    gw, prov, _ = mk()
    gw.catalog_path = tmp_path / "cat.json"
    run(gw.start())
    n = len(prov.requests)
    gw2, prov2, _ = mk()
    gw2.catalog_path = tmp_path / "cat.json"
    c2 = run(gw2.start())
    assert c2.source == "cache" and len(prov2.requests) == 0 and n == 1


# ---------------------------------------------------------------- happy path + request shape
def test_success_records_row_with_cost_hash_and_no_secrets():
    gw, prov, _ = mk()
    run(gw.start())

    async def go():
        return await call(gw, kind="replan", idem_key="k1", task_id="T1", incident_id="INC-1")
    r = run(go())
    assert r.text == '{"ok": true}' and r.role == "reasoner" and r.cost_usd == pytest.approx((1000 * 0.30 + 100 * 2.40) / 1e6)
    body = json.loads(prov.chat[0].content)
    assert body["model"].endswith("Super-120B-A12B") and body["chat_template_kwargs"] == {"enable_thinking": False} and body["seed"] == 7
    assert body["response_format"] == {"type": "json_object"} and body["temperature"] == 0.0
    assert prov.chat[0].headers["authorization"] == "Bearer sk-test-SECRET"
    row = gw.mem.rows[-1]
    assert row.call_id and row.model == body["model"] and row.tokens_in == 1000 and row.tokens_out == 100 and row.task_id == "T1" and row.incident_id == "INC-1"
    assert row.output_hash and row.prompt_hash and row.error is None and row.price_basis == gw.catalog.fetched_at
    pub = json.dumps(row.public()) + json.dumps(gw.status()) + json.dumps(gw.run_metadata())
    assert "SECRET" not in pub and "sys" not in row.public().values()


def test_thinking_on_raises_token_floor_and_unsupported_params_are_omitted():
    gw, prov, _ = mk()
    run(gw.start())
    run(call(gw, kind="classify", thinking=True, max_tokens=300))
    b = json.loads(prov.chat[0].content)
    assert b["max_tokens"] >= 2048 and b["chat_template_kwargs"]["enable_thinking"] is True
    gw2, prov2, _ = mk()
    gw2.catalog = Catalog(parse_models({"data": [{"id": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "supported_parameters": ["max_tokens"]}]}), "d", "live")
    run(call(gw2, kind="classify"))
    b2 = json.loads(prov2.chat[0].content)
    assert "seed" not in b2 and "response_format" not in b2 and "chat_template_kwargs" not in b2


# ---------------------------------------------------------------- failures
def test_missing_key_is_explicit_and_makes_no_http_call():
    gw, prov, _ = mk(key="")
    with pytest.raises(GatewayError) as ei:
        run(call(gw))
    assert ei.value.code == "no_api_key" and prov.requests == [] and gw.mem.rows[-1].error == "no_api_key"
    assert run(gw.discover()).source == "none"


def test_429_honours_retry_after_then_succeeds():
    gw, prov, sl = mk(Provider([httpx.Response(429, headers={"Retry-After": "3"}), httpx.Response(429, headers={"Retry-After": "1.5"})]))
    r = run(call(gw))
    assert r.attempts == 3 and sl.calls == [3.0, 1.5] and gw.stats["retries"] == 2 and len(prov.chat) == 3


def test_503_backoff_is_exponential_with_jitter_and_capped():
    gw, prov, sl = mk(Provider([httpx.Response(503)] * 3 + [httpx.Response(200, json=OK)]), backoff_base_s=1.0, backoff_cap_s=3.0)
    class R:
        def random(self): return 1.0
    gw.rng = R()
    r = run(call(gw))
    assert r.attempts == 4 and sl.calls == [1.0, 2.0, 3.0]


def test_retries_exhausted_raises_with_status_and_opens_breaker():
    gw, prov, _ = mk(Provider([httpx.Response(503)] * 40), retries=1, breaker_threshold=2)
    for _ in range(2):
        with pytest.raises(GatewayError) as ei:
            run(call(gw))
        assert ei.value.code == "http_503" and ei.value.status == 503 and ei.value.attempts == 2
    n = len(prov.chat)
    with pytest.raises(GatewayError) as ei:
        run(call(gw))
    assert ei.value.code == "circuit_open" and len(prov.chat) == n          # open breaker: no request at all
    assert gw.status()["breakers"][gw.cfg.models["specialist"]] == "open"


def test_breaker_half_open_single_probe_and_recovery():
    t = [0.0]
    b = Breaker(2, 30.0, lambda: t[0])
    b.failure(); b.failure()
    assert b.state == "open" and not b.allow()
    t[0] = 31.0
    assert b.state == "half_open" and b.allow() and not b.allow()           # exactly one trial call
    b.failure()
    assert b.state == "open"
    t[0] = 70.0
    assert b.allow(); b.success()
    assert b.state == "closed" and b.allow()


def test_timeout_is_retried_then_reported():
    gw, prov, _ = mk(Provider([httpx.ReadTimeout("slow")] * 5), retries=2)
    with pytest.raises(GatewayError) as ei:
        run(call(gw))
    assert ei.value.code == "timeout" and ei.value.attempts == 3
    gw2, _, _ = mk(Provider([httpx.ReadTimeout("slow"), httpx.Response(200, json=OK)]))
    assert run(call(gw2)).attempts == 2


def test_400_401_are_not_retried_and_do_not_trip_the_breaker():
    gw, prov, sl = mk(Provider([httpx.Response(401, json={"error": "bad key"})] * 5), breaker_threshold=1)
    for _ in range(3):
        with pytest.raises(GatewayError) as ei:
            run(call(gw))
        assert ei.value.code == "http_401" and ei.value.attempts == 1
    assert sl.calls == [] and gw.status()["breakers"][gw.cfg.models["specialist"]] == "closed"
    assert "bad key" not in json.dumps([r.public() for r in gw.mem.rows])   # provider bodies never land in rows


def test_empty_and_whitespace_loop_outputs_are_explicit_errors():
    empty = httpx.Response(200, json={"choices": [{"message": {"content": "", "reasoning_content": "thinking..."}}], "usage": {"prompt_tokens": 10, "completion_tokens": 300}})
    loop = httpx.Response(200, json={"choices": [{"message": {"content": " \n" * 600 + "x"}}], "usage": {"prompt_tokens": 10, "completion_tokens": 1200}})
    gw, _, _ = mk(Provider([empty, loop]))
    run(gw.start())
    for code in ("empty_output", "degenerate_output"):
        with pytest.raises(GatewayError) as ei:
            run(call(gw))
        assert ei.value.code == code
    assert gw.mem.rows[-1].tokens_out == 1200 and gw.spend_usd > 0           # tokens were still paid for and are accounted


def test_bad_provider_body_is_a_gateway_error():
    gw, _, _ = mk(Provider([httpx.Response(200, content=b"<html>")]))
    with pytest.raises(GatewayError) as ei:
        run(call(gw))
    assert ei.value.code == "bad_response"


# ---------------------------------------------------------------- budgets, queue, rate, concurrency
def test_call_budget_and_spend_ceilings():
    gw, prov, _ = mk(run_call_budget=2)
    run(gw.start())
    async def go():
        await call(gw); await call(gw)
        with pytest.raises(GatewayError) as ei:
            await call(gw)
        assert ei.value.code == "call_budget"
    run(go())
    assert len(prov.chat) == 2
    gw2, prov2, _ = mk(run_spend_ceiling_usd=0.001, incident_spend_ceiling_usd=10)
    run(gw2.start())
    async def go2():
        await call(gw2, kind="replan")                         # ~ $0.00054
        await call(gw2, kind="replan")                         # crosses the $0.001 line
        with pytest.raises(GatewayError) as ei:
            await call(gw2, kind="replan")
        assert ei.value.code == "spend_ceiling"
    run(go2())
    gw3, prov3, _ = mk(incident_spend_ceiling_usd=0.0004)
    run(gw3.start())
    async def go3():
        await call(gw3, kind="replan", incident_id="INC-1")
        with pytest.raises(GatewayError) as ei:
            await call(gw3, kind="replan", incident_id="INC-1")
        assert ei.value.code == "spend_ceiling"
        await call(gw3, kind="replan", incident_id="INC-2")    # another incident still has its own allowance
    run(go3())


def test_high_cost_concurrency_is_capped_at_two_and_specialist_at_four():
    prov = Provider()
    prov.delay = 0.02
    gw, _, _ = mk(prov)
    async def go():
        await asyncio.gather(*[call(gw, kind="replan") for _ in range(8)])
    run(go())
    assert prov.max_inflight == 2
    prov2 = Provider(); prov2.delay = 0.02
    gw2, _, _ = mk(prov2)
    async def go2():
        await asyncio.gather(*[call(gw2, kind="classify") for _ in range(10)])
    run(go2())
    assert prov2.max_inflight == 4


def test_bounded_queue_refuses_when_full():
    prov = Provider(); prov.delay = 0.05
    gw, _, _ = mk(prov, queue_max=3, max_concurrency_high=1)
    async def go():
        res = await asyncio.gather(*[call(gw, kind="replan") for _ in range(8)], return_exceptions=True)
        return res
    res = run(go())
    refused = [r for r in res if isinstance(r, GatewayError) and r.code == "queue_full"]
    done = [r for r in res if not isinstance(r, Exception)]
    assert refused and done and len(refused) + len(done) == 8 and gw.waiting == 0


def test_rate_limiter_blocks_the_n_plus_first_request_for_the_window():
    t = [0.0]
    waits: list[float] = []
    async def sleep(s):
        waits.append(s); t[0] += s
    prov = Provider()
    gw = ModelGateway(GatewayConfig(api_key="k", base_url="https://i.example/v1", max_requests_per_min=3), transport=httpx.MockTransport(prov),
                      clock=lambda: t[0], sleep=sleep)
    async def go():
        for _ in range(4):
            await call(gw)
    run(go())
    assert len(waits) == 1 and 59.9 < waits[0] < 60.1 and len(prov.chat) == 4


def test_retry_after_parsing():
    assert parse_retry_after("2", 60) == 2.0 and parse_retry_after("999", 60) == 60 and parse_retry_after("junk", 60) is None and parse_retry_after(None, 60) is None


# ---------------------------------------------------------------- idempotency / replay / frozen outputs
def test_idempotency_key_freezes_output_no_second_request():
    gw, prov, _ = mk()
    async def go():
        a = await call(gw, idem_key="inc1:verify:1")
        b = await call(gw, idem_key="inc1:verify:1")
        return a, b
    a, b = run(go())
    assert len(prov.chat) == 1 and b.source == "frozen" and b.text == a.text and b.cost_usd == 0.0 and b.attempts == 0
    assert [r.source for r in gw.mem.rows] == ["network", "frozen"]


def test_concurrent_duplicate_delivery_shares_one_call():
    prov = Provider(); prov.delay = 0.03
    gw, _, _ = mk(prov)
    async def go():
        return await asyncio.gather(*[call(gw, idem_key="same") for _ in range(5)])
    res = run(go())
    assert len(prov.chat) == 1 and len({r.text for r in res}) == 1


def test_replay_mode_serves_frozen_and_never_calls_the_provider(tmp_path):
    sink = JsonlSink(tmp_path / "calls.jsonl")
    gw, prov, _ = mk()
    gw.sink.sinks.append(sink)
    run(call(gw, idem_key="K"))
    rows = sink.load()
    assert rows[0].output_text == '{"ok": true}' and rows[0].call_id
    # a fresh process in replay mode, fed from the persisted rows
    prov2 = Provider()
    gw2 = ModelGateway(GatewayConfig(api_key="", base_url="https://i.example/v1"), run_id="run_t", replay=True, transport=httpx.MockTransport(prov2))
    for r in rows:
        gw2.mem.record(r)
    r2 = run(call(gw2, idem_key="K"))
    assert r2.source == "frozen" and r2.text == '{"ok": true}' and prov2.requests == []
    with pytest.raises(GatewayError) as ei:
        run(call(gw2, idem_key="never-seen"))
    assert ei.value.code == "replay_miss" and prov2.requests == []


def test_failed_calls_are_not_frozen():
    gw, prov, _ = mk(Provider([httpx.Response(401)]))
    with pytest.raises(GatewayError):
        run(call(gw, idem_key="K"))
    assert run(call(gw, idem_key="K")).source == "network"                  # error rows never satisfy an idempotency lookup


# ---------------------------------------------------------------- structured output: <= 1 repair
def _validator(o):
    if not isinstance(o, dict) or "action" not in o:
        raise ValueError("missing action")
    return o["action"]


def _chat(text):
    return httpx.Response(200, json={"choices": [{"message": {"content": text}}], "usage": {"prompt_tokens": 100, "completion_tokens": 10}})


def test_structured_ok_first_try_no_repair():
    gw, prov, _ = mk(Provider([_chat('```json\n{"action": "isolate"}\n```')]))
    r = run(gw.complete_structured(system="s", user="u", kind="verify", validate=_validator))
    assert r.parsed == "isolate" and not r.repaired and len(prov.chat) == 1


def test_structured_single_repair_then_success():
    gw, prov, _ = mk(Provider([_chat("not json at all"), _chat('{"action": "brush"}')]))
    r = run(gw.complete_structured(system="s", user="u", kind="verify", validate=_validator, idem_key="x"))
    assert r.parsed == "brush" and r.repaired and len(prov.chat) == 2 and gw.stats["repairs"] == 1
    assert "rejected" in json.loads(prov.chat[1].content)["messages"][1]["content"]
    rows = gw.mem.rows
    assert rows[1].repair and rows[1].parent_call_id == rows[0].call_id


def test_structured_second_failure_is_explicit_after_exactly_one_repair():
    gw, prov, _ = mk(Provider([_chat("nope"), _chat('{"wrong": 1}'), _chat('{"action": "never reached"}')]))
    with pytest.raises(GatewayError) as ei:
        run(gw.complete_structured(system="s", user="u", kind="verify", validate=_validator))
    assert ei.value.code == "invalid_output" and len(prov.chat) == 2        # original + ONE repair, never a third call
    assert gw.mem.rows[-1].error == "invalid_output"


def test_structured_frozen_invalid_output_is_not_repaired_on_replay():
    gw, prov, _ = mk(Provider([_chat("nope")]))
    run(call(gw, kind="verify", idem_key="z"))                              # the (invalid) output is frozen under z
    n = len(prov.chat)
    with pytest.raises(GatewayError) as ei:
        run(gw.complete_structured(system="s", user="u", kind="verify", validate=_validator, idem_key="z"))
    assert ei.value.code == "invalid_output" and len(prov.chat) == n        # replay never repairs (that would be a new inference)


# ---------------------------------------------------------------- DecisionService integration (the gateway is a ModelClient)
def test_gateway_is_a_drop_in_model_client_for_decision_service():
    from pydantic import BaseModel
    from loopkeeper.intelligence import decisions as D
    from loopkeeper.intelligence.crusoe import ModelStatus
    kind = next(iter(D.SCHEMAS))
    gw, prov, _ = mk(Provider([httpx.Response(429, headers={"Retry-After": "0"})]))
    out = D.SCHEMAS[kind].model_json_schema()
    assert gw.provider == "crusoe" and gw.model_id
    # protocol surface used by DecisionService
    resp = run(gw.complete_json(system="s", user="u", schema_name=kind, max_tokens=50))
    assert resp.text and resp.tokens_in == 1000 and resp.model_id
    from loopkeeper.intelligence.crusoe import ModelError
    gw2, _, _ = mk(Provider([httpx.Response(401)]))
    with pytest.raises(ModelError) as ei:
        run(gw2.complete_json(system="s", user="u", schema_name=kind))
    assert ei.value.status == 401


def test_json_schema_constrained_decoding_is_used_only_for_models_probed_to_support_it(tmp_path):
    probe = tmp_path / "p.json"
    probe.write_text(json.dumps({"models": {"nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": {"caps": {"json_schema": True, "json_object": True}}}}))
    prov = Provider()
    gw = ModelGateway(GatewayConfig(api_key="k", base_url="https://i.example/v1"), transport=httpx.MockTransport(prov), probe_path=probe)
    run(gw.start())
    schema = {"title": "Act", "type": "object", "properties": {"action": {"type": "string"}}, "required": ["action"]}
    run(call(gw, kind="classify", schema=schema))
    assert json.loads(prov.chat[0].content)["response_format"]["type"] == "json_schema"
    run(call(gw, kind="replan", schema=schema))                       # reasoner model has no probe entry -> conservative json_object
    assert json.loads(prov.chat[1].content)["response_format"] == {"type": "json_object"}


# ---------------------------------------------------------------- live (real Crusoe call; opt-in so the suite never spends credits by default)
@pytest.mark.skipif(not (__import__("os").environ.get("CRUSOE_API_KEY") and __import__("os").environ.get("LK_LIVE_MODEL_TESTS") == "1"), reason="set LK_LIVE_MODEL_TESTS=1 and CRUSOE_API_KEY")
def test_live_gateway_roundtrip_specialist_and_reasoner(tmp_path):
    cfg = GatewayConfig.from_env()
    gw = ModelGateway(cfg, run_id="live_t", sink=JsonlSink(tmp_path / "rows.jsonl"))
    async def go():
        cat = await gw.start()
        a = await gw.complete_structured(system="Reply with JSON only.", user='Return {"pump": "t1"}', kind="classify", validate=lambda o: o["pump"], max_tokens=60, idem_key="live-a")
        b = await gw.complete_structured(system="Reply with JSON only.", user='Return {"verdict": "pass"}', kind="verify", validate=lambda o: o["verdict"], max_tokens=60, idem_key="live-b")
        again = await gw.complete(system="x", user="y", kind="classify", idem_key="live-a")
        await gw.aclose()
        return cat, a, b, again
    cat, a, b, again = run(go())
    assert cat.source == "live" and a.parsed == "t1" and b.parsed == "pass" and a.role == "specialist" and b.role == "reviewer"
    assert again.source == "frozen" and gw.spend_usd < 0.01 and a.cost_usd and a.cost_usd < 0.001
    assert all(r.error is None for r in gw.mem.rows) and len(JsonlSink(tmp_path / "rows.jsonl").load()) == 3
