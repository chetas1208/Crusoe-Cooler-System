"""Live-API error elimination (Agent K): split-database FK on the telemetry plane, commit retry, request-thread races, WebSocket task hygiene,
HEAD / alias routes, comms query shapes, and model 503 recovery. All offline (embedded pgserver, httpx.MockTransport, fake engine)."""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import threading
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent / "agents"))

from loopkeeper.engine.eventlog import EventBus  # noqa: E402
from loopkeeper.storage.base import CommitBatch, StorageError  # noqa: E402
from support.fixtures import TOKEN  # noqa: E402

AUTH = {"Authorization": f"Bearer {TOKEN}"}
TOPO = json.loads((Path(__file__).parent / "fixtures" / "topology.json").read_text())


# ------------------------------------------------------------------ (1) FK violation on the telemetry database
def _ev(run_id: str, seq: int) -> dict:
    return {"seq": seq, "event_id": f"ev_{seq:06d}", "facility_id": "lab_01", "tick": seq, "sim_time_s": float(seq), "world_version": seq,
            "kind": "heartbeat", "entity_id": "lab_01", "actor_type": "system", "actor_id": None, "payload": {"n": seq}, "causal_parent_id": None,
            "command_id": None, "ts": "2026-10-17T00:00:00.000Z", "schema_version": 1, "event_hash": f"h{seq}"}


def _run_row(run_id: str, **kw) -> dict:
    return {"run_id": run_id, "facility_id": "lab_01", "config_version": "c1", "topology_hash": "th1", "seed": 1, "rng_stream": "main", "kind": "scenario",
            "phase": "running", "engine_version": "1.0", "schema_version": 1, "sim_speed": 1, "dt_s": 0.5, **kw}


def test_split_telemetry_db_scenario_run_never_hits_fk_violation(tmp_path):
    """Root cause of 'commit failed (ForeignKeyViolation): halting physics': a scenario run whose scenario_specs row existed only in the PRIMARY
    database. The best-effort mirror of simulation_runs into the telemetry database failed silently (its scenario_id FK) and the run's first
    world_events insert died on world_events.run_id -> simulation_runs. The mirror now copies facility / scenario spec / parent run first, and a
    commit that still meets the FK heals the mirror once and retries."""
    pgserver = pytest.importorskip("pgserver")
    import psycopg
    from loopkeeper.storage.postgres import PostgresStorage
    try:
        srv = pgserver.get_server(str(tmp_path / "pg"))
    except Exception as e:                                      # noqa: BLE001
        pytest.skip(f"embedded postgres unavailable: {type(e).__name__}")
    try:
        base = srv.get_uri()
        with psycopg.connect(base, autocommit=True) as c:
            c.execute("CREATE DATABASE telem")
        telem = base.replace("/postgres?", "/telem?") if "/postgres?" in base else base.rsplit("/", 1)[0] + "/telem"
        assert telem != base
        st = PostgresStorage(base, telemetry_url=telem)
        assert st.telemetry_pool is not st.pool
        st.migrate()
        st.register_facility("lab_01", "c1", "th1", TOPO)
        st.save_scenario({"scenario_id": "MD-02", "spec": {"x": 1}, "creator": "t"})            # primary ONLY: the telemetry DB has no such spec
        with st.telemetry_pool.connection() as c:
            assert c.execute("SELECT count(*) AS n FROM scenario_specs").fetchone()["n"] == 0

        st.create_run(_run_row("run_md02", scenario_id="MD-02"))
        with st.telemetry_pool.connection() as c:                                                # mirrored together with its scenario spec
            assert c.execute("SELECT count(*) AS n FROM simulation_runs WHERE run_id='run_md02'").fetchone()["n"] == 1
            assert c.execute("SELECT count(*) AS n FROM scenario_specs WHERE scenario_id='MD-02'").fetchone()["n"] == 1
        st.commit(CommitBatch(run_id="run_md02", facility_id="lab_01", events=[_ev("run_md02", 1)]))

        # a run row the mirror really missed (old rows, an outage while it was written): the commit heals it instead of failing
        with st.pool.connection() as c, c.transaction():
            c.execute("INSERT INTO simulation_runs (run_id, facility_id, config_version, topology_hash, topology_version, scenario_id, seed, rng_stream, "
                      "kind, phase, engine_version, schema_version, sim_speed, dt_s) VALUES ('run_missed','lab_01','c1','th1','c1#th1','MD-02',1,'main',"
                      "'scenario','running','1.0',1,1,0.5)")
        st.commit(CommitBatch(run_id="run_missed", facility_id="lab_01", events=[_ev("run_missed", 1), _ev("run_missed", 2)]))
        st.commit(CommitBatch(run_id="run_missed", facility_id="lab_01", events=[_ev("run_missed", 2), _ev("run_missed", 3)]))      # idempotent replay
        assert [e["seq"] for e in st.load_events("run_missed")] == [1, 2, 3]

        with st.pool.connection() as c, c.transaction():                                          # startup backfill mirrors every missing run
            c.execute("INSERT INTO simulation_runs (run_id, facility_id, config_version, topology_hash, topology_version, scenario_id, seed, rng_stream, "
                      "kind, phase, engine_version, schema_version, sim_speed, dt_s) VALUES ('run_missed2','lab_01','c1','th1','c1#th1','MD-02',1,'main',"
                      "'scenario','running','1.0',1,1,0.5)")
        assert st.backfill_telemetry_runs() == 1 and st.backfill_telemetry_runs() == 0
        st.commit(CommitBatch(run_id="run_missed2", facility_id="lab_01", events=[_ev("run_missed2", 1)]))

        with pytest.raises(StorageError) as ei:                                                  # a genuinely unknown run still fails, and says where
            st.commit(CommitBatch(run_id="run_nope", facility_id="lab_01", events=[_ev("run_nope", 1)]))
        assert "ForeignKeyViolation" in str(ei.value) and "world_events" in str(ei.value)
        st.close()
    finally:
        srv.cleanup()


