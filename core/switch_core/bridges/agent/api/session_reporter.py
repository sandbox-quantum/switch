"""Reporting an agent session, and only a session.

Split out of `handlers.py` so that `ProtocolService` can hold one: the handler
that starts a session and the registry listener that ends one have to be the
same object, and the service is what both reach.
"""

from __future__ import annotations

import time

from switch_core.bridges.agent.protocol.connections import Connection
from switch_core.db.models import Agent
from switch_core.telemetry import TelemetryService, emit_safely
from switch_core.telemetry.snapshot import normalise_known_agent_type

# The registry records why it closed a connection as prose. These are the
# strings it actually uses; anything else is reported as `error` rather than
# rejected, because a lost session event is worse than an imprecise one.
_SESSION_END_REASONS = {
    "heartbeat lapsed": "heartbeat_lapsed",
    "room already claimed": "room_claimed",
    "invalid room subscription": "error",
    "replaced": "replaced",
    "shutdown": "normal",
}


class SessionReporter:
    """Reports agent sessions, and only reports sessions.

    Two jobs that have to be one object, because the second depends on the
    first: a session has started when a stream is actually handed back, and a
    session has ended only if one had started.

    Opening a stream is not the same as starting a session. A connection is
    created, then rooms are claimed on it, and a claim can fail — the room is
    held by another live session, or the agent is not a member. The connection
    is closed and the request answered 409 or 403, and the client retries. If
    the start were reported when the connection was created, every one of
    those rejected attempts would be a session that began and ended in the
    same second, for as long as the client kept trying. That is not a
    hypothetical: it is what filled the first dashboard this ever reached.

    So the start is reported at the point of no return — after the claims,
    with the stream about to be returned — and the end only for a connection
    this has seen start.
    """

    def __init__(self, telemetry: TelemetryService | None) -> None:
        self._telemetry = telemetry
        # Connection ids that reported a start. Bounded by the live connection
        # count: an id is added when its stream is handed back and discarded
        # when the registry closes it, which it always eventually does — the
        # heartbeat sweep reaps anything whose client went away.
        self._started: set[str] = set()

    async def started(self, agent: Agent, conn: Connection) -> None:
        """A stream is about to be returned, so a session has begun."""
        self._started.add(conn.id)
        runtime = normalise_known_agent_type(agent.metadata_)
        emit_safely(
            self._telemetry, "agent_session_started", {"known_agent_type": runtime}
        )
        if self._telemetry is not None:
            await self._telemetry.emit_milestone(
                "first_session_started", known_agent_type=runtime
            )

    def on_close(self, conn: Connection) -> None:
        """The registry's close listener. Reports only a session that started.

        Installed once, rather than called from each of the five places that
        close a connection — two of which used to report nothing, and both of
        which also remove the connection so nothing downstream could recover
        it.
        """
        if conn.id not in self._started:
            return
        self._started.discard(conn.id)
        emit_safely(
            self._telemetry,
            "agent_session_ended",
            {
                "duration_seconds": max(time.monotonic() - conn.opened_at, 0.0),
                "reason": _SESSION_END_REASONS.get(conn.closed_reason or "", "error"),
            },
        )
