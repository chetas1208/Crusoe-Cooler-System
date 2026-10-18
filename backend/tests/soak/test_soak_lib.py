"""Fast self-tests of the soak harness: the invariant checkers must actually FIRE on planted violations (a checker that cannot fail proves nothing),
and the fault injectors must behave as specified. No plant, no network, no wall-clock waits."""
import asyncio
import random

import pytest

from loopkeeper.intelligence.crusoe import ModelError
from loopkeeper.storage.base import StorageError
from loopkeeper.storage.memory import MemoryStorage

from soak_lib import (DbChaos, DbWindow, FaultyModel, LivenessTracker, ModelWindow, VClock, check_growth, check_seq_stream, check_verified_contract,
                      install_db_chaos, liveness_sig, slope)


def test_seq_checker_flags_gaps_repeats_and_backwards():
    assert check_seq_stream([5, 6, 7, 8], 4) == []
    assert check_seq_stream([1, 2, 3]) == []
    assert "gap" in check_seq_stream([5, 6, 8], 4)[0]
    assert "repeat/backwards" in check_seq_stream([5, 6, 6], 4)[0]
    assert "repeat/backwards" in check_seq_stream([5, 4], 3)[0]
    assert check_seq_stream([9], 4) != []                       # first event after a restart must continue exactly


def _contract(layer_a="PASS", verdict="concur", source="model", state="VERIFIED"):
    return {"terminal_state": state, "evaluation": {"layer_a": layer_a, "layer_b": {"verdict": verdict, "source": source, "model_id": "m"}}}


def test_verified_requires_model_reviewed_layer_b():
    assert check_verified_contract(_contract()) == []
    assert check_verified_contract(_contract(source="fallback"))            # deterministic fallback is not a model review
    assert check_verified_contract(_contract(verdict="request_replan"))
    assert check_verified_contract(_contract(layer_a="FAIL"))
    assert check_verified_contract({"terminal_state": "VERIFIED", "evaluation": {"layer_a": "PASS", "layer_b": None}})
    assert check_verified_contract(_contract(source="fallback", state="PARTIAL")) == []   # only VERIFIED is policed


def test_liveness_tracker_flags_idle_incident_but_not_progress_or_approval_waits():
    tr = LivenessTracker(limit_s=100, max_age_s=1000)
    inc = {"id": "INC-1", "status": "mitigating", "stage": "dispatch", "evidence": [], "task_ids": [], "attempts": 0, "cause": "fouling"}
    assert tr.observe([inc], 0) == []
    assert tr.observe([inc], 90) == []
    assert tr.observe([inc], 150)                                           # no signature change for 150 > 100 s
    assert tr.observe([inc], 400) == []                                     # reported once
    inc2 = dict(inc, id="INC-2")
    assert tr.observe([inc2], 500) == []
    inc2["evidence"] = [1]
    assert tr.observe([inc2], 590) == [] and tr.observe([inc2], 680) == []   # progress resets the idle timer
    inc3 = dict(inc, id="INC-3", approval={"status": "pending"})
    tr.observe([inc3], 0)
    out = tr.observe([inc3], 5000)
    assert len(out) == 1 and "open for" in out[0] and "no progress" not in out[0]      # approval waits are exempt from the idle rule, not from the age cap
    done = dict(inc, id="INC-4", status="escalated")
    assert tr.observe([done], 10_000) == []
    assert liveness_sig(inc) != liveness_sig(inc2)


def _sizes(**kw):
    base = dict(bus_ring=10, hist_t=100, hist_series_max=100, pending_events=0, rt_tasks=0, open_incidents=0, rt_progress=0, waiters=0, open_keys=0,
                escalated_incidents=0, track_tasks=0, ledger_tasks=0, decision_store=0, missions=0, applied_effects=0, cmd_ledger=0, suppress=0, assignments=0,
                sems=0, inc_sem=0, budgets=0)
    base.update(kw)
    return base


