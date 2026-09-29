"""Correcting a bridged room's saved channel type.

A room saved as public when its channel is private shows the wrong privacy,
and a move to another bridge opens a public channel there. The bridge corrects
it on startup through this write.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, CollaborationBridge, Room
from switch_core.db.stores.room_store import RoomStore


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


async def test_set_channel_type_changes_only_the_type(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        bridge = await _make_bridge(session)
        room = await store.create(
            session,
            Room(
                matrix_room_id="!private:test",
                name="private",
                description="private desc",
                bridge_id=bridge.id,
                channel_type="channel_public",
                external_channel_id="19:p@thread.tacv2",
            ),
        )
        await session.commit()

        await store.set_channel_type(session, room.id, "channel_private")
        await session.commit()

    async with session_factory() as session:
        reread = await store.get(session, room.id)
        assert reread is not None
        assert reread.channel_type == "channel_private"
        assert reread.bridge_id == bridge.id
        assert reread.external_channel_id == "19:p@thread.tacv2"


async def test_set_channel_type_on_a_missing_room_raises(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        with pytest.raises(ValueError, match="Room not found"):
            await store.set_channel_type(session, str(uuid.uuid4()), "channel_private")
