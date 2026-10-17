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


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    if rep.when == "call" and item.module.__name__.endswith("test_v4_acceptance"):
        key = item.name.split("_")[:3]
        tid = "-".join([key[1].upper(), key[2]]) if len(key) >= 3 and key[2].isdigit() else item.name
        store = item.config.__dict__.setdefault("_v4_outcomes", {})
        store[tid] = "PASSED" if rep.passed else ("FAILED" if rep.failed else "SKIPPED")
