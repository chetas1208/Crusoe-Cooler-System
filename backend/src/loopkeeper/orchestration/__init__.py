"""Package C: Multi-agent orchestration layer."""
from __future__ import annotations

from typing import Any

from .context import Limits
from .runtime import AgentRuntimeImpl


def create_agent_runtime(**kwargs: Any) -> AgentRuntimeImpl:
    return AgentRuntimeImpl(**kwargs)


create_runtime = create_agent_runtime

__all__ = ["AgentRuntimeImpl", "Limits", "create_agent_runtime", "create_runtime"]
