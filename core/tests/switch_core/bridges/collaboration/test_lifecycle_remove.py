from __future__ import annotations

import re
import uuid
from unittest.mock import MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.bridges.collaboration.lifecycle_service import (
    CollaborationBridgeLifecycleService,
    _bridge_client_localpart,
)
from switch_core.db.models import Client, CollaborationBridge, ExternalUser, Room
from switch_core.db.stores.client_store import ClientStore
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.external_user_store import ExternalUserStore
from switch_core.db.stores.room_store import RoomStore


class _ClientLifecycle:
    """Deletes the row, as the real service does, and remembers what it was
    asked for. The real one also stops a live client; none of these are
    running, and a MagicMock here would let a missing deletion pass."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory
        self.removed: list[str] = []

    async def remove(self, client_id: str) -> None:
        self.removed.append(client_id)
        async with self._session_factory() as session:
            await ClientStore().delete(session, client_id)
            await session.commit()


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
        client_store=MagicMock(),
        client_lifecycle=_ClientLifecycle(session_factory),
        room_service=MagicMock(),
        matrix_admin=MagicMock(),
        session_factory=session_factory,
        config=MagicMock(),
        client_factory=MagicMock(),
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


async def _make_external_user(
    session: AsyncSession, *, bridge_id: str
) -> tuple[str, str]:
    client_id = await _make_client(session, client_type="external_user")
    user = ExternalUser(
        bridge_id=bridge_id,
        external_user_id=f"U{uuid.uuid4().hex[:8]}",
        external_username="alice",
        client_id=client_id,
    )
    session.add(user)
    await session.flush()
    return user.id, client_id


@pytest.mark.asyncio
async def test_remove_detaches_dependent_rooms(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Removing a bridge that still has dependent rooms must not FK-violate.

    Regression for the DELETE /gateway/collaborations 500: rooms.bridge_id references
    collaboration_bridges.id with no ON DELETE rule, so deleting the bridge
    while rooms point at it raised a raw FK error. remove() now detaches the
    rooms (non-destructive) before deleting the bridge.
    """
    service = _service(session_factory)
    async with session_factory() as session:
        bridge_id, _ = await _make_bridge(session)
        room_id = await _make_bridged_room(session, bridge_id=bridge_id)
        external_user_id, _ = await _make_external_user(session, bridge_id=bridge_id)
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
async def test_remove_without_dependent_rooms_still_deletes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    service = _service(session_factory)
    async with session_factory() as session:
        bridge_id, _ = await _make_bridge(session)
        await session.commit()

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await CollaborationBridgeStore().get(session, bridge_id) is None


@pytest.mark.asyncio
async def test_disconnecting_takes_every_identity_switch_made_for_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The bridge's own Matrix client and the puppet behind each person it saw.

    These were left behind, and the bridge one is not merely untidy: its Matrix
    name is derived from the app's type and display name, so disconnecting an
    app and reconnecting one named the same hit the leftover row —
    `duplicate key value violates unique constraint "clients_matrix_user_id_key"`.
    """
    service = _service(session_factory)
    async with session_factory() as session:
        bridge_id, bridge_client_id = await _make_bridge(session)
        _external_user_id, puppet_client_id = await _make_external_user(
            session, bridge_id=bridge_id
        )
        await session.commit()

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await ClientStore().get(session, bridge_client_id) is None
        assert await ClientStore().get(session, puppet_client_id) is None


@pytest.mark.asyncio
async def test_an_app_with_nobody_on_it_still_loses_its_own_client(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    # Louis's case exactly: a Telegram connection nobody had messaged yet.
    service = _service(session_factory)
    async with session_factory() as session:
        bridge_id, bridge_client_id = await _make_bridge(session)
        await session.commit()

    await service.remove(bridge_id)

    async with session_factory() as session:
        assert await ClientStore().get(session, bridge_client_id) is None


class TestTheBridgeClientName:
    """Why deleting the row is necessary but not sufficient.

    The homeserver has no API for removing an account, so the Matrix user
    outlives the row. Reusing the name would then adopt an account whose
    password Switch no longer holds — and shared-secret registration reports an
    existing user as success without applying the new one, which reads as a
    working connection that can never log in. A quiet failure in place of a
    loud one is the wrong trade, so each registration takes a fresh name.
    """

    def test_two_connections_of_the_same_name_do_not_collide(self) -> None:
        first = _bridge_client_localpart("telegram", "Telegram louiss")
        second = _bridge_client_localpart("telegram", "Telegram louiss")

        assert first != second

    def test_the_name_still_says_which_app_it_is(self) -> None:
        # It shows up as a Matrix user in rooms; a pure uuid would be unreadable.
        localpart = _bridge_client_localpart("telegram", "Telegram louiss")

        assert localpart.startswith("switch-bridge-telegram-telegram-louiss")

    def test_it_stays_a_legal_matrix_localpart(self) -> None:
        localpart = _bridge_client_localpart("slack", "Ops & Eng (US)")

        assert re.fullmatch(r"[a-z0-9._=/-]+", localpart)