# ------------------------------------------------------------------ (1b) transient commit failure retries before halting
class _Flaky:
    kind = "flaky"

    def __init__(self, fail_first: int, real=None) -> None:
        self.fail, self.calls, self._real = fail_first, 0, real

    def __getattr__(self, name):                         # everything but commit() is the real storage
        return getattr(self._real, name)

    def commit(self, batch) -> None:
        self.calls += 1
        if self.fail > 0:
            self.fail -= 1
            raise StorageError("commit failed (OperationalError)")


def _engine_with(storage):
    from live_harness import Stack  # noqa: PLC0415
    return Stack


def test_transient_commit_failure_is_retried_without_halting_physics(caplog, monkeypatch):
    from loopkeeper.engine import core
    from live_harness import Stack
    monkeypatch.setattr(core, "COMMIT_RETRY_BASE_S", 0.0)

    async def go():
        s = await Stack.create(seed=3, warmup_s=1)
        try:
            e = s.eng
            real = e.storage
            flaky = _Flaky(2, real)
            e.storage = flaky
            e.emit_internal("heartbeat", "lab_01", {"n": 1})
            assert await e.commit() is True and e.db_down is False and flaky.calls == 3          # 2 failures absorbed by the retry
            flaky.fail, flaky.calls = 99, 0
            e.emit_internal("heartbeat", "lab_01", {"n": 2})
            with caplog.at_level(logging.ERROR, logger="loopkeeper.engine"):
                assert await e.commit() is False and e.db_down is True and flaky.calls == core.COMMIT_ATTEMPTS
            assert sum("halting physics" in r.message for r in caplog.records) == 1
            flaky.calls = 0
            assert await e.commit() is False and flaky.calls == 1                                  # already down: one probe per loop, no retry stall
            flaky.fail = 0
            assert await e.commit() is True and e.db_down is False                                 # recovered on the next probe
            e.storage = real
        finally:
            await s.stop()
    asyncio.run(go())


# ------------------------------------------------------------------ (2) deque / dict iterated from request threads
def test_event_bus_since_survives_concurrent_publish():
    bus = EventBus(ring_size=2000)
    stop = threading.Event()
    errs: list[BaseException] = []

    def reader():
        try:
            while not stop.is_set():
                bus.since(0, 50)
                bus.last_published_seq
                bus.subscribe(5).close()
        except BaseException as e:                              # noqa: BLE001
            errs.append(e)

    ts = [threading.Thread(target=reader) for _ in range(4)]
    for t in ts:
        t.start()
    for i in range(1, 30000):
        bus.publish([{"seq": i, "kind": "x"}])
    stop.set()
    for t in ts:
        t.join()
    assert not errs, errs


