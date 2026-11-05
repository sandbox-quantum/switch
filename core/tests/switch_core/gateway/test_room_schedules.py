from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import TENANT_ZERO_ID, Room, RoomSchedule, User
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.room_store import RoomStore
from switch_core.gateway.room_schedules import (
    ScheduleInput,
    SchedulePause,
    create_schedule,
    delete_schedule,
    edit_schedule,
    list_schedules,
    pause_schedule,
)
from tests.routing import make_room
from tests.switch_core.test_room_scheduler_atomic import setup_schedule

SessionFactory = async_sessionmaker[AsyncSession]


def request(agent_id: str) -> ScheduleInput:
    return ScheduleInput(
        body="Review the queue",
        agent_ids=[agent_id],
        run_at=datetime.now(UTC) + timedelta(hours=1),
    )


async def test_schedule_api_lifecycle(session_factory: SessionFactory) -> None:
    existing_id = await setup_schedule(session_factory)
    rooms = RoomStore()
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        existing = await session.get(RoomSchedule, existing_id)
        assert existing is not None
        user = await session.get(User, existing.author_id)
        assert user is not None
        listed = await list_schedules(existing.room_id, session, rooms, user, False)
        data = request(listed[0].agent_ids[0])
        room_id = existing.room_id
        created = await create_schedule(room_id, data, session, rooms, user, False)
        assert created.next_run_at == data.run_at
        assert created.agent_ids == data.agent_ids
        paused = await pause_schedule(
            room_id, created.id, SchedulePause(paused=True), session, rooms, user, False
        )
        assert paused.paused
        resumed = await pause_schedule(
            room_id,
            created.id,
            SchedulePause(paused=False),
            session,
            rooms,
            user,
            False,
        )
        assert not resumed.paused
        changed = data.model_copy(
            update={
                "body": "Updated instructions",
                "cron": "0 9 * * 1-5",
                "run_at": None,
            }
        )
        edited = await edit_schedule(
            room_id, created.id, changed, session, rooms, user, False
        )
        assert edited.body == changed.body and edited.cron == changed.cron
        await delete_schedule(room_id, created.id, session, rooms, user, False)
        assert all(
            row.id != created.id
            for row in await list_schedules(room_id, session, rooms, user, False)
        )


async def test_public_write_is_not_management_permission(
    session_factory: SessionFactory,
) -> None:
    existing_id = await setup_schedule(session_factory)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        existing = await session.get(RoomSchedule, existing_id)
        assert existing is not None
        other = User(name="other", email="other@example.invalid", role="user")
        session.add(other)
        await session.flush()
        with pytest.raises(HTTPException) as exc:
            await pause_schedule(
                existing.room_id,
                existing.id,
                SchedulePause(paused=True),
                session,
                RoomStore(),
                other,
                False,
            )
        assert exc.value.status_code == 403
        assert not existing.paused


async def test_schedule_cannot_be_managed_through_another_room(
    session_factory: SessionFactory,
) -> None:
    existing_id = await setup_schedule(session_factory)
    other_room = await make_room(session_factory)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        existing = await session.get(RoomSchedule, existing_id)
        assert existing is not None
        user = await session.get(User, existing.author_id)
        other = await session.get(Room, other_room.id)
        assert user is not None and other is not None
        other.owner_id = user.id
        await session.commit()
        with pytest.raises(HTTPException) as exc:
            await pause_schedule(
                other.id,
                existing.id,
                SchedulePause(paused=True),
                session,
                RoomStore(),
                user,
                False,
            )
        assert exc.value.status_code == 404
        assert not existing.paused


@pytest.mark.parametrize(
    "extra",
    [
        {"body": "   "},
        {"run_at": None},
        {"cron": "0 9 * * *"},
        {"agent_ids": []},
        {"agent_ids": ["agent", "agent"]},
        {"run_at": datetime(2026, 1, 1)},
    ],
)
def test_invalid_schedule_input(extra: dict) -> None:
    data = {
        "body": "A task",
        "agent_ids": ["agent"],
        "run_at": datetime.now(UTC) + timedelta(hours=1),
    }
    data.update(extra)
    with pytest.raises(ValidationError):
        ScheduleInput.model_validate(data)
