"""CommunicationEventV1: the typed, validated, redacted record of what the runtime really did (docs/engineering/V10_COMMUNICATION_PROTOCOL.md).

A communication event is a canonical world event of kind ``comm.<kind>`` (same run sequence, same commit transaction, same stream); its
payload is this model minus the wall clock (kept out of the payload so event hashes / digests stay deterministic; ``wall_time_utc`` is
added from the envelope timestamp when the event is read or streamed). Nothing here calls a model: summaries come from authoritative
fields through templates in ``derive.py``."""
from __future__ import annotations

import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

Json = dict[str, Any]
SCHEMA = "agent-envelope.v1"
ENVELOPE_KINDS = ("TASK_ASSIGN", "ACK", "REQUEST_OBSERVATION", "OBSERVATION", "HYPOTHESIS", "REQUEST_TOOL", "TOOL_ACCEPTED", "TOOL_REJECTED", "PROPOSE_PLAN",
                  "PLAN_APPROVED", "PLAN_REJECTED", "SAFETY_VETO", "PROGRESS", "REPLAN", "VERIFICATION_REQUEST", "VERIFICATION_RESULT", "ESCALATION", "STOP",
                  "HEARTBEAT", "MODEL_ERROR", "HUMAN_OVERRIDE")
PRIORITIES = ("low", "normal", "high", "critical")
# concrete boundary (subtype) -> Agent Envelope Protocol kind
KIND_OF_SUBTYPE = {
    "task.delegated": "TASK_ASSIGN", "mission.ack": "ACK", "observation": "OBSERVATION", "tool.started": "REQUEST_TOOL", "tool.completed": "TOOL_ACCEPTED",
    "tool.failed": "TOOL_REJECTED", "policy.blocked": "TOOL_REJECTED", "policy.command_refused": "SAFETY_VETO", "task.blocked": "SAFETY_VETO",
    "dag.cycle_refused": "SAFETY_VETO", "nav.deadlock_unresolved": "SAFETY_VETO", "drive.rejected": "SAFETY_VETO", "task.replan": "REPLAN",
    "verification.started": "VERIFICATION_REQUEST", "verification.passed": "VERIFICATION_RESULT", "verification.failed": "VERIFICATION_RESULT", "verification.unreviewed": "VERIFICATION_RESULT",
    "approval.requested": "PROPOSE_PLAN", "approval.approved": "PLAN_APPROVED", "approval.held": "PLAN_REJECTED", "approval.expired": "PLAN_REJECTED",
    "approval.rejected": "PLAN_REJECTED", "provider.error": "MODEL_ERROR", "run.ended": "STOP", "task.hypothesis": "HYPOTHESIS",
    "task.request_observation": "REQUEST_OBSERVATION", "incident.escalated": "ESCALATION", "agent.heartbeat": "HEARTBEAT",
    "drift.detected": "ESCALATION", "loop.detected": "ESCALATION", "contract.proposed": "PROPOSE_PLAN", "contract.frozen": "PLAN_APPROVED",
    "contract.revised": "PROPOSE_PLAN", "contract.revision_refused": "PLAN_REJECTED", "contract.evaluating": "VERIFICATION_REQUEST",
    "contract.layer_a": "VERIFICATION_RESULT", "contract.layer_b": "VERIFICATION_RESULT", "contract.terminal": "VERIFICATION_RESULT",
}
KINDS = ("agent_message", "task_transition", "tool_event", "verification", "safety", "operator", "simulation", "provider")
PHASES = ("requested", "started", "progress", "completed", "failed", "blocked", "info")
STATUSES = ("ok", "pending", "info", "warning", "failed", "blocked")
PARTY_KINDS = ("agent", "robot", "operator", "system", "provider")
SENDER_CLASSES = ("SENTINEL", "INPIPE", "OUTRIG", "OPERATOR", "SYSTEM", "PROVIDER")
EVENT_PREFIX = "comm."
SUMMARY_MAX = 240
ID_MAX = 96
DETAIL_MAX_BYTES = 2048
EVIDENCE_MAX = 12
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f  ]")
_ID_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@#/+\-]{0,95}$")
_HIDDEN = re.compile(r"^(chain_?of_?thought|cot|reasoning(_content|_trace|_tokens)?|scratchpad|raw_?prompt|prompt|system_?prompt|messages|"
                     r"raw_?response|raw_?completion|thinking|hidden_?reasoning)$", re.I)


def clean_text(s: Any, limit: int = SUMMARY_MAX) -> str:
    """Single-line, control-character-free, bounded text. HTML is NOT interpreted anywhere (clients escape); angle brackets stay literal."""
    t = _CTRL.sub(" ", str(s if s is not None else ""))
    t = re.sub(r"\s+", " ", t).strip()
    return t if len(t) <= limit else t[: limit - 1].rstrip() + "…"


def _scrub(obj: Any) -> Any:
    from ..api.scrub import scrub          # lazy: loopkeeper.api imports the engine
    return scrub(obj)


def clean_id(v: Any) -> Optional[str]:
    if v is None or v == "":
        return None
    s = str(v)
    return s if _ID_OK.match(s) else None


