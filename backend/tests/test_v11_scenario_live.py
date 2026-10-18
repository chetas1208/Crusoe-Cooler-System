"""V11 prompt -> LIVE run: Laya (advisory) -> Nemotron ScenarioSpec (fake model; one real Crusoe call, capped) -> deterministic compile/selector
resolution -> test.inject_fault through the engine command bus on the live run -> SENTINEL incident + frozen DOD -> request record links run/incident ids."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "agents"))

from live_harness import Stack  # noqa: E402
from loopkeeper.api import create_app  # noqa: E402
from loopkeeper.api import scenario_live as SL  # noqa: E402
from loopkeeper.api.scenario_live import Governor, LiveLimits  # noqa: E402
from loopkeeper.intelligence.scenario_interpreter import ScenarioProposalV1  # noqa: E402
from support.fixtures import TOKEN, make_settings  # noqa: E402

AUTH = {"Authorization": f"Bearer {TOKEN}"}
TERMINAL = ("resolved", "escalated", "dismissed")


class _Cfg:
    configured = True


class ScenarioModel:
    """Fake Nemotron: returns a fixed ScenarioProposalV1 JSON; records every call (replay/idempotency must not add calls)."""

    model_id = "fake-nemotron"
    provider = "mock"

    def __init__(self, faults: list[dict], hints: list[str] | None = None, clarify: bool = False, intent: str = "simulate") -> None:
        self.cfg = _Cfg()
        self.payload = {"intent": intent, "summary": "fake interpretation", "proposed_faults": faults, "location_hints": hints or [],
                        "assumptions": ["fake model assumption"], "unresolved_references": [], "needs_clarification": clarify, "candidate_goals": []}
        self.calls = 0

    async def complete_json(self, *, system, user, schema_name, max_tokens=700, timeout_s=None):
        from loopkeeper.intelligence.crusoe import ModelResponse
        self.calls += 1
        return ModelResponse(text=json.dumps(self.payload), tokens_in=100, tokens_out=50, latency_ms=3, model_id=self.model_id)

    async def aclose(self) -> None:
        pass


class Rig:
    def __init__(self, st: Stack, model, limits: LiveLimits | None = None) -> None:
        self.st, self.model = st, model
        self.app = create_app(st.eng, settings=make_settings())
        ctx = self.app.state.ctx
        ctx.scenario_model_client = model
        ctx.scenario_governor = Governor()
        ctx.scenario_limits = limits or LiveLimits(min_interval_s=0.0, link_wait_s=0.0)
        self.ctx = ctx
        self.phases: list[str] = []
        store = SL.scenario_store(st.eng)
        orig = store.update_scenario_request

        def spy(request_id, **f):
            if "phase" in f:
                self.phases.append(f["phase"])
            return orig(request_id, **f)
        store.update_scenario_request = spy
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://t", headers=AUTH)

    async def submit(self, prompt: str, key: str | None = None) -> str:
        r = await self.http.post("/api/v1/scenario-requests", json={"prompt": prompt}, headers={"Idempotency-Key": key} if key else {})
        assert r.status_code == 202, r.text
        return r.json()["request_id"]

    async def final(self, rid: str, timeout: float = 120.0) -> dict:
        t_end = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < t_end:
            r = (await self.http.get(f"/api/v1/scenario-requests/{rid}")).json()
            if r["status"] in ("READY", "REJECTED", "FAILED", "CANCELED"):
                return r
            await asyncio.sleep(0.05)
        raise AssertionError("request did not finish")

    def injected(self) -> int:
        return Governor.ledger_count(self.st.eng)


@pytest.fixture
def no_wait(monkeypatch):
    monkeypatch.setenv("SCENARIO_LIVE_MIN_INTERVAL_S", "0")


async def _stack(run_id: str, **kw) -> Stack:
    return await Stack.create(seed=3, run_id=run_id, **kw)


def _foul_b(sev="severe"):
    return [{"family": "flow_restriction", "severity": sev, "asset_query": "row B supply header", "cause_hint": "deposit"}]


@pytest.mark.asyncio
async def test_prompt_to_live_incident_dod_and_links(no_wait):
    st = await _stack("run_t_scn_flow")
    try:
        rig = Rig(st, ScenarioModel(_foul_b(), hints=["middle racks"]))
        rid = await rig.submit("Something is wrong with the water near the middle racks, maybe overheating. Handle it.")
        rec = await rig.final(rid)
        assert rec["status"] == "READY" and rec["phase"] == "RUNNING"
        # prompt-status chain reflects the real phases, in order
        assert rig.phases == ["CLASSIFYING", "INTERPRETING", "VALIDATING", "CREATING_RUN", "RUNNING"]
        live = rec["live"]
        assert rec["run_id"] == st.eng.run_id == live["run_id"]
        inj = live["injections"][0]
        assert inj["kind"] == "fouling" and inj["target"] == "p_hs_b" and inj["accepted"] and inj["command_id"] == f"scn-{rid}-0"
        assert live["params_sent"] and inj["params"] == {"omax": 0.7, "tau_s": 90.0}          # valid engine parameters, not just severity
        assert st.eng.plant.faults.occl.get("p_hs_b", 0) > 0                                    # the live plant really got the fault
        led = st.eng.commands.ledger[inj["command_id"]]
        assert led["kind"] == "test.inject_fault" and led["status"] == "accepted" and led["issuer"].startswith("scenario-launcher")
        assert rec["interpretation"]["crusoe"]["model"] == "fake-nemotron" and rec["interpretation"]["compiler"]["resolved_assets"] == ["p_hs_b"]
        assert rec["interpretation"]["laya"]["result"]["incident_family"]
        # SENTINEL opens the incident on the live run; record links it; DOD frozen; incident resolves; verified
        assert await st.run_until(lambda: any(i["status"] in TERMINAL for i in st.incidents()), 1800)
        rec2 = (await rig.http.get(f"/api/v1/scenario-requests/{rid}")).json()
        inc = st.incidents()[0]
        assert rec2["live"]["incident_ids"] == [inc["id"]]
        c = st.eng.track.contracts[inc["id"]]
        assert c["frozen_hash"] and c["state"] in ("VERIFIED", "FROZEN", "EVALUATING") and inc["status"] == "resolved"
        # idempotent worker re-entry: no second injection, no second model call
        n_cmd, n_model = rig.injected(), rig.model.calls
        again = await SL.LiveLauncher(st.eng, SL.scenario_store(st.eng), run_id=st.eng.run_id, model_client=rig.model).run(rid)
        assert again["skipped"] and rig.injected() == n_cmd and rig.model.calls == n_model == 1
        # polling the record (what replay / a reloaded UI does) never injects or calls a model
        for _ in range(3):
            await rig.http.get(f"/api/v1/scenario-requests/{rid}")
        assert rig.injected() == n_cmd and rig.model.calls == 1
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_invalid_selector_p17_is_rejected_with_reason_and_nothing_injected(no_wait):
    st = await _stack("run_t_scn_p17", warmup_s=2.0)
    try:
        rig = Rig(st, ScenarioModel([{"family": "flow_restriction", "severity": "severe", "asset_query": "p_17", "cause_hint": None}]))
        rec = await rig.final(await rig.submit("foul pipe p_17"))
        assert rec["status"] == "REJECTED" and rec["phase"] == "REJECTED" and rec["error_code"] == "INVALID_SELECTOR"
        assert "p_17" in rec["error_message"] and "not a faultable pipe" in rec["error_message"]
        assert rec["live"]["rejected"][0]["code"] == "INVALID_SELECTOR" and rig.injected() == 0 and not rec["live"]["injections"]
        assert not any(c.get("kind") == "test.inject_fault" for c in st.eng.commands.ledger.values())
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_hazard_families_map_to_real_kinds_and_bad_selectors_are_listed_honestly(no_wait):
    st = await _stack("run_t_scn_unsup", warmup_s=2.0)
    try:
        # V12: leak / fire_smoke are real hazards now (manifold_leak / rack_thermal_runaway), no longer "unsupported"
        rig = Rig(st, ScenarioModel([{"family": "leak", "severity": "minor", "asset_query": "Row B"},
                                     {"family": "fire_smoke", "severity": "minor", "asset_query": "rack_a1"}]))
        rec = await rig.final(await rig.submit("coolant leak in row B and smoke at rack a1"))
        assert rec["live"]["unsupported"] == []
        assert {(i["kind"], i["target"]) for i in rec["live"]["injections"]} == {("manifold_leak", "p_hs_b"), ("rack_thermal_runaway", "rack_a1")}
        # mixed request: a leak with a non-header selector is rejected with the reason, the supported pump fault is injected on the TCS duty pump (declared default)
        rig2 = Rig(st, ScenarioModel([{"family": "leak", "severity": "severe", "asset_query": "rack_a1"}, {"family": "pump_failure", "severity": "moderate"}]))
        rec2 = await rig2.final(await rig2.submit("leak and the pump is dying"))
        assert rec2["status"] == "READY" and [r["code"] for r in rec2["live"]["rejected"]] == ["INVALID_SELECTOR"]
        inj = rec2["live"]["injections"][0]
        assert inj["kind"] == "pump_degradation" and inj["target"] == "pump_t1" and inj["resolution"] == "default"
        assert any("defaulted" in a for a in rec2["interpretation"]["compiler"]["assumptions"])
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_only_the_supported_kinds_and_mapping_table():
    from loopkeeper.physics.faults import HAZARD_KINDS_A, SUPPORTED_KINDS as PHYS
    from loopkeeper.physics.hazards import HAZARD_KINDS
    assert set(SL.SUPPORTED_KINDS) == set(PHYS) | set(HAZARD_KINDS_A) | set(HAZARD_KINDS) and len(SL.SUPPORTED_KINDS) == 11
    assert all(len(t) <= SL.MAX_PARAMS for t in SL.PARAMS.values())
    assert set(SL.PARAMS) == set(SL.SUPPORTED_KINDS) and not set(SL.UNSUPPORTED_FAMILIES) & {"flow_restriction", "pump_failure", "overheating", "sensor_fault"}
    st = await _stack("run_t_scn_map", warmup_s=2.0)
    try:
        cat = SL.build_catalog(st.eng)
        assert "p_17" not in cat.foul and "p_hs_b" in cat.foul and cat.zone_headers["b"] == "p_hs_b"

        def plan(*faults, hints=()):
            p = ScenarioProposalV1.model_validate({"summary": "x", "proposed_faults": list(faults), "location_hints": list(hints)})
            return SL.plan_injections(p, {"incident_family": "unknown", "abstained": True}, cat)
        got = plan({"family": "flow_restriction", "asset_query": "str_02"}, {"family": "overheating", "asset_query": "rack_a1"},
                   {"family": "sensor_fault", "asset_query": "sn_flow_za"}, {"family": "pump_failure", "asset_query": "pump_tcs_stby"})
        assert [(i.kind, i.target) for i in got.injections][:3] == [("strainer_blockage", "strainer_02"), ("workload_spike", "rack_a1"), ("sensor_drift", "sn_flow_za")]
        assert plan({"family": "overheating", "asset_query": "rack_c04", "cause_hint": "valve stuck"}).injections[0].target == "p_hs_c"  # aux rack -> row header, declared
        assert plan({"family": "overheating", "asset_query": "rack_a1", "cause_hint": "starved by a stuck valve"}).injections[0].kind == "valve_stuck"
        assert plan({"family": "sensor_fault", "asset_query": "p_01"}).rejected[0]["code"] == "INVALID_SELECTOR"       # exists, wrong type
        assert plan({"family": "flow_restriction", "asset_query": "somewhere"}).rejected[0]["code"] == "INVALID_SELECTOR"
        assert [(i.kind, i.target) for i in plan({"family": "power_failure"}).injections] == [("power_failure", "feed_a")]
        assert [(i.kind, i.target) for i in plan({"family": "power_failure", "asset_query": "Row A"}).injections] == [("power_failure", "zone_a")]
        assert [(i.kind, i.target) for i in plan({"family": "heat_rejection_loss"}).injections] == [("facility_heat_rejection_loss", "chiller_01")]
        assert [(i.kind, i.target) for i in plan({"family": "leak", "asset_query": "Row A"}).injections] == [("manifold_leak", "p_hs_a")]
        assert plan({"family": "leak", "asset_query": "rack_a1"}).rejected[0]["code"] == "INVALID_SELECTOR"
        assert plan({"family": "fire_smoke", "asset_query": "rack_zz9"}).rejected[0]["code"] == "INVALID_SELECTOR"
        assert plan({"family": "pump_failure", "cause_hint": "the standby pump is also dead"}).injections[0].kind == "cdu_pump_backup_failure"
        capped = SL.plan_injections(ScenarioProposalV1.model_validate({"summary": "x", "proposed_faults": [
            {"family": "pump_failure", "asset_query": "pump_t1"}, {"family": "pump_failure", "asset_query": "pump_t2"},
            {"family": "sensor_fault", "asset_query": "sn_flow_za"}, {"family": "sensor_fault", "asset_query": "sn_flow_zb"}]}),
            {"abstained": True}, cat, max_per_request=3)
        assert len(capped.injections) == 3 and capped.rejected[0]["code"] == "REQUEST_CAP"
        # every generated parameter is accepted by the real physics (all kinds x all severities, real bus, fresh engine each)
        for kind, target, extra in (("fouling", "p_hs_a", {}), ("strainer_blockage", "strainer_01", {}), ("valve_stuck", "valve_a1", {}),
                                    ("pump_degradation", "pump_t1", {}), ("sensor_drift", "sn_flow_za", {}), ("workload_spike", "rack_b1", {}),
                                    ("manifold_leak", "p_hs_a", {}), ("power_failure", "zone_a", {"racks": 1.0, "pumps": 0.0}),
                                    ("power_failure", "feed_a", {"racks": 0.0, "pumps": 1.0}), ("rack_thermal_runaway", "rack_a1", {}),
                                    ("cdu_pump_backup_failure", "pump_t1", {}), ("facility_heat_rejection_loss", "chiller_01", {})):
            for sev in SL.SEV_ORDER:
                inj = SL.Injection(kind, target, sev, SL._params(kind, sev, **extra), "x", "exact")
                st2 = await _stack(f"run_t_scn_{kind}_{sev}", warmup_s=0.0)
                try:
                    ack = await st2.eng.submit({"command_id": "c1", "kind": "test.inject_fault", "args": inj.args(True)}, principal="t", actor_type="operator")
                    assert ack["accepted"], (kind, sev, ack)
                finally:
                    await st2.stop()
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_per_run_cap_and_launch_spacing():
    st = await _stack("run_t_scn_cap", warmup_s=2.0)
    try:
        rig = Rig(st, ScenarioModel(_foul_b()), LiveLimits(max_faults_per_run=1, min_interval_s=0.0, link_wait_s=0.0))
        first = await rig.final(await rig.submit("one"))
        assert first["status"] == "READY"
        second = await rig.final(await rig.submit("two"))
        assert second["status"] == "REJECTED" and second["error_code"] == "RATE_LIMITED" and "cap 1" in second["error_message"]
        assert rig.injected() == 1
        rig3 = Rig(st, ScenarioModel(_foul_b()), LiveLimits(max_faults_per_run=5, min_interval_s=3600.0, link_wait_s=0.0))
        rig3.ctx.scenario_governor.accepted.clear()
        rig3.ctx.scenario_governor.last_launch[st.eng.run_id] = __import__("time").monotonic()
        third = await rig3.final(await rig3.submit("three"))
        assert third["error_code"] == "RATE_LIMITED" and "apart" in third["error_message"]
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_replay_stored_run_and_disabled_faults_never_inject(no_wait):
    st = await _stack("run_t_scn_ro", warmup_s=2.0)
    try:
        m = ScenarioModel(_foul_b())
        # launcher pointed at a run that is not the engine's live run (stored run / fork): refused, no command submitted
        res = await SL.LiveLauncher(st.eng, SL.scenario_store(st.eng), run_id="run_some_stored", model_client=m,
                                    limits=LiveLimits(min_interval_s=0, link_wait_s=0), governor=Governor()).run(_mk(st, "stored"))
        assert res["error_code"] == "READ_ONLY_RUN" and Governor.ledger_count(st.eng) == 0
        # replay engines are not live-capable at all (the route falls back to the recorded worker, which never touches the live plant)
        class _C:  # noqa: N801
            engine = type("E", (), {"replay": True, "submit": staticmethod(lambda *a: None)})()
            settings = make_settings()
        assert SL.live_capable(_C) is False
        st.eng.cfg.allow_test_faults = False
        res = await SL.LiveLauncher(st.eng, SL.scenario_store(st.eng), run_id=st.eng.run_id, model_client=m,
                                    limits=LiveLimits(min_interval_s=0, link_wait_s=0), governor=Governor()).run(_mk(st, "nofault"))
        assert res["error_code"] == "TEST_FAULTS_DISABLED" and Governor.ledger_count(st.eng) == 0
    finally:
        await st.stop()


def _mk(st, key: str) -> str:
    rid = f"req_{key}"
    SL.scenario_store(st.eng).create_scenario_request(rid, "tester", "foul it", facility_id="lab_01")
    return rid


@pytest.mark.asyncio
async def test_duplicate_command_id_is_idempotent_on_the_bus(no_wait):
    st = await _stack("run_t_scn_dup", warmup_s=2.0)
    try:
        cmd = {"command_id": "scn-dup-0", "kind": "test.inject_fault", "args": {"kind": "fouling", "target": "p_hs_b", "params": {"omax": 0.5, "tau_s": 100.0}},
               "principal": "scenario-launcher:x", "actor_type": "operator"}
        a1 = await st.eng.submit(dict(cmd))
        a2 = await st.eng.submit(dict(cmd))
        assert a1["accepted"] and a2["accepted"] and a2.get("duplicate") and len(st.eng.plant.fault_mgr.procs) == 1
    finally:
        await st.stop()


@pytest.mark.asyncio
async def test_real_crusoe_client_once_capped_spend(no_wait):
    from loopkeeper.intelligence.crusoe import CrusoeClient, IntelligenceConfig, load_dotenv_file
    load_dotenv_file(str(Path(__file__).resolve().parents[2] / ".env"))
    cfg = IntelligenceConfig.from_env()
    if not cfg.configured or os.environ.get("SCENARIO_LIVE_REAL_MODEL", "1") == "0":
        pytest.skip("Crusoe not configured")
    st = await _stack("run_t_scn_real", warmup_s=2.0)
    try:
        client = CrusoeClient(cfg)
        rig = Rig(st, client)
        rid = await rig.submit("Something is wrong with the water near the middle racks, maybe overheating. Handle it.")
        rec = await rig.final(rid, timeout=90.0)                      # ONE chat completion (30 s timeout inside interpret_incident_prompt, no retries)
        crusoe = rec["interpretation"]["crusoe"]
        assert rec["status"] in ("READY", "REJECTED"), rec
        assert crusoe["model"] and crusoe["proposal"]["proposed_faults"]
        used = rec["interpretation"]["tokens_used"]
        assert used["tokens_in"] + used["tokens_out"] < 4000          # spend cap for the single call
        if rec["status"] == "READY":
            assert rec["live"]["injections"][0]["accepted"] and rec["run_id"] == st.eng.run_id
        print("REAL", crusoe["model"], used, rec["live"]["injections"] if rec["live"] else rec["error_message"], rec["interpretation"]["latencies_ms"])
    finally:
        await st.stop()
