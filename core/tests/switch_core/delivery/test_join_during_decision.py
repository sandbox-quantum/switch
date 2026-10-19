"""An agent that joins while a row is being decided is handed the row.

The router reads the room's agent members before `MessageStore.create` takes
the room's lock and numbers the row. An agent whose arrival commits in between
is a member when the row is numbered (its arrival comes first in the room), so
the row is decided for it too.

The mirror image of `test_a_message_decided_before_the_removal_stores_nothing_after_it`.
"""

from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Message
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.message_store import MessageStore
from tests.routing import (
    add_member,
    make_agent,
    make_person,
    make_room,
    own_events,
    process_on,
)

BODY = "@newcomer welcome, please take this"


async def test_a_mention_numbered_after_the_agents_arrival_reaches_it(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    process = process_on(session_factory)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    await add_member(session_factory, room, alice)
    agent, client = await make_agent(session_factory, "newcomer")

    decided = asyncio.Event()
    joined = asyncio.Event()
    create = MessageStore.create

    async def create_after_the_join(self, session, message, attachments):  # type: ignore[no-untyped-def]
        if message.body == BODY:
            decided.set()
            await joined.wait()
        return await create(self, session, message, attachments)

    monkeypatch.setattr(MessageStore, "create", create_after_the_join)

    sending = asyncio.create_task(process.say(room, BODY, sender=alice))
    await decided.wait()
    # The agent is added while the message is between its decision and its
    # write; the arrival takes the room's lock first and commits.
    await process.provisioning.invite_to_room(
        room.transport_room_id, client.transport_user_id
    )
    joined.set()
    await sending
    await process.idle()

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
    arrival = next(
        r
        for r in rows
        if r.event_type == "m.room.member" and r.sender_client_id == client.id
    )
    mention = next(r for r in rows if r.body == BODY)
    # In room order the agent is a member before the mention was written.
    assert arrival.seq < mention.seq

    # So the mention is one of its own events.
    events = await own_events(session_factory, agent.id)
    assert [e.room_seq for e in events] == [mention.seq], (
        f"arrival seq {arrival.seq}, mention seq {mention.seq}, "
        f"own events {[(e.type, e.room_seq) for e in events]}"
    )


BODY2 = "@latecomer here is the brief"


async def test_a_join_that_began_first_but_committed_during_the_decision(
    monkeypatch: pytest.MonkeyPatch,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The join's transaction starts before the message's, so the mention is
    stamped after the arrival (`sent_at`) as well as numbered after it. The
    members were read before the join committed."""
    process = process_on(session_factory)
    room = await make_room(session_factory)
    alice = await make_person(session_factory, "alice")
    await add_member(session_factory, room, alice)
    agent, client = await make_agent(session_factory, "latecomer")

    join_waiting = asyncio.Event()
    mention_decided = asyncio.Event()
    joined = asyncio.Event()
    create = MessageStore.create

    async def interleave(self, session, message, attachments):  # type: ignore[no-untyped-def]
        if (
            message.event_type == "m.room.member"
            and message.sender_client_id == client.id
        ):
            # The join has written its membership row; hold it uncommitted
            # until the mention has been decided.
            join_waiting.set()
            await mention_decided.wait()
        elif message.body == BODY2:
            mention_decided.set()
            await joined.wait()
        return await create(self, session, message, attachments)

    monkeypatch.setattr(MessageStore, "create", interleave)

    joining = asyncio.create_task(
        process.provisioning.invite_to_room(
            room.transport_room_id, client.transport_user_id
        )
    )
    await join_waiting.wait()
    sending = asyncio.create_task(process.say(room, BODY2, sender=alice))
    await joining
    joined.set()
    await sending
    await process.idle()

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
    arrival = next(
        r
        for r in rows
        if r.event_type == "m.room.member" and r.sender_client_id == client.id
    )
    mention = next(r for r in rows if r.body == BODY2)
    assert arrival.seq < mention.seq
    # Stamped after the arrival too: the old consumer would not have ignored it.
    assert arrival.sent_at < mention.sent_at

    events = await own_events(session_factory, agent.id)
    assert [e.room_seq for e in events] == [mention.seq], (
        f"arrival seq {arrival.seq} at {arrival.sent_at}, mention seq "
        f"{mention.seq} at {mention.sent_at}, own events "
        f"{[(e.type, e.room_seq) for e in events]}"
    )
