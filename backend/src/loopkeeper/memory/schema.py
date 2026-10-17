"""Shared-brain table specs (mirror migration 0010_shared_brain.sql; a test asserts column parity against a real Postgres)."""
from __future__ import annotations

from typing import Any

Json = dict[str, Any]

STATUSES = ("PROPOSED", "VERIFIED", "CONFLICTED", "REJECTED", "EXPIRED", "ARCHIVED")
LIVE = ("PROPOSED", "VERIFIED", "CONFLICTED")           # not terminal
TERMINAL = ("REJECTED", "EXPIRED", "ARCHIVED")
JSON_COLS_FACT = ("value", "evidence_ids", "source_run_ids", "event_refs", "preconditions", "verification_ref")

TABLES: dict[str, Json] = {
    "fact": {
        "table": "shared_facts", "pk": ("fact_id", "revision"),
        "cols": ("fact_id", "revision", "facility_id", "run_id", "incident_id", "subject_key", "fact_kind", "fault_kind", "asset_type", "asset_id",
                 "topology_revision", "statement", "value", "value_hash", "evidence_ids", "source_run_ids", "event_refs", "preconditions",
                 "confidence", "status", "status_reason", "visibility", "proposed_by", "verified_by", "verification_ref", "conflict_id",
                 "created_ts", "updated_ts", "expires_ts"),
        "json": ("value", "evidence_ids", "source_run_ids", "event_refs", "preconditions", "verification_ref"),
        "order": ("confidence", "updated_ts", "created_ts", "revision"),
    },
    "lesson": {
        "table": "procedural_lessons", "pk": ("lesson_id", "revision"),
        "cols": ("lesson_id", "revision", "facility_id", "run_id", "incident_id", "fault_kind", "asset_type", "topology_revision", "subject_key",
                 "title", "steps", "steps_hash", "expected_outcome", "preconditions", "evidence_ids", "source_run_ids", "event_refs",
                 "confidence", "success_count", "failure_count", "status", "status_reason", "visibility", "proposed_by", "verified_by",
                 "verification_ref", "conflict_id", "created_ts", "updated_ts", "expires_ts"),
        "json": ("steps", "preconditions", "evidence_ids", "source_run_ids", "event_refs", "verification_ref"),
        "order": ("confidence", "success_count", "updated_ts", "created_ts", "revision"),
    },
    "conflict": {
        "table": "memory_conflicts", "pk": ("conflict_id",),
        "cols": ("conflict_id", "facility_id", "item_kind", "subject_key", "items", "status", "detected_run_id", "detected_ts", "resolved_ts",
                 "resolved_by", "resolution"),
        "json": ("items", "resolution"),
        "order": ("detected_ts",),
    },
    "playbook": {
        "table": "playbook_versions", "pk": ("playbook_id", "version"),
        "cols": ("playbook_id", "version", "parent_version", "facility_id", "fault_kind", "doc", "lesson_refs", "status", "evaluation", "created_ts", "updated_ts"),
        "json": ("doc", "lesson_refs", "evaluation"),
        "order": ("version", "updated_ts", "created_ts"),
    },
}
