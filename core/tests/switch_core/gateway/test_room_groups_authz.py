"""Room groups are shared by the workspace: only an admin manages them."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.room_groups import (
    assign_rooms_to_group,
    create_room_group,
    delete_room_group,
    list_room_groups,
    patch_room_group,
)
from switch_core.gateway.schemas import (
    RoomGroupAssignRequest,
    RoomGroupCreateRequest,
    RoomGroupUpdateRequest,
)

_GROUPS = RoomGroupStore()
_ROOMS = RoomStore()
_USERS = UserStore()


async def _is_admin(session: AsyncSession, user: User) -> bool:
    """The bit `get_tenant_is_admin` hands the route, resolved the same way."""
    return await _USERS.administers(session, user)


async def _add_user(session: AsyncSession, *, name: str, role: str = "user") -> User:
    user = User(name=name, email=f"{name}@example.com", role=role)
    session.add(user)
    await session.flush()
    return user


async def _add_room(
    session: AsyncSession, *, name: str, owner_id: str, read_visibility: str
) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test",
        name=name,
        description="d",
        owner_id=owner_id,
        read_visibility=read_visibility,
        write_visibility="private",
    )
    session.add(room)
    await session.flush()
    return room


class TestManagingGroups:
    async def test_a_member_cannot_create_edit_or_delete_a_group(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            member = await _add_user(session, name="member")
            group = await _GROUPS.create(
                session,
                name="Customers",
                description=None,
                color=None,
                parent_group_id=None,
            )
            await session.commit()
            is_admin = await _is_admin(session, member)

            with pytest.raises(HTTPException) as created:
                await create_room_group(
                    RoomGroupCreateRequest(name="Mine"),
                    session,
                    _GROUPS,
                    member,
                    is_admin,
                )
            with pytest.raises(HTTPException) as patched:
                await patch_room_group(
                    group.id,
                    RoomGroupUpdateRequest(name="Renamed"),
                    session,
                    _GROUPS,
                    _ROOMS,
                    member,
                    is_admin,
                )
            with pytest.raises(HTTPException) as deleted:
                await delete_room_group(group.id, session, _GROUPS, member, is_admin)

            assert {created.value.status_code, patched.value.status_code} == {403}
            assert deleted.value.status_code == 403
            assert [g.name for g in await _GROUPS.get_all(session)] == ["Customers"]

    async def test_an_admin_can_create_and_rename_a_group(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            admin = await _add_user(session, name="admin", role="admin")
            await session.commit()
            is_admin = await _is_admin(session, admin)

            created = await create_room_group(
                RoomGroupCreateRequest(name="Customers"),
                session,
                _GROUPS,
                admin,
                is_admin,
            )
            renamed = await patch_room_group(
                created.id,
                RoomGroupUpdateRequest(name="Clients"),
                session,
                _GROUPS,
                _ROOMS,
                admin,
                is_admin,
            )

            assert renamed.name == "Clients"

    async def test_a_member_can_still_file_their_room_into_a_group(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            member = await _add_user(session, name="member")
            room = await _add_room(
                session, name="mine", owner_id=member.id, read_visibility="private"
            )
            group = await _GROUPS.create(
                session,
                name="Customers",
                description=None,
                color=None,
                parent_group_id=None,
            )
            await session.commit()

            response = await assign_rooms_to_group(
                group.id,
                RoomGroupAssignRequest(room_ids=[room.id]),
                session,
                _GROUPS,
                _ROOMS,
                member,
                await _is_admin(session, member),
            )

            assert response.assigned == 1


class TestRoomCounts:
    async def test_counts_leave_out_private_rooms_the_caller_cannot_read(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            member = await _add_user(session, name="member")
            other = await _add_user(session, name="other")
            group = await _GROUPS.create(
                session,
                name="Customers",
                description=None,
                color=None,
                parent_group_id=None,
            )
            public = await _add_room(
                session, name="pub", owner_id=other.id, read_visibility="public"
            )
            private = await _add_room(
                session, name="priv", owner_id=other.id, read_visibility="private"
            )
            for room in (public, private):
                await _ROOMS.set_group(session, room.id, group.id)
            await session.commit()

            async def count_for(user: User) -> int:
                [detail] = await list_room_groups(
                    session, _GROUPS, _ROOMS, user, await _is_admin(session, user)
                )
                return detail.room_count

            assert await count_for(member) == 1
            assert await count_for(other) == 2
