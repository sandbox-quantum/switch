"""SSE delivery: catch-up, live push, resume and the control events (CHOO-1857).

A stream carries two kinds of event. The agent's own (a message addressed to
it, a command, a task) are kept for it and numbered in its own sequence; here
they are kept with `_keep`. The rest of a room's conversation is read from the
room's own log, which a test writes with `say`.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core import version as version_module
from switch_core.bridges.agent.protocol import stream as stream_module
from switch_core.bridges.agent.protocol.agent_connections import (
    HEARTBEAT_LAPSED,
    HEARTBEAT_TTL_SECONDS,
    POSITIONS_PROTOCOL_REVISION,
    PROTOCOL_ACCEPTS,
    PROTOCOL_VERSION,
    AgentConnectionRegistry,
    ClientDeclaration,
    Closure,
)
from switch_core.bridges.agent.protocol.event_buffer import (
    NO_BASELINE,
    TICKET_FLOOR,
    EventBuffer,
)
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS, room_source
from switch_core.bridges.agent.protocol.stream import (
    KEEPALIVE,
    Frame,
    encode_sse,
    encode_ws,
    event_frames,
    sse_stream,
)
from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    CommandPayload,
    MessagePayload,
)
from switch_core.db.models import TENANT_ZERO_ID, Agent, Message
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_store import RoomStore
from switch_core.messages.notify import MessageListener
from switch_core.observability.metrics import MetricsRegistry, install, uninstall
from tests.db_buffer import (
    age_events,
    db_buffer_on,
    forget_room,
    say,
    seed_member,
    sender_of,
)

AGENT = "agent-1"
ROOM_A = "room-a"
ROOM_B = "room-b"


@pytest.fixture(autouse=True)
async def _agent_rows(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """The agents every stream here is for, in their rooms, so their events
    have a row to belong to and their rooms a conversation to read."""
    await seed_member(session_factory, AGENT, ROOM_A)
    await seed_member(session_factory, AGENT, ROOM_B)
    await seed_member(session_factory, "agent-2", ROOM_A)


def _message(
    body: str, *, room: str = ROOM_A, message_id: str | None = None
) -> AgentEvent:
    """A message addressed to the agent: one of its own events."""
    return AgentEvent(
        type="message",
        room_id=room,
        payload=MessagePayload(
            addressed=True,
            sender="@u:s",
            sender_name="u",
            message_id=message_id or f"$evt-{body}",
            body=body,
            timestamp=0,
        ),
    )


def _command(name: str, *, room: str = ROOM_A) -> AgentEvent:
    """A command sent to the agent: one of its own events, and never one it is
    woken for."""
    return AgentEvent(
        type="command",
        room_id=room,
        payload=CommandPayload(command=name, user_id="@u:s", user_name="u"),
    )


@pytest.fixture
def db_buffer(
    session_factory: async_sessionmaker[AsyncSession], room_bells: MessageListener
) -> EventBuffer:
    """The db-buffer, with its rooms' announcements listened to: a stream that
    reads a room's conversation is woken by a row written there, not by a
    timer, so a test that writes one while a stream waits needs them."""
    return db_buffer_on(session_factory, rooms=room_bells)


async def _keep(buffer: EventBuffer, event: AgentEvent, *, agent: str = AGENT) -> int:
    """Keep `event` as one of the agent's own events and return its number.

    No row in the room's log stands behind it (`room_seq` 0), which is all a
    test that does not count the room needs; `_addressed` writes the row too.
    """
    key = (
        event.payload.message_id if isinstance(event.payload, MessagePayload) else None
    )
    return await buffer.enqueue(
        TENANT_ZERO_ID, agent, event.room_id, event, room_seq=0, message_key=key
    )


async def _addressed(
    session_factory: async_sessionmaker[AsyncSession],
    buffer: EventBuffer,
    body: str,
    *,
    room: str = ROOM_A,
) -> Message:
    """A message addressed to the agent, as one really arrives: a row in the
    room's log, and the event the agent's consumer keeps for it, naming that
    row. Returns the row.

    Only while no stream that reads the conversation is running: a test's rows
    are settled at once, so one reading in between would take this row for
    conversation before its event lands.
    """
    row = await say(session_factory, room, body)
    await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        room,
        _message(body, room=room, message_id=row.transport_event_id),
        room_seq=row.seq,
        message_key=row.transport_event_id,
    )
    return row


async def _leave(session_factory: async_sessionmaker[AsyncSession], room: str) -> None:
    """Take the agent out of the room's membership, as removing it does."""
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        client_id = await session.scalar(
            select(Agent.client_id).where(Agent.id == AGENT)
        )
        assert client_id is not None
        await RoomStore().remove_client(session, client_id, room)
        await session.commit()


async def _until(check: Callable[[], Any], timeout: float = 2.0) -> None:
    """Wait for the stream to have done something it sends no frame for."""

    async def poll() -> None:
        while True:
            done = check()
            if inspect.isawaitable(done):
                done = await done
            if done:
                return
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout=timeout)


def _parse(frame: Frame) -> tuple[str, dict[str, Any]]:
    """A frame as (event name, data)."""
    return frame.event, frame.data


async def _take(stream, count: int, timeout: float = 2.0) -> list[tuple[str, dict]]:
    """Pull `count` non-keepalive frames off the stream."""
    out: list[tuple[str, dict]] = []

    async def pump() -> None:
        async for frame in stream:
            if frame is KEEPALIVE:
                continue
            out.append(_parse(frame))
            if len(out) >= count:
                return

    await asyncio.wait_for(pump(), timeout=timeout)
    return out


def _open(registry: AgentConnectionRegistry, *, cursor: int = 0, **kw: Any):
    """A session's connection: one room, everything said in it.

    `cursor` is where the client resumes in the agent's own events; a test
    that resumes a room's conversation as well passes the whole `position`.
    """
    params: dict[str, Any] = {
        "agent_id": AGENT,
        "connection_id": kw.pop("connection_id", "c1"),
        "scope": "single",
        "delivery_filter": "all",
        "spawn_capable": False,
        "position": {OWN_EVENTS: cursor},
        "declaration": ClientDeclaration(speaks=PROTOCOL_VERSION),
        "expected_generation": None,
    }
    params.update(kw)
    return registry.open(**params)


