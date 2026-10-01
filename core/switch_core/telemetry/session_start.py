"""A coding-agent session starting, as the host that runs it reports it.

The server cannot see this for itself. Sessions share their agent's one
connection, held by Console or a remote host's sidecar, so a session begins
without anything reaching the server, and who began it is known only to
whatever launched it. The host says so once, when the session is new, carrying
what the launcher stamped on it.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Agent
from switch_core.telemetry.deployment import claim_milestone, prune_claims
from switch_core.telemetry.service import TelemetryService, emit_safely
from switch_core.telemetry.snapshot import normalise_known_agent_type

logger = logging.getLogger(__name__)

StartSource = Literal["user", "room", "automation", "unknown"]

# The claims share `telemetry_milestones` with the once-ever milestones and the
# per-connector claims, which are never pruned; the prefix is what tells them
# apart.
CLAIM_PREFIX = "session_started:"

# How long a claim is kept. It exists only so a retried report counts once, and
# a host retries within seconds while Switch answers, or the next time a
# session stopped mid-report runs. A report retried later than this, whose
# first attempt did reach the server, counts twice.
CLAIM_TTL = timedelta(days=7)

# Well above an agent starting a session for every room message it is
# addressed in, and low enough that one agent cannot fill the table or the
# dashboard with made-up sessions.
MAX_STARTS_PER_AGENT = 120
START_WINDOW_SECONDS = 3600.0


class SessionStartLimiter:
    """How many start reports each agent may make in a sliding window.

    In memory, which is enough for what it guards: a restart resets it, and
    the most that buys an abusive agent is one more window's worth.
    """

    def __init__(
        self,
        *,
        max_per_window: int,
        window_seconds: float,
        clock: Callable[[], float],
    ) -> None:
        self._max = max_per_window
        self._window = window_seconds
        self._clock = clock
        self._seen: dict[str, deque[float]] = {}
        # Agents already warned about in their current burst, so a flood logs
        # once rather than once per report.
        self._warned: set[str] = set()

    def admit(self, agent_id: str) -> bool:
        now = self._clock()
        seen = self._seen.setdefault(agent_id, deque())
        while seen and now - seen[0] >= self._window:
            seen.popleft()
        if len(seen) >= self._max:
            if agent_id not in self._warned:
                self._warned.add(agent_id)
                logger.warning(
                    "Agent %s reported more than %d session starts in %.0f "
                    "seconds; further reports are not counted until the rate "
                    "drops.",
                    agent_id,
                    self._max,
                    self._window,
                )
            return False
        self._warned.discard(agent_id)
        seen.append(now)
        return True


def default_session_start_limiter() -> SessionStartLimiter:
    return SessionStartLimiter(
        max_per_window=MAX_STARTS_PER_AGENT,
        window_seconds=START_WINDOW_SECONDS,
        clock=time.monotonic,
    )


async def report_session_started(
    telemetry: TelemetryService | None,
    session_factory: async_sessionmaker[AsyncSession],
    limiter: SessionStartLimiter,
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
    if not limiter.admit(agent.id):
        return False
    if not await claim_milestone(
        session_factory, f"{CLAIM_PREFIX}{agent.id}:{session_id}"
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


async def prune_session_start_claims(
    session_factory: async_sessionmaker[AsyncSession], *, now: datetime
) -> int:
    """Delete session start claims older than `CLAIM_TTL`. Returns how many.

    Only these: every other row in the table is a once-ever claim, and pruning
    one would report its milestone again.
    """
    return await prune_claims(
        session_factory, prefix=CLAIM_PREFIX, claimed_before=now - CLAIM_TTL
    )
