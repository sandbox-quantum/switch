"""An edit of a room message reaches the agents the message reached, and no
one else: whom a message is for was settled when it arrived."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.messages.edits import edit_content, edit_fallback
from tests.routing import (
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)

SessionFactory = async_sessionmaker[AsyncSession]


async def _room(session_factory: SessionFactory):  # type: ignore[no-untyped-def]
    process = process_on(session_factory)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    bob = await make_person(session_factory, "bob")
    helper, helper_client = await make_agent(session_factory, "helper")
    reviewer, reviewer_client = await make_agent(session_factory, "reviewer")
    for client in (alice, bob):
        await add_member(session_factory, room, client)
    await add_member(session_factory, room, helper_client, agent=helper)
    await add_member(session_factory, room, reviewer_client, agent=reviewer)
    return process, room, alice, bob, helper, reviewer


async def _edit(process, room, sender, original: str, body: str) -> str:  # type: ignore[no-untyped-def]
    return await process.say(
        room,
        edit_fallback(body),
        sender=sender,
        extra_content=edit_content(original, body),
    )


async def test_an_edit_reaches_only_the_agents_the_message_reached(
    session_factory: SessionFactory,
) -> None:
    process, room, alice, _, helper, reviewer = await _room(session_factory)
    original = await process.say(room, "@helper fix the bug in pasre.py", sender=alice)
    # Naming another agent in the edit does not start that agent on it.
    edit = await _edit(
        process, room, alice, original, "@helper @reviewer fix the bug in parse.py"
    )
    await process.idle()

    helper_events = await own_events(session_factory, helper.id)
    assert [event.type for event in helper_events] == ["message", "message_edit"]
    payload = helper_events[1].payload
    assert payload["type"] == "message_edit"
    assert payload["payload"]["message_id"] == original
    assert payload["payload"]["edit_id"] == edit
    assert payload["payload"]["body"] == "@helper @reviewer fix the bug in parse.py"
    assert payload["payload"]["sender"] == alice.transport_user_id
    assert helper_events[1].notifiable is True
    assert await own_events(session_factory, reviewer.id) == []


async def test_only_the_sender_can_edit_a_message(
    session_factory: SessionFactory,
) -> None:
    process, room, alice, bob, helper, _ = await _room(session_factory)
    original = await process.say(room, "@helper deploy to staging", sender=alice)
    await _edit(process, room, bob, original, "@helper deploy to production")
    await process.idle()

    assert [e.type for e in await own_events(session_factory, helper.id)] == ["message"]


async def test_an_edit_of_a_message_nobody_received_reaches_nobody(
    session_factory: SessionFactory,
) -> None:
    process, room, alice, _, helper, reviewer = await _room(session_factory)
    original = await process.say(room, "lunch at noon?", sender=alice)
    await _edit(process, room, alice, original, "@helper lunch at one?")
    await _edit(process, room, alice, "$not-in-this-room", "@helper anything")
    await process.idle()

    assert await own_events(session_factory, helper.id) == []
    assert await own_events(session_factory, reviewer.id) == []
