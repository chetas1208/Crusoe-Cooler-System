"""Plain-language rendering of engine / policy reason codes for operators.

Operators must never see raw validation errors, stack text or field names in incident summaries or
next-step text. The raw detail stays in the task trace (tool-call output, redacted).
"""
from __future__ import annotations

import re

_RULES: list[tuple[str, str]] = [
    (r"approval", "the operator approval needed for this action was not in place"),
    (r"resource_locked|isolation_busy|segment_locked|isolation_lock|isolation lock", "another maintenance job is using that part of the plant"),
    (r"not_isolated|pressure_above|isolat", "the section could not be isolated and depressurised safely first"),
    (r"racks_not_cordoned|cordon|still loaded", "the workload had not been moved off the affected racks"),
    (r"crawler_inside|crawler_out", "an inspection crawler was still inside the pipe section"),
    (r"no_route|route_blocked|not_reachable|route_exists|segment_serviceable|unknown_target|out_of_reach", "there is no safe route or reach to the target"),
    (r"battery", "the robot battery reserve is too low for the job"),
    (r"tool_unavailable|tool", "the robot does not carry the required tool"),
    (r"manual_control|manual control", "an operator is driving that robot"),
    (r"unknown_robot|robot unavailable|robot busy|no_robot_conflict|robot_health|robot_exists", "no suitable robot was available"),
    (r"physics_degraded|degraded", "the plant simulation is degraded, so physical work is on hold"),
    (r"timeout|timed out|did not complete", "the job took longer than allowed"),
    (r"thermal_impact|below the warning margin|critically low", "taking that zone out of service would leave other racks short of cooling"),
    (r"not_whitelisted|whitelist|invalid args|unexpected field|extra inputs|schema|policy", "the request did not pass the safety checks"),
    (r"no observation", "the inspection returned no usable measurement"),
]


def plain(raw: str | None) -> str:
    """One short, jargon-free clause (no field names, no stack/validation text)."""
    t = (raw or "").lower()
    for pat, msg in _RULES:
        if re.search(pat, t):
            return msg
    return "an unexpected condition stopped the job"


def next_step(escalated: bool = True) -> str:
    return "An operator should review the incident; monitoring continues." if escalated else ""