class Party(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    kind: Literal["agent", "robot", "operator", "system", "provider"]
    id: str = Field(min_length=1, max_length=ID_MAX)
    klass: str = Field(alias="class", max_length=24)

    def wire(self) -> Json:
        return {"kind": self.kind, "id": self.id, "class": self.klass}


class CommunicationEventV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["agent-envelope.v1"] = SCHEMA
    message_id: str = Field(min_length=1, max_length=ID_MAX)                     # == event_id (one id space with the canonical run log)
    kind: Literal["TASK_ASSIGN", "ACK", "REQUEST_OBSERVATION", "OBSERVATION", "HYPOTHESIS", "REQUEST_TOOL", "TOOL_ACCEPTED", "TOOL_REJECTED", "PROPOSE_PLAN",
                  "PLAN_APPROVED", "PLAN_REJECTED", "SAFETY_VETO", "PROGRESS", "REPLAN", "VERIFICATION_REQUEST", "VERIFICATION_RESULT", "ESCALATION", "STOP",
                  "HEARTBEAT", "MODEL_ERROR", "HUMAN_OVERRIDE"]
    parent_task_id: Optional[str] = None
    priority: Literal["low", "normal", "high", "critical"] = "normal"
    deadline_sim_tick: Optional[int] = Field(default=None, ge=0)
    world_version_observed: Optional[int] = Field(default=None, ge=0)
    topology_revision: Optional[str] = Field(default=None, max_length=96)
    permission_scope: Literal["observe", "plan", "act", "operator", "system"] = "observe"
    idempotency_key: Optional[str] = Field(default=None, max_length=160)           # outbox / consumer dedupe key: the same boundary is never applied twice
    event_id: str = Field(min_length=1, max_length=ID_MAX)
    run_id: str = Field(min_length=1, max_length=ID_MAX)
    seq: int = Field(ge=1)
    sim_tick: int = Field(ge=0)
    sim_time_ms: int = Field(ge=0)
    wall_time_utc: Optional[str] = None                      # added from the envelope timestamp on read / stream, never stored in the payload
    message_type: Literal["agent_message", "task_transition", "tool_event", "verification", "safety", "operator", "simulation", "provider"]
    subtype: str = Field(min_length=1, max_length=48, pattern=r"^[a-z0-9_.\-]+$")      # the concrete boundary, e.g. task.delegated, tool.started, verification.failed
    phase: Literal["requested", "started", "progress", "completed", "failed", "blocked", "info"]
    status: Literal["ok", "pending", "info", "warning", "failed", "blocked"]
    sender: Party
    recipient: Optional[Party] = None
    thread_id: str = Field(min_length=1, max_length=ID_MAX)
    task_id: Optional[str] = None
    mission_id: Optional[str] = None
    incident_id: Optional[str] = None
    asset_id: Optional[str] = None
    robot_id: Optional[str] = None
    summary: str = Field(min_length=1, max_length=SUMMARY_MAX)
    evidence_ids: list[str] = Field(default_factory=list, max_length=EVIDENCE_MAX)
    model_provider: Optional[str] = Field(default=None, max_length=48)
    model_id: Optional[str] = Field(default=None, max_length=96)
    visibility: Literal["operator", "debug"] = "operator"
    causal_event_id: Optional[str] = None                    # the authoritative runtime event this record was derived from
    payload: Json = Field(default_factory=dict)              # compact authoritative metadata (tool name / latency / checks / reason); redacted + bounded

    @field_validator("task_id", "mission_id", "incident_id", "asset_id", "robot_id", "causal_event_id", "parent_task_id", mode="before")
    @classmethod
    def _ids(cls, v: Any) -> Optional[str]:
        return clean_id(v)

    @field_validator("evidence_ids", mode="before")
    @classmethod
    def _evidence(cls, v: Any) -> list[str]:
        return [x for x in (clean_id(i) for i in list(v or [])[:EVIDENCE_MAX]) if x]

    @field_validator("summary", mode="before")
    @classmethod
    def _summary(cls, v: Any) -> str:
        return clean_text(v) or "(no summary)"

    @field_validator("payload", mode="before")
    @classmethod
    def _detail(cls, v: Any) -> Json:
        return bound_detail(v)

    def stored(self) -> Json:
        """The payload persisted in world_events (no wall clock: digests stay deterministic)."""
        d = self.model_dump(by_alias=True, exclude={"wall_time_utc"})
        d["sender"] = self.sender.wire()
        d["recipient"] = self.recipient.wire() if self.recipient else None
        return d


def _strip_hidden(obj: Any, depth: int = 0) -> Any:
    if depth > 4:
        return "[truncated]"
    if isinstance(obj, dict):
        return {str(k)[:48]: _strip_hidden(v, depth + 1) for k, v in list(obj.items())[:24] if not _HIDDEN.match(str(k).replace("-", "_"))}
    if isinstance(obj, (list, tuple)):
        return [_strip_hidden(v, depth + 1) for v in list(obj)[:16]]
    if isinstance(obj, str):
        return clean_text(obj, 160)
    if isinstance(obj, (int, float, bool)) or obj is None:
        return obj
    return clean_text(obj, 80)


def bound_detail(v: Any) -> Json:
    """Redacted (secret keys / values, hidden-reasoning keys), shallow and at most DETAIL_MAX_BYTES of JSON."""
    import json
    if not isinstance(v, dict):
        return {}
    d = _strip_hidden(_scrub(v))
    raw = json.dumps(d, separators=(",", ":"), default=str)
    if len(raw) <= DETAIL_MAX_BYTES:
        return d
    keep: Json = {}
    for k, x in d.items():
        keep[k] = x
        if len(json.dumps(keep, separators=(",", ":"), default=str)) > DETAIL_MAX_BYTES:
            keep.pop(k)
            break
    keep["truncated"] = True
    return keep


def complete(env: Json) -> Json:
    """Wire envelope of a stored comm.* event -> envelope whose payload is the full record (adds wall_time_utc; `detail` mirrors `payload` for panels)."""
    p = dict(env["payload"])
    p["wall_time_utc"] = env.get("ts")
    p["detail"] = p.get("payload") or {}
    return {**env, "payload": p}


def to_v1(env: Json) -> Json:
    """Stored/enveloped comm.* event -> the plain CommunicationEventV1 JSON object REST returns."""
    return complete(env)["payload"]
