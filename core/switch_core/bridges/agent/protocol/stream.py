"""The frames of an agent connection (CHOO-1857).

Turns a connection plus the event buffer into a sequence of frames: catch-up
from the client's cursor, then live delivery as events are appended. The client
never asks again; it opens once and reads. The WebSocket in
`api/handlers.py` sends them.

Every event says where it sits, so a client that reconnects can say how far it
got and resume exactly where it stopped. A client on agent-protocol revision 9
or later receives `position` on each event: the event's source and its number
there. The source is `s` for the agent's own events in `agent_events` (the
events meant for the agent, not ones it sent) or `r:<room_id>` for a room's
messages. An older client holds a single number, sent as `sequence`. For a
client that receives only the agent's own events it is the event's number among
them. For a client that receives every room message it is a ticket, a number
the server maps back to a full position when the client resumes. Gaps are
reported as their own event rather than skipped: a client that has missed
events must never see a stream that looks complete.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from switch_core.bridges.agent.protocol.agent_connections import (
    APPROVAL_OUTCOME_PROTOCOL_REVISION,
    HEARTBEAT_LAPSED,
    PROTOCOL_VERSION,
    TAKEN_OVER,
    AgentConnection,
    AgentConnectionRegistry,
    Closure,
)
from switch_core.bridges.agent.protocol.event_buffer import (
    BufferedEvent,
    CursorExpiredError,
    EventBuffer,
)
from switch_core.bridges.agent.protocol.positions import (
    OWN_EVENTS,
    Position,
    room_source,
)
from switch_core.observability.catalogue import BRIDGE_EVENTS_OUT
from switch_core.observability.metrics import metrics
from switch_core.tenant_context import current_tenant_id
from switch_core.version import server_declaration

if TYPE_CHECKING:
    from switch_core.session_activity.outcomes import ApprovalOutcomes, Outcome

logger = logging.getLogger(__name__)

# How long the loop waits for work before yielding an idle tick, so whoever
# reads it gets a chance to do its own periodic work.
KEEPALIVE_INTERVAL_SECONDS = 15.0

# Cap on how many buffered events are written in one batch, so a large catch-up
# cannot monopolise the loop.
CATCH_UP_BATCH = 200


@dataclass(frozen=True)
class Frame:
    """One message on an agent's event stream, before it is encoded.

    The loop decides what to send; the transport decides how it is encoded.
    """

    event: str
    data: dict[str, Any]
    seq: int | None = None


# Not a message: the loop's signal that it waited a keepalive interval with
# nothing to send. The WebSocket has its own ping and drops it.
KEEPALIVE = Frame("keepalive", {})


def _frame(event: str, data: dict[str, Any], *, seq: int | None = None) -> Frame:
    return Frame(event, data, seq)


def encode_ws(frame: Frame) -> dict[str, Any]:
    """A frame as a WebSocket message. `id` is the event's sequence number,
    which a reconnecting client passes back as `start_from`."""
    message: dict[str, Any] = {"event": frame.event, "data": frame.data}
    if frame.seq is not None:
        message["id"] = frame.seq
    return message


def _connection_state(conn: AgentConnection) -> dict[str, Any]:
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
        "position": dict(conn.position),
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


def event_frames(
    *,
    conn: AgentConnection,
    registry: AgentConnectionRegistry,
    buffer: EventBuffer,
    approvals: ApprovalOutcomes | None,
) -> AsyncGenerator[Frame]:
    """The connection's frames, for a transport to encode."""
    return _event_stream(
        conn=conn,
        registry=registry,
        buffer=buffer,
        approvals=approvals,
        generation=conn.stream_generation,
    )


