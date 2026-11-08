"""An edit to a room message reaches the agents the original reached, and
nobody else.

Each test runs on real Postgres: who an edit is for is read from the original's
`agent_events` rows, so a fake store would prove nothing about it.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import event as sa_event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.agent.protocol.agent_core import AgentCore
from switch_core.bridges.agent.protocol.event_buffer import is_notifiable
from switch_core.bridges.agent.protocol.types import AgentEvent, MessageEditPayload
from switch_core.clients.consumer import Consumer
from switch_core.db.models import Client, Message, Room
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore
from switch_core.messages.edits import (
    MESSAGE_EDIT_EVENT_TYPE,
    MessageEdit,
    edit_content,
    edit_source,
    parse_edit,
)
from switch_core.transport.derived_ids import writes_derived_from
from switch_core.transport.types import InboundCustomEvent, RoomRef
from tests.routing import (
    Process,
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)

SessionFactory = async_sessionmaker[AsyncSession]


async def _edit(
    process: Process,
    room: Room,
    original: str,
    body: str,
    *,
    sender: Client,
    revision: int = 1,
) -> str:
    """Write an edit the way the bridge does: its id derived from what it edits."""
    with writes_derived_from(sender.id, edit_source(original, revision)):
        result = await process.transport(sender).send_event(
            room.transport_room_id,
            MESSAGE_EDIT_EVENT_TYPE,
            edit_content(
                MessageEdit(
                    original_event_id=original,
                    new_body=body,
                    revision=revision,
                    author=sender.transport_user_id,
                    room=room.id,
                    timestamp=1_700_000_000_000 + revision,
                )
            ),
        )
    return result.event_id


async def _row(factory: SessionFactory, room: Room, event_id: str) -> Message | None:
    async with tenant_session(factory, room.tenant_id) as session:
        return await MessageStore().get_by_transport_event_id(session, event_id)


async def _setup(factory: SessionFactory) -> tuple[Process, Room, Client, str, str]:
    process = process_on(factory)
    room = await make_room(factory)
    alice = await make_person(factory, "alice")
    await add_member(factory, room, alice)
    named, named_client = await make_agent(factory, "named")
    other, other_client = await make_agent(factory, "other")
    await add_member(factory, room, named_client, agent=named)
    await add_member(factory, room, other_client, agent=other)
    return process, room, alice, named.id, other.id


def test_the_row_shape_is_generic_and_round_trips() -> None:
    edit = MessageEdit(
        original_event_id="sw_original",
        new_body="Decline",
        revision=7,
        author="@alice:test",
        room="room-1",
        timestamp=1234,
    )
    content = edit_content(edit)
    assert content["m.relates_to"] == {
        "rel_type": "m.replace",
        "event_id": "sw_original",
    }
    assert content["m.new_content"] == {"msgtype": "m.text", "body": "Decline"}
    assert parse_edit(content) == edit
    # Nothing about a queued prompt: another caller can reuse the shape.
    assert parse_edit({"m.relates_to": {"rel_type": "m.annotation"}}) is None


class TestRecipients:
    async def test_only_the_agents_that_received_the_original(
        self, session_factory: SessionFactory
    ) -> None:
        process, room, alice, named, other = await _setup(session_factory)
        original = await process.say(room, "@named Approve", sender=alice)

        # The edit names the other agent, and that changes nothing: it is
        # never addressed again.
        await _edit(process, room, original, "@other Decline", sender=alice)
        await process.idle()

        events = await own_events(session_factory, named)
        assert [event.type for event in events] == ["message", "message_edit"]
        edit = events[1].payload["payload"]
        assert edit["message_id"] == original
        assert edit["new_body"] == "@other Decline"
        assert edit["revision"] == 1
        assert await own_events(session_factory, other) == []

    async def test_the_lookup_names_the_agents_so_the_index_serves_it(
        self, session_factory: SessionFactory
    ) -> None:
        """Without the agents, `uq_agent_events_source` cannot serve the read,
        and every edit scans the workspace's events."""
        process, room, alice, named, _ = await _setup(session_factory)
        original = await process.say(room, "@named Approve", sender=alice)
        engine = session_factory.kw["bind"].sync_engine
        lookups: list[str] = []

        def capture(_c: object, _k: object, sql: str, *_rest: object) -> None:
            if "agent_events.payload" in sql and "message_key =" in sql:
                lookups.append(sql)

        sa_event.listen(engine, "before_cursor_execute", capture)
        try:
            await _edit(process, room, original, "@named Decline", sender=alice)
            await process.idle()
        finally:
            sa_event.remove(engine, "before_cursor_execute", capture)

        assert lookups
        assert all("agent_events.agent_id IN" in sql for sql in lookups)
        events = await own_events(session_factory, named)
        assert [event.type for event in events] == ["message", "message_edit"]

    async def test_no_new_invocation_and_the_original_row_is_untouched(
        self, session_factory: SessionFactory
    ) -> None:
        process, room, alice, named, _ = await _setup(session_factory)
        original = await process.say(room, "@named Approve", sender=alice)
        edit_id = await _edit(process, room, original, "@named Decline", sender=alice)
        await process.idle()

        events = await own_events(session_factory, named)
        assert sum(event.type == "message" for event in events) == 1
        row = await _row(session_factory, room, original)
        assert row is not None and row.body == "@named Approve"
        replacement = await _row(session_factory, room, edit_id)
        assert replacement is not None
        assert replacement.event_type == MESSAGE_EDIT_EVENT_TYPE
        assert replacement.seq > row.seq

    async def test_every_agent_that_received_it_hears(
        self, session_factory: SessionFactory
    ) -> None:
        process, room, alice, named, other = await _setup(session_factory)
        original = await process.say(room, "@named @other Approve", sender=alice)
        await _edit(process, room, original, "Decline", sender=alice)
        await process.idle()
        for agent in (named, other):
            types = [e.type for e in await own_events(session_factory, agent)]
            assert types == ["message", "message_edit"]

    async def test_a_multi_file_post_is_found_by_its_group(
        self, session_factory: SessionFactory
    ) -> None:
        process, room, alice, named, _ = await _setup(session_factory)
        group = {"id": "group-1", "total": 2}
        first = await process.send_file(
            room,
            "a.txt",
            sender=alice,
            caption="@named Approve",
            group={**group, "index": 0},
        )
        await process.send_file(
            room, "b.txt", sender=alice, group={**group, "index": 1}
        )
        await _edit(process, room, first, "Decline", sender=alice)
        await process.idle()

        events = await own_events(session_factory, named)
        assert [event.type for event in events] == ["message", "message_edit"]
        told = [event.payload["payload"]["message_id"] for event in events]
        assert told[0] == told[1]


