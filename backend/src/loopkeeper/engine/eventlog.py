"""Ordered event log: one monotonic seq across every event type (heartbeats included), an in-memory ring for
events_since(), and bounded subscriber queues. Events become visible to subscribers only after commit."""
from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime, timezone

from .config import STATE_SCHEMA_VERSION
from .util import Json, chash


def now_iso() -> str:
    d = datetime.now(timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def event_hash(ev: Json) -> str:
    return chash({"seq": ev["seq"], "kind": ev["kind"], "entity_id": ev["entity_id"], "tick": ev["tick"],
                  "payload": ev["payload"], "actor_type": ev.get("actor_type"), "command_id": ev.get("command_id")})


def to_envelope(run_id: str, ev: Json) -> Json:
    """Stored event row -> wire envelope (contracts.ts EventBase + run_id / actor extras)."""
    return {
        "event_id": ev["event_id"], "seq": ev["seq"], "sim_tick": ev["tick"], "sim_time_s": ev["sim_time_s"],
        "world_version": ev["world_version"], "type": ev["kind"], "entity_id": ev["entity_id"],
        "facility_id": ev["facility_id"], "ts": ev["ts"], "payload": ev["payload"], "run_id": run_id,
        "actor_type": ev.get("actor_type", "system"), "actor_id": ev.get("actor_id"),
        "command_id": ev.get("command_id"), "causal_parent_id": ev.get("causal_parent_id"),
    }


def from_envelope(facility_id: str, env: Json) -> Json:
    return {
        "seq": env["seq"], "event_id": env["event_id"], "facility_id": facility_id, "tick": env["sim_tick"],
        "sim_time_s": env["sim_time_s"], "world_version": env["world_version"], "kind": env["type"],
        "entity_id": env["entity_id"], "actor_type": env.get("actor_type", "system"), "actor_id": env.get("actor_id"),
        "payload": env["payload"], "causal_parent_id": env.get("causal_parent_id"), "command_id": env.get("command_id"),
        "ts": env["ts"], "schema_version": STATE_SCHEMA_VERSION,
    }


class Subscription:
    """Async iterator of wire envelopes. If the consumer falls too far behind it is closed with
    `overflowed=True` and must resynchronise from a snapshot."""

    def __init__(self, bus: "EventBus", maxsize: int = 5000):
        self._bus = bus
        self._q: asyncio.Queue = asyncio.Queue()
        self._max = maxsize
        self.closed = False
        self.overflowed = False

    def _push(self, ev: Json) -> None:
        if self.closed:
            return
        if self._q.qsize() >= self._max:
            self.overflowed = True
            self.close()
            return
        self._q.put_nowait(ev)

    def __aiter__(self):
        return self

    async def __anext__(self) -> Json:
        while True:
            if not self._q.empty():
                ev = self._q.get_nowait()
                if ev is None:
                    raise StopAsyncIteration
                return ev
            if self.closed:
                raise StopAsyncIteration
            ev = await self._q.get()
            if ev is None:
                raise StopAsyncIteration
            return ev

    def get_nowait(self) -> Json | None:
        return None if self._q.empty() else self._q.get_nowait()

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self._bus._subs.discard(self)
            self._q.put_nowait(None)


class EventBus:
    def __init__(self, ring_size: int = 20000):
        self.ring: deque[Json] = deque(maxlen=ring_size)  # published (committed) wire envelopes
        self._subs: set[Subscription] = set()
        self.base_seq = 0  # last seq committed before this process started publishing

    @property
    def last_published_seq(self) -> int:
        return self.ring[-1]["seq"] if self.ring else 0

    def publish(self, envs: list[Json]) -> None:
        for e in envs:
            self.ring.append(e)
            for s in list(self._subs):
                s._push(e)

    def since(self, seq: int, limit: int = 1000) -> list[Json] | None:
        """Envelopes with seq > `seq`, or None if the ring no longer covers that point (caller falls back to storage)."""
        if self.ring:
            if self.ring[0]["seq"] > seq + 1:
                return None
        elif seq < self.base_seq:
            return None
        out = []
        for e in self.ring:
            if e["seq"] > seq:
                out.append(e)
                if len(out) >= limit:
                    break
        return out

    def subscribe(self, since_seq: int | None = None) -> Subscription:
        sub = Subscription(self)
        if since_seq is not None:
            for e in self.ring:
                if e["seq"] > since_seq:
                    sub._push(e)
        self._subs.add(sub)
        return sub

    def close_all(self) -> None:
        for s in list(self._subs):
            s.close()
