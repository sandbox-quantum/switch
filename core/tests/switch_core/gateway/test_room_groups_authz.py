"""Room groups are shared by the workspace: only an admin manages them, or
puts a room in one."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.decision_settings_store import DecisionSettingsStore
from switch_core.db.stores.room_group_store import RoomGroupStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.decision.settings import DecisionAvailability, ServerDefault
from switch_core.gateway import rooms as rooms_routes
from switch_core.gateway.room_groups import (
    assign_rooms_to_group,
    create_room_group,
    delete_room_group,
    list_room_groups,
    patch_room_group,
)
from switch_core.gateway.rooms import create_room, put_room_group
from switch_core.gateway.schemas import (
    RoomCreateRequest,
    RoomGroupAssignRequest,
    RoomGroupCreateRequest,
    RoomGroupUpdateRequest,
    RoomSetGroupRequest,
)

_GROUPS = RoomGroupStore()
_ROOMS = RoomStore()
_NO_DECISIONS = DecisionAvailability(
    enabled=False,
    server=ServerDefault(endpoint_url=None, api_key=None, bedrock_enabled=False),
    store=DecisionSettingsStore(),
)
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


class TestFilingRooms:
    """Putting a room in a group needs a workspace admin; taking it out needs
    write access to the room."""

    async def _setup(self, session: AsyncSession) -> tuple[User, User, Room, str]:
        member = await _add_user(session, name="member")
        admin = await _add_user(session, name="admin", role="admin")
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
        return member, admin, room, group.id

    async def test_a_member_cannot_add_even_their_own_room_to_a_group(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            member, _admin, room, group_id = await self._setup(session)

            with pytest.raises(HTTPException) as bulk:
                await assign_rooms_to_group(
                    group_id,
                    RoomGroupAssignRequest(room_ids=[room.id]),
                    session,
                    _GROUPS,
                    _ROOMS,
                    member,
                    await _is_admin(session, member),
                )
            with pytest.raises(HTTPException) as single:
                await put_room_group(
                    room.id,
                    RoomSetGroupRequest(group_id=group_id),
                    session,
                    _ROOMS,
                    None,  # type: ignore[arg-type]
                    None,  # type: ignore[arg-type]
                    None,  # type: ignore[arg-type]
                    _NO_DECISIONS,
                    member,
                    await _is_admin(session, member),
                )

            assert bulk.value.status_code == single.value.status_code == 403
            assert (await _ROOMS.get(session, room.id)).group_id is None  # type: ignore[union-attr]

    async def test_a_member_is_refused_before_the_group_lookup(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            member, _admin, room, _group_id = await self._setup(session)

            with pytest.raises(HTTPException) as bulk:
                await assign_rooms_to_group(
                    "no-such-group",
                    RoomGroupAssignRequest(room_ids=[room.id]),
                    session,
                    _GROUPS,
                    _ROOMS,
                    member,
                    await _is_admin(session, member),
                )

            assert bulk.value.status_code == 403

    async def test_a_member_may_put_the_room_back_in_its_current_group(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        async def detail(_session: AsyncSession, room: Room, *_rest: object) -> Room:
            return room

        monkeypatch.setattr(rooms_routes, "_build_room_detail", detail)
        async with session_factory() as session:
            member, _admin, room, group_id = await self._setup(session)
            await _ROOMS.set_group(session, room.id, group_id, acting_is_admin=True)
            await session.commit()

            await put_room_group(
                room.id,
                RoomSetGroupRequest(group_id=group_id),
                session,
                _ROOMS,
                None,  # type: ignore[arg-type]
                None,  # type: ignore[arg-type]
                None,  # type: ignore[arg-type]
                _NO_DECISIONS,
                member,
                await _is_admin(session, member),
            )
            refreshed = await _ROOMS.get(session, room.id)
            assert refreshed is not None and refreshed.group_id == group_id

    async def test_a_member_cannot_create_a_room_in_a_group(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            member, _admin, _room, group_id = await self._setup(session)

            with pytest.raises(HTTPException) as created:
                await create_room(
                    RoomCreateRequest(
                        name="new",
                        description="d",
                        agent_names=["a"],
                        group_id=group_id,
                    ),
                    session,
                    None,  # type: ignore[arg-type]
                    _ROOMS,
                    None,  # type: ignore[arg-type]
                    None,  # type: ignore[arg-type]
                    None,  # type: ignore[arg-type]
                    _NO_DECISIONS,
                    member,
                    await _is_admin(session, member),
                    AgentStore(),
                )

            assert created.value.status_code == 403

    async def test_an_admin_files_a_room_and_its_writer_takes_it_out(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        async def detail(_session: AsyncSession, room: Room, *_rest: object) -> Room:
            return room

        monkeypatch.setattr(rooms_routes, "_build_room_detail", detail)
        async with session_factory() as session:
            member, admin, room, group_id = await self._setup(session)

            response = await assign_rooms_to_group(
                group_id,
                RoomGroupAssignRequest(room_ids=[room.id]),
                session,
                _GROUPS,
                _ROOMS,
                admin,
                await _is_admin(session, admin),
            )
            assert response.assigned == 1

            await put_room_group(
                room.id,
                RoomSetGroupRequest(group_id=None),
                session,
                _ROOMS,
                None,  # type: ignore[arg-type]
                None,  # type: ignore[arg-type]
                None,  # type: ignore[arg-type]
                _NO_DECISIONS,
                member,
                await _is_admin(session, member),
            )
            refreshed = await _ROOMS.get(session, room.id)
            assert refreshed is not None and refreshed.group_id is None


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
                await _ROOMS.set_group(session, room.id, group.id, acting_is_admin=True)
            await session.commit()

            async def count_for(user: User) -> int:
                [detail] = await list_room_groups(
                    session, _GROUPS, _ROOMS, user, await _is_admin(session, user)
                )
                return detail.room_count

            assert await count_for(member) == 1
            assert await count_for(other) == 2