async def _event_stream(
    *,
    conn: AgentConnection,
    registry: AgentConnectionRegistry,
    buffer: EventBuffer,
    approvals: ApprovalOutcomes | None,
    generation: int,
) -> AsyncGenerator[Frame]:
    """Yield frames for a connection until its stream is superseded or it dies."""
    if conn.stream_generation != generation:
        return
    agent_id = conn.agent_id
    bell = buffer.doorbell(agent_id)
    # Captured before the first yield: the generator suspends there, and any
    # subscription change that lands while it is suspended must still be
    # reported when it resumes.
    last_rooms = set(conn.rooms)

    tenant_id = current_tenant_id()
    if tenant_id is None:
        raise RuntimeError("An agent stream runs inside its agent's tenant")
    tenant: str = tenant_id

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

        unsubscribe_outcomes = approvals.subscribe(tenant, agent_id, owe, recheck)
        resync[0] = True
    # Rooms this stream has already passed to `EventBuffer.ensure_counting`,
    # which gives the agent an unread-count baseline for the room in
    # `agent_room_reads`. Each pass of the loop calls it only for rooms not in
    # this set, so it does not write to the database for every room each time.
    counted: set[str] = set()
    # A new row in a room whose conversation this stream reads rings no
    # doorbell of the agent's, so the stream asks each such room's own
    # announcement (`EventBuffer.rooms`) to wake it.
    rooms = _ConversationBells(buffer)
    last_keepalive = time.monotonic()
    try:
        if conn.reads_conversation:
            # The client learns its starting position from `connection_state`.
            # A client that reconnects before any room message arrives resumes
            # from that position, so each room must already be in it. A room
            # missing from it would start at the room's newest message on the
            # reconnect, and the messages sent in between would never arrive.
            await _place_in_conversation(conn, registry, buffer, tenant)
        yield _frame("connection_state", _connection_state(conn))

        for gap in await _opening_gaps(conn, buffer, tenant):
            yield _frame("gap", gap)

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

            if conn.session_commands:
                relayed = list(conn.session_commands)
                conn.session_commands.clear()
                for frame in relayed:
                    yield _frame("session_command", frame)

            if conn.released_rooms:
                released = dict(conn.released_rooms)
                conn.released_rooms.clear()
                for room_id, session_id in released.items():
                    yield _frame(
                        "room_released", {"room_id": room_id, "session_id": session_id}
                    )

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
                # — and the skip path advances the position, so it would consume
                # its way to the end of the agent's events while waiting for its
                # room.
                #
                # That window is not an edge case: a session spawned to answer a
                # message opens its connection *before* the session boots and
                # calls connect_to_room. Reading during it burns past the very
                # message the session was started for, which then never arrives.
                #
                # Park until a room is claimed. `claim_room` sets `wake`, so the
                # loop resumes the moment there is something to cover, with the
                # position still where it started.
                conn.wake.clear()
                if not conn.rooms and not await _wait_for_wake(conn):
                    yield KEEPALIVE
                continue

            # Give each room this connection covers an unread-count baseline at
            # the room's newest message if it has none yet. A room the
            # connection starts covering later gets its baseline when this loop
            # first sees it. This never takes the room's count from another
            # connection; that happens through `take_counting` when a connection
            # opens on a room or claims it, not on each pass here.
            for room_id in conn.rooms - counted:
                await buffer.ensure_counting(tenant, agent_id, conn.id, room_id)
                counted.add(room_id)

            conversation_rooms: set[str] = set()
            if conn.reads_conversation:
                conversation_rooms = await _place_in_conversation(
                    conn, registry, buffer, tenant
                )
            # Before the read, so a row written while it runs wakes the wait
            # below rather than being left for the keepalive.
            rooms.watch(conversation_rooms)

            try:
                pending, looked = await buffer.read(
                    tenant,
                    agent_id,
                    conn.position,
                    conversation_rooms=conversation_rooms,
                    notifiable_only=not conn.reads_conversation,
                    limit=CATCH_UP_BATCH,
                )
            except CursorExpiredError as exc:
                conn.position[OWN_EVENTS] = exc.resume_after
                yield _frame(
                    "gap",
                    await _gap(
                        conn,
                        buffer,
                        tenant,
                        from_sequence=exc.requested,
                        rooms=list(exc.rooms),
                        all_rooms=False,
                        reason=str(exc),
                    ),
                )
                continue

            # Room coverage is evaluated per event rather than up front: a
            # sibling claiming a room must take effect immediately, without
            # tearing the stream down. An event for a room this connection does
            # not cover is not sent, but the position still moves past it, in
            # order: only once every event before it has gone out, so the
            # position never says the client was sent an event that is still
            # to come. `covered` is the plan when the batch is read, which the
            # tickets are minted for: room messages are in it because
            # `_conversation_rooms` only returned rooms this connection covers.
            # Each event is checked again just before it is sent, because the
            # loop suspends at every yield and a sibling can claim the room
            # while it does. The check reads the registry in memory, so it
            # costs no query.
            covered = [
                item.source != OWN_EVENTS or registry.covers(conn, item.room_id)
                for item in pending
            ]
            tickets = await _tickets_for(conn, buffer, tenant, pending, covered)
            # The unread counts sent with the events below, counted for the
            # whole batch at once, so that catching up on a few hundred events
            # costs a few statements per room rather than several per event.
            missed = await buffer.unread_batch(
                tenant,
                agent_id,
                [
                    (item.room_id, item.room_seq)
                    for item, send in zip(pending, covered, strict=True)
                    if send and item.notifiable
                ],
            )
            delivered = False
            index = -1
            for item, send in zip(pending, covered, strict=True):
                if send:
                    # Counted before the re-check below, so a ticket stays
                    # with the event it was minted for even when an event
                    # before it in the batch is no longer sent.
                    index += 1
                if not send or not registry.covers(conn, item.room_id):
                    if item.seq > conn.position.get(item.source, -1):
                        conn.position[item.source] = item.seq
                    continue
                payload = item.event.model_dump(mode="json")
                frame_seq = _number_for(conn, item, tickets, index)
                if frame_seq is not None:
                    payload["sequence"] = frame_seq
                if conn.speaks_positions:
                    payload["position"] = {item.source: item.seq}
                if item.notifiable:
                    # Told on the way past, on the one event the agent is being
                    # woken for anyway. A count of its own would be a wake
                    # spent on "you may have missed something you may not care
                    # about".
                    unread = missed[(item.room_id, item.room_seq)]
                    payload["missed"] = {
                        "count": unread.count,
                        "reason": unread.reason,
                    }
                # Advance before yielding, because the position records what
                # the server has written out. Where the client resumes after a
                # drop is its own position, which it sends when it reopens.
                if item.seq > conn.position.get(item.source, -1):
                    conn.position[item.source] = item.seq
                if tickets:
                    conn.ticket = tickets[index]
                delivered = True
                metrics().increment(
                    BRIDGE_EVENTS_OUT,
                    {"bridge": "agent", "platform": "switch", "kind": item.event.type},
                )
                yield _frame(item.event.type, payload, seq=frame_seq)

            # Move the position past every row the read examined, including
            # rows it did not return: own events the `addressed` filter left
            # out, and room messages that are not conversation for this agent
            # (messages it sent, or ones already among its own events). Nothing
            # is lost, because the position records what the server has written
            # out, not what the agent has caught up on, and those rows still
            # count towards the agent's unread counts. If the position stayed
            # behind them, the "anything new?" check below would stay true and
            # the loop would spin instead of waiting.
            for source, seq in looked.items():
                if seq > conn.position.get(source, -1):
                    conn.position[source] = seq

            if delivered:
                continue

            bell.clear()
            conn.wake.clear()
            # Re-check after clearing: an event appended between the read above
            # and the clear would otherwise wait for the keepalive timeout.
            if (
                conn.session_commands
                or conn.released_rooms
                or outcomes
                or resync[0]
                or await buffer.head(tenant, agent_id)
                > conn.position.get(OWN_EVENTS, 0)
                or conn.rooms != last_rooms
            ):
                continue

            if await _wait_for_work(bell, conn, rooms.moved):
                continue
            if time.monotonic() - last_keepalive >= KEEPALIVE_INTERVAL_SECONDS:
                last_keepalive = time.monotonic()
                yield KEEPALIVE
    finally:
        rooms.watch(set())
        if unsubscribe_outcomes is not None:
            unsubscribe_outcomes()
        registry.detach_stream(conn, generation)


