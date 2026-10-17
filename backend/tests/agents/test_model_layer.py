"""Intelligence layer: Crusoe client/probe/status, structured-output validation, frozen decisions, caches, budgets."""
import asyncio
import json
import types

import pytest

from agent_fakes import FakeModelClient
from loopkeeper.intelligence.crusoe import (CrusoeClient, IntelligenceConfig, ModelError, ModelResponse, ModelStatus, extract_json, probe_model)
from loopkeeper.intelligence.decisions import DecisionRequest, DecisionService, MemoryDecisionStore
from loopkeeper.orchestration.context import redact


def test_extract_json_handles_fences_think_and_prose():
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert extract_json('<think>secret chain of thought { not json }</think>{"ok": true}') == {"ok": True}
    assert extract_json('Sure! Here you go: {"a": {"b": [1, 2]}} thanks') == {"a": {"b": [1, 2]}}
    with pytest.raises(ValueError):
        extract_json("no json here")


def test_base_url_must_be_https_or_local():
    IntelligenceConfig(api_key="k", base_url="https://api.inference.crusoecloud.com/v1").validate_base_url()
    IntelligenceConfig(api_key="k", base_url="http://localhost:9000/v1").validate_base_url()
    for bad in ("http://evil.example/v1", "ftp://x/v1", "https://user:pw@host/v1", "file:///etc/passwd"):
        with pytest.raises(ValueError):
            IntelligenceConfig(api_key="k", base_url=bad).validate_base_url()


def test_redact_secrets_and_sizes():
    out = redact({"api_key": "sk-123", "nested": {"Authorization": "Bearer x", "ok": 1}, "long": "x" * 5000, "list": list(range(100))})
    assert out["api_key"] == "[redacted]" and out["nested"]["Authorization"] == "[redacted]" and out["nested"]["ok"] == 1
    assert len(out["long"]) == 400 and len(out["list"]) == 40


@pytest.mark.asyncio
async def test_probe_without_key_is_fallback_never_live():
    st, client = await probe_model(IntelligenceConfig(api_key=""))
    assert client is None and st.status == "fallback" and st.provider == "deterministic"
    assert st.to_dict()["fallback_active"] is True and "CRUSOE_API_KEY" in st.to_dict()["reason"]


@pytest.mark.asyncio
async def test_probe_live_unavailable_and_missing_model():
    st, _ = await probe_model(IntelligenceConfig(api_key="k", model_name="fake-model"), FakeModelClient("fake-model"))
    assert st.status == "live" and st.model_id == "fake-model" and st.to_dict()["last_latency_ms"] is not None
    bad = FakeModelClient("fake-model", fail=ModelError("down", 503))
    bad.fail_probe = True
    st2, _ = await probe_model(IntelligenceConfig(api_key="k", model_name="fake-model"), bad)
    assert st2.status == "unavailable"
    other = FakeModelClient("fake-model")
    other.model_id = "not-entitled"
    other.list_models = lambda: asyncio.sleep(0, result=["something-else"])
    st3, _ = await probe_model(IntelligenceConfig(api_key="k", model_name="not-entitled"), other)
    assert st3.status == "unavailable" and "catalog" in st3.reason


@pytest.mark.asyncio
async def test_crusoe_client_openai_compatible_calls_and_error_hygiene():
    calls = []

    class Completions:
        async def create(self, **kw):
            calls.append(kw)
            if "response_format" in kw:
                raise types.SimpleNamespace  # not an exception -> TypeError path
            msg = types.SimpleNamespace(content='{"ok": true}')
            return types.SimpleNamespace(choices=[types.SimpleNamespace(message=msg)], usage=types.SimpleNamespace(prompt_tokens=11, completion_tokens=5), model="m1")

    class E400(Exception):
        status_code = 400

    class Completions400(Completions):
        async def create(self, **kw):
            if "response_format" in kw:
                calls.append(kw)
                raise E400("json mode unsupported")
            return await super().create(**{k: v for k, v in kw.items() if k != "response_format"})

    fake = types.SimpleNamespace(chat=types.SimpleNamespace(completions=Completions400()), models=types.SimpleNamespace(list=None), close=lambda: asyncio.sleep(0))
    c = CrusoeClient(IntelligenceConfig(api_key="sk-SECRET", model_name="m1"), client=fake)
    r = await c.complete_json(system="s", user="u", schema_name="t")
    assert r.tokens_in == 11 and r.tokens_out == 5 and extract_json(r.text) == {"ok": True}
    assert any("response_format" in k for k in calls) and "response_format" not in calls[-1]       # retried once without json mode

    class Boom:
        class chat:
            class completions:
                @staticmethod
                async def create(**kw):
                    raise RuntimeError("secret url https://x?key=sk-SECRET")

    c2 = CrusoeClient(IntelligenceConfig(api_key="sk-SECRET", model_name="m1"), client=Boom)
    with pytest.raises(ModelError) as ei:
        await c2.complete_json(system="s", user="u", schema_name="t")
    assert "SECRET" not in str(ei.value) and "secret" not in str(ei.value).lower()


