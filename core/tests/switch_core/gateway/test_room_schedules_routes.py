"""The room schedule routes: who may list and who may change a room's
schedules, and what a bad request is told. The route coroutines run against
real Postgres with the real service and stores."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, User, room_agents
from switch_core.db.stores.agent_store import AgentStore
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore
from switch_core.db.stores.user_store import UserStore
from switch_core.gateway.room_schedules import (
    create_room_schedule,
    delete_room_schedule,
    list_room_schedules,
    update_room_schedule,
)
from switch_core.gateway.schemas import (
    RoomScheduleCreateRequest,
    RoomScheduleDetail,
    RoomScheduleUpdateRequest,
)
from switch_core.room_schedules import RoomScheduleService
from tests.switch_core.test_room_schedules import _make_agent

_ROOM_STORE = RoomStore()
_USER_STORE = UserStore()


def _service(
    session_factory: async_sessionmaker[AsyncSession],
) -> RoomScheduleService:
    return RoomScheduleService(
        schedule_store=RoomScheduleStore(),
        room_store=_ROOM_STORE,
        agent_store=AgentStore(),
        user_store=_USER_STORE,
        client_lifecycle=SimpleNamespace(),  # type: ignore[arg-type]
        session_factory=session_factory,
        clock=lambda: datetime.now(UTC),
    )


async def _add_user(session: AsyncSession, name: str, role: str = "user") -> User:
    user = User(name=name, email=f"{name}@example.com", role=role)
    session.add(user)
    await session.flush()
    return user


async def _is_admin(session: AsyncSession, user: User) -> bool:
    return await _USER_STORE.administers(session, user)


def _create_request(agent_id: str) -> RoomScheduleCreateRequest:
    return RoomScheduleCreateRequest(
        agent_ids=[agent_id],
        message="summarise new issues",
        schedule_type="cron",
        cron_expression="0 9 * * 1-5",
        timezone="Europe/Berlin",
    )


class World(SimpleNamespace):
    owner: User
    stranger: User
    admin: User
    room: Room
    agent_id: str


async def _world(
    session: AsyncSession,
    *,
    read_visibility: str = "private",
    write_visibility: str = "private",
) -> World:
    owner = await _add_user(session, "owner")
    stranger = await _add_user(session, "stranger")
    admin = await _add_user(session, "admin", role="admin")
    agent = await _make_agent(session, "alice", owner.id)
    room = Room(
        transport_room_id="!r:test",
        name="r",
        description="r",
        owner_id=owner.id,
        read_visibility=read_visibility,
        write_visibility=write_visibility,
    )
    session.add(room)
    await session.flush()
    await session.execute(
        room_agents.insert().values(room_id=room.id, agent_id=agent.id)
    )
    return World(
        owner=owner, stranger=stranger, admin=admin, room=room, agent_id=agent.id
    )


async def _create_as(
    session: AsyncSession,
    service: RoomScheduleService,
    world: World,
    user: User,
) -> RoomScheduleDetail:
    return await create_room_schedule(
        world.room.id,
        _create_request(world.agent_id),
        session,
        service,
        _ROOM_STORE,
        user,
        await _is_admin(session, user),
    )


class TestWhoMayChange:
    async def test_the_owner_creates_edits_pauses_and_deletes(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        async with session_factory() as session:
            world = await _world(session)
            is_admin = await _is_admin(session, world.owner)

            created = await _create_as(session, service, world, world.owner)
            assert created.enabled is True
            assert created.next_run_at is not None
            assert created.created_by_user_id == world.owner.id

            edited = await update_room_schedule(
                world.room.id,
                created.id,
                RoomScheduleUpdateRequest(message="new text"),
                session,
                service,
                _ROOM_STORE,
                world.owner,
                is_admin,
            )
            assert edited.message == "new text"

            paused = await update_room_schedule(
                world.room.id,
                created.id,
                RoomScheduleUpdateRequest(enabled=False),
                session,
                service,
                _ROOM_STORE,
                world.owner,
                is_admin,
            )
            assert paused.enabled is False
            assert paused.next_run_at is None

            listed = await list_room_schedules(
                world.room.id, session, service, _ROOM_STORE, world.owner, is_admin
            )
            assert [s.id for s in listed] == [created.id]

            response = await delete_room_schedule(
                world.room.id,
                created.id,
                session,
                service,
                _ROOM_STORE,
                world.owner,
                is_admin,
            )
            assert response.status_code == 204
            assert (
                await list_room_schedules(
                    world.room.id, session, service, _ROOM_STORE, world.owner, is_admin
                )
                == []
            )

    async def test_a_workspace_admin_may_manage_a_room_they_do_not_own(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        async with session_factory() as session:
            world = await _world(session)

            created = await _create_as(session, service, world, world.admin)

            assert created.created_by_user_id == world.admin.id

    async def test_a_stranger_may_neither_read_nor_change_a_private_room(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        async with session_factory() as session:
            world = await _world(session)
            created = await _create_as(session, service, world, world.owner)
            is_admin = await _is_admin(session, world.stranger)

            with pytest.raises(HTTPException) as listing:
                await list_room_schedules(
                    world.room.id,
                    session,
                    service,
                    _ROOM_STORE,
                    world.stranger,
                    is_admin,
                )
            with pytest.raises(HTTPException) as creating:
                await _create_as(session, service, world, world.stranger)
            with pytest.raises(HTTPException) as updating:
                await update_room_schedule(
                    world.room.id,
                    created.id,
                    RoomScheduleUpdateRequest(enabled=False),
                    session,
                    service,
                    _ROOM_STORE,
                    world.stranger,
                    is_admin,
                )
            with pytest.raises(HTTPException) as deleting:
                await delete_room_schedule(
                    world.room.id,
                    created.id,
                    session,
                    service,
                    _ROOM_STORE,
                    world.stranger,
                    is_admin,
                )

        assert [
            e.value.status_code for e in (listing, creating, updating, deleting)
        ] == [403, 403, 403, 403]

    async def test_a_reader_of_a_public_room_lists_but_may_not_change(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        async with session_factory() as session:
            world = await _world(session, read_visibility="public")
            created = await _create_as(session, service, world, world.owner)
            is_admin = await _is_admin(session, world.stranger)

            listed = await list_room_schedules(
                world.room.id, session, service, _ROOM_STORE, world.stranger, is_admin
            )
            with pytest.raises(HTTPException) as creating:
                await _create_as(session, service, world, world.stranger)
            with pytest.raises(HTTPException) as deleting:
                await delete_room_schedule(
                    world.room.id,
                    created.id,
                    session,
                    service,
                    _ROOM_STORE,
                    world.stranger,
                    is_admin,
                )

        assert [s.id for s in listed] == [created.id]
        assert creating.value.status_code == 403
        assert deleting.value.status_code == 403

    async def test_public_write_access_is_not_enough(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        async with session_factory() as session:
            world = await _world(
                session, read_visibility="public", write_visibility="public"
            )

            with pytest.raises(HTTPException) as exc:
                await _create_as(session, service, world, world.stranger)

        assert exc.value.status_code == 403
        assert "owner or a workspace admin" in exc.value.detail

    async def test_a_missing_room_is_not_found(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        async with session_factory() as session:
            world = await _world(session)

            with pytest.raises(HTTPException) as exc:
                await list_room_schedules(
                    "no-such-room", session, service, _ROOM_STORE, world.owner, False
                )

        assert exc.value.status_code == 404


class TestBadRequests:
    async def test_invalid_timing_is_a_400_naming_the_problem(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        async with session_factory() as session:
            world = await _world(session)
            request = _create_request(world.agent_id).model_copy(
                update={"cron_expression": "every day"}
            )

            with pytest.raises(HTTPException) as exc:
                await create_room_schedule(
                    world.room.id,
                    request,
                    session,
                    service,
                    _ROOM_STORE,
                    world.owner,
                    False,
                )

        assert exc.value.status_code == 400
        assert "five fields" in exc.value.detail

    async def test_an_agent_outside_the_room_is_a_400(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        async with session_factory() as session:
            world = await _world(session)
            outsider = await _make_agent(session, "outsider", world.owner.id)

            with pytest.raises(HTTPException) as exc:
                await create_room_schedule(
                    world.room.id,
                    _create_request(outsider.id),
                    session,
                    service,
                    _ROOM_STORE,
                    world.owner,
                    False,
                )

        assert exc.value.status_code == 400

    async def test_a_one_off_time_in_the_past_is_a_400(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        async with session_factory() as session:
            world = await _world(session)
            request = RoomScheduleCreateRequest(
                agent_ids=[world.agent_id],
                message="x",
                schedule_type="once",
                run_at=datetime.now(UTC) - timedelta(minutes=1),
                timezone="UTC",
            )

            with pytest.raises(HTTPException) as exc:
                await create_room_schedule(
                    world.room.id,
                    request,
                    session,
                    service,
                    _ROOM_STORE,
                    world.owner,
                    False,
                )

        assert exc.value.status_code == 400

    async def test_an_unknown_schedule_is_a_404(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        async with session_factory() as session:
            world = await _world(session)

            with pytest.raises(HTTPException) as updating:
                await update_room_schedule(
                    world.room.id,
                    "missing",
                    RoomScheduleUpdateRequest(enabled=False),
                    session,
                    service,
                    _ROOM_STORE,
                    world.owner,
                    False,
                )
            with pytest.raises(HTTPException) as deleting:
                await delete_room_schedule(
                    world.room.id,
                    "missing",
                    session,
                    service,
                    _ROOM_STORE,
                    world.owner,
                    False,
                )

        assert updating.value.status_code == 404
        assert deleting.value.status_code == 404

    async def test_a_schedule_of_another_room_is_not_reachable_through_this_one(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        service = _service(session_factory)
        async with session_factory() as session:
            world = await _world(session)
            other = Room(
                transport_room_id="!other:test",
                name="other",
                description="other",
                owner_id=world.owner.id,
            )
            session.add(other)
            await session.flush()
            await session.execute(
                room_agents.insert().values(room_id=other.id, agent_id=world.agent_id)
            )
            theirs = await create_room_schedule(
                other.id,
                _create_request(world.agent_id),
                session,
                service,
                _ROOM_STORE,
                world.owner,
                False,
            )

            with pytest.raises(HTTPException) as exc:
                await delete_room_schedule(
                    world.room.id,
                    theirs.id,
                    session,
                    service,
                    _ROOM_STORE,
                    world.owner,
                    False,
                )

        assert exc.value.status_code == 404
