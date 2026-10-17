"""V11 Shared Brain: provenance, independent promotion, conflicts (never silent overwrite), TTL, run isolation, token-budgeted reads, compaction,
the hooks (flag OFF = inert) and the ablation switch. Every store behaviour runs on the in-memory twin AND on a real Postgres (embedded pgserver in a
temp dir, no network; plus TEST_DATABASE_URL when set - a disposable branch, never production)."""
from __future__ import annotations

import asyncio
import os
import threading
import uuid

import pytest

from loopkeeper.memory import (MemoryBrainStore, MemoryRefusal, NullBrain, PgBrainStore, SharedBrain, make_brain, memory_read, memory_write, paired_delta,
                               prior_block, record_episode, tokens_of)
from loopkeeper.memory.schema import TABLES
from loopkeeper.storage.memory import MemoryStorage

PROPOSER, VERIFIER = "agent:SEN-01", "verifier:SEN-05"


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture(scope="module")
def pg_url(tmp_path_factory):
    url = os.environ.get("TEST_DATABASE_URL")
    if url:
        yield url
        return
    pgserver = pytest.importorskip("pgserver")
    try:
        srv = pgserver.get_server(str(tmp_path_factory.mktemp("brain_pg")))
    except Exception as e:                                          # noqa: BLE001
        pytest.skip(f"embedded postgres unavailable: {type(e).__name__}")
    yield srv.get_uri()
    srv.cleanup()


@pytest.fixture(scope="module")
def pg_storage(pg_url):
    from loopkeeper.storage.postgres import PostgresStorage
    st = PostgresStorage(pg_url)
    st.migrate()
    yield st
    st.close()


@pytest.fixture(params=["memory", "postgres"])
def kit(request):
    clock = Clock()
    if request.param == "memory":
        store = MemoryBrainStore()
    else:
        store = PgBrainStore(request.getfixturevalue("pg_storage").pool)
    fac = "fac_" + uuid.uuid4().hex[:8]                              # unique facility per test: isolation inside a shared database
    return SharedBrain(store, clock=clock), clock, fac, store


def fact(b, fac, run="run_a", inc="INC-001", value=None, subject="asset:strainer_02:cause", **kw):
    return b.propose_fact(run_id=run, facility_id=fac, subject_key=subject, statement=f"strainer_02 cause {value or 'strainer_blockage'}", value={"cause": value or "strainer_blockage"},
                          evidence_ids=["ev_1_1", "ev_1_2"], proposed_by=PROPOSER, incident_id=inc, fault_kind="strainer_blockage", asset_type="strainer", asset_id="strainer_02", **kw)


def lesson(b, fac, run="run_a", inc="INC-001", action="replace_strainer", **kw):
    return b.propose_lesson(run_id=run, facility_id=fac, fault_kind="strainer_blockage", steps=[{"action": action, "target_role": "strainer"}], evidence_ids=["ev_1_1"],
                            proposed_by=PROPOSER, asset_type="strainer", incident_id=inc, expected_outcome="verified recovery", **kw)


def ver(run="run_a", inc="INC-001", status="verified", vid="ver_1", verifier=VERIFIER):
    return {"verification_id": vid, "verifier": verifier, "status": status, "run_id": run, "incident_id": inc}


def read(b, fac, run="run_b", **kw):
    return b.read_relevant(run_id=run, facility_id=fac, fault_kind=kw.pop("fault_kind", "strainer_blockage"), asset_type=kw.pop("asset_type", "strainer"), **kw)


def tag(row, kind="lesson"):
    return {"kind": kind, "id": row["lesson_id" if kind == "lesson" else "fact_id"], "revision": row["revision"]}


# ───────────────────────── schema / migration ─────────────────────────
def test_migration_0010_is_idempotent_and_matches_the_python_schema(pg_storage):
    pg_storage.migrate()
    pg_storage.migrate()
    with pg_storage.pool.connection() as c:
        for kind, spec in TABLES.items():
            cols = [r["column_name"] for r in c.execute("SELECT column_name FROM information_schema.columns WHERE table_name=%s ORDER BY ordinal_position", (spec["table"],)).fetchall()]
            assert set(cols) == set(spec["cols"]), (kind, set(cols) ^ set(spec["cols"]))
        idx = {r["indexname"] for r in c.execute("SELECT indexname FROM pg_indexes WHERE tablename IN ('shared_facts','procedural_lessons','memory_conflicts','playbook_versions')").fetchall()}
        assert {"shared_facts_scope_idx", "shared_facts_subject_idx", "shared_facts_expiry_idx", "procedural_lessons_scope_idx", "memory_conflicts_subject_idx", "playbook_versions_fault_idx"} <= idx
        assert c.execute("SELECT version FROM schema_migrations WHERE version='0010_shared_brain'").fetchone()


