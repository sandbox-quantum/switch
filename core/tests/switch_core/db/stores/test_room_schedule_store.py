from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, RoomSchedule
from switch_core.db.stores.room_schedule_store import RoomScheduleStore
from switch_core.db.stores.room_store import RoomStore

NOW = datetime(2026, 11, 6, 12, 0, tzinfo=UTC)


async def _make_room(session: AsyncSession, name: str) -> Room:
    room = Room(
        transport_room_id=f"!{name}:test", name=name, description=f"{name} desc"
    )
    session.add(room)
    await session.flush()
    return room


def _cron(room_id: str, next_run_at: datetime | None, **fields: object) -> RoomSchedule:
    return RoomSchedule(
        room_id=room_id,
        agent_ids=["agent-1"],
        message="summarise",
        schedule_type="cron",
        cron_expression="0 9 * * *",
        timezone="UTC",
        next_run_at=next_run_at,
        **fields,
    )


class TestRoomScheduleStore:
    async def test_add_get_list_count_delete(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomScheduleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            other = await _make_room(session, "r2")
            first = await store.add(session, _cron(room.id, NOW))
            await store.add(session, _cron(room.id, NOW))
            await store.add(session, _cron(other.id, NOW))
            await session.commit()

        async with session_factory() as session:
            assert (await store.get(session, room.id, first.id)) is not None
            assert (await store.get(session, other.id, first.id)) is None
            assert len(await store.list_for_room(session, room.id)) == 2
            assert await store.count_for_room(session, room.id) == 2
            assert await store.count_for_room(session, other.id) == 1

            await store.delete(session, first)
            await session.commit()

        async with session_factory() as session:
            assert await store.count_for_room(session, room.id) == 1

    async def test_add_fills_the_server_defaults(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            schedule = await RoomScheduleStore().add(session, _cron(room.id, NOW))

            assert schedule.id
            assert schedule.enabled is True
            assert schedule.created_at is not None
            assert schedule.updated_at is not None

    async def test_claim_due_takes_only_enabled_due_rows_oldest_first(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomScheduleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            newer = await store.add(session, _cron(room.id, NOW - timedelta(minutes=1)))
            older = await store.add(session, _cron(room.id, NOW - timedelta(hours=1)))
            await store.add(session, _cron(room.id, NOW + timedelta(minutes=1)))
            await store.add(session, _cron(room.id, None))
            await store.add(
                session, _cron(room.id, NOW - timedelta(hours=2), enabled=False)
            )
            await session.commit()

        async with session_factory() as session:
            claimed = await store.claim_due(session, NOW, 10)
            limited = await store.claim_due(session, NOW, 1)

        assert [s.id for s in claimed] == [older.id, newer.id]
        assert [s.id for s in limited] == [older.id]

    async def test_a_claimed_row_is_not_claimed_by_a_concurrent_poll(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomScheduleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            await store.add(session, _cron(room.id, NOW - timedelta(minutes=2)))
            await store.add(session, _cron(room.id, NOW - timedelta(minutes=1)))
            await session.commit()

        async with session_factory() as one, session_factory() as two:
            first = await store.claim_due(one, NOW, 1)
            second = await store.claim_due(two, NOW, 10)
            third = await store.claim_due(two, NOW, 10)

            assert len(first) == 1
            assert len(second) == 1
            assert second[0].id != first[0].id
            assert third == second

    async def test_deleting_the_room_deletes_its_schedules(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = RoomScheduleStore()
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            await store.add(session, _cron(room.id, NOW))
            await session.commit()
            room_id = room.id

        async with session_factory() as session:
            await RoomStore().delete(session, room_id)
            await session.commit()

        async with session_factory() as session:
            assert (await session.execute(select(RoomSchedule))).first() is None

    @pytest.mark.parametrize(
        "fields",
        [
            {"schedule_type": "cron", "cron_expression": None},
            {"schedule_type": "cron", "run_at": NOW},
            {"schedule_type": "once", "cron_expression": "0 9 * * *"},
            {"schedule_type": "once", "cron_expression": None, "run_at": None},
            {"schedule_type": "weekly"},
        ],
    )
    async def test_timing_that_contradicts_its_type_is_refused(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        fields: dict[str, object],
    ) -> None:
        async with session_factory() as session:
            room = await _make_room(session, "r1")
            schedule = _cron(room.id, NOW)
            for name, value in fields.items():
                setattr(schedule, name, value)

            with pytest.raises(IntegrityError):
                await RoomScheduleStore().add(session, schedule)
