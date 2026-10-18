"""Chaos / soak harness over the in-process REAL stack (physics plant + engine + agent runtime, in-memory or embedded-Postgres stores).

Nothing here is a mock of production logic: the plant, engine, command bus, leases, orchestration graphs, decision service and storage commit path
are the shipped code. Only the *edges* are faulted:

* model provider  -> `FaultyModel` (503 / 429 / timeout / garbage JSON / truncated / wrong-schema / slow / token hog), wrapped around the scripted
                     `FakeModelClient`; reports provider "crusoe" so the real circuit-breaker (ModelStatus half-open) path is exercised.
* database commit -> `install_db_chaos` swaps `storage.commit` for a wrapper that raises `StorageError` (down / flaky / ack-lost-after-apply).
* process         -> `Soak.kill_and_restore`: cancel agent tasks, drop the engine WITHOUT a shutdown snapshot, rebuild from the store's latest snapshot.
* operators       -> manual control leases that are abandoned (deadman), concurrent `test.inject_fault` bursts, pause/resume.

Time: everything is simulated. A virtual wall clock (`VClock`) advances 1:1 with each driver chunk (also while physics is halted by a database
outage) and feeds the engine's lease/deadman clock, the model breaker's cooldown and the fault windows.
"""
from __future__ import annotations

import asyncio
import contextlib
import copy
import hashlib
import json
import math
import os
import random
import sys
import time as _real_time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "tests"), str(ROOT / "tests" / "agents")]

from agent_fakes import FakeModelClient  # noqa: E402
from live_harness import Stack  # noqa: E402
from loopkeeper.engine import create_engine  # noqa: E402
from loopkeeper.engine.core import STREAM_ONLY_KINDS  # noqa: E402
from loopkeeper.intelligence.crusoe import IntelligenceConfig, ModelError, ModelResponse  # noqa: E402
from loopkeeper.orchestration import AgentRuntimeImpl, Limits  # noqa: E402
from loopkeeper.physics import FacilityPlant  # noqa: E402
from loopkeeper.physics.config import load_config  # noqa: E402
from loopkeeper.storage.base import StorageError  # noqa: E402
from loopkeeper.storage.memory import MemoryStorage  # noqa: E402

Json = dict[str, Any]
ARTIFACT_DIR = ROOT.parent / "artifacts" / "soak"

KINDS_RANDOM = ("fouling", "strainer_blockage", "valve_stuck", "pump_degradation", "sensor_drift", "workload_spike")
# V12 hazards (physics/faults.py HAZARD_KINDS_A, physics/hazards.py HAZARD_KINDS): read from the shipped modules so the list can never drift.
try:
    from loopkeeper.physics.faults import HAZARD_KINDS_A
except Exception:                                                     # noqa: BLE001
    HAZARD_KINDS_A = ()
try:
    from loopkeeper.physics.hazards import HAZARD_KINDS as HAZARD_KINDS_B
except Exception:                                                     # noqa: BLE001
    HAZARD_KINDS_B = ()
KINDS_HAZARD = tuple(HAZARD_KINDS_A) + tuple(HAZARD_KINDS_B)
REPAIR_MISSION_KINDS = ("service",)
TERMINAL = ("resolved", "dismissed", "escalated")


# ═══════════════════════════════════════════════════════════════ virtual time
class VClock:
    """Virtual wall clock (seconds). Advanced by the driver once per chunk."""

    def __init__(self, t0: float = 1_000_000.0) -> None:
        self.t = t0

    def __call__(self) -> float:
        return self.t


class _TimeShim:
    """Stands in for the `time` module inside modules whose breaker / latency logic reads the wall clock: monotonic & perf_counter follow the VClock."""

    def __init__(self, clock: VClock) -> None:
        self._c = clock

    def monotonic(self) -> float:
        return self._c.t

    def perf_counter(self) -> float:
        return self._c.t

    def __getattr__(self, name: str) -> Any:
        return getattr(_real_time, name)


@contextlib.contextmanager
def patched_time(clock: VClock):
    from unittest import mock
    import loopkeeper.engine.core as core
    import loopkeeper.intelligence.crusoe as crusoe
    import loopkeeper.intelligence.decisions as decisions
    shim = _TimeShim(clock)
    with mock.patch.object(crusoe, "time", shim), mock.patch.object(decisions, "time", shim), mock.patch.object(core, "COMMIT_RETRY_BASE_S", 0.0):
        yield


# ═══════════════════════════════════════════════════════════════ faulty model
@dataclass
class ModelWindow:
    t0: float
    t1: float
    mode: str            # outage_503 | outage_429 | outage_timeout | garbage | slow | hog | hostile_concur | mixed


GARBAGE = ['```json\n{"summary": "ok", "findings": [', "I cannot help with that request.", "{}", "[]", "null", '{"verdict": "concur"}', "<think>hmm</think> no json here",
           '{"action": "format_disk", "target_id": "../../etc/passwd", "confidence": 9}', "x" * 6000, '{"summary": 12, "followups": "nope"}']


class FaultyModel:
    """Fault-injecting wrapper around a `FakeModelClient`. Faults arrive from (a) explicit windows on the virtual wall clock and (b) background rates."""

    provider = "crusoe"                      # so ModelStatus's half-open recovery (crusoe-only) is exercised

    def __init__(self, clock: VClock, rng: random.Random, *, rates: dict[str, float] | None = None, tokens: tuple[int, int] = (120, 60),
                 hog_tokens: tuple[int, int] = (9000, 4000)) -> None:
        self.inner = FakeModelClient("soak-model", tokens=tokens)
        self.model_id = self.inner.model_id
        self.clock, self.rng = clock, rng
        self.rates = {"503": 0.015, "429": 0.01, "timeout": 0.01, "garbage": 0.02, "slow": 0.03} if rates is None else dict(rates)
        self.windows: list[ModelWindow] = []
        self.hog_tokens = hog_tokens
        self._slow: list[tuple[float, asyncio.Future]] = []
        self.stats: dict[str, int] = {"calls": 0, "ok": 0, "503": 0, "429": 0, "timeout": 0, "garbage": 0, "slow": 0, "hog": 0, "hostile_concur": 0, "probe": 0}
        self.tokens_by_inc: dict[str, int] = {}
        self.tokens_total = 0
        self.max_call_tokens = 0
        self.key_calls: dict[str, int] = {}
        self.resets = 0

    # ---- window helpers
    def mode_at(self) -> str | None:
        t = self.clock.t
        for w in self.windows:
            if w.t0 <= t < w.t1:
                return w.mode
        return None

    def in_outage(self) -> bool:
        return (self.mode_at() or "").startswith("outage")

    async def list_models(self) -> list[str]:
        return [self.model_id]

    async def aclose(self) -> None:                                   # shared across restarts: closing is a no-op
        return None

    def pump(self) -> None:
        """Release slow calls whose virtual deadline passed (driver calls this after advancing the clock)."""
        keep = []
        for due, fut in self._slow:
            if fut.done():
                continue
            if self.clock.t >= due:
                fut.set_result(None)
            else:
                keep.append((due, fut))
        self._slow = keep

    async def complete_json(self, *, system: str, user: str, schema_name: str, max_tokens: int = 700, timeout_s: float | None = None,
                            incident_id: str | None = None, task_id: str | None = None, idem_key: str | None = None, schema: Any = None) -> ModelResponse:
        self.stats["calls"] += 1
        if schema_name == "probe":
            self.stats["probe"] += 1
        if idem_key:
            self.key_calls[idem_key] = self.key_calls.get(idem_key, 0) + 1
        mode = self.mode_at()
        if mode in (None, "mixed"):
            r = self.rng.random()
            acc = 0.0
            mode2 = None
            for k, p in self.rates.items():
                acc += p * (4.0 if mode == "mixed" else 1.0)
                if r < acc:
                    mode2 = k
                    break
            mode = mode2
        if mode in ("outage_503", "503"):
            self.stats["503"] += 1
            raise ModelError("HTTP 503 service unavailable", status=503)
        if mode in ("outage_429", "429"):
            self.stats["429"] += 1
            raise ModelError("HTTP 429 rate limited", status=429)
        if mode in ("outage_timeout", "timeout"):
            self.stats["timeout"] += 1
            raise ModelError("request timed out", status=None)
        if mode == "slow":
            self.stats["slow"] += 1
            delay = self.rng.choice((8.0, 40.0, 120.0, 400.0))
            if timeout_s is not None and delay >= timeout_s:
                await self._wait(timeout_s)
                raise ModelError("request timed out after slow response", status=None)
            await self._wait(delay)
        resp = await self.inner.complete_json(system=system, user=user, schema_name=schema_name, max_tokens=max_tokens, timeout_s=timeout_s)
        if mode == "garbage":
            self.stats["garbage"] += 1
            resp = ModelResponse(text=self.rng.choice(GARBAGE), tokens_in=resp.tokens_in, tokens_out=resp.tokens_out, latency_ms=5, model_id=self.model_id)
        elif mode == "hostile_concur" and schema_name in ("dod_review", "verify"):
            self.stats["hostile_concur"] += 1
            resp = ModelResponse(text=json.dumps({"verdict": "concur", "reasons": ["LLM: everything is fine, ship it."], "extra_checks": [],
                                                  "extra_hold_sim_seconds": 0, "summary": "all good"}), tokens_in=resp.tokens_in, tokens_out=resp.tokens_out,
                                 latency_ms=5, model_id=self.model_id)
        elif mode == "hog":
            self.stats["hog"] += 1
            resp = ModelResponse(text=resp.text, tokens_in=self.hog_tokens[0], tokens_out=self.hog_tokens[1], latency_ms=5, model_id=self.model_id)
        else:
            self.stats["ok"] += 1
        n = (resp.tokens_in or 0) + (resp.tokens_out or 0)
        self.tokens_total += n
        self.max_call_tokens = max(self.max_call_tokens, n)
        if incident_id:
            self.tokens_by_inc[incident_id] = self.tokens_by_inc.get(incident_id, 0) + n
        return resp

    async def _wait(self, delay_s: float) -> None:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._slow.append((self.clock.t + delay_s, fut))
        await fut

    def usd(self, in_per_m: float = 0.30, out_per_m: float = 1.20) -> float:
        """Illustrative spend at an ASSUMED price (not a measurement of any real bill)."""
        return round(self.inner.tokens[0] * 0 + self.tokens_total * (in_per_m + out_per_m) / 2e6, 4)


