"""Creating a room with links needs read access to each link's target, whose
name and description the link shows. Real Postgres."""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User
from switch_core.db.stores.room_store import RoomStore
from switch_core.room_service import LinkedRoomSpec, RoomCreateConfig, RoomService


def _service(session_factory: async_sessionmaker[AsyncSession]) -> RoomService:
    # `_validate_attachments` only reads rooms; refs and packages are not used.
    svc = object.__new__(RoomService)
    svc._session_factory = session_factory  # type: ignore[attr-defined]
    svc._room_store = RoomStore()  # type: ignore[attr-defined]
    return svc


def _config(target_id: str, user_id: str) -> RoomCreateConfig:
    return RoomCreateConfig(
        name="new",
        description="d",
        linked_rooms=[LinkedRoomSpec(target_room_id=target_id, label="see also")],
        acting_user_id=user_id,
        acting_is_admin=False,
    )


async def test_linking_to_a_private_room_one_cannot_read_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        owner = User(name="owner", email="owner@example.invalid", role="user")
        other = User(name="other", email="other@example.invalid", role="user")
        session.add_all([owner, other])
        await session.flush()
        private = Room(
            transport_room_id="!priv:test",
            name="priv",
            description="secret",
            owner_id=owner.id,
            read_visibility="private",
            write_visibility="private",
        )
        session.add(private)
        await session.commit()

    svc = _service(session_factory)
    with pytest.raises(PermissionError, match="cannot link"):
        await svc._validate_attachments(_config(private.id, other.id))
    await svc._validate_attachments(_config(private.id, owner.id))
