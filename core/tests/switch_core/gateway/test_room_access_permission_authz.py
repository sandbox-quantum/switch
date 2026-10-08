"""Regression tests for CHOO-3077 — changing a room's access permission
(read/write visibility) is reserved for the room's owner and tenant admins.

Before the fix `patch_room` authorized the whole update with a plain `write`
check. For a room whose `write_visibility` is public that check passes for
*every* authenticated user, so anyone could re-permission any room — and, by
flipping it to private, lock the real owner out with no way back through the
gateway. The route coroutine is exercised directly against real Postgres.

The authz gate runs before `room_service.update_room`, so a sentinel-raising
fake service lets us tell "gate denied" (HTTP 403, service never reached) from
"gate passed" (the sentinel escapes) without standing up the full success path.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.rooms import patch_room
from switch_core.gateway.schemas import RoomUpdateRequest

_ROOM_STORE = RoomStore()
_USER_STORE = UserStore()


class _GatePassed(Exception):
    """Raised by the fake service to prove the authz gate let the call through."""


class _SentinelRoomService:
    async def update_room(self, *args: Any, **kwargs: Any) -> None:
        raise _GatePassed


async def _is_admin(session: AsyncSession, user: User) -> bool:
    return await _USER_STORE.administers(session, user)


async def _add_user(session: AsyncSession, *, name: str, role: str = "user") -> User:
    user = User(name=name, email=f"{name}@example.com", role=role)
    session.add(user)
    await session.flush()
    return user


async def _add_room(
    session: AsyncSession,
    *,
    name: str,
    owner_id: str | None,
    read_visibility: str = "private",
    write_visibility: str = "private",
) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description=f"{name} desc",
        owner_id=owner_id,
        read_visibility=read_visibility,
        write_visibility=write_visibility,
    )
    session.add(room)
    await session.flush()
    return room


async def _patch(
    session: AsyncSession,
    *,
    room_id: str,
    req: RoomUpdateRequest,
    user: User,
) -> None:
    await patch_room(
        room_id,
        req,
        session,
        _SentinelRoomService(),  # type: ignore[arg-type]
        _ROOM_STORE,
        None,  # type: ignore[arg-type]  # bridge_store — unused before the gate
        None,  # type: ignore[arg-type]  # external_user_store
        None,  # type: ignore[arg-type]  # protocol
        user,
        await _is_admin(session, user),
    )


class TestRoomAccessPermissionAuthz:
    async def test_non_owner_cannot_change_visibility_of_public_write_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            room = await _add_room(
                session,
                name="r1",
                owner_id=owner.id,
                read_visibility="public",
                write_visibility="public",
            )

            with pytest.raises(HTTPException) as exc:
                await _patch(
                    session,
                    room_id=room.id,
                    req=RoomUpdateRequest(write_visibility="private"),
                    user=other,
                )

            assert exc.value.status_code == 403

    async def test_non_owner_may_still_edit_other_fields_on_public_write_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        # The fix must not over-block: a public-write room is still editable by
        # a non-owner as long as the access permission is left alone.
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            other = await _add_user(session, name="other")
            room = await _add_room(
                session,
                name="r1",
                owner_id=owner.id,
                read_visibility="public",
                write_visibility="public",
            )

            with pytest.raises(_GatePassed):
                await _patch(
                    session,
                    room_id=room.id,
                    req=RoomUpdateRequest(name="renamed"),
                    user=other,
                )

    async def test_owner_can_change_visibility(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            room = await _add_room(session, name="r1", owner_id=owner.id)

            with pytest.raises(_GatePassed):
                await _patch(
                    session,
                    room_id=room.id,
                    req=RoomUpdateRequest(write_visibility="public"),
                    user=owner,
                )

    async def test_admin_can_change_visibility_of_room_they_dont_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            owner = await _add_user(session, name="owner")
            admin = await _add_user(session, name="admin", role="admin")
            room = await _add_room(session, name="r1", owner_id=owner.id)

            with pytest.raises(_GatePassed):
                await _patch(
                    session,
                    room_id=room.id,
                    req=RoomUpdateRequest(read_visibility="public"),
                    user=admin,
                )