def test_safe_read_route_retries_transient_iteration_race():
    from fastapi import APIRouter, FastAPI
    from fastapi.testclient import TestClient
    from loopkeeper.api.safe_reads import SafeReadRoute
    n = {"calls": 0}
    r = APIRouter(route_class=SafeReadRoute)

    @r.get("/racy")
    def racy(x: int = 1):
        n["calls"] += 1
        if n["calls"] < 3:
            raise RuntimeError("deque mutated during iteration")
        return {"x": x}

    @r.get("/real-bug")
    def bug():
        raise RuntimeError("something else")

    app = FastAPI()
    app.include_router(r)
    c = TestClient(app, raise_server_exceptions=False)
    assert c.get("/racy?x=7").json() == {"x": 7} and n["calls"] == 3
    assert c.get("/real-bug").status_code == 500                  # only the iteration race is retried


def test_projection_catch_up_is_thread_safe():
    from loopkeeper.api.projections import Projection

    class Eng:
        def __init__(self):
            self.evs = [{"seq": i, "type": "agent.task", "payload": {"task": {"id": f"t{i}", "incident_id": "I"}}} for i in range(1, 3001)]

        def events_since(self, seq, limit=1000):
            return [e for e in self.evs if e["seq"] > seq][:limit]

    p = Projection(Eng(), 500)
    errs = []

    def work():
        try:
            for _ in range(20):
                p.catch_up()
                p.trace("I")
        except BaseException as e:                              # noqa: BLE001
            errs.append(e)
    ts = [threading.Thread(target=work) for _ in range(6)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errs and len(p.tasks) == 3000 and len(p.task_order) == 3000       # no double-apply


# ------------------------------------------------------------------ (3)(4) WebSocket connect/disconnect hygiene
def test_ws_connect_disconnect_loop_leaves_no_unretrieved_task_exceptions(client, engine, caplog):
    import gc
    with caplog.at_level(logging.ERROR, logger="asyncio"):
        for i in range(30):
            with client.websocket_connect("/api/v1/stream", headers=AUTH) as ws:
                assert ws.receive_json()["type"] == "snapshot"
                if i % 2:
                    for k in range(40):
                        engine.emit("heartbeat", "lab_01", {"n": k})
        gc.collect()
    assert [r.getMessage() for r in caplog.records if "never retrieved" in r.getMessage()] == []


@pytest.mark.asyncio
async def test_guard_swallows_closed_socket_errors_only():
    from starlette.websockets import WebSocketDisconnect
    from loopkeeper.api.stream import _guard

    async def disc():
        raise WebSocketDisconnect(1006)

    async def closed():
        raise RuntimeError('Cannot call "send" once a close message has been sent.')

    async def bug():
        raise RuntimeError("boom")
    await _guard(disc())
    await _guard(closed())
    with pytest.raises(RuntimeError):
        await _guard(bug())


# ------------------------------------------------------------------ (5) client shapes / methods
def test_head_health_root_and_openapi_aliases(anon):
    for path in ("/api/v1/health/live", "/api/v1/health", "/api/v1/health/ready"):
        assert anon.head(path).status_code in (200, 503), path
        assert anon.get(path).status_code in (200, 503)
    assert anon.head("/").status_code == 200
    for path in ("/openapi.json", "/api/openapi.json", "/api/v1/openapi.json"):
        r = anon.get(path)
        assert r.status_code == 200 and "paths" in r.json(), path


def test_comms_limit_500_and_replay_to_tick_alias(client, engine):
    # no storage on the fake engine: the handlers answer through their own storage guard, but validation (422) must pass
    for url in ("/api/v1/runs/run_live/communications?limit=500", "/api/v1/runs/run_live/replay/communications?to_tick=5&limit=500",
                "/api/v1/runs/run_live/replay/communications?cursor_tick=5"):
        assert client.get(url).status_code != 422, url
    assert client.get("/api/v1/runs/run_live/communications?limit=501").status_code == 422


# ------------------------------------------------------------------ (6) Crusoe 503 burst then 200
OK = {"model": "m", "choices": [{"message": {"content": '{"x": 1}'}}], "usage": {"prompt_tokens": 10, "completion_tokens": 3}}


def _gateway(script, **cfg):
    from loopkeeper.inference.config import GatewayConfig
    from loopkeeper.inference.gateway import ModelGateway
    steps = list(script)

    async def provider(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": []})
        return steps.pop(0) if steps else httpx.Response(200, json=OK)
    slept: list[float] = []

    async def sleep(s):
        slept.append(s)
    t = [0.0]
    gw = ModelGateway(GatewayConfig(api_key="sk-x", base_url="https://inference.example/v1", **cfg), run_id="run_k",
                      transport=httpx.MockTransport(provider), sleep=sleep, clock=lambda: t[0]) if "clock" in ModelGateway.__init__.__code__.co_varnames else \
        ModelGateway(GatewayConfig(api_key="sk-x", base_url="https://inference.example/v1", **cfg), run_id="run_k",
                     transport=httpx.MockTransport(provider), sleep=sleep)
    return gw, slept, t


def test_503_then_200_honours_retry_after_and_status_goes_degraded_then_live():
    from loopkeeper.intelligence.crusoe import ModelStatus
    from loopkeeper.intelligence.decisions import DecisionRequest, DecisionService
    from loopkeeper.intelligence.schemas import SCHEMAS
    kind = next(iter(SCHEMAS))
    gw, slept, _ = _gateway([httpx.Response(503, headers={"Retry-After": "2"}), httpx.Response(503, headers={"Retry-After": "1"})], retries=3)

    async def go():
        resp = await gw.complete_json(system="s", user="u", schema_name="classify")
        assert json.loads(resp.text) == {"x": 1} and slept == [2.0, 1.0]                  # 503 x2 (Retry-After honoured) then 200, one logical call
    asyncio.run(go())

    # exhausted retries -> the decision falls back and the UI-facing status is degraded; the next healthy call makes it live again
    gw2, _, _ = _gateway([httpx.Response(503)] * 4, retries=3, breaker_threshold=99)
    st = ModelStatus("crusoe", "m", "live")
    svc = DecisionService(gw2, st, run_id="run_k")
    from loopkeeper.inference.gateway import ModelGateway  # noqa: F401

    async def go2():
        from loopkeeper.intelligence.crusoe import ModelError
        with pytest.raises(ModelError) as ei:
            await gw2.complete_json(system="s", user="u", schema_name="classify")
        assert ei.value.status == 503
        st.record_failure(str(ei.value))
        assert st.status == "degraded" and st.to_dict()["fallback_active"] is False
        r = await gw2.complete_json(system="s", user="u", schema_name="classify")
        st.record_success(r)
        assert st.status == "live" and st.consecutive_failures == 0
    asyncio.run(go2())
    assert svc is not None and kind


def test_model_status_half_open_recovers_after_503_burst(monkeypatch):
    from loopkeeper.intelligence import crusoe
    from loopkeeper.intelligence.crusoe import ModelResponse, ModelStatus
    now = [1000.0]
    monkeypatch.setattr(crusoe.time, "monotonic", lambda: now[0])
    st = ModelStatus("crusoe", "m", "live")
    for _ in range(3):
        st.record_failure("InternalServerError status=503")
    assert st.status == "unavailable" and st.to_dict()["fallback_active"] and not st.allow_call()
    now[0] += 31
    assert st.allow_call() and not st.allow_call()                  # one trial after the cooldown, then closed again
    st.record_failure("503")                                        # trial fails -> another cooldown
    now[0] += 31
    assert st.allow_call()
    st.record_success(ModelResponse(text="{}", latency_ms=5))
    assert st.status == "live" and st.allow_call()


def test_gateway_breaker_never_stays_half_open_forever():
    from loopkeeper.inference.gateway import Breaker
    t = [0.0]
    b = Breaker(2, 30.0, lambda: t[0])
    b.failure(); b.failure()
    t[0] = 31.0
    assert b.allow() and not b.allow()          # probe handed out, but it is cancelled / dropped (never reports success or failure)
    t[0] = 62.0
    assert b.allow()                            # ... so after another cooldown a new probe is allowed
    b.success()
    assert b.state == "closed"


# ------------------------------------------------------------------ V12 review items owned by K
def test_live_stream_publishes_stream_only_events_not_just_the_persisted_subset():
    """The stall: commit() published only `batch.events` (heartbeat / world.diff / robot.pose thinned for storage), so the wire had permanent seq gaps,
    no heartbeats and a resync snapshot at every gap (probe: 45 s, 7 snapshots, max gap 13 s)."""
    from live_harness import Stack

    async def go():
        s = await Stack.create(seed=3, warmup_s=1)
        try:
            e = s.eng
            await e.commit()
            head = e.bus.last_published_seq
            e.tick  # noqa: B018
            a = e.emit_internal("heartbeat", "lab_01", {"n": 1})            # tick not a multiple of STREAM_PERSIST_EVERY_TICKS -> not persisted
            b = e.emit_internal("robot.mission_assigned", "OR-01", {"robot_id": "OR-01"})
            await e.commit()
            seqs = [x["seq"] for x in e.bus.since(head, 100)]
            assert a["seq"] in seqs and b["seq"] in seqs and seqs == sorted(seqs)
            assert seqs == list(range(seqs[0], seqs[-1] + 1))                # contiguous on the wire
        finally:
            await s.stop()
    asyncio.run(go())


def test_submit_ignores_a_principal_key_in_the_body_and_honours_the_argument():
    from live_harness import Stack

    async def go():
        s = await Stack.create(seed=3, warmup_s=1)
        try:
            e = s.eng
            ack = await e.submit({"command_id": "k-imp-1", "kind": "set_sim_speed", "args": {"speed": 1}, "principal": "mallory"})
            assert ack["accepted"] and e.commands.ledger["k-imp-1"]["issuer"] != "mallory"
            await e.submit({"command_id": "k-imp-2", "kind": "set_sim_speed", "args": {"speed": 1}, "principal": "mallory"}, principal="alice")
            assert e.commands.ledger["k-imp-2"]["issuer"] == "alice"
        finally:
            await s.stop()
    asyncio.run(go())


def test_commands_are_refused_while_storage_is_down_and_resend_cleanly_after(monkeypatch):
    from loopkeeper.engine import core
    from live_harness import Stack
    monkeypatch.setattr(core, "COMMIT_RETRY_BASE_S", 0.0)

    async def go():
        s = await Stack.create(seed=3, warmup_s=1)
        try:
            e = s.eng
            e.db_down = True
            ack = await e.submit({"command_id": "k-dur-1", "kind": "set_sim_speed", "args": {"speed": 2}}, principal="op")
            assert ack["accepted"] is False and ack["durable"] is False and "database_unavailable" in ack["reason"]
            assert "k-dur-1" not in e.commands.ledger                          # not recorded: the same id can be re-sent
            assert (await e.submit({"command_id": "k-dur-2", "kind": "pause"}, principal="op"))["accepted"]     # pause stays available
            e.db_down = False
            assert (await e.submit({"command_id": "k-dur-1", "kind": "set_sim_speed", "args": {"speed": 2}}, principal="op"))["accepted"]
            # applied but the commit fails: accepted, flagged non-durable
            real = e.storage
            e.storage = _Flaky(99, real)
            ack = await e.submit({"command_id": "k-dur-3", "kind": "set_sim_speed", "args": {"speed": 1}}, principal="op")
            assert ack["accepted"] and ack["durable"] is False
            e.storage = real
        finally:
            await s.stop()
    asyncio.run(go())


def test_ws_catch_up_streams_page_by_page_and_degrades_to_snapshot_when_too_long(engine, monkeypatch):
    from fastapi.testclient import TestClient
    from loopkeeper.api import create_app
    from loopkeeper.api import stream as S
    from support.fake_engine import FakeRuntime
    from support.fixtures import make_settings
    for i in range(95):
        engine.emit("agent.tool", "T", {"i": i})
    head = engine.world()["last_seq"]
    app = create_app(engine, agent_runtime=FakeRuntime(), settings=make_settings(ws_catchup_page=10))
    with TestClient(app) as c, c.websocket_connect(f"/api/v1/stream?since_seq={head - 60}", headers=AUTH) as ws:
        got = [ws.receive_json() for _ in range(60)]
        assert [g["seq"] for g in got] == list(range(head - 59, head + 1)) and all(g["type"] != "snapshot" for g in got)
    monkeypatch.setattr(S, "MAX_CATCHUP_PAGES", 2)
    with TestClient(app) as c, c.websocket_connect(f"/api/v1/stream?since_seq={head - 60}", headers=AUTH) as ws:
        seen = []
        while True:
            m = ws.receive_json()
            seen.append(m)
            if m["type"] == "snapshot":
                break
        assert len(seen) == 21 and seen[-1]["seq"] >= head                 # 2 pages replayed, then a snapshot instead of 4 more pages


# ------------------------------------------------------------------ security audit follow-ups (S-06 / S-08 / S-10 / S-11 / S-13)
def test_s06_viewer_cannot_steer_the_clock_operator_can():
    from fastapi.testclient import TestClient
    from loopkeeper.api import create_app
    from support.fake_engine import FakeEngine, FakeRuntime
    from support.fixtures import VIEWER, make_settings
    app = create_app(FakeEngine(), agent_runtime=FakeRuntime(), settings=make_settings())
    with TestClient(app) as c:
        v = {"Authorization": f"Bearer {VIEWER}"}
        for p, body in (("/speed", {"speed": 3}), ("/pause", {}), ("/play", {})):
            assert c.post(f"/api/v1/runs/run_live{p}", headers=v, json=body).status_code == 403, p
        assert c.post("/api/v1/runs/run_live/speed", headers=AUTH, json={"speed": 9}).status_code == 422       # operator passes the role check, then input validation


def test_s08_mutating_routes_are_rate_limited_and_ws_is_capped_per_ip():
    from fastapi.testclient import TestClient
    from loopkeeper.api import create_app
    from support.fake_engine import FakeEngine, FakeRuntime
    from support.fixtures import make_settings
    app = create_app(FakeEngine(), agent_runtime=FakeRuntime(), settings=make_settings(mutate_rate_per_s=0.01, mutate_burst=3, ws_max_per_ip=2))
    with TestClient(app) as c:
        codes = [c.post("/api/v1/intelligence/laya/classify", headers=AUTH, json={"x": 1}).status_code for _ in range(8)]
        assert 429 in codes and codes.index(429) <= 3
        r = c.post("/api/v1/runs/run_live/exports", headers=AUTH)
        assert r.status_code == 429 and r.headers.get("retry-after")                          # same bucket: one budget for the expensive routes
        assert c.get("/api/v1/world", headers=AUTH).status_code == 200                         # reads are not limited
        from starlette.websockets import WebSocketDisconnect
        with c.websocket_connect("/api/v1/stream", headers=AUTH) as a, c.websocket_connect("/api/v1/stream", headers=AUTH) as b:
            a.receive_json(); b.receive_json()
            with pytest.raises(WebSocketDisconnect):
                with c.websocket_connect("/api/v1/stream", headers=AUTH):
                    pass
        with c.websocket_connect("/api/v1/stream", headers=AUTH) as d:                           # slots are released on close
            assert d.receive_json()["type"] == "snapshot"


@pytest.mark.parametrize("url", ["https://169.254.169.254/v1", "https://169.254.169.254.nip.io/v1", "https://10.0.0.5/v1", "https://metadata.google.internal/v1",
                                 "https://[fd00::1]/v1", "https://2130706433/v1", "https://0x7f000001/v1", "https://169.254.169.254.example.com/v1"])
def test_s10_both_model_configs_reject_private_and_metadata_hosts(url):
    from loopkeeper.inference.config import GatewayConfig
    from loopkeeper.intelligence.crusoe import IntelligenceConfig
    with pytest.raises(ValueError):
        IntelligenceConfig(api_key="k", base_url=url).validate_base_url()
    with pytest.raises(ValueError):
        GatewayConfig(base_url=url).validate_base_url()


def test_s10_real_and_local_endpoints_still_accepted():
    from loopkeeper.inference.config import GatewayConfig
    from loopkeeper.intelligence.crusoe import IntelligenceConfig
    for u in ("https://api.inference.crusoecloud.com/v1", "http://localhost:9000/v1", "http://127.0.0.1:9/v1"):
        IntelligenceConfig(api_key="k", base_url=u).validate_base_url()
        GatewayConfig(base_url=u).validate_base_url()


def test_s11_scrub_masks_neon_and_short_csk_keys():
    from loopkeeper.api.scrub import scrub
    fake_neon = "npg_" + "AbCdEf123456xyz"
    fake_csk = "csk-" + "abcdefgh"
    out = scrub({"a": f"password is {fake_neon}", "b": f"key {fake_csk} here", "c": "plain text", "d": "csk-ab"})
    assert "npg_" not in out["a"] and fake_csk not in out["b"] and out["c"] == "plain text" and out["d"] == "csk-ab"


def test_s13_spa_responses_carry_a_csp_that_allows_the_api_and_websocket(anon):
    r = anon.get("/")
    csp = r.headers.get("content-security-policy", "")
    assert "default-src 'self'" in csp and "frame-ancestors 'none'" in csp and "connect-src 'self' https: wss:" in csp and "object-src 'none'" in csp
    assert anon.get("/api/v1/health/live").headers["content-security-policy"].startswith("default-src 'none'")      # the API itself stays locked down