def test_status_circuit_breaker_and_recovery():
    st = ModelStatus("crusoe", "m", "live")
    for _ in range(3):
        st.record_failure("boom")
    assert st.status == "unavailable" and not st.allow_call()
    st._opened_at -= 31                        # cooldown elapsed -> one trial call allowed
    assert st.allow_call()
    st.record_success(ModelResponse("{}", 1, 1, 7))
    assert st.status == "live" and st.to_dict()["last_latency_ms"] == 7


def svc(client, **kw):
    return DecisionService(client, ModelStatus("mock", "fake-model", "live"), MemoryDecisionStore(), run_id="r", **kw)


def req(kind="verify", key="k1", validate=None, **kw):
    return DecisionRequest(kind=kind, key=key, payload={"x": 1}, fallback=lambda: {"summary": "deterministic text"}, validate=validate, incident_id="INC-001", **kw)


@pytest.mark.asyncio
async def test_invalid_output_is_rejected_then_fallback_is_labelled():
    cl = FakeModelClient(scripts={"verify": ["not json at all", {"nope": 1}, '{"summary": 5}']})
    res = await svc(cl).decide(req())
    assert res.source == "fallback" and res.meta["fallback"] is True and res.meta["provider"] == "deterministic"
    assert res.decision["summary"] == "deterministic text" and len(res.rejected) == 2 and res.consulted
    assert len(cl.calls) == 2                     # 1 try + 1 bounded repair (spec: at most one JSON/validator repair)


@pytest.mark.asyncio
async def test_policy_rejected_output_triggers_retry_then_accepts_valid():
    cl = FakeModelClient(scripts={"verify": [{"summary": "FORBIDDEN"}, {"summary": "fine"}]})
    res = await svc(cl).decide(req(validate=lambda d: ["contains forbidden"] if "FORBIDDEN" in d.summary else []))
    assert res.source == "model" and res.decision["summary"] == "fine" and res.meta["fallback"] is False and res.meta["provider"] == "mock"
    assert res.rejected == ["contains forbidden"]


@pytest.mark.asyncio
async def test_frozen_decisions_never_recall_the_model_and_replay_never_calls():
    cl = FakeModelClient(scripts={"verify": [{"summary": "first"}]})
    s = svc(cl)
    a = await s.decide(req())
    b = await s.decide(req())                      # same key: restart/replay path
    assert a.decision == b.decision and b.source == "frozen" and len(cl.calls) == 1
    replay = DecisionService(cl, ModelStatus("mock", "fake-model", "live"), s.store, run_id="r", replay=True)
    assert (await replay.decide(req())).source == "frozen"
    c = await replay.decide(req(key="never-seen"))
    assert c.source == "fallback" and c.reason == "replay" and len(cl.calls) == 1
    recs = await s.store.list()
    assert recs[0]["prompt_version"] == "verify.v1" and recs[0]["meta"]["schema_version"] == "verify.v1"


@pytest.mark.asyncio
async def test_token_budget_exhaustion_falls_back_and_cache_dedupes():
    cl = FakeModelClient(tokens=(400, 200))
    s = svc(cl, token_budget=500)
    a = await s.decide(req(key="a"))
    b = await s.decide(req(key="b"))               # budget (500) already spent by the first call (600 tokens)
    assert a.source == "model" and b.source == "fallback" and b.reason == "token_budget" and len(cl.calls) == 1
    s2 = svc(FakeModelClient(), token_budget=10**6)
    r1 = await s2.decide(req(key="c1", cacheable=True, world_version=5))
    r2 = await s2.decide(req(key="c2", cacheable=True, world_version=5))     # same input + same world revision
    r3 = await s2.decide(req(key="c3", cacheable=True, world_version=6))     # new revision -> asked again
    assert (r1.source, r2.source, r3.source) == ("model", "cache", "model") and s2.cache.hits == 1


@pytest.mark.asyncio
async def test_unavailable_model_is_skipped_quickly_and_flagged():
    cl = FakeModelClient(fail=ModelError("timeout", None))
    s = svc(cl)
    for i in range(5):
        res = await s.decide(req(key=f"k{i}"))
        assert res.source == "fallback" and res.meta["fallback"]
    assert s.status.status == "unavailable" and s.model_calls == 3        # breaker opened after 3 failures: no more calls
    assert s.status.to_dict()["fallback_active"] is True
