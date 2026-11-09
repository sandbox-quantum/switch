"""Reporting an agent coming online and going offline (`agent_connected` /
`agent_disconnected`), which is not the same as a connection, and not a
coding-agent session either: hosts report those (`telemetry/session_start.py`).

Two ordinary things make an agent hold a succession of short connections while
being continuously present: a stream rejected at the room claim and retried,
and a stream whose heartbeat lapsed (`HEARTBEAT_TTL_SECONDS`) closing itself so
the client reopens. Per connection, both read as a session every few seconds.

So this reports on the **agent**: it comes online when one that had no live
connection acquires its first, and goes offline only once it has had none for
`_RECONNECT_GRACE_SECONDS`. The grace is how long it waits to be sure, not part
of the time online: the offline event is dated, and the time online measured,
to the moment the last connection closed.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime

from switch_core.bridges.agent.protocol.agent_connections import (
    HEARTBEAT_TTL_SECONDS,
    UNRECORDED,
    AgentConnection,
    AgentConnectionRegistry,
    Closure,
)
from switch_core.db.models import Agent
from switch_core.telemetry import TelemetryService, emit_safely
from switch_core.telemetry.service import emit_safely_at
from switch_core.telemetry.snapshot import normalise_known_agent_type

logger = logging.getLogger(__name__)

# Several times the heartbeat TTL, because the reconnect this absorbs is
# triggered by that TTL lapsing. Too tight and every lapse is a new session.
_RECONNECT_GRACE_SECONDS = HEARTBEAT_TTL_SECONDS * 4


def end_reason(closure: Closure | None) -> str:
    """Why an agent went offline, as `agent_disconnected` reports it.

    `normal` for a close Switch made on purpose: the agent deleted, its key
    re-issued, it moved onto an agent controller, its controller revoked.
    `room_claimed` for a stream closed because a room it declared could not be
    served to it. `replaced` for another stream taking the connection over,
    `heartbeat_lapsed` for a client that stopped beating, and `error` for a
    connection that could not be recorded, or that closed with no reason at
    all, which should not happen.
    """
    if closure is None or closure is UNRECORDED:
        return "error"
    if closure.code == "heartbeat_lapsed":
        return "heartbeat_lapsed"
    if closure.code in ("taken_over", "launch_superseded"):
        return "replaced"
    if closure.room_id is not None:
        return "room_claimed"
    return "normal"


class _Session:
    __slots__ = ("started_at", "runtime", "ending")

    def __init__(self, started_at: float, runtime: str) -> None:
        self.started_at = started_at
        self.runtime = runtime
        # The task waiting out the grace period, if the agent currently holds
        # no connection. Cancelled by a reconnect.
        self.ending: asyncio.Task[None] | None = None


class SessionReporter:
    """Reports agents coming online and going offline, coalescing the
    connections that make up each stretch online."""

    def __init__(
        self,
        telemetry: TelemetryService | None,
        connections: AgentConnectionRegistry | None = None,
    ) -> None:
        self._telemetry = telemetry
        self._connections = connections
        # AgentConnection ids whose stream was actually handed back. A connection
        # closed before that — a rejected room claim — is not part of any
        # session and must not end one.
        self._streaming: set[str] = set()
        self._sessions: dict[str, _Session] = {}

    async def started(self, agent: Agent, conn: AgentConnection) -> None:
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
        emit_safely(self._telemetry, "agent_connected", {"known_agent_type": runtime})
        if self._telemetry is not None:
            await self._telemetry.emit_milestone(
                "first_agent_connected", known_agent_type=runtime
            )

    def on_close(self, conn: AgentConnection) -> None:
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

        reason = end_reason(conn.closure)
        closed = time.monotonic()
        closed_at = datetime.now(UTC)
        try:
            session.ending = asyncio.get_running_loop().create_task(
                self._end_after_grace(conn.agent_id, reason, closed, closed_at)
            )
        except RuntimeError:
            # Synchronous teardown. The grace period is an optimisation.
            self._report_end(conn.agent_id, reason, closed, closed_at)

    async def _end_after_grace(
        self, agent_id: str, reason: str, closed: float, closed_at: datetime
    ) -> None:
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
        self._report_end(agent_id, reason, closed, closed_at)

    def _report_end(
        self, agent_id: str, reason: str, closed: float, closed_at: datetime
    ) -> None:
        """`closed` and `closed_at` are when the last connection closed, on
        the monotonic clock for the duration and the wall clock for the date."""
        session = self._sessions.pop(agent_id, None)
        if session is None:
            return
        emit_safely_at(
            self._telemetry,
            "agent_disconnected",
            closed_at,
            {
                "duration_seconds": max(closed - session.started_at, 0.0),
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