# ───────────────────────── provenance + promotion ─────────────────────────
def test_proposal_needs_provenance_and_is_never_read_before_verification(kit):
    b, _, fac, _ = kit
    with pytest.raises(MemoryRefusal) as e:
        b.propose_fact(run_id="run_a", facility_id=fac, subject_key="s", statement="x", evidence_ids=[], proposed_by=PROPOSER)
    assert e.value.code == "no_evidence"
    with pytest.raises(MemoryRefusal):
        b.propose_lesson(run_id="run_a", facility_id=fac, fault_kind="f", steps=[], evidence_ids=["e"], proposed_by=PROPOSER)
    f, l = fact(b, fac), lesson(b, fac)
    assert f["status"] == l["status"] == "PROPOSED" and f["run_id"] == "run_a" and f["evidence_ids"] == ["ev_1_1", "ev_1_2"] and f["proposed_by"] == PROPOSER
    assert fact(b, fac)["deduped"] and lesson(b, fac)["deduped"]            # idempotent re-proposal
    for run in ("run_a", "run_b"):
        r = read(b, fac, run=run)
        assert not r["facts"] and not r["lessons"] and r["tokens"] == 0     # not even the proposing run reads its own unverified claims


def test_only_an_independent_verified_outcome_promotes(kit):
    b, _, fac, _ = kit
    f, l = fact(b, fac), lesson(b, fac)
    items = [tag(f, "fact"), tag(l)]
    assert {x["reason"] for x in b.settle(run_id="run_a", incident_id="INC-001", verification=ver(verifier=PROPOSER), items=items)["refused"]} == {"verifier_is_proposer"}
    assert b.settle(run_id="run_a", incident_id="INC-001", verification=ver(vid=""), items=items)["refused"]                   # unidentified
    assert b.settle(run_id="run_a", incident_id="INC-001", verification={**ver(), "run_id": "run_zzz"}, items=items)["refused"]  # about another run
    assert b.settle(run_id="run_a", incident_id="INC-001", verification=ver(status="unknown"), items=items)["kept"]
    assert not read(b, fac)["lessons"]
    res = b.settle(run_id="run_a", incident_id="INC-001", verification=ver(), items=items)
    assert len(res["promoted"]) == 2
    r = read(b, fac, run="run_b")                                            # another run now sees it: provenance + evidence travel with it
    assert r["lessons"][0]["id"] == l["lesson_id"] and r["facts"][0]["id"] == f["fact_id"]
    assert r["lessons"][0]["run_ids"] == ["run_a"] and r["lessons"][0]["evidence_ids"] == ["ev_1_1"]
    row = b.store.get("lesson", {"lesson_id": l["lesson_id"], "revision": 1})
    assert row["status"] == "VERIFIED" and row["visibility"] == "shared" and row["verified_by"] == VERIFIER and row["verification_ref"]["verification_id"] == "ver_1"


def test_a_lesson_is_not_promoted_from_a_failed_run(kit):
    b, _, fac, _ = kit
    l = lesson(b, fac, run="run_f", inc="INC-009")
    res = b.settle(run_id="run_f", incident_id="INC-009", verification=ver(run="run_f", inc="INC-009", status="rejected", vid="ver_f"))
    assert [x["id"] for x in res["rejected"]] == [l["lesson_id"]] and not res["promoted"]
    row = b.store.get("lesson", {"lesson_id": l["lesson_id"], "revision": 1})
    assert row["status"] == "REJECTED" and row["failure_count"] == 1 and row["evidence_ids"]       # kept for audit, never learned
    assert not read(b, fac)["lessons"]
    # a second, verified attempt with a different plan is learned; the failed one is not
    l2 = lesson(b, fac, run="run_f", inc="INC-009", action="clean_basket")
    b.settle(run_id="run_f", incident_id="INC-009", verification=ver(run="run_f", inc="INC-009", vid="ver_f2"), items=[tag(l2)])
    assert [x["id"] for x in read(b, fac)["lessons"]] == [l2["lesson_id"]]


