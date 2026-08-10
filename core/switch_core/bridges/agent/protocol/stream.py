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
from typing import Any

from switch_core.bridges.agent.protocol.connections import (
    PROTOCOL_VERSION,
    Connection,
    ConnectionRegistry,
)
from switch_core.bridges.agent.protocol.event_buffer import (
    CursorExpiredError,
    EventBuffer,
)
from switch_core.version import server_declaration

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


async def event_stream(
    *,
    conn: Connection,
    registry: ConnectionRegistry,
    buffer: EventBuffer,
) -> AsyncIterator[bytes]:
    """Yield SSE frames for a connection until its stream is superseded or it dies."""
    generation = conn.stream_generation
    agent_id = conn.agent_id
    bell = buffer.doorbell(agent_id)
    # Captured before the first yield: the generator suspends there, and any
    # subscription change that lands while it is suspended must still be
    # reported when it resumes.
    last_rooms = set(conn.rooms)

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
            yield _frame(
                "gap",
                {
                    "from_sequence": head,
                    "resumed_at": head,
                    "reason": "the server restarted since your last connection; "
                    "sequence numbers have been reset and events from before "
                    "the restart are gone — re-read room context",
                },
            )

        # A cursor the buffer can no longer serve is reported, not silently
        # moved to head. The client re-reads room context to recover.
        if buffer.has_gap_before(agent_id, conn.cursor):
            oldest = buffer.oldest_retained(agent_id)
            logger.warning(
                "[STREAM] agent=%s connection=%s resumed from expired cursor %s "
                "(oldest retained %s)",
                agent_id,
                conn.id,
                conn.cursor,
                oldest,
            )
            resumed_at = max(oldest - 1, 0)
            conn.cursor = resumed_at
            yield _frame(
                "gap",
                {
                    "from_sequence": conn.cursor,
                    "resumed_at": resumed_at,
                    "reason": "events older than the retention window were "
                    "dropped; re-read room context",
                },
            )

        while True:
            if conn.stream_generation != generation:
                # Another stream took this connection over.
                yield _frame(
                    "evicted",
                    {"reason": "another stream attached to this connection"},
                )
                return
            if conn.closed_reason is not None:
                yield _frame("evicted", {"reason": conn.closed_reason})
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
                registry.close(conn.id, "heartbeat lapsed")
                yield _frame(
                    "evicted",
                    {
                        "reason": "heartbeat lapsed; reopen the stream and resume "
                        "from your cursor"
                    },
                )
                return

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
            if buffer.head(agent_id) > conn.cursor or conn.rooms != last_rooms:
                continue

            if not await _wait_for_work(bell, conn):
                yield b": keepalive\n\n"
    finally:
        registry.detach_stream(conn.id, generation)


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
