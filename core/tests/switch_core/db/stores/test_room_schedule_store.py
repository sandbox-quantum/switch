"""A room's schedules: kept with the room, and each run taken by one process."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import Room, RoomSchedule, User
from switch_core.db.stores.room_schedule_store import RoomScheduleStore

NOW = datetime(2026, 11, 4, 9, 0, tzinfo=UTC)


async def _room_and_user(session: AsyncSession) -> tuple[Room, User]:
    slug = uuid.uuid4().hex[:8]
    room = Room(transport_room_id=f"!{slug}:test", name="room", description="")
    user = User(name=slug, email=f"{slug}@test", role="user", password_hash="x")
    session.add_all([room, user])
    await session.flush()
    return room, user


def _schedule(
    room: Room, user: User, *, next_run_at: datetime | None, paused: bool = False
) -> RoomSchedule:
    return RoomSchedule(
        room_id=room.id,
        author_id=user.id,
        agent_ids=["agent-1"],
        text="Summarise the new issues.",
        cron="0 9 * * 1-5",
        timezone="Europe/London",
        paused=paused,
        next_run_at=next_run_at,
    )


async def test_only_unpaused_schedules_that_are_due_come_back_oldest_first(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomScheduleStore()
    async with session_factory() as session:
        room, user = await _room_and_user(session)
        late = await store.create(
            session, _schedule(room, user, next_run_at=NOW - timedelta(hours=1))
        )
        now = await store.create(session, _schedule(room, user, next_run_at=NOW))
        await store.create(
            session, _schedule(room, user, next_run_at=NOW + timedelta(minutes=1))
        )
        await store.create(
            session,
            _schedule(room, user, next_run_at=NOW - timedelta(hours=2), paused=True),
        )
        await store.create(session, _schedule(room, user, next_run_at=None))

        due = await store.due(session, NOW)

    assert [schedule.id for schedule in due if schedule.room_id == room.id] == [
        late.id,
        now.id,
    ]


async def test_a_run_is_taken_by_exactly_one_claim(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomScheduleStore()
    following = NOW + timedelta(days=1)
    async with session_factory() as session:
        room, user = await _room_and_user(session)
        schedule = await store.create(session, _schedule(room, user, next_run_at=NOW))
        await session.commit()
        schedule_id = schedule.id

    async with session_factory() as first, session_factory() as second:
        won = await store.claim(
            first, schedule_id, due_at=NOW, next_run_at=following, fired_at=NOW
        )
        await first.commit()
        lost = await store.claim(
            second, schedule_id, due_at=NOW, next_run_at=following, fired_at=NOW
        )
        await second.commit()

    assert (won, lost) == (True, False)
    async with session_factory() as session:
        moved = await store.get(session, schedule_id)
    assert moved is not None
    assert (moved.next_run_at, moved.last_run_at) == (following, NOW)


async def test_a_paused_schedule_cannot_be_claimed(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = RoomScheduleStore()
    async with session_factory() as session:
        room, user = await _room_and_user(session)
        schedule = await store.create(
            session, _schedule(room, user, next_run_at=NOW, paused=True)
        )

        claimed = await store.claim(
            session, schedule.id, due_at=NOW, next_run_at=None, fired_at=NOW
        )

    assert claimed is False


async def test_a_rooms_schedules_are_listed_oldest_first_and_go_with_it(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Created by separate requests, as schedules are: `created_at` is the
    transaction's clock, so two made in one transaction would tie."""
    store = RoomScheduleStore()
    async with session_factory() as session:
        room, user = await _room_and_user(session)
        first = await store.create(session, _schedule(room, user, next_run_at=NOW))
        await session.commit()
        room_id, first_id = room.id, first.id
    async with session_factory() as session:
        second = await store.create(session, _schedule(room, user, next_run_at=NOW))
        await session.commit()
        second_id = second.id

    async with session_factory() as session:
        assert [s.id for s in await store.for_room(session, room_id)] == [
            first_id,
            second_id,
        ]
        await session.delete(await session.get(Room, room_id))
        await session.commit()

    async with session_factory() as session:
        assert await store.for_room(session, room_id) == []
