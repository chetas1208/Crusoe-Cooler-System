"""V11 gateway as the DEFAULT DecisionService client (flag INFERENCE_GATEWAY, default ON). No network: httpx.MockTransport. Frozen-decision replay kept."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "agents"))

from loopkeeper.engine import create_engine  # noqa: E402
from loopkeeper.inference import default as D
from loopkeeper.inference.calls import JsonlSink, PgSink
from loopkeeper.inference.gateway import ModelGateway
from loopkeeper.intelligence.crusoe import CrusoeClient, IntelligenceConfig
from loopkeeper.intelligence.decisions import DecisionRequest, DecisionService, MemoryDecisionStore
from loopkeeper.orchestration import AgentRuntimeImpl, Limits
from loopkeeper.physics import FacilityPlant
from loopkeeper.physics.config import load_config
from loopkeeper.storage.memory import MemoryStorage

MODELS = {"data": [{"id": "m-spec", "type": "chat", "context_length": 8000, "supported_parameters": ["seed", "response_format", "chat_template_kwargs"], "pricing": {"prompt": "0.05", "completion": "0.2"}},
                   {"id": "m-deep", "type": "chat", "context_length": 8000, "supported_parameters": ["seed", "response_format", "chat_template_kwargs"], "pricing": {"prompt": "0.3", "completion": "2.4"}}]}
CLASSIFY = {"mechanism": "unknown", "summary": "gateway test"}


class Provider:
    def __init__(self) -> None:
        self.chat: list[httpx.Request] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json=MODELS)
        self.chat.append(request)
        body = json.loads(request.content)
        text = '{"ok": true}' if "ping" in body["messages"][1]["content"] else json.dumps(CLASSIFY)
        return httpx.Response(200, json={"model": body["model"], "choices": [{"message": {"content": text}}], "usage": {"prompt_tokens": 1000, "completion_tokens": 100}})


@pytest.fixture
def mock_gateway(monkeypatch):
    prov = Provider()
    made: list[ModelGateway] = []

    class G(ModelGateway):
        def __init__(self, *a, **kw):
            super().__init__(*a, transport=httpx.MockTransport(prov), **kw)
            made.append(self)

    monkeypatch.setattr(D, "ModelGateway", G)
    return prov, made


async def _start(cfg: IntelligenceConfig, **kw):
    plant = FacilityPlant(seed=3, config=load_config(overrides={"physics": {"faults": {"enabled": False}}}))
    eng = create_engine(plant=plant, run_id="run_gw", seed=3, storage=MemoryStorage())
    rt = AgentRuntimeImpl(intelligence=cfg, database_url="", limits=Limits(), **kw)
    await rt.start(eng.as_actor("agent", "agent"))
    return eng, rt


def test_flag_default_on_and_off_values():
    assert D.gateway_enabled({}) is True
    for v in ("0", "false", "off", "No"):
        assert D.gateway_enabled({"INFERENCE_GATEWAY": v}) is False
    assert D.gateway_enabled({"INFERENCE_GATEWAY": "1"}) is True


async def test_runtime_uses_gateway_by_default_when_a_key_is_configured(mock_gateway, monkeypatch):
    monkeypatch.delenv("INFERENCE_GATEWAY", raising=False)
    prov, made = mock_gateway
    _, rt = await _start(IntelligenceConfig(api_key="sk-test", base_url="https://inference.example/v1", model_name="m-spec", model_deep="m-deep"))
    try:
        assert rt.gateway is made[0] and rt.client is rt.gateway
        assert rt.status.status == "live" and rt.status.provider == "crusoe"
        assert any("ping" in json.loads(r.content)["messages"][1]["content"] for r in prov.chat)       # the startup probe went through the gateway
        row = rt.gateway.mem.rows[-1]
        assert row.kind == "probe" and row.est_cost_usd and row.error is None and "sk-test" not in json.dumps(row.public())
        assert rt.gateway.cfg.models == {"reasoner": "m-deep", "specialist": "m-spec", "reviewer": "m-deep"}
    finally:
        await rt.stop()


async def test_flag_off_restores_the_legacy_client(monkeypatch):
    monkeypatch.setenv("INFERENCE_GATEWAY", "0")
    _, rt = await _start(IntelligenceConfig(api_key="sk-test", base_url="http://localhost:9/v1", model_name="m-spec"))
    try:
        assert rt.gateway is None and isinstance(rt.client, CrusoeClient)
    finally:
        await rt.stop()


async def test_no_key_and_injected_client_paths_are_untouched(mock_gateway):
    _, made = mock_gateway
    _, rt = await _start(IntelligenceConfig(api_key=""))
    assert rt.gateway is None and rt.client is None and rt.status.status == "fallback"
    await rt.stop()
    from agent_fakes import FakeModelClient
    fake = FakeModelClient("fake-model")
    _, rt2 = await _start(IntelligenceConfig(api_key="k", model_name="fake-model"), model_client=fake)
    try:
        assert rt2.gateway is None and rt2.client is fake and not made
    finally:
        await rt2.stop()


async def test_decision_service_through_gateway_keeps_frozen_replay_semantics(mock_gateway):
    prov, _ = mock_gateway
    gw = await D.build_default_gateway(IntelligenceConfig(api_key="k", base_url="https://inference.example/v1", model_name="m-spec"), "run_a")
    from loopkeeper.intelligence.crusoe import ModelStatus
    st = ModelStatus("crusoe", gw.model_id, "live", "")
    store = MemoryDecisionStore()
    mk = lambda **kw: DecisionRequest(kind="classify", key="k1", payload={"x": 1}, fallback=lambda: dict(CLASSIFY), incident_id="INC-1", task_id="t1", **kw)
    svc = DecisionService(gw, st, store, run_id="run_a")
    r1 = await svc.decide(mk())
    assert r1.source == "model" and len(prov.chat) == 1
    r2 = await svc.decide(mk())                                                    # same service: frozen decision, no call
    assert r2.source == "frozen" and len(prov.chat) == 1
    svc2 = DecisionService(gw, st, MemoryDecisionStore(), run_id="run_a")          # fresh decision store (restart w/o it): the gateway's frozen output answers, still no HTTP
    r3 = await svc2.decide(mk())
    assert r3.decision == r1.decision and len(prov.chat) == 1
    assert any(x.source == "frozen" and x.idempotency_key == "run_a:k1" for x in gw.mem.rows)
    rep = ModelGateway(gw.cfg, run_id="run_a", replay=True, transport=httpx.MockTransport(prov))   # replay: fed the frozen rows, can never call out
    for r in gw.mem.rows:
        rep.mem.record(r)
    svc3 = DecisionService(rep, st, MemoryDecisionStore(), run_id="run_a", replay=False)
    r4 = await svc3.decide(mk())
    assert r4.decision == r1.decision and len(prov.chat) == 1
    # an unseen decision in replay mode: labelled deterministic fallback, still no HTTP
    r5 = await svc3.decide(DecisionRequest(kind="classify", key="never-seen", payload={}, fallback=lambda: dict(CLASSIFY), incident_id="INC-1"))
    assert r5.fallback and r5.source == "fallback" and len(prov.chat) == 1
    await gw.aclose()


async def test_model_calls_rows_carry_incident_and_task_ids(mock_gateway):
    gw = await D.build_default_gateway(IntelligenceConfig(api_key="k", base_url="https://inference.example/v1", model_name="m-spec"), "run_b")
    svc = DecisionService(gw, __import__("loopkeeper.intelligence.crusoe", fromlist=["ModelStatus"]).ModelStatus("crusoe", "m", "live", ""), run_id="run_b")
    await svc.decide(DecisionRequest(kind="classify", key="c1", payload={}, fallback=lambda: dict(CLASSIFY), incident_id="INC-7", task_id="T-9"))
    row = [r for r in gw.mem.rows if r.kind == "classify"][0]
    assert (row.incident_id, row.task_id, row.run_id, row.role) == ("INC-7", "T-9", "run_b", "specialist")
    assert gw.incident_spend["INC-7"] > 0
    await gw.aclose()


async def test_jsonl_sink_env_and_retry_through_default_gateway(tmp_path, mock_gateway, monkeypatch):
    monkeypatch.setenv("INFERENCE_CALLS_JSONL", str(tmp_path))
    gw = await D.build_default_gateway(IntelligenceConfig(api_key="k", base_url="https://inference.example/v1", model_name="m-spec"), "run_c")
    await gw.complete(system="s", user="u", kind="classify", idem_key="x")
    await gw.aclose()
    rows = JsonlSink(tmp_path / "run_c.jsonl").load()
    assert len(rows) == 1 and rows[0].run_id == "run_c" and rows[0].output_text


def test_threaded_sink_never_blocks_never_drops_silently(tmp_path):
    from loopkeeper.inference.calls import ModelCallRow
    mk_row = lambda i: ModelCallRow(call_id=f"c{i}", provider="p", model="m", role="r", kind="k", schema_version="v", run_id="r", ts="t")

    class Slow:
        def __init__(self): self.n = 0
        def record(self, row):
            time.sleep(0.05)
            if row.call_id == "c1":
                raise RuntimeError("db down")
            self.n += 1
    inner = Slow()
    ts = D.ThreadedSink(inner, maxsize=3, spill_path=tmp_path / "spill.jsonl")
    t0 = time.perf_counter()
    for i in range(7):
        ts.record(mk_row(i))                                   # returns immediately; overflow / failed writes are SPILLED, not lost
    assert time.perf_counter() - t0 < 0.5
    assert ts.flush(5)
    st = ts.stats()
    assert st["written"] + st["spilled"] == 7 and st["write_errors"] == 1 and st["lost"] == 0 and ts.dropped == 0
    spilled = [json.loads(x)["call_id"] for x in (tmp_path / "spill.jsonl").read_text().splitlines()]
    assert len(spilled) == st["spilled"] and "c1" in spilled and st["spilled"] >= 2
    ts.close()


@pytest.fixture(scope="module")
def pg_url(tmp_path_factory):
    import os
    url = os.environ.get("TEST_DATABASE_URL")
    if url:
        yield url
        return
    pgserver = pytest.importorskip("pgserver")
    try:
        srv = pgserver.get_server(str(tmp_path_factory.mktemp("gw_pg")))
    except Exception as e:                                          # noqa: BLE001
        pytest.skip(f"embedded postgres unavailable: {type(e).__name__}")
    yield srv.get_uri()
    srv.cleanup()


async def test_postgres_model_calls_rows_via_threaded_sink(pg_url, mock_gateway):
    from loopkeeper.storage.postgres import PostgresStorage
    st = PostgresStorage(pg_url)
    st.migrate()
    try:
        gw = await D.build_default_gateway(IntelligenceConfig(api_key="k", base_url="https://inference.example/v1", model_name="m-spec"), "run_pg", storage=st)
        await gw.complete(system="s", user="u", kind="classify", idem_key="pg1", task_id="T-1", incident_id="INC-1")
        await gw.aclose()
        with st.pool.connection() as c:
            rows = c.execute("SELECT run_id, kind, role, task_id, incident_id, est_cost_usd, output_text FROM model_calls WHERE run_id='run_pg'").fetchall()
        assert len(rows) == 1
        r = rows[0]
        r = r if isinstance(r, dict) else dict(zip(("run_id", "kind", "role", "task_id", "incident_id", "est_cost_usd", "output_text"), r))
        assert (r["kind"], r["role"], r["task_id"], r["incident_id"]) == ("classify", "specialist", "T-1", "INC-1") and r["est_cost_usd"] > 0 and r["output_text"]
    finally:
        st.close()