def test_corroboration_merges_into_the_verified_twin(kit):
    b, _, fac, _ = kit
    l1 = lesson(b, fac)
    b.settle(run_id="run_a", incident_id="INC-001", verification=ver())
    l2 = lesson(b, fac, run="run_c", inc="INC-004")
    assert l2["lesson_id"] == l1["lesson_id"] and l2["revision"] == 2
    res = b.settle(run_id="run_c", incident_id="INC-004", verification=ver(run="run_c", inc="INC-004", vid="ver_c"))
    assert res["merged"]
    twin = b.store.get("lesson", {"lesson_id": l1["lesson_id"], "revision": 1})
    assert twin["success_count"] == 2 and set(twin["source_run_ids"]) == {"run_a", "run_c"} and twin["confidence"] > 0.7
    assert b.store.get("lesson", {"lesson_id": l1["lesson_id"], "revision": 2})["status"] == "ARCHIVED"
    assert len(read(b, fac)["lessons"]) == 1


# ───────────────────────── conflicts ─────────────────────────
def test_conflicting_evidence_keeps_both_revisions_as_conflicted_never_overwrites(kit):
    b, _, fac, _ = kit
    f1 = fact(b, fac)
    b.settle(run_id="run_a", incident_id="INC-001", verification=ver(), items=[tag(f1, "fact")])
    assert [x["id"] for x in read(b, fac)["facts"]] == [f1["fact_id"]]
    f2 = fact(b, fac, run="run_c", inc="INC-007", value="valve_stuck")
    assert f2["fact_id"] == f1["fact_id"] and f2["revision"] == 2 and f2["status"] == "CONFLICTED"
    r1 = b.store.get("fact", {"fact_id": f1["fact_id"], "revision": 1})
    assert r1["status"] == "CONFLICTED" and r1["value"] == {"cause": "strainer_blockage"} and r1["statement"].endswith("strainer_blockage")      # old content untouched
    assert b.store.get("fact", {"fact_id": f1["fact_id"], "revision": 2})["value"] == {"cause": "valve_stuck"}
    cs = b.open_conflicts(fac)
    assert len(cs) == 1 and {i["revision"] for i in cs[0]["items"]} == {1, 2} and cs[0]["status"] == "OPEN"
    r = read(b, fac)
    assert not r["facts"] and r["disputed"] and r["disputed"][0]["subject"] == "asset:strainer_02:cause"       # flagged, never served as truth
    # resolution needs an independent verified outcome
    with pytest.raises(MemoryRefusal):
        b.resolve_conflict(cs[0]["conflict_id"], winner_revision=2, verification=ver(run="run_c", verifier=PROPOSER), resolved_by="op")
    b.resolve_conflict(cs[0]["conflict_id"], winner_revision=2, verification=ver(run="run_c", inc="INC-007", vid="ver_x"), resolved_by="op", reason="bench test")
    assert [x["id"] for x in read(b, fac)["facts"]] == [f1["fact_id"]] and not b.open_conflicts(fac)
    assert {b.store.get("fact", {"fact_id": f1["fact_id"], "revision": n})["status"] for n in (1, 2)} == {"VERIFIED", "REJECTED"}


def test_a_contradicting_claim_that_fails_verification_dissolves_the_conflict(kit):
    b, _, fac, _ = kit
    f1 = fact(b, fac)
    b.settle(run_id="run_a", incident_id="INC-001", verification=ver(), items=[tag(f1, "fact")])
    fact(b, fac, run="run_c", inc="INC-007", value="valve_stuck")
    assert not read(b, fac)["facts"]
    b.settle(run_id="run_c", incident_id="INC-007", verification=ver(run="run_c", inc="INC-007", status="rejected", vid="ver_c"))
    assert [x["id"] for x in read(b, fac)["facts"]] == [f1["fact_id"]] and not b.open_conflicts(fac)       # poisoning cannot stick


