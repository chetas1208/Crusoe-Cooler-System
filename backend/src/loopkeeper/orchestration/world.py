"""Read-only helpers over the engine's WorldSnapshot dict + a rolling telemetry history."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Any

Json = dict[str, Any]


def rd(world: Json, asset: str, metric: str, default: float | None = None) -> float | None:
    v = ((world.get("assets") or {}).get(asset) or {}).get("readings", {}).get(metric)
    return float(v) if isinstance(v, (int, float)) else default


def sim_time(world: Json) -> float:
    return float(world.get("sim_time_s", 0.0))


@dataclass
class Sample:
    t: float
    version: int
    readings: dict[str, dict[str, float]]


class History:
    def __init__(self, maxlen: int = 120) -> None:
        self.buf: deque[Sample] = deque(maxlen=maxlen)

    def add(self, world: Json) -> Sample | None:
        t = sim_time(world)
        if self.buf and t <= self.buf[-1].t:
            return None
        rds = {a: {k: float(v) for k, v in (s.get("readings") or {}).items() if isinstance(v, (int, float))}
               for a, s in (world.get("assets") or {}).items()}
        smp = Sample(t, int(world.get("version", 0)), rds)
        self.buf.append(smp)
        return smp

    def last(self) -> Sample | None:
        return self.buf[-1] if self.buf else None

    def avg(self, asset: str, metric: str, n: int = 6, default: float = 0.0) -> float:
        vals = [s.readings.get(asset, {}).get(metric) for s in list(self.buf)[-n:]]
        vals = [v for v in vals if v is not None]
        return sum(vals) / len(vals) if vals else default

    def slope(self, asset: str, metric: str, n: int = 20) -> float:
        h = [s for s in list(self.buf)[-n:] if metric in s.readings.get(asset, {})]
        if len(h) < 6:
            return 0.0
        dt = max(h[-1].t - h[0].t, 1.0)
        return (h[-1].readings[asset][metric] - h[0].readings[asset][metric]) / dt
