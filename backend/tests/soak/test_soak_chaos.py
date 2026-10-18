"""Chaos / soak scenarios over the in-process real stack (see soak_lib.py). Every scenario asserts the same invariant set:

  physics never halts permanently | no incident stuck beyond its liveness guard | no duplicate repair after restart |
  every VERIFIED has a model-reviewed Layer B | no unbounded growth (RSS / dict+deque sizes / open incident keys) |
  event seq monotonic with no gaps | spend ceilings hold | committed events are durable | leases always end (deadman) | replay is hash-identical

Default horizon = 1 simulated hour per scenario (~3 min wall at ~22 sim-s/s + the 1950 s quiesce); SOAK_SIM_HOURS / SOAK_SIM_S / SOAK_SEED override.
Run ONE scenario per invocation through the lock:  scripts/pytest_locked.sh tests/soak -m slow -k restarts
A run that violates an invariant is marked xfail(strict=False) ONLY when the violation is already reported to its owner (see KNOWN below and
docs/engineering/V12_SOAK_REPORT.md); an xfail that starts passing shows up as XPASS = the owner fixed it.
"""
import asyncio
import os

import pytest

from scenarios import build
from soak_lib import run_soak, write_result

pytestmark = pytest.mark.slow

# invariant-prefix -> reason (owner, report id). Filled from the ledger; empty means every violation fails the test.
KNOWN: dict[str, str] = {}


def _check(res: dict) -> None:
    bad = [v for v in res["violations"] if v["invariant"] not in KNOWN]
    assert not bad, "\n".join(f"[{v['invariant']}] t={v['sim_t']}: {v['detail']}" for v in bad[:12])


async def _run(name: str, **over) -> dict:
    res = await run_soak(build(name, **over))
    write_result(res)
    return res


@pytest.mark.asyncio
async def test_soak_faults_all_kinds():
    _check(await _run("faults"))


@pytest.mark.asyncio
async def test_soak_restarts():
    _check(await _run("restarts"))


@pytest.mark.asyncio
async def test_soak_provider_outages():
    _check(await _run("outages"))


@pytest.mark.asyncio
async def test_soak_db_commit_failures():
    _check(await _run("dbfail"))


@pytest.mark.asyncio
async def test_soak_manual_leases():
    _check(await _run("leases"))


@pytest.mark.asyncio
async def test_soak_concurrent_requests():
    _check(await _run("concurrent"))


@pytest.mark.asyncio
async def test_soak_spend_ceiling():
    _check(await _run("spend"))


@pytest.mark.asyncio
async def test_soak_hostile_model():
    _check(await _run("hostile"))


@pytest.mark.asyncio
async def test_soak_everything():
    _check(await _run("everything"))


@pytest.mark.asyncio
async def test_soak_replay_is_hash_identical():
    """The same seeded run executed twice (restarts, outages, DB failures and bursts included) must end in the identical engine state hash and the
    identical persisted event chain: any divergence means wall-clock / iteration-order / uuid leakage into deterministic state."""
    a = await _run("determinism")
    b = await _run("determinism")
    _check(a)
    _check(b)
    assert a["final_state_hash"] == b["final_state_hash"], (a["final_state_hash"], b["final_state_hash"], a["last_seq"], b["last_seq"])
    assert a["event_chain_hash"] == b["event_chain_hash"]


@pytest.fixture(scope="module")
def pg_url(tmp_path_factory):
    url = os.environ.get("TEST_DATABASE_URL")                      # a disposable branch only, never production
    if url:
        yield url
        return
    pgserver = pytest.importorskip("pgserver")
    try:
        srv = pgserver.get_server(str(tmp_path_factory.mktemp("soak_pg")))
    except Exception as e:                                          # noqa: BLE001
        pytest.skip(f"embedded postgres unavailable: {type(e).__name__}")
    yield srv.get_uri()
    srv.cleanup()


@pytest.mark.asyncio
async def test_soak_postgres_persistence_variant(pg_url):
    """Real Postgres store (embedded pgserver) + Postgres LangGraph checkpointer + PgDecisionStore: kill/restore, DB commit failures and provider outages
    over the real persistence path."""
    _check(await _run("postgres", storage="postgres", pg_url=pg_url, name="postgres"))
