"""A room's conversation, read for an agent from the room's own log.

What a reader that wants everything (`filter=all`, the legacy polls) is sent
besides the agent's own events. Three properties are pinned here, each found
running the stream end to end:

- a row is read as soon as it is written, because whether it is the agent's
  own was decided in the transaction that wrote it, so it is never sent twice;
  the one row read later is a file of a post the router is still waiting on,
  which holds the read back until the post is decided;
- the agent's own event for a message stands for that message up to the row it
  was delivered through, so a file that arrives after its group was delivered
  is still read;
- a place in a room past the room's newest row is from a history the room no
  longer has, and is brought back to the room's end.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.attachments import ATTACHMENT_GROUP_KEY
from switch_core.bridges.agent.protocol.event_buffer import BufferedEvent, EventBuffer
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS, room_source
from switch_core.bridges.agent.protocol.types import AgentEvent, MessagePayload
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    Message,
    MessageAttachment,
    PendingAttachmentGroup,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore
from tests.db_buffer import say, seed_member, seed_room

AGENT = "agent-1"
ROOM = "room-1"
EMPTY_ROOM = "room-2"

SessionFactory = async_sessionmaker[AsyncSession]


@pytest.fixture(autouse=True)
async def _rows(session_factory: SessionFactory) -> None:
    await seed_member(session_factory, AGENT, ROOM)
    await seed_room(session_factory, EMPTY_ROOM)


async def _keep(buffer: EventBuffer, room_seq: int, message_key: str) -> None:
    """The agent's own event for a message addressed to it, as its consumer
    keeps it."""
    await buffer.enqueue(
        TENANT_ZERO_ID,
        AGENT,
        ROOM,
        AgentEvent(
            type="message",
            room_id=ROOM,
            payload=MessagePayload(
                addressed=True,
                sender="@alice:test",
                sender_name="Alice",
                message_id=message_key,
                body="@agent over to you",
                timestamp=0,
            ),
        ),
        room_seq=room_seq,
        message_key=message_key,
    )


async def _file(
    session_factory: SessionFactory,
    group: str,
    index: int,
    name: str,
    sent_at: datetime,
    *,
    caption: str | None = None,
) -> Message:
    """One file of a two-file message, as the bridge stores it: a row of its
    own, numbered within its attachment group."""
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        row = await MessageStore().create(
            session,
            Message(
                room_id=ROOM,
                transport_event_id=f"${group}-{index}",
                sender_id="@alice:test",
                sender_name="Alice",
                event_type="m.room.message",
                msgtype="m.file",
                body=caption or name,
                formatted_body=None,
                content={
                    "body": caption or name,
                    ATTACHMENT_GROUP_KEY: {"id": group, "index": index, "total": 2},
                },
                sent_at=sent_at,
            ),
            [MessageAttachment(uri=f"mxc://s/{name}", filename=name)],
        )
        await session.commit()
    return row


def _files(item: BufferedEvent) -> set[str]:
    attachments = getattr(item.event.payload, "attachments", None) or []
    return {ref.filename for ref in attachments}


def _bodies(items: list[BufferedEvent]) -> list[str | None]:
    return [getattr(item.event.payload, "body", None) for item in items]


async def test_what_came_before_and_after_the_agents_own_event_is_read_at_once(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A row and the own events decided for it commit together, so a row that
    can be read is decided: the conversation around a mention is read at once,
    and the mention, already the agent's own, is not read again. Waiting for
    rows to settle sent the agent its mention ahead of the conversation that
    led up to it."""
    buffer = db_buffer
    await say(session_factory, ROOM, "before")
    asked = await say(session_factory, ROOM, "@agent over to you")
    await _keep(buffer, asked.seq, asked.transport_event_id)
    after = await say(session_factory, ROOM, "after")

    read = await buffer.read_conversation(TENANT_ZERO_ID, AGENT, {ROOM: 0}, limit=100)

    assert _bodies(read.events) == ["before", "after"]
    assert read.through == {ROOM: after.seq}


