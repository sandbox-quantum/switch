"""Requests the server refuses an agent, kept so people can see them.

An agent acts for its owner, but not with everything the owner may do: it may
change only the templates it saved, it cannot create agents, and the run
guards in ``agent_runs`` refuse rooms that cannot work. When one of those
rules says no, the agent gets a sentence it can act on, and the refusal is
recorded. Nobody yet knows which of these rules people will run into, so the
record is what a finer rights model should be designed from.

Each refusal goes three places: a row in ``agent_refusals``, which Switch
Console shows quietly under Templates; a log line; and a telemetry event that
carries only the operation and the reason code, since product telemetry never
carries a name or an id.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Literal

from switch_core.db.models import AgentRefusal
from switch_core.telemetry import emit_safely

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

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

# The agent operations whose refusals are recorded.
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

    def __init__(
        self, reason: RefusalReason, message: str, *, subject: str | None = None
    ) -> None:
        super().__init__(message)
        self.reason: RefusalReason = reason
        self.subject = subject


async def record_refusal(
    session_factory: async_sessionmaker[AsyncSession],
    telemetry: TelemetryService | None,
    *,
    agent_id: str,
    agent_name: str,
    owner_id: str | None,
    operation: str,
    refusal: AgentRefused,
) -> None:
    """Keep a refusal. Best effort: failing to write the record must not
    change what the agent is told."""
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
    try:
        async with session_factory() as session:
            session.add(
                AgentRefusal(
                    agent_id=agent_id,
                    agent_name=agent_name,
                    owner_id=owner_id,
                    operation=operation,
                    reason=refusal.reason,
                    message=str(refusal),
                    subject=refusal.subject,
                )
            )
            await session.commit()
    except Exception:  # noqa: BLE001 - the refusal stands either way
        logger.warning("Could not record a refusal for %s", agent_id, exc_info=True)
