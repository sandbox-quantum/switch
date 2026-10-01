"""Correcting a channel's saved type touches only the room bound to that channel
on that bridge and saved as a channel; anything else is not about it."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, CollaborationBridge, Room
from switch_core.db.stores.room_store import RoomStore

CHANNEL = "19:p@thread.tacv2"
CHAT = "19:g@thread.v2"


async def _make_bridge(session: AsyncSession) -> str:
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
    return bridge.id


async def _make_room(
    session: AsyncSession,
    bridge_id: str | None,
    external_channel_id: str | None,
    channel_type: str | None,
) -> str:
    room = await RoomStore().create(
        session,
        Room(
            matrix_room_id=f"!{uuid.uuid4().hex[:8]}:test",
            name="room",
            description="room desc",
            bridge_id=bridge_id,
            channel_type=channel_type,
            external_channel_id=external_channel_id,
        ),
    )
    return room.id


async def test_only_the_room_saved_with_the_other_privacy_is_corrected(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        bridge = await _make_bridge(session)
        other_bridge = await _make_bridge(session)
        target = await _make_room(session, bridge, CHANNEL, "channel_public")
        untouched = {
            await _make_room(
                session, other_bridge, CHANNEL, "channel_public"
            ): "channel_public",
            await _make_room(
                session, bridge, "19:x", "channel_public"
            ): "channel_public",
            await _make_room(session, bridge, CHAT, "group"): "group",
            await _make_room(session, None, None, None): None,
        }
        await session.commit()

        async def correct(channel_id: str) -> list[str]:
            return await store.correct_channel_type(
                session,
                bridge_id=bridge,
                external_channel_id=channel_id,
                channel_type="channel_private",
            )

        assert await correct(CHANNEL) == [target]
        assert await correct(CHANNEL) == []  # already right
        assert await correct(CHAT) == []  # a chat, not a channel
        await session.commit()

    async with session_factory() as session:
        saved = {
            room_id: (await store.get(session, room_id)).channel_type  # type: ignore[union-attr]
            for room_id in [target, *untouched]
        }
    assert saved == {target: "channel_private", **untouched}
