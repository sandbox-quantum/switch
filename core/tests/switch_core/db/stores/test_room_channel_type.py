"""Recording a channel's type, as its platform reports it, on its rooms.

A room saved as public when its channel is private shows the wrong privacy,
and a move to another bridge opens a public channel there. The write must touch
only rooms still bound to that channel on that bridge and saved as a channel —
anything else was not about this channel.
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


async def _make_room(
    store: RoomStore,
    session: AsyncSession,
    *,
    bridge_id: str | None,
    external_channel_id: str | None = CHANNEL,
    channel_type: str | None = "channel_public",
) -> Room:
    return await store.create(
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


async def _channel_type(
    session_factory: async_sessionmaker[AsyncSession], room_id: str
) -> str | None:
    async with session_factory() as session:
        room = await RoomStore().get(session, room_id)
        assert room is not None
        return room.channel_type


async def test_a_room_saved_with_the_other_privacy_is_corrected(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        bridge = await _make_bridge(session)
        room = await _make_room(store, session, bridge_id=bridge.id)
        await session.commit()

        corrected = await store.correct_channel_type(
            session,
            bridge_id=bridge.id,
            external_channel_id=CHANNEL,
            channel_type="channel_private",
        )
        await session.commit()

    assert corrected == [room.id]
    assert await _channel_type(session_factory, room.id) == "channel_private"


async def test_a_room_already_right_is_not_reported(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        bridge = await _make_bridge(session)
        await _make_room(store, session, bridge_id=bridge.id)
        await session.commit()

        corrected = await store.correct_channel_type(
            session,
            bridge_id=bridge.id,
            external_channel_id=CHANNEL,
            channel_type="channel_public",
        )

    assert corrected == []


async def test_rooms_not_bound_to_this_channel_as_a_channel_are_left_alone(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomStore()
    async with session_factory() as session:
        bridge = await _make_bridge(session)
        other_bridge = await _make_bridge(session)
        rooms = [
            # The same channel id on another bridge.
            await _make_room(store, session, bridge_id=other_bridge.id),
            # Another channel on this bridge.
            await _make_room(
                store, session, bridge_id=bridge.id, external_channel_id="19:x"
            ),
            # Saved as a chat, or with no type at all.
            await _make_room(
                store,
                session,
                bridge_id=bridge.id,
                external_channel_id="19:g@thread.v2",
                channel_type="group",
            ),
            # Unlinked: no bridge, no channel, no type.
            await _make_room(
                store,
                session,
                bridge_id=None,
                external_channel_id=None,
                channel_type=None,
            ),
        ]
        await session.commit()

        for channel_id in (CHANNEL, "19:g@thread.v2"):
            corrected = await store.correct_channel_type(
                session,
                bridge_id=bridge.id,
                external_channel_id=channel_id,
                channel_type="channel_private",
            )
            assert corrected == []
        await session.commit()

    assert [await _channel_type(session_factory, r.id) for r in rooms] == [
        "channel_public",
        "channel_public",
        "group",
        None,
    ]
