"""Deleting a bridge an install built must be refused, not half-done.

`messaging_installs.bridge_id` is a real foreign key with no `ON DELETE`, and
the delete endpoint tears down every room on the bridge *before* it removes the
bridge itself. Without a guard the ordering plays out as: rooms irreversibly
deleted, Postgres then refuses the bridge deletion, operator gets a 500 — and
the app is still installed with a token nobody revoked.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    Client,
    CollaborationBridge,
    MessagingInstall,
    Room,
    User,
)
from switch_core.db.stores.collaboration_bridge_store import CollaborationBridgeStore
from switch_core.db.stores.messaging_install_store import (
    INSTALL_ACTIVE,
    INSTALL_DISCONNECTED,
    MessagingInstallStore,
)
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.collaborations import delete_bridge

_BRIDGE_STORE = CollaborationBridgeStore()
_ROOM_STORE = RoomStore()
_INSTALL_STORE = MessagingInstallStore()


class _RecordingRoomService:
    """Remembers the rooms it was told to delete and deletes nothing.

    A spy rather than the real service because the property under test is that
    it is never called at all: an assertion on the list is the assertion that
    the refusal came first.
    """

    def __init__(self) -> None:
        self.deleted: list[str] = []

    async def delete_room(self, room_id: str) -> None:
        self.deleted.append(room_id)


class _RecordingLifecycle:
    def __init__(self) -> None:
        self.removed: list[str] = []

    async def remove(self, bridge_id: str) -> None:
        self.removed.append(bridge_id)


async def _make_admin(session: AsyncSession) -> User:
    user = User(
        id=f"admin-{uuid.uuid4().hex[:8]}",
        name=f"admin-{uuid.uuid4().hex[:8]}",
        email=f"admin-{uuid.uuid4().hex[:8]}@example.test",
        role="admin",
    )
    session.add(user)
    await session.flush()
    return user


async def _make_bridge(session: AsyncSession) -> str:
    client = Client(
        matrix_user_id=f"@bridge-{uuid.uuid4().hex[:12]}:test",
        display_name="bridge client",
        type="bridge",
    )
    session.add(client)
    await session.flush()
    bridge = CollaborationBridge(
        type="slack",
        display_name="Slack",
        client_id=client.id,
        status="active",
    )
    session.add(bridge)
    await session.flush()
    return bridge.id


async def _make_room(session: AsyncSession, *, bridge_id: str) -> str:
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


async def _make_install(
    session: AsyncSession, *, bridge_id: str | None, status: str, user_id: str
) -> str:
    install = MessagingInstall(
        platform="slack",
        external_workspace_id=f"T{uuid.uuid4().hex[:8]}",
        encrypted_bot_token="encrypted-placeholder",
        scopes="app_mentions:read,chat:write",
        status=status,
        installed_by_user_id=user_id,
        bridge_id=bridge_id,
    )
    session.add(install)
    await session.flush()
    return install.id


async def test_a_bridge_an_install_built_cannot_be_deleted_here(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        admin = await _make_admin(session)
        bridge_id = await _make_bridge(session)
        room_id = await _make_room(session, bridge_id=bridge_id)
        await _make_install(
            session, bridge_id=bridge_id, status=INSTALL_ACTIVE, user_id=admin.id
        )
        await session.commit()

    room_service = _RecordingRoomService()
    lifecycle = _RecordingLifecycle()
    async with session_factory() as session:
        admin = await _make_admin(session)
        with pytest.raises(HTTPException) as excinfo:
            await delete_bridge(
                bridge_id,
                session,
                _BRIDGE_STORE,
                _ROOM_STORE,
                room_service,  # type: ignore[arg-type]
                _INSTALL_STORE,
                lifecycle,  # type: ignore[arg-type]
                admin,
            )

    assert excinfo.value.status_code == 409
    # The whole point of the ordering: nothing was destroyed on the way to the
    # refusal, so retrying after disconnecting is a clean retry.
    assert room_service.deleted == []
    assert lifecycle.removed == []

    async with session_factory() as session:
        assert await _BRIDGE_STORE.get(session, bridge_id) is not None
        assert await _ROOM_STORE.get(session, room_id) is not None


async def test_the_refusal_names_the_workspace_to_disconnect(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """An operator who cannot delete here has to be told where to go instead."""
    async with session_factory() as session:
        admin = await _make_admin(session)
        bridge_id = await _make_bridge(session)
        install_id = await _make_install(
            session, bridge_id=bridge_id, status=INSTALL_ACTIVE, user_id=admin.id
        )
        await session.commit()

    async with session_factory() as session:
        install = await _INSTALL_STORE.get(session, install_id=install_id)
        workspace = install.external_workspace_id
        with pytest.raises(HTTPException) as excinfo:
            await delete_bridge(
                bridge_id,
                session,
                _BRIDGE_STORE,
                _ROOM_STORE,
                _RecordingRoomService(),  # type: ignore[arg-type]
                _INSTALL_STORE,
                _RecordingLifecycle(),  # type: ignore[arg-type]
                await _make_admin(session),
            )

    detail = str(excinfo.value.detail)
    assert workspace in detail
    assert "slack" in detail
    assert "Disconnect" in detail


async def test_a_bridge_registered_by_hand_still_deletes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        bridge_id = await _make_bridge(session)
        room_id = await _make_room(session, bridge_id=bridge_id)
        await session.commit()

    room_service = _RecordingRoomService()
    lifecycle = _RecordingLifecycle()
    async with session_factory() as session:
        result = await delete_bridge(
            bridge_id,
            session,
            _BRIDGE_STORE,
            _ROOM_STORE,
            room_service,  # type: ignore[arg-type]
            _INSTALL_STORE,
            lifecycle,  # type: ignore[arg-type]
            await _make_admin(session),
        )

    assert result == {"ok": True}
    assert room_service.deleted == [room_id]
    assert lifecycle.removed == [bridge_id]


async def test_a_bridge_whose_install_already_ended_still_deletes(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Disconnecting releases the pointer, so an ended install guards nothing.

    The row it leaves behind is a record, not a claim — and a bridge that
    outlived its install is an ordinary bridge again.
    """
    async with session_factory() as session:
        admin = await _make_admin(session)
        bridge_id = await _make_bridge(session)
        await _make_install(
            session, bridge_id=None, status=INSTALL_DISCONNECTED, user_id=admin.id
        )
        await session.commit()

    lifecycle = _RecordingLifecycle()
    async with session_factory() as session:
        await delete_bridge(
            bridge_id,
            session,
            _BRIDGE_STORE,
            _ROOM_STORE,
            _RecordingRoomService(),  # type: ignore[arg-type]
            _INSTALL_STORE,
            lifecycle,  # type: ignore[arg-type]
            await _make_admin(session),
        )

    assert lifecycle.removed == [bridge_id]
