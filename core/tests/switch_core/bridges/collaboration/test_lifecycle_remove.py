from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
)
from switch_core.db.models import Client, CollaborationBridge, ExternalUser, Room
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore


def _service(
    session_factory: async_sessionmaker[AsyncSession],
) -> CollaborationBridgeLifecycleService:
    """Build the service with real stores; mock the deps remove() never touches."""
    return CollaborationBridgeLifecycleService(
        bridge_store=CollaborationBridgeStore(),
        external_user_store=ExternalUserStore(),
        bridge_message_map_store=MagicMock(),
        room_store=RoomStore(),
        agent_store=MagicMock(),
        client_store=ClientStore(),
        client_lifecycle=MagicMock(),
        room_service=MagicMock(),
        matrix_admin=MagicMock(),
        session_factory=session_factory,
        config=MagicMock(),
    )


async def _make_client(session: AsyncSession, *, client_type: str) -> str:
    client = Client(
        matrix_user_id=f"@{client_type}-{uuid.uuid4().hex[:8]}:test",
        display_name=f"{client_type} client",
        type=client_type,
        password="x",
    )
    session.add(client)
    await session.flush()
    return client.id


async def _make_bridge(session: AsyncSession) -> tuple[str, str]:
    """Returns (bridge_id, bridge_client_id)."""
    client_id = await _make_client(session, client_type="bridge")
    bridge = CollaborationBridge(
        type="mattermost",
        display_name="MM",
        client_id=client_id,
        status="active",
    )
    session.add(bridge)
    await session.flush()
    return bridge.id, client_id


async def _make_bridged_room(session: AsyncSession, *, bridge_id: str) -> str:
    room = Room(
        matrix_room_id=f"!{uuid.uuid4().hex[:8]}:test",
        name="bridged room",
        description="mirror of an external channel",
        bridge_id=bridge_id,
        channel_type="channel_public",
        external_channel_id="C123",
    )
    session.add(room)
    await session.flush()
    return room.id


async def _make_external_user(session: AsyncSession, *, bridge_id: str) -> str:
    client_id = await _make_client(session, client_type="external_user")
    user = ExternalUser(
        bridge_id=bridge_id,
        external_user_id=f"U{uuid.uuid4().hex[:8]}",
        external_username="alice",
        client_id=client_id,
    )
    session.add(user)
    await session.flush()
    return user.id


@pytest.mark.asyncio
async def test_remove_detaches_dependent_rooms(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Removing a bridge that still has dependent rooms must not FK-violate.

    Regression for the DELETE /collab/bridges 500 (CHOO-1484): rooms.bridge_id
    references collaboration_bridges.id with no ON DELETE rule, so deleting the
    bridge while rooms point at it raised a raw FK error. remove() now detaches
    the rooms (non-destructive) before deleting the bridge.
    """
    service = _service(session_factory)
    async with session_factory() as session:
        bridge_id, _ = await _make_bridge(session)
        room_id = await _make_bridged_room(session, bridge_id=bridge_id)
        external_user_id = await _make_external_user(session, bridge_id=bridge_id)
        await session.commit()

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await CollaborationBridgeStore().get(session, bridge_id) is None

        # Room survives, just detached from the (now-gone) bridge.
        room = await RoomStore().get(session, room_id)
        assert room is not None
        assert room.bridge_id is None
        assert room.channel_type is None
        assert room.external_channel_id is None

        # External users for the bridge are cleaned up (pre-existing behavior).
        assert await ExternalUserStore().get(session, external_user_id) is None


@pytest.mark.asyncio
async def test_remove_deletes_bridge_own_client(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The bridge's own Client (and its room memberships) is torn down on remove.

    Regression for CHOO-1489: register() mints a dedicated bridge Client, but
    remove() left it (and its client_rooms rows) orphaned in the DB after every
    onboard->remove cycle. remove() now clears the bridge client's memberships
    and deletes the Client row alongside the bridge.
    """
    service = _service(session_factory)
    async with session_factory() as session:
        bridge_id, bridge_client_id = await _make_bridge(session)
        room_id = await _make_bridged_room(session, bridge_id=bridge_id)
        # The bridge client is a member of the room it bridges.
        await RoomStore().add_client(session, bridge_client_id, room_id)
        await session.commit()

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await CollaborationBridgeStore().get(session, bridge_id) is None
        # The bridge's own Client row is gone (no orphan).
        assert await ClientStore().get(session, bridge_client_id) is None
        # Its room membership is gone; the room itself survives (detached).
        member_ids = await RoomStore().get_client_ids(session, room_id)
        assert bridge_client_id not in member_ids
        assert await RoomStore().get(session, room_id) is not None


@pytest.mark.asyncio
async def test_remove_without_dependent_rooms_still_deletes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service = _service(session_factory)
    async with session_factory() as session:
        bridge_id, bridge_client_id = await _make_bridge(session)
        await session.commit()

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await CollaborationBridgeStore().get(session, bridge_id) is None
        assert await ClientStore().get(session, bridge_client_id) is None