def test_two_verified_contradictions_end_conflicted(kit):
    b, _, fac, _ = kit
    fa = fact(b, fac, run="run_a", inc="I1")
    fb = fact(b, fac, run="run_b", inc="I2", value="valve_stuck")
    assert fa["status"] == fb["status"] == "PROPOSED"                      # two unverified claims do not conflict yet
    b.settle(run_id="run_a", incident_id="I1", verification=ver(inc="I1", vid="v1"))
    b.settle(run_id="run_b", incident_id="I2", verification=ver(run="run_b", inc="I2", vid="v2"))
    st = {b.store.get("fact", {"fact_id": fa["fact_id"], "revision": n})["status"] for n in (1, 2)}
    assert st == {"CONFLICTED"} and len(b.open_conflicts(fac)) == 1 and not read(b, fac, run="run_z")["facts"]


def test_a_verified_lesson_that_later_fails_under_the_same_plan_is_flagged(kit):
    b, _, fac, _ = kit
    l1 = lesson(b, fac)
    b.settle(run_id="run_a", incident_id="INC-001", verification=ver())
    lesson(b, fac, run="run_d", inc="INC-020")
    b.settle(run_id="run_d", incident_id="INC-020", verification=ver(run="run_d", inc="INC-020", status="rejected", vid="ver_d"))
    assert b.store.get("lesson", {"lesson_id": l1["lesson_id"], "revision": 1})["status"] == "CONFLICTED"
    assert b.store.get("lesson", {"lesson_id": l1["lesson_id"], "revision": 2})["status"] == "CONFLICTED"
    assert not read(b, fac)["lessons"] and read(b, fac)["disputed"]


# ───────────────────────── expiry ─────────────────────────
def test_sensor_facts_expire_and_invalid_facts_stop_being_read(kit):
    b, clock, fac, _ = kit
    s = fact(b, fac, subject="sensor:sn_flow_trunk:bias", fact_kind="sensor")
    assert s["expires_ts"] == clock.t + 1800
    k = fact(b, fac, subject="asset:valve_a1:state")
    b.settle(run_id="run_a", incident_id="INC-001", verification=ver())
    assert {x["id"] for x in read(b, fac)["facts"]} == {s["fact_id"], k["fact_id"]}
    assert b.invalidate("fact", k["fact_id"], 1, "recalibrated") and not b.invalidate("fact", k["fact_id"], 1, "again")
    assert {x["id"] for x in read(b, fac)["facts"]} == {s["fact_id"]}
    clock.t += 1801
    assert not read(b, fac)["facts"]                                        # filtered at read time even before any sweep
    assert b.expire_sweep() == 1 and b.store.get("fact", {"fact_id": s["fact_id"], "revision": 1})["status"] == "EXPIRED"
    clock.t += 8 * 86400                                                    # an unsettled proposal expires too
    p = lesson(b, fac, run="run_q", inc="INC-050")
    clock.t += 8 * 86400
    b.expire_sweep()
    assert b.store.get("lesson", {"lesson_id": p["lesson_id"], "revision": p["revision"]})["status"] == "EXPIRED"


# ───────────────────────── isolation / leakage ─────────────────────────
def test_no_foreign_run_or_foreign_facility_leakage(kit):
    b, _, fac, _ = kit
    other = fac + "_other"
    l = lesson(b, fac, run="run_a")                                          # proposed only
    lesson(b, other, run="run_x", inc="INC-077", action="reboot_everything")
    b.settle(run_id="run_x", incident_id="INC-077", verification=ver(run="run_x", inc="INC-077", vid="vx"))
    assert not read(b, fac, run="run_b")["lessons"]                           # run_a's unverified lesson invisible to run_b; other facility's verified lesson too
    b.settle(run_id="run_a", incident_id="INC-001", verification=ver())
    assert [x["id"] for x in read(b, fac, run="run_b")["lessons"]] == [l["lesson_id"]]
    assert not read(b, other + "2", run="run_b")["lessons"]
    assert [x["id"] for x in read(b, other, run="run_b")["lessons"]] != [l["lesson_id"]]
    # held-out contamination guard: anything whose provenance touches an excluded run is never returned
    assert not read(b, fac, run="run_b", exclude_runs=["run_a"])["lessons"]
    lc = lesson(b, fac, run="run_c", inc="I3")                                # corroborated by an excluded run -> source_run_ids touches it
    b.settle(run_id="run_c", incident_id="I3", verification=ver(run="run_c", inc="I3", vid="v3"))
    assert not read(b, fac, run="run_b", exclude_runs=["run_c"])["lessons"]
    # a different topology layout is stale knowledge
    lt = b.propose_lesson(run_id="run_t", facility_id=fac, fault_kind="pump_degradation", steps=[{"action": "service_pump"}], evidence_ids=["e"], proposed_by=PROPOSER,
                          incident_id="T", topology_revision="th_old")
    b.settle(run_id="run_t", incident_id="T", verification=ver(run="run_t", inc="T", vid="vt"))
    assert read(b, fac, fault_kind="pump_degradation", asset_type=None, topology_revision="th_old")["lessons"]
    assert not read(b, fac, fault_kind="pump_degradation", asset_type=None, topology_revision="th_new")["lessons"]
    assert lt and lc


