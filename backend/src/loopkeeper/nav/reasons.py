"""Refusal vocabulary (docs/engineering/v7-nav-streaming.md section 2). Every refusal carries one reason code and the exact constraint."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

REASONS = ("NO_ACCESS", "TURN_RADIUS", "EQUIPMENT_BLOCK", "RESERVATION_CONFLICT", "PRESSURE_UNSAFE", "BATTERY", "PIPE_CLEARANCE",
           "STALE_GRAPH", "STALE_TRAFFIC", "UNKNOWN_ROBOT", "UNKNOWN_TARGET", "UNKNOWN_PLAN", "LEASE_REQUIRED", "ROBOT_BUSY")


@dataclass
class Refusal:
    reason: str
    detail: str
    data: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        assert self.reason in REASONS, self.reason
        return {"ok": False, "reason": self.reason, "detail": self.detail, **self.data}