async def _gap(
    conn: AgentConnection,
    buffer: EventBuffer,
    tenant: str,
    *,
    from_sequence: int,
    rooms: list[str],
    all_rooms: bool,
    reason: str,
) -> dict[str, Any]:
    """Build a gap frame from the connection's current position.

    `resumed_position` is the position the stream continues from. `resumed_at`
    is the single number an older client adopts instead. For most clients it is
    the `s` entry, the place in the agent's own events. A client that receives
    every room message but holds a single number is sent a new ticket for the
    whole position. If that client were sent the `s` entry and later resumed
    from it, the server would treat the number as an own-events place only,
    start every room again at its newest message, and the client would never
    receive the room messages it had not read yet.
    """
    resumed_at = conn.position.get(OWN_EVENTS, 0)
    if conn.reads_conversation and not conn.speaks_positions:
        (resumed_at,) = await buffer.mint_tickets(
            tenant, conn.agent_id, [dict(conn.position)]
        )
        conn.ticket = resumed_at
    return {
        "from_sequence": from_sequence,
        "resumed_at": resumed_at,
        "resumed_position": dict(conn.position),
        "rooms": rooms,
        "all_rooms": all_rooms,
        "reason": reason,
    }


async def _opening_gaps(
    conn: AgentConnection, buffer: EventBuffer, tenant: str
) -> list[dict[str, Any]]:
    """Check the position the client resumed from, and return the gap frames
    to send before any event.

    A gap is due when the client resumed from a ticket the server does not
    have, from an own-events number issued before this agent's current
    numbering started, from a number past the newest of the agent's own events,
    from a room place past that room's newest message, or from a point older
    than the events still retained. Each case is reported rather than corrected
    quietly. A client that believes it is caught up when its numbers no longer
    mean anything would never re-read what it lost.
    """
    agent_id = conn.agent_id
    gaps: list[dict[str, Any]] = []
    if conn.resume_lost:
        conn.resume_lost = False
        gaps.append(
            await _gap(
                conn,
                buffer,
                tenant,
                from_sequence=conn.resume_requested,
                rooms=sorted(conn.rooms),
                all_rooms=True,
                reason="where you left off is no longer known to the server; "
                "re-read room context",
            )
        )
        return gaps

    at = conn.position.get(OWN_EVENTS, 0)
    head = await buffer.head(tenant, agent_id)
    floor = await buffer.first_seq(tenant, agent_id)
    if 0 < at < floor - 1:
        # The number is below where the numbering of this agent's own events
        # starts (`first_seq`), so an earlier server issued it and those events
        # are gone. New numbering always starts above every earlier number, so
        # the client's dedupe by sequence number stays valid. The client has
        # lost every event from before.
        logger.warning(
            "[STREAM] agent=%s connection=%s resumed from cursor %s of an "
            "earlier server boot (this agent's events start at %s)",
            agent_id,
            conn.id,
            at,
            floor,
        )
        conn.position[OWN_EVENTS] = floor - 1
        gaps.append(
            await _gap(
                conn,
                buffer,
                tenant,
                from_sequence=at,
                rooms=sorted(conn.rooms),
                all_rooms=True,
                reason="the server restarted since your last connection; "
                "events from before the restart are gone in every room, "
                "including any this connection has yet to claim — re-read "
                "room context",
            )
        )
        at = floor - 1
    elif at > head:
        logger.warning(
            "[STREAM] agent=%s connection=%s resumed from cursor %s but the "
            "agent's events only reach %s — treating as a restart",
            agent_id,
            conn.id,
            at,
            head,
        )
        conn.position[OWN_EVENTS] = head
        gaps.append(
            await _gap(
                conn,
                buffer,
                tenant,
                from_sequence=head,
                rooms=sorted(conn.rooms),
                all_rooms=True,
                reason="the server restarted since your last connection; "
                "sequence numbers have been reset and events from before "
                "the restart are gone in every room, including any this "
                "connection has yet to claim — re-read room context",
            )
        )
        at = head

    # A room place past the room's newest message comes from a history the
    # room no longer has, for example after a database restore. Positions never
    # move back, so if it were kept the stream would skip that many of the
    # room's next messages without telling the client.
    within, past = await buffer.within_rooms(tenant, conn.position)
    if past:
        logger.warning(
            "[STREAM] agent=%s connection=%s resumed past the end of rooms %s",
            agent_id,
            conn.id,
            ", ".join(past),
        )
        conn.position.update(within)
        gaps.append(
            await _gap(
                conn,
                buffer,
                tenant,
                from_sequence=at,
                rooms=past,
                all_rooms=False,
                reason="these rooms no longer reach where you left off; "
                "re-read room context",
            )
        )

    # If retention has deleted any of the agent's own events after the client's
    # number, report a gap instead of quietly moving the client to the newest
    # event. The client recovers by re-reading room context.
    try:
        await buffer.check_cursor(tenant, agent_id, at)
    except CursorExpiredError as exc:
        logger.warning(
            "[STREAM] agent=%s connection=%s resumed from expired cursor %s "
            "(oldest retained %s, rooms %s)",
            agent_id,
            conn.id,
            at,
            exc.oldest,
            ", ".join(exc.rooms),
        )
        conn.position[OWN_EVENTS] = exc.resume_after
        gaps.append(
            await _gap(
                conn,
                buffer,
                tenant,
                from_sequence=at,
                rooms=list(exc.rooms),
                all_rooms=False,
                reason="events older than the retention window were "
                "dropped; re-read room context",
            )
        )
    return gaps