# ───────────────────────── token budget ─────────────────────────
def test_retrieval_is_token_budgeted_and_compact(kit):
    b, _, fac, _ = kit
    for i in range(12):
        b.propose_lesson(run_id="run_a", facility_id=fac, fault_kind="strainer_blockage", asset_type="strainer", incident_id="INC-001", proposed_by=PROPOSER, evidence_ids=["e"],
                         steps=[{"action": f"action_{i}", "target_role": "strainer"}], expected_outcome="verified recovery " + "x" * 120)
    b.settle(run_id="run_a", incident_id="INC-001", verification=ver())
    full = read(b, fac, limit=50, token_budget=100000)
    assert len(full["lessons"]) == 12 and not full["truncated"]
    for budget in (60, 150, 400):
        r = read(b, fac, limit=50, token_budget=budget)
        assert r["tokens"] <= budget
        assert r["truncated"] and 0 <= len(r["lessons"]) < 12
        assert tokens_of(r["text"]) <= budget
    assert read(b, fac, limit=3, token_budget=100000)["lessons"].__len__() == 3
    assert read(b, fac, limit=50, token_budget=5)["lessons"] == []


# ───────────────────────── compaction ─────────────────────────
def test_compact_summarises_terminal_rows_with_links_to_events_and_prunes(kit):
    b, clock, fac, _ = kit
    for i in range(3):
        b.propose_lesson(run_id=f"run_{i}", facility_id=fac, fault_kind="strainer_blockage", asset_type="strainer", incident_id=f"I{i}", proposed_by=PROPOSER, evidence_ids=[f"ev_{i}"],
                         steps=[{"action": f"a{i}"}], event_refs=[{"run_id": f"run_{i}", "seq": 100 + i}])
        b.settle(run_id=f"run_{i}", incident_id=f"I{i}", verification=ver(run=f"run_{i}", inc=f"I{i}", status="rejected", vid=f"v{i}"))
    good = lesson(b, fac, run="run_ok", inc="IOK")
    b.settle(run_id="run_ok", incident_id="IOK", verification=ver(run="run_ok", inc="IOK", vid="vok"))
    clock.t += 3600
    out = b.compact(fac, older_than_s=60, delete=True)
    assert out == {"summaries": 1, "pruned": 3}
    rows = b.store.select("lesson", eq={"facility_id": fac})
    summ = [r for r in rows if r["lesson_id"].startswith("sum_")]
    assert len(summ) == 1 and summ[0]["status"] == "ARCHIVED" and {e["seq"] for e in summ[0]["event_refs"]} == {100, 101, 102} and set(summ[0]["evidence_ids"]) == {"ev_0", "ev_1", "ev_2"}
    assert [r["lesson_id"] for r in rows if not r["lesson_id"].startswith("sum_")] == [good["lesson_id"]]       # the verified row is untouched
    assert [x["id"] for x in read(b, fac)["lessons"]] == [good["lesson_id"]]
    assert b.compact(fac, older_than_s=60, delete=True) == {"summaries": 0, "pruned": 0}