class TestDeduplication:
    async def test_the_same_revision_is_stored_and_delivered_once(
        self, session_factory: SessionFactory
    ) -> None:
        process, room, alice, named, _ = await _setup(session_factory)
        original = await process.say(room, "@named Approve", sender=alice)
        first = await _edit(process, room, original, "Decline", sender=alice)
        again = await _edit(process, room, original, "Decline", sender=alice)
        await process.idle()

        assert first == again
        events = await own_events(session_factory, named)
        assert [event.type for event in events] == ["message", "message_edit"]

    async def test_a_new_revision_is_delivered_too(
        self, session_factory: SessionFactory
    ) -> None:
        process, room, alice, named, _ = await _setup(session_factory)
        original = await process.say(room, "@named Approve", sender=alice)
        await _edit(process, room, original, "Decline", sender=alice, revision=1)
        await _edit(process, room, original, "Hold", sender=alice, revision=2)
        await process.idle()
        events = await own_events(session_factory, named)
        assert [e.payload["payload"]["revision"] for e in events[1:]] == [1, 2]


class TestRefused:
    async def test_an_unknown_message_reaches_nobody(
        self, session_factory: SessionFactory
    ) -> None:
        process, room, alice, named, other = await _setup(session_factory)
        await _edit(process, room, "sw_unknown", "Decline", sender=alice)
        await process.idle()
        assert await own_events(session_factory, named) == []
        assert await own_events(session_factory, other) == []

    async def test_someone_else_editing_reaches_nobody(
        self, session_factory: SessionFactory
    ) -> None:
        process, room, alice, named, _ = await _setup(session_factory)
        mallory = await make_person(session_factory, "mallory")
        await add_member(session_factory, room, mallory)
        original = await process.say(room, "@named Approve", sender=alice)
        await _edit(process, room, original, "Decline", sender=mallory)
        await process.idle()
        types = [e.type for e in await own_events(session_factory, named)]
        assert types == ["message"]

    async def test_an_edit_written_in_another_room_leaks_nowhere(
        self, session_factory: SessionFactory
    ) -> None:
        process, room, alice, named, _ = await _setup(session_factory)
        elsewhere = await make_room(session_factory)
        bystander, bystander_client = await make_agent(session_factory, "bystander")
        await add_member(session_factory, elsewhere, alice)
        await add_member(session_factory, elsewhere, bystander_client, agent=bystander)
        original = await process.say(room, "@named Approve", sender=alice)
        await _edit(process, elsewhere, original, "Decline", sender=alice)
        await process.idle()
        assert [e.type for e in await own_events(session_factory, named)] == ["message"]
        assert await own_events(session_factory, bystander.id) == []

    async def test_a_message_that_addressed_nobody_has_nobody_to_tell(
        self, session_factory: SessionFactory
    ) -> None:
        process, room, alice, named, other = await _setup(session_factory)
        original = await process.say(room, "just chatting", sender=alice)
        await _edit(process, room, original, "@named Decline", sender=alice)
        await process.idle()
        assert await own_events(session_factory, named) == []
        assert await own_events(session_factory, other) == []