async def test_first_frame_is_the_connection_state(db_buffer: EventBuffer) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    ((name, data),) = await _take(stream, 1)

    assert name == "connection_state"
    assert data["connection_id"] == "c1"
    assert data["scope"] == "single"
    assert data["rooms"] == [ROOM_A]
    assert data["protocol"] == PROTOCOL_VERSION
    # The client returns this on every heartbeat; without it the server cannot
    # tell the holder of a connection from a client displaced from it.
    assert data["generation"] == conn.stream_generation
    # Where the stream starts, for a client that keeps a position: in the
    # agent's own events and, since it reads the room's conversation, at the
    # room's newest message (none yet).
    assert data["position"] == {OWN_EVENTS: 0, room_source(ROOM_A): 0}


async def test_the_first_frame_declares_the_server(
    monkeypatch, db_buffer: EventBuffer
) -> None:
    """Version disclosure rides this frame, not an endpoint of its own.

    The stream is already authenticated, and nothing about the server's
    version is reachable without authenticating (CHOO-1865).
    """
    monkeypatch.setattr(version_module, "switch_core_version", lambda: "9.9.9")
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    ((_, data),) = await _take(stream, 1)

    assert data["server"] == {
        "version": "9.9.9",
        "contracts": {
            "agent-protocol": {
                "speaks": PROTOCOL_VERSION,
                "accepts": PROTOCOL_ACCEPTS,
            }
        },
    }


async def test_an_unreadable_server_version_is_null_not_a_placeholder(
    monkeypatch,
    db_buffer: EventBuffer,
) -> None:
    """Null means unknown. A placeholder would read as a version we chose."""
    monkeypatch.setattr(version_module, "switch_core_version", lambda: None)
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    ((_, data),) = await _take(stream, 1)

    assert data["server"]["version"] is None


async def test_the_first_frame_echoes_what_the_client_declared(
    db_buffer: EventBuffer,
) -> None:
    """So a declaration that failed to parse cannot pass unnoticed.

    Both sides otherwise believe it landed, which is worse than never having
    sent it.
    """
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(
        registry,
        declaration=ClientDeclaration(
            speaks=PROTOCOL_VERSION,
            accepts=PROTOCOL_ACCEPTS,
            artifact="agent-runtime",
            version="0.1.5",
        ),
    )

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    ((_, data),) = await _take(stream, 1)

    assert data["client"] == {
        "speaks": PROTOCOL_VERSION,
        "accepts": PROTOCOL_ACCEPTS,
        "artifact": "agent-runtime",
        "version": "0.1.5",
    }


async def test_an_undeclared_client_is_echoed_as_all_null(
    db_buffer: EventBuffer,
) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry, declaration=ClientDeclaration())

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    ((_, data),) = await _take(stream, 1)

    assert data["client"] == {
        "speaks": None,
        "accepts": None,
        "artifact": None,
        "version": None,
    }


async def test_catch_up_then_live_delivery(db_buffer: EventBuffer) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    # Kept before the stream opened: must be caught up, not skipped.
    await _keep(buffer, _message("before"))

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 2)
    assert frames[1][0] == "message"
    assert frames[1][1]["payload"]["body"] == "before"

    # Kept while the stream is open: pushed without being asked for.
    async def append_soon() -> None:
        await asyncio.sleep(0.01)
        await _keep(buffer, _message("after"))

    task = asyncio.create_task(append_soon())
    live = await _take(stream, 1)
    await task

    assert live[0][1]["payload"]["body"] == "after"


async def test_the_conversation_is_read_from_where_the_room_was_when_covered(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """The rest of a room's conversation is not kept for the agent: it is read
    from the room's own log, from where the room was when the stream first
    covered it. What was said before that is history, for `read_context`, not
    a backlog to deliver.

    A client that keeps a position is told the event's place in the room, and
    no number in the agent's own events, which it has none of.
    """
    registry = AgentConnectionRegistry()
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)
    await say(session_factory, ROOM_A, "history")

    stream = event_frames(
        conn=conn, registry=registry, buffer=db_buffer, approvals=None
    )
    await _take(stream, 1)
    arriving = asyncio.ensure_future(_take(stream, 1))
    await _until(lambda: room_source(ROOM_A) in conn.position)
    live = await say(session_factory, ROOM_A, "live")
    ((name, data),) = await arriving
    await stream.aclose()

    assert name == "message"
    assert data["payload"]["body"] == "live"
    assert data["payload"]["addressed"] is False
    assert "sequence" not in data
    assert data["position"] == {room_source(ROOM_A): live.seq}


async def test_the_chatter_before_a_mention_arrives_with_it_and_ahead_of_it(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """Every row is decided as it is written, so the rows around a mention are
    read straight away rather than once settled, and what led up to a mention
    arrives ahead of it."""
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry, position={OWN_EVENTS: 0, room_source(ROOM_A): 0})
    registry.claim_room(conn, ROOM_A)
    await say(session_factory, ROOM_A, "chatter")
    await _addressed(session_factory, buffer, "for you")

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    _, (_, before), (_, mention) = await _take(stream, 3)
    await stream.aclose()

    assert before["payload"]["body"] == "chatter"
    assert mention["payload"]["body"] == "for you"


