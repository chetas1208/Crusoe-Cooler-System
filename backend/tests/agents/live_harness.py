"""In-process REAL stack (physics plant + engine + agent runtime) stepped deterministically; no network, no wall clock."""
from __future__ import annotations

from typing import Any

from loopkeeper.engine import create_engine
from loopkeeper.intelligence.crusoe import IntelligenceConfig
from loopkeeper.orchestration import AgentRuntimeImpl, Limits
from loopkeeper.physics import FacilityPlant
from loopkeeper.physics.config import load_config
from loopkeeper.storage.memory import MemoryStorage

Json = dict[str, Any]


class Stack:
    def __init__(self, eng: Any, rt: AgentRuntimeImpl) -> None:
        self.eng, self.rt = eng, rt
        self.n_cmd = 0
        self.dt = eng.dt

    @classmethod
    async def create(cls, seed: int = 3, *, model_client: Any = None, checkpointer: Any = None, limits: Limits | None = None,
                     mode: str = "autonomous", window_s: float = 6.0, warmup_s: float = 70.0, store: Any = None, random_faults: bool = False,
                     overrides: Json | None = None, storage: Any = None, run_id: str | None = None) -> "Stack":
        ov: Json = {"physics": {"faults": {"enabled": random_faults}, "workload": {"wave_amplitude": 0.0 if not random_faults else 0.08}}}
        if overrides:
            ov["physics"]["faults"].update(overrides)
        cfg = load_config(overrides=ov)
        plant = FacilityPlant(seed=seed, config=cfg)
        eng = create_engine(plant=plant, run_id=run_id or f"run_t{seed}", seed=seed, storage=storage or MemoryStorage())
        eng.cfg.safe_automation_mode, eng.cfg.approval_window_s = mode, window_s
        lim = limits or Limits(approval_mode=mode, approval_window_s=window_s)
        rt = AgentRuntimeImpl(intelligence=IntelligenceConfig(api_key=""), model_client=model_client, checkpointer=checkpointer,
                              database_url="", limits=lim, decision_store=store)
        await rt.start(eng.as_actor("agent", "agent"))
        st = cls(eng, rt)
        await st.advance(warmup_s)       # lets the monitor calibrate its healthy reference
        return st

    async def advance(self, sim_s: float, every_s: float = 2.0) -> None:
        n = max(1, int(round(sim_s / every_s)))
        per = max(1, int(round(every_s / self.dt)))
        for _ in range(n):
            await self.eng.step_ticks(per)
            await self.rt.on_tick(self.eng.world(), [])
            await self.rt.settle()

    async def inject(self, kind: str, target: str | None = None, severity: float | None = None) -> Json:
        self.n_cmd += 1
        args: Json = {"kind": kind}
        if target:
            args["target"] = target
        if severity is not None:
            args["severity"] = severity
        return await self.eng.submit({"command_id": f"inj-{self.n_cmd}", "kind": "test.inject_fault", "args": args, "actor_type": "operator"},
                                     principal="test", actor_type="operator")

    def incidents(self) -> list[Json]:
        return sorted(self.eng.track.incidents.values(), key=lambda i: i["id"])

    def tasks(self, inc: str) -> list[Json]:
        return [t for t in self.eng.track.tasks.values() if t["incident_id"] == inc]

    async def run_until(self, cond, max_s: float = 1500, every_s: float = 2.0) -> bool:
        t_end = self.eng.sim_time + max_s
        while self.eng.sim_time < t_end:
            await self.advance(every_s, every_s)
            if cond():
                return True
        return False

    async def stop(self) -> None:
        await self.rt.stop()
