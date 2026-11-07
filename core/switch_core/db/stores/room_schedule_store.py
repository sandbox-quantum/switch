from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import RoomSchedule


class RoomScheduleStore:
    """Storage for a room's scheduled messages (`room_schedules`)."""

    async def add(self, session: AsyncSession, schedule: RoomSchedule) -> RoomSchedule:
        session.add(schedule)
        await session.flush()
        await session.refresh(schedule)
        return schedule

    async def get(
        self, session: AsyncSession, room_id: str, schedule_id: str
    ) -> RoomSchedule | None:
        result = await session.execute(
            select(RoomSchedule).where(
                RoomSchedule.room_id == room_id, RoomSchedule.id == schedule_id
            )
        )
        return result.scalar_one_or_none()

    async def list_for_room(
        self, session: AsyncSession, room_id: str
    ) -> list[RoomSchedule]:
        result = await session.execute(
            select(RoomSchedule)
            .where(RoomSchedule.room_id == room_id)
            .order_by(RoomSchedule.created_at, RoomSchedule.id)
        )
        return list(result.scalars().all())

    async def count_for_room(self, session: AsyncSession, room_id: str) -> int:
        result = await session.execute(
            select(func.count())
            .select_from(RoomSchedule)
            .where(RoomSchedule.room_id == room_id)
        )
        return result.scalar_one()

    async def delete(self, session: AsyncSession, schedule: RoomSchedule) -> None:
        await session.delete(schedule)
        await session.flush()

    async def claim_due(
        self, session: AsyncSession, now: datetime, limit: int
    ) -> list[RoomSchedule]:
        """Lock the enabled schedules due at `now`, oldest first.

        `SKIP LOCKED`: another process polling at the same moment locks and
        advances different rows, so no schedule is claimed twice. The caller
        moves `next_run_at` on and commits, which releases the lock and takes
        the row out of the next poll.
        """
        result = await session.execute(
            select(RoomSchedule)
            .where(RoomSchedule.enabled.is_(True), RoomSchedule.next_run_at <= now)
            .order_by(RoomSchedule.next_run_at, RoomSchedule.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        return list(result.scalars().all())