async def test_a_conversation_reader_starts_with_a_place_in_each_room(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """A client learns where it starts from `connection_state`, and one that
    reconnects before any room message arrives resumes from there. Each room it
    reads must already have its place in that position: missing, the room
    would start at its newest message again on the reconnect, and what was
    said in between would never arrive."""
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    said = await say(session_factory, ROOM_A, "before the client connected")
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    ((name, opening),) = await _take(stream, 1)
    await stream.aclose()
    await say(session_factory, ROOM_A, "while the client was away")
    again = _open(registry, position=opening["position"])
    registry.claim_room(again, ROOM_A)
    stream = event_frames(conn=again, registry=registry, buffer=buffer, approvals=None)
    _, (_, missed) = await _take(stream, 2)
    await stream.aclose()

    assert name == "connection_state"
    assert opening["position"] == {OWN_EVENTS: 0, room_source(ROOM_A): said.seq}
    assert missed["payload"]["body"] == "while the client was away"


async def test_a_gap_for_own_events_all_deleted_is_sent_once(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """When retention has deleted every one of the agent's own events, the gap
    moves the connection past all of them, so the next frame is the next
    event rather than the same gap again."""
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    await _keep(buffer, _message("dropped"))
    await age_events(session_factory, AGENT, seconds=2 * 3600)
    await buffer.expire(TENANT_ZERO_ID)
    conn = _open(registry, cursor=0)
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    _, (gap, _) = await _take(stream, 2)
    await _keep(buffer, _message("after the gap"))
    ((name, after),) = await _take(stream, 1)
    await stream.aclose()

    assert gap == "gap"
    assert name == "message"
    assert after["payload"]["body"] == "after the gap"


async def test_sequence_number_is_carried_for_resume(db_buffer: EventBuffer) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)
    seq = await _keep(buffer, _message("one"))

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 2)

    assert frames[1][1]["sequence"] == seq
    # And, for a client that keeps a position, the event's place in its source.
    assert frames[1][1]["position"] == {OWN_EVENTS: seq}
    assert conn.cursor == seq


async def test_a_client_that_keeps_one_number_is_handed_tickets(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """A client built before positions keeps one number per stream. A stream
    that reads the conversation as well as the agent's own events has a place
    in each, so every event it sends such a client is numbered with a ticket
    standing for the whole position after it: the number the client sends
    back resumes it exactly there."""
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    said = await say(session_factory, ROOM_A, "chatter")
    kept = await _keep(buffer, _message("for you"))
    conn = _open(
        registry,
        position={OWN_EVENTS: 0, room_source(ROOM_A): 0},
        declaration=ClientDeclaration(speaks=POSITIONS_PROTOCOL_REVISION - 1),
    )
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    _, (_, chatter), (_, mine) = await _take(stream, 3)
    await stream.aclose()

    assert chatter["payload"]["body"] == "chatter"
    assert mine["payload"]["body"] == "for you"
    assert chatter["sequence"] >= TICKET_FLOOR
    assert "position" not in chatter
    assert await buffer.ticket(TENANT_ZERO_ID, AGENT, chatter["sequence"]) == {
        OWN_EVENTS: 0,
        room_source(ROOM_A): said.seq,
    }
    assert await buffer.ticket(TENANT_ZERO_ID, AGENT, mine["sequence"]) == {
        OWN_EVENTS: kept,
        room_source(ROOM_A): said.seq,
    }
    assert conn.cursor == mine["sequence"]


async def test_a_ticket_never_covers_an_event_still_to_come(
    db_buffer: EventBuffer,
) -> None:
    """One of the agent's own events for a room this connection does not cover
    is not sent, and the position moves past it. A ticket handed out for an
    event before it must not include it: a client that reconnects with that
    ticket would resume past the events in between and never receive them."""
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    first = await _keep(buffer, _message("first"))
    second = await _keep(buffer, _message("second"))
    await _keep(buffer, _message("elsewhere", room=ROOM_B))
    conn = _open(
        registry,
        position={OWN_EVENTS: 0, room_source(ROOM_A): 0},
        declaration=ClientDeclaration(speaks=POSITIONS_PROTOCOL_REVISION - 1),
    )
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    _, (_, one), (_, two) = await _take(stream, 3)
    await stream.aclose()
    after_one = await buffer.ticket(TENANT_ZERO_ID, AGENT, one["sequence"])
    after_two = await buffer.ticket(TENANT_ZERO_ID, AGENT, two["sequence"])

    assert after_one is not None and after_one[OWN_EVENTS] == first
    assert after_two is not None and after_two[OWN_EVENTS] == second


async def test_resuming_from_a_cursor_skips_what_was_already_seen(
    db_buffer: EventBuffer,
) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    first = await _keep(buffer, _message("seen"))
    await _keep(buffer, _message("missed"))

    conn = _open(registry, cursor=first)
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 2)

    assert frames[1][1]["payload"]["body"] == "missed"


async def test_expired_cursor_produces_a_gap_event_rather_than_silence(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    await _keep(buffer, _message("dropped"))
    await age_events(session_factory, AGENT, seconds=2 * 3600)
    await buffer.expire(TENANT_ZERO_ID)
    await _keep(buffer, _message("kept"))

    conn = _open(registry, cursor=0)
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 2)

    assert frames[1][0] == "gap"
    assert "re-read" in frames[1][1]["reason"]


async def test_events_for_rooms_the_connection_does_not_cover_are_skipped(
    db_buffer: EventBuffer,
) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    await _keep(buffer, _message("elsewhere", room=ROOM_B))
    await _keep(buffer, _message("mine"))

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 2)

    assert frames[1][1]["payload"]["body"] == "mine"


