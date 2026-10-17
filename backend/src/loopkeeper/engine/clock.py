"""Two clocks: simulation time advances in fixed `dt` ticks, paced by wall time x speed multiplier."""
from __future__ import annotations

import time
from typing import Callable

SPEED_MIN, SPEED_MAX = 0.5, 60.0


class SimClock:
    def __init__(self, dt_s: float, speed: float, wall: Callable[[], float] = time.monotonic,
                 max_catchup: int = 600):
        self.dt = dt_s
        self.speed = speed
        self.paused = False
        self.tick = 0
        self.wall = wall
        self.max_catchup = max_catchup
        self.lag_dropped_s = 0.0
        self._acc = 0.0
        self._last: float | None = None

    @property
    def sim_time_s(self) -> float:
        return self.tick * self.dt

    def set_speed(self, speed: float) -> bool:
        if not (SPEED_MIN <= speed <= SPEED_MAX) or speed != speed:
            return False
        self.speed = float(speed)
        return True

    def pause(self) -> None:
        self.paused = True
        self._last = None

    def resume(self) -> None:
        self.paused = False
        self._last = None

    def due_ticks(self, max_wall_dt: float = 0.25) -> int:
        """Number of fixed ticks owed since the last call (0 while paused). Wall gaps are capped so an LLM
        stall or a suspended process never produces a physics leap."""
        now = self.wall()
        last, self._last = self._last, now
        if self.paused or last is None:
            return 0
        self._acc += min(max(now - last, 0.0), max_wall_dt) * self.speed
        n = int(self._acc // self.dt)
        if n > self.max_catchup:
            self.lag_dropped_s += (n - self.max_catchup) * self.dt
            n = self.max_catchup
            self._acc = 0.0
        else:
            self._acc -= n * self.dt
        return n