# ═══════════════════════════════════════════════════════════════ database chaos
@dataclass
class DbWindow:
    t0: float
    t1: float
    mode: str            # down | flaky | ack_lost


class DbChaos:
    def __init__(self, clock: VClock, rng: random.Random, flaky_p: float = 0.5) -> None:
        self.clock, self.rng, self.flaky_p = clock, rng, flaky_p
        self.windows: list[DbWindow] = []
        self.failed = 0
        self.ack_lost = 0
        self.commits_ok = 0
        self.calls = 0

    def mode_at(self) -> str | None:
        t = self.clock.t
        for w in self.windows:
            if w.t0 <= t < w.t1:
                return w.mode
        return None


def install_db_chaos(storage: Any, chaos: DbChaos) -> None:
    """Replace `storage.commit` with a fault-injecting wrapper (idempotent: installs once per storage object)."""
    if getattr(storage, "_soak_chaos", None) is chaos:
        return
    orig = getattr(storage, "_soak_orig_commit", None) or storage.commit
    storage._soak_orig_commit = orig
    storage._soak_chaos = chaos

    def commit(batch: Any) -> None:
        chaos.calls += 1
        mode = chaos.mode_at()
        if mode == "down" or (mode == "flaky" and chaos.rng.random() < chaos.flaky_p):
            chaos.failed += 1
            raise StorageError("injected: database unavailable")
        if mode == "ack_lost":
            orig(batch)
            chaos.ack_lost += 1
            raise StorageError("injected: commit applied but acknowledgement lost")
        orig(batch)
        chaos.commits_ok += 1

    storage.commit = commit


# ═══════════════════════════════════════════════════════════════ violations / ledger
@dataclass
class Violation:
    invariant: str
    detail: str
    sim_t: float
    owner: str = ""

    def to_json(self) -> Json:
        return {"invariant": self.invariant, "detail": self.detail, "sim_t": round(self.sim_t, 1), "owner": self.owner}


# Violations that are already reported to their owner with a minimal reproducer (tests/soak/test_soak_contracts.py, docs/engineering/V12_SOAK_REPORT.md).
# (invariant, regex over the detail, ledger id). A matching violation is listed under `known_violations` and does not fail a scenario, so one known
# defect cannot mask every other invariant; when the owner fixes it the reproducer in test_soak_contracts.py XPASSes and the entry is deleted here.
KNOWN_SIGNATURES: list[tuple[str, str, str]] = []

OWNERS = {"physics_halt": "K", "liveness": "M", "duplicate_repair": "M", "layer_b": "M", "growth": "M", "seq": "K", "spend": "I", "replay": "S",
          "durability": "K", "lease": "K", "unexpected_pause": "K", "exceptions": "M", "determinism": "S"}


def rss_mb() -> float:
    try:
        with open("/proc/self/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024.0
    except OSError:
        pass
    return 0.0


def slope(xs: list[float], ys: list[float]) -> float:
    n = len(xs)
    if n < 3:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs)
    return 0.0 if den == 0 else sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den


# ═══════════════════════════════════════════════════════════════ pure invariant checkers (unit-tested in test_soak_lib.py)
def check_seq_stream(seqs: list[int], last_before: int | None = None) -> list[str]:
    """Published event seq must be strictly consecutive. `last_before` = last seq seen before this list (None = first)."""
    out: list[str] = []
    prev = last_before
    for s in seqs:
        if prev is not None and s != prev + 1:
            out.append(f"seq {prev} -> {s} ({'gap' if s > prev + 1 else 'repeat/backwards'})")
            if len(out) >= 5:
                break
        prev = s
    return out


def check_verified_contract(c: Json) -> list[str]:
    """A VERIFIED terminal state requires Layer A PASS and a *model-reviewed* Layer B concurrence (never the deterministic fallback)."""
    if (c.get("terminal_state") or c.get("state")) != "VERIFIED":
        return []
    ev = c.get("evaluation") or {}
    lb = ev.get("layer_b") or {}
    errs = []
    if ev.get("layer_a") != "PASS":
        errs.append(f"layer_a={ev.get('layer_a')}")
    if lb.get("verdict") != "concur":
        errs.append(f"layer_b.verdict={lb.get('verdict')}")
    if lb.get("source") != "model":
        errs.append(f"layer_b.source={lb.get('source')!r} model_id={lb.get('model_id')!r} (not model-reviewed)")
    return errs


def liveness_sig(inc: Json) -> tuple:
    return (inc.get("status"), inc.get("stage"), len(inc.get("evidence") or []), len(inc.get("task_ids") or []), inc.get("attempts"),
            (inc.get("approval") or {}).get("status"), (inc.get("verification") or {}).get("status"),
            round(float((inc.get("verification") or {}).get("progress") or 0.0), 1))


