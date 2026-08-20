"""Re-pointing a bridged room at a new external channel id.

Telegram reissues a chat's id when a group becomes a supergroup, and the room
has to follow it or nothing from that chat matches a room again. Against real
Postgres, because the unique index on (bridge, external channel) is the whole
reason a re-point can fail.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Client, CollaborationBridge, Room
from switch_core.db.stores.room_store import RoomStore

OLD_ID = "-4912345678"
NEW_ID = "-1009876543210"


async def _make_bridge(session: AsyncSession, name: str) -> CollaborationBridge:
    client = Client(
        matrix_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
        display_name=f"{name} client",
        type="bridge",
        password="x",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="telegram",
        display_name=name,
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
    name: str,
    *,
    bridge_id: str,
    external_channel_id: str,
) -> Room:
    return await store.create(
        session,
        Room(
            matrix_room_id=f"!{name}:test",
            name=name,
            description=f"{name} desc",
            bridge_id=bridge_id,
            channel_type="channel_private",
            external_channel_id=external_channel_id,
        ),
    )


class TestUpdateExternalChannel:
    async def test_the_room_is_found_under_its_new_id(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            bridge = await _make_bridge(session, "telegram-1")
            room = await _make_room(
                store, session, "alpha", bridge_id=bridge.id, external_channel_id=OLD_ID
            )
            await session.commit()

            await store.update_external_channel(session, room.id, NEW_ID)
            await session.commit()

            assert (
                await store.get_by_external_channel(session, bridge.id, OLD_ID)
            ) is None
            moved = await store.get_by_external_channel(session, bridge.id, NEW_ID)
            assert moved is not None
            assert moved.id == room.id
            # Only the id moves: it is the same conversation on the same bridge.
            assert moved.bridge_id == bridge.id
            assert moved.channel_type == "channel_private"

    async def test_an_id_another_room_holds_is_rejected(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The caller checks for this first; the index is the backstop, and a
        # backstop nobody has seen fire is a guess.
        store = RoomStore()
        async with session_factory() as session:
            bridge = await _make_bridge(session, "telegram-2")
            room = await _make_room(
                store, session, "beta", bridge_id=bridge.id, external_channel_id=OLD_ID
            )
            await _make_room(
                store, session, "gamma", bridge_id=bridge.id, external_channel_id=NEW_ID
            )
            await session.commit()

            # The store flushes, so the index rejects it there rather than at
            # commit — the caller sees the failure at the call that caused it.
            with pytest.raises(IntegrityError):
                await store.update_external_channel(session, room.id, NEW_ID)

    async def test_an_unknown_room_raises_rather_than_passing_quietly(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomStore()
        async with session_factory() as session:
            with pytest.raises(ValueError, match="Room not found"):
                await store.update_external_channel(session, "no-such-room", NEW_ID)
