"""Correcting a bridged room's saved channel type.

A room saved as public when its channel is private shows the wrong privacy,
and a move to another bridge opens a public channel there. The bridge corrects
it on startup from an earlier read of the room, so the write only lands if the
room is still bound the way it was read.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, CollaborationBridge, Room
from switch_core.db.stores.room_store import RoomStore

CHANNEL = "19:p@thread.tacv2"


async def _make_bridge(session: AsyncSession) -> CollaborationBridge:
    client = Client(
        matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
        display_name="teams client",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="teams",
        display_name="teams",
        connection_config={},
        client_id=client.id,
        status="active",
    )
    session.add(bridge)
    await session.flush()
    return bridge


async def _make_room(store: RoomStore, session: AsyncSession, bridge_id: str) -> Room:
    return await store.create(
        session,
        Room(
            matrix_room_id=f"!{uuid.uuid4().hex[:8]}:test",
            name="private",
            description="private desc",
            bridge_id=bridge_id,
            channel_type="channel_public",
            external_channel_id=CHANNEL,
        ),
    )


async def _correct(
    store: RoomStore, session: AsyncSession, room_id: str, bridge_id: str
) -> bool:
    return await store.correct_channel_type(
        session,
        room_id,
        bridge_id=bridge_id,
        external_channel_id=CHANNEL,
        saved_type="channel_public",
        channel_type="channel_private",
    )


async def test_an_unchanged_room_is_corrected(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        bridge = await _make_bridge(session)
        room = await _make_room(store, session, bridge.id)
        await session.commit()

        assert await _correct(store, session, room.id, bridge.id) is True
        await session.commit()

    async with session_factory() as session:
        reread = await store.get(session, room.id)
        assert reread is not None
        assert reread.channel_type == "channel_private"
        assert reread.bridge_id == bridge.id
        assert reread.external_channel_id == CHANNEL


async def test_a_room_unlinked_since_the_read_is_left_alone(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        bridge = await _make_bridge(session)
        room = await _make_room(store, session, bridge.id)
        await session.commit()
        await store.clear_bridge(session, room.id)
        await session.commit()

        assert await _correct(store, session, room.id, bridge.id) is False
        await session.commit()

    async with session_factory() as session:
        reread = await store.get(session, room.id)
        assert reread is not None
        assert reread.channel_type is None


async def test_a_room_moved_to_another_bridge_is_left_alone(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        bridge = await _make_bridge(session)
        other = await _make_bridge(session)
        room = await _make_room(store, session, bridge.id)
        await session.commit()
        await store.update_bridge(
            session,
            room.id,
            bridge_id=other.id,
            channel_type="channel_public",
            external_channel_id="C-OTHER",
        )
        await session.commit()

        assert await _correct(store, session, room.id, bridge.id) is False


async def test_a_missing_room_is_left_alone(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        bridge = await _make_bridge(session)
        await session.commit()

        assert await _correct(store, session, str(uuid.uuid4()), bridge.id) is False