class LivenessTracker:
    """Independent of the runtime's own guard: flags an open incident whose observable signature has not moved for `limit_s` simulated seconds
    (approval waits are exempt: they are bounded by hold_timeout_s) and one that stays open longer than `max_age_s`."""

    def __init__(self, limit_s: float, max_age_s: float) -> None:
        self.limit_s, self.max_age_s = limit_s, max_age_s
        self.seen: dict[str, tuple[tuple, float]] = {}
        self.opened: dict[str, float] = {}
        self.flagged: set[str] = set()
        self.max_idle_s = 0.0

    def observe(self, incidents: list[Json], now: float) -> list[str]:
        out = []
        for inc in incidents:
            iid = inc["id"]
            self.opened.setdefault(iid, now)
            if inc.get("closed_tick") is not None or inc.get("status") in TERMINAL:
                self.seen.pop(iid, None)
                continue
            sig = liveness_sig(inc)
            prev = self.seen.get(iid)
            if prev is None or prev[0] != sig or (inc.get("approval") or {}).get("status") in ("pending", "held"):
                self.seen[iid] = (sig, now)
                continue
            idle = now - prev[1]
            self.max_idle_s = max(self.max_idle_s, idle)
            if idle > self.limit_s and iid not in self.flagged:
                self.flagged.add(iid)
                out.append(f"{iid} ({inc.get('cause')}/{inc.get('stage')}/{inc.get('status')}) no progress for {idle:.0f} sim-s (limit {self.limit_s:.0f})")
            age = now - self.opened[iid]
            if age > self.max_age_s and (iid + "#age") not in self.flagged:
                self.flagged.add(iid + "#age")
                out.append(f"{iid} ({inc.get('cause')}/{inc.get('stage')}/{inc.get('status')}) open for {age:.0f} sim-s (cap {self.max_age_s:.0f})")
        return out


def check_growth(samples: list[Json], n_incidents: int, ring_size: int, history_len: int) -> list[str]:
    """Structure-size caps. `samples` = list of size dicts (see `sizes()`)."""
    out = []
    if not samples:
        return out
    last = samples[-1]
    peak = {k: max(s.get(k, 0) for s in samples) for k in last}
    if peak["bus_ring"] > ring_size:
        out.append(f"bus ring {peak['bus_ring']} > ring_size {ring_size}")
    if peak["hist_t"] > history_len + 2:
        out.append(f"telemetry history {peak['hist_t']} > history_len {history_len}")
    if peak["hist_series_max"] > history_len + 2:
        out.append(f"telemetry series length {peak['hist_series_max']} > history_len {history_len}")
    if peak["pending_events"] > 60000:
        out.append(f"pending (uncommitted) events {peak['pending_events']}")
    if last["rt_tasks"] > last["open_incidents"] + 1:
        out.append(f"agent tasks {last['rt_tasks']} > open incidents {last['open_incidents']} + 1 (graph tasks not reaped)")
    if last["rt_progress"] > last["open_incidents"] + 2:
        out.append(f"liveness progress map {last['rt_progress']} > open incidents {last['open_incidents']} + 2")
    if last["waiters"] > 4 * max(last["open_incidents"], 1) + 8:
        out.append(f"world waiters {last['waiters']} with {last['open_incidents']} open incidents")
    if last["open_keys"] > last["open_incidents"] + last["escalated_incidents"] + 1:
        out.append(f"open incident keys {last['open_keys']} > open {last['open_incidents']} + escalated {last['escalated_incidents']}")
    per = {"track_tasks": 80, "ledger_tasks": 80, "decision_store": 400, "missions": 25, "applied_effects": 60, "cmd_ledger": 150, "suppress": 60,
           "assignments": 3, "sems": 3, "inc_sem": 3, "budgets": 3}
    for k, lim in per.items():
        if last.get(k, 0) > lim * max(n_incidents, 1) + 40:
            out.append(f"{k} {last[k]} grows faster than {lim}/incident ({n_incidents} incidents)")
    return out


# ═══════════════════════════════════════════════════════════════ the driver
@dataclass
class SoakConfig:
    name: str
    seed: int = 3
    horizon_s: float = 3600.0
    quiesce_s: float = 1950.0
    chunk_s: float = 2.0
    warmup_s: float = 70.0
    plant_faults: bool = True             # the plant's own random arrivals (first_fault_s / mean_gap_s from the facility config)
    first_fault_s: tuple[int, int] = (90, 150)
    mean_gap_s: float = 520.0
    inject_mean_gap_s: float = 0.0        # extra operator-injected faults, any kind (0 = off)
    hazards: bool = False                 # include HAZARD kinds in injected arrivals
    hazard_weight: float = 0.25
    restarts: int = 0                     # random kill/restore points
    graceful_restart_frac: float = 0.34
    model_outages: int = 0
    outage_len_s: tuple[float, float] = (60.0, 420.0)
    model_rates: dict[str, float] | None = None
    model_windows: tuple[str, ...] = ("outage_503", "outage_429", "outage_timeout", "garbage", "slow", "mixed")
    db_windows: int = 0
    db_window_len_s: tuple[float, float] = (10.0, 150.0)
    db_modes: tuple[str, ...] = ("down", "flaky", "ack_lost")
    leases: int = 0
    bursts: int = 0
    burst_size: int = 6
    pauses: int = 0
    token_budget: int = 60000
    hog: bool = False                     # windows of token-hogging responses (spend ceiling)
    storage: str = "memory"               # memory | postgres
    pg_url: str | None = None
    allow_unhandled_hazards: bool = True  # undetected hazard faults are reported as a metric, not a violation
    max_open_age_s: float = 5400.0
    thin_storage: bool = True
    replay_pairs: int = 0                 # >0: after the run, re-execute that many snapshot->snapshot segments from the recorded commands (memory store, no restarts only)