# ───────────────────────── playbooks (stretch) ─────────────────────────
def test_playbook_is_accepted_only_on_heldout_evidence_and_rejected_honestly(kit):
    b, _, fac, _ = kit
    p1 = b.propose_playbook(facility_id=fac, fault_kind="strainer_blockage", doc={"steps": ["replace_strainer"]}, lesson_refs=["lsn_x"])
    assert p1["version"] == 1 and p1["status"] == "CANDIDATE"
    r = b.decide_playbook(p1["playbook_id"], 1, {"heldout_n": 4, "delta_verified_completion": 0.2, "false_success_on": 0, "false_success_off": 0})
    assert r["status"] == "REJECTED" and "held-out n=4 < 10" in r["reasons"][0]
    p2 = b.propose_playbook(facility_id=fac, fault_kind="strainer_blockage", doc={"steps": ["replace_strainer"]}, lesson_refs=["lsn_x"])
    assert p2["version"] == 2 and p2["parent_version"] is None
    assert b.decide_playbook(p2["playbook_id"], 2, {"heldout_n": 10, "delta_verified_completion": 0.0, "false_success_on": 0, "false_success_off": 0})["status"] == "REJECTED"
    p3 = b.propose_playbook(facility_id=fac, fault_kind="strainer_blockage", doc={"steps": ["replace_strainer"]}, lesson_refs=["lsn_x"])
    assert b.decide_playbook(p3["playbook_id"], 3, {"heldout_n": 10, "delta_verified_completion": 0.3, "false_success_on": 0, "false_success_off": 0})["status"] == "ACCEPTED"
    assert b.store.get("playbook", {"playbook_id": p3["playbook_id"], "version": 3})["evaluation"]["decision"] == "ACCEPTED"
    with pytest.raises(MemoryRefusal):
        b.decide_playbook(p3["playbook_id"], 3, {"heldout_n": 10})                  # decided once


# ───────────────────────── persistence / concurrency (Postgres) ─────────────────────────
def test_postgres_persistence_survives_a_new_connection_pool(pg_storage, pg_url):
    from loopkeeper.storage.postgres import PostgresStorage
    fac = "fac_" + uuid.uuid4().hex[:8]
    b = SharedBrain(PgBrainStore(pg_storage.pool))
    l = lesson(b, fac)
    f = fact(b, fac)
    b.settle(run_id="run_a", incident_id="INC-001", verification=ver())
    st2 = PostgresStorage(pg_url)                                              # a "restarted" process: fresh pool, fresh store
    try:
        r = SharedBrain(PgBrainStore(st2.pool)).read_relevant(run_id="run_next", facility_id=fac, fault_kind="strainer_blockage", asset_type="strainer")
        assert [x["id"] for x in r["lessons"]] == [l["lesson_id"]] and [x["id"] for x in r["facts"]] == [f["fact_id"]]
        assert r["lessons"][0]["run_ids"] == ["run_a"]
    finally:
        st2.close()


