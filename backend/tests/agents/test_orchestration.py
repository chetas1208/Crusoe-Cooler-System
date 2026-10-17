import pytest
from loopkeeper.orchestration.facility import Facility
from loopkeeper.orchestration.policy import Policy, ResourceLocks, ACTIONS
from loopkeeper.orchestration.monitor import Monitor
from agent_fakes import FakeEngine, FakeModelClient, make_topology


def test_policy_approval_rules():
    fac = Facility(make_topology())
    p_auto = Policy(fac, approval_mode="autonomous")
    assert p_auto.approval_required("brush_clear") is True
    assert p_auto.approval_required("replace_section") is True
    assert p_auto.approval_required("replace_strainer") is False
    assert p_auto.approval_style() == "veto-window"

    p_super = Policy(fac, approval_mode="supervised")
    assert p_super.approval_style() == "explicit"


def test_resource_locks():
    locks = ResourceLocks()
    # Try acquiring robot for inc_1
    assert locks.try_robot("crawler_1", "inc_1") is True
    # Re-acquire is idempotent
    assert locks.try_robot("crawler_1", "inc_1") is True
    # Conflict from inc_2 is refused
    assert locks.try_robot("crawler_1", "inc_2") is False

    # Release by inc_1
    locks.release_robot("crawler_1", "inc_1")
    # Now inc_2 can acquire
    assert locks.try_robot("crawler_1", "inc_2") is True


@pytest.mark.asyncio
async def test_fake_model_client():
    client = FakeModelClient("test-crusoe-model")
    models = await client.list_models()
    assert "test-crusoe-model" in models

    resp = await client.complete_json(
        system="system prompt",
        user='{"facts": {"detector_cause": "fouling"}}',
        schema_name="classify"
    )
    assert resp.model_id == "test-crusoe-model"
    assert "fouling" in resp.text
    await client.aclose()
    assert client.closed is True


def test_monitor_nominal_world():
    fac = Facility(make_topology())
    eng = FakeEngine()
    world = eng.world()
    mon = Monitor(fac)
    detections = mon.evaluate(world)
    assert len(detections) == 0
