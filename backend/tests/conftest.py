import os
import sys
from pathlib import Path

# deterministic in-process agent tests step simulated time faster than wall-clock: keep the slow Laya router out of the loop
os.environ.setdefault("LOOPKEEPER_LAYA_ROUTER", "0")

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))

from loopkeeper.api import Settings, create_app  # noqa: E402
from support.fake_engine import FakeEngine, FakeRuntime  # noqa: E402
from support.fixtures import OTHER, TOKEN, VIEWER, make_settings  # noqa: E402


@pytest.fixture(autouse=True)
def _deterministic_triage_thread(monkeypatch):
    """Flake root cause (tests/agents/test_live_flows.py::test_all_six_faults...[3-12.0]): the sentinel graph runs the Laya triage via
    asyncio.to_thread, but AgentRuntimeImpl.settle() decides 'the agents are idle' by counting 400 event-loop yields without activity. A thread
    that is merely slow to be scheduled (loaded machine) looks idle, settle() returns early and the incident graph resumes at a different
    simulated time -> a different outcome. Wall-clock must not enter a deterministic simulation, so in tests the triage call runs inline (same
    function, same result; the router is off in tests via LOOPKEEPER_LAYA_ROUTER=0). Production keeps the thread."""
    mod = sys.modules.get("loopkeeper.orchestration.graphs.sentinel")
    if mod is None or not hasattr(mod, "asyncio") or os.environ.get("LOOPKEEPER_TEST_THREADED_TRIAGE") == "1":   # =1: A/B switch, restores the racy behaviour
        return
    import asyncio

    class _InlineThreads:
        def __getattr__(self, name):
            return getattr(asyncio, name)

        @staticmethod
        async def to_thread(fn, /, *a, **kw):
            return fn(*a, **kw)

    monkeypatch.setattr(mod, "asyncio", _InlineThreads())


@pytest.fixture
def engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def runtime() -> FakeRuntime:
    return FakeRuntime()


@pytest.fixture
def settings() -> Settings:
    return make_settings()


@pytest.fixture
def app(engine, runtime, settings):
    return create_app(engine, agent_runtime=runtime, settings=settings)


@pytest.fixture
def client(app):
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as c:
        yield c


@pytest.fixture
def anon(app):
    with TestClient(app) as c:
        yield c


