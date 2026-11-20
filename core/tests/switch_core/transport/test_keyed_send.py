"""A send under a sender's key (`client_txn_id`) is posted once.

The box's "I was restarted" line is sent under
`restart:<turnId>`, so a retry whose answer was lost, or a second start, can't
post it twice. The key is scoped to the sending client
(uq_messages_sender_client_txn)."""

from __future__ import annotations

import asyncio

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Message
from tests.switch_core.transport.test_postgres_transport import (
    _make_client,
    _make_room,
    _transport,
)

KEY = "restart:turn-cut-off"


async def _count(session_factory: async_sessionmaker[AsyncSession], body: str) -> int:
    async with session_factory() as session:
        return int(
            await session.scalar(select(func.count()).where(Message.body == body)) or 0
        )


async def test_a_second_send_under_the_same_key_is_the_first_message(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        _, room, client_id, user_id = await _make_room(session)
        await session.commit()
    box = _transport(session_factory, client_id=client_id, user_id=user_id)

    first = await box.send_message(
        room, "restarted", sender_name="agent one", metered=True, client_txn_id=KEY
    )
    again = await box.send_message(
        room, "restarted", sender_name="agent one", metered=True, client_txn_id=KEY
    )

    assert again.event_id == first.event_id
    assert await _count(session_factory, "restarted") == 1


async def test_two_sends_under_one_key_at_once_post_one_message(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        _, room, client_id, user_id = await _make_room(session)
        await session.commit()
    box = _transport(session_factory, client_id=client_id, user_id=user_id)

    results = await asyncio.gather(
        *(
            box.send_message(
                room, "raced", sender_name="agent one", metered=True, client_txn_id=KEY
            )
            for _ in range(4)
        )
    )

    assert len({result.event_id for result in results}) == 1
    assert await _count(session_factory, "raced") == 1


async def test_a_key_is_the_senders_own(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        _, room, client_id, user_id = await _make_room(session)
        other_id, other_mxid = await _make_client(session, "another-agent")
        await session.commit()
    mine = _transport(session_factory, client_id=client_id, user_id=user_id)
    theirs = _transport(session_factory, client_id=other_id, user_id=other_mxid)

    a = await mine.send_message(
        room, "scoped", sender_name="agent one", metered=True, client_txn_id=KEY
    )
    b = await theirs.send_message(
        room, "scoped", sender_name="another", metered=True, client_txn_id=KEY
    )

    assert a.event_id != b.event_id
    assert await _count(session_factory, "scoped") == 2


async def test_a_reply_key_is_the_senders_own(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # A host's `reply:` key can never make another agent's reply a copy.
    async with session_factory() as session:
        _, room, client_id, user_id = await _make_room(session)
        other_id, other_mxid = await _make_client(session, "another-agent")
        await session.commit()
    mine = _transport(session_factory, client_id=client_id, user_id=user_id)
    theirs = _transport(session_factory, client_id=other_id, user_id=other_mxid)

    a = await mine.send_message(
        room, "reply", sender_name="agent one", metered=True, client_txn_id="reply:k"
    )
    b = await theirs.send_message(
        room, "reply", sender_name="another", metered=True, client_txn_id="reply:k"
    )
    again = await mine.send_message(
        room, "reply", sender_name="agent one", metered=True, client_txn_id="reply:k"
    )

    assert a.event_id != b.event_id
    assert again.event_id == a.event_id
    assert await _count(session_factory, "reply") == 2


async def test_sends_without_a_key_are_unchanged(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        _, room, client_id, user_id = await _make_room(session)
        await session.commit()
    box = _transport(session_factory, client_id=client_id, user_id=user_id)

    await box.send_message(room, "twice", sender_name="agent one", metered=True)
    await box.send_message(room, "twice", sender_name="agent one", metered=True)

    assert await _count(session_factory, "twice") == 2
