"""Reporting an agent session — the thing a person means by that word.

A session is not a connection, and conflating the two is how the first
dashboard this reached filled with `agent_session_started` /
`agent_session_ended` pairs a few seconds apart, for ever.

Two different things produce that, and both are ordinary:

- **A stream rejected at the room claim.** Opening a stream creates a
  connection and then claims its rooms; a claim fails when another live
  session holds the room, the connection is closed, and the client retries.
  Nothing began, so nothing should be reported.
- **A stream reconnecting.** The protocol requires the client to heartbeat
  (`HEARTBEAT_TTL_SECONDS`, six seconds), and a stream whose heartbeat lapses
  closes itself and tells the client to reopen. An agent that is slow to beat
  therefore holds a succession of short connections while being, to anyone
  watching the product, continuously present the whole time.

So this reports on the **agent**, not the connection:

- a session begins when an agent that had none acquires its first live
  connection, and
- it ends only once the agent has had none for `_RECONNECT_GRACE_SECONDS` —
  comfortably longer than the heartbeat TTL, so a reconnect inside that window
  continues the session it resumed rather than starting another.

The duration reported is the whole span, across however many connections it
took, which is the number "how long do sessions last" is actually asking for.
"""

from __future__ import annotations

import asyncio
import logging
import time

from switch_core.bridges.agent.protocol.connections import (
    HEARTBEAT_TTL_SECONDS,
    Connection,
    ConnectionRegistry,
)
from switch_core.db.models import Agent
from switch_core.telemetry import TelemetryService, emit_safely
from switch_core.telemetry.snapshot import normalise_known_agent_type

logger = logging.getLogger(__name__)

# How long an agent must hold no connection before its session is over.
# Several times the heartbeat TTL, because the reconnect this exists to absorb
# is triggered *by* that TTL lapsing: the client learns it must reopen only
# when the stream tells it so, and then has to come back. Too tight and every
# lapse is a new session, which is the bug; too loose and a genuine departure
# is reported late, which costs nothing.
_RECONNECT_GRACE_SECONDS = HEARTBEAT_TTL_SECONDS * 4

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


class _Session:
    __slots__ = ("started_at", "runtime", "ending")

    def __init__(self, started_at: float, runtime: str) -> None:
        self.started_at = started_at
        self.runtime = runtime
        # The task waiting out the grace period, if the agent currently holds
        # no connection. Cancelled by a reconnect.
        self.ending: asyncio.Task[None] | None = None


class SessionReporter:
    """Reports agent sessions, coalescing the connections they are made of."""

    def __init__(
        self,
        telemetry: TelemetryService | None,
        connections: ConnectionRegistry | None = None,
    ) -> None:
        self._telemetry = telemetry
        self._connections = connections
        # Connection ids whose stream was actually handed back. A connection
        # closed before that — a rejected room claim — is not part of any
        # session and must not end one.
        self._streaming: set[str] = set()
        self._sessions: dict[str, _Session] = {}

    async def started(self, agent: Agent, conn: Connection) -> None:
        """A stream is about to be returned on `conn`."""
        self._streaming.add(conn.id)
        session = self._sessions.get(conn.agent_id)

        if session is not None:
            # The agent was already in a session. Either it holds several
            # connections at once, or this is the reconnect that the pending
            # end was waiting to see — in both cases the session continues and
            # there is nothing to report.
            if session.ending is not None:
                session.ending.cancel()
                session.ending = None
            return

        runtime = normalise_known_agent_type(agent.metadata_)
        self._sessions[conn.agent_id] = _Session(time.monotonic(), runtime)
        emit_safely(
            self._telemetry, "agent_session_started", {"known_agent_type": runtime}
        )
        if self._telemetry is not None:
            await self._telemetry.emit_milestone(
                "first_session_started", known_agent_type=runtime
            )

    def on_close(self, conn: Connection) -> None:
        """The registry's close listener, for every path that closes."""
        if conn.id not in self._streaming:
            # Never streamed: a room claim was refused and the connection was
            # closed on the way out. No session began, so none ends.
            return
        self._streaming.discard(conn.id)

        session = self._sessions.get(conn.agent_id)
        if session is None or session.ending is not None:
            return
        if self._connections is not None and self._connections.for_agent(conn.agent_id):
            # Still connected by another stream; the session did not end.
            return

        reason = _SESSION_END_REASONS.get(conn.closed_reason or "", "error")
        try:
            session.ending = asyncio.get_running_loop().create_task(
                self._end_after_grace(conn.agent_id, reason)
            )
        except RuntimeError:
            # No loop — a synchronous teardown. Report immediately rather than
            # losing the event; the grace period is an optimisation, not a
            # correctness requirement.
            self._report_end(conn.agent_id, reason)

    async def _end_after_grace(self, agent_id: str, reason: str) -> None:
        try:
            await asyncio.sleep(_RECONNECT_GRACE_SECONDS)
        except asyncio.CancelledError:
            # The agent came back. `started` already cleared the pending end.
            return
        if self._connections is not None and self._connections.for_agent(agent_id):
            session = self._sessions.get(agent_id)
            if session is not None:
                session.ending = None
            return
        self._report_end(agent_id, reason)

    def _report_end(self, agent_id: str, reason: str) -> None:
        session = self._sessions.pop(agent_id, None)
        if session is None:
            return
        emit_safely(
            self._telemetry,
            "agent_session_ended",
            {
                "duration_seconds": max(time.monotonic() - session.started_at, 0.0),
                "reason": reason,
            },
        )

    async def aclose(self) -> None:
        """Cancel any pending ends, at shutdown.

        The sessions they describe are not reported: the process is going away,
        so every agent is about to disconnect at once, and a burst of ends
        carrying "the server stopped" is noise rather than signal.
        """
        for session in self._sessions.values():
            if session.ending is not None:
                session.ending.cancel()
        self._sessions.clear()
        self._streaming.clear()
