"""The router announces the rows it writes once they have committed.

A transaction that sends a `NOTIFY` holds every other notifying commit in the
database back until it is durable, so the triggers on `messages` and
`agent_events` stand down for the router's transactions, and the router hands
the same announcements to the process's `Announcer` after its commit.

Against real PostgreSQL with a real `LISTEN`: what a listener hears is the
point. Every other writer still announces through the triggers, and listeners
re-check on a timer for an announcement a dying process never sent.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from switch_core.announcer import Announcer
from switch_core.bridges.agent.protocol import (
    agent_event_listener as agent_event_listener_module,
)
from switch_core.bridges.agent.protocol.agent_connections import (
    PROTOCOL_VERSION,
    ClientDeclaration,
)
from switch_core.bridges.agent.protocol.agent_event_listener import AgentEventListener
from switch_core.bridges.agent.protocol.positions import OWN_EVENTS
from switch_core.db.agent_event_notify_ddl import (
    AGENT_EVENT_CHANNEL,
    agent_event_announcement,
)
from switch_core.db.models import TENANT_ZERO_ID, Message
from switch_core.db.notify_ddl import MESSAGE_CHANNEL, message_announcement
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore
from switch_core.messages.row import message_row
from tests.routing import (
    Process,
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)
from tests.switch_core.test_announcer import heard

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from switch_core.db.models import Agent, Client, Room


async def _room_with_an_agent(
    session_factory: async_sessionmaker[AsyncSession], process: Process
) -> tuple[Room, Client, Agent]:
    room = await make_room(session_factory)
    louisa = await make_person(session_factory, "louisa")
    await add_member(session_factory, room, louisa)
    agent, client = await make_agent(
        session_factory, "member", connection_model="session_addressable"
    )
    await add_member(session_factory, room, client, agent=agent)
    # Connected, so a message addressed to it is its own event and nothing
    # more: an agent away would also be sent a reply saying so.
    process.connections.open(
        agent_id=agent.id,
        connection_id="c1",
        scope="single",
        delivery_filter="all",
        spawn_capable=False,
        position={OWN_EVENTS: 0},
        declaration=ClientDeclaration(speaks=PROTOCOL_VERSION),
        expected_generation=None,
    )
    # Louisa's transport knows the room from here on.
    await process.say(room, "hello", sender=louisa)
    return room, louisa, agent


async def _written_since(
    session_factory: async_sessionmaker[AsyncSession],
    room: Room,
    agent: Agent,
    *,
    after_seq: int,
    after_event: int,
) -> list[tuple[str, dict[str, object]]]:
    """What the triggers would have announced for the rows written past
    those positions: each message of the room, and each own event of the
    agent."""
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        messages = (
            await session.scalars(
                select(Message)
                .where(Message.room_id == room.id, Message.seq > after_seq)
                .order_by(Message.seq)
            )
        ).all()
    events = [
        event
        for event in await own_events(session_factory, agent.id)
        if event.seq > after_event
    ]
    assert messages and events
    return [
        (
            MESSAGE_CHANNEL,
            json.loads(
                message_announcement(
                    room.id, message.seq, message.id, message.event_type
                )
            ),
        )
        for message in messages
    ] + [
        (AGENT_EVENT_CHANNEL, json.loads(agent_event_announcement(agent.id, event.seq)))
        for event in events
    ]


async def _positions(
    session_factory: async_sessionmaker[AsyncSession], room: Room, agent: Agent
) -> tuple[int, int]:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        head = await MessageStore().head_seq(session, room.id)
    events = await own_events(session_factory, agent.id)
    return head, max((event.seq for event in events), default=0)


def _sorted(
    announcements: list[tuple[str, dict[str, object]]],
) -> list[tuple[str, dict[str, object]]]:
    return sorted(announcements, key=lambda each: (each[0], json.dumps(each[1])))


class TestAfterTheCommit:
    @pytest.mark.parametrize("writer_announces", [False, True])
    async def test_message_edit_announces_and_rings_after_commit(
        self,
        postgres_url: str,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
        writer_announces: bool,
    ) -> None:
        original_process = process_on(session_factory)
        room, louisa, agent = await _room_with_an_agent(
            session_factory, original_process
        )
        original_id = await original_process.say(
            room, "@member original", sender=louisa
        )
        await original_process.idle()
        after_seq, after_event = await _positions(session_factory, room, agent)
        announcer = Announcer(session_factory) if writer_announces else None
        process = process_on(session_factory, announcer=announcer)
        ring = Mock(wraps=process.router.services.event_buffer.ring)
        monkeypatch.setattr(process.router.services.event_buffer, "ring", ring)
        announce = Mock(wraps=announcer.announce) if announcer is not None else None
        if announcer is not None:
            monkeypatch.setattr(announcer, "announce", announce)
            await announcer.start()
        try:
            async with heard(postgres_url) as announcements:
                async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
                    routed = await process.router.store(
                        session,
                        tenant_id=TENANT_ZERO_ID,
                        room_id=room.id,
                        transport_room_id=room.transport_room_id,
                        message=message_row(
                            room_id=room.id,
                            event_id="$edited",
                            sender_id=louisa.transport_user_id,
                            sender_client_id=louisa.id,
                            sender_name=louisa.display_name,
                            event_type="com.switch.message_edit",
                            content={
                                "m.relates_to": {
                                    "rel_type": "m.replace",
                                    "event_id": original_id,
                                },
                                "m.new_content": {"body": "@member corrected"},
                                "revision": 123456,
                            },
                            client_txn_id=None,
                        ),
                        attachments=[],
                    )
                    assert routed is not None
                    ring.assert_not_called()
                    if announce is not None:
                        announce.assert_not_called()
                    await session.commit()
                edits = await own_events(session_factory, agent.id)
                edit = edits[-1]
                assert edit.type == "message_edit"
                assert routed._stored == [(agent.id, edit.seq)]
                routed.committed()
                ring.assert_called_once_with(agent.id, edit.seq)
                if announce is not None:
                    assert announce.call_count == 2
                if announcer is not None:
                    await announcer.stop()
            written = await _written_since(
                session_factory,
                room,
                agent,
                after_seq=after_seq,
                after_event=after_event,
            )
            assert _sorted(
                [(channel, json.loads(payload)) for channel, payload in announcements]
            ) == _sorted(written)
            assert not any(
                "Could not finish routing" in record.getMessage()
                for record in caplog.records
            )
        finally:
            if announcer is not None:
                await announcer.stop()

    async def test_every_row_is_announced_once_as_the_trigger_would(
        self, postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Once each, with the payloads the triggers send: the triggers sent
        nothing for the router's transactions."""
        announcer = Announcer(session_factory)
        process = process_on(session_factory, announcer=announcer)
        room, louisa, agent = await _room_with_an_agent(session_factory, process)
        after_seq, after_event = await _positions(session_factory, room, agent)
        await announcer.start()

        async with heard(postgres_url) as announcements:
            await process.say(room, "@member can you look at this", sender=louisa)
            await process.idle()
            await announcer.stop()

        written = await _written_since(
            session_factory, room, agent, after_seq=after_seq, after_event=after_event
        )
        heard_now = [
            (channel, json.loads(payload)) for channel, payload in announcements
        ]
        assert _sorted(heard_now) == _sorted(written)
        # A message is announced before the own events it caused.
        assert heard_now[0][0] == MESSAGE_CHANNEL

    async def test_without_an_announcer_the_triggers_announce_the_same(
        self, postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A process without an announcer leaves it to the triggers, as a
        process of an older release does; a listener hears the same."""
        process = process_on(session_factory)
        room, louisa, agent = await _room_with_an_agent(session_factory, process)
        after_seq, after_event = await _positions(session_factory, room, agent)

        async with heard(postgres_url) as announcements:
            await process.say(room, "@member can you look at this", sender=louisa)
            await process.idle()

        written = await _written_since(
            session_factory, room, agent, after_seq=after_seq, after_event=after_event
        )
        heard_now = [
            (channel, json.loads(payload)) for channel, payload in announcements
        ]
        assert _sorted(heard_now) == _sorted(written)

    async def test_a_write_that_rolls_back_announces_nothing(
        self, postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        announcer = Announcer(session_factory)
        process = process_on(session_factory, announcer=announcer)
        room, louisa, _ = await _room_with_an_agent(session_factory, process)
        await announcer.start()

        async with heard(postgres_url) as announcements:
            async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
                routed = await process.router.store(
                    session,
                    tenant_id=TENANT_ZERO_ID,
                    room_id=room.id,
                    transport_room_id=room.transport_room_id,
                    message=message_row(
                        room_id=room.id,
                        event_id="$never-committed",
                        sender_id=louisa.transport_user_id,
                        sender_client_id=louisa.id,
                        sender_name=louisa.display_name,
                        event_type="m.room.message",
                        content={"msgtype": "m.text", "body": "@member never mind"},
                        client_txn_id=None,
                    ),
                    attachments=[],
                )
                assert routed is not None
                await session.rollback()
            await announcer.stop()

        assert announcements == []

    async def test_a_writer_that_does_not_announce_is_still_heard(
        self, postgres_url: str, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Only a transaction that says it announces its rows itself turns
        the triggers off: a row written any other way announces itself."""
        process = process_on(session_factory)
        room, louisa, _ = await _room_with_an_agent(session_factory, process)

        async with heard(postgres_url, (MESSAGE_CHANNEL,)) as announcements:
            async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
                message = message_row(
                    room_id=room.id,
                    event_id="$by-hand",
                    sender_id=louisa.transport_user_id,
                    sender_client_id=louisa.id,
                    sender_name=louisa.display_name,
                    event_type="m.room.message",
                    content={"msgtype": "m.text", "body": "written by hand"},
                    client_txn_id=None,
                )
                await MessageStore().create(session, message, [])
                await session.commit()

        assert [json.loads(payload)["id"] for _, payload in announcements] == [
            message.id
        ]


class TestALostAnnouncement:
    async def test_the_heads_told_are_forgotten_and_read_again(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        process = process_on(session_factory)
        room, louisa, agent = await _room_with_an_agent(session_factory, process)
        process.buffer.listening(True)
        process.buffer.doorbell(agent.id)
        await process.say(room, "@member can you look at this", sender=louisa)
        await process.idle()
        [*_, event] = await own_events(session_factory, agent.id)
        assert process.buffer._told_heads == {agent.id: event.seq}

        process.buffer.forget_told_heads()

        assert process.buffer._told_heads == {}
        heads = await process.buffer.heads(TENANT_ZERO_ID, {agent.id})
        assert heads == {agent.id: event.seq}

    async def test_the_listener_forgets_them_every_heartbeat(
        self, postgres_url: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(agent_event_listener_module, "HEARTBEAT_SECONDS", 0.02)

        class _Buffer:
            forgotten = 0

            def listening(self, _now: bool) -> None:
                pass

            def forget_told_heads(self) -> None:
                self.forgotten += 1

        buffer = _Buffer()
        listener = AgentEventListener(
            lambda: create_async_engine(postgres_url, poolclass=NullPool),
            buffer,  # type: ignore[arg-type]
        )
        await listener.start()
        try:
            async with asyncio.timeout(10):
                while buffer.forgotten < 2:
                    await asyncio.sleep(0.01)
        finally:
            await listener.stop()
