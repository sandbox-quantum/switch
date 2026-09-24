"""Server-sent event stream for agent connections (CHOO-1857).

Turns a connection plus the event buffer into a `text/event-stream`: catch-up
from the client's cursor, then live delivery as events are appended. The client
never asks again — it opens once and reads.

Every event carries its sequence number as the SSE `id`, so a client that
reconnects sends `Last-Event-ID` and resumes exactly where it stopped. Gaps are
reported as their own event rather than skipped: a client that has missed
events must never see a stream that looks complete.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from contextlib import nullcontext
from typing import TYPE_CHECKING, Any

from switch_core.bridges.agent.protocol.connections import (
    APPROVAL_OUTCOME_PROTOCOL_REVISION,
    HEARTBEAT_LAPSED,
    PROTOCOL_VERSION,
    TAKEN_OVER,
    Closure,
    Connection,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import (
    CursorExpiredError,
    EventBuffer,
)
from switch_core.sessions.command_notifications import subscribe
from switch_core.tenant_context import current_tenant_id
from switch_core.version import server_declaration

if TYPE_CHECKING:
    from switch_core.session_activity.outcomes import ApprovalOutcomes, Outcome

logger = logging.getLogger(__name__)

# How long to wait for an event before writing a keepalive comment. This exists
# only to stop proxies dropping an idle connection — liveness comes from the
# client's heartbeat, never from this.
KEEPALIVE_INTERVAL_SECONDS = 15.0

# Cap on how many buffered events are written in one batch, so a large catch-up
# cannot monopolise the loop.
CATCH_UP_BATCH = 200


def _frame(event: str, data: dict[str, Any], *, seq: int | None = None) -> bytes:
    lines = []
    if seq is not None:
        lines.append(f"id: {seq}")
    lines.append(f"event: {event}")
    lines.append(f"data: {json.dumps(data, separators=(',', ':'))}")
    return ("\n".join(lines) + "\n\n").encode()


def _connection_state(conn: Connection) -> dict[str, Any]:
    """The first frame of every stream, and where the server declares itself.

    Version disclosure rides this frame rather than an endpoint of its own
    (CHOO-1865): the stream is already authenticated, and nothing about the
    server's version is reachable without authenticating. `protocol` stays as
    it was — clients read it today — and equals the server's `speaks`.

    `server.version` is null when switch-core cannot read its own version.
    Null means unknown and must be rendered as such, never as current.
    """
    return {
        "connection_id": conn.id,
        "agent_id": conn.agent_id,
        # Which incarnation of the id this stream is. The client sends it back
        # on every heartbeat, which is what lets the server tell the holder of
        # a connection from a client that has been displaced from it — the two
        # are otherwise identical on the wire.
        "generation": conn.stream_generation,
        "scope": conn.scope,
        "filter": conn.delivery_filter,
        "spawn_capable": conn.spawn_capable,
        "rooms": sorted(conn.rooms),
        "cursor": conn.cursor,
        "protocol": PROTOCOL_VERSION,
        "heartbeat_interval_seconds": 2.0,
        "server": server_declaration("agent-protocol"),
        # Echoed back so a client can see what the server understood it to
        # have said — a declaration that silently failed to parse is worse
        # than one never sent, because both sides think it landed.
        "client": conn.declaration.as_dict(),
    }


def _eviction(closure: Closure) -> dict[str, Any]:
    """The evicted frame: a code to act on, prose to read, a room when one applies."""
    return {
        "code": closure.code,
        "reason": closure.message,
        "room_id": closure.room_id,
    }


def event_stream(
    *,
    conn: Connection,
    registry: ConnectionRegistry,
    buffer: EventBuffer,
    approvals: ApprovalOutcomes | None,
) -> AsyncIterator[bytes]:
    return _event_stream(
        conn=conn,
        registry=registry,
        buffer=buffer,
        approvals=approvals,
        generation=conn.stream_generation,
    )


async def _event_stream(
    *,
    conn: Connection,
    registry: ConnectionRegistry,
    buffer: EventBuffer,
    approvals: ApprovalOutcomes | None,
    generation: int,
) -> AsyncIterator[bytes]:
    """Yield SSE frames for a connection until its stream is superseded or it dies."""
    if conn.stream_generation != generation:
        return
    agent_id = conn.agent_id
    bell = buffer.doorbell(agent_id)
    # Captured before the first yield: the generator suspends there, and any
    # subscription change that lands while it is suspended must still be
    # reported when it resumes.
    last_rooms = set(conn.rooms)

    commands: set[str] = set()

    def wake_commands(session_id: str) -> None:
        commands.add(session_id)
        conn.wake.set()

    tenant_id = current_tenant_id()
    subscription = (
        subscribe(tenant_id, agent_id, wake_commands)
        if tenant_id is not None and conn.scope == "all"
        else nullcontext()
    )
    subscription.__enter__()

    # Approval answers and expiries, for the agent's own stream only: the
    # watcher that routes work to its sessions. Owed ones are read on opening
    # and on every resync; live ones arrive pushed. Keyed so a resync that
    # overlaps a live push sends each outcome once per pass.
    outcomes: dict[tuple[str, str], Outcome] = {}
    resync = [False]
    unsubscribe_outcomes = None
    speaks = conn.declaration.speaks
    if (
        approvals is not None
        and tenant_id is not None
        and conn.scope == "all"
        and speaks is not None
        and speaks >= APPROVAL_OUTCOME_PROTOCOL_REVISION
    ):

        def owe(outcome: Outcome) -> None:
            outcomes[(outcome["session_id"], outcome["request_id"])] = outcome
            conn.wake.set()

        def recheck() -> None:
            resync[0] = True
            conn.wake.set()

        unsubscribe_outcomes = approvals.subscribe(tenant_id, agent_id, owe, recheck)
        resync[0] = True
    try:
        yield _frame("connection_state", _connection_state(conn))

        # A cursor ahead of everything we hold is a cursor from a previous
        # life of this process: the buffer is in memory, so a restart resets
        # the sequence. Say so. Staying quiet would leave the client believing
        # it is caught up when its numbering no longer means anything.
        head = buffer.head(agent_id)
        if conn.cursor > head:
            logger.warning(
                "[STREAM] agent=%s connection=%s resumed from cursor %s but the "
                "buffer only reaches %s — treating as a restart",
                agent_id,
                conn.id,
                conn.cursor,
                head,
            )
            conn.cursor = head
            # Every room of this agent loses its baseline with the buffer that
            # held it, not only the rooms this connection has named — it may
            # have named none, and its sessions claim theirs later. Starting a
            # fresh baseline for any of them would answer the next "how far
            # behind am I in this room" with a zero the agent has no reason to
            # doubt.
            buffer.mark_restarted(agent_id)
            yield _frame(
                "gap",
                {
                    "from_sequence": head,
                    "resumed_at": head,
                    "rooms": sorted(conn.rooms),
                    "all_rooms": True,
                    "reason": "the server restarted since your last connection; "
                    "sequence numbers have been reset and events from before "
                    "the restart are gone in every room, including any this "
                    "connection has yet to claim — re-read room context",
                },
            )

        # A cursor the buffer can no longer serve is reported, not silently
        # moved to head. The client re-reads room context to recover.
        lost = buffer.rooms_dropped_after(agent_id, conn.cursor)
        if lost:
            oldest = buffer.oldest_retained(agent_id)
            logger.warning(
                "[STREAM] agent=%s connection=%s resumed from expired cursor %s "
                "(oldest retained %s, rooms %s)",
                agent_id,
                conn.id,
                conn.cursor,
                oldest,
                ", ".join(lost),
            )
            resumed_at = max(oldest - 1, 0)
            conn.cursor = resumed_at
            yield _frame(
                "gap",
                {
                    "from_sequence": conn.cursor,
                    "resumed_at": resumed_at,
                    "rooms": list(lost),
                    "all_rooms": False,
                    "reason": "events older than the retention window were "
                    "dropped; re-read room context",
                },
            )

        while True:
            if conn.stream_generation != generation:
                # Another stream took this connection over.
                yield _frame("evicted", _eviction(TAKEN_OVER))
                return
            if conn.closure is not None:
                yield _frame("evicted", _eviction(conn.closure))
                return
            if not conn.is_alive(time.monotonic()):
                # Delivering to a connection whose heartbeat has lapsed is the
                # worst of both worlds: every presence reader treats it as dead
                # (they filter on liveness), so the agent is reported offline
                # while its socket keeps handing it events. That combination is
                # invisible from either side — the client sees traffic and
                # believes it is fine, the room is told nobody is home.
                logger.warning(
                    "[STREAM] agent=%s connection=%s heartbeat lapsed — closing "
                    "the stream rather than delivering to a connection nothing "
                    "else considers alive",
                    agent_id,
                    conn.id,
                )
                registry.close(conn.id, HEARTBEAT_LAPSED)
                yield _frame("evicted", _eviction(HEARTBEAT_LAPSED))
                return

            if commands:
                session_ids = sorted(commands)
                commands.clear()
                yield _frame("session_commands", {"session_ids": session_ids})

            if conn.session_commands:
                relayed = list(conn.session_commands)
                conn.session_commands.clear()
                for frame in relayed:
                    yield _frame("session_command", frame)

            if resync[0] and approvals is not None:
                resync[0] = False
                for outcome in await approvals.undelivered(agent_id):
                    outcomes[(outcome["session_id"], outcome["request_id"])] = outcome
            if outcomes:
                owed = list(outcomes.values())
                outcomes.clear()
                for outcome in owed:
                    yield _frame("approval_outcome", outcome)

            if conn.rooms != last_rooms:
                last_rooms = set(conn.rooms)
                yield _frame(
                    "subscription_changed",
                    {"rooms": sorted(last_rooms), "reason": "subscription updated"},
                )

            if conn.scope == "single" and not conn.rooms:
                # A session connection that has not claimed a room yet must not
                # read. It would find every event uncovered — it covers nothing
                # — and the skip path advances the cursor, so it would consume
                # its way to the end of the buffer while waiting for its room.
                #
                # That window is not an edge case: a session spawned to answer a
                # message opens its connection *before* the session boots and
                # calls connect_to_room. Reading during it burns past the very
                # message the session was started for, which then never arrives.
                #
                # Park until a room is claimed. `claim_room` sets `wake`, so the
                # loop resumes the moment there is something to cover, with the
                # cursor still where it started.
                conn.wake.clear()
                if not conn.rooms and not await _wait_for_wake(conn):
                    yield b": keepalive\n\n"
                continue

            # Where counting starts for a room nothing is counting yet. It is
            # the cursor rather than head because the backlog this connection
            # is about to work through is backlog it genuinely has not seen; a
            # room covered later starts from wherever the cursor has reached by
            # then, which is the same rule. Covering is not taking: the room
            # slot changes hands at the doors, not on every pass of this loop.
            for room_id in conn.rooms:
                buffer.ensure_counting(agent_id, conn.id, room_id, conn.cursor)

            try:
                pending = buffer.read_from(
                    agent_id,
                    conn.cursor,
                    notifiable_only=conn.delivery_filter == "addressed",
                    limit=CATCH_UP_BATCH,
                )
            except CursorExpiredError as exc:
                yield _frame(
                    "gap",
                    {
                        "from_sequence": exc.requested,
                        "resumed_at": max(exc.oldest - 1, 0),
                        "rooms": list(exc.rooms),
                        "all_rooms": False,
                        "reason": str(exc),
                    },
                )
                conn.cursor = max(exc.oldest - 1, 0)
                continue

            if not pending:
                # Nothing above the cursor is for this connection: the filter
                # excluded all of it. Advance past it anyway.
                #
                # `read_from` does not return filtered-out events, so the cursor
                # cannot advance through them the way it does for events skipped
                # by room coverage below. Leaving it behind them makes the
                # "anything new?" re-check further down permanently true, and
                # this loop spins at full speed instead of waiting — starving the
                # event loop, so no heartbeat is processed, so every connection
                # in the process is declared dead and reconnects, forever.
                #
                # Nothing is lost by moving past them: the cursor records what
                # has been written out, not what the agent has caught up on.
                # The events stay in the buffer and each room's watermark stays
                # where it was, so what was skipped here is still countable.
                #
                # An empty result means the scan reached the end without hitting
                # the batch limit, so head is exactly how far we have looked.
                head = buffer.head(agent_id)
                if head > conn.cursor:
                    conn.cursor = head

            delivered = False
            for item in pending:
                # Room coverage is evaluated per event rather than up front: a
                # sibling claiming a room must take effect immediately, without
                # tearing the stream down.
                if not registry.covers(conn, item.room_id):
                    conn.cursor = item.seq
                    continue
                payload = item.event.model_dump(mode="json")
                payload["sequence"] = item.seq
                if item.notifiable:
                    # Told on the way past, on the one event the agent is being
                    # woken for anyway. A count of its own would be a wake
                    # spent on "you may have missed something you may not care
                    # about".
                    unread = buffer.unread(agent_id, item.room_id, item.seq)
                    payload["missed"] = {
                        "count": unread.count,
                        "reason": unread.reason,
                    }
                # Advance before yielding: the cursor tracks what the server has
                # written out. What the client has actually processed comes back
                # on its heartbeat, which is the value that governs resume.
                conn.cursor = item.seq
                delivered = True
                yield _frame(item.event.type, payload, seq=item.seq)

            if delivered:
                continue

            bell.clear()
            conn.wake.clear()
            # Re-check after clearing: an event appended between the read above
            # and the clear would otherwise wait for the keepalive timeout.
            if (
                commands
                or outcomes
                or resync[0]
                or buffer.head(agent_id) > conn.cursor
                or conn.rooms != last_rooms
            ):
                continue

            if not await _wait_for_work(bell, conn):
                yield b": keepalive\n\n"
    finally:
        subscription.__exit__(None, None, None)
        if unsubscribe_outcomes is not None:
            unsubscribe_outcomes()
        registry.detach_stream(conn, generation)


async def _wait_for_wake(conn: Connection) -> bool:
    """Wait for the connection itself to change — a room claim, or a close.

    Deliberately not waiting on the event bell: a parked connection covers
    nothing, so new events are not news to it, and waking for each one would
    spin through a busy room for no reason.
    """
    try:
        await asyncio.wait_for(conn.wake.wait(), timeout=KEEPALIVE_INTERVAL_SECONDS)
        return True
    except TimeoutError:
        return False


async def _wait_for_work(bell: asyncio.Event, conn: Connection) -> bool:
    """Wait for a new event or a change to the connection itself.

    Returns False when neither happened before the keepalive interval, so the
    caller can write a comment and keep the socket warm.
    """
    waiters = [
        asyncio.ensure_future(bell.wait()),
        asyncio.ensure_future(conn.wake.wait()),
    ]
    try:
        done, _ = await asyncio.wait(
            waiters,
            timeout=KEEPALIVE_INTERVAL_SECONDS,
            return_when=asyncio.FIRST_COMPLETED,
        )
        return bool(done)
    finally:
        for waiter in waiters:
            waiter.cancel()