async def _conversation_rooms(
    conn: AgentConnection,
    registry: AgentConnectionRegistry,
    buffer: EventBuffer,
    tenant: str,
) -> set[str]:
    """Return the rooms whose every message this connection receives.

    A session connection (scope `single`) receives the room it has claimed. A
    connection over all of the agent's rooms receives each room the agent is a
    member of, except rooms another connection of the same agent has claimed.
    """
    if conn.scope == "single":
        return set(conn.rooms)
    member = await buffer.member_rooms(tenant, conn.agent_id)
    return {room_id for room_id in member if registry.covers(conn, room_id)}


async def _place_in_conversation(
    conn: AgentConnection,
    registry: AgentConnectionRegistry,
    buffer: EventBuffer,
    tenant: str,
) -> set[str]:
    """Return the rooms whose conversation this connection receives, after
    giving each room it has no place in yet a place at the room's newest
    message.

    A room with no entry in the connection's position has never been read by
    this connection. Its earlier messages are history the agent can fetch with
    `read_context`; sending them all as new events would bury the agent in a
    backlog.
    """
    rooms = await _conversation_rooms(conn, registry, buffer, tenant)
    fresh = {room_id for room_id in rooms if room_source(room_id) not in conn.position}
    for room_id, head in (await buffer.room_heads(tenant, fresh)).items():
        conn.position[room_source(room_id)] = head
    return rooms