def test_an_edit_is_handed_to_a_connection_that_filters_to_what_addresses_it() -> None:
    event = AgentEvent(
        type="message_edit",
        room_id="room",
        payload=MessageEditPayload(
            message_id="m",
            edit_event_id="e",
            new_body="b",
            revision=1,
            sender="s",
            sender_name="n",
            timestamp=1,
        ),
    )
    assert is_notifiable(event) is True


def _edit_row() -> Message:
    edit = MessageEdit(
        original_event_id="sw_original",
        new_body="Decline",
        revision=1,
        author="@alice:test",
        room="room",
        timestamp=1,
    )
    return Message(
        room_id="room",
        transport_event_id="sw_edit",
        sender_id="@alice:test",
        sender_name="alice",
        event_type=MESSAGE_EDIT_EVENT_TYPE,
        content=edit_content(edit),
        sent_at=datetime(2026, 11, 4, tzinfo=UTC),
    )


def test_read_context_shows_the_replacement_beside_the_original() -> None:
    """Without this the row reads as a message with no words, and an agent
    reading the room sees only the text that was replaced."""
    entry = AgentCore._timeline_entry(_edit_row(), [])
    assert entry["kind"] == "message_edit"
    assert entry["edits"] == "sw_original"
    assert entry["body"] == "Decline"


async def test_a_workspace_consumer_passes_over_an_edit_quietly(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The bridge wrote the row; a consumer of the room has nothing to do with it."""

    class Reader(Consumer):
        def __init__(self) -> None:
            pass

        def _should_ignore(self, room: object, event: object) -> bool:
            return False

    await Reader()._handle_custom_event(
        RoomRef(room_id="room"),
        InboundCustomEvent(
            room_id="room",
            event_id="sw_edit",
            sender="@alice:test",
            timestamp=1,
            event_type=MESSAGE_EDIT_EVENT_TYPE,
        ),
    )
    assert "Unhandled custom event" not in caplog.text
