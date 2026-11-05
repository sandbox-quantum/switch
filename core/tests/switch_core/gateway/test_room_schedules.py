from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import event
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
from switch_core.scheduling.runner import RoomScheduler
from tests.routing import make_room, process_on
from tests.switch_core.test_room_scheduler_atomic import (
    counts,
    scheduler,
    setup_schedule,
)

SessionFactory = async_sessionmaker[AsyncSession]


async def test_redundant_resume_preserves_due_work_and_author(
    session_factory: SessionFactory,
) -> None:
    schedule_id = await setup_schedule(session_factory)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(RoomSchedule, schedule_id)
        assert row is not None
        row.cron = "* * * * *"
        original_due, original_author = row.next_run_at, row.author_id
        other = User(name="admin", email="admin@example.invalid", role="admin")
        session.add(other)
        await session.commit()
        result = await pause_schedule(
            row.room_id,
            row.id,
            SchedulePause(paused=False),
            session,
            RoomStore(),
            other,
            True,
        )
        assert result.next_run_at == original_due
        assert row.author_id == original_author
    worker = RoomScheduler(session_factory, process_on(session_factory).router)
    assert await worker.fire_one(TENANT_ZERO_ID)
    assert not await worker.fire_one(TENANT_ZERO_ID)
    assert (await counts(session_factory))[:2] == (1, 1)


async def test_list_batches_targets_and_history_with_empty_rows(
    session_factory: SessionFactory,
) -> None:
    schedule_id = await setup_schedule(session_factory)
    assert await scheduler(session_factory).fire_one(TENANT_ZERO_ID)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(RoomSchedule, schedule_id)
        assert row is not None
        user = await session.get(User, row.author_id)
        assert user is not None
        empty = RoomSchedule(
            room_id=row.room_id,
            author_id=user.id,
            body="No targets remain",
            timezone="UTC",
            paused=True,
        )
        session.add(empty)
        await session.commit()
        statements: list[str] = []

        def record(connection, cursor, statement, parameters, context, executemany):
            if (
                statement.lstrip().upper().startswith("SELECT")
                and "room_schedule" in statement
            ):
                statements.append(statement)

        engine = session.get_bind()
        event.listen(engine, "before_cursor_execute", record)
        try:
            rows = {
                item.id: item
                for item in await list_schedules(
                    row.room_id, session, RoomStore(), user, False
                )
            }
        finally:
            event.remove(engine, "before_cursor_execute", record)
        assert len(statements) == 3
        assert rows[row.id].agent_ids and rows[row.id].last_run_at is not None
        assert rows[empty.id].agent_ids == []
        assert rows[empty.id].last_run_at is None
        await delete_schedule(row.room_id, row.id, session, RoomStore(), user, False)
        await delete_schedule(row.room_id, empty.id, session, RoomStore(), user, False)
        assert (
            await list_schedules(row.room_id, session, RoomStore(), user, False) == []
        )


async def test_completed_one_off_still_requires_edit_before_resume(
    session_factory: SessionFactory,
) -> None:
    schedule_id = await setup_schedule(session_factory)
    assert await scheduler(session_factory).fire_one(TENANT_ZERO_ID)
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        row = await session.get(RoomSchedule, schedule_id)
        assert row is not None
        user = await session.get(User, row.author_id)
        assert user is not None
        with pytest.raises(HTTPException) as exc:
            await pause_schedule(
                row.room_id,
                row.id,
                SchedulePause(paused=False),
                session,
                RoomStore(),
                user,
                False,
            )
        assert exc.value.status_code == 409


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