# --------------------------------------------------------------------------------------------------------------------------
# Fast/slow split + xdist scheduling (scripts/test_fast.sh, scripts/test_all.sh). Durations measured serially with
# scripts/pytest_locked.sh --durations (V12 audit); a test is "slow" when it needs ~>=20 s of real pandapipes/agent-loop simulation.
# These nodeid PREFIXES (so every parametrisation) get @pytest.mark.slow without editing the owners' test files.
SLOW_PREFIXES = (
    "tests/agents/test_fleet_soak.py",                       # 18-robot soak, 6-23 s per fault kind
    "tests/agents/test_model_in_loop.py",                    # 9 model-driven flows, 11-26 s each
    "tests/agents/test_live_flows.py",                       # real plant + agent loop, 7-106 s (six-fault live demo: 3 x ~80-106 s)
    "tests/agents/test_policy_seams.py::test_engine_service_actions_for_pump_and_sensor_and_strainer_need_no_isolation",
    "tests/test_v5_acceptance.py::test_laya_01_router_accuracy_and_abstention",     # runs the real torch Laya router on 30 cases
    "tests/test_v7_navigation.py::test_stress_8_outrig_10_inpipe",
    "tests/test_v6_acceptance.py::test_gate_sampled_schedules_home_road_affinity",
    "tests/test_v6_acceptance.py::test_gate_adversarial_random_targets_never_collide",
    "tests/test_v11_eval.py::test_end_to_end_static_run_and_replay_determinism",
    "tests/test_v11_eval.py::test_static_cr07_exposes_the_false_success_the_verifier_exists_for",
    "tests/test_v11_eval_recursive.py::test_runtime_arm_verifies_a_real_strainer_fault_with_truth_agreement",
    "tests/test_v8_scenarios.py::test_v8_playback_controls_and_endpoints",
    "tests/test_v8_scenarios.py::test_cr02_manifold_rupture_leak_physics_and_recovery",
    "tests/test_v8_scenarios.py::test_start_v8_episode_records_exact_30_minutes_clock_and_replay",
    "tests/test_v11_scenario_live.py::test_only_the_six_supported_kinds_and_mapping_table",
    "tests/test_v11_scenario_live.py::test_prompt_to_live_incident_dod_and_links",
    "tests/test_v12_replay_fork.py::test_replay_keyset_pages_concatenate_to_the_whole_window",
    "tests/test_v12_replay_fork.py::test_every_checkpoint_restores_to_its_recorded_state_hash",
)
# ...except these short, still-valuable live-flow cases, which stay in the fast suite (<= ~9 s serial each).
FAST_EXCEPTIONS = (
    "tests/agents/test_live_flows.py::test_each_fault_kind_closes_verified[sensor_drift",
    "tests/agents/test_live_flows.py::test_each_fault_kind_closes_verified[workload_spike",
    "tests/agents/test_live_flows.py::test_escalates_only_after_caps_with_plain_language",
)
# Modules whose tests accumulate state across tests (module-level result lists, module-scoped DB / engine fixtures that later tests build on).
# Under `--dist loadgroup` every test of such a module runs on ONE worker, in file order, exactly as in a serial run. Modules not listed
# here and without module-scoped fixtures are scheduled test-by-test; modules WITH module-scoped fixtures are grouped automatically,
# except those in SPLIT_MODULES whose module fixtures are pure read-only topology data (rebuilding them per worker is cheap).
GROUP_MODULES = {"tests/agents/test_fleet_soak.py", "tests/test_v4_acceptance.py"}
SPLIT_MODULES = {"tests/test_v6_acceptance.py", "tests/test_v7_navigation.py", "tests/physics/test_topology_v2.py"}


def _rel(item) -> str:
    return item.nodeid.split("::", 1)[0]


def pytest_collection_modifyitems(config, items):
    slow = pytest.mark.slow
    for it in items:
        if it.nodeid.startswith(SLOW_PREFIXES) and not it.nodeid.startswith(FAST_EXCEPTIONS):
            it.add_marker(slow)
        mod = _rel(it)
        has_module_state = any(
            fd[-1].scope in ("module", "package") for n, fd in it._fixtureinfo.name2fixturedefs.items() if n != "request")
        if mod in GROUP_MODULES or (has_module_state and mod not in SPLIT_MODULES):
            it.add_marker(pytest.mark.xdist_group(mod))
    if hasattr(config, "workerinput"):
        # xdist worker: hand out the heaviest work first so the long tail is not scheduled last. Same deterministic order on every worker.
        # Stable sort: within a module (and so within a group) the file order is untouched.
        slow_mods = {_rel(i) for i in items if i.get_closest_marker("slow")}

        def key(i):
            if i.get_closest_marker("xdist_group"):                       # grouped: one key per module so file order is kept
                return (1 if _rel(i) in slow_mods else 3, _rel(i))
            return (0 if i.get_closest_marker("slow") else 2, _rel(i))

        items.sort(key=key)


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    if rep.when == "call" and item.module.__name__.endswith("test_v4_acceptance"):
        key = item.name.split("_")[:3]
        tid = "-".join([key[1].upper(), key[2]]) if len(key) >= 3 and key[2].isdigit() else item.name
        store = item.config.__dict__.setdefault("_v4_outcomes", {})
        store[tid] = "PASSED" if rep.passed else ("FAILED" if rep.failed else "SKIPPED")


@pytest.fixture(autouse=True)
def _base_snapshot_cadence(monkeypatch):
    """Tests assume the configured snapshot interval (60 sim-s). In production the storage-budget policy (storage.maintenance.POLICY) stretches it;
    explicit incident / fork / shutdown checkpoints are never subject to it. Give it an unlimited budget here."""
    from loopkeeper.storage import maintenance
    monkeypatch.setattr(maintenance.POLICY, "budget", 1e12)