def test_growth_checker_flags_leaks_and_passes_healthy_runs():
    assert check_growth([_sizes()], 3, 20000, 450) == []
    assert check_growth([_sizes(bus_ring=30000)], 3, 20000, 450)
    assert check_growth([_sizes(rt_tasks=9, open_incidents=1)], 3, 20000, 450)
    assert check_growth([_sizes(open_keys=7, open_incidents=1)], 3, 20000, 450)
    assert check_growth([_sizes(open_keys=2, open_incidents=1, escalated_incidents=1)], 3, 20000, 450) == []
    assert check_growth([_sizes(hist_series_max=900)], 3, 20000, 450)
    assert check_growth([_sizes(track_tasks=100000)], 3, 20000, 450)


def test_slope():
    assert abs(slope([0, 1, 2, 3], [0, 2, 4, 6]) - 2.0) < 1e-9
    assert slope([1], [1]) == 0.0


def test_db_chaos_modes():
    st = MemoryStorage()
    clock, calls = VClock(0.0), []
    ch = DbChaos(clock, random.Random(1))
    ch.windows = [DbWindow(10, 20, "down"), DbWindow(30, 40, "ack_lost"), DbWindow(50, 60, "flaky")]
    st.commit = lambda b: calls.append(b)                                   # the real commit would need a run row; the wrapper only needs something to wrap
    install_db_chaos(st, ch)
    st.commit("a")
    assert calls == ["a"]
    clock.t = 15
    with pytest.raises(StorageError):
        st.commit("b")
    assert calls == ["a"] and ch.failed == 1                                # down: nothing applied
    clock.t = 35
    with pytest.raises(StorageError):
        st.commit("c")
    assert calls == ["a", "c"] and ch.ack_lost == 1                         # ack lost: applied, caller told it failed
    clock.t = 55
    fails = 0
    for i in range(40):
        try:
            st.commit(i)
        except StorageError:
            fails += 1
    assert 5 < fails < 35
    clock.t = 70
    st.commit("z")
    assert calls[-1] == "z"
    install_db_chaos(st, ch)                                                # idempotent
    assert st._soak_chaos is ch


@pytest.mark.asyncio
async def test_faulty_model_modes():
    clock = VClock(0.0)
    m = FaultyModel(clock, random.Random(2), rates={})
    ok = await m.complete_json(system="s", user='{"facts":{"detector_cause":"fouling"}}', schema_name="classify", incident_id="INC-1")
    assert '"mechanism"' in ok.text and m.tokens_by_inc["INC-1"] == 180
    for mode, status in (("outage_503", 503), ("outage_429", 429), ("outage_timeout", None)):
        m.windows = [ModelWindow(0, 10, mode)]
        with pytest.raises(ModelError) as ei:
            await m.complete_json(system="s", user="{}", schema_name="classify")
        assert ei.value.status == status
    m.windows = [ModelWindow(0, 10, "garbage")]
    g = await m.complete_json(system="s", user='{"facts":{}}', schema_name="classify")
    assert g.text in __import__("soak_lib").GARBAGE
    m.windows = [ModelWindow(0, 10, "hog")]
    h = await m.complete_json(system="s", user='{"facts":{}}', schema_name="classify", incident_id="INC-2")
    assert m.tokens_by_inc["INC-2"] == 13000 and m.max_call_tokens == 13000
    m.windows = []
    clock.t = 100.0
    m.windows = [ModelWindow(100, 200, "slow")]
    m.rng = random.Random(5)
    t = asyncio.ensure_future(m.complete_json(system="s", user='{"facts":{}}', schema_name="classify", timeout_s=45.0))
    await asyncio.sleep(0)
    assert not t.done()                                                     # a slow call really spans simulated time
    for _ in range(20):
        clock.t += 25.0
        m.pump()
        await asyncio.sleep(0)
        if t.done():
            break
    assert t.done()
