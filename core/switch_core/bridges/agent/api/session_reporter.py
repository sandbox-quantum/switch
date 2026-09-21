"""Reporting an agent session, which is not the same as a connection.

Two ordinary things make an agent hold a succession of short connections while
being continuously present: a stream rejected at the room claim and retried,
and a stream whose heartbeat lapsed (six seconds) closing itself so the client
reopens. Per connection, both read as a session every few seconds.

So this reports on the **agent**: a session begins when one that had no live
connection acquires its first, and ends only once it has had none for
`_RECONNECT_GRACE_SECONDS`. The duration is the whole span.
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

# Several times the heartbeat TTL, because the reconnect this absorbs is
# triggered by that TTL lapsing. Too tight and every lapse is a new session.
_RECONNECT_GRACE_SECONDS = HEARTBEAT_TTL_SECONDS * 4

# The registry's reasons are prose. Anything unmapped reports `error` rather
# than failing validation at the moment a session drops.
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
            # Already in a session: another connection, or the reconnect the
            # pending end was waiting for. Either way it continues.
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
            # A refused room claim closed it on the way out; nothing began.
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
            # Synchronous teardown. The grace period is an optimisation.
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
        """Cancel any pending ends at shutdown, without reporting them: every
        agent disconnects at once, so a burst of ends is noise."""
        for session in self._sessions.values():
            if session.ending is not None:
                session.ending.cancel()
        self._sessions.clear()
        self._streaming.clear()
