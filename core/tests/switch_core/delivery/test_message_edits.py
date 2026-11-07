"""An edit of a message is a row of its own, decided for the agents the message
reached.

The original row is never rewritten. The edit carries the new text and an
`m.replace` relation to the message, and the router hands it to exactly the
agents whose own event the message was, as a `message_edit` saying what that
delivery said (addressed or not, which thread). Its own text addresses nobody:
an edit cannot reach an agent the message did not, and it is never something
to act on twice. What cannot be an edit is refused before the row is numbered.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.types import (
    AgentEvent,
    MessageEditPayload,
    MessagePayload,
)
from switch_core.db.models import TENANT_ZERO_ID, Message, Room
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore
from switch_core.delivery.router import EditRefused
from tests.routing import (
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)

SessionFactory = async_sessionmaker[AsyncSession]


async def _rows(session_factory: SessionFactory, room: Room) -> list[Message]:
    async with tenant_session(session_factory, room.tenant_id) as session:
        return list(
            (
                await session.scalars(
                    select(Message)
                    .where(Message.room_id == room.id)
                    .order_by(Message.seq)
                )
            ).all()
        )


async def _events(session_factory: SessionFactory, agent_id: str) -> list[AgentEvent]:
    return [
        AgentEvent.model_validate(row.payload)
        for row in await own_events(session_factory, agent_id)
    ]


class TestWhoAnEditReaches:
    async def test_the_agent_the_message_reached_gets_its_new_text(
        self, session_factory: SessionFactory
    ) -> None:
        here = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        helper, helper_client = await make_agent(session_factory, "helper")
        await add_member(session_factory, room, helper_client, agent=helper)
        await add_member(session_factory, room, alice)

        root = await here.say(room, "a thread about a file", sender=alice)
        original = await here.say(
            room, "@helper look at teh file", sender=alice, thread_root_id=root
        )
        edit = await here.say(
            room,
            "@helper look at the file",
            sender=alice,
            replaces_event_id=original,
        )
        await here.idle()

        events = await _events(session_factory, helper.id)
        assert [event.type for event in events] == ["message", "message_edit"]
        delivered = events[0].payload
        assert isinstance(delivered, MessagePayload)
        assert delivered.message_id == original
        payload = events[1].payload
        assert isinstance(payload, MessageEditPayload)
        assert payload.message_id == edit
        assert payload.replaces_message_id == original
        assert payload.body == "@helper look at the file"
        assert payload.addressed is True
        assert payload.thread_id == root
        assert payload.sender == alice.transport_user_id
        assert payload.sender_name == "alice"
        # Numbered by the edit row, so a reader's cursor moves past it.
        rows = await own_events(session_factory, helper.id)
        assert rows[1].message_key == edit
        [edit_row] = [
            r for r in await _rows(session_factory, room) if r.replaces_event_id
        ]
        assert edit_row.transport_event_id == edit
        assert rows[1].room_seq == edit_row.seq

    async def test_an_edit_never_addresses_an_agent_the_message_did_not(
        self, session_factory: SessionFactory
    ) -> None:
        """Whatever names the new text drops or adds."""
        here = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        helper, helper_client = await make_agent(session_factory, "helper")
        reviewer, reviewer_client = await make_agent(session_factory, "reviewer")
        for agent, client in [(helper, helper_client), (reviewer, reviewer_client)]:
            await add_member(session_factory, room, client, agent=agent)
        await add_member(session_factory, room, alice)

        original = await here.say(room, "@helper look at this", sender=alice)
        await here.say(
            room, "@reviewer look at this", sender=alice, replaces_event_id=original
        )
        await here.idle()

        assert await own_events(session_factory, reviewer.id) == []
        events = await _events(session_factory, helper.id)
        assert [event.type for event in events] == ["message", "message_edit"]
        assert events[1].payload.body == "@reviewer look at this"  # type: ignore[union-attr]

    async def test_an_edit_of_the_rooms_chatter_is_written_for_nobody(
        self, session_factory: SessionFactory
    ) -> None:
        here = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        helper, helper_client = await make_agent(session_factory, "helper")
        await add_member(session_factory, room, helper_client, agent=helper)
        await add_member(session_factory, room, alice)

        original = await here.say(room, "hello all", sender=alice)
        await here.say(room, "hello everyone", sender=alice, replaces_event_id=original)
        await here.idle()

        assert await own_events(session_factory, helper.id) == []
        rows = await _rows(session_factory, room)
        assert [row.body for row in rows] == ["hello all", "hello everyone"]
        assert rows[1].replaces_event_id == original
        assert rows[0].body == "hello all", "the original is never rewritten"

    async def test_an_agent_reading_the_whole_conversation_reads_the_edit_too(
        self, session_factory: SessionFactory
    ) -> None:
        here = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        helper, helper_client = await make_agent(session_factory, "helper")
        await add_member(session_factory, room, helper_client, agent=helper)
        await add_member(session_factory, room, alice)

        root = await here.say(room, "a thread", sender=alice)
        original = await here.say(room, "hello all", sender=alice, thread_root_id=root)
        await here.say(room, "hello everyone", sender=alice, replaces_event_id=original)
        await here.idle()

        conversation = await here.buffer.read_conversation(
            TENANT_ZERO_ID, helper.id, {room.id: 0}, limit=10
        )
        events = [buffered.event for buffered in conversation.events]
        assert [event.type for event in events] == [
            "message",
            "message",
            "message_edit",
        ]
        payload = events[2].payload
        assert isinstance(payload, MessageEditPayload)
        assert payload.replaces_message_id == original
        assert payload.body == "hello everyone"
        assert payload.addressed is False
        assert payload.thread_id == root


class TestWhatIsRefused:
    async def test_only_the_sender_may_edit(
        self, session_factory: SessionFactory
    ) -> None:
        here = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        bob = await make_person(session_factory, "bob")
        helper, helper_client = await make_agent(session_factory, "helper")
        await add_member(session_factory, room, helper_client, agent=helper)
        await add_member(session_factory, room, alice)
        await add_member(session_factory, room, bob)

        original = await here.say(room, "@helper look", sender=alice)
        with pytest.raises(EditRefused, match="only its sender"):
            await here.say(room, "@helper stop", sender=bob, replaces_event_id=original)
        await here.idle()

        # The message and the offline helper's notice, and no edit.
        rows = await _rows(session_factory, room)
        assert [row.replaces_event_id for row in rows] == [None, None]
        assert "stop" not in " ".join(row.body or "" for row in rows)
        assert len(await own_events(session_factory, helper.id)) == 1

    async def test_a_command_is_not_edited_into_anything(
        self, session_factory: SessionFactory
    ) -> None:
        here = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        await add_member(session_factory, room, alice)

        command = await here.command(room, "help", "", sender=alice)
        with pytest.raises(EditRefused, match="not a message"):
            await here.say(room, "hello", sender=alice, replaces_event_id=command)

    async def test_an_edit_is_of_the_message_not_of_an_earlier_edit(
        self, session_factory: SessionFactory
    ) -> None:
        here = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        await add_member(session_factory, room, alice)

        original = await here.say(room, "one", sender=alice)
        first = await here.say(room, "two", sender=alice, replaces_event_id=original)
        with pytest.raises(EditRefused, match="itself an edit"):
            await here.say(room, "three", sender=alice, replaces_event_id=first)

    async def test_an_edit_of_a_message_not_in_the_room_is_refused(
        self, session_factory: SessionFactory
    ) -> None:
        here = process_on(session_factory)
        room = await make_room(session_factory)
        elsewhere = await make_room(session_factory, "elsewhere")
        alice = await make_person(session_factory, "alice")
        await add_member(session_factory, room, alice)
        await add_member(session_factory, elsewhere, alice)

        original = await here.say(elsewhere, "over there", sender=alice)
        with pytest.raises(EditRefused, match="not a message in room"):
            await here.say(room, "over here", sender=alice, replaces_event_id=original)
        assert await _rows(session_factory, room) == []


class TestLatestText:
    async def test_the_store_gives_the_newest_edit_of_each_message(
        self, session_factory: SessionFactory
    ) -> None:
        here = process_on(session_factory)
        room = await make_room(session_factory)
        alice = await make_person(session_factory, "alice")
        await add_member(session_factory, room, alice)

        edited = await here.say(room, "one", sender=alice)
        untouched = await here.say(room, "as sent", sender=alice)
        await here.say(room, "two", sender=alice, replaces_event_id=edited)
        await here.say(room, "three", sender=alice, replaces_event_id=edited)

        async with tenant_session(session_factory, room.tenant_id) as session:
            latest = await MessageStore().latest_replacements(
                session, room.id, [edited, untouched, "$nowhere"]
            )
        assert set(latest) == {edited}
        assert latest[edited].body == "three"
