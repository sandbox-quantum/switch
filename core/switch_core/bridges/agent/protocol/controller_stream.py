"""One stream per agents controller, sent on its socket
(`/v1/controllers/{id}/connection/ws`).

A read-side merge over the per-agent `EventBuffer`: every agent bound to the
controller is read from its own cursor, with nothing filtered (the controller
filters for each of its agents locally), and its events are written tagged
with the agent. There is no buffer per controller. Bindings that change while
the stream is open attach and detach agents on it live.

Frames carry `agent_id` wherever they are about one agent, and the agent's own
sequence where there is one. Each wraps the payload today's per-agent stream
would have written, unchanged, so the controller's local relay can hand each
of its agents' watchers exactly the stream it would have had from Switch:

- `connection_state`: first, and the stream's own.
- `agent.attached {agent_id, from_seq, rooms}`: the agent's events follow from
  `from_seq`.
- `agent.event {agent_id, seq, event}`: `event` is today's domain event data,
  `sequence` and `missed` included.
- `agent.gap {agent_id, from_sequence, resumed_at, rooms, all_rooms, reason}`.
- `agent.session_command {agent_id, room_id, command}`: an in-room command
  (`!reset`, `!compact`, `!interrupt`, a Stop press) for the session working in
  `room_id`, which the controller routes. `command` is today's frame.
- `agent.approval_outcome {agent_id, outcome}`.
- `agent.rooms {agent_id, rooms}`: its room membership changed.
- `agent.detached {agent_id, reason}`: `unassigned` or `deleted`.
- The management nudges, passed through as they come: `assignment.changed`,
  `operation.pending`, and `credential.revoked`, which ends the stream.
- `evicted {code, reason}`: the stream ends. `taken_over` is terminal for the
  client that receives it; the rest are recovered by opening again.

Frames are `{"event", "data"}` dicts, which the socket sends as JSON. When
nothing has happened for the idle interval the stream yields `IDLE`, which is
not sent: it only lets the loop look at the connection again.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from switch_core.bridges.agent.protocol.controller_presence import (
    DETACH_UNASSIGNED,
    ControllerConnection,
    ControllerPresence,
)
from switch_core.bridges.agent.protocol.event_buffer import (
    CursorExpiredError,
    EventBuffer,
)
from switch_core.bridges.agent.protocol.liveness import TAKEN_OVER, Closure
from switch_core.tenant_context import current_tenant_id

if TYPE_CHECKING:
    from switch_core.session_activity.outcomes import ApprovalOutcomes, Outcome

logger = logging.getLogger(__name__)

IDLE_INTERVAL_SECONDS = 15.0
CATCH_UP_BATCH = 200

ControllerFrame = dict[str, Any]
# Yielded when nothing happened for the idle interval; never sent.
IDLE: ControllerFrame = {"event": "idle", "data": {}}

# The nudge after which nothing more is written: the controller stops every
# agent on it and exits.
CREDENTIAL_REVOKED = "credential.revoked"


class ControllerNudges(Protocol):
    """Management's pending signals for one open stream, opaque to Core."""

    @property
    def wake(self) -> asyncio.Event: ...

    def drain(self) -> list[tuple[str, dict[str, Any]]]: ...

    def close(self) -> None: ...


def frame(event: str, data: dict[str, Any]) -> ControllerFrame:
    return {"event": event, "data": data}


@dataclass
class _Attached:
    """One agent on the stream: where its delivery has reached."""

    agent_id: str
    reader_id: str
    cursor: int
    outcomes: dict[tuple[str, str], Outcome] = field(default_factory=dict)
    resync: bool = False
    unsubscribe: Callable[[], None] | None = None


def _eviction(closure: Closure) -> dict[str, Any]:
    return {"code": closure.code, "reason": closure.message}


def controller_event_stream(
    *,
    conn: ControllerConnection,
    stream_token: int,
    presence: ControllerPresence,
    buffer: EventBuffer,
    approvals: ApprovalOutcomes | None,
    nudges: ControllerNudges,
    opening: dict[str, Any],
    rooms_of: Callable[[str], Awaitable[set[str]]],
    idle_seconds: float,
) -> AsyncGenerator[ControllerFrame]:
    """The stream for an open controller connection whose stream was just
    attached as `stream_token`. Takes ownership of `nudges` and closes it."""
    return _ControllerStream(
        conn=conn,
        stream_token=stream_token,
        presence=presence,
        buffer=buffer,
        approvals=approvals,
        nudges=nudges,
        rooms_of=rooms_of,
        idle_seconds=idle_seconds,
    ).run(opening)