async def test_a_post_not_yet_decided_holds_back_the_rows_after_it(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """Rows are read as an unbroken run from the reader's place. A post whose
    files are still arriving is decided as a whole, so the read stops at its
    first file, and the rows after it wait with it: had the reader's place
    moved past the file, the post would reach the agent in pieces."""
    buffer = db_buffer
    long_ago = datetime.now(UTC) - timedelta(minutes=5)
    await say(session_factory, ROOM, "decided", sent_at=long_ago)
    first = await say(
        session_factory,
        ROOM,
        "first of two",
        content={ATTACHMENT_GROUP_KEY: {"id": "grp", "index": 0, "total": 2}},
        sent_at=long_ago,
    )
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        session.add(
            PendingAttachmentGroup(
                room_id=ROOM,
                group_id="grp",
                total=2,
                from_seq=first.seq,
                deadline=datetime.now(UTC) + timedelta(minutes=1),
            )
        )
        await session.commit()
    await say(session_factory, ROOM, "after it", sent_at=long_ago)

    read = await buffer.read_conversation(TENANT_ZERO_ID, AGENT, {ROOM: 0}, limit=100)

    assert _bodies(read.events) == ["decided"]

    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(delete(PendingAttachmentGroup))
        await session.commit()
    read = await buffer.read_conversation(TENANT_ZERO_ID, AGENT, {ROOM: 0}, limit=100)

    # Decided: the read goes on from the post's first file.
    assert _bodies(read.events) == ["decided", "first of two", "after it"]


async def test_a_backlog_longer_than_one_read_keeps_its_order(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A read takes at most `limit` rows of a room. The agent's own event for a
    message posted after the rows left over waits for them, rather than going
    out ahead of conversation that came before it."""
    buffer = db_buffer
    long_ago = datetime.now(UTC) - timedelta(minutes=1)
    for index in range(3):
        await say(session_factory, ROOM, f"chatter {index}", sent_at=long_ago)
    asked = await say(session_factory, ROOM, "@agent over to you")
    await _keep(buffer, asked.seq, asked.transport_event_id)

    position: dict[str, int] = {room_source(ROOM): 0}
    sent: list[list[str | None]] = []
    for _ in range(2):
        events, looked = await buffer.read(
            TENANT_ZERO_ID, AGENT, position, conversation_rooms={ROOM}, limit=2
        )
        sent.append(_bodies(events))
        for item in events:
            position[item.source] = max(position.get(item.source, -1), item.seq)
        for source, seq in looked.items():
            position[source] = max(position.get(source, -1), seq)

    assert sent == [
        ["chatter 0", "chatter 1"],
        ["chatter 2", "@agent over to you"],
    ]


async def test_a_file_that_arrives_after_its_group_was_delivered_is_still_read(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """The consumer delivers several files posted as one once they are all in,
    or when it stops waiting for the rest. A file arriving after that is past
    the row the group was delivered through: it is conversation, and the files
    already delivered are not sent again."""
    buffer = db_buffer
    long_ago = datetime.now(UTC) - timedelta(minutes=1)

    def part(index: int) -> dict[str, object]:
        return {ATTACHMENT_GROUP_KEY: {"id": "grp", "index": index, "total": 3}}

    await say(session_factory, ROOM, "first", content=part(0), sent_at=long_ago)
    second = await say(
        session_factory, ROOM, "second", content=part(1), sent_at=long_ago
    )
    await _keep(buffer, second.seq, "grp")
    await say(session_factory, ROOM, "late", content=part(2), sent_at=long_ago)

    read = await buffer.read_conversation(TENANT_ZERO_ID, AGENT, {ROOM: 0}, limit=100)

    assert _bodies(read.events) == ["late"]


async def test_a_message_posted_between_the_files_of_a_group_goes_out_first(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A multi-file message goes out once, at its last file. A message posted
    between its files goes out before it, so the room's events go out in rising
    order and a client that disconnects after the group has not been moved past
    the message in between."""
    buffer = db_buffer
    long_ago = datetime.now(UTC) - timedelta(minutes=1)

    await _file(session_factory, "g1", 0, "one.pdf", long_ago)
    between = await say(session_factory, ROOM, "in between", sent_at=long_ago)
    last = await _file(session_factory, "g1", 1, "two.pdf", long_ago)

    read = await buffer.read_conversation(TENANT_ZERO_ID, AGENT, {ROOM: 0}, limit=100)

    assert [item.seq for item in read.events] == [between.seq, last.seq]
    assert _bodies(read.events)[0] == "in between"


async def test_a_group_held_back_by_another_keeps_its_first_file(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """Two people post two files each and the files interleave: A's first, B's
    first, A's second. B is still waiting for its second file, so it holds the
    read at its first file. A goes out at its last file, which is past the
    hold, so the read must not move past A's first file either, or the next
    read would send A with only its second file."""
    buffer = db_buffer
    long_ago = datetime.now(UTC) - timedelta(minutes=5)
    a_first = await _file(
        session_factory, "A", 0, "a-one.pdf", long_ago, caption="see these"
    )
    b_first = await _file(session_factory, "B", 0, "b-one.pdf", long_ago)
    await _file(session_factory, "A", 1, "a-two.pdf", long_ago)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        session.add(
            PendingAttachmentGroup(
                room_id=ROOM,
                group_id="B",
                total=2,
                from_seq=b_first.seq,
                deadline=datetime.now(UTC) + timedelta(minutes=1),
            )
        )
        await session.commit()

    first = await buffer.read_conversation(TENANT_ZERO_ID, AGENT, {ROOM: 0}, limit=100)

    assert first.events == []
    place = first.through.get(ROOM, 0)
    assert place < a_first.seq

    # B is decided without its second file.
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(delete(PendingAttachmentGroup))
        await session.commit()

    second = await buffer.read_conversation(
        TENANT_ZERO_ID, AGENT, {ROOM: place}, limit=100
    )

    assert [_files(item) for item in second.events] == [
        {"b-one.pdf"},
        {"a-one.pdf", "a-two.pdf"},
    ]


async def test_a_place_past_the_end_of_a_room_is_brought_back_to_it(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A position never moves back, so a place a room's log does not reach (a
    restored database) would pass over that many of its next messages. The
    agent's own events are left to their own checks."""
    buffer = db_buffer
    await say(session_factory, ROOM, "one")
    await say(session_factory, ROOM, "two")

    within, past = await buffer.within_rooms(
        TENANT_ZERO_ID,
        {OWN_EVENTS: 99, room_source(ROOM): 9, room_source(EMPTY_ROOM): 3},
    )

    assert within == {OWN_EVENTS: 99, room_source(ROOM): 2, room_source(EMPTY_ROOM): 0}
    assert past == [ROOM, EMPTY_ROOM]


async def test_a_poll_for_an_agent_deleted_meanwhile_saves_nothing(
    db_buffer: EventBuffer, session_factory: SessionFactory
) -> None:
    """A long poll can be waiting when its agent is deleted. The place it would
    save goes with the agent rather than failing the request."""
    buffer = db_buffer
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        await session.execute(delete(Agent).where(Agent.id == AGENT))
        await session.commit()

    assert await buffer.poll(TENANT_ZERO_ID, AGENT, rooms={ROOM}, timeout=0) == []
