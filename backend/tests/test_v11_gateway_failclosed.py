"""V12 review item 5 (inference): spend ceilings FAIL CLOSED (unknown price, missing usage, max_tokens reserved before the call), restart finds frozen outputs in
the durable sink (a failing lookup raises, never pays twice), audit rows are bounded / never silently dropped. No network."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from loopkeeper.inference.calls import Fanout, JsonlSink, MemorySink, ModelCallRow
from loopkeeper.inference.config import GatewayConfig
from loopkeeper.inference.default import ThreadedSink
from loopkeeper.inference.gateway import GatewayError, ModelGateway


def run(c):
    return asyncio.run(c)


def row(i, key=None, text="x", source="network", error=None):
    return ModelCallRow(call_id=f"c{i}", provider="p", model="m", role="specialist", kind="k", schema_version="v", run_id="run_t", ts="t", idempotency_key=key, output_text=text, error=error, source=source)


def gw_for(handler, *, models=None, sink=None, **cfg):
    c = GatewayConfig(api_key="k", base_url="https://i.example/v1", **cfg)
    gw = ModelGateway(c, run_id="run_t", sink=sink, transport=httpx.MockTransport(handler), sleep=lambda s: asyncio.sleep(0))
    return gw


def ok_handler(usage=None, text='{"ok": true}', models=None):
    reqs = []

    async def h(request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": models if models is not None else []})
        reqs.append(request)
        body = {"model": "m", "choices": [{"message": {"content": text}}]}
        if usage is not None:
            body["usage"] = usage
        return httpx.Response(200, json=body)
    h.reqs = reqs
    return h


KNOWN = [{"id": "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", "type": "chat", "supported_parameters": ["seed"], "pricing": {"prompt": "0.05", "completion": "0.2"}}]


def test_unknown_price_is_charged_worst_case_and_the_ceiling_trips():
    h = ok_handler(usage={"prompt_tokens": 1000, "completion_tokens": 100})              # no catalog at all -> no price for the model
    gw = gw_for(h, run_spend_ceiling_usd=0.01)
    r = run(gw.complete(system="s", user="u", kind="classify", max_tokens=100))
    assert r.cost_usd == pytest.approx((1000 * 5.0 + 100 * 25.0) / 1e6) and r.cost_usd > 0     # never 0
    row_ = gw.mem.rows[-1]
    assert row_.price_basis == "assumed_worst_case" and row_.est_cost_usd == r.cost_usd
    with pytest.raises(GatewayError) as ei:
        run(gw.complete(system="s", user="u", kind="classify", max_tokens=100))             # 0.0075 spent + reservation -> over 0.01
    assert ei.value.code == "spend_ceiling" and len(h.reqs) == 1


def test_missing_usage_is_charged_from_max_tokens_not_free():
    h = ok_handler(usage=None, models=KNOWN)
    gw = gw_for(h)
    run(gw.start())
    r = run(gw.complete(system="s" * 300, user="u" * 300, kind="classify", max_tokens=500))
    est_in = 600 // 3 + 16
    assert (r.tokens_in, r.tokens_out) == (est_in, 500)
    assert r.cost_usd == pytest.approx((est_in * 0.05 + 500 * 0.2) / 1e6) and gw.spend_usd == r.cost_usd > 0
    assert "usage_missing" in gw.mem.rows[-1].price_basis and gw.stats["usage_missing"] == 1


def test_partial_usage_fills_only_the_missing_side():
    h = ok_handler(usage={"prompt_tokens": 40}, models=KNOWN)
    gw = gw_for(h)
    run(gw.start())
    r = run(gw.complete(system="s", user="u", kind="classify", max_tokens=300))
    assert (r.tokens_in, r.tokens_out) == (40, 300)


def test_max_tokens_is_reserved_before_the_call_so_inflight_calls_cannot_overshoot():
    gate = asyncio.Event()
    reqs = []

    async def h(request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": KNOWN})
        reqs.append(1)
        await gate.wait()
        return httpx.Response(200, json={"model": "m", "choices": [{"message": {"content": "{}"}}], "usage": {"prompt_tokens": 10, "completion_tokens": 10}})
    gw = gw_for(h, run_spend_ceiling_usd=0.0015, max_concurrency_low=4)
    run(gw.start())

    async def go():
        t = [asyncio.create_task(gw.complete(system="s", user="u", kind="classify", max_tokens=4000)) for _ in range(3)]   # each reserves 4000 x $0.2/M = $0.0008
        await asyncio.sleep(0.05)
        assert gw.reserved_usd == pytest.approx(0.0008, rel=0.05)                      # one admitted (0.0008); a second would need 0.0016 > 0.0015
        gate.set()
        return await asyncio.gather(*t, return_exceptions=True)
    res = run(go())
    assert sum(isinstance(x, GatewayError) and x.code == "spend_ceiling" for x in res) == 2 and len(reqs) == 1
    assert gw.reserved_usd == 0.0                                                  # released afterwards; only the actual cost was spent


def test_reservation_is_released_when_the_call_fails():
    async def h(request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": KNOWN})
        return httpx.Response(401)
    gw = gw_for(h)
    run(gw.start())
    with pytest.raises(GatewayError):
        run(gw.complete(system="s", user="u", kind="classify", max_tokens=700, incident_id="INC-1"))
    assert gw.reserved_usd == 0.0 and gw.incident_reserved.get("INC-1", 0.0) == 0.0 and gw.spend_usd == 0.0


def test_thinking_floor_is_reserved_at_2048():
    h = ok_handler(usage={"prompt_tokens": 1, "completion_tokens": 1}, models=KNOWN)
    gw = gw_for(h, thinking=True)
    run(gw.start())
    assert gw._effective_max_tokens("specialist", 100, None) == 2048 and gw.worst_case_cost("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", 0, 2048) == pytest.approx(2048 * 0.2 / 1e6)


# ---------------------------------------------------------------- frozen lookup / restart
def test_threaded_sink_frozen_delegates_and_restart_does_not_recall_the_model(tmp_path):
    p = tmp_path / "calls.jsonl"
    h1 = ok_handler(usage={"prompt_tokens": 5, "completion_tokens": 5}, text='{"a": 1}')
    gw1 = gw_for(h1, sink=JsonlSink(p))
    run(gw1.complete(system="s", user="u", kind="classify", idem_key="K1"))
    assert len(h1.reqs) == 1
    h2 = ok_handler()
    gw2 = gw_for(h2, sink=Fanout([ThreadedSink(JsonlSink(p), spill_path=tmp_path / "sp.jsonl")]))       # new process: empty memory, durable sink only (nested fanout)
    r = run(gw2.complete(system="s", user="u", kind="classify", idem_key="K1"))
    assert r.source == "frozen" and r.text == '{"a": 1}' and h2.reqs == []


def test_frozen_lookup_failure_raises_instead_of_paying_a_duplicate():
    class Broken:
        def record(self, row): pass
        def frozen(self, run_id, key): raise RuntimeError("db down")
    h = ok_handler(usage={"prompt_tokens": 5, "completion_tokens": 5})
    gw = gw_for(h, sink=Broken())
    with pytest.raises(GatewayError) as ei:
        run(gw.complete(system="s", user="u", kind="classify", idem_key="K"))
    assert ei.value.code == "frozen_lookup_failed" and h.reqs == [] and gw.stats["frozen_lookup_failures"] == 1
    run(gw.complete(system="s", user="u", kind="classify"))                          # no idempotency key -> nothing to look up, still works


# ---------------------------------------------------------------- audit rows
def test_memory_sink_is_bounded_with_o1_frozen_index():
    m = MemorySink(max_rows=5, max_frozen=3)
    for i in range(10):
        m.record(row(i, key=f"k{i}"))
    assert len(m.rows) == 5 and m.rows[0].call_id == "c5" and m.evicted_rows == 5
    assert m.frozen("k9").call_id == "c9" and m.frozen("k0") is None and m.evicted_frozen == 7 and len(m._frozen) == 3
    m.record(row(11, key="bad", error="http_500"))
    m.record(row(12, key="fz", source="frozen"))
    assert m.frozen("bad") is None and m.frozen("fz") is None                        # only successful network rows freeze


def test_gateway_status_surfaces_audit_health(tmp_path):
    gw = gw_for(ok_handler(usage={"prompt_tokens": 1, "completion_tokens": 1}), sink=ThreadedSink(JsonlSink(tmp_path / "a.jsonl"), spill_path=tmp_path / "s.jsonl"))
    run(gw.complete(system="s", user="u", kind="classify"))
    run(gw.aclose())
    a = gw.status()["audit"]
    assert a["MemorySink"]["rows"] == 1 and a["ThreadedSink"]["written"] == 1 and a["ThreadedSink"]["lost"] == 0
    json.dumps(gw.status())


# ---------------------------------------------------------------- ops: one structured log line per call, last_error_class
def test_one_structured_log_line_per_call_without_prompt_or_secrets(caplog):
    import logging
    h = ok_handler(usage={"prompt_tokens": 7, "completion_tokens": 3}, models=KNOWN)
    gw = gw_for(h)
    with caplog.at_level(logging.INFO, logger="loopkeeper.model_calls"):
        run(gw.start())
        run(gw.complete(system="TOPSECRET-PROMPT", user="USER-TEXT", kind="classify", incident_id="INC-1", task_id="T-1"))
    lines = [r.getMessage() for r in caplog.records if r.name == "loopkeeper.model_calls"]
    assert len(lines) == 1
    ln = lines[0]
    for want in ("provider=crusoe", "kind=classify", "status=ok", "tokens_in=7", "tokens_out=3", "est_cost_usd=", "latency_ms=", "incident_id=INC-1"):
        assert want in ln
    assert "TOPSECRET" not in ln and "USER-TEXT" not in ln and '{"ok"' not in ln and "k" != ln


def test_last_error_class_and_breaker_state_are_exposed_for_health_detail():
    async def h(request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": KNOWN})
        return httpx.Response(503)
    gw = gw_for(h, retries=0, breaker_threshold=2)
    run(gw.start())
    assert gw.last_error_class is None and gw.status()["last_error_class"] is None
    for _ in range(2):
        with pytest.raises(GatewayError):
            run(gw.complete(system="s", user="u", kind="classify"))
    assert gw.last_error_class == "http_503" and gw.status()["last_error_class"] == "http_503"
    assert "open" in gw.status()["breakers"].values()