class _ControllerStream:
    def __init__(
        self,
        *,
        conn: ControllerConnection,
        stream_token: int,
        presence: ControllerPresence,
        buffer: EventBuffer,
        approvals: ApprovalOutcomes | None,
        nudges: ControllerNudges,
        rooms_of: Callable[[str], Awaitable[set[str]]],
        idle_seconds: float,
    ) -> None:
        self._conn = conn
        self._token = stream_token
        self._presence = presence
        self._buffer = buffer
        self._approvals = approvals
        self._nudges = nudges
        self._rooms_of = rooms_of
        self._idle = idle_seconds
        self._tenant_id = current_tenant_id()
        self._attached: dict[str, _Attached] = {}

    async def run(self, opening: dict[str, Any]) -> AsyncGenerator[ControllerFrame]:
        conn = self._conn
        try:
            yield frame("connection_state", opening)
            while True:
                for event, data in self._nudges.drain():
                    yield frame(event, data)
                    if event == CREDENTIAL_REVOKED:
                        return

                ending = self._ending()
                if ending is not None:
                    # A revocation closes the connection and nudges together;
                    # the controller acts on the nudge, so it goes first.
                    for event, data in self._nudges.drain():
                        yield frame(event, data)
                        if event == CREDENTIAL_REVOKED:
                            return
                    yield frame("evicted", _eviction(ending))
                    return

                for raw in self._detach_departed():
                    yield raw
                for raw in await self._attach_arrivals():
                    yield raw

                for agent_id in sorted(self._presence.take_rooms_changed(conn)):
                    if agent_id in self._attached:
                        yield frame(
                            "agent.rooms",
                            {
                                "agent_id": agent_id,
                                "rooms": sorted(self._presence.rooms(agent_id)),
                            },
                        )

                for agent_id, command in self._presence.take_session_commands(conn):
                    origin = command.get("origin")
                    room_id = origin.get("roomId") if isinstance(origin, dict) else None
                    yield frame(
                        "agent.session_command",
                        {"agent_id": agent_id, "room_id": room_id, "command": command},
                    )

                for raw in await self._owed_outcomes():
                    yield raw

                delivered = False
                for attached in list(self._attached.values()):
                    for raw in self._deliver(attached):
                        delivered = True
                        yield raw
                if delivered:
                    continue

                if not await self._wait():
                    yield IDLE
        finally:
            for attached in self._attached.values():
                if attached.unsubscribe is not None:
                    attached.unsubscribe()
            self._nudges.close()
            self._presence.detach_stream(conn, self._token)

    def _ending(self) -> Closure | None:
        conn = self._conn
        if conn.closure is not None:
            return conn.closure
        if conn.stream_token != self._token:
            return TAKEN_OVER
        if not conn.is_live(time.monotonic()):
            logger.warning(
                "[CONTROLLER] controller=%s connection=%s beat lapsed — closing "
                "the stream rather than delivering to a controller nothing else "
                "considers live",
                conn.controller_id,
                conn.id,
            )
            self._presence.close_lapsed(conn)
            return conn.closure
        return None

    def _detach_departed(self) -> list[ControllerFrame]:
        conn = self._conn
        owed = self._presence.take_detached(conn)
        bound = self._presence.agents_of(conn.controller_id)
        frames: list[ControllerFrame] = []
        for agent_id in sorted(self._attached):
            if agent_id in bound and agent_id not in owed:
                continue
            attached = self._attached.pop(agent_id)
            # Bound here again later, it starts at its head: what it missed in
            # between was never this controller's.
            conn.resume_cursors.pop(agent_id, None)
            if attached.unsubscribe is not None:
                attached.unsubscribe()
            frames.append(
                frame(
                    "agent.detached",
                    {
                        "agent_id": agent_id,
                        "reason": owed.get(agent_id, DETACH_UNASSIGNED),
                    },
                )
            )
        return frames

    async def _attach_arrivals(self) -> list[ControllerFrame]:
        conn = self._conn
        frames: list[ControllerFrame] = []
        for agent_id in sorted(
            self._presence.agents_of(conn.controller_id) - set(self._attached)
        ):
            binding = self._presence.binding(agent_id)
            if binding is None:
                continue
            rooms = await self._rooms_of(agent_id)
            self._presence.set_rooms(agent_id, rooms)
            head = self._buffer.head(agent_id)
            requested = conn.resume_cursors.get(agent_id)
            cursor = head if requested is None else requested
            gaps: list[dict[str, Any]] = []
            if cursor > head:
                logger.warning(
                    "[CONTROLLER] controller=%s agent=%s resumed from cursor %s "
                    "but the buffer only reaches %s — treating as a restart",
                    conn.controller_id,
                    agent_id,
                    cursor,
                    head,
                )
                cursor = head
                self._buffer.mark_restarted(agent_id)
                gaps.append(
                    {
                        "agent_id": agent_id,
                        "from_sequence": head,
                        "resumed_at": head,
                        "rooms": sorted(rooms),
                        "all_rooms": True,
                        "reason": "the server restarted since your last connection; "
                        "sequence numbers have been reset and events from before "
                        "the restart are gone in every room — re-read room context",
                    }
                )
            lost = self._buffer.rooms_dropped_after(agent_id, cursor)
            if lost:
                resumed_at = max(self._buffer.oldest_retained(agent_id) - 1, 0)
                gaps.append(
                    {
                        "agent_id": agent_id,
                        "from_sequence": cursor,
                        "resumed_at": resumed_at,
                        "rooms": list(lost),
                        "all_rooms": False,
                        "reason": "events older than the retention window were "
                        "dropped; re-read room context",
                    }
                )
                cursor = resumed_at
            conn.resume_cursors[agent_id] = cursor
            attached = _Attached(
                agent_id=agent_id,
                reader_id=self._presence.holder_id(binding),
                cursor=cursor,
            )
            self._subscribe_outcomes(attached)
            self._attached[agent_id] = attached
            # The conversation this reader has not seen starts where its
            # delivery does, which is what the per-agent stream counts from.
            for room_id in rooms:
                self._buffer.ensure_counting(
                    agent_id, attached.reader_id, room_id, cursor
                )
            frames.append(
                frame(
                    "agent.attached",
                    {"agent_id": agent_id, "from_seq": cursor, "rooms": sorted(rooms)},
                )
            )
            frames.extend(frame("agent.gap", gap) for gap in gaps)
        return frames

    def _subscribe_outcomes(self, attached: _Attached) -> None:
        if self._approvals is None or self._tenant_id is None:
            return

        def owe(outcome: Outcome) -> None:
            attached.outcomes[(outcome["session_id"], outcome["request_id"])] = outcome
            self._conn.wake.set()

        def recheck() -> None:
            attached.resync = True
            self._conn.wake.set()

        attached.unsubscribe = self._approvals.subscribe(
            self._tenant_id, attached.agent_id, owe, recheck
        )
        attached.resync = True

    async def _owed_outcomes(self) -> list[ControllerFrame]:
        frames: list[ControllerFrame] = []
        for attached in list(self._attached.values()):
            if attached.resync and self._approvals is not None:
                attached.resync = False
                for outcome in await self._approvals.undelivered(attached.agent_id):
                    attached.outcomes[
                        (outcome["session_id"], outcome["request_id"])
                    ] = outcome
            owed = list(attached.outcomes.values())
            attached.outcomes.clear()
            frames.extend(
                frame(
                    "agent.approval_outcome",
                    {"agent_id": attached.agent_id, "outcome": outcome},
                )
                for outcome in owed
            )
        return frames

    def _deliver(self, attached: _Attached) -> list[ControllerFrame]:
        agent_id = attached.agent_id
        for room_id in self._presence.rooms(agent_id):
            self._buffer.ensure_counting(
                agent_id, attached.reader_id, room_id, attached.cursor
            )
        try:
            pending = self._buffer.read_from(
                agent_id, attached.cursor, limit=CATCH_UP_BATCH
            )
        except CursorExpiredError as exc:
            resumed_at = max(exc.oldest - 1, 0)
            attached.cursor = resumed_at
            return [
                frame(
                    "agent.gap",
                    {
                        "agent_id": agent_id,
                        "from_sequence": exc.requested,
                        "resumed_at": resumed_at,
                        "rooms": list(exc.rooms),
                        "all_rooms": False,
                        "reason": str(exc),
                    },
                )
            ]
        if not pending:
            # Events above the cursor that are no longer held — a room the
            # agent left takes its events with it — are passed, or every pass
            # would find work it can never read and spin.
            attached.cursor = max(attached.cursor, self._buffer.head(agent_id))
            return []
        frames: list[ControllerFrame] = []
        for item in pending:
            data = item.event.model_dump(mode="json")
            data["sequence"] = item.seq
            if item.notifiable:
                unread = self._buffer.unread(agent_id, item.room_id, item.seq)
                data["missed"] = {"count": unread.count, "reason": unread.reason}
            attached.cursor = item.seq
            frames.append(
                frame(
                    "agent.event",
                    {"agent_id": agent_id, "seq": item.seq, "event": data},
                )
            )
        return frames

    def _has_work(self) -> bool:
        conn = self._conn
        return (
            conn.closure is not None
            or conn.stream_token != self._token
            or bool(conn.detached or conn.rooms_changed or conn.session_commands)
            or self._presence.agents_of(conn.controller_id) != set(self._attached)
            or any(a.outcomes or a.resync for a in self._attached.values())
            or any(
                self._buffer.head(a.agent_id) > a.cursor
                for a in self._attached.values()
            )
        )

    async def _wait(self) -> bool:
        """Wait for an event, a nudge or a change to the connection. False when
        the idle interval passed with none of them."""
        bells = [self._buffer.doorbell(agent_id) for agent_id in self._attached]
        for bell in bells:
            bell.clear()
        self._conn.wake.clear()
        # Re-checked after clearing: anything that arrived between the last
        # read and the clear would otherwise wait for the idle timeout.
        if self._has_work() or self._nudges.wake.is_set():
            return True
        waiters = [
            asyncio.ensure_future(event.wait())
            for event in (*bells, self._conn.wake, self._nudges.wake)
        ]
        try:
            done, _ = await asyncio.wait(
                waiters, timeout=self._idle, return_when=asyncio.FIRST_COMPLETED
            )
            return bool(done)
        finally:
            for waiter in waiters:
                waiter.cancel()