@pytest.mark.parametrize("backend", ["memory", "postgres"])
def test_concurrent_conflicting_proposals_get_unique_revisions(backend, request):
    store = MemoryBrainStore() if backend == "memory" else PgBrainStore(request.getfixturevalue("pg_storage").pool)
    b = SharedBrain(store)
    fac, errs, rows = "fac_" + uuid.uuid4().hex[:8], [], []

    def go(i):
        try:
            rows.append(fact(b, fac, run=f"run_{i}", inc=f"I{i}", value=f"cause_{i}"))
        except Exception as e:                                                  # noqa: BLE001
            errs.append(e)
    ts = [threading.Thread(target=go, args=(i,)) for i in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errs and sorted(r["revision"] for r in rows) == [1, 2, 3, 4]


# ───────────────────────── hooks + feature flag ─────────────────────────
class _Fac:
    assets = {"strainer_02": {"type": "strainer"}}

    def label(self, i):
        return i.upper()


class _Eng:
    def __init__(self, storage, run_id):
        self.storage, self.run_id, self.facility_id, self.topology_revision = storage, run_id, "fac_hook", "th_1"


class _Ctx:
    def __init__(self, storage, run_id):
        self.engine, self.fac, self.tick = _Eng(storage, run_id), _Fac(), 42


def _state(ok, action="replace_strainer", inc="INC-001"):
    return {"incident": {"id": inc, "evidence": [{"id": "ev_1_1"}, {"id": "ev_1_2"}], "verification": {"id": "vr_1", "checks": [{"id": "flow"}]}, "attempts": 0},
            "det": {"cause": "strainer_blockage", "target_id": "strainer_02"}, "plan": {"action": action, "target_id": "strainer_02"}, "verify": {"ok": ok}, "attempt": 0}


def test_hooks_are_inert_when_the_flag_is_off(monkeypatch):
    monkeypatch.delenv("MEMORY_ENABLED", raising=False)
    st = MemoryStorage()
    ctx = _Ctx(st, "run_a")
    assert asyncio.run(memory_read(ctx, _state(True)["det"])) == {}
    asyncio.run(memory_write(ctx, _state(True)))
    assert getattr(st, "_shared_brain_store", None) is None and getattr(st, "_shared_brain", None) is None    # nothing was even created


@pytest.mark.parametrize("backend", ["memory", "postgres"])
def test_hooks_write_after_verification_and_read_in_a_later_run(monkeypatch, backend, request):
    monkeypatch.setenv("MEMORY_ENABLED", "1")
    if backend == "memory":
        st = MemoryStorage()
    else:
        st = request.getfixturevalue("pg_storage")
    fac = "fac_hook_" + uuid.uuid4().hex[:6]
    ctx_a, ctx_b = _Ctx(st, "run_a"), _Ctx(st, "run_b")
    ctx_a.engine.facility_id = ctx_b.engine.facility_id = fac
    det = _state(True)["det"]

    async def go():
        assert await memory_read(ctx_a, det) == {}                                   # nothing learned yet
        await memory_write(ctx_a, _state(False, "brush_clear"))                      # a failed attempt first
        await memory_write(ctx_a, _state(True))                                      # then a verified one
        got = await memory_read(ctx_b, det)
        await memory_write(ctx_a, {**_state(True), "verify": {"ok": False, "unknown": True}, "plan": {"action": "wait", "target_id": "strainer_02"}})   # UNKNOWN: kept proposed
        return got, await memory_read(ctx_b, det)
    got, again = asyncio.run(go())
    m = got["memory"]
    assert len(m["lessons"]) == 1 and "replace_strainer" in m["lessons"][0] and "brush_clear" not in m["lessons"][0]
    assert any("confirmed cause strainer_blockage" in x for x in m["facts"]) and "advice only" in m["note"]
    assert "wait" not in " ".join(again["memory"]["lessons"])
    assert st._shared_brain.stats["errors"] == 0


def test_hook_failure_never_propagates(monkeypatch):
    monkeypatch.setenv("MEMORY_ENABLED", "1")
    st = MemoryStorage()
    ctx = _Ctx(st, "run_a")
    assert asyncio.run(memory_read(ctx, {"cause": "strainer_blockage", "target_id": "strainer_02"})) == {}
    asyncio.run(memory_write(ctx, {"incident": {"id": "I"}, "det": {"cause": "x"}, "plan": {"action": "a"}, "verify": {"ok": True}}))   # no target -> refused inside, swallowed
    assert st._shared_brain.stats["errors"] >= 1


# ───────────────────────── ablation hook ─────────────────────────
def test_ablation_off_is_empty_on_learns_only_verified_and_respects_heldout_exclusion():
    off, on = make_brain(False), make_brain(True)
    assert isinstance(off, NullBrain) and record_episode(off, run_id="t1", facility_id="f", fault_kind="x", asset_type="a", action="fix", verified=True, verification_id="v", evidence_ids=["e"]) == {}
    for i, ok in enumerate((True, True, False)):
        record_episode(on, run_id=f"train_{i}", facility_id="f", fault_kind="x", asset_type="a", action="fix" if ok else "bad", verified=ok, verification_id=f"v{i}", evidence_ids=[f"e{i}"])
    kw = dict(run_id="eval_1", facility_id="f", fault_kind="x", asset_type="a")
    assert prior_block(off, **kw) == ""
    txt = prior_block(on, **kw)
    assert "fix" in txt and "bad" not in txt
    assert prior_block(on, **kw, exclude_runs=["train_0", "train_1"]) == ""                    # held-out guard
    assert paired_delta([{"scenario_id": "s", "seed": 1, "v": 0}, {"scenario_id": "s", "seed": 2, "v": 1}], [{"scenario_id": "s", "seed": 1, "v": 1}, {"scenario_id": "s", "seed": 2, "v": 1}],
                        lambda r: r["v"]) == {"n_pairs": 2, "dropped": 0, "mean_delta_on_minus_off": 0.5, "wins": 1, "losses": 0}
