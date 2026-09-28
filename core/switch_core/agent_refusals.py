"""Requests the server refuses an agent, and how the refusal is reported.

An agent acts for its owner, but not with everything the owner may do: it may
change only the templates it saved, it cannot create agents, and the run
guards in ``agent_runs`` refuse rooms that cannot work. When one of those
rules says no, the agent gets a sentence it can act on, and the refusal is
reported. Nobody yet knows which of these rules people will run into, so the
counts are what a finer rights model should be designed from.

Each refusal goes two places: a log line naming the agent, and a telemetry
event that carries only the operation and the reason code, since product
telemetry never carries a name or an id.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Literal

from switch_core.telemetry import emit_safely

if TYPE_CHECKING:
    from switch_core.telemetry import TelemetryService

logger = logging.getLogger(__name__)

RefusalReason = Literal[
    # Templates
    "not_found",
    "not_yours",
    "name_taken",
    "visibility_not_allowed",
    "invalid",
    "too_large",
    "missing_agents",
    "agent_creation_console_only",
    # Rooms an agent creates (see `agent_runs`)
    "busy",
    "run_paused",
    "run_stopped",
    "repeat",
    "kickoff_ignored",
]

REFUSAL_REASONS: tuple[str, ...] = RefusalReason.__args__  # type: ignore[attr-defined]

# The agent operations whose refusals are reported.
OPERATIONS = (
    "list_templates",
    "get_template",
    "run_template",
    "save_template",
    "update_template",
    "delete_template",
    "create_room",
    "create_room_from_yaml",
)


class AgentRefused(ValueError):
    """A request refused on purpose, with a reason code and a sentence for
    the agent. A ValueError, so it reaches the agent the way every other
    operation error does."""

    def __init__(self, reason: RefusalReason, message: str) -> None:
        super().__init__(message)
        self.reason: RefusalReason = reason


def record_refusal(
    telemetry: TelemetryService | None,
    *,
    agent_id: str,
    agent_name: str,
    operation: str,
    refusal: AgentRefused,
) -> None:
    """Report a refusal in the log and as a telemetry event."""
    logger.info(
        "Refused agent %s (%s) %s: %s. %s",
        agent_name,
        agent_id,
        operation,
        refusal.reason,
        refusal,
    )
    emit_safely(
        telemetry,
        "agent_request_refused",
        {"operation": operation, "reason": refusal.reason},
    )