class Soak:
    def __init__(self, cfg: SoakConfig) -> None:
        self.cfg = cfg
        self.rng = random.Random(cfg.seed * 7919 + 17)           # chaos schedule (independent of the plant's RNG)
        self.clock = VClock()
        self.model = FaultyModel(self.clock, random.Random(cfg.seed * 104729 + 3), rates=cfg.model_rates)
        self.chaos = DbChaos(self.clock, random.Random(cfg.seed * 1299709 + 5))
        self.storage: Any = None
        self.saver: Any = None
        self.store: Any = None
        self.run_id = f"soak_{cfg.name}_{cfg.seed}"
        self.st: Stack | None = None
        self.epoch = 0
        self.sub: Any = None
        self.cmd_n = 0
        self.violations: list[Violation] = []
        self.notes: list[str] = []
        self.sched: list[tuple[float, str, Json]] = []
        self.live = LivenessTracker(limit_s=1500.0 + 15.0 + 300.0, max_age_s=cfg.max_open_age_s)
        self.size_samples: list[Json] = []
        self.rss_samples: list[tuple[float, float]] = []
        self.bus_seqs: list[int] = []
        self.bus_kinds: dict[int, str] = {}
        self.last_bus_seq: int | None = None
        self.metrics: dict[str, Any] = {"restarts": 0, "graceful_restarts": 0, "faults_injected": 0, "faults_accepted": 0, "fault_rejections": {}, "faults_by_kind": {},
                                        "model_outage_windows": 0, "db_windows": 0, "leases_taken": 0, "leases_abandoned": 0, "bursts": 0, "burst_cmds": 0,
                                        "db_down_chunks": 0, "chunks": 0, "pauses": 0, "recoveries": []}
        self.pending_leases: list[Json] = []
        self.lease_log: list[Json] = []
        self.expected_pause = False
        self.injected: list[Json] = []                          # {t, kind, accepted, incident_seen}
        self.verified_seen: set[str] = set()
        self.t_start_wall = _real_time.time()
        self.sim0 = 0.0
        self.recoveries: list[Json] = []
        self.stall_since: float | None = None
        self.last_tick = 0
        self.restore_infos: list[Json] = []
        self._stack_cm: Any = None
        self.max_stall_s = 0.0
        self._errs_n = 0
        self.resume_at_wall: float | None = None

    # ───────────────────────────── boot / kill
    def violate(self, inv: str, detail: str) -> None:
        sim_t = self.st.eng.sim_time if self.st else 0.0
        self.violations.append(Violation(inv, detail, sim_t, OWNERS.get(inv.split(":")[0], "")))

    async def boot(self, *, resume: bool) -> None:
        cfg = self.cfg
        ov: Json = {"physics": {"faults": {"enabled": cfg.plant_faults, "first_fault_s": list(cfg.first_fault_s), "mean_gap_s": cfg.mean_gap_s},
                                "workload": {"wave_amplitude": 0.08 if cfg.plant_faults else 0.0}}}
        plant = FacilityPlant(seed=cfg.seed, config=load_config(overrides=ov))
        eng = create_engine(plant=plant, run_id=self.run_id, seed=cfg.seed, storage=self.storage, wall_time=self.clock)
        eng.cfg.safe_automation_mode, eng.cfg.approval_window_s = "autonomous", 6.0
        if eng.recovery_info:
            self.restore_infos.append(dict(eng.recovery_info))
        lim = Limits(approval_mode="autonomous", approval_window_s=6.0, token_budget=cfg.token_budget)
        kw: Json = {}
        if cfg.storage == "postgres":
            rt = AgentRuntimeImpl(intelligence=IntelligenceConfig(api_key=""), model_client=self.model, checkpointer=None, database_url=cfg.pg_url, limits=lim,
                                  decision_store=None)
        else:
            rt = AgentRuntimeImpl(intelligence=IntelligenceConfig(api_key=""), model_client=self.model, checkpointer=self.saver, database_url="", limits=lim,
                                  decision_store=self.store)
        await rt.start(eng.as_actor("agent", "agent"))
        if resume:
            open_inc = eng.track.open_incidents()
            if open_inc:
                await rt.resume(open_inc)
        self.st = Stack(eng, rt)
        self.epoch += 1
        self.sub = eng.subscribe()
        self.last_bus_seq = eng.bus.base_seq if resume else None
        self.last_tick = eng.tick
        self._errs_n = 0
        self.expected_pause = bool(eng.paused)                  # a snapshot taken while an operator pause was active restores paused; we resume it shortly
        self.resume_at_wall = self.clock.t + 20.0 if eng.paused else None
        self.pending_leases = []

    async def start(self) -> None:
        cfg = self.cfg
        if cfg.storage == "postgres":
            from loopkeeper.storage.postgres import PostgresStorage
            self.storage = PostgresStorage(cfg.pg_url)
            self.storage.migrate()
        else:
            from langgraph.checkpoint.memory import InMemorySaver
            from loopkeeper.intelligence.decisions import MemoryDecisionStore
            self.storage = MemoryStorage()
            self.saver = InMemorySaver()
            self.store = MemoryDecisionStore()
        install_db_chaos(self.storage, self.chaos)
        await self.boot(resume=False)
        await self.step(cfg.warmup_s, chaos=False)
        self.sim0 = self.st.eng.sim_time
        self._plan()

    async def kill_and_restore(self, graceful: bool) -> None:
        old = self.st
        assert old is not None
        try:
            has_snap = self.storage.latest_snapshot(self.run_id) is not None
        except Exception:                                       # noqa: BLE001
            has_snap = False
        if not has_snap and not graceful:                       # by design a run without a durable snapshot restarts as a NEW run id (see create_engine); not a soak case
            self.metrics["restarts_skipped_no_snapshot"] = self.metrics.get("restarts_skipped_no_snapshot", 0) + 1
            self.sched.append((old.eng.sim_time + 90.0, "restart", {"graceful": graceful}))
            self.sched.sort(key=lambda x: x[0])
            return
        eng, rt = old.eng, old.rt
        pre_seq, pre_tick, pre_inc = eng.seq, eng.tick, {i["id"]: i["status"] for i in eng.track.open_incidents()}
        self.drain_bus()
        if self.sub is not None:
            self.sub.close()
        if graceful:                                            # SIGTERM path: shutdown snapshot + final commit
            await rt.stop()
            async with eng._lock:
                if not eng.fenced and not eng.db_down:
                    eng.take_snapshot("shutdown")
                with contextlib.suppress(Exception):
                    await eng.commit()
            self.metrics["graceful_restarts"] += 1
        else:                                                   # SIGKILL: tasks vanish, uncommitted events and the unsnapshotted tail are lost
            for t in list(rt._tasks.values()):
                t.cancel()
            await asyncio.gather(*rt._tasks.values(), return_exceptions=True)
            with contextlib.suppress(Exception):
                await rt._stack.aclose()
        self.metrics["restarts"] += 1
        await self.boot(resume=True)
        info = self.restore_infos[-1] if self.restore_infos else {}
        self.recoveries.append({"at_tick": pre_tick, "graceful": graceful, "restored": info.get("restored"), "lost_ticks": info.get("lost_ticks"),
                                "open_incidents_before": len(pre_inc), "open_after": len(self.st.eng.track.open_incidents())})
        if self.st.eng.run_id != self.run_id:
            self.violate("durability", f"restart resumed under a different run id {self.st.eng.run_id!r} although a snapshot existed: {info}")
        elif not info.get("restored"):
            self.violate("durability", f"restart did not restore from a snapshot: {info}")

    # ───────────────────────────── schedule
    def _plan(self) -> None:
        cfg, rng = self.cfg, self.rng
        t0 = self.st.eng.sim_time + 40.0
        span = max(cfg.horizon_s - 120.0, 60.0)
        t_end = t0 + span

        def at() -> float:
            return rng.uniform(t0, t_end)

        if cfg.inject_mean_gap_s > 0:
            t = t0 + rng.expovariate(1.0 / cfg.inject_mean_gap_s)
            while t < t_end:
                self.sched.append((t, "inject", {}))
                t += max(30.0, rng.expovariate(1.0 / cfg.inject_mean_gap_s))
        for _ in range(cfg.restarts):
            self.sched.append((at(), "restart", {"graceful": rng.random() < cfg.graceful_restart_frac}))
        for _ in range(cfg.model_outages):
            a = at()
            self.sched.append((a, "model_window", {"mode": rng.choice(cfg.model_windows), "len": rng.uniform(*cfg.outage_len_s)}))
        if cfg.hog:
            for _ in range(2):
                self.sched.append((at(), "model_window", {"mode": "hog", "len": rng.uniform(120, 480)}))
        for _ in range(cfg.db_windows):
            self.sched.append((at(), "db_window", {"mode": rng.choice(cfg.db_modes), "len": rng.uniform(*cfg.db_window_len_s)}))
        for _ in range(cfg.leases):
            style = rng.choice(("abandon", "abandon", "hb_then_abandon", "release", "drive_then_abandon", "hold", "hold"))
            self.sched.append((at(), "lease", {"style": style, "pick": rng.random(),
                                               "hb_n": int(rng.choice((30, 100, 250))) if style == "hold" else rng.randint(1, 4)}))
        for _ in range(cfg.bursts):
            self.sched.append((at(), "burst", {"n": cfg.burst_size}))
        for _ in range(cfg.pauses):
            self.sched.append((at(), "pause", {"len": rng.uniform(6, 60)}))
        self.sched.sort(key=lambda x: x[0])

    # ───────────────────────────── chaos actions
    def _kind(self) -> str:
        if self.cfg.hazards and KINDS_HAZARD and self.rng.random() < self.cfg.hazard_weight:
            return self.rng.choice(KINDS_HAZARD)
        return self.rng.choice(KINDS_RANDOM)

    async def inject(self, kind: str | None = None, *, cid: str | None = None, target: str | None = None) -> Json:
        assert self.st is not None
        kind = kind or self._kind()
        self.cmd_n += 1
        args: Json = {"kind": kind}
        if target:
            args["target"] = target
        ack = await self.st.eng.submit({"command_id": cid or f"soak-inj-{self.cmd_n}", "kind": "test.inject_fault", "args": args, "actor_type": "operator"},
                                       principal="soak", actor_type="operator")
        m = self.metrics
        m["faults_injected"] += 1
        if ack.get("accepted"):
            m["faults_accepted"] += 1
            m["faults_by_kind"][kind] = m["faults_by_kind"].get(kind, 0) + 1
            self.injected.append({"t": self.st.eng.sim_time, "kind": kind, "tick": self.st.eng.tick})
        else:
            key = f"{kind}: {str(ack.get('reason'))[:70]}"
            m["fault_rejections"][key] = m["fault_rejections"].get(key, 0) + 1
        return ack

    async def do_action(self, kind: str, a: Json) -> None:
        assert self.st is not None
        eng = self.st.eng
        now = self.clock.t
        if kind == "inject":
            await self.inject()
        elif kind == "restart":
            await self.kill_and_restore(a["graceful"])
        elif kind == "model_window":
            self.model.windows.append(ModelWindow(now, now + a["len"], a["mode"]))
            self.metrics["model_outage_windows"] += 1
        elif kind == "db_window":
            self.chaos.windows.append(DbWindow(now, now + a["len"], a["mode"]))
            self.metrics["db_windows"] += 1
        elif kind == "lease":
            await self._lease(a)
        elif kind == "burst":
            await self._burst(a["n"])
        elif kind == "pause":
            self.cmd_n += 1
            ack = await eng.submit({"command_id": f"soak-pause-{self.cmd_n}", "kind": "pause", "actor_type": "operator"}, principal="soak", actor_type="operator")
            if ack.get("accepted"):
                self.expected_pause = True
                self.metrics["pauses"] += 1
                self.resume_at_wall = now + a["len"]

    async def _lease(self, a: Json) -> None:
        eng = self.st.eng
        cands = sorted(r for r, x in eng.robots.items() if x.klass in ("inpipe", "outrig") and eng.control.state_of(r) == "AUTONOMOUS")
        if not cands:
            return
        busy = [r for r in cands if eng.missions.active_mission(r) is not None]
        pool = busy if (busy and a["pick"] < 0.5) else cands          # half the time grab a robot that is mid-mission
        rid = pool[int(a["pick"] * 1e6) % len(pool)]
        self.cmd_n += 1
        principal = f"op-{self.cmd_n}"
        ack = await eng.submit({"command_id": f"soak-acq-{self.cmd_n}", "kind": "control.acquire", "args": {"robot_id": rid}, "actor_type": "operator"},
                               principal=principal, actor_type="operator")
        if not ack.get("accepted"):
            return
        self.metrics["leases_taken"] += 1
        self.pending_leases.append({"lease_id": ack["lease_id"], "robot": rid, "principal": principal, "style": a["style"], "hb_left": 0 if a["style"] == "abandon" else a["hb_n"],
                                    "t_taken": self.clock.t, "last_hb": self.clock.t, "seq": 0, "mid_mission": rid in busy})

    async def _lease_tick(self) -> None:
        eng = self.st.eng
        for L in list(self.pending_leases):
            lease = eng.control.leases.get(L["lease_id"])
            if lease is None or lease["status"] not in ("pending", "active"):
                self.pending_leases.remove(L)
                self.lease_log.append({**L, "ended": (lease or {}).get("ended_reason"), "t_end": self.clock.t, "held_s": self.clock.t - L["t_taken"]})
                continue
            style = L["style"]
            if style == "release":
                await eng.submit({"command_id": f"soak-rel-{L['lease_id']}", "kind": "control.release", "args": {"lease_id": L["lease_id"]}, "actor_type": "operator"},
                                 principal=L["principal"], actor_type="operator")
                continue
            if style in ("hb_then_abandon", "drive_then_abandon", "hold") and L["hb_left"] > 0:
                if style == "drive_then_abandon" and eng.control.state_of(L["robot"]) == "MANUAL":
                    L["seq"] += 1
                    await eng.submit({"command_id": f"soak-drive-{L['lease_id']}-{L['seq']}", "kind": "control.drive",
                                      "args": {"lease_id": L["lease_id"], "command_seq": L["seq"], "topology_revision": str(eng.topology_revision), "throttle": 0.5,
                                               "steer": 0.0, "duration_ms": 200.0}, "actor_type": "operator"}, principal=L["principal"], actor_type="operator")
                else:
                    await eng.submit({"command_id": f"soak-hb-{L['lease_id']}-{L['hb_left']}", "kind": "control.heartbeat", "args": {"lease_id": L["lease_id"]},
                                      "actor_type": "operator"}, principal=L["principal"], actor_type="operator")
                L["hb_left"] -= 1
                L["last_hb"] = self.clock.t
            if style in ("abandon", "hb_then_abandon", "drive_then_abandon", "hold") and L["hb_left"] <= 0 and not L.get("abandoned"):
                L["abandoned"] = True
                L["t_abandon"] = self.clock.t
                self.metrics["leases_abandoned"] += 1

    async def _burst(self, n: int) -> None:
        """N concurrent operator requests racing the tick loop: injections (some re-using a command id), set_load, speed, resume."""
        eng = self.st.eng
        self.metrics["bursts"] += 1
        cmds = []
        dup_id = f"soak-dup-{self.cmd_n}"
        for i in range(n):
            self.cmd_n += 1
            k = self.rng.random()
            if k < 0.55:
                kind = self.rng.choice(KINDS_RANDOM + (KINDS_HAZARD if self.cfg.hazards else ()))
                cid = dup_id if i % 3 == 0 else f"soak-b{self.cmd_n}"
                cmds.append({"command_id": cid, "kind": "test.inject_fault", "args": {"kind": kind}, "actor_type": "operator"})
            elif k < 0.75:
                cmds.append({"command_id": f"soak-b{self.cmd_n}", "kind": "workload.set_load", "target_id": self.rng.choice(("rack_a1", "rack_a2", "rack_b1", "rack_b2")),
                             "args": {"load_factor": self.rng.uniform(0.5, 1.1)}, "actor_type": "operator"})
            elif k < 0.9:
                cmds.append({"command_id": f"soak-b{self.cmd_n}", "kind": "set_sim_speed", "args": {"speed": 6.0}, "actor_type": "operator"})
            else:
                cmds.append({"command_id": f"soak-b{self.cmd_n}", "kind": "resume", "actor_type": "operator"})
        self.metrics["burst_cmds"] += len(cmds)
        stepper = asyncio.ensure_future(eng.step_ticks(2 if not eng.db_down else 0))
        acks = await asyncio.gather(*[eng.submit(c, principal=f"burst-{j % 3}", actor_type="operator") for j, c in enumerate(cmds)], stepper, return_exceptions=True)
        by_id: dict[str, list[Json]] = {}
        for c, a in zip(cmds, acks[:-1]):
            if isinstance(a, BaseException):
                self.violate("exceptions", f"concurrent submit raised {type(a).__name__}: {a}")
                continue
            by_id.setdefault(c["command_id"], []).append(a)
            if a.get("accepted") and c["kind"] == "test.inject_fault":
                self.metrics["faults_accepted"] += 1
                self.metrics["faults_injected"] += 1
                self.injected.append({"t": eng.sim_time, "kind": c["args"]["kind"], "tick": eng.tick})
        for cid, lst in by_id.items():
            acc = [x for x in lst if x.get("accepted") and not x.get("duplicate")]
            if len(acc) > 1:
                self.violate("durability", f"command {cid} was applied {len(acc)} times by concurrent submits (idempotency broken)")
        if isinstance(acks[-1], BaseException):
            self.violate("exceptions", f"step_ticks raised during a command burst: {type(acks[-1]).__name__}: {acks[-1]}")

    # ───────────────────────────── stepping (emulates Engine._run + the agent cadence)
    def drain_bus(self) -> None:
        if self.sub is None:
            return
        got: list[int] = []
        while True:
            e = self.sub.get_nowait()
            if e is None:
                break
            got.append(e["seq"])
            self.bus_kinds[e["seq"]] = e["type"]
        if self.sub.overflowed:
            self.violate("seq", "event subscription overflowed (consumer drained every chunk)")
        for msg in check_seq_stream(got, self.last_bus_seq):
            self.violate("seq", f"epoch {self.epoch}: {msg}")
        if got:
            self.last_bus_seq = got[-1]
            self.bus_seqs.extend(got)

    async def _chunk(self, chunk_s: float, chaos: bool) -> None:
        st = self.st
        eng, rt = st.eng, st.rt
        for _ in range(2):                                       # two half-chunks: operators heartbeat every 1 s (< deadman_s) while the plant steps once per chunk
            self.clock.t += chunk_s / 2.0
            self.model.pump()
            async with eng._lock:
                eng._wall_monitor()
            await self._lease_tick()
        per = max(1, int(round(chunk_s / eng.dt)))
        t_before, tick_before = eng.sim_time, eng.tick
        was_down = eng.db_down
        if eng.db_down or eng.fenced or eng.paused:
            with contextlib.suppress(Exception):
                await eng.commit()                               # the loop's per-iteration commit (also the probe while storage is down); no physics ticks
        else:
            await eng.step_ticks(per)
        if eng.db_down:
            self.metrics["db_down_chunks"] += 1
            if self.stall_since is None:
                self.stall_since = self.clock.t
        elif self.stall_since is not None:
            stall = self.clock.t - self.stall_since
            self.max_stall_s = max(self.max_stall_s, stall)
            self.recoveries.append({"kind": "db", "stalled_s": round(stall, 1), "tick_resumed": eng.tick})
            self.stall_since = None
        await rt.on_tick(eng.world(), [])
        await rt.settle()
        self.metrics["chunks"] += 1
        self._observe(tick_before, per, was_down)

    def _observe(self, tick_before: int, per: int, was_down: bool) -> None:
        eng, rt = self.st.eng, self.st.rt
        self.drain_bus()
        if eng.tick > tick_before:
            if eng.tick - tick_before != per:
                self.violate("physics_halt", f"ticked {eng.tick - tick_before} of {per} requested at tick {tick_before} (physics_err={eng.physics_err})")
        if eng.physics_err:
            self.violate("physics_halt", f"plant.step failing: {eng.physics_err}")
        if eng.paused and not self.expected_pause:
            self.violate("unexpected_pause", f"engine paused without an operator pause at tick {eng.tick} (db_down={eng.db_down} physics_err={eng.physics_err})")
            eng.clock.resume()
        if eng.fenced:
            self.violate("physics_halt", "engine fenced (single-process soak: nothing else owns the lease)")
        k = eng.kpis()
        for key in ("min_margin_k", "total_heat_kw", "tcs_flow_kg_s"):
            v = k.get(key)
            if not isinstance(v, (int, float)) or not math.isfinite(v):
                self.violate("physics_halt", f"kpi {key} not finite: {v!r}")
        incs = [i for i in eng.track.incidents.values()]
        for msg in self.live.observe(incs, eng.sim_time):
            self.violate("liveness", msg)
        for cid, c in eng.track.contracts.items():
            if c.get("terminal_state") == "VERIFIED" and cid not in self.verified_seen:
                self.verified_seen.add(cid)
                for e in check_verified_contract(c):
                    self.violate("layer_b", f"{cid} VERIFIED but {e}")
        if len(rt.errors) > self._errs_n:
            for e in rt.errors[self._errs_n:]:
                inc = eng.track.incidents.get(e.split(":")[0]) or {}
                self.violate("exceptions", f"agent graph crashed: {e} (cause={inc.get('cause')!r} anchor={(inc.get('anchor') or {}).get('entity_id')!r} title={str(inc.get('title'))[:60]!r})")
            self._errs_n = len(rt.errors)
        if self.metrics["chunks"] % 30 == 0:
            self.thin_storage()
        if self.metrics["chunks"] % 15 == 0:
            self.size_samples.append(self.sizes())
            self.rss_samples.append((eng.sim_time, rss_mb()))

    def thin_storage(self) -> None:
        """Models Postgres retention (storage/maintenance.py thins snapshots / samples) for the in-memory twin, so RSS measures the PROCESS, not an
        ever-growing fake database. The latest 400 snapshots are kept (restore needs only the newest; the replay check walks consecutive pairs); events and the command ledger are never thinned."""
        s = self.storage
        if not isinstance(s, MemoryStorage) or not self.cfg.thin_storage:
            return
        snaps = s.snapshots.get(self.run_id)
        if snaps and len(snaps) > 400:
            for sid in [k for k, _ in sorted(snaps.items(), key=lambda kv: kv[1]["tick"])][:-400]:
                del snaps[sid]
        smp = s.samples.get(self.run_id)
        if smp is not None and len(smp) > 3000:
            del smp[:-3000]

    def sizes(self) -> Json:
        e, r = self.st.eng, self.st.rt
        c = r.ctx
        inc = list(e.track.incidents.values())
        open_n = sum(1 for i in inc if i.get("closed_tick") is None and i.get("status") not in TERMINAL)
        esc_n = sum(1 for i in inc if i.get("status") == "escalated" and i["id"] in c.open_keys.values())
        stor_ev = len(getattr(self.storage, "events", {}).get(self.run_id, {})) if hasattr(self.storage, "events") else 0
        return {"sim_t": round(e.sim_time, 1), "bus_ring": len(e.bus.ring), "pending_events": len(e.pending_events), "pending_snaps": len(e.pending_snaps),
                "pending_samples": len(e.pending_samples), "cmd_ledger": len(e.commands.ledger), "cmd_dirty": len(e.commands.dirty),
                "track_incidents": len(e.track.incidents), "track_tasks": len(e.track.tasks), "track_verifs": len(e.track.verifications),
                "track_contracts": len(e.track.contracts), "hist_t": len(e.hist_t), "hist_series_max": max((len(v) for v in e.hist.values()), default=0),
                "rt_tasks": len(r._tasks), "rt_progress": len(r._progress), "open_keys": len(c.open_keys), "open_incidents": open_n, "escalated_incidents": esc_n,
                "ledger_incidents": len(c.ledger.incidents), "ledger_tasks": len(c.ledger.tasks), "waiters": len(c._waiters), "budgets": len(c.decisions._budgets),
                "inc_sem": len(c.decisions._inc_sem), "sems": len(c._sems), "suppress": len(c.suppress), "assignments": len(c.assignments),
                "missions": len(e.missions.missions), "applied_effects": len(e.missions.applied_effects), "history": len(c.history.buf),
                "decision_store": len(getattr(c.decisions.store, "d", None) or getattr(c.decisions.store, "_d", None) or {}), "store_events": stor_ev,
                "rss_mb": round(rss_mb(), 1)}

    async def step(self, sim_s: float, chaos: bool = True) -> None:
        eng = self.st.eng
        t_end = eng.sim_time + sim_s
        guard = 0
        while eng.sim_time < t_end - 1e-9:
            await self._tick_actions()
            await self._chunk(self.cfg.chunk_s, chaos)
            eng = self.st.eng                                   # a restart replaces the engine
            guard += 1
            if guard > int(sim_s / self.cfg.chunk_s) * 40 + 4000:
                self.violate("physics_halt", f"sim time did not reach target after {guard} chunks (stuck at {eng.sim_time:.0f}/{t_end:.0f})")
                break

    async def _tick_actions(self) -> None:
        eng = self.st.eng
        if self.resume_at_wall is not None and self.clock.t >= self.resume_at_wall:
            self.cmd_n += 1
            ack = await eng.submit({"command_id": f"soak-resume-{self.cmd_n}", "kind": "resume", "actor_type": "operator"}, principal="soak", actor_type="operator")
            if ack.get("accepted"):
                self.expected_pause = False
                self.resume_at_wall = None
        while self.sched and self.sched[0][0] <= eng.sim_time:
            t, kind, a = self.sched.pop(0)
            await self.do_action(kind, a)
            eng = self.st.eng

    # ───────────────────────────── run + final checks
    async def run(self) -> Json:
        cfg = self.cfg
        await self.start()
        wall0 = _real_time.time()
        await self.step(cfg.horizon_s)
        # quiesce: stop new arrivals, let every window close, then everything must come to rest
        self.sched.clear()
        eng = self.st.eng
        eng.plant.fault_mgr.enabled = False
        self.model.windows.clear()
        self.chaos.windows.clear()
        self.model.rates = {}
        self.resume_at_wall = self.clock.t
        await self.step(cfg.quiesce_s, chaos=False)
        await self.finalize()
        self.metrics["wall_s"] = round(_real_time.time() - wall0, 1)
        return self.result()

    async def finalize(self) -> None:
        st = self.st
        eng, rt = st.eng, st.rt
        for _ in range(3):
            await eng.commit()
        self.drain_bus()
        # 1) physics never halted permanently
        t0 = eng.tick
        await st.advance(10.0, 2.0)
        if eng.tick <= t0:
            self.violate("physics_halt", f"no tick progress after quiesce (db_down={eng.db_down} paused={eng.paused} fenced={eng.fenced} err={eng.physics_err})")
        if eng.db_down or eng.paused:
            self.violate("physics_halt", f"after all faults cleared: db_down={eng.db_down} paused={eng.paused}")
        # 2) no incident stuck: all terminal after the quiesce window
        stuck = [i for i in eng.track.incidents.values() if i.get("closed_tick") is None and i.get("status") not in TERMINAL]
        for i in stuck:
            self.violate("liveness", f"{i['id']} ({i.get('cause')}/{i.get('stage')}/{i.get('status')}) still open {self.cfg.quiesce_s:.0f}s after the last fault cleared")
        # 3) leases: none left active, every robot back under autonomous control
        for rid in eng.robots:
            if eng.control.state_of(rid) != "AUTONOMOUS":
                self.violate("lease", f"{rid} left in control state {eng.control.state_of(rid)} after all leases ended")
        live = eng.control.active_lease_ids()
        if live:
            self.violate("lease", f"leases still active at the end: {live[:3]}")
        for L in self.lease_log:
            if L.get("t_abandon") is not None and L.get("ended") not in ("deadman_timeout", "lease_expired", "operator_release", "client_disconnect"):
                self.violate("lease", f"abandoned lease on {L['robot']} ended with reason {L.get('ended')!r}")
            budget = eng.cfg.deadman_s + 2 * self.cfg.chunk_s + 1
            if L.get("t_abandon") is not None and L["t_end"] - L["last_hb"] > budget + 2 * self.cfg.chunk_s:
                self.violate("lease", f"abandoned lease on {L['robot']} stayed live {L['t_end'] - L['last_hb']:.1f}s past its last heartbeat (deadman {eng.cfg.deadman_s}s)")
        # 4) durability + seq: every published non-stream event is stored; stored seqs unique/increasing
        self._check_storage()
        # 5) duplicate repairs in the surviving timeline
        self._check_duplicate_repairs()
        # 6) growth
        n_inc = len(eng.track.incidents)
        self.size_samples.append(self.sizes())
        for msg in check_growth(self.size_samples, n_inc, eng.cfg.ring_size, eng.cfg.history_len):
            self.violate("growth", msg)
        self._check_rss()
        # 7) spend
        self._check_spend()
        # 8) undetected faults (metric only unless configured)
        self._check_detection()
        # 9) replay of recorded segments is hash-identical
        if self.cfg.replay_pairs and isinstance(self.storage, MemoryStorage):
            await self._check_replay_segments()

    def _stored_events(self) -> list[Json]:
        s = self.storage
        if hasattr(s, "events") and isinstance(getattr(s, "events", None), dict):
            return sorted(s.events.get(self.run_id, {}).values(), key=lambda e: e["seq"])
        out: list[Json] = []
        after = 0
        while True:
            rows = s.load_events(self.run_id, after_seq=after, until_seq=10 ** 9, limit=5000)
            if not rows:
                break
            out.extend(rows)
            after = rows[-1]["seq"]
        return out

    def _check_storage(self) -> None:
        ev = self._stored_events()
        seqs = [e["seq"] for e in ev]
        if len(seqs) != len(set(seqs)):
            self.violate("seq", "duplicate seq in the stored event log")
        stored = set(seqs)
        missing = [s for s in self.bus_seqs if self.bus_kinds.get(s) not in STREAM_ONLY_KINDS and not str(self.bus_kinds.get(s, "")).startswith("comm.") and s not in stored]
        if missing:
            self.violate("durability", f"{len(missing)} published event(s) not in the store (e.g. seq {missing[:5]}, kinds {sorted({self.bus_kinds.get(s) for s in missing[:20]})})")
        self.metrics["events_published"] = len(self.bus_seqs)
        self.metrics["events_stored"] = len(seqs)
        self.stored_events = ev

    def _check_duplicate_repairs(self) -> None:
        ev = getattr(self, "stored_events", [])
        abandoned: list[tuple[int, int]] = []
        for info in self.restore_infos:
            if info.get("restored"):
                abandoned.append((int(info["snapshot_seq"]), int(info["continued_seq"])))
        def dead(seq: int) -> bool:
            return any(a < seq <= b for a, b in abandoned)
        seen: dict[str, int] = {}
        per_target: dict[tuple[str, str], int] = {}
        for e in ev:
            if e["kind"] != "repair.completed" or dead(e["seq"]):
                continue
            pl = e["payload"]
            ek = pl.get("effect_key")
            if (pl.get("effects") or {}).get("duplicate"):
                continue
            seen[ek] = seen.get(ek, 0) + 1
            mid = str(e.get("entity_id"))
            parts = mid.split("_")
            inc = f"INC-{parts[1]}" if len(parts) > 1 else mid
            tgt = pl.get("target_id") or pl.get("target") or mid
            per_target[(inc, str(tgt))] = per_target.get((inc, str(tgt)), 0) + 1
        for ek, n in seen.items():
            if n > 1:
                self.violate("duplicate_repair", f"effect {ek} applied {n} times in the surviving timeline")
        lim = 1 + 2 + 1
        for (inc, tgt), n in per_target.items():
            if n > lim:
                self.violate("duplicate_repair", f"{inc} repaired {tgt} {n} times (> max_replans+2)")
        self.metrics["repairs_completed"] = sum(per_target.values())

    async def _check_replay_segments(self) -> None:
        """Restore snapshot A into a FRESH engine, re-apply the recorded accepted commands (by apply_order, at their recorded ticks) and step to snapshot B:
        plant / robots / missions must hash identically to what B recorded. Only meaningful for the surviving timeline, so it is skipped after restarts."""
        import zlib

        from loopkeeper.engine.util import chash
        if self.metrics["restarts"]:
            self.notes.append("replay segments skipped: run contains restarts (abandoned timelines share the store)")
            return
        snaps = sorted(self.storage.snapshots.get(self.run_id, {}).values(), key=lambda r: (r["tick"], r["last_seq"]))
        snaps = [x for i, x in enumerate(snaps) if i == 0 or x["tick"] > snaps[i - 1]["tick"]]
        pairs = [(a, b) for a, b in zip(snaps, snaps[1:]) if b["tick"] - a["tick"] >= 20]
        if not pairs:
            return
        chosen = pairs[:: max(1, len(pairs) // self.cfg.replay_pairs)][: self.cfg.replay_pairs]
        ledger = sorted((c for c in self.storage.commands.get(self.run_id, {}).values() if c.get("status") == "accepted" and c.get("apply_order")),
                        key=lambda c: c["apply_order"])
        ok = bad = 0
        for a, b in chosen:
            da, db = json.loads(zlib.decompress(a["state"])), json.loads(zlib.decompress(b["state"]))
            ov = {"physics": {"faults": {"enabled": self.cfg.plant_faults, "first_fault_s": list(self.cfg.first_fault_s), "mean_gap_s": self.cfg.mean_gap_s},
                              "workload": {"wave_amplitude": 0.08 if self.cfg.plant_faults else 0.0}}}
            e2 = create_engine(plant=FacilityPlant(seed=self.cfg.seed, config=load_config(overrides=ov)), run_id=f"replay_{a['tick']}", seed=self.cfg.seed,
                               storage=MemoryStorage(), wall_time=VClock())
            e2.load_state_doc(da)
            cmds = [c for c in ledger if da["apply_order"] < c["apply_order"] <= db["apply_order"]]
            for c in cmds:
                if c["applied_tick"] > e2.tick:
                    await e2.step_ticks(c["applied_tick"] - e2.tick, commit=False)
                raw = {"command_id": c["command_id"], "kind": c["kind"], "target_id": c.get("target_id"), "args": c.get("args") or {},
                       "actor_type": c.get("actor_type"), "issuer": c.get("issuer")}
                internal = str(c["kind"]).startswith("internal.")
                e2.commands.process(raw, actor_default=None if internal else c.get("actor_type"), internal=internal)
            if db["tick"] > e2.tick:
                await e2.step_ticks(db["tick"] - e2.tick, commit=False)
            got = {"plant": e2.plant.state_hash(), "robots": chash({k: r.to_state() for k, r in e2.robots.items()}), "missions": chash(e2.missions.to_state())}
            want = {"plant": db["plant_hash"], "robots": chash(db["robots"]), "missions": chash(db["missions"])}
            diff = [k for k in got if got[k] != want[k]]
            if e2.tick != db["tick"]:
                diff.append(f"tick {e2.tick}!={db['tick']}")
            if diff:
                bad += 1
                self.violate("replay", f"segment tick {a['tick']}->{b['tick']} ({len(cmds)} commands) diverged in {diff}")
            else:
                ok += 1
        self.metrics["replay_segments_ok"], self.metrics["replay_segments_bad"] = ok, bad

    def _check_rss(self) -> None:
        pts = [(t, r) for t, r in self.rss_samples if r > 0]
        if len(pts) < 8:
            return
        n = len(pts)
        base = pts[n // 3:]                                      # ignore warm-up growth (imports, solver caches)
        xs = [t / 3600.0 for t, _ in base]
        ys = [r for _, r in base]
        sl = slope(xs, ys)
        self.metrics["rss_mb_start"], self.metrics["rss_mb_end"] = round(pts[0][1], 1), round(pts[-1][1], 1)
        self.metrics["rss_slope_mb_per_sim_hour"] = round(sl, 1)
        if sl > 120.0 and ys[-1] > ys[0] * 1.25:
            self.violate("growth", f"RSS grows {sl:.0f} MB per simulated hour after warm-up ({ys[0]:.0f} -> {ys[-1]:.0f} MB)")

    def _check_spend(self) -> None:
        rt = self.st.rt
        c = rt.ctx
        lim = self.cfg.token_budget
        slack = 2 * self.model.max_call_tokens + 1
        for iid, b in c.decisions._budgets.items():
            if b.used > lim + slack:
                self.violate("spend", f"{iid} used {b.used} tokens > budget {lim} (+{slack} one-call slack)")
        n_inc = len(self.st.eng.track.incidents)
        cap = (n_inc + 1) * (lim + slack) + 20000
        if self.model.tokens_total > cap:
            self.violate("spend", f"run used {self.model.tokens_total} tokens > {n_inc} incidents x budget {lim} (+probes)")
        for iid, used in self.model.tokens_by_inc.items():
            if used > lim * 2 + slack:                           # restarts reset the in-memory counter only through frozen decisions; > 2x is a leak
                self.violate("spend", f"{iid}: the provider saw {used} tokens for one incident (budget {lim}); the budget does not survive restarts / leaks across retries")
        self.metrics["tokens_total"] = self.model.tokens_total
        self.metrics["usd_assumed"] = self.model.usd()

    def _check_detection(self) -> None:
        eng = self.st.eng
        incs = sorted(eng.track.incidents.values(), key=lambda i: i["opened_tick"])
        det = 0
        for f in self.injected:
            if f["kind"] in KINDS_HAZARD:
                if any(i["opened_tick"] >= f["tick"] for i in incs):
                    det += 1
        self.metrics["hazard_faults_accepted"] = sum(1 for f in self.injected if f["kind"] in KINDS_HAZARD)
        self.metrics["hazard_faults_followed_by_incident"] = det

    def result(self) -> Json:
        eng = self.st.eng
        incs = list(eng.track.incidents.values())
        by_status: dict[str, int] = {}
        for i in incs:
            by_status[i["status"]] = by_status.get(i["status"], 0) + 1
        terminal: dict[str, int] = {}
        for c in eng.track.contracts.values():
            k = c.get("terminal_state") or c.get("state") or "?"
            terminal[k] = terminal.get(k, 0) + 1
        peak = {k: max(s.get(k, 0) for s in self.size_samples) for k in self.size_samples[-1] if isinstance(self.size_samples[-1][k], (int, float))} if self.size_samples else {}
        return {"scenario": self.cfg.name, "seed": self.cfg.seed, "storage": self.cfg.storage, "sim_seconds": round(eng.sim_time - self.sim0, 0),
                "sim_hours": round((eng.sim_time - self.sim0) / 3600.0, 2), "horizon_s": self.cfg.horizon_s, "quiesce_s": self.cfg.quiesce_s,
                "metrics": self.metrics, "incidents": {"total": len(incs), "by_status": by_status, "contract_terminal": terminal},
                "model": {k: v for k, v in self.model.stats.items()}, "model_tokens": self.model.tokens_total, "db": {"failed": self.chaos.failed, "ack_lost": self.chaos.ack_lost,
                                                                                                                       "commits_ok": self.chaos.commits_ok},
                "recoveries": self.recoveries, "leases": {"taken": self.metrics["leases_taken"], "ended": [
                    {"robot": L["robot"], "style": L["style"], "held_s": round(L["held_s"], 1), "ended": L["ended"], "mid_mission": L["mid_mission"]} for L in self.lease_log]},
                "peak_sizes": peak, "max_idle_sim_s": round(self.live.max_idle_s, 1), "max_db_stall_s": round(self.max_stall_s, 1),
                "violations": [v.to_json() for v in self.violations if not self._known(v)], "violation_count": sum(1 for v in self.violations if not self._known(v)),
                "known_violations": [{**v.to_json(), "ledger": self._known(v)} for v in self.violations if self._known(v)],
                "rss_series": [(round(t), round(r)) for t, r in self.rss_samples[:: max(1, len(self.rss_samples) // 40)]],
                "final_state_hash": eng.state_hash(), "event_chain_hash": self.event_chain_hash(), "last_seq": eng.seq, "tick": eng.tick}

    @staticmethod
    def _known(v: "Violation") -> str:
        import re
        for inv, rx, ledger in KNOWN_SIGNATURES:
            if v.invariant == inv and re.search(rx, v.detail):
                return ledger
        return ""

    def event_chain_hash(self) -> str:
        h = hashlib.sha256()
        for e in getattr(self, "stored_events", []):
            if e["kind"] in STREAM_ONLY_KINDS or e["kind"].startswith("comm."):
                continue
            h.update(f"{e['seq']}|{e['kind']}|{e['entity_id']}|{e['tick']}|{e.get('event_hash')}".encode())
        return h.hexdigest()[:24]

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            if self.st:
                await self.st.rt.stop()
        if self.cfg.storage == "postgres":
            with contextlib.suppress(Exception):
                self.storage.close()


def write_result(res: Json, tag: str = "") -> Path:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    p = ARTIFACT_DIR / f"{res['scenario']}{tag}_{res['seed']}.json"
    import datetime as _dt
    res = {"generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"), **res}
    p.write_text(json.dumps(res, indent=2, default=str))
    return p


async def run_soak(cfg: SoakConfig) -> Json:
    s = Soak(cfg)
    clock_patch = patched_time(s.clock)
    with clock_patch:
        try:
            return await s.run()
        finally:
            await s.close()
