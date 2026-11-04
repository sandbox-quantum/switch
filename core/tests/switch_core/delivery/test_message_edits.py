from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Message
from switch_core.db.session_scope import tenant_session
from switch_core.transport.derived_ids import writes_derived_from
from switch_core.transport.types import TransportError
from tests.routing import (
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)


def replacement(original: str, body: str, revision: int = 10) -> dict[str, object]:
    return {
        "msgtype": "m.text",
        "body": body,
        "m.relates_to": {"rel_type": "m.replace", "event_id": original},
        "m.new_content": {"msgtype": "m.text", "body": body},
        "com.switch.edit_revision": revision,
    }


async def test_edit_reaches_original_recipient_without_addressing_new_mentions(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    author = await make_person(session_factory)
    first, first_client = await make_agent(session_factory, "first")
    other, other_client = await make_agent(session_factory, "other")
    await add_member(session_factory, room, author)
    await add_member(session_factory, room, first_client, agent=first)
    await add_member(session_factory, room, other_client, agent=other)
    transport = process.transport(author)
    sent = await transport.send_message(
        room.transport_room_id, "@first Original", sender_name="author", metered=False
    )
    edit = await transport.send_event(
        room.transport_room_id,
        "m.room.message",
        replacement(sent.event_id, "@other Revised"),
    )
    first_events = await own_events(session_factory, first.id)
    assert [event.type for event in first_events] == ["message", "message_edit"]
    assert first_events[-1].payload["payload"] == {
        "message_id": sent.event_id,
        "edit_id": edit.event_id,
        "sender": author.transport_user_id,
        "body": "@other Revised",
        "revision": 10,
    }
    assert first_events[-1].notifiable is True
    assert await own_events(session_factory, other.id) == []
    async with tenant_session(session_factory, room.tenant_id) as session:
        rows = list(
            (
                await session.scalars(
                    select(Message)
                    .where(Message.room_id == room.id)
                    .order_by(Message.seq)
                )
            ).all()
        )
    assert [row.body for row in rows] == ["@first Original", "@other Revised"]


@pytest.mark.parametrize("wrong_room", [False, True])
async def test_wrong_author_or_room_cannot_replace_a_message(
    session_factory: async_sessionmaker[AsyncSession], wrong_room: bool
) -> None:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    author = await make_person(session_factory)
    other = await make_person(session_factory, "other")
    for person in (author, other):
        await add_member(session_factory, room, person)
    original = await process.transport(author).send_message(
        room.transport_room_id, "Original", sender_name="author", metered=False
    )
    target = await make_room(session_factory, "elsewhere") if wrong_room else room
    sender = author if wrong_room else other
    if wrong_room:
        await add_member(session_factory, target, sender)
    with pytest.raises((TransportError, ValueError), match="original author"):
        await process.transport(sender).send_event(
            target.transport_room_id,
            "m.room.message",
            replacement(original.event_id, "Forged"),
        )


async def test_retried_edit_is_stored_and_routed_once_across_processes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    here, there = process_on(session_factory), process_on(session_factory)
    room = await make_room(session_factory)
    author = await make_person(session_factory)
    agent, client = await make_agent(session_factory, "worker")
    await add_member(session_factory, room, author)
    await add_member(session_factory, room, client, agent=agent)
    sent = await here.transport(author).send_message(
        room.transport_room_id, "@worker Original", sender_name="author", metered=False
    )
    for process in (here, there):
        with writes_derived_from(author.id, "same-platform-edit"):
            await process.transport(author).send_event(
                room.transport_room_id,
                "m.room.message",
                replacement(sent.event_id, "Updated"),
            )
    assert [event.type for event in await own_events(session_factory, agent.id)] == [
        "message",
        "message_edit",
    ]


async def test_editing_unaddressed_message_does_not_start_an_agent(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    author = await make_person(session_factory)
    agent, client = await make_agent(session_factory, "worker")
    await add_member(session_factory, room, author)
    await add_member(session_factory, room, client, agent=agent)
    transport = process.transport(author)
    sent = await transport.send_message(
        room.transport_room_id, "Chatter", sender_name="author", metered=False
    )
    await transport.send_event(
        room.transport_room_id,
        "m.room.message",
        replacement(sent.event_id, "@worker New mention"),
    )
    assert await own_events(session_factory, agent.id) == []


async def test_edit_of_grouped_attachment_caption_keeps_original_recipient(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    author = await make_person(session_factory)
    agent, client = await make_agent(session_factory, "worker")
    await add_member(session_factory, room, author)
    await add_member(session_factory, room, client, agent=agent)
    transport = process.transport(author)
    original = await transport.send_media(
        room.transport_room_id,
        "mxc://example.test/file-one",
        "one.txt",
        "text/plain",
        10,
        sender_name="author",
        msgtype="m.file",
        caption="@worker Original caption",
        group={"id": "post-group", "index": 0, "total": 2},
        metered=False,
    )
    await transport.send_media(
        room.transport_room_id,
        "mxc://example.test/file-two",
        "two.txt",
        "text/plain",
        10,
        sender_name="author",
        msgtype="m.file",
        caption=None,
        group={"id": "post-group", "index": 1, "total": 2},
        metered=False,
    )
    await transport.send_event(
        room.transport_room_id,
        "m.room.message",
        replacement(original.event_id, "Revised caption"),
    )
    events = await own_events(session_factory, agent.id)
    assert [event.type for event in events] == ["message", "message_edit"]
    assert events[0].payload["payload"]["message_id"] == original.event_id
    assert len(events[0].payload["payload"]["attachments"]) == 2
    assert events[-1].payload["payload"]["message_id"] == original.event_id