async def _tickets_for(
    conn: AgentConnection,
    buffer: EventBuffer,
    tenant: str,
    pending: list[BufferedEvent],
    covered: list[bool],
) -> list[int]:
    """Mint a ticket for each event about to be sent, for a client that
    receives every room message but holds a single number.

    `pending` is the batch in order and `covered` says which of its events
    are sent. Each ticket stands for the position just after its event,
    including the unsent events before it and none after it, so a client that
    reconnects with that number resumes after that event and misses nothing
    that comes later in the batch. Every other client gets an empty list.
    """
    if conn.speaks_positions or not conn.reads_conversation:
        return []
    positions: list[Position] = []
    position = dict(conn.position)
    for item, send in zip(pending, covered, strict=True):
        if item.seq > position.get(item.source, -1):
            position[item.source] = item.seq
        if send:
            positions.append(dict(position))
    if not positions:
        return []
    return await buffer.mint_tickets(tenant, conn.agent_id, positions)


def _number_for(
    conn: AgentConnection, item: BufferedEvent, tickets: list[int], index: int
) -> int | None:
    """Return the `sequence` number to send with a delivered event.

    When the client is sent tickets, the number is the event's ticket.
    Otherwise one of the agent's own events carries its number in
    `agent_events`, and a room message carries none, because a client that
    receives room messages without tickets speaks positions and reads the
    message's place from `position`.
    """
    if tickets:
        return tickets[index]
    if item.source == OWN_EVENTS:
        return item.seq
    return None


async def _wait_for_wake(conn: AgentConnection) -> bool:
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


async def _wait_for_work(
    bell: asyncio.Event, conn: AgentConnection, moved: asyncio.Event
) -> bool:
    """Wait for a new event, a new row in a room whose conversation the
    stream reads, or a change to the connection itself.

    Returns False when none happened within the keepalive interval, so the
    caller can read again or send a keepalive.
    """
    waiters = [
        asyncio.ensure_future(bell.wait()),
        asyncio.ensure_future(conn.wake.wait()),
        asyncio.ensure_future(moved.wait()),
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


class _ConversationBells:
    """The rooms whose new rows wake one stream, kept to the rooms whose
    conversation it reads.

    `moved` is set when any of them is announced, and cleared each time the
    rooms are given again, just before the stream reads: an announcement that
    lands during the read leaves it set, so the stream reads once more rather
    than sleeping on a row it has not seen. The rows themselves are read from
    the stream's own position, as everything here is.
    """

    def __init__(self, buffer: EventBuffer) -> None:
        self._rooms = buffer.rooms
        self._watched: set[str] = set()
        self.moved = asyncio.Event()

    async def _moved(self, _room_id: str) -> None:
        self.moved.set()

    def watch(self, rooms: set[str]) -> None:
        self.moved.clear()
        for room_id in rooms - self._watched:
            self._rooms.subscribe(room_id, self._moved)
        for room_id in self._watched - rooms:
            self._rooms.unsubscribe(room_id, self._moved)
        self._watched = set(rooms)