async def test_a_room_claimed_while_a_batch_goes_out_is_not_sent_by_its_old_holder(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """The stream suspends after each event it sends. A session of the same
    agent that claims the room in that moment takes the rest of the batch: the
    connection that covered the room before must not send it too."""
    await seed_member(session_factory, AGENT, ROOM_A)
    registry = AgentConnectionRegistry()
    watcher = _open(
        registry, connection_id="watcher", scope="all", delivery_filter="addressed"
    )
    await _keep(db_buffer, _message("first"))
    await _keep(db_buffer, _message("second"))

    stream = event_frames(
        conn=watcher, registry=registry, buffer=db_buffer, approvals=None
    )
    assert (await anext(stream)).event == "connection_state"
    assert (await anext(stream)).data["payload"]["body"] == "first"

    session = _open(
        registry, connection_id="session", scope="single", delivery_filter="addressed"
    )
    registry.claim_room(session, ROOM_A)

    try:
        after: Frame | None = await asyncio.wait_for(anext(stream), timeout=1.0)
    except TimeoutError:
        after = None
    assert after is None or after is KEEPALIVE
    assert watcher.position[OWN_EVENTS] == await db_buffer.head(TENANT_ZERO_ID, AGENT)


async def test_addressed_filter_drops_ambient_chatter(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    # From a position before the chatter, which a stream reading everything
    # would be sent.
    conn = _open(
        registry,
        scope="all",
        delivery_filter="addressed",
        position={OWN_EVENTS: 0, room_source(ROOM_A): 0},
    )

    await say(session_factory, ROOM_A, "chatter")
    await _keep(buffer, _message("wanted", room=ROOM_B))

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 2)

    assert frames[1][1]["payload"]["body"] == "wanted"


async def test_a_superseded_stream_is_told_it_was_evicted(
    db_buffer: EventBuffer,
) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    await _take(stream, 1)

    # A second stream attaches to the same connection id.
    _open(registry)
    await _keep(buffer, _message("wake up"))

    frames = await _take(stream, 1)
    assert frames[0][0] == "evicted"
    # The code is what the displaced client acts on: reopening would itself be
    # a takeover, so this ending is terminal and must not be read as prose.
    assert frames[0][1]["code"] == "taken_over"


async def test_closing_the_connection_ends_the_stream_with_a_reason(
    db_buffer: EventBuffer,
) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    await _take(stream, 1)

    registry.close(conn.id, HEARTBEAT_LAPSED)

    frames = await _take(stream, 1)
    assert frames[0][0] == "evicted"
    assert frames[0][1]["code"] == "heartbeat_lapsed"
    assert "heartbeat lapsed" in frames[0][1]["reason"]
    assert frames[0][1]["room_id"] is None


async def test_a_close_about_a_room_names_the_room_it_was_about(
    db_buffer: EventBuffer,
) -> None:
    """A client that loses a connection over a room it declared must be told which."""
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    await _take(stream, 1)

    registry.close(
        conn.id,
        Closure(code="closed", message="the room is already held", room_id=ROOM_A),
    )

    ((name, data),) = await _take(stream, 1)
    assert name == "evicted"
    assert data["code"] == "closed"
    assert data["room_id"] == ROOM_A


async def test_subscription_change_is_announced(db_buffer: EventBuffer) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    await _take(stream, 1)

    registry.claim_room(conn, ROOM_B)
    frames = await _take(stream, 1)
    assert frames[0][0] == "subscription_changed"
    assert sorted(frames[0][1]["rooms"]) == sorted([ROOM_A, ROOM_B])

    # And on the way out, which is how a supervisor learns a session left a
    # room rather than inferring it from a set that only ever grows.
    registry.release_room(conn, ROOM_A)
    frames = await _take(stream, 1)
    assert frames[0][0] == "subscription_changed"
    assert frames[0][1]["rooms"] == [ROOM_B]


async def test_stream_detaches_on_exit_without_killing_the_connection(
    db_buffer: EventBuffer,
) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    await _take(stream, 1)
    await stream.aclose()

    assert not conn.stream_attached
    assert registry.get(conn.id) is conn


@pytest.mark.parametrize("scope", ["single", "all"])
async def test_two_connections_receive_the_same_event(
    scope: str,
    db_buffer: EventBuffer,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Non-destructive reads: one reader must not steal from another.

    The conversation is read where it lies, in the room's log, so one row is
    read by every agent in the room.
    """
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    await say(session_factory, ROOM_A, "shared")
    # Both resume from before it.
    start = {OWN_EVENTS: 0, room_source(ROOM_A): 0}

    session = registry.open(
        agent_id=AGENT,
        connection_id="session",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        position=start,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    registry.claim_room(session, ROOM_A)

    other_agent = registry.open(
        agent_id="agent-2",
        connection_id="other",
        scope=scope,  # type: ignore[arg-type]
        delivery_filter="all",
        spawn_capable=False,
        position=start,
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    registry.claim_room(other_agent, ROOM_A)

    a = event_frames(conn=session, registry=registry, buffer=buffer, approvals=None)
    b = event_frames(conn=other_agent, registry=registry, buffer=buffer, approvals=None)

    assert (await _take(a, 2))[1][1]["payload"]["body"] == "shared"
    assert (await _take(b, 2))[1][1]["payload"]["body"] == "shared"


async def test_resume_replays_buffered_events_for_a_room_claimed_at_open(
    db_buffer: EventBuffer,
) -> None:
    """The reconnect case the whole design exists for.

    A client that drops and comes back declares its room when it reopens. If
    the room were only claimed after the stream started, catch-up would run
    first, skip those events as "not covered", and advance the cursor past
    them — losing exactly what resume is meant to recover.
    """
    registry = AgentConnectionRegistry()
    buffer = db_buffer

    seen = await _keep(buffer, _message("before the drop"))
    await _keep(buffer, _message("while disconnected"))

    conn = _open(registry, connection_id="c-resumed", cursor=seen)
    # Claimed before the stream is created, as the endpoint does.
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 2)

    assert frames[1][0] == "message"
    assert frames[1][1]["payload"]["body"] == "while disconnected"


async def test_events_for_uncovered_rooms_do_not_block_the_cursor(
    db_buffer: EventBuffer,
) -> None:
    """Skipping is deliberate for rooms this connection does not cover."""
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)
    registry.claim_room(conn, ROOM_A)

    await _keep(buffer, _message("someone else's room", room=ROOM_B))
    last = await _keep(buffer, _message("mine"))

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 2)

    assert frames[1][1]["payload"]["body"] == "mine"
    assert conn.cursor == last


async def test_a_cursor_from_before_a_restart_is_reported_not_ignored(
    db_buffer: EventBuffer,
) -> None:
    """A cursor ahead of everything the agent's events reach is from some other
    history: the in-memory buffer before them, a restored database.

    A client that comes back with one would otherwise sit quietly at a
    position that no longer means anything, looking caught up while its
    history has a hole in it.
    """
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    await _keep(buffer, _message("after the restart"))

    conn = _open(registry, cursor=4812)  # from a previous life
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 2)

    assert frames[1][0] == "gap"
    assert "restarted" in frames[1][1]["reason"]


async def test_stream_reports_restart_below_floor(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """An agent's numbering starts above every earlier boot's, so a cursor
    from before its events were kept here is below its floor rather than above
    its head. That is still told, and `resumed_at` sits above the old cursor so
    the client keeps its dedupe."""
    registry = AgentConnectionRegistry()
    buffer = db_buffer_on(session_factory, sequence_base=7 << 32)
    first = await _keep(buffer, _message("after the restart"))
    old_cursor = (6 << 32) + 4812

    conn = _open(registry, cursor=old_cursor)
    registry.claim_room(conn, ROOM_A)

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 3)

    kind, gap = frames[1]
    assert kind == "gap"
    assert gap["from_sequence"] == old_cursor
    assert gap["resumed_at"] == buffer.sequence_floor - 1
    assert gap["resumed_at"] > old_cursor
    # The same place, for a client that keeps a position.
    assert gap["resumed_position"] == {
        OWN_EVENTS: gap["resumed_at"],
        room_source(ROOM_A): 0,
    }
    assert gap["all_rooms"] is True
    assert "restarted" in gap["reason"]
    assert frames[2][1]["sequence"] == first == buffer.sequence_floor


class TestALapsedHeartbeatStopsDelivery:
    """A connection nothing considers alive must not keep receiving.

    Every presence reader filters on liveness, so a connection whose heartbeat
    has lapsed is invisible to all of them — while its socket happily keeps
    handing over events. That pairing is undetectable from either side: the
    client sees traffic and assumes it is healthy, the room is told the agent is
    offline. It is what produced "my connector isn't reporting in" while
    Switch Console was demonstrably receiving the same message and spawning a
    session from it.
    """

    async def test_the_stream_evicts_when_the_heartbeat_lapses(
        self, db_buffer: EventBuffer
    ) -> None:
        import time as _time

        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry)
        registry.claim_room(conn, ROOM_A)

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        # Consume the opening frame while still healthy.
        await _take(stream, 1)

        conn.last_beat = _time.monotonic() - (HEARTBEAT_TTL_SECONDS + 1)
        await _keep(buffer, _message("should not arrive"))

        ((name, data),) = await _take(stream, 1)

        assert name == "evicted"
        assert data["code"] == "heartbeat_lapsed"
        assert "heartbeat" in data["reason"]

    async def test_the_connection_is_closed_not_merely_ignored(
        self, db_buffer: EventBuffer
    ) -> None:
        """Otherwise the room slot stays claimed by a connection that is gone."""
        import time as _time

        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry)
        registry.claim_room(conn, ROOM_A)

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        await _take(stream, 1)
        conn.last_beat = _time.monotonic() - (HEARTBEAT_TTL_SECONDS + 1)
        await _take(stream, 1)

        assert registry.claimant_of(AGENT, ROOM_A) is None
        assert conn.closure is not None


class TestFilteredEventsDoNotSpinTheLoop:
    """A connection must not busy-loop over events its filter excludes.

    `read_from` does not return filtered-out events, so unlike events skipped
    for room coverage they cannot advance the cursor on their way past. Left
    behind them, the stream's "anything new?" check is permanently true and the
    generator spins at full speed instead of awaiting.

    That is not a slow stream, it is a stopped server: one spinning generator
    starves the event loop, so no heartbeat is processed, so every connection in
    the process is declared dead and reconnects — which is exactly what was
    observed, with `beats=0` on connections that had only just opened.
    """

    async def test_the_cursor_advances_past_events_the_filter_excludes(
        self, monkeypatch: pytest.MonkeyPatch, db_buffer: EventBuffer
    ) -> None:
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry, delivery_filter="addressed")
        registry.claim_room(conn, ROOM_A)

        # Commands: the agent's own events, none of them notifiable.
        for i in range(3):
            await _keep(buffer, _command(f"command-{i}"))

        # Shorten the keepalive so "did it reach its wait?" is answered in
        # milliseconds. A spinning generator never yields one at any interval.
        monkeypatch.setattr(stream_module, "KEEPALIVE_INTERVAL_SECONDS", 0.05)

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        await _take(stream, 1)  # connection_state
        await asyncio.wait_for(anext(stream), timeout=2.0)

        assert conn.cursor == await buffer.head(TENANT_ZERO_ID, AGENT)
        await stream.aclose()

    async def test_an_addressed_event_after_the_excluded_ones_still_arrives(
        self,
        db_buffer: EventBuffer,
    ) -> None:
        """Advancing past the excluded events must not skip what follows."""
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry, delivery_filter="addressed")
        registry.claim_room(conn, ROOM_A)

        await _keep(buffer, _command("reset"))
        await _keep(buffer, _message("for-you"))

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        frames = await _take(stream, 2)

        assert frames[1][0] == "message"
        assert frames[1][1]["payload"]["body"] == "for-you"
        await stream.aclose()

    async def test_the_room_position_moves_past_rows_that_are_not_conversation(
        self,
        monkeypatch: pytest.MonkeyPatch,
        db_buffer: EventBuffer,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        """The same for the conversation. The agent's own message, and a row it
        was already sent as one of its own events, are looked at and passed
        over: the stream moves past them rather than reading them again on
        every pass, and the addressed message arrives once, not twice."""
        monkeypatch.setattr(stream_module, "KEEPALIVE_INTERVAL_SECONDS", 0.05)
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry, position={OWN_EVENTS: 0, room_source(ROOM_A): 0})
        registry.claim_room(conn, ROOM_A)

        await say(session_factory, ROOM_A, "chatter")
        mine = await sender_of(session_factory, AGENT)
        await say(session_factory, ROOM_A, "said by the agent", sender=mine)
        addressed = await _addressed(session_factory, buffer, "for you")

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        frames = await _take(stream, 3)
        # Nothing more to send: the next thing out is the idle tick.
        assert await asyncio.wait_for(anext(stream), timeout=2.0) is KEEPALIVE
        await stream.aclose()

        assert sorted(
            (data["payload"]["body"], data["payload"]["addressed"])
            for _, data in frames[1:]
        ) == [("chatter", False), ("for you", True)]
        assert conn.position[room_source(ROOM_A)] == addressed.seq


class TestAConnectionWithNoRoomDoesNotConsume:
    """A session connection must not burn through the buffer before it has a room.

    A session spawned to answer a message opens its connection *before* the
    session boots and calls connect_to_room. During that window it covers no
    room, so every event looks uncovered — and the skip path advances the
    cursor. Left to read, it consumes its way to the end of the buffer and the
    message it was started for is behind it by the time its room arrives.

    This is the last link in that chain: the spawn hand-off can pass the right
    cursor, the client can open at the right place, and the message is still
    lost here.
    """

    async def test_the_cursor_survives_the_wait_for_a_room(
        self, monkeypatch: pytest.MonkeyPatch, db_buffer: EventBuffer
    ) -> None:
        monkeypatch.setattr(stream_module, "KEEPALIVE_INTERVAL_SECONDS", 0.05)
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        # Opened at 0, like a session handed its trigger's position.
        conn = _open(registry, cursor=0)

        await _keep(buffer, _message("the trigger"))

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        await _take(stream, 1)  # connection_state
        # Parked: a keepalive rather than the event, and no position moved.
        await asyncio.wait_for(anext(stream), timeout=2.0)

        assert conn.position == {OWN_EVENTS: 0}
        await stream.aclose()

    async def test_the_trigger_arrives_once_the_room_is_claimed(
        self, monkeypatch: pytest.MonkeyPatch, db_buffer: EventBuffer
    ) -> None:
        monkeypatch.setattr(stream_module, "KEEPALIVE_INTERVAL_SECONDS", 0.05)
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry, cursor=0)

        await _keep(buffer, _message("the trigger"))

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        await _take(stream, 1)
        await asyncio.wait_for(anext(stream), timeout=2.0)  # parked

        # connect_to_room, arriving late as it does in practice.
        registry.claim_room(conn, ROOM_A)

        frames = await _take(stream, 2)
        assert frames[0][0] == "subscription_changed"
        assert frames[1][0] == "message"
        assert frames[1][1]["payload"]["body"] == "the trigger"
        await stream.aclose()

    async def test_an_all_scope_connection_is_not_parked(
        self, db_buffer: EventBuffer
    ) -> None:
        """A watcher holds no room by design and must keep receiving."""
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry, scope="all", connection_id="watcher")

        await _keep(buffer, _message("hello"))

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        frames = await _take(stream, 2)

        assert frames[1][0] == "message"
        await stream.aclose()


async def test_replaced_stream_cannot_capture_its_successors_generation(
    db_buffer: EventBuffer,
) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)
    old = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    _open(registry)
    assert await _take(old, 1) == []
    assert registry.beat(AGENT, conn.id, conn.stream_generation).stream_attached


async def test_closed_stream_cannot_detach_a_recreated_connection(
    db_buffer: EventBuffer,
) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry)
    old = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    await anext(old)
    registry.close(conn.id, HEARTBEAT_LAPSED)
    replacement = _open(registry)
    assert replacement is not conn
    await old.aclose()
    assert registry.beat(
        AGENT, replacement.id, replacement.stream_generation
    ).stream_attached


async def test_a_resumed_stream_does_not_replay_a_room_the_agent_was_removed_from(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """The leak this stream had no way of its own to close.

    Membership is checked when a room is claimed and never again, and an
    `all`-scope connection covers every room no sibling has claimed, so the
    stream cannot re-derive who is in what — it holds no session to ask with.
    A supervisor reconnecting with a resumed cursor therefore replayed the
    whole retained tail of a room the agent had been removed from.

    What closes it is acting on the removal once, where it is known: the
    room's events leave the buffer and its claim is released, so there is
    nothing left for any reader to be handed. The room's conversation stays
    in its log, and is not read for a room the agent is no longer in. This
    asserts the property at the reader that has no other defence.
    """
    registry = AgentConnectionRegistry()
    buffer = db_buffer

    await say(session_factory, ROOM_A, "chatter before the removal")
    await _keep(buffer, _message("said before the removal"))
    await _keep(buffer, _message("still a member here", room=ROOM_B))

    # What a kick does: the membership goes, its own events in the room go
    # with it (`MessageRouter.remove`), and the room is let go of here.
    await _leave(session_factory, ROOM_A)
    await forget_room(session_factory, buffer, AGENT, ROOM_A)
    registry.release_room_everywhere(AGENT, ROOM_A)

    # The supervisor comes back and resumes from before all of it.
    conn = _open(
        registry,
        connection_id="c-resumed",
        scope="all",
        position={OWN_EVENTS: 0, room_source(ROOM_A): 0, room_source(ROOM_B): 0},
    )
    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 2)

    assert frames[1][0] == "message"
    assert frames[1][1]["payload"]["body"] == "still a member here"


async def test_a_last_event_id_reconnect_does_not_replay_a_removed_room(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    """The resume a real client actually performs.

    An SSE client reconnects by sending back the `Last-Event-ID` it last saw;
    `_resolve_start_position` prefers it over `start_from` and the stream resumes
    from there. That is the path the removed room's retained tail would come
    back down, and it is the one a browser or an agent runtime takes without
    being asked — so it is worth pinning separately from an explicitly
    requested `start_from`.
    """
    registry = AgentConnectionRegistry()
    buffer = db_buffer

    seen = await _keep(buffer, _message("before the drop"))
    await _keep(buffer, _message("while it was still a member"))
    await _keep(buffer, _message("in the room it kept", room=ROOM_B))

    await forget_room(session_factory, buffer, AGENT, ROOM_A)
    registry.release_room_everywhere(AGENT, ROOM_A)

    # `seen` is what the client would send back as Last-Event-ID: a cursor from
    # while it was still in room A, resolved to exactly this by
    # `_resolve_start_position`.
    conn = _open(registry, connection_id="c-reconnect", scope="all", cursor=seen)
    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    frames = await _take(stream, 2)

    assert frames[1][0] == "message"
    assert frames[1][1]["payload"]["body"] == "in the room it kept"


class TestWhatADeliveredEventSaysAboutItsRoom:
    """An agent is woken for addressed traffic; the chatter rides along with it.

    The count is per room and is taken from the room's log, so the client
    renders what it is told rather than tallying what it happened to filter
    out.
    """

    async def test_a_delivered_event_carries_the_chatter_of_its_own_room(
        self,
        db_buffer: EventBuffer,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry, delivery_filter="addressed")
        for room in (ROOM_A, ROOM_B):
            registry.claim_room(conn, room)
            # Declared as the connection opened, which counts the room from then.
            await buffer.take_counting(TENANT_ZERO_ID, AGENT, conn.id, room)

        await say(session_factory, ROOM_A, "chatter-1")
        await say(session_factory, ROOM_A, "chatter-2")
        await say(session_factory, ROOM_B, "elsewhere")
        await _addressed(session_factory, buffer, "for you")
        await _addressed(session_factory, buffer, "also you", room=ROOM_B)

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        frames = await _take(stream, 3)
        await stream.aclose()

        assert frames[1][1]["missed"] == {"count": 2, "reason": None}
        assert frames[2][1]["missed"] == {"count": 1, "reason": None}

    async def test_chatter_the_stream_moved_past_is_still_counted(
        self,
        db_buffer: EventBuffer,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        """Sending the conversation moves the position, not where the agent
        caught up.

        The position is what keeps the stream from reading the chatter again;
        it must not double as a claim that the agent has read it. Only
        catching up (`read_context`) clears the count.
        """
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry, position={OWN_EVENTS: 0, room_source(ROOM_A): 0})
        registry.claim_room(conn, ROOM_A)
        await buffer.take_counting(TENANT_ZERO_ID, AGENT, conn.id, ROOM_A)
        chatter = await say(session_factory, ROOM_A, "chatter")

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        (_, (_, sent)) = await _take(stream, 2)
        assert sent["payload"]["body"] == "chatter"
        assert conn.position[room_source(ROOM_A)] == chatter.seq

        # The stream waits on the frame it just yielded, so the addressed row
        # and its event both land before it reads again.
        await _addressed(session_factory, buffer, "for you")
        ((_, data),) = await _take(stream, 1)
        await stream.aclose()

        assert data["missed"] == {"count": 1, "reason": None}

    async def test_a_room_claimed_after_the_connection_opened_counts_from_there(
        self,
        db_buffer: EventBuffer,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry, delivery_filter="addressed")
        registry.claim_room(conn, ROOM_A)

        await say(session_factory, ROOM_B, "before the claim")
        await _addressed(session_factory, buffer, "for you")

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        await _take(stream, 2)  # connection_state, then the message in room A

        registry.claim_room(conn, ROOM_B)
        # subscription_changed, then the message.
        arriving = asyncio.ensure_future(_take(stream, 2))

        async def counting_room_b() -> bool:
            unread = await buffer.unread(TENANT_ZERO_ID, AGENT, ROOM_B, 0)
            return unread.reason is None

        await _until(counting_room_b)
        await say(session_factory, ROOM_B, "chatter")
        await _addressed(session_factory, buffer, "for you", room=ROOM_B)
        frames = await arriving
        await stream.aclose()

        assert frames[1][1]["missed"] == {"count": 1, "reason": None}

    async def test_a_count_is_absent_rather_than_zero_where_nothing_counts_the_room(
        self,
        db_buffer: EventBuffer,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        """A watcher covers every room no session holds, and counts none of
        them: a room is counted from when something takes it. An event in a
        room nothing has counted says the count cannot be told, rather than a
        zero the agent would believe."""
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry, scope="all", delivery_filter="addressed")

        await say(session_factory, ROOM_A, "chatter")
        await _addressed(session_factory, buffer, "for you")

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        frames = await _take(stream, 2)
        await stream.aclose()

        assert frames[1][1]["missed"] == {"count": None, "reason": NO_BASELINE}


class TestAGapNamesTheRoomsThatLostEvents:
    """ "Something was dropped" is unactionable across a dozen rooms."""

    async def test_an_expired_cursor_names_them(
        self, db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        await _keep(buffer, _message("dropped"))
        await _keep(buffer, _message("dropped", room=ROOM_B))
        await age_events(session_factory, AGENT, seconds=2 * 3600)
        await buffer.expire(TENANT_ZERO_ID)
        await _keep(buffer, _message("kept"))
        await _keep(buffer, _message("kept", room=ROOM_B))

        conn = _open(registry, cursor=0)
        registry.claim_room(conn, ROOM_A)
        registry.claim_room(conn, ROOM_B)

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        frames = await _take(stream, 2)
        await stream.aclose()

        assert frames[1][0] == "gap"
        assert sorted(frames[1][1]["rooms"]) == [ROOM_A, ROOM_B]

    async def test_a_restart_names_the_rooms_the_connection_covers(
        self, db_buffer: EventBuffer
    ) -> None:
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        await _keep(buffer, _message("after the restart"))

        conn = _open(registry, cursor=4812)
        registry.claim_room(conn, ROOM_A)

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        frames = await _take(stream, 2)
        await stream.aclose()

        assert frames[1][0] == "gap"
        assert frames[1][1]["rooms"] == [ROOM_A]
        assert frames[1][1]["all_rooms"] is True

    async def test_a_restart_says_the_loss_is_not_confined_to_them(
        self, db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A watcher of every room names none, and its rooms arrive afterwards.

        Reporting only what the connection had claimed would leave every room
        its sessions go on to claim looking untouched, which is the restart
        made invisible in exactly the rooms the agent works in. What each of
        those rooms is behind by is kept in the database, so it survives the
        restart: told in full, never a fresh zero.
        """
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        # Before the restart a session had room B, and the room went on talking.
        before_the_restart = db_buffer_on(session_factory)
        await before_the_restart.take_counting(
            TENANT_ZERO_ID, AGENT, "session-before", ROOM_B
        )
        await say(session_factory, ROOM_B, "said before the restart")

        await _keep(buffer, _message("after the restart"))
        conn = _open(registry, scope="all", cursor=4812)

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        frames = await _take(stream, 2)

        assert frames[1][0] == "gap"
        assert frames[1][1]["rooms"] == []
        assert frames[1][1]["all_rooms"] is True

        registry.claim_room(conn, ROOM_B)
        await say(session_factory, ROOM_B, "chatter")
        await _addressed(session_factory, buffer, "for you", room=ROOM_B)
        # subscription_changed, the chatter (this connection reads the room's
        # conversation from where it opened), then the message.
        delivered = await _take(stream, 3)
        await stream.aclose()

        assert [frame[1].get("payload", {}).get("body") for frame in delivered[1:]] == [
            "chatter",
            "for you",
        ]
        assert delivered[-1][1]["missed"] == {"count": 2, "reason": None}

    async def test_a_place_past_the_end_of_a_room_names_that_room(
        self, db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A place further than the room has ever reached is from a history the
        room no longer has (a restored database). Kept, it would pass over that
        many of the room's next messages without a word, so the stream starts
        the room at its end and says so."""
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        earlier = await say(session_factory, ROOM_A, "earlier")
        conn = _open(registry, position={OWN_EVENTS: 0, room_source(ROOM_A): 4812})
        registry.claim_room(conn, ROOM_A)

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        (_, (kind, gap)) = await _take(stream, 2)

        assert kind == "gap"
        assert gap["rooms"] == [ROOM_A]
        assert gap["all_rooms"] is False
        assert gap["resumed_position"][room_source(ROOM_A)] == earlier.seq

        # What is said next is delivered, not passed over.
        await say(session_factory, ROOM_A, "next")
        ((_, data),) = await _take(stream, 1)
        await stream.aclose()

        assert data["payload"]["body"] == "next"

    async def test_a_dropped_event_gap_is_confined_to_the_rooms_it_names(
        self, db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        await _keep(buffer, _message("dropped"))
        await age_events(session_factory, AGENT, seconds=2 * 3600)
        await buffer.expire(TENANT_ZERO_ID)
        await _keep(buffer, _message("kept"))

        conn = _open(registry, cursor=0)
        registry.claim_room(conn, ROOM_A)

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        frames = await _take(stream, 2)
        await stream.aclose()

        assert frames[1][0] == "gap"
        assert frames[1][1]["all_rooms"] is False


async def test_a_delivered_event_names_no_session(db_buffer: EventBuffer) -> None:
    """Routing a room's events to a session is the watcher's, from its own placements."""
    registry = AgentConnectionRegistry()
    buffer = db_buffer
    conn = _open(registry, scope="all")
    registry.place_session(AGENT, "session-1", ROOM_A, conn.id)
    await _keep(buffer, _message("hello"))

    stream = event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
    (_, (name, data)) = await _take(stream, 2)

    assert name == "message"
    assert "session_id" not in data


async def test_new_boot_reports_gap_and_keeps_messages_when_old_cursor_is_below_head(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    registry = AgentConnectionRegistry()
    buffer = db_buffer_on(session_factory, sequence_base=2 << 32)
    sequences = [await _keep(buffer, _message(str(i))) for i in range(3)]
    conn = _open(registry, cursor=(1 << 32) + 2)
    registry.claim_room(conn, ROOM_A)
    frames = await _take(
        event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None), 5
    )
    assert frames[1][0] == "gap"
    assert frames[1][1]["resumed_at"] == 2 << 32
    assert [frame[1]["sequence"] for frame in frames[2:]] == sequences


async def test_each_delivered_event_counts_as_an_agent_bridge_event_out(
    db_buffer: EventBuffer, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    registry_metrics = MetricsRegistry()
    install(registry_metrics)
    try:
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry, position={OWN_EVENTS: 0, room_source(ROOM_B): 0})
        registry.claim_room(conn, ROOM_A)
        registry.claim_room(conn, ROOM_B)
        await _keep(buffer, _message("one"))
        # The conversation, read from the room's log, counts the same.
        await say(session_factory, ROOM_B, "two")

        stream = event_frames(
            conn=conn, registry=registry, buffer=buffer, approvals=None
        )
        await _take(stream, 3)

        points = {
            payload.name: {
                tuple(sorted(p.attributes.items())): p.value for p in payload.numbers
            }
            for payload in registry_metrics.collect()
        }
        assert points["switch.bridge.events_out"] == {
            (("bridge", "agent"), ("kind", "message"), ("platform", "switch")): 2.0
        }
    finally:
        uninstall()


class TestBothTransportsEncodeTheSameFrames:
    """The socket and the event stream an old client still reads carry the
    same frames from the same loop; only the encoding differs."""

    def test_an_event_carries_its_sequence_as_the_sse_id(self) -> None:
        frame = Frame("message", {"payload": {"body": "hi"}}, seq=7)

        assert encode_sse(frame) == (
            b'id: 7\nevent: message\ndata: {"payload":{"body":"hi"}}\n\n'
        )
        assert encode_ws(frame) == {
            "event": "message",
            "data": {"payload": {"body": "hi"}},
            "id": 7,
        }

    def test_a_frame_without_a_sequence_has_no_id(self) -> None:
        assert encode_sse(Frame("gap", {"reason": "x"})) == (
            b'event: gap\ndata: {"reason":"x"}\n\n'
        )

    def test_the_keepalive_is_a_comment_on_the_event_stream(self) -> None:
        assert encode_sse(KEEPALIVE) == b": keepalive\n\n"

    async def test_closing_the_event_stream_detaches_its_connection(
        self, db_buffer: EventBuffer
    ) -> None:
        registry = AgentConnectionRegistry()
        buffer = db_buffer
        conn = _open(registry)

        body = sse_stream(
            event_frames(conn=conn, registry=registry, buffer=buffer, approvals=None)
        )
        first = await anext(body)
        await body.aclose()

        assert first.startswith(b"event: connection_state\n")
        assert not conn.stream_attached
        assert registry.get(conn.id) is conn
