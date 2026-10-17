"""Pydantic schemas for every structured model decision.

The model only PROPOSES. Every decision is validated here (shape) and by
orchestration.policy (admissibility) before any tool or command uses it.
Free text is length-bounded and sanitised; there is no field for chain-of-thought.
"""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SCHEMA_VERSION = "agent.v1"

FaultKindLit = Literal[
    "fouling", "strainer_blockage", "valve_stuck", "pump_degradation",
    "sensor_drift", "workload_spike", "leak",
]
ActionLit = Literal[
    "brush_clear", "replace_section", "replace_strainer", "service_valve",
    "service_pump", "recalibrate_sensor", "monitor_only", "escalate",
]
ProbeToolLit = Literal[
    "read_telemetry", "query_topology", "check_mass_balance", "check_flow_normality",
]

_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def clean_text(s: str, limit: int = 400) -> str:
    s = _THINK.sub("", s or "")
    s = _CTRL.sub("", s).strip()
    return s[:limit]


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class ClassifyDecision(_Base):
    mechanism: FaultKindLit | Literal["unknown"] = "unknown"
    summary: str = Field(max_length=600)

    @field_validator("summary")
    @classmethod
    def _s(cls, v: str) -> str:
        return clean_text(v)


class ReviewDecision(_Base):
    summary: str = Field(max_length=600)
    findings: list[str] = Field(default_factory=list, max_length=4)
    supports: FaultKindLit | Literal["none"] = "none"

    @field_validator("summary")
    @classmethod
    def _s(cls, v: str) -> str:
        return clean_text(v)

    @field_validator("findings")
    @classmethod
    def _f(cls, v: list[str]) -> list[str]:
        return [clean_text(x, 200) for x in v][:4]


class HypothesisProposal(_Base):
    cause: FaultKindLit
    target_id: str = Field(max_length=64, pattern=r"^[A-Za-z0-9_.\-]+$")
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_for: list[str] = Field(default_factory=list, max_length=4)
    evidence_against: list[str] = Field(default_factory=list, max_length=4)


class FollowupProposal(_Base):
    tool: ProbeToolLit
    target_id: str = Field(max_length=64, pattern=r"^[A-Za-z0-9_.\-]+$")
    question: str = Field(max_length=240)


class ReconcileDecision(_Base):
    hypotheses: list[HypothesisProposal] = Field(min_length=1, max_length=5)
    summary: str = Field(default="", max_length=600)
    followups: list[FollowupProposal] = Field(default_factory=list, max_length=8)

    @field_validator("summary")
    @classmethod
    def _s(cls, v: str) -> str:
        return clean_text(v)


class ProbeSummary(_Base):
    summary: str = Field(max_length=500)
    followups: list[FollowupProposal] = Field(default_factory=list, max_length=4)

    @field_validator("summary")
    @classmethod
    def _s(cls, v: str) -> str:
        return clean_text(v, 300)


class InspectionDecision(_Base):
    inspect: bool
    gauge: Literal["deposit", "bore", "flow"] | None = None
    rationale: str = Field(default="", max_length=400)


class ObservationSummary(_Base):
    summary: str = Field(max_length=500)
    confirms: bool | None = None

    @field_validator("summary")
    @classmethod
    def _s(cls, v: str) -> str:
        return clean_text(v)


class InterventionDecision(_Base):
    action: ActionLit
    target_id: str = Field(max_length=64, pattern=r"^[A-Za-z0-9_.\-]+$")
    rationale: str = Field(default="", max_length=500)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)

    @field_validator("rationale")
    @classmethod
    def _s(cls, v: str) -> str:
        return clean_text(v, 500)


class VerifySummary(_Base):
    summary: str = Field(max_length=500)

    @field_validator("summary")
    @classmethod
    def _s(cls, v: str) -> str:
        return clean_text(v)


class EscalationSummary(_Base):
    summary: str = Field(max_length=500)

    @field_validator("summary")
    @classmethod
    def _s(cls, v: str) -> str:
        return clean_text(v)


DodCheckLit = Literal[
    "sustained_flow_fraction", "segment_dp_ratio_max", "temperature_within_configured_limit", "collateral_flow_deviation_max",
    "pump_head_fraction_min", "bearing_vibration_max", "independent_sensor_agreement", "no_active_uncontained_leak",
]


class DraftCheck(_Base):
    """A check the model WANTS in the contract. Thresholds and units are never the model's: the compiler takes them from the configuration."""
    type: DodCheckLit
    subject_asset_id: str = Field(default="", max_length=64, pattern=r"^[A-Za-z0-9_.\-]*$")


class DodDraft(_Base):
    """SEN-01's proposal for the executable Definition of Done (PROPOSED). Validated and frozen by the deterministic compiler."""
    goal: str = Field(max_length=240)
    subject_asset_ids: list[str] = Field(default_factory=list, max_length=8)
    hold_sim_seconds: int = Field(default=30, ge=0, le=600)
    checks: list[DraftCheck] = Field(default_factory=list, max_length=8)
    reason: str = Field(default="", max_length=300)

    @field_validator("goal", "reason")
    @classmethod
    def _s(cls, v: str) -> str:
        return clean_text(v, 300)


class DodReview(_Base):
    """SEN-05's independent review. It can ask for more evidence or a replan; it has no field that could force a pass."""
    verdict: Literal["concur", "request_more_tests", "request_replan"]
    reasons: list[str] = Field(default_factory=list, max_length=4)
    extra_checks: list[DraftCheck] = Field(default_factory=list, max_length=3)
    extra_hold_sim_seconds: int = Field(default=0, ge=0, le=120)

    @field_validator("reasons")
    @classmethod
    def _r(cls, v: list[str]) -> list[str]:
        return [clean_text(x, 200) for x in v]


SCHEMAS: dict[str, type[BaseModel]] = {
    "dod_draft": DodDraft,
    "dod_revise": DodDraft,
    "dod_review": DodReview,
    "classify": ClassifyDecision,
    "review": ReviewDecision,
    "reconcile": ReconcileDecision,
    "probe": ProbeSummary,
    "inspection": InspectionDecision,
    "observation": ObservationSummary,
    "intervention": InterventionDecision,
    "replan": InterventionDecision,
    "verify": VerifySummary,
    "escalate": EscalationSummary,
}
