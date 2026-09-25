"""A coding-agent session starting, as the host that runs it reports it.

The server cannot see this for itself. Sessions share their agent's one
connection, held by Console or a remote host's sidecar, so a session begins
without anything reaching the server, and who began it is known only to
whatever launched it. The host says so once, when the session is new, carrying
what the launcher stamped on it.
"""

from __future__ import annotations

from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent
from switch_core.telemetry.deployment import claim_milestone
from switch_core.telemetry.service import TelemetryService, emit_safely
from switch_core.telemetry.snapshot import normalise_known_agent_type

StartSource = Literal["user", "room", "automation", "unknown"]


async def report_session_started(
    telemetry: TelemetryService | None,
    session_factory: async_sessionmaker[AsyncSession],
    agent: Agent,
    session_id: str,
    start_source: StartSource,
) -> bool:
    """Emit `session_started` for this session unless it already has.

    The claim is what makes a retried or repeated report count once, across
    restarts too: the host retries until the server answers, and an answer
    lost on the way back is a second report of the same start. Keyed by agent
    as well as session, so one agent's host cannot spend another's.

    Nothing is claimed while telemetry is off, for the reason
    `TelemetryService.emit_milestone` gives. Returns whether it was sent.
    """
    if telemetry is None or not telemetry.enabled:
        return False
    if not await claim_milestone(
        session_factory, f"session_started:{agent.id}:{session_id}"
    ):
        return False
    emit_safely(
        telemetry,
        "session_started",
        {
            "start_source": start_source,
            "known_agent_type": normalise_known_agent_type(agent.metadata_),
        },
    )
    return True
