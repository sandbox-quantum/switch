from __future__ import annotations

from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import RoomSchedule


class RoomScheduleStore:
    async def create(
        self, session: AsyncSession, schedule: RoomSchedule
    ) -> RoomSchedule:
        session.add(schedule)
        await session.flush()
        return schedule

    async def get(self, session: AsyncSession, schedule_id: str) -> RoomSchedule | None:
        return await session.get(RoomSchedule, schedule_id)

    async def for_room(self, session: AsyncSession, room_id: str) -> list[RoomSchedule]:
        """The room's schedules, oldest first."""
        result = await session.execute(
            select(RoomSchedule)
            .where(RoomSchedule.room_id == room_id)
            .order_by(RoomSchedule.created_at, RoomSchedule.id)
        )
        return list(result.scalars())

    async def delete(self, session: AsyncSession, schedule: RoomSchedule) -> None:
        await session.delete(schedule)
        await session.flush()

    async def due(self, session: AsyncSession, now: datetime) -> list[RoomSchedule]:
        """Unpaused schedules whose next run is at or before `now`, oldest due first."""
        result = await session.execute(
            select(RoomSchedule)
            .where(
                RoomSchedule.paused.is_(False),
                RoomSchedule.next_run_at.is_not(None),
                RoomSchedule.next_run_at <= now,
            )
            .order_by(RoomSchedule.next_run_at)
        )
        return list(result.scalars())

    async def claim(
        self,
        session: AsyncSession,
        schedule_id: str,
        *,
        due_at: datetime,
        next_run_at: datetime | None,
        fired_at: datetime,
    ) -> bool:
        """Take the run due at `due_at` by moving the schedule on to `next_run_at`.

        Whether this caller took it. The update matches only while the
        schedule still names `due_at`, so of several processes firing the same
        run exactly one sees a row change; the others find it already moved on.
        """
        result = await session.execute(
            update(RoomSchedule)
            .where(
                RoomSchedule.id == schedule_id,
                RoomSchedule.next_run_at == due_at,
                RoomSchedule.paused.is_(False),
            )
            .values(next_run_at=next_run_at, last_run_at=fired_at)
            .execution_options(synchronize_session=False)
        )
        return int(result.rowcount or 0) == 1  # type: ignore[attr-defined]
