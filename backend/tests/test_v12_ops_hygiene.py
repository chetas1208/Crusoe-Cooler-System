"""V12 ops hygiene: log-noise config and GET /api/v1/health/detail (read-only, authenticated, no secrets)."""
from __future__ import annotations

import logging
import time
from collections import deque
from types import SimpleNamespace

from fastapi.testclient import TestClient

from loopkeeper.api import create_app
from loopkeeper.api.__main__ import AccessErrorsOnly, QUIET_LOGGERS, configure_logging
from support.fixtures import TOKEN, make_settings

AUTH = {"Authorization": f"Bearer {TOKEN}"}


def _engine():
    clock = SimpleNamespace(paused=False, speed=1.0, dt=0.5, lag_dropped_s=0.0, wall=time.monotonic, _last=time.monotonic() - 0.2)
    ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 3))
    return SimpleNamespace(run_id="run_x", tick=7, clock=clock, cfg=SimpleNamespace(loop_period_s=0.05), fenced=False, db_down=False, replay=False,
                           bus=SimpleNamespace(ring=deque([{"seq": 5, "ts": ts}]), _subs={object(), object()}), pending_events=[1, 2, 3],
                           pending_snaps=[], pending_samples=[1], commands=SimpleNamespace(dirty={}), storage=None, _started_wall=time.time() - 10,
                           world=lambda: {"health": {}})


def test_health_detail_sections_and_auth():
    c = TestClient(create_app(_engine(), settings=make_settings()))
    assert c.get("/api/v1/health/detail").status_code == 401
    r = c.get("/api/v1/health/detail", headers=AUTH)
    assert r.status_code == 200
    d = r.json()
    assert 0.1 < d["engine"]["tick_lag_s"] < 5 and d["engine"]["tick"] == 7
    assert 2 < d["commit"]["last_commit_age_s"] < 10 and d["commit"]["last_seq"] == 5
    assert d["outbox"]["pending_events"] == 3 and d["outbox"]["depth"] == 4
    assert d["stream"]["event_bus_subscribers"] == 2
    assert d["process"]["rss_mb"] > 0 and d["disk"]["exists"] in (True, False)
    assert "model" in d and "database" in d
    assert TOKEN not in r.text


def test_noisy_loggers_are_quiet_and_access_log_keeps_errors_only():
    configure_logging()
    for name in ("pandapipes", "pandapower", "numba"):
        assert name in QUIET_LOGGERS
        assert not logging.getLogger(name + ".pf.pipeflow_setup").isEnabledFor(logging.INFO)
    f = AccessErrorsOnly()
    rec = lambda status: logging.LogRecord("uvicorn.access", logging.INFO, "", 0, '%s - "%s %s HTTP/%s" %d', ("1.2.3.4:1", "GET", "/x", "1.1", status), None)
    assert not f.filter(rec(200)) and not f.filter(rec(304)) and f.filter(rec(404)) and f.filter(rec(500))
